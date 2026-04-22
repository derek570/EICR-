/**
 * CCU Stage 4 — Per-slot label reading
 *
 * Separate VLM pass that reads the circuit label text adjacent to each slot.
 * Works for both modern DIN-rail boards (labels in strip-label channels above
 * or below each module) AND rewireable fuse boards (paper stickers on the
 * metal cover, handwritten labels above carriers). Same crop geometry for
 * both: slot horizontal extent × wider vertical extent (panel_top - 80% up
 * to panel_bottom + 40% down) so the VLM sees the label zones on every
 * common layout without being overwhelmed by the whole board.
 *
 * Runs after Stage 3 (device classification). Separate from Stage 3 so the
 * classification prompt stays focused — mixing "identify the device" with
 * "read text 200 pixels above" was the kind of whole-board reasoning that
 * single-shot fails at.
 *
 * Output shape: `[{ slotIndex, label, confidence }]`, one entry per input
 * slot, in input order. Labels are normalised to EICR standard terms
 * ("Lights", "Kitchen Sockets", "Water Heater", etc.) — the same map as
 * `normaliseCircuitLabels` in the route handler. Slots with no readable
 * label or where the VLM is unconfident get `label: null`.
 *
 * Feeds: the route handler's `slotsToCircuits` merger, which now sources
 * circuit labels from this pass (not from the single-shot prompt).
 *
 * Soft-fail: any VLM or crop failure throws; the caller is expected to
 * swallow the throw and emit the underlying slots with `label: null` plus
 * the error on `labelPassError`, so Stage 3 data is never lost because
 * Stage 4 tripped.
 */

import sharp from 'sharp';

const CCU_LABEL_MODEL = (
  process.env.CCU_LABEL_MODEL ||
  process.env.CCU_GEOMETRIC_MODEL ||
  process.env.CCU_MODEL ||
  'claude-sonnet-4-6'
).trim();
const CCU_LABEL_MAX_TOKENS = 1024;
const CCU_LABEL_TIMEOUT_MS = Number(process.env.CCU_LABEL_TIMEOUT_MS || 60_000);
const CCU_LABEL_BATCH_SIZE = 4;

/**
 * Duplicated from `src/routes/extraction.js:normaliseCircuitLabels`. Keep in sync
 * when adding new normalisations. Plan: de-dupe into a shared `src/utils/eicr-
 * labels.js` in a follow-up refactor — too many test-mocking seams to disrupt
 * right now.
 */
const LABEL_MAP = [
  { pattern: /^immersion\s*heater$/i, label: 'Water Heater' },
  { pattern: /^immersion$/i, label: 'Water Heater' },
  { pattern: /^imm$/i, label: 'Water Heater' },
  { pattern: /^hot\s*water$/i, label: 'Water Heater' },
  { pattern: /^hw$/i, label: 'Water Heater' },
  { pattern: /^heater$/i, label: 'Water Heater' },
  { pattern: /^smokes?$/i, label: 'Smoke Alarm' },
  { pattern: /^smoke\s*det(ector)?s?$/i, label: 'Smoke Alarm' },
  { pattern: /^s\/?d$/i, label: 'Smoke Alarm' },
  { pattern: /^smoke\s*alarms?$/i, label: 'Smoke Alarm' },
  { pattern: /^fire\s*alarm$/i, label: 'Smoke Alarm' },
  { pattern: /^lts$/i, label: 'Lights' },
  { pattern: /^ltg$/i, label: 'Lighting' },
  { pattern: /^ckr$/i, label: 'Cooker' },
  { pattern: /^shwr$/i, label: 'Shower' },
  { pattern: /^blr$/i, label: 'Boiler' },
  { pattern: /^f\/?f$/i, label: 'Fridge Freezer' },
  { pattern: /^fridge\s*freezer$/i, label: 'Fridge Freezer' },
  { pattern: /^ch$/i, label: 'Central Heating' },
  { pattern: /^central\s*heating$/i, label: 'Central Heating' },
  { pattern: /^ufh$/i, label: 'Underfloor Heating' },
  { pattern: /^under\s*floor\s*heat(ing)?$/i, label: 'Underfloor Heating' },
  { pattern: /^ev(cp)?$/i, label: 'Electric Vehicle' },
  { pattern: /^ev\s*charg(er|ing)$/i, label: 'Electric Vehicle' },
  { pattern: /^w\/?m$/i, label: 'Washing Machine' },
  { pattern: /^washer$/i, label: 'Washing Machine' },
  { pattern: /^t\/?d$/i, label: 'Tumble Dryer' },
  {
    pattern: /^skt\s+(.+)$/i,
    label: null,
    transform: (m) => {
      const prefix = m[1].trim();
      return prefix.charAt(0).toUpperCase() + prefix.slice(1).toLowerCase() + ' Sockets';
    },
  },
  { pattern: /^skts?\s*$/i, label: 'Sockets' },
];

