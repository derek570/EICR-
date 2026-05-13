/**
 * CCU pre-flight quality screen.
 *
 * Quick Haiku vision call that runs BEFORE the expensive per-slot
 * extraction pipeline. Catches obviously-unusable photos (shadows,
 * heavy glare, hands in shot, severe defocus, board out of frame) for
 * ~$0.001 and ~2 seconds, so we don't burn $0.05 of GPT-5.5 tokens on
 * a photo that was always going to fail.
 *
 * This is complementary to the post-extraction quality gate
 * (ccu-quality-gate.js): preflight catches *visually* bad photos
 * before extraction; the post-gate catches photos where extraction
 * finished but the output is internally inconsistent (VLM↔CV count
 * disagreement, low classifier confidence). Both return the same
 * `retake_required` response shape to iOS.
 *
 * KILL SWITCH: set CCU_PREFLIGHT_ENABLED=false on the task definition
 * env to bypass entirely. CCU_PREFLIGHT_MIN_SCORE controls the reject
 * threshold (default 0.7).
 */

import sharp from 'sharp';

const DEFAULT_MODEL = process.env.CCU_PREFLIGHT_MODEL || 'claude-haiku-4-5-20251001';
const DEFAULT_MIN_SCORE = Number(process.env.CCU_PREFLIGHT_MIN_SCORE || 0.7);
const DEFAULT_TIMEOUT_MS = Number(process.env.CCU_PREFLIGHT_TIMEOUT_MS || 15_000);
// Resize down for the quality screen — Haiku doesn't need the full 24 MP
// to judge "is this even worth running through extraction". 1024 wide is
// enough to see shadows, glare, hand occlusion, and gross focus issues.
const PREFLIGHT_RESIZE_WIDTH = Number(process.env.CCU_PREFLIGHT_RESIZE_WIDTH || 1024);

const PROMPT = `You are screening a photo of a UK consumer unit (electrical fuseboard) to decide whether it is good enough for automated data extraction.

CONTEXT — what a "good" photo looks like in this domain:
- Most UK consumer units have HANDWRITTEN circuit labels on a paper or
  card strip above or below the device row. These are NORMAL and
  EXPECTED — they ARE the data the inspector needs us to read. Do NOT
  treat handwritten labels as occlusion or as obstructing the rail.
- A slight downward / upward tilt is normal because inspectors photograph
  units mounted high on a wall. "Head-on" is a target, not a hard
  requirement — only flag "angle" when the perspective is so extreme
  that one end of the rail is dramatically larger than the other.
- Mild shadow falling along part of the rail is normal in domestic
  consumer-unit cupboards. Only flag "shadow" when a shadow is dark
  enough to make device-face printing UNREADABLE in that area.
- The cover / metal tray edges around the devices are PART of the
  consumer unit, not an obstruction.

REJECT (score < 0.7) only for genuine blockers:
- A hand, finger, tool, or unrelated object physically COVERING device
  faces or labels (not the printed label strip itself).
- Heavy motion blur or severe defocus making the device-face text
  unreadable.
- Severe perspective where the rail is at ~60°+ from head-on.
- One or both ends of the rail cut out of frame.
- Lighting so dark or blown-out that the device-face text is unreadable.
- A dark shadow covering a substantial portion of the rail such that
  individual devices in that zone cannot be distinguished.

ACCEPT (score >= 0.7) when:
- The full rail is visible end-to-end.
- The device faces (toggles, amperage prints, RCD waveform symbols) are
  legible to a human looking at this photo.
- Handwritten or printed labels on the label strip are present —
  whether legible or not is fine, that's a separate extraction concern.

Score guidance:
  1.0 = perfect — head-on, evenly lit, in focus, full rail in frame.
  0.85 = good — minor cosmetic issues, will extract reliably.
  0.7 = acceptable — handwritten labels, slight tilt, slight shadow, all
                     within the "normal install" range above.
  0.5 = marginal — one of the REJECT criteria is borderline.
  0.0 = unusable — one or more REJECT criteria are clearly tripped.

Return JSON only, no prose, no markdown fence:
{
  "score": <0.0-1.0>,
  "issues": [<one or more of: "shadow", "glare", "occlusion", "blur", "angle", "out_of_frame", "low_light">],
  "user_message": "<one short sentence telling the inspector exactly what to fix on retake, or empty string if no issue>"
}

IMPORTANT: "issues" is for genuine blockers under the REJECT criteria
above. Do NOT list "occlusion" for handwritten labels. Do NOT list
"angle" for a normal downward-facing inspection shot. An empty issues
array on a score >= 0.7 is the expected case for a typical good photo.`;

