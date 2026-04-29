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
import { detectModulePitchCv } from './ccu-cv-pitch.js';

const CCU_GEOMETRIC_MODEL = (process.env.CCU_GEOMETRIC_MODEL || 'claude-sonnet-4-6').trim();
const CCU_GEOMETRIC_MAX_TOKENS = 1024;
// Stage 3 needs a bigger response envelope — batched classifications each return a JSON object.
const CCU_STAGE3_MAX_TOKENS = 2048;
const CCU_GEOMETRIC_TIMEOUT_MS = Number(process.env.CCU_GEOMETRIC_TIMEOUT_MS || 60_000);

// Stage 2 groups mode (2026-04-28) — reframes Stage 2's prompt to ask for an
// array of TIGHT per-group MCB bounding boxes instead of a single
// populated_area_start_x / end_x rectangle. Driven by the realisation that
// with the iOS capture-then-frame UI (CCUFramingView, ccu-framing branch)
// the user already supplies a rough crop around the MCBs — Stage 2's job
// becomes "find each MCB tightly within this user-supplied region", which:
//   1. Handles split-load boards natively (two groups separated by a gap;
//      old prompt asked for one rect with "skip middle gaps" hint, which
//      field experience says lands on the gap and loses one half of the
//      board).
//   2. Eliminates the rail-extent compounding bug where Stage 1's rail_right
//      overshoots and Stage 2's populated_area extends with it, cropping
//      into the last MCB ("losing big chunks of MCB", Derek 2026-04-28).
//   3. Robust to loose user framing — VLM only reports groups around real
//      devices; empty space at the box edges is ignored.
// Default OFF so the existing populated_area path keeps running until field
// data confirms the new path is at least as accurate. Flip via task-def env.
// Function (not const) so tests can toggle process.env.CCU_STAGE2_GROUPS
// without re-importing the module.
function isCcuStage2GroupsEnabled() {
  return (process.env.CCU_STAGE2_GROUPS || 'false').trim().toLowerCase() === 'true';
}
// CV-based module-pitch detection (Sobel-X + autocorrelation) replaces the
// 44.5mm height-anchor calibration with direct edge analysis of the photo.
// Default ON since 2026-04-29 (Derek field-test confidence). Set
// CCU_CV_PITCH=false on the task-def to roll back without redeploy. When
// CV detection has low confidence (small board, low contrast), the
// height-anchor path runs as fallback.
function isCcuCvPitchEnabled() {
  return (process.env.CCU_CV_PITCH || 'true').trim().toLowerCase() === 'true';
}
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

Also identify the horizontal bounds of the POPULATED AREA on the rail. "Populated" includes:
- devices (MCBs, RCBOs, RCDs, main switches)
- blanking plates (1-module plastic covers that fill unused slots)
- empty slots in the middle of the rail that have devices or blanks further left/right — do NOT stop at middle gaps, split-load RCD boards and RCBO boards with removed circuits are common
Only stop at the true ends of the populated area: the far-left edge of the leftmost element, and the far-right edge of the rightmost element. Exclude any exposed DIN rail past the last element at either end.

Report:
1. The x-coordinate of the main switch's CENTRE on the 0-1000 scale (main_switch_center_x).
2. The TOTAL width of the main switch on the 0-1000 scale (main_switch_width).
3. A direct count of how many module positions fit on the rail between rail_left and rail_right (module_count_direct). A module is an 18mm-wide slot — a single MCB is 1 module, an RCBO or RCD or main switch is 2 modules, blanks count as 1 module each.
4. The x-coordinate of the far-LEFT edge of the populated area on the 0-1000 scale (populated_area_start_x). Leftmost device or blanking plate.
5. The x-coordinate of the far-RIGHT edge of the populated area on the 0-1000 scale (populated_area_end_x). Rightmost device or blanking plate. Skip middle gaps — if there's a gap in the middle with more devices or blanks further right, continue past the gap to the true end.

Respond with JSON only:
{"main_switch_center_x": <int>, "main_switch_width": <int>, "module_count_direct": <int>, "populated_area_start_x": <int>, "populated_area_end_x": <int>}`;

// Stage 2 tighten-and-chunk prompt (CCU_STAGE2_GROUPS=true, Derek 2026-04-28).
// Replaces the failed groups-with-counts schema. The VLM has ONE job: return
// the rectangle that tightly encloses every device on the DIN rail (RCD,
// MCBs, RCBOs, blanks, main switch — everything mounted on the rail). No
// counting, no grouping, no per-device list, no module pitch derivation.
//
// Backend then chunks the bbox geometrically using two hard standards:
//   - MCB visible-face height = 44.5mm (DIN 43880 front-zone, ±1.5mm
//     across Wylex / Hager / Crabtree / Schneider / MK / Chint /
//     Contactum / Eaton). NOT the 82.5mm full body — most of the body
//     sits behind the cover plate and is invisible in the photo.
//   - DIN module pitch = 17.5mm
// pixels_per_mm = rail_height_px / 44.5; module_count = round(rail_width_px /
// (17.5 * pixels_per_mm)). Stage 3 classifies each tiled slot, so split-
// load gaps appear as `blank` classifications, the main switch as
// `main_switch`, etc. — all handled downstream by slotsToCircuits.
//
// Why this beats per-group bboxes (the previous schema):
//   - Inconsistent VLM responses on group boundaries / counts disappear:
//     yesterday it split into 2 groups (lost spares in the gap), this
//     morning it merged into 1 (under-counted), the morning before that it
//     mis-aligned start_x relative to module_count (Stage 3 cropped between
//     devices). Now the VLM is asked to find FOUR EDGES of a single
//     rectangle. That's a task Sonnet 4.6 nails reliably.
//   - Module count derives from a hard physical standard (DIN 17.5mm pitch)
//     instead of asking the VLM to count. Counting is the VLM's most
//     unreliable behaviour; we just stop asking it to count.
//   - Loose user framing (extra background past the device row) gets
//     auto-tightened by the VLM in this single-bbox step. No more lost
//     edge MCBs from rail-overshoot compounding.
//
// Known risk (Derek 2026-04-28): "small error compounds all the way along
// where we could end up reading half an MCB at the end". Mitigated by
// (1) cross-checking pixels_per_mm derived from rail height vs derived
// from main_switch_width when present (>10% disagreement → lowConfidence
// flagged); (2) logging per-slot positions in CloudWatch so drift is
// visible. Long-term mitigation if drift turns out to be real: use Stage
// 3's per-slot device-centroid feedback to re-anchor remaining slots.
const MODULE_COUNT_PROMPT_GROUPS = (
  rails
) => `This image is a USER-CROPPED region of a UK consumer unit, framed roughly around the device row by an inspector on an iOS device. The crop may include extra empty space at the edges (left/right of the devices, above/below for label clearance). The DIN rail bounding box on a 0-1000 scale (within this cropped image) is approximately:
- rail_top: ${rails.rail_top}
- rail_bottom: ${rails.rail_bottom}
- rail_left: ${rails.rail_left}
- rail_right: ${rails.rail_right}

Your task: TIGHTEN this user crop to a single rectangle that encloses EVERY device mounted on the DIN rail and NOTHING ELSE. Tight on all four sides.

Devices to include in the bbox: MCBs, RCBOs, RCDs, blanking plates, and the MAIN SWITCH. Treat the main switch as PART of the device row — it sits on the same rail as the MCBs and the bbox extends to its outer edge.

