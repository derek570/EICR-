/**
 * CCU single-shot extraction — one VLM call, full rail at once.
 *
 * Replaces the sliding-window pipeline for the per-slot enumeration step.
 * The sliding-window architecture was originally designed to overcome
 * Sonnet's accuracy issues at long-rail single-shot reads; with GPT-5.5,
 * the model can enumerate a 16-module rail in one call with the correct
 * count and cleanly structured per-slot output. The 9-window dance plus
 * pairwise alignment merger is no longer necessary.
 *
 * Field-test verification (2026-05-07, Wylex NHRS12SL, 16-module board):
 *
 *   Pipeline                                    slots   wall    cost
 *   ─────────────────────────────────────────────────────────────────────
 *   Sliding-window Sonnet 4.6 (broken in prod)  25      6.6s    $0.10
 *   Sliding-window GPT-5.5 (intermediate)        18      4.0s    $0.25
 *   Single-shot GPT-5.5 (this module)            16      7.3s    $0.04
 *
 * The single-shot pipeline collapses several classes of complexity that
 * existed only because of the sliding-window architecture:
 *   - No alignment merger → no findBestOverlap, no entriesMatch tolerance
 *   - No within-window over-enumeration to defend against
 *   - No per-window cropping geometry to maintain
 *   - No source/CV-space coordinate scaling (the call sees the whole image)
 *
 * What we keep:
 *   - CV (Stage 1 + Stage 2) still runs. moduleCountFromCv is independent
 *     ground truth that cross-checks the VLM's enumeration count.
 *   - The board classifier (board_technology, manufacturer, model, main
 *     switch position, SPD presence) still runs first. Its output decides
 *     which prompt to send (modern vs rewireable).
 *   - All downstream enrichment: slotsToCircuits, applyRcdTypeLookup,
 *     applyBsEnFallback, normaliseCircuitLabels, lookupMissingRcdTypes,
 *     flagRcdWaveformOutliers — unchanged. The output of this module
 *     mimics extractViaSlidingWindow's return shape exactly.
 *
 * What gets flagged as low-confidence:
 *   - VLM count disagrees with CV's moduleCountFromCv. Inspector should
 *     verify the count manually before relying on the extraction.
 *
 * Output contract (matches extractViaSlidingWindow):
 *   { slots, labels, finalDevices, snappedWays, pitchPx, timings, usage,
 *     lowConfidence, stage3Error, stageOutputs, skippedSlotIndices }
 */
import sharp from 'sharp';
import { cropSlot } from './ccu-geometric.js';
import { cropCarrierSlot } from './ccu-geometric-rewireable.js';

const SINGLE_SHOT_TIMEOUT_MS = Number(process.env.CCU_SINGLE_SHOT_TIMEOUT_MS || 90_000);
const SINGLE_SHOT_MAX_TOKENS = Number(process.env.CCU_SINGLE_SHOT_MAX_TOKENS || 4096);

// Wylex BS 3036 colour-code lookup for rewireable carriers — only used
// when the VLM left ocpd_rating_a null on a rewireable.
const COLOUR_TO_AMPS = {
  white: 5,
  blue: 15,
  yellow: 20,
  red: 30,
  green: 45,
};

const norm2px = (v, dim) => Math.round((v / 1000) * dim);

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const MODERN_PROMPT = `You are inspecting a UK consumer unit's main DIN rail. The image shows a single horizontal rail with a row of devices left-to-right.

Devices visible: MCBs, RCBOs, RCDs, blanking plates, main switches, SPDs. Each device is mounted on the rail and may have a circuit-label strip above and/or below it.

YOUR JOB
List every visible MODULE SLOT in strict left-to-right order. ONE ENTRY = ONE MODULE SLOT.

A 2-pole device that physically occupies TWO module slots — typically a 2-pole main switch or a 2-module RCD — must be returned as TWO ENTRIES with identical device_kind, label, ocpd_rating_a, ocpd_bs_en, rcd_type, rcd_rating_ma. Three-pole isolators: three identical entries.

INCLUDE blanking plates (plain plastic covers in an unused slot) as ordinary entries with device_kind:"blank".

OUTPUT
Return a JSON object with one key "entries", an array of objects:
  {
    "device_kind": "mcb" | "rcbo" | "rcd" | "main_switch" | "spd" | "blank",
    "ocpd_rating_a": <integer amperage on the device face, or null>,
    "ocpd_curve": "B" | "C" | "D" | null,
    "ocpd_bs_en": "BS EN 60898" | "BS EN 61009" | "BS EN 60947-2" | null,
    "rcd_type": "AC" | "A" | "F" | "B" | null,
    "rcd_rating_ma": <integer mA for RCD/RCBO, or null>,
    "label": <string from the circuit-label strip, or null if illegible>
  }

RULES
- Read the printed amperage from the device face, not from any label nearby.
- Trip-curve letter is printed beside the amperage on the device face. If you can't read it, return null.
- For RCBOs and RCDs, look for the waveform symbol (∿ AC, ⬓ A, ⌒ F, ⊐ B). Return null if symbol is unclear.
- Labels: transcribe verbatim including line breaks. Don't summarise.

Return JSON only — no prose, no markdown fence.`;