/**
 * Normalise a raw label string to EICR standard terminology. Returns null
 * for empty/placeholder input. Exported for unit tests and potential reuse
 * from the route handler when we de-dupe with `normaliseCircuitLabels`.
 */
export function normaliseLabel(raw) {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed || trimmed.toLowerCase() === 'null') return null;

  for (const entry of LABEL_MAP) {
    const m = trimmed.match(entry.pattern);
    if (m) {
      if (entry.transform) return entry.transform(m);
      return entry.label;
    }
  }

  // Title-case cleanup when the whole string is mono-case (e.g. "KITCHEN SOCKETS"
  // or "kitchen sockets" → "Kitchen Sockets"). Don't re-case mixed-case input —
  // inspectors often write things like "FF in garage" where case is meaningful.
  if (
    trimmed.length > 1 &&
    (trimmed === trimmed.toLowerCase() || trimmed === trimmed.toUpperCase())
  ) {
    return trimmed.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  }

  return trimmed;
}

/**
 * Convert 0-1000 normalised coordinate to pixel, clamped to image bounds.
 */
function normToPx(value, dimension) {
  const px = (value / 1000) * dimension;
  return Math.max(0, Math.min(dimension, Math.round(px)));
}

async function getAnthropicClient() {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  return new Anthropic({ apiKey: anthropicKey });
}

/**
 * Crop a slot's LABEL ZONE — horizontal extent of the slot, vertical extent
 * widened to capture above-carrier stickers AND below-carrier strip labels.
 *
 * @param {Buffer} imageBuffer - Full CCU JPEG bytes.
 * @param {number} slotIndex - Index into geom.slotCentersX.
 * @param {object} geom
 * @param {number[]} geom.slotCentersX - Pixel-space slot centres from Stage 2.
 * @param {number}   geom.slotPitchPx  - Pitch in pixels (moduleWidth / carrierPitch).
 * @param {number}   geom.panelTopNorm
 * @param {number}   geom.panelBottomNorm
 * @param {number}   geom.imageWidth
 * @param {number}   geom.imageHeight
 * @returns {Promise<{buffer: Buffer, bbox: {x:number,y:number,w:number,h:number}}>}
 */
export async function cropSlotLabelZone(imageBuffer, slotIndex, geom) {
  if (!Buffer.isBuffer(imageBuffer)) {
    throw new Error('cropSlotLabelZone: imageBuffer must be a Buffer');
  }
  const {
    slotCentersX,
    slotPitchPx,
    panelTopNorm,
    panelBottomNorm,
    imageWidth,
    imageHeight,
  } = geom || {};
  if (!Array.isArray(slotCentersX) || slotCentersX.length === 0) {
    throw new Error('cropSlotLabelZone: geom.slotCentersX must be a non-empty array');
  }
  if (slotIndex < 0 || slotIndex >= slotCentersX.length) {
    throw new Error(
      `cropSlotLabelZone: slotIndex ${slotIndex} out of range (0..${slotCentersX.length - 1})`
    );
  }
  if (!Number.isFinite(slotPitchPx) || slotPitchPx <= 0) {
    throw new Error('cropSlotLabelZone: geom.slotPitchPx must be a positive number');
  }
  if (
    !Number.isFinite(panelTopNorm) ||
    !Number.isFinite(panelBottomNorm) ||
    panelBottomNorm <= panelTopNorm
  ) {
    throw new Error('cropSlotLabelZone: geom.panelTopNorm/panelBottomNorm invalid');
  }
  if (
    !Number.isFinite(imageWidth) ||
    imageWidth <= 0 ||
    !Number.isFinite(imageHeight) ||
    imageHeight <= 0
  ) {
    throw new Error('cropSlotLabelZone: geom.imageWidth and imageHeight must be positive');
  }

  const centerXPx = slotCentersX[slotIndex];
  const panelTopPx = normToPx(panelTopNorm, imageHeight);
  const panelBottomPx = normToPx(panelBottomNorm, imageHeight);
  const panelHeightPx = panelBottomPx - panelTopPx;

  // Horizontal: 2× pitch wide (±1 pitch either side of the slot centre).
  // Same as Stage 3, so labels sitting directly above/below the specific slot
  // are captured without pulling in a full neighbour slot's label.
  const halfWidthPx = slotPitchPx;

  // Vertical: extend UP by 80% of panel height (captures paper stickers on
  // the cover above the carrier row, handwritten labels on the frame, and
  // typical 10mm strip-label channels above modern DIN rails) and DOWN by
  // 40% (below-rail strip labels and inside-door label strips). Clamped to
  // image bounds.
  const topPx = Math.max(0, Math.round(panelTopPx - panelHeightPx * 0.8));
  const bottomPx = Math.min(imageHeight, Math.round(panelBottomPx + panelHeightPx * 0.4));

  const leftPx = Math.max(0, Math.round(centerXPx - halfWidthPx));
  const rightPx = Math.min(imageWidth, Math.round(centerXPx + halfWidthPx));
  const wPx = Math.max(1, rightPx - leftPx);
  const hPx = Math.max(1, bottomPx - topPx);

  const buffer = await sharp(imageBuffer)
    .extract({ left: leftPx, top: topPx, width: wPx, height: hPx })
    // Upscale to 1024 wide for VLM legibility (matches modern/rewireable Stage 3
    // crop resize). Labels are often small — the extra resolution matters.
    .resize({ width: 1024, withoutEnlargement: false })
    .jpeg({ quality: 90 })
    .toBuffer();

  return {
    buffer,
    bbox: { x: leftPx, y: topPx, w: wPx, h: hPx },
  };
}