Edges to pin to:
- LEFT edge: the LEFT face of the leftmost device (whichever device sits furthest left — could be the main switch on a left-handed board, an RCD, an MCB, or a blanking plate). NOT the left edge of empty rail past the last device. NOT the user-crop edge.
- RIGHT edge: the RIGHT face of the rightmost device. NOT empty rail past the last device.
- TOP edge: the TOP of the device bodies (where the MCB toggle housing meets its top face). NOT the printed label strip above the row, NOT the inside of the consumer unit cover above the rail.
- BOTTOM edge: the BOTTOM of the device bodies (where the MCB body meets its bottom face). NOT the printed label strip below, NOT the cable entry / wiring area below the rail.

The bbox top-to-bottom MUST span the FULL VISIBLE FACE of the MCB — top of the toggle housing down to the bottom of the rating-label face printed on the same molded body. The face is what protrudes through the cover plate; ~44.5mm per DIN 43880. INCLUDE the printed label face on the device — it's part of the molded body and the bottom edge of the face. EXCLUDE only the printed paper labels on the consumer-unit casing above/below the device row (those sit on the cover plate, not on the MCB).

Empty rail past the last device on either end MUST be excluded — only enclose the populated section.

Also report the MAIN SWITCH separately (used as a backup horizontal calibration anchor — main switches are 2 modules / 36mm wide). The main switch is the largest device on the rail, no test button, no sensitivity marking, NOT an RCD. If no main switch is visible (inline-mains rewireable boards), report null.

Output 0-1000 normalised coordinates as integers.

Respond with JSON only:
{"rail_bbox": {"left": <int>, "right": <int>, "top": <int>, "bottom": <int>}, "main_switch_center_x": <int|null>, "main_switch_width": <int|null>}`;

// Stage 3 — classify the device in each crop. Each message contains N crops
// (CCU_STAGE3_BATCH_SIZE); the VLM must return exactly N objects in the same order.
// We send the slot_index explicitly so the VLM can echo it back and we can verify
// alignment rather than trusting positional order alone.
//
// Schema note (2026-04-23, Derek design review): the prompt now asks for an
// explicit `content` discriminator + `extends` signal on top of the existing
// classification. Vision models tend to pattern-match half-visible RCDs to the
// median residential MCB ("B32") when forced to classify — the completeness
// signal gives them a legitimate way to say "this is partial, merge me with a
// neighbour" rather than hallucinating a confident wrong answer. Downstream
// merger (Phase 4) reconciles `extends` across adjacent slots to dedupe
// multi-module devices back into single certificate circuits.
const SLOT_CLASSIFY_PROMPT = (
  slotIndices
) => `You are looking at ${slotIndices.length} cropped image${slotIndices.length === 1 ? '' : 's'} taken from a UK consumer unit (fuseboard). Each crop is centred on a single DIN rail module position (slot).

The slot indices, in order of the images you are seeing, are: [${slotIndices.join(', ')}].

For EACH crop, report THREE things:

1. CONTENT (what is in this crop):
   - "device"  — a complete electrical device centred in this crop, fully contained within the crop edges
   - "blank"   — a 1-module blanking plate (intentional plastic filler in an unused slot)
   - "empty"   — exposed DIN rail with no device and no blanking plate (UNSAFE — exposed live parts are a safety defect; reporting empty triggers a C2/C3 observation)
   - "partial" — part of a WIDER device whose body extends BEYOND this crop. Signs: body touches a crop edge, a rating label is cut off mid-number, a test button is visible but the matching rating label is not, or the device toggle is at the edge rather than centred. PREFER "partial" over guessing at a classification you're not sure about.

2. EXTENDS (if content is "device" or "partial", does the body continue beyond the crop edges?):
   - "none"   — fully contained in this crop
   - "left"   — body continues past the LEFT edge
   - "right"  — body continues past the RIGHT edge
   - "both"   — body extends past BOTH edges (very wide device, we see only its middle)