/**
 * @param {object} args
 * @param {Buffer} args.imageBuffer — original photo bytes (any format sharp can read)
 * @param {object} args.anthropic — @anthropic-ai/sdk client instance
 * @param {object} [args.logger]
 * @param {string} [args.userId] — for log correlation
 * @param {string} [args.model] — override the Haiku model id
 * @param {number} [args.minScore] — reject threshold (default 0.7)
 * @returns {Promise<{
 *   pass: boolean,
 *   score: number|null,
 *   issues: string[],
 *   userMessage: string|null,
 *   diagnostic: object,
 * }>}
 */
export async function screenCcuPhoto({
  imageBuffer,
  anthropic,
  logger = null,
  userId = null,
  model = DEFAULT_MODEL,
  minScore = DEFAULT_MIN_SCORE,
}) {
  const t0 = Date.now();

  if (!Buffer.isBuffer(imageBuffer)) {
    throw new Error('screenCcuPhoto: imageBuffer must be a Buffer');
  }

  // Downsize to keep Haiku cost low. Sharp re-encodes as JPEG at q85.
  let resizedBuffer;
  try {
    resizedBuffer = await sharp(imageBuffer)
      .resize({ width: PREFLIGHT_RESIZE_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch (err) {
    // If we can't even decode the upload, that IS the answer — bail
    // with a hard fail so the caller surfaces a retake.
    return {
      pass: false,
      score: null,
      issues: ['decode_error'],
      userMessage: 'We couldn’t read this image. Please retake the photo.',
      diagnostic: { decodeError: err.message, elapsedMs: Date.now() - t0 },
    };
  }

  const base64 = resizedBuffer.toString('base64');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  let response;
  try {
    response = await anthropic.messages.create(
      {
        model,
        max_tokens: 256,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/jpeg', data: base64 },
              },
              { type: 'text', text: PROMPT },
            ],
          },
        ],
      },
      { signal: controller.signal }
    );
  } catch (err) {
    // Preflight is a best-effort safety net. If Haiku is down or times
    // out, let the request through to the main pipeline rather than
    // blocking inspectors over an unrelated outage. The post-extract
    // quality gate is the second line of defence.
    if (logger) {
      logger.warn('CCU preflight call failed (open-fail to pipeline)', {
        userId,
        error: err?.message ?? String(err),
        elapsedMs: Date.now() - t0,
      });
    }
    return {
      pass: true,
      score: null,
      issues: [],
      userMessage: null,
      diagnostic: { preflightError: err?.message ?? String(err), openFail: true },
    };
  } finally {
    clearTimeout(timeoutId);
  }

  const text = response?.content?.[0]?.text ?? '';
  let parsed = null;
  try {
    // Tolerate the model wrapping the JSON in a fenced code block, even
    // though we explicitly tell it not to.
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    parsed = JSON.parse(cleaned);
  } catch (err) {
    if (logger) {
      logger.warn('CCU preflight JSON parse failed (open-fail to pipeline)', {
        userId,
        error: err.message,
        responsePreview: text.slice(0, 200),
      });
    }
    return {
      pass: true,
      score: null,
      issues: [],
      userMessage: null,
      diagnostic: { parseError: err.message, openFail: true },
    };
  }

  const score = Number.isFinite(parsed.score) ? parsed.score : null;
  const issues = Array.isArray(parsed.issues) ? parsed.issues.map(String) : [];
  const userMessage =
    typeof parsed.user_message === 'string' && parsed.user_message.trim().length > 0
      ? parsed.user_message.trim()
      : null;

  const pass = score == null ? true : score >= minScore;

  const diagnostic = {
    score,
    issues,
    minScore,
    model,
    elapsedMs: Date.now() - t0,
    usage: response?.usage ?? null,
  };

  if (logger) {
    logger.info('CCU preflight evaluated', {
      userId,
      pass,
      score,
      issues,
      elapsedMs: diagnostic.elapsedMs,
    });
  }

  return { pass, score, issues, userMessage, diagnostic };
}

export const __TEST_INTERNALS = { PROMPT, DEFAULT_MIN_SCORE, DEFAULT_MODEL };
