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
 *   - CV (Stage 1 + Stage 2) still runs. It produces the rail quad that
 *     feeds the perspective dewarp, the rail bbox for slot-position
 *     math, and the Stage 3 main-switch-side disambiguation. CV's
 *     moduleCountFromCv is still computed for telemetry but is no longer
 *     treated as authoritative — the field corpus showed it's unreliable
 *     on non-standard rails (ADRBs, SPDs, multi-pole devices break the
 *     periodic signature the pitch estimator depends on), see the
 *     ccu-quality-gate.js header for the full story.
 *   - The board classifier (board_technology, manufacturer, model, main
 *     switch position, SPD presence) still runs first. Its output decides
 *     which prompt to send (modern vs rewireable).
 *   - All downstream enrichment: slotsToCircuits, applyRcdTypeLookup,
 *     applyBsEnFallback, normaliseCircuitLabels, lookupMissingRcdTypes,
 *     flagRcdWaveformOutliers — unchanged. The output of this module
 *     mimics extractViaSlidingWindow's return shape exactly.
 *
 * Output contract (matches extractViaSlidingWindow):
 *   { slots, labels, finalDevices, snappedWays, pitchPx, timings, usage,
 *     lowConfidence, stage3Error, stageOutputs, skippedSlotIndices }
 */
import sharp from 'sharp';
import { dewarpRailQuad } from './ccu-rail-dewarp.js';

// Kill switch for the rail-region perspective dewarp pre-pass. Defaults
// ON. Set CCU_DEWARP_ENABLED="false" to fall back to the legacy
// axis-aligned bbox extract — emergency rollback path if the dewarp
// regresses without redeploying.
const DEWARP_ENABLED = (process.env.CCU_DEWARP_ENABLED ?? 'true').toLowerCase() === 'true';
// Output width for the rectified rail image sent to the VLM.
// DEFAULT: 2048 pixels (fixed). This is an EMPIRICAL choice — see history.
//
// HISTORY
//   - Before 2026-05-12: hardcoded 2048 fixed. Reliable VLM counting on
//     real-world boards across the corpus.
//   - 2026-05-12 (commit 10aabca, "preserve native pixel density"):
//     changed default to null = native (no downsample, ~5917 px on a
//     24 MP camera). Reasoning at the time: more pixels per module →
//     better OCR on small device-face text.
//   - 2026-05-13: native output empirically regressed gpt-5.5 COUNTING
//     accuracy on Wylex NHRS12SL (multiple under-count repros). The
//     OCR-side win on face text was real, but the counting-side loss
//     dropped whole circuits — net worse. Hotfix set
//     CCU_DEWARP_OUTPUT_WIDTH=2048 on the production task def to roll
//     back to the prior behaviour.
//   - Between 2026-05-13 and 2026-05-22, the hotfix env var was
//     dropped from the task def (env-var drift). The native default
//     re-applied silently.
//   - 2026-05-22: same Wylex NHRS12SL board, same failure mode
//     resurfaced (extraction 1779468040371-vwj60m: 14 entries when
//     CV correctly counted 16; main switch + last Lighting dropped).
//     This commit moves the 2048 default INTO CODE so it cannot be
//     lost again to env-var drift.
//
// WHY 2048 BEATS NATIVE AT COUNTING (best theory — empirical primary)
//   gpt-5.5's vision pipeline tiles input into multiple ~512px patches.
//   At ~5917 wide the rail spans many tile boundaries; the model
//   struggles to maintain spatial coherence across them and silently
//   drops edge-of-rail modules. At 2048 wide the rail fits within a
//   smaller tile footprint, whole-rail attention holds, counting is
//   reliable. Per-module density drops ~296 → ~115 px, but device-face
//   text remains legible at that density (60-80 px per character vs
//   ~20-40 needed).
//
// ESCAPE HATCHES
//   CCU_DEWARP_OUTPUT_WIDTH=N        — pin output to N pixels (overrides
//                                      this 2048 default; useful for
//                                      experiments at higher density)
//   CCU_DEWARP_OUTPUT_WIDTH=native   — revert to native pixel-density
//                                      output (the post-10aabca behaviour).
//                                      Reserve for OCR-priority work; do
//                                      NOT use in prod without re-testing
//                                      counting accuracy on the corpus.
//   CCU_DEWARP_MAX_WIDTH=N           — soft cap, only active when output
//                                      mode is "native" (see below).
const DEWARP_OUTPUT_WIDTH_RAW = process.env.CCU_DEWARP_OUTPUT_WIDTH;
const DEWARP_OUTPUT_WIDTH = (() => {
  const raw = typeof DEWARP_OUTPUT_WIDTH_RAW === 'string' ? DEWARP_OUTPUT_WIDTH_RAW.trim() : '';
  if (raw.toLowerCase() === 'native') return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  return 2048; // default — see history block above
})();
// Halfway cost brake: if CCU_DEWARP_OUTPUT_WIDTH is unset (native mode)
// and CCU_DEWARP_MAX_WIDTH is a positive integer, native output is
// capped at that pixel width. Small-board photos whose native is already
// below the cap are unaffected — that's the win vs forcing a fixed
// CCU_DEWARP_OUTPUT_WIDTH, which would *upsample* a tight close-up of
// a 4-way garage CU. Recommended fallback values if costs spike: 4096
// (~25% below typical native, ~2× the old 2048 default).
const DEWARP_MAX_WIDTH_RAW = process.env.CCU_DEWARP_MAX_WIDTH;
const DEWARP_MAX_WIDTH =
  DEWARP_MAX_WIDTH_RAW && Number(DEWARP_MAX_WIDTH_RAW) > 0 ? Number(DEWARP_MAX_WIDTH_RAW) : null;

