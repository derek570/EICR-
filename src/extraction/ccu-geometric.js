/**
 * CCU Geometric Extraction (Phase B + C)
 *
 * Three-stage VLM pipeline for Consumer Control Unit photo analysis:
 *   Stage 1 (getRailGeometry): Rail bbox on 0-1000 grid, median of 3 samples with SD check.
 *   Stage 2 (getModuleCount): Main switch pixel width → module pitch → rail-width-based count,
 *                             plus a direct VLM count for disagreement detection.
 *   Stage 3 (classifySlots):  Per-slot crop-and-zoom classification, batched 4 crops per VLM call.
 *                             Each crop is centred on slotCentersX[i] with 20% H / 30% V padding.
 *
 * Throws on missing ANTHROPIC_API_KEY or VLM failure in stages 1/2. Stage 3 failures are
 * surfaced as { slots: null, stage3Error } so the caller still gets usable rail geometry.
 *
 * See: docs/plans/2026-04-16-ccu-geometric-extraction-design.md §2.1, §2.2, §2.3, §5
 */

import sharp from 'sharp';
import { applyDeviceLookup } from './device-lookup-table.js';

const CCU_GEOMETRIC_MODEL = (process.env.CCU_GEOMETRIC_MODEL || 'claude-sonnet-4-6').trim();
const CCU_GEOMETRIC_MAX_TOKENS = 1024;
// Stage 3 needs a bigger response envelope — batched classifications each return a JSON object.
const CCU_STAGE3_MAX_TOKENS = 2048;
const CCU_GEOMETRIC_TIMEOUT_MS = Number(process.env.CCU_GEOMETRIC_TIMEOUT_MS || 60_000);
// Batch size for Stage 3 classification. 4 crops/message gave the best accuracy/cost trade-off
// on the 3 fixture photos: fewer round-trips vs. VLM attention dilution on tiny crops. Going
// to 6 made the VLM skip or mis-number slots on photo-1 (the MEM Memera 2000 board). Keep at 4.
const CCU_STAGE3_BATCH_SIZE = 4;

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const RAIL_PROMPTS = [
  // Variation 1 — straightforward
  `Look at this consumer unit (fuseboard) photo. Identify the DIN rail — the metal rail that the circuit breakers clip onto.
Return the bounding box of the DIN rail only (NOT the whole enclosure, NOT the cover, NOT the labels — only the rail itself where modules clip on).
Coordinates are normalised 0-1000, with (0,0) at top-left of the image.
Return ONLY JSON: {"rail_top": number, "rail_bottom": number, "rail_left": number, "rail_right": number}`,

  // Variation 2 — emphasise module alignment
  `Examine this electrical consumer unit photograph. Find the horizontal row of breakers and isolators.
They all clip onto a DIN rail — locate that rail's outer edges.
- rail_top: vertical coordinate of the rail's upper edge
- rail_bottom: vertical coordinate of the rail's lower edge
- rail_left: horizontal coordinate of the leftmost point of the rail occupied by modules
- rail_right: horizontal coordinate of the rightmost point of the rail occupied by modules
All four values are on a 0 to 1000 scale (top-left origin).
Respond with JSON only: {"rail_top":..., "rail_bottom":..., "rail_left":..., "rail_right":...}`,

  // Variation 3 — emphasise precision
  `This is a UK consumer unit. Identify the DIN rail region — the strip where MCBs, RCBOs, the main switch, SPD etc. are mounted.
Return the tightest bounding box around that rail region (do not include the enclosure, cover, stickers, or wiring above/below).
Normalise to 0-1000 (top-left origin). Output strictly:
{"rail_top": <int>, "rail_bottom": <int>, "rail_left": <int>, "rail_right": <int>}`,
];

const MODULE_COUNT_PROMPT = (
  rails
) => `This is a UK consumer unit. The DIN rail bounding box on a 0-1000 scale is:
- rail_top: ${rails.rail_top}
- rail_bottom: ${rails.rail_bottom}
- rail_left: ${rails.rail_left}
- rail_right: ${rails.rail_right}

Find the MAIN SWITCH on this board. It is typically the largest device on the rail — two modules wide (~36mm in reality). It has no test button and no sensitivity marking ("30mA" etc.). It is NOT an RCD.

Report:
1. The x-coordinate of the main switch's CENTRE on the 0-1000 scale (main_switch_center_x).
2. The TOTAL width of the main switch on the 0-1000 scale (main_switch_width).
3. A direct count of how many module positions fit on the rail between rail_left and rail_right (module_count_direct). A module is an 18mm-wide slot — a single MCB is 1 module, an RCBO or RCD or main switch is 2 modules, blanks count as 1 module each.

Respond with JSON only:
{"main_switch_center_x": <int>, "main_switch_width": <int>, "module_count_direct": <int>}`;