const REWIREABLE_PROMPT = `You are inspecting a UK consumer unit with REWIREABLE FUSE CARRIERS (BS 3036) instead of modern MCBs. The fuse carriers are coloured plastic blocks (white=5A, blue=15A, yellow=20A, red=30A, green=45A) and slot into a horizontal carrier panel.

YOUR JOB
List every visible CARRIER SLOT in strict left-to-right order. ONE ENTRY = ONE CARRIER SLOT.

OUTPUT
Return a JSON object with one key "entries", an array of objects:
  {
    "device_kind": "rewireable" | "main_switch" | "blank",
    "ocpd_rating_a": <integer derived from carrier colour, or null>,
    "ocpd_bs_en": "BS 3036" | null,
    "body_colour": "white" | "blue" | "yellow" | "red" | "green" | null,
    "label": <string from circuit label, or null>
  }

RULES
- Carrier colour is the strongest rating signal. Match white=5A, blue=15A, yellow=20A, red=30A, green=45A.
- Main switch is a separate row or end position; if visible, use device_kind:"main_switch".
- Empty slots in the carrier panel are blanks: device_kind:"blank".

Return JSON only — no prose, no markdown fence.`;

// ---------------------------------------------------------------------------
// Crop image to the rail region (with margin above/below for labels)
// ---------------------------------------------------------------------------

/**
 * Crop the source image to the rail area plus generous vertical margin so the
 * VLM's attention isn't spread across cabinet door / wall / floor / ceiling
 * content surrounding the rail.
 *
 * Margin choices (tuned 2026-05-07 against the Wylex NHRS12SL field test):
 *   horizontal: 5% of rail width on each side — small buffer so a slightly
 *               imprecise rail-bbox detection doesn't clip a real edge device
 *   above:      200% of rail height — captures typed label strips (close)
 *               and inspector handwritten cards far above the rail
 *   below:     200% of rail height — captures the handwritten "label flaps"
 *               that often hang well below the device row on UK CUs
 *
 * Each margin is clamped to image bounds. If the rail is near a frame edge,
 * the crop simply runs to the edge — we never pad with synthetic content.
 *
 * Falls back to the full image if the rail bbox is missing or degenerate
 * (CV upstream failure shouldn't take the VLM call down).
 */
async function cropToRailRegion({ imageBuffer, prepared, imgW, imgH, isRewireable, logger }) {
  const bbox = isRewireable ? prepared.panelBounds : prepared.railBbox;
  if (
    !bbox ||
    !Number.isFinite(bbox.left) ||
    !Number.isFinite(bbox.right) ||
    !Number.isFinite(bbox.top) ||
    !Number.isFinite(bbox.bottom) ||
    bbox.right <= bbox.left ||
    bbox.bottom <= bbox.top
  ) {
    if (logger) {
      logger.warn('CCU single-shot: rail bbox missing or degenerate, sending full image', {
        bbox,
      });
    }
    return imageBuffer;
  }

  const railLeftPx = norm2px(bbox.left, imgW);
  const railRightPx = norm2px(bbox.right, imgW);
  const railTopPx = norm2px(bbox.top, imgH);
  const railBottomPx = norm2px(bbox.bottom, imgH);
  const railWidth = railRightPx - railLeftPx;
  const railHeight = railBottomPx - railTopPx;

  const xMargin = Math.round(railWidth * 0.05);
  const yAboveMargin = Math.round(railHeight * 2.0);
  const yBelowMargin = Math.round(railHeight * 2.0);

  const cropLeft = Math.max(0, railLeftPx - xMargin);
  const cropTop = Math.max(0, railTopPx - yAboveMargin);
  const cropRight = Math.min(imgW, railRightPx + xMargin);
  const cropBottom = Math.min(imgH, railBottomPx + yBelowMargin);
  const cropWidth = cropRight - cropLeft;
  const cropHeight = cropBottom - cropTop;

  if (cropWidth <= 0 || cropHeight <= 0) {
    if (logger) {
      logger.warn('CCU single-shot: zero-area crop, sending full image', {
        cropLeft,
        cropTop,
        cropWidth,
        cropHeight,
      });
    }
    return imageBuffer;
  }

  // Re-encode at quality 92 — the camera-source JPEG is already lossy, so a
  // small further re-encode preserves enough fidelity for the labels while
  // keeping the cropped buffer small. Use mozjpeg=false (default) for
  // speed; per-extraction this runs once per request, not in a hot loop.
  const cropped = await sharp(imageBuffer)
    .extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight })
    .jpeg({ quality: 92 })
    .toBuffer();

  if (logger) {
    logger.info('CCU single-shot rail-region crop', {
      sourceWidth: imgW,
      sourceHeight: imgH,
      cropLeft,
      cropTop,
      cropWidth,
      cropHeight,
      sourceBytes: imageBuffer.length,
      croppedBytes: cropped.length,
    });
  }
  return cropped;
}