const SINGLE_SHOT_TIMEOUT_MS = Number(process.env.CCU_SINGLE_SHOT_TIMEOUT_MS || 90_000);
const SINGLE_SHOT_MAX_TOKENS = Number(process.env.CCU_SINGLE_SHOT_MAX_TOKENS || 4096);

// Feature flag for the position-based label matcher introduced 2026-05-21.
// New prompt asks gpt-5.5 to return labels and devices as two arrays with
// normalised position_x values; downstream code does the nearest-neighbour
// 1-to-1 assignment instead of trusting the VLM to do it. Default ON;
// CCU_VLM_POSITION_MATCHER="false" reverts to the per-entry label path
// (defensive emergency rollback — the prompt still includes the legacy
// label-per-entry field as a fallback when this flag is off).
const VLM_POSITION_MATCHER_ENABLED =
  (process.env.CCU_VLM_POSITION_MATCHER ?? 'true').toLowerCase() === 'true';

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

export const MODERN_PROMPT = `You are inspecting a UK consumer unit's main DIN rail. The image shows a single horizontal rail with a row of devices left-to-right.

Devices visible: MCBs, RCBOs, RCDs, blanking plates, main switches, SPDs. Each device is mounted on the rail and may have a circuit-label strip above and/or below it.

YOUR JOB
List every visible MODULE SLOT in strict left-to-right order. ONE ENTRY = ONE MODULE SLOT.

A 2-pole device that physically occupies TWO module slots — typically a 2-pole main switch or a 2-module RCD — must be returned as TWO ENTRIES with identical device_kind, label, ocpd_rating_a, ocpd_bs_en, rcd_type, rcd_rating_ma. Three-pole isolators: three identical entries.

INCLUDE blanking plates (plain plastic covers in an unused slot) as ordinary entries with device_kind:"blank".

COUNTING — CRITICAL
Before writing any entries, count the visible toggle handles (or rocker switches, or fuse carriers) along the rail. UK consumer units commonly have runs of 3–8 IDENTICAL-LOOKING MCBs side-by-side (same colour, same amperage, same curve letter — e.g. four B32s in a row or six B6s in a row). It is easy to miscount these as "three" or "five" when there are actually four or six.

Procedure:
1. First, scan left-to-right and count every distinct toggle/rocker handle on the rail. Note the total.
2. Then identify the major reference points: where does the row of MCBs start? Where does the RCD sit (if any)? Where is the main switch?
3. For each RUN of identical-looking MCBs, count them individually by toggle. Do NOT describe a run as "several" or estimate — point at each toggle in turn (mentally), incrementing a counter.
4. Your output must have one entry per physical slot — INCLUDING every identical MCB in a run. Five identical B6 MCBs in a row = five entries with rating=6, curve="B".
5. Sanity check before returning: does the total entries count = the total toggles you counted in step 1, accounting for 2-pole/3-pole devices contributing 2 or 3 entries each? If they don't match, re-count.

If unsure between N and N+1 in a long run of identicals, prefer N+1 — the post-extraction layer cross-checks with an independent geometric pipeline and a phantom slot is recoverable; a missed slot is not.

OUTPUT
Return a JSON object with TWO keys: "entries" (one per module slot) and "labels" (one per visible circuit label on the strip channel).

"entries" — array, one object per visible MODULE SLOT in strict left-to-right order:
  {
    "device_kind": "mcb" | "rcbo" | "rcd" | "main_switch" | "spd" | "blank",
    "ocpd_rating_a": <integer amperage on the device face, or null>,
    "ocpd_curve": "B" | "C" | "D" | null,
    "ocpd_bs_en": "BS EN 60898" | "BS EN 61009" | "BS EN 60947-2" | null,
    "rcd_type": "AC" | "A" | "F" | "B" | null,
    "rcd_rating_ma": <integer mA for RCD/RCBO, or null>,
    "device_code": <printed part number on the device face, EXACTLY as printed, e.g. "61/B16" on a Crabtree MCB, "iC60N" on a Schneider MCB, "MCN116" on a Hager MCB, "AFDD-32B" on an AFDD; null if not readable or no part number visible>,
    "position_x": <fraction 0.0 - 1.0 of image width where this device's HORIZONTAL CENTRE sits>
  }

"labels" — array, one object per visible printed CIRCUIT LABEL on the strip channel (above or below the rail), in left-to-right order:
  {
    "text": <label text after applying the abbreviation normalisation below, or null if illegible>,
    "position_x": <fraction 0.0 - 1.0 of image width where this label's HORIZONTAL CENTRE sits>
  }

POSITION_X values are measured from the LEFT edge of the image (=0.0) to the RIGHT edge (=1.0). Be precise — these positions will be matched to devices in code, not by your reasoning. Do NOT assign labels to devices yourself; just report what you see and where.

RULES (entries)
- Read the printed amperage from the device face, not from any label nearby.
- Trip-curve letter is printed beside the amperage on the device face. If you can't read it, return null.
- For RCBOs and RCDs, look for the waveform symbol (∿ AC, ⬓ A, ⌒ F, ⊐ B). Return null if symbol is unclear.

RULES (labels)
- Include every label you can read on the strip channel above OR below the rail. Each label gets ONE entry in the labels array, at its horizontal centre.
- IGNORE the printed circuit-number prefix at the top of the strip (the small "1", "2", "3" etc.). The schedule renumbers, so the printed number is noise — don't include it as a label.
- Join multi-line wraps with a single space — e.g. a strip with "Upstairs" on one line and "Lighting" on the next is ONE label "Upstairs Lighting".
- If a label is faded or illegible, omit it from the labels array (or include with text:null if you can locate the position but not read the text).
- For boards with pictogram icons (stove hob, lightbulb, socket outlet, showerhead, etc.), report the normalised text equivalent: hob/stove icon → "Cooker", lightbulb → "Lighting" or "Lights", socket icon → "Sockets", showerhead → "Shower".
- Normalise common abbreviations to title-case EICR terms:
    Imm / Immersion / Hot Water / HW → "Water Heater"
    Smokes / Smoke / S/D / Smoke Det → "Smoke Alarm"
    Lts / Ltg → "Lights"
    Skt / Skts → "Sockets" (keep any room prefix, e.g. "Kitchen Sockets")
    CKR → "Cooker"
    Shwr → "Shower"
    Blr → "Boiler"
    FF / F/F → "Fridge Freezer"
    CH → "Central Heating"
    UFH → "Underfloor Heating"
    W/M / Washer → "Washing Machine"
    T/D → "Tumble Dryer"
    EV / EVCP → "Electric Vehicle"

Return JSON only — no prose, no markdown fence.`;