/**
 * Prompt: ask the VLM to read the single most relevant circuit label for each
 * crop. Wording kept tight because we're batching — the VLM has to hold N
 * crops + instructions + echo N slot_index values in output.
 */
const LABEL_READ_PROMPT = (
  slotIndices
) => `You are looking at ${slotIndices.length} cropped image${slotIndices.length === 1 ? '' : 's'} from a UK consumer unit (fuseboard). Each crop shows ONE circuit position's WIDER area — the carrier / breaker itself plus the label zones above AND below it.

The slot indices, in order of the images you are seeing, are: [${slotIndices.join(', ')}].

For EACH crop, return the ONE label text that identifies the circuit at that position. Labels may be:
- A paper sticker above or below the device
- A printed strip label in a 10mm channel directly above or below a DIN rail module
- Handwritten text on the board cover, panel, or carrier itself
- A punched/engraved label on the cover

If you see multiple labels in a crop, choose the ONE that most clearly corresponds to the central device. If two equally plausible labels exist (ambiguous sticker placement), set label=null and mark low confidence.
If there is no readable label, set label=null.

DO NOT return text from elsewhere on the board (schedule cards, brand names, BS/EN numbers, ratings, "Main Switch" text that applies to the main isolator). Focus on the single-word or short-phrase circuit designations — "Shower", "Lights", "Sockets", "Cooker", "Immersion", "Boiler", "Smokes", etc.

Use shorthand EXACTLY as written if you cannot expand it confidently — we normalise "Imm" → "Water Heater", "Skts" → "Sockets", "Ckr" → "Cooker", "Shwr" → "Shower" downstream. Don't invent expansions.

Return ONLY a JSON array, one object per crop, in the SAME ORDER as the images you received. Echo back slot_index to prove alignment:
[
  {"slot_index": <int>, "label": <string|null>, "confidence": <float>},
  ...
]`;

/**
 * Core Stage 4 pipeline — takes pre-cropped slot buffers and asks the VLM
 * to read the circuit label at each one. Batched 4 crops per VLM message.
 *
 * @param {Array<{slotIndex:number, buffer:Buffer, bbox:object}>} slotCrops
 * @param {{anthropicClient?: object, model?: string}} [opts]
 * @returns {Promise<{labels: Array<{slotIndex:number, label:string|null, rawLabel:string|null, confidence:number}>, usage: {inputTokens:number, outputTokens:number}, batchCount:number}>}
 */