// ---------------------------------------------------------------------------
// VLM call
// ---------------------------------------------------------------------------

async function runSingleShot({ anthropic, model, prompt, imageBuffer, signal }) {
  const t0 = Date.now();
  const resp = await anthropic.messages.create(
    {
      model,
      max_tokens: SINGLE_SHOT_MAX_TOKENS,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/jpeg',
                data: imageBuffer.toString('base64'),
              },
            },
            { type: 'text', text: prompt },
          ],
        },
      ],
    },
    { signal }
  );
  const ms = Date.now() - t0;
  const usage = resp.usage || {};

  const textBlock = resp.content.find((b) => b.type === 'text');
  const rawText = textBlock?.text ?? '';
  let parsed;
  try {
    const fenced = rawText.match(/```(?:json)?\s*([\s\S]+?)```/);
    parsed = JSON.parse(fenced ? fenced[1] : rawText);
  } catch (err) {
    throw new Error(`single-shot JSON parse failed: ${err.message}`);
  }
  const entries = parsed.entries || parsed.devices || parsed.circuits || parsed.slots || [];

  return {
    ms,
    usage: {
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      cachedInputTokens: usage.cached_input_tokens || 0,
    },
    entries,
    rawText,
  };
}

// ---------------------------------------------------------------------------
// Entry → slot mapping
// ---------------------------------------------------------------------------

function entriesToSlots(entries, boardManufacturer, vlmCountAgreesWithCv) {
  const slots = [];
  const labels = [];
  // Single-shot has no per-slot vote count to derive confidence from. We
  // assign a baseline confidence that's high when VLM count matches CV
  // count and lower when they disagree — disagreement is the strongest
  // signal we have that something's off in this run.
  const baseConfidence = vlmCountAgreesWithCv ? 0.92 : 0.65;

  for (let s = 0; s < entries.length; s++) {
    const raw = entries[s];
    if (!raw || typeof raw !== 'object') continue;
    const cls = typeof raw.device_kind === 'string' ? raw.device_kind.toLowerCase().trim() : null;
    if (!cls) continue;

    let rating = raw.ocpd_rating_a != null ? Number(raw.ocpd_rating_a) || null : null;
    const bodyColour = typeof raw.body_colour === 'string' ? raw.body_colour.toLowerCase() : null;
    if (rating == null && cls === 'rewireable' && bodyColour && COLOUR_TO_AMPS[bodyColour]) {
      rating = COLOUR_TO_AMPS[bodyColour];
    }

    const sensitivity =
      raw.rcd_rating_ma != null
        ? typeof raw.rcd_rating_ma === 'number'
          ? raw.rcd_rating_ma
          : Number(raw.rcd_rating_ma) || null
        : null;

    const labelText = typeof raw.label === 'string' && raw.label.trim() !== '' ? raw.label : null;
    const curve = typeof raw.ocpd_curve === 'string' ? raw.ocpd_curve : null;

    slots.push({
      slotIndex: s,
      content: cls === 'blank' ? 'blank' : 'device',
      extends: 'none',
      classification: cls,
      manufacturer:
        boardManufacturer ?? (cls === 'rcbo' || cls === 'rcd' || cls === 'mcb' ? 'unknown' : null),
      model: null,
      ratingAmps: rating,
      ratingText: rating != null ? `${curve || ''}${rating}A`.trim() : null,
      ratingHallucinationDetected: false,
      poles: 1,
      tripCurve: curve,
      sensitivity,
      rcdWaveformType: raw.rcd_type || null,
      bsEn: raw.ocpd_bs_en || null,
      bodyColour,
      confidence: baseConfidence,
      crop: { bbox: { x: 0, y: 0, w: 0, h: 0 }, base64: '' },
      label: labelText,
    });
    labels.push({
      slotIndex: s,
      label: labelText,
      rawLabel: labelText,
      confidence: baseConfidence,
    });
  }
  return { slots, labels };
}

