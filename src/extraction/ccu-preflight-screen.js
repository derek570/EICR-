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

Look at the photo and judge:
- Is the entire DIN rail (the row of MCBs/RCDs) fully visible and in frame?
- Is the photo in focus on the device faces?
- Is there severe shadow, glare, reflection, or a hand/finger covering any of the devices on the rail?
- Is the rail roughly head-on (within ~30° tilt), or so angled that perspective is extreme?
- Is the lighting sufficient to read the printed text on the device faces?

Score:
  1.0 = perfect — well-lit, in focus, head-on, fully framed, nothing covering devices.
  0.7 = acceptable — minor issues that probably won't affect extraction.
  0.5 = marginal — visible issues likely to cause errors.
  0.0 = unusable — major obstruction, blur, or severe lighting problem.

Return JSON only, no prose, no markdown fence:
{
  "score": <0.0-1.0>,
  "issues": [<one or more of: "shadow", "glare", "occlusion", "blur", "angle", "out_of_frame", "low_light">],
  "user_message": "<one short sentence telling the inspector exactly what to fix on retake, or empty string if no issue>"
}`;

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