export async function readSlotLabels(slotCrops, opts = {}) {
  if (!Array.isArray(slotCrops)) {
    throw new Error('readSlotLabels: slotCrops must be an array');
  }
  if (slotCrops.length === 0) {
    return { labels: [], usage: { inputTokens: 0, outputTokens: 0 }, batchCount: 0 };
  }

  // Confidence threshold: opts > env > default 0.5
  let threshold = 0.5;
  if (typeof opts.labelConfidenceMin === 'number') {
    threshold = opts.labelConfidenceMin;
  } else {
    const envVal = parseFloat(process.env.CCU_LABEL_CONFIDENCE_MIN);
    if (Number.isFinite(envVal)) threshold = envVal;
  }

  const anthropic = opts.anthropicClient || (await getAnthropicClient());
  const model = opts.model || CCU_LABEL_MODEL;

  const batches = [];
  for (let i = 0; i < slotCrops.length; i += CCU_LABEL_BATCH_SIZE) {
    batches.push(slotCrops.slice(i, i + CCU_LABEL_BATCH_SIZE));
  }

  const resultsBySlotIndex = new Map();
  const usage = { inputTokens: 0, outputTokens: 0 };

  for (const batch of batches) {
    const slotIndices = batch.map((b) => b.slotIndex);
    const base64s = batch.map((b) => b.buffer.toString('base64'));

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), CCU_LABEL_TIMEOUT_MS);
    let response;
    try {
      response = await anthropic.messages.create(
        {
          model,
          max_tokens: CCU_LABEL_MAX_TOKENS,
          messages: [
            {
              role: 'user',
              content: [
                ...base64s.map((data) => ({
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/jpeg', data },
                })),
                { type: 'text', text: LABEL_READ_PROMPT(slotIndices) },
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
      throw new Error(`readSlotLabels: failed to parse VLM array response: ${err.message}`);
    }

    const u = response.usage || {};
    usage.inputTokens += u.input_tokens || 0;
    usage.outputTokens += u.output_tokens || 0;

    for (let i = 0; i < batch.length; i++) {
      const crop = batch[i];
      const vlmItem = arr.find((x) => x && x.slot_index === crop.slotIndex) || arr[i] || {};

      const rawLabel =
        typeof vlmItem.label === 'string' && vlmItem.label.trim().length > 0
          ? vlmItem.label.trim()
          : null;
      const confidence = typeof vlmItem.confidence === 'number' ? vlmItem.confidence : 0;
      // Apply confidence gate: null out the label when confidence is below
      // the threshold so low-confidence guesses don't propagate as hallucinations.
      // rawLabel is kept intact so debug/review tooling can still inspect what
      // the VLM thought it saw.
      const normalisedLabel = normaliseLabel(rawLabel);
      const label = confidence >= threshold ? normalisedLabel : null;

      resultsBySlotIndex.set(crop.slotIndex, {
        slotIndex: crop.slotIndex,
        label,
        rawLabel,
        confidence,
      });
    }
  }

  const labels = slotCrops.map(
    (c) =>
      resultsBySlotIndex.get(c.slotIndex) || {
        slotIndex: c.slotIndex,
        label: null,
        rawLabel: null,
        confidence: 0,
      }
  );

  return { labels, usage, batchCount: batches.length };
}

/**
 * Orchestrator: given the full image + geometry from a geometric pipeline
 * (modern or rewireable) + the set of slot indices to read labels for,
 * crop each slot's label zone and run the VLM batch reader.
 *
 * Skips slots whose Stage 3 classification has already been identified as
 * `main_switch`, `spd`, or `blank` — labels don't apply there, and skipping
 * saves crops + VLM tokens.
 *
 * @param {Buffer} imageBuffer
 * @param {object} geom
 * @param {number[]} geom.slotCentersX
 * @param {number}   geom.slotPitchPx
 * @param {number}   geom.panelTopNorm
 * @param {number}   geom.panelBottomNorm
 * @param {number}   geom.imageWidth
 * @param {number}   geom.imageHeight
 * @param {Array<{slotIndex:number, classification:string}>} [geom.slotsForSkipHint] - Stage 3 output for skip filtering
 * @param {object} [opts]
 * @returns {Promise<{labels: Array, usage: object, batchCount: number, skippedSlotIndices: number[], timings: {cropMs:number, vlmMs:number, totalMs:number}}>}
 */
export async function extractSlotLabels(imageBuffer, geom, opts = {}) {
  if (!Buffer.isBuffer(imageBuffer)) {
    throw new Error('extractSlotLabels: imageBuffer must be a Buffer');
  }
  const totalT0 = Date.now();

  const slotsForSkip = Array.isArray(geom.slotsForSkipHint) ? geom.slotsForSkipHint : [];
  const skippedSlotIndices = slotsForSkip
    .filter((s) => {
      const c = (s?.classification || '').toLowerCase();
      return c === 'main_switch' || c === 'spd' || c === 'blank';
    })
    .map((s) => s.slotIndex);

  const slotIndicesToRead = [];
  for (let i = 0; i < geom.slotCentersX.length; i++) {
    if (!skippedSlotIndices.includes(i)) slotIndicesToRead.push(i);
  }

  if (slotIndicesToRead.length === 0) {
    return {
      labels: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      batchCount: 0,
      skippedSlotIndices,
      timings: { cropMs: 0, vlmMs: 0, totalMs: Date.now() - totalT0 },
    };
  }

  const cropT0 = Date.now();
  const slotCrops = [];
  for (const slotIndex of slotIndicesToRead) {
    const { buffer, bbox } = await cropSlotLabelZone(imageBuffer, slotIndex, geom);
    slotCrops.push({ slotIndex, buffer, bbox });
  }
  const cropMs = Date.now() - cropT0;

  const vlmT0 = Date.now();
  const classified = await readSlotLabels(slotCrops, opts);
  const vlmMs = Date.now() - vlmT0;

  return {
    labels: classified.labels,
    usage: classified.usage,
    batchCount: classified.batchCount,
    skippedSlotIndices,
    timings: {
      cropMs,
      vlmMs,
      totalMs: Date.now() - totalT0,
    },
  };
}

// Exported for unit tests.
export { LABEL_MAP };