3. CLASSIFICATION (device type):
   - "mcb"          — single MCB (BS EN 60898-1), trip curve letter + amp rating (e.g. "B32")
   - "rcbo"         — combined RCD + MCB (BS EN 61009-1), test button + trip curve + amp rating
   - "rcd"          — RCD (BS EN 61008-1), test button + mA rating, NO trip curve
   - "main_switch"  — 2-module isolator, no test button, no trip curve, no mA rating, typically "100A" or "Main Switch"
   - "spd"          — Surge Protection Device (cartridges / status windows)
   - "blank"        — blanking plate (use when content="blank")
   - "empty"        — exposed rail (use when content="empty")
   - "unknown"      — cannot determine (use when content="partial" and you can't make a best guess)

   When content="partial", report classification as your BEST GUESS based on visible features:
     — test button visible but rating label cut → "rcd" or "rcbo" (best guess)
     — toggle + curve letter visible but rest cut → "mcb"
     — too ambiguous → "unknown"

For MCBs and RCBOs:
- manufacturer      — brand stamped on the face ("Hager", "MK", "Wylex", "MEM", "Crabtree", "Eaton", "Schneider", "BG", "Fusebox", "Contactum"). null if illegible.
- model             — product family if printed ("Memera 2000", "Design 10"). null if not shown.
- ratingAmps        — integer amp rating (6, 10, 16, 20, 25, 32, 40, 50, 63, 80, 100). null if unreadable.
                      **ANTI-HALLUCINATION RULE**: if content="partial" and the rating number is not FULLY visible in this crop (any digit cut off by the crop edge), you MUST return null. Do not complete "3" to "32" or "16" to "160" — if the whole number isn't visible, it's null. The merger will get the real rating from the adjacent crop that IS fully centred on this device.
- rating_text       — the EXACT visible text on the device that indicates the rating (e.g. "B32", "C20", "32A", "NSB32-C", "32"). Transcribe what you literally see; do not paraphrase. If you reported a non-null ratingAmps, rating_text MUST contain the digits of that rating exactly as printed. If no rating text is legibly visible in this crop, rating_text AND ratingAmps MUST BOTH be null. The backend cross-checks these against each other to catch hallucinated ratings.
- poles             — 1, 2, 3, or 4 if you can count them. null if unsure. Stage 4 fills defaults.
- tripCurve         — "B", "C" or "D". Same partial rule: if the letter is at a crop edge / cut off, return null. UK MCBs print the curve letter either immediately BEFORE the rating ("B32") or as a SUFFIX after it ("NSB32-C" on Wylex NH series, "32C" on MEM Memera MMB/MMC series). Both are valid — treat the suffix letter as the trip curve. If neither leading nor trailing pattern is fully visible, return null.
- confidence        — your self-assessed 0.0-1.0 confidence in the overall classification. Lower this when content="partial" — a partial crop classification should never score above 0.7.

For RCDs and RCBOs additionally:
- sensitivity       — mA sensitivity ("30", "100", "300", "500"). Integer mA. null if unreadable. Same anti-hallucination rule: if the mA number is cut off, null.
- rcdWaveformType   — "AC", "A", "F", or "B". null if the waveform symbol is not visible or unclear.

For all devices:
- bsEn              — BS EN standard number printed on the face ("BS EN 60898-1", "BS EN 61009-1", "BS EN 61008-1"). null if not visible.

For blanks, SPDs, empties, and main switches: manufacturer / model / ratingAmps / tripCurve / sensitivity / rcdWaveformType / bsEn may all be null. Still return poles (1 for blank/SPD if single-module, 2 for main_switch — null if unsure) and confidence.

Return ONLY a JSON array, one object per crop, in the SAME ORDER as the images you received. Echo back slot_index to prove alignment:
[
  {"slot_index": <int>, "content": "<string>", "extends": "<string>", "classification": "<string>", "manufacturer": <string|null>, "model": <string|null>, "ratingAmps": <int|null>, "rating_text": <string|null>, "poles": <int|null>, "tripCurve": <string|null>, "sensitivity": <int|null>, "rcdWaveformType": <string|null>, "bsEn": <string|null>, "confidence": <float>},
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
// Stage 1 alternate — Build rail geometry from an ROI hint (iOS framing box)
// ---------------------------------------------------------------------------

/**
 * Build a Stage-1-shaped result from a user-provided rail ROI hint. When the
 * iOS capture view shows an alignment rectangle and the inspector fits the
 * MCB row inside it, iOS passes the rectangle's normalised image-coord bounds
 * as `rail_roi` on the upload. Using that as ground truth skips the three
 * VLM rail-detection calls entirely — deterministic, free, and 17 seconds
 * off the wall clock.
 *
 * Accepts ROI as either {x, y, w, h} (top-left + size) or {x_min, y_min,
 * x_max, y_max} — both in 0-1 normalised coordinates relative to the full
 * captured image. Returns a shape identical to `getRailGeometry` so callers
 * don't branch on source.
 *
 * @param {Buffer} imageBuffer
 * @param {{x?:number, y?:number, w?:number, h?:number, x_min?:number, y_min?:number, x_max?:number, y_max?:number}} roi
 * @returns {{rails:Array, medianRails:object, sdPct:object, lowConfidence:false, usage:{inputTokens:0, outputTokens:0}, imageWidth:number, imageHeight:number}}
 */
async function stage1FromRoiHint(imageBuffer, roi) {
  if (!roi || typeof roi !== 'object') {
    throw new Error('stage1FromRoiHint: roi must be an object');
  }

  // Normalise either {x,y,w,h} or {x_min,y_min,x_max,y_max} to edges.
  let xMin, yMin, xMax, yMax;
  if (
    typeof roi.x === 'number' &&
    typeof roi.y === 'number' &&
    typeof roi.w === 'number' &&
    typeof roi.h === 'number'
  ) {
    xMin = roi.x;
    yMin = roi.y;
    xMax = roi.x + roi.w;
    yMax = roi.y + roi.h;
  } else if (
    typeof roi.x_min === 'number' &&
    typeof roi.y_min === 'number' &&
    typeof roi.x_max === 'number' &&
    typeof roi.y_max === 'number'
  ) {
    xMin = roi.x_min;
    yMin = roi.y_min;
    xMax = roi.x_max;
    yMax = roi.y_max;
  } else {
    throw new Error('stage1FromRoiHint: roi must have {x,y,w,h} or {x_min,y_min,x_max,y_max}');
  }

  // Clamp to [0,1] so callers cannot push slots outside the image.
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  xMin = clamp01(xMin);
  yMin = clamp01(yMin);
  xMax = clamp01(xMax);
  yMax = clamp01(yMax);
  if (xMax <= xMin || yMax <= yMin) {
    throw new Error('stage1FromRoiHint: roi collapsed to zero area after clamping');
  }

  // Convert to the 0-1000 scale Stage 1/2 operate on.
  const medianRails = {
    rail_top: Math.round(yMin * 1000),
    rail_bottom: Math.round(yMax * 1000),
    rail_left: Math.round(xMin * 1000),
    rail_right: Math.round(xMax * 1000),
  };

  const meta = await sharp(imageBuffer).metadata();

  return {
    rails: [medianRails], // single "sample" — the user's box
    medianRails,
    sdPct: { rail_top: 0, rail_bottom: 0, rail_left: 0, rail_right: 0 },
    lowConfidence: false,
    usage: { inputTokens: 0, outputTokens: 0 },
    imageWidth: meta.width || 1000,
    imageHeight: meta.height || 1000,
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
export async function getModuleCount(imageBuffer, medianRails, imageDimensions = {}, options = {}) {
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

  // Groups-mode dispatch (CCU_STAGE2_GROUPS=true). New per-group tight-bbox
  // schema; see MODULE_COUNT_PROMPT_GROUPS for the rationale. Default-off.
  if (isCcuStage2GroupsEnabled()) {
    return getModuleCountFromGroups(
      anthropic,
      imageBuffer,
      base64,
      medianRails,
      imageDimensions,
      options
    );
  }

  const sample = await callVlm(anthropic, base64, MODULE_COUNT_PROMPT(medianRails));
  const {
    main_switch_center_x,
    main_switch_width,
    module_count_direct,
    populated_area_start_x,
    populated_area_end_x,
  } = sample.parsed;

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

  // Pitch estimate #1: main-switch width ÷ 2. By BS 7671 convention every UK
  // domestic main switch is a 2-module double-pole isolator (~36mm), so this
  // gives pitch directly. Will be refined from the bank/count quotient once
  // the rail span is clamped and count is locked in.
  let moduleWidth = main_switch_width / 2;
  const moduleWidthFromMainSwitch = moduleWidth;

  // Pitch estimate #2 (diagnostic): MCB visible-face height. DIN 43880 caps
  // the front-zone protrusion (the part of the device that shows above the
  // cover plate) at 45mm; UK domestic ranges measure 44–45mm. We use 44.5mm.
  // Module pitch is the hard DIN standard at 17.5mm. So
  // (17.5 / 44.5) × rail-height-in-pixels → pitch in pixels. This is
  // independent of main_switch_width and lets us flag when the two
  // estimates disagree — usually a sign the inspector framed rails outside
  // the MCB face edges. Not a hard gate this session; logged as
  // pitchCrossCheck in the return value.
  const { imageWidth, imageHeight } = imageDimensions || {};
  let pitchCrossCheck = null;
  if (
    Number.isFinite(imageWidth) &&
    imageWidth > 0 &&
    Number.isFinite(imageHeight) &&
    imageHeight > 0 &&
    typeof medianRails.rail_top === 'number' &&
    typeof medianRails.rail_bottom === 'number' &&
    medianRails.rail_bottom > medianRails.rail_top
  ) {
    const railHeightPx = ((medianRails.rail_bottom - medianRails.rail_top) / 1000) * imageHeight;
    const moduleWidthPxFromMs = (moduleWidthFromMainSwitch / 1000) * imageWidth;
    const moduleWidthPxFromHeight = 17.5 * (railHeightPx / 44.5);
    const denom = Math.max(moduleWidthPxFromMs, moduleWidthPxFromHeight, 1);
    const disagreementPct = Math.round(
      (Math.abs(moduleWidthPxFromMs - moduleWidthPxFromHeight) / denom) * 100
    );
    pitchCrossCheck = {
      fromMainSwitchPx: Math.round(moduleWidthPxFromMs),
      fromMcbHeightPx: Math.round(moduleWidthPxFromHeight),
      disagreementPct,
    };
  }

  // --- Clamp rail span to the populated area -------------------------------
  // When iOS sends a railRoiHint, the inspector may leave horizontal slack
  // on the left/right of the MCB row (the rails overlay only constrains the
  // VERTICAL axis — top/bottom of MCBs to the two bars). Without clamping,
  // effectiveRailLeft/Right would still reflect the ROI edges and the
  // refined-pitch step below would compute an artificially wide pitch,
  // inflating every slot crop. Use the VLM's populated_area bounds (which
  // correctly skip middle gaps for split-load / RCBO-removed boards) to
  // tighten the rail span before the main-switch clamp applies. Both bounds
  // are optional — fall back to medianRails verbatim if the VLM omits or
  // returns nonsense values.
  let effectiveRailLeft = medianRails.rail_left;
  let effectiveRailRight = medianRails.rail_right;
  let populatedLeftTightened = false;
  let populatedRightTightened = false;
  if (
    typeof populated_area_start_x === 'number' &&
    Number.isFinite(populated_area_start_x) &&
    populated_area_start_x > medianRails.rail_left &&
    populated_area_start_x < medianRails.rail_right
  ) {
    effectiveRailLeft = populated_area_start_x;
    populatedLeftTightened = true;
  }
  if (
    typeof populated_area_end_x === 'number' &&
    Number.isFinite(populated_area_end_x) &&
    populated_area_end_x < medianRails.rail_right &&
    populated_area_end_x > effectiveRailLeft
  ) {
    effectiveRailRight = populated_area_end_x;
    populatedRightTightened = true;
  }

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
  // or when the main switch already sits outside the populated bounds.
  //
  // effectiveRailLeft / effectiveRailRight were initialised above with
  // medianRails.rail_left / rail_right and already narrowed by the
  // populated-area clamp. The main-switch clamp narrows them further on the
  // side the main switch sits on.
  let mainSwitchSide = null;
  // Only clamp when the main-switch centre is physically INSIDE the current
  // effective rail bounds. If the VLM places it outside (e.g. separate rail
  // segment, Stage 1 already excluded the main-switch zone, or the
  // populated-area clamp narrowed past it), trust that and leave the span
  // alone.
  const msCentreInsideRail =
    typeof main_switch_center_x === 'number' &&
    Number.isFinite(main_switch_center_x) &&
    main_switch_center_x >= effectiveRailLeft &&
    main_switch_center_x <= effectiveRailRight;

  if (msCentreInsideRail) {
    const msHalf = main_switch_width / 2;
    const msLeft = main_switch_center_x - msHalf;
    const msRight = main_switch_center_x + msHalf;
    const railMid = (effectiveRailLeft + effectiveRailRight) / 2;
    if (main_switch_center_x > railMid) {
      mainSwitchSide = 'right';
      if (msLeft > effectiveRailLeft) {
        effectiveRailRight = msLeft;
      }
    } else {
      mainSwitchSide = 'left';
      if (msRight < effectiveRailRight) {
        effectiveRailLeft = msRight;
      }
    }
  }

  const railWidth = effectiveRailRight - effectiveRailLeft;
  if (railWidth <= 0) {
    throw new Error(
      'getModuleCount: effective rail width collapsed to zero after main-switch clamp'
    );
  }
  // Use Math.floor so every generated slot's bbox (centre ± moduleWidth/2)
  // sits fully inside the effective rail. Math.round could push the last
  // slot's right edge past effectiveRailRight when railWidth > N·moduleWidth
  // + moduleWidth/2 (≈40% of the time in practice), which then causes Stage 3
  // to hallucinate a main_switch on the phantom slot because its crop
  // extends 2.2× moduleWidth beyond the centre and reaches the real main
  // switch face. Observed on Wylex NHRS12SL 2026-04-23 harness run 3: Stage
  // 2 returned 16 slots but the last two (810, 860) had crops reaching into
  // the main-switch bbox; Stage 3 tagged 14 as main_switch and 15 as blank,
  // merger pushed "Spare" phantom onto the schedule as circuit 1.
  let geometricCount = Math.floor(railWidth / moduleWidth);

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

  // --- Refine pitch from bank-width / count --------------------------------
  // Previously moduleWidth stayed at main_switch_width/2 for slot tiling,
  // which meant slot positions were extrapolated from ONE anchor (the
  // main-switch side) and the far slot could drift by up to half a module
  // relative to the real bank edge. Derek, 2026-04-23: "if the main-switch
  // measurement is half a millimetre off, 15 MCBs later we're 7.5mm out".
  //
  // Fix: once count is locked in, recompute moduleWidth from the clamped
  // bank width. This pins slot 0 at half a pitch from the left edge AND
  // the last slot at half a pitch from the right edge — a two-anchor
  // calibration whose error doesn't compound. The original
  // main_switch_width/2 value is still returned as moduleWidthFromMainSwitch
  // for cross-check / diagnostic purposes.
  //
  // Gating (Codex 2026-04-23 P1):
  //
  //   Refinement is ONLY safe when BOTH ends of the bank are trustworthy.
  //   The main-switch clamp tightens the main-switch-side edge; we also
  //   need the OPPOSITE edge to be tight. Two sources of tightness on that
  //   side:
  //     - populated_area_start_x / populated_area_end_x from the VLM (the
  //       end opposite the main switch): tightened iff the relevant
  //       populated bound was provided AND inside the raw rail bbox.
  //     - For boards where the main switch is absent or mainSwitchCenterX
  //       is null (inline mains, rewireable): fall back to requiring
  //       BOTH populated bounds to have tightened.
  //
  //   If the opposite end is still at the raw rail_left / rail_right
  //   (typical when iOS ROI has horizontal slack and the VLM didn't
  //   provide populated_area bounds), the refined pitch would stretch
  //   across that slack and shift far-end slots — reintroducing the same
  //   phantom slots the sprint is trying to eliminate. Keep main-switch
  //   pitch in that case.
  //
  //   Also never refine when truncation fired — that explicitly distrusts
  //   the non-main-switch-side edge.
  const oppositeEndTightened =
    mainSwitchSide === 'right'
      ? populatedLeftTightened
      : mainSwitchSide === 'left'
        ? populatedRightTightened
        : populatedLeftTightened && populatedRightTightened;
  if (
    geometricCount > 0 &&
    !truncatedFromDisagreement &&
    mainSwitchSide !== null &&
    oppositeEndTightened
  ) {
    moduleWidth = railWidth / geometricCount;
  } else if (
    geometricCount > 0 &&
    !truncatedFromDisagreement &&
    mainSwitchSide === null &&
    populatedLeftTightened &&
    populatedRightTightened
  ) {
    // Inline / mains-less fallback: if both populated bounds were provided
    // AND main switch wasn't localised, both ends are VLM-tightened and
    // refinement is safe.
    moduleWidth = railWidth / geometricCount;
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
    moduleWidthFromMainSwitch,
    effectiveRailLeft,
    effectiveRailRight,
    populatedAreaStartX:
      typeof populated_area_start_x === 'number' && Number.isFinite(populated_area_start_x)
        ? populated_area_start_x
        : null,
    populatedAreaEndX:
      typeof populated_area_end_x === 'number' && Number.isFinite(populated_area_end_x)
        ? populated_area_end_x
        : null,
    pitchCrossCheck,
    usage: {
      inputTokens: sample.inputTokens,
      outputTokens: sample.outputTokens,
    },
  };
}

/**
 * Stage 2, groups-mode (CCU_STAGE2_GROUPS=true). Calls the VLM with the
 * MODULE_COUNT_PROMPT_GROUPS prompt and assembles a return shape compatible
 * with the existing populated_area path's downstream consumers (so Stage 3
 * + prepareModernGeometry don't need to know which Stage 2 path ran).
 *
 * Differences from the populated_area path:
 *
 *   * Trusts the VLM's per-group start_x/end_x as TIGHT bounds — no rail
 *     clamp, no main-switch clamp, no populated-area tightening. The VLM
 *     was told to find groups tightly within the user-supplied crop, and
 *     groups are already split around middle gaps by construction.
 *
 *   * `slotCentersX` is built per group: each group is tiled with even
 *     spacing using its own (end_x - start_x) / module_count pitch. Across
 *     groups, slot order is left-to-right by group start_x. Centres in the
 *     gap between groups are NOT generated — empty rail in the middle of
 *     a split-load board is invisible to Stage 3.
 *
 *   * `moduleWidth` is the average pitch across all groups (used by Stage
 *     3 for crop-width sizing, where one number per board is sufficient).
 *     Per-group pitch is also returned in `mcbGroups[].pitch` for Stage 3
 *     to use when finer cropping is needed in a follow-up.
 *
 *   * `mainSwitchSide` is determined by comparing main_switch_center_x to
 *     the midpoint of (first group start_x, last group end_x). Falls back
 *     to null if the VLM reported no main switch (inline-mains boards).
 *
 *   * `disagreement` and `truncatedFromDisagreement` are always false —
 *     in groups mode the VLM's per-group count IS the count; there is no
 *     geometric-vs-VLM cross-check to disagree on. `lowConfidence` is
 *     surfaced from the pitch cross-check instead (main_switch_width / 2
 *     vs measured group pitch — significant divergence still flags the
 *     inspector to double-check).
 *
 * @private
 */
async function getModuleCountFromGroups(
  anthropic,
  imageBuffer,
  base64,
  medianRails,
  imageDimensions,
  options = {}
) {
  const sample = await callVlm(anthropic, base64, MODULE_COUNT_PROMPT_GROUPS(medianRails));
  const { rail_bbox: vlmRailBbox, main_switch_center_x, main_switch_width } = sample.parsed;

  // --- Choose rail bbox source --------------------------------------------
  // 2026-04-29 (Derek field test, Wylex NHRS12SL): the VLM was reliably
  // mis-tightening the rail bbox vertically — typically clipping it to the
  // dark toggle housing only and discarding the white rating-label face,
  // halving rail-height-px. Combined with the (also wrong) MCB_BODY_HEIGHT
  // constant of 82.5mm (full body, most of which sits BEHIND the cover
  // plate), pixels-per-mm came out at 1/4 of reality and moduleCount came
  // out 2× too high (29 vs ~15 actual). Fix: when iOS sent a railRoiHint,
  // skip the VLM tightening entirely — the user's box from the custom
  // camera already brackets the visible MCB row tightly. Still call the
  // VLM for main_switch_center_x / main_switch_width (we need them for
  // circuit numbering side and the cross-check); just throw away its
  // rail_bbox. When NO ROI hint was provided (e.g. legacy uploads), we
  // still trust the VLM tightening as the only signal we have.
  const trustInputRails = options.trustInputRails === true;
  let left;
  let right;
  let top;
  let bottom;
  if (trustInputRails) {
    left = medianRails.rail_left;
    right = medianRails.rail_right;
    top = medianRails.rail_top;
    bottom = medianRails.rail_bottom;
  } else {
    if (!vlmRailBbox || typeof vlmRailBbox !== 'object') {
      throw new Error('getModuleCountFromGroups: VLM returned missing rail_bbox');
    }
    left = Number(vlmRailBbox.left);
    right = Number(vlmRailBbox.right);
    top = Number(vlmRailBbox.top);
    bottom = Number(vlmRailBbox.bottom);
    if (
      !Number.isFinite(left) ||
      !Number.isFinite(right) ||
      !Number.isFinite(top) ||
      !Number.isFinite(bottom)
    ) {
      throw new Error('getModuleCountFromGroups: rail_bbox edges must all be finite numbers');
    }
    if (right <= left) {
      throw new Error(
        `getModuleCountFromGroups: rail_bbox right (${right}) must be > left (${left})`
      );
    }
    if (bottom <= top) {
      throw new Error(
        `getModuleCountFromGroups: rail_bbox bottom (${bottom}) must be > top (${top})`
      );
    }
  }
  const railBboxNorm = { left, right, top, bottom };
  const railBboxSource = trustInputRails ? 'user-roi' : 'vlm-tightened';

  // --- Calibrate pixels-per-mm from MCB face height ------------------------
  // The bbox top/bottom spans the visible MCB FACE — the part that
  // protrudes through the consumer-unit cover plate. DIN 43880 caps the
  // front-zone protrusion at 45 mm and every UK domestic MCB range
  // (Wylex NSB / Hager MCN/MTN / Crabtree / Schneider iC60 / MK Sentry /
  // Chint / Contactum / Eaton Memshield) lands at 44–45 mm measured. We
  // use 44.5 mm. DIN module pitch is the hard 17.5 mm standard.
  //
  // Earlier versions of this calibration used 82.5 mm — that's the FULL
  // body height (cover-plate-cutout edge to terminal block), almost half
  // of which sits behind the cover and is invisible in the photo. Using
  // 82.5 mm with bbox-height-of-the-visible-face produced moduleCount
  // ~2× reality. Field-confirmed 2026-04-29 against a measured spares
  // box.
  const { imageWidth, imageHeight } = imageDimensions || {};
  if (
    !Number.isFinite(imageWidth) ||
    imageWidth <= 0 ||
    !Number.isFinite(imageHeight) ||
    imageHeight <= 0
  ) {
    throw new Error(
      'getModuleCountFromGroups: imageDimensions must include positive imageWidth and imageHeight'
    );
  }

  const MCB_FACE_HEIGHT_MM = 44.5;
  const MODULE_PITCH_MM = 17.5;
  const railHeightPx = ((bottom - top) / 1000) * imageHeight;
  const railWidthPx = ((right - left) / 1000) * imageWidth;

  // --- Pitch detection: CV first, height-anchor fallback ------------------
  // 2026-04-29 (Derek field-test): the height-anchor path (44.5mm DIN
  // 43880 face) is sensitive to the user's box being 100% accurate
  // vertically. A 6%-too-short box on the Wylex Nano photo gave count=17
  // for an actual 16-module board. Direct CV pitch detection (Sobel-X +
  // length-normalised autocorrelation) finds the actual periodicity in
  // the photo and is independent of user framing accuracy.
  //
  // CV-first when CCU_CV_PITCH=true (default ON). Fall back to the
  // height anchor when CV returns null (low confidence, small board, or
  // disabled by env). Both paths surface as `pitchSource` for telemetry.
  let moduleWidthPxFromHeight = MODULE_PITCH_MM * (railHeightPx / MCB_FACE_HEIGHT_MM);
  let moduleWidthPx = moduleWidthPxFromHeight;
  let pitchSource = 'height-anchor';
  let cvPitchDiag = null;
  if (isCcuCvPitchEnabled() && Buffer.isBuffer(imageBuffer)) {
    const railBboxPx = {
      left: (left / 1000) * imageWidth,
      right: (right / 1000) * imageWidth,
      top: (top / 1000) * imageHeight,
      bottom: (bottom / 1000) * imageHeight,
    };
    try {
      const cv = await detectModulePitchCv(imageBuffer, railBboxPx);
      cvPitchDiag = {
        pitchPx: cv?.pitchPx ?? null,
        normCorr: cv?.normCorr ?? 0,
        moduleCountFromCv: cv?.moduleCount ?? null,
        railWidthPx: cv?.railWidthPx ?? null,
        reason: cv?.reason ?? null,
      };
      if (cv && cv.pitchPx > 0 && cv.moduleCount != null) {
        moduleWidthPx = cv.pitchPx;
        pitchSource = 'cv-autocorr';
      }
    } catch (err) {
      cvPitchDiag = { error: String(err?.message || err) };
    }
  }

  if (moduleWidthPx <= 0) {
    throw new Error('getModuleCountFromGroups: could not derive a positive module width');
  }

  // --- Compute module count by chunking the bbox width ---------------------
  // Round to nearest integer — half-modules don't physically exist in UK
  // CUs (every device is 1 or 2 modules wide on a 17.5mm pitch). When
  // pitchSource='cv-autocorr', the rounding error is bounded by ±0.5
  // pixels at the autocorrelation lag resolution (1.2% on typical 80px
  // pitch → 0.2 module margin on a 16-module board → robust). When
  // pitchSource='height-anchor', the cross-check against
  // main_switch_width below catches >10% disagreement.
  const moduleCountRaw = railWidthPx / moduleWidthPx;
  const moduleCount = Math.max(1, Math.round(moduleCountRaw));

  // --- Tile slots across the bbox ------------------------------------------
  // Use the COMPUTED module width (railWidthPx / moduleCount) for tiling
  // rather than the raw pitch source, so slot 0 sits at half-a-pitch from
  // the left edge AND slot N-1 sits at half-a-pitch from the right edge.
  // This is two-anchor calibration — the only slot positioning that
  // doesn't accumulate error from one end.
  const tilePitchPx = railWidthPx / moduleCount;
  const moduleWidth = (tilePitchPx / imageWidth) * 1000; // back to 0-1000 scale
  const slotCentersX = [];
  for (let i = 0; i < moduleCount; i++) {
    slotCentersX.push(left + moduleWidth * (i + 0.5));
  }

  // --- Cross-check vs main_switch_width (drift detector) -------------------
  // Main switches are exactly 2-module wide (BS 7671 double-pole isolator,
  // 2 × 17.5mm). Their pixel width gives an independent pitch anchor.
  // Compare against the actual pitch we tiled at and flag disagreement >10%
  // as lowConfidence — usually a sign the rail bbox or main_switch bbox is
  // off, OR the main switch on this board isn't standard 2-mod (rare).
  const moduleWidthFromMainSwitch =
    Number.isFinite(main_switch_width) && main_switch_width > 0 ? main_switch_width / 2 : null;
  let pitchCrossCheck = null;
  let lowConfidence = false;
  if (moduleWidthFromMainSwitch != null) {
    const moduleWidthPxFromMs = (moduleWidthFromMainSwitch / 1000) * imageWidth;
    const denom = Math.max(moduleWidthPxFromMs, moduleWidthPx, 1);
    const disagreementPct = Math.round(
      (Math.abs(moduleWidthPxFromMs - moduleWidthPx) / denom) * 100
    );
    pitchCrossCheck = {
      fromMainSwitchPx: Math.round(moduleWidthPxFromMs),
      fromActualPitchPx: Math.round(moduleWidthPx),
      fromMcbHeightPx: Math.round(moduleWidthPxFromHeight),
      disagreementPct,
    };
    if (disagreementPct > 10) {
      lowConfidence = true;
    }
  }

  // --- Main switch side derivation -----------------------------------------
  // mainSwitchSide is determined by main_switch_center_x position relative
  // to the bbox midpoint. The main switch sits ON the rail (it's INSIDE the
  // bbox per the prompt) so its centre tells us which end of the rail it's
  // at. Used by slotsToCircuits to drive BS-7671 circuit numbering
  // (circuit 1 = nearest to main switch).
  //
  // Future improvement: if main_switch_center_x is null but Stage 3 later
  // classifies a slot as 'main_switch', that slot's index gives us the
  // side. We don't have Stage 3 output here, so for now null → null.
  let mainSwitchSide = null;
  const bboxMid = (left + right) / 2;
  if (typeof main_switch_center_x === 'number' && Number.isFinite(main_switch_center_x)) {
    mainSwitchSide = main_switch_center_x > bboxMid ? 'right' : 'left';
  }

  // Diagnostic block — surfaces the raw inputs to the geometric chunking
  // calculation so CloudWatch shows us exactly what dimensions / pixel
  // counts produced this slot count. Added 2026-04-28 after the first
  // tighten-and-chunk field test (38 Dickens Close, 15:38 BST) reported
  // moduleCount=29 against an actual 16-module board with the pitch
  // cross-check showing 0% disagreement — meaning the math was internally
  // consistent but the inputs were wrong. Without these values in the log
  // we can't tell whether it's the bbox too wide, the image dimensions
  // wrong, or both calibrations broken in the same way.
  const chunkingDiag = {
    imageWidth: Math.round(imageWidth),
    imageHeight: Math.round(imageHeight),
    railWidthPx: Math.round(railWidthPx),
    railHeightPx: Math.round(railHeightPx),
    pixelsPerMmFromHeight: Number((railHeightPx / MCB_FACE_HEIGHT_MM).toFixed(2)),
    moduleWidthPxFromHeight: Math.round(moduleWidthPxFromHeight),
    moduleWidthPxUsed: Math.round(moduleWidthPx),
    pitchSource,
    moduleCountRaw: Number(moduleCountRaw.toFixed(2)),
    moduleCount,
  };

  return {
    geometricCount: moduleCount,
    vlmCount: moduleCount, // no separate VLM count in tighten-and-chunk
    slotCentersX,
    disagreement: false,
    truncatedFromDisagreement: false,
    mainSwitchSide,
    mainSwitchCenterX:
      typeof main_switch_center_x === 'number' && Number.isFinite(main_switch_center_x)
        ? main_switch_center_x
        : null,
    mainSwitchWidth:
      typeof main_switch_width === 'number' && Number.isFinite(main_switch_width)
        ? main_switch_width
        : null,
    moduleWidth,
    moduleWidthFromMainSwitch: moduleWidthFromMainSwitch ?? moduleWidth,
    effectiveRailLeft: left,
    effectiveRailRight: right,
    populatedAreaStartX: left,
    populatedAreaEndX: right,
    mcbGroups: null, // legacy field — no per-group structure in tighten-and-chunk
    upstreamRcds: null, // legacy field — RCDs identified by Stage 3 classification per slot
    railBbox: railBboxNorm, // NEW 2026-04-28 — surfaces the rail bbox used for telemetry
    railBboxSource, // NEW 2026-04-29 — 'user-roi' (no VLM tightening) or 'vlm-tightened'
    pitchSource, // NEW 2026-04-29 — 'cv-autocorr' (Sobel-X) or 'height-anchor' (44.5mm DIN face fallback)
    cvPitchDiag, // NEW 2026-04-29 — CV detection internals (pitch, normCorr, fallback reason)
    pitchCrossCheck,
    chunkingDiag, // NEW 2026-04-28 — exposes raw chunking inputs for prod diagnostics
    lowConfidence,
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
  // are fully captured regardless of which of their two slot centres we anchor
  // to. Narrower crops (tried 1.6× on 2026-04-23 harness run 4) caused Stage
  // 3 to miss RCD classification on the second module (confidence collapsed
  // from 0.9 to 0.4 because the test button / waveform symbol fell outside
  // the crop), net worse than the marginal gain from less neighbour bleed.
  // VLM prompt already says "identify the device centred in this crop" +
  // echoes slot_index, so a small amount of neighbour bleed is acceptable.
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
    // Tried 2048 on 2026-04-23 to help the VLM read Wylex PSB32-C's small
    // "-C" suffix — regressed: Stage 3 confidence dropped from 0.95 to
    // 0.82 on clear devices and labels from the strip-channel (above/below
    // the rail) bled into the device classification output as raw text.
    // Turns out 1024 is already at the resolution sweet spot for this VLM.
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
      // Validate the new content/extends fields (2026-04-23 schema). Older
      // VLM responses (or responses where the model ignored the new fields)
      // won't include them — fall back to defaults that preserve the old
      // behaviour: content inferred from classification, extends="none".
      const rawContent = typeof vlmItem.content === 'string' ? vlmItem.content : null;
      const content = ['device', 'blank', 'empty', 'partial'].includes(rawContent)
        ? rawContent
        : vlmItem.classification === 'blank'
          ? 'blank'
          : vlmItem.classification === 'empty'
            ? 'empty'
            : 'device';
      const rawExtends = typeof vlmItem.extends === 'string' ? vlmItem.extends : null;
      const extendsSide = ['none', 'left', 'right', 'both'].includes(rawExtends)
        ? rawExtends
        : 'none';

      // OCR cross-check on ratings. Hallucinated ratings have no textual
      // evidence in the pixels — a half-RCD crop confidently "reading"
      // B32 won't have "32" anywhere in the transcribed rating_text.
      // When disagreement is detected, null out the rating rather than
      // silently accepting a fabricated number. Only applies when BOTH
      // rating_text and ratingAmps are provided and the text is a string;
      // older VLM responses without rating_text pass through unaffected.
      //
      // Strict check: does rating_text contain the digit sequence of
      // ratingAmps? Tolerant to whitespace and adjacent characters
      // (rating_text="B32" contains "32"; rating_text="C 40" contains
      // "40"; rating_text="32 A" contains "32"). Handles the Wylex
      // suffix-curve convention ("NSB32-C", "PSB32-C") which the prompt
      // explicitly supports.
      let ratingAmps =
        typeof vlmItem.ratingAmps === 'number' ? vlmItem.ratingAmps : (vlmItem.ratingAmps ?? null);
      let ratingHallucinationDetected = false;
      if (ratingAmps != null && typeof vlmItem.rating_text === 'string') {
        const textDigits = vlmItem.rating_text.replace(/\D+/g, ' ');
        const ratingDigits = String(ratingAmps);
        const tokens = textDigits.split(/\s+/).filter(Boolean);
        const anyTokenMatches = tokens.some((tok) => tok === ratingDigits);
        if (!anyTokenMatches) {
          // Rating text doesn't contain the claimed rating — this is the
          // classic half-RCD-as-B32 hallucination. Reject the rating.
          ratingAmps = null;
          ratingHallucinationDetected = true;
        }
      }

      resultsBySlotIndex.set(crop.slotIndex, {
        slotIndex: crop.slotIndex,
        content,
        extends: extendsSide,
        classification: vlmItem.classification || (content === 'empty' ? 'empty' : 'unknown'),
        manufacturer: vlmItem.manufacturer ?? null,
        model: vlmItem.model ?? null,
        ratingAmps,
        ratingText: typeof vlmItem.rating_text === 'string' ? vlmItem.rating_text : null,
        ratingHallucinationDetected,
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

  // Preserve input order. Fallback defaults mirror the 2026-04-23 schema —
  // content/extends/ratingText included so downstream merger never
  // encounters undefined.
  const slots = slotCrops.map(
    (c) =>
      resultsBySlotIndex.get(c.slotIndex) || {
        slotIndex: c.slotIndex,
        content: 'device',
        extends: 'none',
        classification: 'unknown',
        manufacturer: null,
        model: null,
        ratingAmps: null,
        ratingText: null,
        ratingHallucinationDetected: false,
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
export async function prepareModernGeometry(imageBuffer, options = {}) {
  const t0 = Date.now();
  let stage1;
  let stage1Source = 'vlm';
  if (options.railRoiHint) {
    // iOS sent a framing-box hint from the camera overlay. Use it directly
    // as the rail bbox and skip the 3-sample VLM rail-detection pass. The
    // hint is {x, y, w, h} in 0-1 normalised coords; convert to the 0-1000
    // Stage 1 scale, keep the same result shape so downstream stages are
    // oblivious to the source. Zero-token cost; saves ~$0.03 and ~17s.
    stage1 = await stage1FromRoiHint(imageBuffer, options.railRoiHint);
    stage1Source = 'roi-hint';
  } else {
    stage1 = await getRailGeometry(imageBuffer);
  }
  const stage1Ms = Date.now() - t0;

  // --- Stage 2 prep: crop to the rail ROI when available ------------------
  // When iOS sent a railRoiHint, Stage 1 already has the rail bbox — passing
  // the full photo to Stage 2 forces the VLM to reason over ceiling / wiring
  // / enclosure / meter / floor to find the main switch. Cropping to the
  // rail area (with a small padding margin so device labels above/below the
  // rail stay visible) gives the VLM a much simpler task — just the MCB row.
  // Derek 2026-04-23: "makes the job far more simple". Stage 2's output
  // coords are in the CROP's 0-1000 space; we translate them back to
  // original-image 0-1000 below so downstream Stage 3 still works on the
  // original imageBuffer. When there's no ROI hint, we pass the full image
  // unchanged (Stage 1 used the VLM path and its bounds may be fuzzy).
  let stage2Image = imageBuffer;
  let stage2Rails = stage1.medianRails;
  let stage2Width = stage1.imageWidth;
  let stage2Height = stage1.imageHeight;
  let cropTransform = null;

  if (options.railRoiHint && stage1.imageWidth > 0 && stage1.imageHeight > 0) {
    const PAD_X = 0.08; // 8% horizontal padding (room for main-switch body + label strip edges)
    const PAD_Y = 0.25; // 25% vertical padding (labels sit above/below the rail; need to stay in frame)
    const railLeftPx = (stage1.medianRails.rail_left / 1000) * stage1.imageWidth;
    const railRightPx = (stage1.medianRails.rail_right / 1000) * stage1.imageWidth;
    const railTopPx = (stage1.medianRails.rail_top / 1000) * stage1.imageHeight;
    const railBottomPx = (stage1.medianRails.rail_bottom / 1000) * stage1.imageHeight;
    const railWidthPx = Math.max(1, railRightPx - railLeftPx);
    const railHeightPx = Math.max(1, railBottomPx - railTopPx);

    const cropX0 = Math.max(0, Math.round(railLeftPx - PAD_X * railWidthPx));
    const cropY0 = Math.max(0, Math.round(railTopPx - PAD_Y * railHeightPx));
    const cropX1 = Math.min(stage1.imageWidth, Math.round(railRightPx + PAD_X * railWidthPx));
    const cropY1 = Math.min(stage1.imageHeight, Math.round(railBottomPx + PAD_Y * railHeightPx));
    const cropW = cropX1 - cropX0;
    const cropH = cropY1 - cropY0;

    // Sharp refuses zero / negative crops; if the ROI was too small after
    // clamping, fall back to the full image.
    if (cropW > 16 && cropH > 16) {
      stage2Image = await sharp(imageBuffer)
        .extract({ left: cropX0, top: cropY0, width: cropW, height: cropH })
        .toBuffer();
      stage2Rails = {
        rail_left: Math.round(((railLeftPx - cropX0) / cropW) * 1000),
        rail_right: Math.round(((railRightPx - cropX0) / cropW) * 1000),
        rail_top: Math.round(((railTopPx - cropY0) / cropH) * 1000),
        rail_bottom: Math.round(((railBottomPx - cropY0) / cropH) * 1000),
      };
      stage2Width = cropW;
      stage2Height = cropH;
      cropTransform = { cropX0, cropY0, cropW, cropH };
    }
  }

  const t1 = Date.now();
  const stage2 = await getModuleCount(
    stage2Image,
    stage2Rails,
    { imageWidth: stage2Width, imageHeight: stage2Height },
    // 2026-04-29: when iOS sent a railRoiHint, the user has already drawn a
    // tight box around the visible MCB row. Skip the VLM rail-bbox
    // tightening step in groups-mode — the VLM has been mis-tightening
    // vertically (clipping the white rating-label face off the device,
    // halving rail height, doubling moduleCount). We still call the VLM
    // because we need main_switch_center_x / main_switch_width; we just
    // ignore its rail_bbox and use the user's box directly.
    { trustInputRails: !!options.railRoiHint }
  );
  const stage2Ms = Date.now() - t1;

  // --- Translate Stage 2 X-axis outputs back to original image coords ----
  // All coordinate fields Stage 2 returns are in its input image's 0-1000
  // scale; when we cropped, that's the crop's scale. Downstream Stage 3
  // (classifyModernSlots → cropSlot) operates on the ORIGINAL imageBuffer
  // using stage2.slotCentersX / moduleWidth etc., so these must be in the
  // original-image scale. Translate each X coord via:
  //     orig_norm = (cropX0 + (stage2_norm / 1000) * cropW) / origWidth * 1000
  // Width-scale values (moduleWidth, mainSwitchWidth) scale by (cropW / origWidth).
  // Y-axis values are left alone if we cropped vertically too; Stage 3 uses
  // stage1.medianRails.rail_top / rail_bottom (still in original coords)
  // for vertical crop bounds, so Stage 2's Y outputs aren't read downstream.
  if (cropTransform) {
    const { cropX0, cropW } = cropTransform;
    const origWidth = stage1.imageWidth;
    const scale = cropW / origWidth;
    const translateX = (c) =>
      typeof c === 'number' && Number.isFinite(c)
        ? ((cropX0 + (c / 1000) * cropW) / origWidth) * 1000
        : c;
    const scaleWidth = (w) => (typeof w === 'number' && Number.isFinite(w) ? w * scale : w);

    stage2.mainSwitchCenterX = translateX(stage2.mainSwitchCenterX);
    stage2.populatedAreaStartX = translateX(stage2.populatedAreaStartX);
    stage2.populatedAreaEndX = translateX(stage2.populatedAreaEndX);
    stage2.effectiveRailLeft = translateX(stage2.effectiveRailLeft);
    stage2.effectiveRailRight = translateX(stage2.effectiveRailRight);
    stage2.mainSwitchWidth = scaleWidth(stage2.mainSwitchWidth);
    stage2.moduleWidth = scaleWidth(stage2.moduleWidth);
    stage2.moduleWidthFromMainSwitch = scaleWidth(stage2.moduleWidthFromMainSwitch);
    if (Array.isArray(stage2.slotCentersX)) {
      stage2.slotCentersX = stage2.slotCentersX.map(translateX);
    }
    // Translate mcbGroups (groups-mode only — populated_area path doesn't
    // populate this field). Each group's start_x / end_x are X coords; the
    // pitch is a width-scale value. Re-translating via map is intentional
    // — we leave the original group object unmutated where possible so a
    // future refactor that wants to log "untranslated" coordinates can
    // re-derive them.
    if (Array.isArray(stage2.mcbGroups)) {
      stage2.mcbGroups = stage2.mcbGroups.map((g) => ({
        start_x: translateX(g.start_x),
        end_x: translateX(g.end_x),
        module_count: g.module_count,
        pitch: scaleWidth(g.pitch),
      }));
    }
    // Translate railBbox (tighten-and-chunk only). Y-axis is in the crop's
    // own scale; downstream Stage 3 reads stage1.medianRails for vertical
    // crop bounds (still in original-image scale), so the railBbox top/
    // bottom translation is purely cosmetic for telemetry. We keep them
    // in CROP-scale to match what the VLM actually returned and what the
    // height calibration was computed against.
    if (stage2.railBbox && typeof stage2.railBbox === 'object') {
      stage2.railBbox = {
        left: translateX(stage2.railBbox.left),
        right: translateX(stage2.railBbox.right),
        top: stage2.railBbox.top,
        bottom: stage2.railBbox.bottom,
      };
    }
  }

  const usage = {
    inputTokens: stage1.usage.inputTokens + stage2.usage.inputTokens,
    outputTokens: stage1.usage.outputTokens + stage2.usage.outputTokens,
  };

  // Roll the Stage 2 truncation signal into top-level lowConfidence so the
  // route handler can surface it (and iOS can render the existing lowConf
  // banner / amber state) without needing a second flag.
  // lowConfidence fires when: Stage 1 samples diverged (SD threshold),
  // Stage 2 truncated geometric → VLM (big overcount that we fixed), OR
  // geometric/VLM disagreed by 2+ modules with VLM higher (we floor-counted
  // and undercount is suspected). The last case used to be silent — only
  // truncation lit lowConfidence — but a 2-module delta in either direction
  // means rail geometry is shaky and the inspector should double-check.
  const lowConfidence =
    stage1.lowConfidence ||
    !!stage2.truncatedFromDisagreement ||
    Math.abs(stage2.geometricCount - stage2.vlmCount) >= 2;

  // Source of Stage 2 output. 'tighten-and-chunk' = 2026-04-28 redesign
  // (CCU_STAGE2_GROUPS=true). 'populated-area' = legacy single-rect path
  // (CCU_STAGE2_GROUPS=false / unset). Useful for telemetry while we A/B
  // the two paths in production. The fingerprint is `railBbox` — only
  // the new path populates it.
  const stage2Source = stage2.railBbox ? 'tighten-and-chunk' : 'populated-area';

  return {
    medianRails: stage1.medianRails,
    moduleCount: stage2.geometricCount,
    vlmCount: stage2.vlmCount,
    disagreement: stage2.disagreement,
    truncatedFromDisagreement: !!stage2.truncatedFromDisagreement,
    lowConfidence,
    stage1Source, // 'vlm' | 'roi-hint' — lets caller log the skip
    stage2Source, // 'tighten-and-chunk' | 'populated-area'
    mcbGroups: stage2.mcbGroups ?? null,
    railBbox: stage2.railBbox ?? null,
    pitchCrossCheck: stage2.pitchCrossCheck ?? null,
    chunkingDiag: stage2.chunkingDiag ?? null,
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
        moduleWidthFromMainSwitch: stage2.moduleWidthFromMainSwitch,
        effectiveRailLeft: stage2.effectiveRailLeft,
        effectiveRailRight: stage2.effectiveRailRight,
        populatedAreaStartX: stage2.populatedAreaStartX,
        populatedAreaEndX: stage2.populatedAreaEndX,
        pitchCrossCheck: stage2.pitchCrossCheck,
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