// ---------------------------------------------------------------------------
// Per-slot crop generation for iOS overlay
// ---------------------------------------------------------------------------

async function attachCropsToSlots({ slots, imageBuffer, prepared, isRewireable, imgW, imgH }) {
  if (slots.length === 0) return;

  // Build slot-centre x-coordinates by dividing the rail evenly into N
  // slot positions, where N is the actual count VLM returned. For modern
  // boards we use the railBbox; for rewireable we use panelBounds.
  let leftPx, rightPx, panelTopNorm, panelBottomNorm, pitchPx;
  if (isRewireable) {
    leftPx = norm2px(prepared.panelBounds?.left ?? 50, imgW);
    rightPx = norm2px(prepared.panelBounds?.right ?? 950, imgW);
    panelTopNorm = prepared.panelBounds?.top ?? 400;
    panelBottomNorm = prepared.panelBounds?.bottom ?? 600;
    pitchPx = (rightPx - leftPx) / slots.length;
  } else {
    leftPx = norm2px(prepared.railBbox?.left ?? 50, imgW);
    rightPx = norm2px(prepared.railBbox?.right ?? 950, imgW);
    pitchPx = (rightPx - leftPx) / slots.length;
  }

  const slotCentersPx = slots.map((_, i) => leftPx + (i + 0.5) * pitchPx);

  await Promise.all(
    slots.map(async (slot, i) => {
      try {
        if (isRewireable) {
          const out = await cropCarrierSlot(imageBuffer, i, {
            slotCentersX: slotCentersPx,
            carrierPitchPx: pitchPx,
            panelTopNorm,
            panelBottomNorm,
            imageWidth: imgW,
            imageHeight: imgH,
          });
          slot.crop = { bbox: out.bbox, base64: out.buffer.toString('base64') };
        } else {
          const out = await cropSlot(imageBuffer, i, {
            slotCentersX: slotCentersPx.map((px) => Math.round((px / imgW) * 1000)),
            moduleWidth: Math.round((pitchPx / imgW) * 1000),
            railTop:
              prepared.medianRails?.rail_top ??
              Math.round((norm2px(prepared.railBbox?.top ?? 400, imgH) / imgH) * 1000),
            railBottom:
              prepared.medianRails?.rail_bottom ??
              Math.round((norm2px(prepared.railBbox?.bottom ?? 600, imgH) / imgH) * 1000),
            imageWidth: imgW,
            imageHeight: imgH,
          });
          slot.crop = { bbox: out.bbox, base64: out.buffer.toString('base64') };
        }
      } catch {
        slot.crop = { bbox: { x: 0, y: 0, w: 1, h: 1 }, base64: '' };
      }
    })
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   imageBuffer: Buffer,
 *   prepared: object,
 *   isRewireable: boolean,
 *   anthropic: object,           // Anthropic SDK client OR OpenAI adapter
 *   model: string,
 *   imgW: number,
 *   imgH: number,
 *   boardManufacturer?: string,
 *   logger?: object,
 *   userId?: string
 * }} args
 * @returns Same shape as extractViaSlidingWindow.
 */