// Stage 3 — classify the device in each crop. Each message contains N crops
// (CCU_STAGE3_BATCH_SIZE); the VLM must return exactly N objects in the same order.
// We send the slot_index explicitly so the VLM can echo it back and we can verify
// alignment rather than trusting positional order alone.
const SLOT_CLASSIFY_PROMPT = (
  slotIndices
) => `You are looking at ${slotIndices.length} cropped image${slotIndices.length === 1 ? '' : 's'} taken from a UK consumer unit (fuseboard). Each crop is centred on a single DIN rail module position (slot).

The slot indices, in order of the images you are seeing, are: [${slotIndices.join(', ')}].

For EACH crop, classify the device occupying that slot. Valid classifications:
- "mcb"          — single Miniature Circuit Breaker (BS EN 60898-1), has a trip curve letter (B/C/D) before amp rating, e.g. "B32"
- "rcbo"         — combined RCD + MCB (BS EN 61009-1), has both a trip curve + amp rating AND a test button with mA sensitivity (e.g. "30mA")
- "rcd"          — Residual Current Device (BS EN 61008), has a test button and mA sensitivity but NO trip curve letter
- "main_switch"  — 2-module-wide isolator with NO test button, NO trip curve, NO mA marking, typically labelled "Main Switch" or "100A"
- "spd"          — Surge Protection Device, usually has plug-in cartridges or coloured status windows
- "blank"        — unused/empty slot with a blanking plate
- "unknown"      — cannot determine

For MCBs and RCBOs, read:
- manufacturer      — brand stamped on the face (e.g. "Hager", "MK", "Wylex", "MEM", "Crabtree", "Eaton", "Schneider", "BG", "Fusebox", "Contactum"). null if illegible.
- model             — product family if printed (e.g. "Memera 2000", "Design 10"). null if not shown.
- ratingAmps        — integer amp rating (6, 10, 16, 20, 25, 32, 40, 50, 63, 80, 100). null if unreadable.
- poles             — 1, 2, 3 or 4 if you can read/count them. Return null if unsure — DO NOT guess. Stage 4 fills defaults from the device-face lookup table.
- tripCurve         — "B", "C" or "D" — the curve letter printed directly before the amp rating (e.g. the "B" in "B32"). null if not visible. MCB/RCBO only.
- confidence        — your self-assessed 0.0-1.0 confidence in the classification.

For RCDs and RCBOs, additionally read:
- sensitivity       — mA sensitivity printed on the device face ("30", "100", "300", "500"). Integer mA. null if unreadable.
- rcdWaveformType   — "AC" (sine wave symbol), "A" (sine + pulse symbol), "F" (A + composite), or "B" (all waveforms incl. DC). null if the waveform symbol is not visible or unclear.

For all devices, if you can read it:
- bsEn              — the BS EN standard number printed on the face (e.g. "BS EN 60898-1", "BS EN 61009-1", "BS EN 61008-1"). null if not visible.

For blanks, SPDs and main switches: manufacturer / model / ratingAmps / tripCurve / sensitivity / rcdWaveformType / bsEn may be null. Still return poles (1 for blank/SPD if single-module, 2 for main_switch — null if unsure) and confidence.

Return ONLY a JSON array, one object per crop, in the SAME ORDER as the images you received. Echo back slot_index to prove alignment:
[
  {"slot_index": <int>, "classification": "<string>", "manufacturer": <string|null>, "model": <string|null>, "ratingAmps": <int|null>, "poles": <int|null>, "tripCurve": <string|null>, "sensitivity": <int|null>, "rcdWaveformType": <string|null>, "bsEn": <string|null>, "confidence": <float>},
  ...
]`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractJson(text) {
  if (!text || typeof text !== 'string') {
    throw new Error('VLM returned empty response');
  }
  let jsonStr = text.trim();
  const fenceMatch = jsonStr.match(/```json\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  } else {
    const firstBrace = jsonStr.indexOf('{');
    const lastBrace = jsonStr.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
    }
  }
  return JSON.parse(jsonStr);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const squaredDiffs = values.map((v) => (v - mean) ** 2);
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(variance);
}

async function getAnthropicClient() {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  return new Anthropic({ apiKey: anthropicKey });
}

async function callVlm(anthropic, base64, prompt) {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), CCU_GEOMETRIC_TIMEOUT_MS);
  let response;
  try {
    response = await anthropic.messages.create(
      {
        model: CCU_GEOMETRIC_MODEL,
        max_tokens: CCU_GEOMETRIC_MAX_TOKENS,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/jpeg', data: base64 },
              },
              { type: 'text', text: prompt },
            ],
          },
        ],
      },
      { signal: abortController.signal }
    );
  } finally {
    clearTimeout(timeoutId);
  }

  const textBlocks = (response.content || []).filter((b) => b.type === 'text');
  const text = textBlocks.map((b) => b.text).join('');
  const usage = response.usage || {};
  return {
    text,
    parsed: extractJson(text),
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
  };
}

// ---------------------------------------------------------------------------
// Stage 1 — Rail geometry (median of 3)
// ---------------------------------------------------------------------------

/**
 * Stage 1: Extract DIN rail bounding box.
 *
 * Runs 3 VLM samples with wording variations, takes the median per-coordinate,
 * flags low confidence if per-coordinate SD > 5% of image width.
 *
 * @param {Buffer} imageBuffer  Raw JPEG bytes.
 * @returns {Promise<{rails: Array<object>, medianRails: object, sdPct: object, lowConfidence: boolean, usage: object}>}
 * @throws if ANTHROPIC_API_KEY missing or any VLM call fails.
 */
export async function getRailGeometry(imageBuffer) {
  if (!Buffer.isBuffer(imageBuffer)) {
    throw new Error('getRailGeometry: imageBuffer must be a Buffer');
  }

  const anthropic = await getAnthropicClient();
  const base64 = imageBuffer.toString('base64');

  // Image metadata (for SD-as-percentage).
  const meta = await sharp(imageBuffer).metadata();
  const imageWidth = meta.width || 1000;

  // Run 3 samples in parallel.
  const samples = await Promise.all(RAIL_PROMPTS.map((p) => callVlm(anthropic, base64, p)));

  const rails = samples.map((s) => {
    const { rail_top, rail_bottom, rail_left, rail_right } = s.parsed;
    if (
      typeof rail_top !== 'number' ||
      typeof rail_bottom !== 'number' ||
      typeof rail_left !== 'number' ||
      typeof rail_right !== 'number'
    ) {
      throw new Error('getRailGeometry: VLM response missing required rail_* numeric fields');
    }
    return { rail_top, rail_bottom, rail_left, rail_right };
  });

  const medianRails = {
    rail_top: median(rails.map((r) => r.rail_top)),
    rail_bottom: median(rails.map((r) => r.rail_bottom)),
    rail_left: median(rails.map((r) => r.rail_left)),
    rail_right: median(rails.map((r) => r.rail_right)),
  };

  // SD on 0-1000 normalised scale.
  const sd = {
    rail_top: standardDeviation(rails.map((r) => r.rail_top)),
    rail_bottom: standardDeviation(rails.map((r) => r.rail_bottom)),
    rail_left: standardDeviation(rails.map((r) => r.rail_left)),
    rail_right: standardDeviation(rails.map((r) => r.rail_right)),
  };

  // SD as % of image width. The VLM coords are 0-1000 so SD is already on that scale;
  // "percent of image width" is SD / 1000 * 100 regardless of actual pixel width, because
  // both numerator and denominator are in the same normalised space. We keep imageWidth
  // on the output for downstream pixel conversion.
  const sdPct = {
    rail_top: (sd.rail_top / 1000) * 100,
    rail_bottom: (sd.rail_bottom / 1000) * 100,
    rail_left: (sd.rail_left / 1000) * 100,
    rail_right: (sd.rail_right / 1000) * 100,
  };

  const SD_THRESHOLD_PCT = 5;
  const lowConfidence = Object.values(sdPct).some((v) => v > SD_THRESHOLD_PCT);

  const usage = samples.reduce(
    (acc, s) => ({
      inputTokens: acc.inputTokens + s.inputTokens,
      outputTokens: acc.outputTokens + s.outputTokens,
    }),
    { inputTokens: 0, outputTokens: 0 }
  );

  return {
    rails,
    medianRails,
    sdPct,
    lowConfidence,
    imageWidth,
    imageHeight: meta.height || 0,
    usage,
  };
}

// ---------------------------------------------------------------------------
// Stage 2 — Module count (geometric vs direct VLM)
// ---------------------------------------------------------------------------

/**
 * Stage 2: Derive module count from main switch pitch + directly from VLM.
 *
 * The main switch is always 2 modules wide on UK CCUs, so:
 *   module_width = main_switch_width / 2
 *   module_count = round(rail_width / module_width)
 * We also ask the VLM directly for a count, and flag disagreement if |geo - vlm| >= 1.
 *
 * @param {Buffer} imageBuffer
 * @param {{rail_top:number, rail_bottom:number, rail_left:number, rail_right:number}} medianRails
 * @returns {Promise<{geometricCount:number, vlmCount:number, slotCentersX:number[], disagreement:boolean, mainSwitchCenterX:number, mainSwitchWidth:number, usage:object}>}
 * @throws if ANTHROPIC_API_KEY missing or VLM call fails.
 */
export async function getModuleCount(imageBuffer, medianRails) {
  if (!Buffer.isBuffer(imageBuffer)) {
    throw new Error('getModuleCount: imageBuffer must be a Buffer');
  }
  if (
    !medianRails ||
    typeof medianRails.rail_left !== 'number' ||
    typeof medianRails.rail_right !== 'number'
  ) {
    throw new Error('getModuleCount: medianRails must include numeric rail_left and rail_right');
  }

  const anthropic = await getAnthropicClient();
  const base64 = imageBuffer.toString('base64');

  const sample = await callVlm(anthropic, base64, MODULE_COUNT_PROMPT(medianRails));
  const { main_switch_center_x, main_switch_width, module_count_direct } = sample.parsed;

  if (typeof main_switch_width !== 'number' || main_switch_width <= 0) {
    throw new Error('getModuleCount: VLM returned invalid main_switch_width');
  }
  if (typeof module_count_direct !== 'number') {
    throw new Error('getModuleCount: VLM returned invalid module_count_direct');
  }

  const rawRailWidth = medianRails.rail_right - medianRails.rail_left;
  if (rawRailWidth <= 0) {
    throw new Error('getModuleCount: rail_right must be greater than rail_left');
  }

  const moduleWidth = main_switch_width / 2; // main switch is always 2 modules wide

  // --- Clamp rail span to exclude the main switch bbox ---------------------
  // Stage 1's VLM often returns `rail_right` at the physical end of the DIN
  // rail, which includes the main-switch region on right-handed boards (or
  // `rail_left` at the start of the rail including the main switch on left-
  // handed boards). Without this clamp, Stage 2 tiles the main-switch zone
  // into phantom module slots — on a Wylex NHRS12SL that meant 18 slots for
  // a ~12-module board, which then passed through Stage 3 as 2-4 "unknown"
  // / "blank" phantoms sitting inside the isolator.
  //
  // Skip the clamp when mainSwitchCenterX is null (inline-mains rewireable
  // boards — the Codex P1 fix handles those via mainSwitchOffset upstream),
  // or when the main switch already sits outside the rail bbox (no-op).
  let effectiveRailLeft = medianRails.rail_left;
  let effectiveRailRight = medianRails.rail_right;
  let mainSwitchSide = null;
  // Only clamp when the main-switch centre is physically INSIDE the rail bbox
  // returned by Stage 1. If the VLM places it outside (e.g. separate rail
  // segment, or Stage 1 already excluded the main-switch zone), trust that
  // and leave the rail span alone.
  const msCentreInsideRail =
    typeof main_switch_center_x === 'number' &&
    Number.isFinite(main_switch_center_x) &&
    main_switch_center_x >= medianRails.rail_left &&
    main_switch_center_x <= medianRails.rail_right;

  if (msCentreInsideRail) {
    const msHalf = main_switch_width / 2;
    const msLeft = main_switch_center_x - msHalf;
    const msRight = main_switch_center_x + msHalf;
    const railMid = (medianRails.rail_left + medianRails.rail_right) / 2;
    if (main_switch_center_x > railMid) {
      mainSwitchSide = 'right';
      if (msLeft > medianRails.rail_left) {
        effectiveRailRight = msLeft;
      }
    } else {
      mainSwitchSide = 'left';
      if (msRight < medianRails.rail_right) {
        effectiveRailLeft = msRight;
      }
    }
  }

  const railWidth = effectiveRailRight - effectiveRailLeft;
  if (railWidth <= 0) {
    throw new Error('getModuleCount: effective rail width collapsed to zero after main-switch clamp');
  }
  let geometricCount = Math.round(railWidth / moduleWidth);

  const vlmCount = Math.round(module_count_direct);

  // --- Disagreement gate ---------------------------------------------------
  // After the clamp, if geometric and VLM counts still differ by >= 2, the
  // rail edges are still fuzzy (typically the far-from-main-switch end —
  // that's the only remaining unclamped edge). Truncate to the VLM count by
  // dropping modules from the end NEAREST the main switch, which is the
  // fuzziest region even post-clamp (main_switch_width is a VLM estimate,
  // not a measurement). A 1-module drift is ignored — that can be genuine
  // fence-post rounding.
  let truncatedFromDisagreement = false;
  if (vlmCount > 0 && geometricCount - vlmCount >= 2) {
    geometricCount = vlmCount;
    truncatedFromDisagreement = true;
  }

  const slotCentersX = [];
  if (mainSwitchSide === 'right' || mainSwitchSide === null) {
    // Tile from the far-from-main-switch end (left), so if we ever truncate
    // further we lose the modules nearest the main switch (fuzziest region).
    for (let i = 0; i < geometricCount; i++) {
      slotCentersX.push(effectiveRailLeft + moduleWidth * (i + 0.5));
    }
  } else {
    // mainSwitchSide === 'left' — tile from the right edge backwards so the
    // nearest-to-main-switch modules are the last to be generated.
    for (let i = 0; i < geometricCount; i++) {
      slotCentersX.push(effectiveRailRight - moduleWidth * (i + 0.5));
    }
    slotCentersX.reverse(); // keep physical left-to-right ordering for callers
  }

  const disagreement = Math.abs(geometricCount - vlmCount) >= 1;

  return {
    geometricCount,
    vlmCount,
    slotCentersX,
    disagreement,
    truncatedFromDisagreement,
    mainSwitchSide,
    mainSwitchCenterX: typeof main_switch_center_x === 'number' ? main_switch_center_x : null,
    mainSwitchWidth: main_switch_width,
    moduleWidth,
    usage: {
      inputTokens: sample.inputTokens,
      outputTokens: sample.outputTokens,
    },
  };
}

// ---------------------------------------------------------------------------
// Stage 3 — Per-slot crop-and-zoom classification
// ---------------------------------------------------------------------------

/**
 * Convert 0-1000 normalised coordinates to pixel coordinates, clamped to image bounds.
 * @private
 */
function normToPx(value, dimension) {
  const px = (value / 1000) * dimension;
  return Math.max(0, Math.min(dimension, Math.round(px)));
}

/**
 * Crop a single module slot from the full CCU image, centred on slotCentersX[slotIndex],
 * with 20% horizontal / 30% vertical padding relative to module/rail size.
 *
 * Rationale:
 *   - 20% horizontal padding lets the VLM see the edges of the device (important for
 *     distinguishing 1-pole MCB from 2-pole RCBO when the center is slightly off).
 *   - 30% vertical padding grabs the printed labels above/below the rail where
 *     manufacturer and model are often printed.
 *   - Bbox is clamped so edge slots don't generate zero-width / negative crops.
 *
 * @param {Buffer} imageBuffer  Full CCU JPEG.
 * @param {number} slotIndex
 * @param {object} geom
 * @param {number[]} geom.slotCentersX   On 0-1000 scale.
 * @param {number}   geom.moduleWidth    On 0-1000 scale (width of a single module).
 * @param {number}   geom.railTop        0-1000.
 * @param {number}   geom.railBottom     0-1000.
 * @param {number}   geom.imageWidth     Full image pixel width.
 * @param {number}   geom.imageHeight    Full image pixel height.
 * @returns {Promise<{buffer: Buffer, bbox: {x:number,y:number,w:number,h:number}}>}
 *          bbox is in PIXEL coordinates — Phase D iOS tap-to-correct overlays need this.
 */
export async function cropSlot(imageBuffer, slotIndex, geom) {
  if (!Buffer.isBuffer(imageBuffer)) {
    throw new Error('cropSlot: imageBuffer must be a Buffer');
  }
  const { slotCentersX, moduleWidth, railTop, railBottom, imageWidth, imageHeight } = geom || {};
  if (!Array.isArray(slotCentersX) || slotCentersX.length === 0) {
    throw new Error('cropSlot: geom.slotCentersX must be a non-empty array');
  }
  if (slotIndex < 0 || slotIndex >= slotCentersX.length) {
    throw new Error(
      `cropSlot: slotIndex ${slotIndex} out of range (0..${slotCentersX.length - 1})`
    );
  }
  if (!Number.isFinite(moduleWidth) || moduleWidth <= 0) {
    throw new Error('cropSlot: geom.moduleWidth must be a positive number');
  }
  if (!Number.isFinite(railTop) || !Number.isFinite(railBottom) || railBottom <= railTop) {
    throw new Error('cropSlot: geom.railTop/railBottom invalid');
  }
  if (
    !Number.isFinite(imageWidth) ||
    imageWidth <= 0 ||
    !Number.isFinite(imageHeight) ||
    imageHeight <= 0
  ) {
    throw new Error('cropSlot: geom.imageWidth and imageHeight must be positive');
  }

  const centerXNorm = slotCentersX[slotIndex];
  const railHeightNorm = railBottom - railTop;
  const railCenterYNorm = (railTop + railBottom) / 2;

  // Crop width = 2.2 × moduleWidth so 2-module devices (RCDs, 2P MCBs, isolators)
  // are fully captured regardless of which of their two slot centres we anchor to.
  // Previous 1.2× bisected 2-module devices straight down the middle. VLM prompt
  // already says "identify the device centred in this crop" + echoes slot_index,
  // so the small bleed into neighbours is acceptable.
  const halfWidthNorm = moduleWidth * 0.5 * 2.2;
  // 30% V padding applied relative to rail height (labels live just above/below the rail)
  const halfHeightNorm = (railHeightNorm / 2) * 1.3;

  const leftNorm = centerXNorm - halfWidthNorm;
  const rightNorm = centerXNorm + halfWidthNorm;
  const topNorm = railCenterYNorm - halfHeightNorm;
  const bottomNorm = railCenterYNorm + halfHeightNorm;

  // Convert to pixels and clamp to image bounds.
  const xPx = normToPx(leftNorm, imageWidth);
  const yPx = normToPx(topNorm, imageHeight);
  const rightPx = normToPx(rightNorm, imageWidth);
  const bottomPx = normToPx(bottomNorm, imageHeight);
  const wPx = Math.max(1, rightPx - xPx);
  const hPx = Math.max(1, bottomPx - yPx);

  const buffer = await sharp(imageBuffer)
    .extract({ left: xPx, top: yPx, width: wPx, height: hPx })
    // Upscale to ~1024px wide for VLM legibility (matches v3 POC).
    .resize({ width: 1024, withoutEnlargement: false })
    .jpeg({ quality: 90 })
    .toBuffer();

  return {
    buffer,
    bbox: { x: xPx, y: yPx, w: wPx, h: hPx },
  };
}

/**
 * Send a batch of slot crops to the VLM for classification.
 *
 * Each Anthropic message contains CCU_STAGE3_BATCH_SIZE image blocks + one prompt;
 * the VLM returns an array of classification objects. We then merge crop bbox
 * metadata + base64 onto each result so iOS (Phase D) can render the crop back to
 * the inspector on tap-to-correct without re-fetching the full photo.
 *
 * @param {Buffer}  _imageBuffer  Original CCU JPEG (unused at the moment — slotCrops
 *                                already contain per-slot buffers — but kept on the
 *                                signature for future re-use without API churn).
 * @param {Array<{slotIndex:number, buffer:Buffer, bbox:object}>} slotCrops
 * @param {{anthropicClient?: object, model?: string}} [opts]
 * @returns {Promise<{slots: Array<object>, usage: {inputTokens:number, outputTokens:number}, batchCount:number}>}
 */
export async function classifySlots(_imageBuffer, slotCrops, opts = {}) {
  if (!Array.isArray(slotCrops)) {
    throw new Error('classifySlots: slotCrops must be an array');
  }
  if (slotCrops.length === 0) {
    return { slots: [], usage: { inputTokens: 0, outputTokens: 0 }, batchCount: 0 };
  }

  const anthropic = opts.anthropicClient || (await getAnthropicClient());
  const model = opts.model || CCU_GEOMETRIC_MODEL;

  // Split into batches.
  const batches = [];
  for (let i = 0; i < slotCrops.length; i += CCU_STAGE3_BATCH_SIZE) {
    batches.push(slotCrops.slice(i, i + CCU_STAGE3_BATCH_SIZE));
  }

  const resultsBySlotIndex = new Map();
  const usage = { inputTokens: 0, outputTokens: 0 };

  for (const batch of batches) {
    const slotIndices = batch.map((b) => b.slotIndex);
    const base64s = batch.map((b) => b.buffer.toString('base64'));

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), CCU_GEOMETRIC_TIMEOUT_MS);
    let response;
    try {
      response = await anthropic.messages.create(
        {
          model,
          max_tokens: CCU_STAGE3_MAX_TOKENS,
          messages: [
            {
              role: 'user',
              content: [
                ...base64s.map((data) => ({
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/jpeg', data },
                })),
                { type: 'text', text: SLOT_CLASSIFY_PROMPT(slotIndices) },
              ],
            },
          ],
        },
        { signal: abortController.signal }
      );
    } finally {
      clearTimeout(timeoutId);
    }

    const text = (response.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');

    // Parse array response. Strip fences and find the outer [...] block.
    let arr;
    try {
      let jsonStr = text.trim();
      const fence = jsonStr.match(/```json\s*([\s\S]*?)```/);
      if (fence) jsonStr = fence[1].trim();
      const firstBracket = jsonStr.indexOf('[');
      const lastBracket = jsonStr.lastIndexOf(']');
      if (firstBracket !== -1 && lastBracket > firstBracket) {
        jsonStr = jsonStr.slice(firstBracket, lastBracket + 1);
      }
      arr = JSON.parse(jsonStr);
      if (!Array.isArray(arr)) throw new Error('not an array');
    } catch (err) {
      throw new Error(`classifySlots: failed to parse VLM array response: ${err.message}`);
    }

    const u = response.usage || {};
    usage.inputTokens += u.input_tokens || 0;
    usage.outputTokens += u.output_tokens || 0;

    // Match by echoed slot_index if present, else fall back to positional order.
    for (let i = 0; i < batch.length; i++) {
      const crop = batch[i];
      const vlmItem = arr.find((x) => x && x.slot_index === crop.slotIndex) || arr[i] || {};
      resultsBySlotIndex.set(crop.slotIndex, {
        slotIndex: crop.slotIndex,
        classification: vlmItem.classification || 'unknown',
        manufacturer: vlmItem.manufacturer ?? null,
        model: vlmItem.model ?? null,
        ratingAmps:
          typeof vlmItem.ratingAmps === 'number'
            ? vlmItem.ratingAmps
            : (vlmItem.ratingAmps ?? null),
        poles: typeof vlmItem.poles === 'number' ? vlmItem.poles : null,
        tripCurve: vlmItem.tripCurve ?? null,
        sensitivity: typeof vlmItem.sensitivity === 'number' ? vlmItem.sensitivity : null,
        rcdWaveformType: vlmItem.rcdWaveformType ?? null,
        bsEn: vlmItem.bsEn ?? null,
        confidence: typeof vlmItem.confidence === 'number' ? vlmItem.confidence : 0,
        crop: {
          bbox: crop.bbox,
          base64: crop.buffer.toString('base64'),
        },
      });
    }
  }

  // Preserve input order.
  const slots = slotCrops.map(
    (c) =>
      resultsBySlotIndex.get(c.slotIndex) || {
        slotIndex: c.slotIndex,
        classification: 'unknown',
        manufacturer: null,
        model: null,
        ratingAmps: null,
        poles: null,
        tripCurve: null,
        sensitivity: null,
        rcdWaveformType: null,
        bsEn: null,
        confidence: 0,
        crop: { bbox: c.bbox, base64: c.buffer.toString('base64') },
      }
  );

  return { slots, usage, batchCount: batches.length };
}

// ---------------------------------------------------------------------------
// Prepare / Classify split
// ---------------------------------------------------------------------------

/**
 * Prepare the modern pipeline geometry — runs Stage 1 (rail bbox) and Stage 2
 * (module count + slot centres) sequentially. Exposed so the route handler can
 * kick off Stage 3 (`classifyModernSlots`) and Stage 4 (`extractSlotLabels`)
 * in parallel once geometry is ready — the Stage 3/4 serialisation was worth
 * ~10-15s per extraction on wide boards.
 *
 * Pure pair-of-VLM-calls pipeline: throws on VLM/key failure, the caller gets
 * a usable geometry object or an exception. No Stage 3 soft-fail semantics
 * live here (that belongs to the classifier half).
 *
 * @param {Buffer} imageBuffer
 * @returns {Promise<{
 *   medianRails: object,
 *   moduleCount: number,
 *   vlmCount: number,
 *   disagreement: boolean,
 *   lowConfidence: boolean,
 *   slotCentersX: number[],
 *   moduleWidth: number,
 *   mainSwitchWidth: number,
 *   mainSwitchCenterX: number|null,
 *   imageWidth: number,
 *   imageHeight: number,
 *   stageOutputs: { stage1: object, stage2: object },
 *   timings: { stage1Ms: number, stage2Ms: number },
 *   usage: { inputTokens: number, outputTokens: number }
 * }>}
 * @throws on any VLM failure or missing key (no fallback — caller decides).
 */
export async function prepareModernGeometry(imageBuffer) {
  const t0 = Date.now();
  const stage1 = await getRailGeometry(imageBuffer);
  const stage1Ms = Date.now() - t0;

  const t1 = Date.now();
  const stage2 = await getModuleCount(imageBuffer, stage1.medianRails);
  const stage2Ms = Date.now() - t1;

  const usage = {
    inputTokens: stage1.usage.inputTokens + stage2.usage.inputTokens,
    outputTokens: stage1.usage.outputTokens + stage2.usage.outputTokens,
  };

  // Roll the Stage 2 truncation signal into top-level lowConfidence so the
  // route handler can surface it (and iOS can render the existing lowConf
  // banner / amber state) without needing a second flag.
  const lowConfidence = stage1.lowConfidence || !!stage2.truncatedFromDisagreement;

  return {
    medianRails: stage1.medianRails,
    moduleCount: stage2.geometricCount,
    vlmCount: stage2.vlmCount,
    disagreement: stage2.disagreement,
    truncatedFromDisagreement: !!stage2.truncatedFromDisagreement,
    lowConfidence,
    slotCentersX: stage2.slotCentersX,
    moduleWidth: stage2.moduleWidth,
    mainSwitchWidth: stage2.mainSwitchWidth,
    mainSwitchCenterX: stage2.mainSwitchCenterX,
    mainSwitchSide: stage2.mainSwitchSide ?? null,
    imageWidth: stage1.imageWidth,
    imageHeight: stage1.imageHeight,
    stageOutputs: {
      stage1: {
        rails: stage1.rails,
        medianRails: stage1.medianRails,
        sdPct: stage1.sdPct,
        lowConfidence: stage1.lowConfidence,
        usage: stage1.usage,
      },
      stage2: {
        geometricCount: stage2.geometricCount,
        vlmCount: stage2.vlmCount,
        slotCentersX: stage2.slotCentersX,
        mainSwitchCenterX: stage2.mainSwitchCenterX,
        mainSwitchWidth: stage2.mainSwitchWidth,
        mainSwitchSide: stage2.mainSwitchSide ?? null,
        moduleWidth: stage2.moduleWidth,
        disagreement: stage2.disagreement,
        truncatedFromDisagreement: !!stage2.truncatedFromDisagreement,
        usage: stage2.usage,
      },
    },
    timings: { stage1Ms, stage2Ms },
    usage,
  };
}

/**
 * Classify modern pipeline slots — runs Stage 3 (per-slot crop + VLM classify
 * + device-face lookup gap-fill) given a geometry object from
 * `prepareModernGeometry`. Soft-fail: any error is returned on `stage3Error`,
 * `slots` is null. Mirrors the Stage 3 block inside the old orchestrator
 * verbatim so behaviour stays identical.
 *
 * @param {Buffer} imageBuffer
 * @param {object} preparedGeom  Output of `prepareModernGeometry`.
 * @returns {Promise<{
 *   slots: Array|null,
 *   stage3Error: string|null,
 *   timings: { stage3Ms: number },
 *   usage: { inputTokens: number, outputTokens: number },
 *   stageOutputs: { stage3: object }
 * }>}
 */
export async function classifyModernSlots(imageBuffer, preparedGeom) {
  if (!preparedGeom || !Array.isArray(preparedGeom.slotCentersX)) {
    throw new Error('classifyModernSlots: preparedGeom.slotCentersX must be an array');
  }

  let slots = null;
  let stage3Error = null;
  let stage3Usage = { inputTokens: 0, outputTokens: 0 };
  let stage3BatchCount = 0;
  const t2 = Date.now();
  try {
    const slotCrops = [];
    for (let i = 0; i < preparedGeom.slotCentersX.length; i++) {
      const crop = await cropSlot(imageBuffer, i, {
        slotCentersX: preparedGeom.slotCentersX,
        moduleWidth: preparedGeom.moduleWidth,
        railTop: preparedGeom.medianRails.rail_top,
        railBottom: preparedGeom.medianRails.rail_bottom,
        imageWidth: preparedGeom.imageWidth,
        imageHeight: preparedGeom.imageHeight,
      });
      slotCrops.push({ slotIndex: i, buffer: crop.buffer, bbox: crop.bbox });
    }

    const classified = await classifySlots(imageBuffer, slotCrops);
    // Stage 4 — device-face lookup gap-fill. Only applied when Stage 3 is confident
    // and returned a real device (not 'blank' / 'unknown'); otherwise a low-confidence
    // mis-read would pull in default poles / bsEn from the lookup table and mask the
    // fact that the VLM couldn't read the slot. Pure gap-fill — VLM-confirmed values
    // are never overwritten. See: docs/plans/2026-04-16-ccu-geometric-extraction-design.md §5 Phase D.
    slots = classified.slots.map((slot) => {
      const cls = slot.classification;
      const conf = typeof slot.confidence === 'number' ? slot.confidence : 0;
      if (cls === 'blank' || cls === 'unknown' || conf < 0.7) return slot;
      return applyDeviceLookup(slot);
    });
    stage3Usage = classified.usage;
    stage3BatchCount = classified.batchCount;
  } catch (err) {
    stage3Error = err && err.message ? err.message : String(err);
  }
  const stage3Ms = Date.now() - t2;

  return {
    slots,
    stage3Error,
    timings: { stage3Ms },
    usage: stage3Usage,
    stageOutputs: {
      stage3: {
        slots,
        error: stage3Error,
        batchCount: stage3BatchCount,
        batchSize: CCU_STAGE3_BATCH_SIZE,
        usage: stage3Usage,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the full three-stage geometric extraction pipeline.
 *
 * THIN WRAPPER around `prepareModernGeometry` + `classifyModernSlots` — kept
 * for backward compatibility with the non-route-handler callers (tests, any
 * batch re-analysis scripts). The route handler no longer calls this —
 * instead it awaits `prepareModernGeometry` and dispatches Stage 3 +
 * Stage 4 (label pass) in parallel via `Promise.all`.
 *
 * Result shape IS IDENTICAL to the pre-split implementation — the split-
 * function tests exercise the halves, the existing orchestrator tests
 * exercise the wrapper verbatim.
 *
 * @param {Buffer} imageBuffer
 * @returns {Promise<object>} Combined result with stage1, stage2, stage3 and top-level convenience fields.
 * @throws on any Stage 1/2 VLM failure or missing key (Stage 3 is still soft-fail inside classifyModernSlots).
 */
export async function extractCcuGeometric(imageBuffer) {
  const prepared = await prepareModernGeometry(imageBuffer);
  const classified = await classifyModernSlots(imageBuffer, prepared);

  const totalUsage = {
    inputTokens: prepared.usage.inputTokens + classified.usage.inputTokens,
    outputTokens: prepared.usage.outputTokens + classified.usage.outputTokens,
  };

  return {
    schemaVersion: 'ccu-geometric-v1',
    medianRails: prepared.medianRails,
    moduleCount: prepared.moduleCount,
    vlmCount: prepared.vlmCount,
    slotCentersX: prepared.slotCentersX,
    moduleWidth: prepared.moduleWidth,
    mainSwitchCenterX: prepared.mainSwitchCenterX,
    mainSwitchWidth: prepared.mainSwitchWidth,
    mainSwitchSide: prepared.mainSwitchSide ?? null,
    lowConfidence: prepared.lowConfidence,
    disagreement: prepared.disagreement,
    truncatedFromDisagreement: !!prepared.truncatedFromDisagreement,
    imageWidth: prepared.imageWidth,
    imageHeight: prepared.imageHeight,
    slots: classified.slots,
    stage3Error: classified.stage3Error,
    timings: {
      stage1Ms: prepared.timings.stage1Ms,
      stage2Ms: prepared.timings.stage2Ms,
      stage3Ms: classified.timings.stage3Ms,
      totalMs: prepared.timings.stage1Ms + prepared.timings.stage2Ms + classified.timings.stage3Ms,
    },
    usage: totalUsage,
    stageOutputs: {
      stage1: prepared.stageOutputs.stage1,
      stage2: prepared.stageOutputs.stage2,
      stage3: classified.stageOutputs.stage3,
    },
  };
}