export const REWIREABLE_PROMPT = `You are inspecting a UK consumer unit with REWIREABLE FUSE CARRIERS (BS 3036) instead of modern MCBs. The fuse carriers are coloured plastic blocks (white=5A, blue=15A, yellow=20A, red=30A, green=45A) and slot into a horizontal carrier panel.

YOUR JOB
List every visible CARRIER SLOT in strict left-to-right order. ONE ENTRY = ONE CARRIER SLOT.

OUTPUT
Return a JSON object with TWO keys: "entries" (one per carrier slot) and "labels" (one per visible circuit label on the strip channel).

"entries" — array, one object per visible CARRIER SLOT in strict left-to-right order:
  {
    "device_kind": "rewireable" | "main_switch" | "blank",
    "ocpd_rating_a": <integer derived from carrier colour, or null>,
    "ocpd_bs_en": "BS 3036" | null,
    "body_colour": "white" | "blue" | "yellow" | "red" | "green" | null,
    "device_code": <any printed part number stamped on the carrier or main switch, EXACTLY as printed; null if not readable or absent>,
    "position_x": <fraction 0.0 - 1.0 of image width where this carrier's HORIZONTAL CENTRE sits>
  }

"labels" — array, one object per visible printed CIRCUIT LABEL on the strip channel (above or below the carrier panel), in left-to-right order:
  {
    "text": <label text after applying the abbreviation normalisation below, or null if illegible>,
    "position_x": <fraction 0.0 - 1.0 of image width where this label's HORIZONTAL CENTRE sits>
  }

POSITION_X values are measured from the LEFT edge of the image (=0.0) to the RIGHT edge (=1.0). Be precise — these positions will be matched to carriers in code, not by your reasoning. Do NOT assign labels to carriers yourself; just report what you see and where.

RULES (entries)
- Carrier colour is the strongest rating signal. Match white=5A, blue=15A, yellow=20A, red=30A, green=45A.
- Main switch is a separate row or end position; if visible, use device_kind:"main_switch".
- Empty slots in the carrier panel are blanks: device_kind:"blank".

RULES (labels)
- Include every label you can read on the strip channel above OR below the carrier panel. Each label gets ONE entry in the labels array, at its horizontal centre.
- IGNORE the printed circuit-number prefix at the top of the strip (the small "1", "2", "3" etc.). The schedule renumbers, so the printed number is noise — don't include it as a label.
- Join multi-line wraps with a single space — e.g. a strip with "Upstairs" on one line and "Lighting" on the next is ONE label "Upstairs Lighting".
- If a label is faded or illegible, omit it from the labels array (or include with text:null if you can locate the position but not read the text).
- For boards with pictogram icons (stove hob, lightbulb, socket outlet, showerhead, etc.), report the normalised text equivalent: hob/stove icon → "Cooker", lightbulb → "Lighting" or "Lights", socket icon → "Sockets", showerhead → "Shower".
- Normalise common abbreviations to title-case EICR terms:
    Imm / Immersion / Hot Water / HW → "Water Heater"
    Smokes / Smoke / S/D / Smoke Det → "Smoke Alarm"
    Lts / Ltg → "Lights"
    Skt / Skts → "Sockets" (keep any room prefix, e.g. "Kitchen Sockets")
    CKR → "Cooker"
    Shwr → "Shower"
    Blr → "Boiler"
    FF / F/F → "Fridge Freezer"
    CH → "Central Heating"
    UFH → "Underfloor Heating"
    W/M / Washer → "Washing Machine"
    T/D → "Tumble Dryer"
    EV / EVCP → "Electric Vehicle"

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
  // 1. Perspective-dewarp the rail when we have a quad — kill-switch
  //    via CCU_DEWARP_ENABLED. Only the modern DIN-rail path: rewireable
  //    boards use panelBounds (axis-aligned rectangle on the cover, not
  //    a tilted rail), so the dewarp doesn't apply there.
  //
  //    On any dewarp error we log and fall through to the legacy
  //    axis-aligned extract so the single-shot path is never blocked by
  //    a dewarp regression. iOS sees the same response shape either way.
  if (DEWARP_ENABLED && !isRewireable && prepared.railQuad) {
    try {
      const dewarpStart = Date.now();
      const result = await dewarpRailQuad({
        imageBuffer,
        quad: prepared.railQuad,
        // 200% vertical margin on each side captures the label strips
        // above and below the rail. Horizontal margin is 10% of rail
        // width on each end (~1 module on a 19-way board) — gives the
        // VLM breathing room when the box-tightener clips the rail
        // short, without dragging in an adjacent CU.
        marginAboveFraction: 2.0,
        marginBelowFraction: 2.0,
        marginHorizontalFraction: 0.1,
        outputWidth: DEWARP_OUTPUT_WIDTH,
        maxOutputWidth: DEWARP_MAX_WIDTH,
      });
      if (logger) {
        logger.info('CCU single-shot rail-region dewarp', {
          sourceWidth: imgW,
          sourceHeight: imgH,
          outputWidth: result.outputWidth,
          outputHeight: result.outputHeight,
          sourceBytes: imageBuffer.length,
          dewarpedBytes: result.buffer.length,
          dewarpMs: Date.now() - dewarpStart,
          quad: prepared.railQuad,
        });
      }
      return result.buffer;
    } catch (err) {
      if (logger) {
        logger.warn('CCU single-shot dewarp failed, falling back to bbox extract', {
          error: err?.message ?? String(err),
        });
      }
      // intentional fall-through to the legacy path below
    }
  }

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
  const labelArray = Array.isArray(parsed.labels) ? parsed.labels : [];

  return {
    ms,
    usage: {
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      cachedInputTokens: usage.cached_input_tokens || 0,
    },
    entries,
    labelArray,
    rawText,
  };
}

// ---------------------------------------------------------------------------
// Position-based label-to-device matcher
// ---------------------------------------------------------------------------

/**
 * Devices that should receive circuit labels via the position matcher.
 * Main switches, RCDs (section headers like "RCD Protected Circuits"),
 * SPDs and blanks are EXCLUDED — labels near those positions are either
 * device-kind identifiers ("Main Switch", "(RCD)") or section headers,
 * neither of which should surface as circuit labels in the final
 * schedule. slotsToCircuits filters main_switch/spd/blank out of
 * circuits[] anyway, so labels on those entries would be ignored
 * downstream — pre-filtering here keeps section headers from "stealing"
 * a slot the real circuit label could have matched.
 */
const LABEL_MATCHABLE_KINDS = new Set(['mcb', 'rcbo', 'rewireable', 'cartridge']);

// Selects which label-to-device matching algorithm to use. Default
// 'monotonic' — global sequence alignment via DP, ships 2026-05-21 to
// fix the Wylex NHRS12SL +1-shift regression (handoff
// .planning-stage6-agentic/handoffs/ccu-label-shift-2026-05-21/).
// 'nearest' falls back to the per-label nearest-neighbour matcher that
// shipped 2026-05-21 earlier the same day. Kept as a one-flag rollback
// — flip `CCU_LABEL_MATCHER_ALGORITHM=nearest` on the ECS task def to
// revert without a redeploy. Delete the nearest path once monotonic
// has 2 weeks in production with no surprises.
const LABEL_MATCHER_ALGORITHM = (
  process.env.CCU_LABEL_MATCHER_ALGORITHM ?? 'monotonic'
).toLowerCase();

/**
 * Public entry point — dispatches to the configured matching algorithm.
 * Mutates `entries` in place (sets entries[i].label). Returns a
 * diagnostic object for CloudWatch logging.
 *
 * See `matchLabelsToEntriesMonotonic` (default) for the algorithm
 * detail. The legacy `matchLabelsToEntriesNearest` is preserved as a
 * one-env-var rollback path.
 */
export function matchLabelsToEntries(entries, labelArray) {
  if (LABEL_MATCHER_ALGORITHM === 'nearest') {
    return matchLabelsToEntriesNearest(entries, labelArray);
  }
  return matchLabelsToEntriesMonotonic(entries, labelArray);
}

/**
 * Monotonic sequence-alignment label matcher (default since 2026-05-21).
 *
 * The previous nearest-neighbour matcher operated per label in isolation:
 * for each label, pick the closest matchable device within a tight
 * pitch-derived threshold. This was robust to obvious failure modes
 * (section headers landing on RCDs) but had a subtle one: when the VLM's
 * reported positions drift by ~0.02 normalised x (which they do — see
 * the 2026-05-21 diagnostic replay against the failing Wylex extraction
 * 1779384564405-u7dp9b), a label can flip to a neighbour device whose
 * x happens to be marginally closer that turn. Result: every circuit
 * downstream shifts by one slot until the next gap absorbs the slack.
 *
 * The fix is to stop matching per-label and instead solve the GLOBAL
 * one-to-one assignment that preserves the LEFT-TO-RIGHT ORDER of both
 * lists — labels are emitted in left-to-right order along the strip,
 * devices are mounted left-to-right on the rail, so the right answer
 * must respect that ordering. Standard dynamic-programming sequence
 * alignment (same machinery as DTW, Needleman-Wunsch) computes this in
 * O(L × D) time.
 *
 * Algorithm:
 *   1. Filter entries to matchable kinds (mcb/rcbo/rewireable/cartridge);
 *      sort by x. Filter labels to those with valid text + x; sort by x.
 *   2. Derive `pitch` = median adjacent gap between matchable candidates
 *      (same as the nearest matcher — single source of truth).
 *   3. Build a (L+1) × (D+1) DP table where cost[i][j] = best total
 *      cost to align labels[0..i-1] with candidates[0..j-1]. At each
 *      cell, pick the cheapest of three moves:
 *        - MATCH: cost[i-1][j-1] + |label_i.x − cand_j.x|
 *        - LABEL-SKIP (section header / hallucinated label):
 *            cost[i-1][j] + LABEL_SKIP_PENALTY
 *        - DEVICE-SKIP (unlabelled device, e.g. spare slot):
 *            cost[i][j-1] + DEVICE_SKIP_PENALTY
 *   4. Backtrack from (L, D) to recover the actual assignment.
 *   5. Apply matched label.text onto entries[c.idx].label. Unmatched
 *      matchable entries get label = null.
 *
 * Cost weights — tune via the env vars
 * `CCU_LABEL_MATCHER_LABEL_SKIP_FACTOR`,
 * `CCU_LABEL_MATCHER_DEVICE_SKIP_FACTOR`,
 * `CCU_LABEL_MATCHER_MAX_MATCH_FACTOR` (all relative to pitch):
 *
 *   LABEL_SKIP_PENALTY = pitch        (default factor 1.0)
 *     A label costs roughly one slot of misalignment to discard.
 *     Higher → keeps labels even when their nearest device is far away
 *     (risk: section headers swallow a real device). Lower → drops
 *     labels too eagerly. The current value matches the cost of one
 *     pitch of match-distance, so a label is matched if and only if
 *     there's a device within ~one pitch of it.
 *
 *   DEVICE_SKIP_PENALTY = 0.5 × pitch (default factor 0.5)
 *     A device costs half a slot to skip. Non-zero is CRITICAL — with
 *     0 the algorithm gratuitously shifts labels +1 to chase a closer
 *     neighbour match, exactly the bug we're fixing. 0.5 × pitch is
 *     the smallest value at which the Wylex Kitchen Sockets +1 shift
 *     becomes unprofitable in DP cost terms (the 0.006 distance gain
 *     from picking slot 4 over slot 3 is offset by the 0.026 skip
 *     cost). Don't lower this below ~0.4 × pitch without re-validating
 *     the Wylex regression test.
 *
 *   MAX_MATCH_COST = 0.7 × pitch     (default factor 0.7)
 *     Hard cap on individual match distance — beyond this, the match
 *     cost is Infinity (forbidden). Without the cap a label sitting
 *     in the middle of nowhere could match the nearest device across
 *     the entire rail; with it, far-from-anything labels are forced to
 *     label-skip and the device they would have stolen stays available
 *     for the next label in sequence. 0.7 is slightly more permissive
 *     than the old 0.5 × pitch nearest-neighbour threshold so a
 *     leftmost label (which tends to sit slightly right of its device
 *     due to label-strip layout) doesn't get dropped — but tight
 *     enough that "Sockets" at 0.85 × pitch from its only matchable
 *     neighbour still gets skipped.
 *
 * Backtrack tie-break (when two moves have equal cost): match > label-
 * skip > device-skip. Rationale: a match is the most informative
 * outcome; label-skip is the next-likely "real" interpretation (a
 * section header that gpt-5.5 emitted alongside circuit labels); a
 * device-skip is the least informative (just padding).
 *
 * Diagnostic shape (returned object, also logged to CloudWatch):
 *   {
 *     algorithm, skipped, skipReason,
 *     labelsInput, labelsValidated, candidates,
 *     matched, labelsSkipped, devicesSkipped,
 *     pitchNorm, labelSkipPenalty, deviceSkipPenalty, maxMatchCost,
 *     totalCost,
 *   }
 *
 * Mutates `entries` in place.
 */
export function matchLabelsToEntriesMonotonic(entries, labelArray) {
  const diag = {
    algorithm: 'monotonic',
    skipped: false,
    skipReason: null,
    labelsInput: Array.isArray(labelArray) ? labelArray.length : 0,
    labelsValidated: 0,
    candidates: 0,
    matched: 0,
    labelsSkipped: 0,
    devicesSkipped: 0,
    pitchNorm: null,
    labelSkipPenalty: null,
    deviceSkipPenalty: null,
    maxMatchCost: null,
    totalCost: null,
  };

  if (!Array.isArray(labelArray) || labelArray.length === 0) {
    diag.skipped = true;
    diag.skipReason = 'no_labels_array';
    return diag;
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    diag.skipped = true;
    diag.skipReason = 'no_entries';
    return diag;
  }

  // 1a. Build candidate list. Each candidate carries its ORIGINAL index in
  //     entries[] so the result can be written back to the right slot.
  //     Sort left-to-right by x — the monotonic constraint is in candidate-x
  //     order, not entries[] order (defensive: VLM's entries[] *should* be
  //     left-to-right but the diagnostic showed it isn't always).
  const candidates = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const kind = typeof e?.device_kind === 'string' ? e.device_kind.toLowerCase().trim() : null;
    const x = typeof e?.position_x === 'number' ? e.position_x : null;
    if (kind && LABEL_MATCHABLE_KINDS.has(kind) && x != null && x >= 0 && x <= 1) {
      candidates.push({ idx: i, x });
    }
  }
  candidates.sort((a, b) => a.x - b.x);
  diag.candidates = candidates.length;

  if (candidates.length === 0) {
    diag.skipped = true;
    diag.skipReason = 'no_matchable_candidates';
    return diag;
  }

  // 1b. Build label list (valid text + valid x); sort left-to-right.
  const labels = [];
  for (const lab of labelArray) {
    const lx = typeof lab?.position_x === 'number' ? lab.position_x : null;
    const text = typeof lab?.text === 'string' ? lab.text.trim() : null;
    if (lx == null || lx < 0 || lx > 1 || !text) continue;
    labels.push({ x: lx, text });
  }
  labels.sort((a, b) => a.x - b.x);
  diag.labelsValidated = labels.length;

  if (labels.length === 0) {
    diag.skipped = true;
    diag.skipReason = 'no_valid_labels';
    // Still clear stale label fields on matchable entries.
    for (const c of candidates) entries[c.idx].label = null;
    return diag;
  }

  // 2. Pitch = median adjacent gap between matchable candidates.
  let pitch;
  if (candidates.length < 2) {
    pitch = 1 / Math.max(entries.length + 1, 2);
  } else {
    const gaps = [];
    for (let i = 1; i < candidates.length; i++) {
      gaps.push(candidates[i].x - candidates[i - 1].x);
    }
    gaps.sort((a, b) => a - b);
    pitch = gaps[Math.floor(gaps.length / 2)];
  }

  // Tunable factors. Defaults derived in the algorithm docstring above.
  const labelSkipFactor = Number(process.env.CCU_LABEL_MATCHER_LABEL_SKIP_FACTOR ?? 1.0);
  const deviceSkipFactor = Number(process.env.CCU_LABEL_MATCHER_DEVICE_SKIP_FACTOR ?? 0.5);
  const maxMatchFactor = Number(process.env.CCU_LABEL_MATCHER_MAX_MATCH_FACTOR ?? 0.7);
  const LABEL_SKIP_PENALTY = labelSkipFactor * pitch;
  const DEVICE_SKIP_PENALTY = deviceSkipFactor * pitch;
  const MAX_MATCH_COST = maxMatchFactor * pitch;

  diag.pitchNorm = Number(pitch.toFixed(4));
  diag.labelSkipPenalty = Number(LABEL_SKIP_PENALTY.toFixed(4));
  diag.deviceSkipPenalty = Number(DEVICE_SKIP_PENALTY.toFixed(4));
  diag.maxMatchCost = Number(MAX_MATCH_COST.toFixed(4));

  // 3. DP fill. cost[i][j] = min cost to align labels[0..i-1] ↔ cands[0..j-1].
  const L = labels.length;
  const D = candidates.length;
  const cost = Array.from({ length: L + 1 }, () => new Float64Array(D + 1));
  // path[i][j]: 0=MATCH (diagonal), 1=LABEL_SKIP (from i-1,j), 2=DEVICE_SKIP (from i,j-1).
  const path = Array.from({ length: L + 1 }, () => new Uint8Array(D + 1));

  // Init: empty labels align with all-skipped devices, and vice versa.
  for (let j = 1; j <= D; j++) {
    cost[0][j] = j * DEVICE_SKIP_PENALTY;
    path[0][j] = 2;
  }
  for (let i = 1; i <= L; i++) {
    cost[i][0] = i * LABEL_SKIP_PENALTY;
    path[i][0] = 1;
  }

  for (let i = 1; i <= L; i++) {
    for (let j = 1; j <= D; j++) {
      const dist = Math.abs(labels[i - 1].x - candidates[j - 1].x);
      const matchCost = dist > MAX_MATCH_COST ? Infinity : dist;
      const matchOpt = cost[i - 1][j - 1] + matchCost;
      const labelSkipOpt = cost[i - 1][j] + LABEL_SKIP_PENALTY;
      const deviceSkipOpt = cost[i][j - 1] + DEVICE_SKIP_PENALTY;

      // Tie-break: match > label-skip > device-skip (strict-less compares).
      let best = matchOpt;
      let how = 0;
      if (labelSkipOpt < best) {
        best = labelSkipOpt;
        how = 1;
      }
      if (deviceSkipOpt < best) {
        best = deviceSkipOpt;
        how = 2;
      }
      cost[i][j] = best;
      path[i][j] = how;
    }
  }
  diag.totalCost = Number.isFinite(cost[L][D]) ? Number(cost[L][D].toFixed(4)) : null;

  // 4. Backtrack from (L, D) to recover the assignment.
  const matchByCandidateIdx = new Map();
  let labelsSkipped = 0;
  let devicesSkipped = 0;
  {
    let i = L;
    let j = D;
    while (i > 0 || j > 0) {
      if (i === 0) {
        devicesSkipped++;
        j--;
        continue;
      }
      if (j === 0) {
        labelsSkipped++;
        i--;
        continue;
      }
      const move = path[i][j];
      if (move === 0) {
        matchByCandidateIdx.set(candidates[j - 1].idx, labels[i - 1].text);
        i--;
        j--;
      } else if (move === 1) {
        labelsSkipped++;
        i--;
      } else {
        devicesSkipped++;
        j--;
      }
    }
  }
  diag.matched = matchByCandidateIdx.size;
  diag.labelsSkipped = labelsSkipped;
  diag.devicesSkipped = devicesSkipped;

  // 5. Apply. Matchable entries: matched label or null (clears stale labels
  //    from any prior per-entry-label code path). Non-matchable kinds
  //    (main_switch, rcd, spd, blank) are not touched — the merger filters
  //    them out of circuits[] anyway.
  for (const c of candidates) {
    const matched = matchByCandidateIdx.get(c.idx);
    entries[c.idx].label = matched != null ? matched : null;
  }
  return diag;
}

/**
 * Legacy nearest-neighbour label matcher. Kept as a one-env-var rollback
 * path for the monotonic matcher that replaced it on 2026-05-21. Reverts
 * to per-label nearest-within-half-pitch behaviour — see commit history
 * for the full failure-mode story.
 *
 * To activate: set `CCU_LABEL_MATCHER_ALGORITHM=nearest` on the task def.
 *
 * Delete this function once the monotonic matcher has 2 weeks in
 * production with no surprises and there's no scenario where we'd want
 * to roll back.
 */
export function matchLabelsToEntriesNearest(entries, labelArray) {
  const diag = {
    algorithm: 'nearest',
    skipped: false,
    skipReason: null,
    labelsInput: Array.isArray(labelArray) ? labelArray.length : 0,
    candidates: 0,
    matched: 0,
    droppedFarFromAnyDevice: 0,
    droppedDuplicateClaim: 0,
    pitchNorm: null,
    maxDistNorm: null,
  };

  if (!Array.isArray(labelArray) || labelArray.length === 0) {
    diag.skipped = true;
    diag.skipReason = 'no_labels_array';
    return diag;
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    diag.skipped = true;
    diag.skipReason = 'no_entries';
    return diag;
  }

  const candidates = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const kind = typeof e?.device_kind === 'string' ? e.device_kind.toLowerCase().trim() : null;
    const x = typeof e?.position_x === 'number' ? e.position_x : null;
    if (kind && LABEL_MATCHABLE_KINDS.has(kind) && x != null && x >= 0 && x <= 1) {
      candidates.push({ idx: i, x });
    }
  }
  diag.candidates = candidates.length;

  if (candidates.length === 0) {
    diag.skipped = true;
    diag.skipReason = 'no_matchable_candidates';
    return diag;
  }

  const sortedX = candidates.map((c) => c.x).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < sortedX.length; i++) gaps.push(sortedX[i] - sortedX[i - 1]);
  let pitch;
  if (gaps.length === 0) {
    pitch = 1 / Math.max(entries.length + 1, 2);
  } else {
    gaps.sort((a, b) => a - b);
    pitch = gaps[Math.floor(gaps.length / 2)];
  }
  const maxDist = 0.5 * pitch;
  diag.pitchNorm = Number(pitch.toFixed(4));
  diag.maxDistNorm = Number(maxDist.toFixed(4));

  const bestByIdx = new Map();
  for (const lab of labelArray) {
    const lx = typeof lab?.position_x === 'number' ? lab.position_x : null;
    const text = typeof lab?.text === 'string' ? lab.text.trim() : null;
    if (lx == null || lx < 0 || lx > 1 || !text) continue;

    let bestDist = Infinity;
    let bestCand = null;
    for (const c of candidates) {
      const d = Math.abs(c.x - lx);
      if (d < bestDist) {
        bestDist = d;
        bestCand = c;
      }
    }
    if (!bestCand || bestDist > maxDist) {
      diag.droppedFarFromAnyDevice++;
      continue;
    }

    const prev = bestByIdx.get(bestCand.idx);
    if (!prev) {
      bestByIdx.set(bestCand.idx, { text, dist: bestDist });
    } else if (bestDist < prev.dist) {
      bestByIdx.set(bestCand.idx, { text, dist: bestDist });
      diag.droppedDuplicateClaim++;
    } else {
      diag.droppedDuplicateClaim++;
    }
  }
  diag.matched = bestByIdx.size;

  for (const c of candidates) {
    const m = bestByIdx.get(c.idx);
    entries[c.idx].label = m ? m.text : null;
  }
  return diag;
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

    // device_code is the printed part number on the device face (e.g.
    // Crabtree "61/B16", Schneider "iC60N", Hager "MCN116"). When the VLM
    // can read it, the downstream RCD-type lookup uses it as a precise
    // identifier — manufacturer + part number resolves a single datasheet
    // entry instead of guessing across a manufacturer's whole catalogue.
    const deviceCode =
      typeof raw.device_code === 'string' && raw.device_code.trim() !== ''
        ? raw.device_code.trim()
        : null;

    // Preserve the VLM's reported horizontal position so the label-shift
    // bug can be diagnosed offline from result.json without re-calling the
    // model. Stamped per-slot (camelCase to match the rest of this struct)
    // and re-emitted as analysis.slots[].position_x_normalised by the route
    // handler so the saved result.json carries it. See handoff
    // .planning-stage6-agentic/handoffs/ccu-label-shift-2026-05-21/HANDOFF.md
    // for the diagnostic flow this enables.
    const positionXNormalised =
      typeof raw.position_x === 'number' && raw.position_x >= 0 && raw.position_x <= 1
        ? raw.position_x
        : null;

    slots.push({
      slotIndex: s,
      content: cls === 'blank' ? 'blank' : 'device',
      extends: 'none',
      classification: cls,
      manufacturer:
        boardManufacturer ?? (cls === 'rcbo' || cls === 'rcd' || cls === 'mcb' ? 'unknown' : null),
      model: deviceCode,
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
      positionXNormalised,
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
  //    to be misclassified as blank from attention dilution.
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

  // 2b. Position-based label matcher (2026-05-21). Replaces the prior
  //     "VLM picks the label per entry" approach with code-side nearest-
  //     neighbour matching on the VLM's reported label/device positions.
  //     Failure mode addressed: gpt-5.5 perceives positions reliably
  //     (range 0.006 normalised across 5 runs on the same image) but
  //     skips its own closer-to-neighbour check when assigning, sticking
  //     labels onto the wrong adjacent MCB. See matchLabelsToEntries
  //     header for the algorithm. Mutates result.entries in place.
  //
  //     Gated by CCU_VLM_POSITION_MATCHER env var (default true). When
  //     OFF, the VLM's per-entry label field survives unchanged (legacy
  //     behaviour — risk-free rollback path).
  let labelMatcherDiag = null;
  if (VLM_POSITION_MATCHER_ENABLED) {
    labelMatcherDiag = matchLabelsToEntries(result.entries, result.labelArray);
    if (logger) {
      logger.info('CCU single-shot label matcher', {
        userId,
        enabled: true,
        ...labelMatcherDiag,
      });
    }
  } else if (logger) {
    logger.info('CCU single-shot label matcher', { userId, enabled: false });
  }

  // 3. Build slots[] + labels[] in the shape downstream code expects.
  const { slots, labels } = entriesToSlots(result.entries, boardManufacturer, vlmCountAgreesWithCv);

  // 4. Effective pitch derived from final slot count and rail width.
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

  // Raw VLM output exposed for offline diagnostic replay. The matcher
  // mutates result.entries[i].label in place, but the original label
  // text + label position_x in result.labelArray is untouched, and the
  // per-entry position_x is still present on result.entries[i]. Surfacing
  // both keeps result.json self-diagnosing for the 2026-05-21 label-shift
  // bug — a future change to matchLabelsToEntries can be replayed against
  // these saved arrays without re-billing the VLM call.
  const labelArrayRaw = Array.isArray(result.labelArray)
    ? result.labelArray.map((l) => ({
        text: typeof l?.text === 'string' ? l.text : null,
        positionX:
          typeof l?.position_x === 'number' && l.position_x >= 0 && l.position_x <= 1
            ? l.position_x
            : null,
      }))
    : [];
  const entriesRaw = Array.isArray(result.entries)
    ? result.entries.map((e, i) => ({
        index: i,
        deviceKind: typeof e?.device_kind === 'string' ? e.device_kind.toLowerCase().trim() : null,
        positionX:
          typeof e?.position_x === 'number' && e.position_x >= 0 && e.position_x <= 1
            ? e.position_x
            : null,
      }))
    : [];

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
    labelArrayRaw,
    entriesRaw,
    labelMatcherDiag,
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