export async function extractViaSingleShot({
  imageBuffer,
  prepared,
  isRewireable,
  anthropic,
  model,
  imgW,
  imgH,
  boardManufacturer = null,
  logger,
  userId,
}) {
  const t0 = Date.now();

  // 1. Crop to the rail region + label margin before sending to the VLM.
  //    The full original image is mostly cabinet/wall/floor surrounding the
  //    rail (rail occupies ~19% of frame area on a typical UK shot). Cropping
  //    keeps the model's attention on the rail and the label strips above
  //    and below it, so devices in the middle of the rail are less likely
  //    to be misclassified as blank from attention dilution. The
  //    per-slot crops attached to slots[].crop later still come from the
  //    full original buffer at native resolution for the iOS overlay —
  //    only the VLM call uses the rail-region crop.
  const visionImage = await cropToRailRegion({
    imageBuffer,
    prepared,
    imgW,
    imgH,
    isRewireable,
    logger,
  });
  const prompt = isRewireable ? REWIREABLE_PROMPT : MODERN_PROMPT;
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), SINGLE_SHOT_TIMEOUT_MS);
  let result;
  try {
    result = await runSingleShot({
      anthropic,
      model,
      prompt,
      imageBuffer: visionImage,
      signal: abortController.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  // 2. Cross-check VLM count against CV count. Disagreement → low confidence.
  const cvCount = prepared.cvPitchDiag?.moduleCountFromCv;
  const vlmCount = result.entries.length;
  const vlmCountAgreesWithCv = Number.isFinite(cvCount) && cvCount === vlmCount;
  const lowConfidence = !vlmCountAgreesWithCv;

  // 3. Build slots[] + labels[] in the shape downstream code expects.
  const { slots, labels } = entriesToSlots(result.entries, boardManufacturer, vlmCountAgreesWithCv);

  // 4. Generate per-slot crops for the iOS tap-to-correct overlay.
  await attachCropsToSlots({
    slots,
    imageBuffer,
    prepared,
    isRewireable,
    imgW,
    imgH,
  });

  // 5. Effective pitch derived from final slot count and rail width.
  const railLeftPx = isRewireable
    ? norm2px(prepared.panelBounds?.left ?? 50, imgW)
    : norm2px(prepared.railBbox?.left ?? 50, imgW);
  const railRightPx = isRewireable
    ? norm2px(prepared.panelBounds?.right ?? 950, imgW)
    : norm2px(prepared.railBbox?.right ?? 950, imgW);
  const railWidthPx = railRightPx - railLeftPx;
  const pitchPx = slots.length > 0 ? railWidthPx / slots.length : 0;

  const wallMs = Date.now() - t0;
  if (logger) {
    logger.info('CCU single-shot extraction complete', {
      userId,
      vlmCount,
      cvCount,
      vlmCountAgreesWithCv,
      pitchPx,
      wallMs,
      vlmMs: result.ms,
      tokensIn: result.usage.inputTokens,
      tokensOut: result.usage.outputTokens,
      cachedTokensIn: result.usage.cachedInputTokens,
      pipeline: isRewireable ? 'rewireable' : 'modern',
      model,
    });
  }

  // 6. Return the same shape extractViaSlidingWindow returns so the route
  //    handler doesn't need a separate code path for output assembly.
  //    `finalDevices` is the canonical list (which IS slots in this
  //    pipeline — no merger to produce a separate canonical), reshaped
  //    so existing consumers keep working.
  const finalDevices = slots.map((s) => ({
    kind: s.classification,
    rating: s.ratingAmps,
    curve: s.tripCurve,
    bs_en: s.bsEn,
    rcd_type: s.rcdWaveformType,
    rcd_rating_ma: s.sensitivity,
    body_colour: s.bodyColour,
    label: s.label,
    votes: 1,
    sources: [{ window: 0, indexInWindow: s.slotIndex }],
  }));

  return {
    slots,
    labels,
    finalDevices,
    snappedWays: slots.length,
    pitchPx,
    timings: { stage3Ms: wallMs },
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    },
    lowConfidence,
    stage3Error: null,
    stageOutputs: {
      stage3: {
        slots,
        batchCount: 1,
        batchSize: null,
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
        },
        // Match the windowEntries diagnostic shape from sliding-window so
        // S3 sidecars stay analysable with the same tools. A single-shot
        // is conceptually one "window" covering the entire rail.
        windowEntries: [
          {
            window: 1,
            x0: railLeftPx,
            x1: railRightPx,
            overshoot: 'none',
            ms: result.ms,
            entries: result.entries.map((e) => ({
              kind: typeof e.device_kind === 'string' ? e.device_kind.toLowerCase() : null,
              rating: e.ocpd_rating_a ?? null,
              curve: e.ocpd_curve || null,
              bs_en: e.ocpd_bs_en || null,
              rcd_type: e.rcd_type || null,
              rcd_rating_ma: e.rcd_rating_ma ?? null,
              body_colour: e.body_colour || null,
              label: e.label || null,
            })),
          },
        ],
        singleShot: true,
        vlmCount,
        cvCount,
        vlmCountAgreesWithCv,
      },
    },
    skippedSlotIndices: [],
  };
}
