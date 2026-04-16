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
- manufacturer   — brand stamped on the face (e.g. "Hager", "MK", "Wylex", "MEM", "Crabtree", "Eaton", "Schneider", "BG", "Fusebox", "Contactum"). null if illegible.
- model          — product family if printed (e.g. "Memera 2000", "Design 10"). null if not shown.
- ratingAmps     — integer amp rating (6, 10, 16, 20, 25, 32, 40, 50, 63, 80, 100). null if unreadable.
- poles          — 1, 2, 3 or 4. Default to 1 for a single-module MCB, 2 for RCBOs / RCDs / main switch unless the physical width is clearly different.
- confidence     — your self-assessed 0.0–1.0 confidence in the classification.

For blanks, SPDs and main switches: manufacturer / model / ratingAmps may be null; still return poles (1 for blank/SPD, 2 for main_switch) and confidence.

Return ONLY a JSON array, one object per crop, in the SAME ORDER as the images you received. Echo back slot_index to prove alignment:
[
  {"slot_index": <int>, "classification": "<string>", "manufacturer": <string|null>, "model": <string|null>, "ratingAmps": <int|null>, "poles": <int>, "confidence": <float>},
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

  const railWidth = medianRails.rail_right - medianRails.rail_left;
  if (railWidth <= 0) {
    throw new Error('getModuleCount: rail_right must be greater than rail_left');
  }

  const moduleWidth = main_switch_width / 2; // main switch is always 2 modules wide
  const geometricCount = Math.round(railWidth / moduleWidth);

  const slotCentersX = [];
  for (let i = 0; i < geometricCount; i++) {
    slotCentersX.push(medianRails.rail_left + moduleWidth * (i + 0.5));
  }

  const vlmCount = Math.round(module_count_direct);
  const disagreement = Math.abs(geometricCount - vlmCount) >= 1;

  return {
    geometricCount,
    vlmCount,
    slotCentersX,
    disagreement,
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

  // 20% H padding: half-width = 0.5 * moduleWidth * (1 + 0.20)
  const halfWidthNorm = moduleWidth * 0.5 * 1.2;
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
        poles: typeof vlmItem.poles === 'number' ? vlmItem.poles : 1,
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
        poles: 1,
        confidence: 0,
        crop: { bbox: c.bbox, base64: c.buffer.toString('base64') },
      }
  );

  return { slots, usage, batchCount: batches.length };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the full two-stage geometric extraction pipeline.
 *
 * @param {Buffer} imageBuffer
 * @returns {Promise<object>} Combined result with stage1, stage2 and top-level convenience fields.
 * @throws on any VLM failure or missing key (no fallback — caller decides).
 */
export async function extractCcuGeometric(imageBuffer) {
  const t0 = Date.now();
  const stage1 = await getRailGeometry(imageBuffer);
  const stage1Ms = Date.now() - t0;

  const t1 = Date.now();
  const stage2 = await getModuleCount(imageBuffer, stage1.medianRails);
  const stage2Ms = Date.now() - t1;

  // Stage 3 — per-slot classification. SOFT-FAIL: any error is captured on
  // stage3Error and slots is set to null. Stages 1/2 output is still returned
  // so the caller can render rail + module-count UI without blocking on Stage 3.
  let slots = null;
  let stage3Error = null;
  let stage3Usage = { inputTokens: 0, outputTokens: 0 };
  let stage3Ms = 0;
  let stage3BatchCount = 0;
  const t2 = Date.now();
  try {
    const slotCrops = [];
    for (let i = 0; i < stage2.slotCentersX.length; i++) {
      const crop = await cropSlot(imageBuffer, i, {
        slotCentersX: stage2.slotCentersX,
        moduleWidth: stage2.moduleWidth,
        railTop: stage1.medianRails.rail_top,
        railBottom: stage1.medianRails.rail_bottom,
        imageWidth: stage1.imageWidth,
        imageHeight: stage1.imageHeight,
      });
      slotCrops.push({ slotIndex: i, buffer: crop.buffer, bbox: crop.bbox });
    }

    const classified = await classifySlots(imageBuffer, slotCrops);
    // Stage 4 — device-face lookup gap-fill. Applied to every classified slot so that
    // the VLM's (manufacturer, model) identification can fill any bsEn / rcdWaveformType
    // blanks it couldn't read directly off the device face. Pure gap-fill — VLM-confirmed
    // values are never overwritten. See: docs/plans/2026-04-16-ccu-geometric-extraction-design.md §5 Phase D.
    slots = classified.slots.map((slot) => applyDeviceLookup(slot));
    stage3Usage = classified.usage;
    stage3BatchCount = classified.batchCount;
  } catch (err) {
    stage3Error = err && err.message ? err.message : String(err);
  }
  stage3Ms = Date.now() - t2;

  const totalUsage = {
    inputTokens: stage1.usage.inputTokens + stage2.usage.inputTokens + stage3Usage.inputTokens,
    outputTokens: stage1.usage.outputTokens + stage2.usage.outputTokens + stage3Usage.outputTokens,
  };

  return {
    schemaVersion: 'ccu-geometric-v1',
    medianRails: stage1.medianRails,
    moduleCount: stage2.geometricCount,
    vlmCount: stage2.vlmCount,
    slotCentersX: stage2.slotCentersX,
    moduleWidth: stage2.moduleWidth,
    mainSwitchCenterX: stage2.mainSwitchCenterX,
    mainSwitchWidth: stage2.mainSwitchWidth,
    lowConfidence: stage1.lowConfidence,
    disagreement: stage2.disagreement,
    imageWidth: stage1.imageWidth,
    imageHeight: stage1.imageHeight,
    slots,
    stage3Error,
    timings: { stage1Ms, stage2Ms, stage3Ms, totalMs: stage1Ms + stage2Ms + stage3Ms },
    usage: totalUsage,
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
        moduleWidth: stage2.moduleWidth,
        disagreement: stage2.disagreement,
        usage: stage2.usage,
      },
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
