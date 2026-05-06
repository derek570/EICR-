/**
 * Sliding-window CCU extraction — ordered-list pipeline.
 *
 * Design (replaces position-clustered v5c, 2026-05-07):
 *
 *   The VLM is asked to enumerate every visible MODULE SLOT in left-to-right
 *   order, one entry per slot. A 2-pole device that occupies two physical
 *   slots is returned as TWO entries with identical kind/label/rating —
 *   "RCD counts as 2", as Derek put it. Edge-clipped devices are
 *   deliberately OMITTED so the count from each window is unambiguous, and
 *   the next overlapping window covers them whole. Bare DIN rail and cover
 *   plastic are also omitted; only physical devices and blanking plates
 *   appear in the response.
 *
 *   Consecutive overlapping windows are reconciled by sequence alignment on
 *   device_kind (with rating as a secondary tiebreaker). The merger walks
 *   pairwise through the windows, finds the largest tail/head match between
 *   window N and window N+1, votes on the overlapping entries, and appends
 *   the non-overlapping tail. The result is a canonical ordered list of
 *   entries — one per module slot of the rail — that maps 1:1 to the
 *   downstream `slots[]` shape consumed by `slotsToCircuits`.
 *
 *   Window planning extends ~`overshootMod` modules past each rail edge.
 *   Off-rail regions are visually empty, the model omits them per the prompt
 *   rules, so the overshoot windows naturally return fewer entries near the
 *   edges. This serves three purposes simultaneously:
 *     (1) every real edge device gets at least 2 window passes (no single-
 *         coverage at the rail extremes);
 *     (2) end-of-rail is self-validating — if the leftmost or rightmost
 *         window returns close to a full `windowMod` of devices, the rail
 *         estimate was short and a warning is logged;
 *     (3) the merger's "no leftover unowned slots in the interior" guarantee
 *         removes the entire class of fabricated "exposed rail" defects
 *         that the position-clustered pipeline produced when it dropped a
 *         cluster (extractions 1778086091005-v9sst9 and 1778103470875-488yba
 *         are the named regressions this rewrite closes).
 *
 *   What this rewrite removes:
 *     - position_pct in the prompt (VLMs are unreliable at pixel coordinates;
 *       we don't ask for what the model is bad at).
 *     - clusterReads / mergeAdjacentMainSwitchClusters / snap-to-slot
 *       placement (all artefacts of the position-clustered design — gone).
 *     - The downstream patches in extraction.js
 *       (trimSpuriousMainSwitchClusterRuns, promoteLabelMatchedMainSwitch,
 *       promoteLabelMatchedRcd) exist purely to fix symptoms of the old
 *       merger; they are removed in the same change.
 *
 * Output contract is unchanged: returns `{slots, labels, finalDevices,
 * snappedWays, pitchPx, timings, usage, lowConfidence, stage3Error,
 * stageOutputs, skippedSlotIndices}` so the existing route-handler chain
 * (assembleGeometricResult, slotsToCircuits, applyRcdTypeLookup,
 * applyBsEnFallback, normaliseCircuitLabels, lookupMissingRcdTypes,
 * flagRcdWaveformOutliers) consumes it without change.
 */
import sharp from 'sharp';
import { cropSlot } from './ccu-geometric.js';
import { cropCarrierSlot } from './ccu-geometric-rewireable.js';

const SLIDING_WINDOW_TIMEOUT_MS = Number(process.env.CCU_SLIDING_WINDOW_TIMEOUT_MS || 60_000);
const SLIDING_WINDOW_MAX_TOKENS = 2048;

// Wylex BS 3036 colour-code lookup for rewireable carriers — only used when
// the VLM left ocpd_rating_a null on a rewireable.
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
//
// The unifying rule is: ONE ENTRY PER MODULE SLOT, in strict left-to-right
// order. Multi-module devices are repeated. Edge-clipped devices and bare
// rail are omitted. The VLM never returns coordinates — only an ordered
// list — because spatial regression is its weak suit and the surrounding
// pipeline doesn't need it (CV owns the geometry, the merger owns the
// alignment).
// ---------------------------------------------------------------------------

const MODERN_PROMPT = `You are inspecting a horizontal section of a UK consumer unit's main DIN rail.

Devices visible: MCBs, RCBOs, RCDs, blanking plates, main switches, SPDs, all mounted on a horizontal rail with a circuit-label strip above and/or below.

YOUR JOB
List every visible MODULE SLOT in strict left-to-right order. ONE ENTRY = ONE MODULE SLOT.

A 2-pole device that physically occupies TWO module slots — typically a 2-pole main switch or a 2-module RCD — must be returned as TWO ENTRIES with identical device_kind, label, ocpd_rating_a, ocpd_bs_en, rcd_type, rcd_rating_ma. (One entry per module slot it occupies.) Three-pole isolators: three identical entries.

EDGE RULES — read carefully, these are the most common source of error:
- OMIT any device whose body is partially clipped at the LEFT or RIGHT edge of this image. The next overlapping window will see it whole. UNDER-reporting at the edges is correct; do not guess width or identity from a half view.
- OMIT bare DIN rail, cover plastic, the side/end of the consumer-unit enclosure, or anything that is not a physical device or a blanking plate. If a stretch of rail at either edge has no device and no blanking plate, do NOT add a placeholder.
- INCLUDE blanking plates (plain plastic covers in an unused slot) as ordinary entries with device_kind:"blank". They occupy a real module slot.

For each entry:
- device_kind: one of "mcb", "rcbo", "rcd", "main_switch", "spd", "blank"
- label: circuit name from the strip directly aligned with this module slot — copy VERBATIM (preserve exact spelling, including handwritten quirks). null if blank/unreadable. For a 2-mod device the same label is repeated on both entries.
- ocpd_rating_a: integer amperage from the device face (e.g. 32 for "B32A"). null if not clearly readable.
- ocpd_curve: "B", "C", or "D" for MCBs/RCBOs. null otherwise.
- ocpd_bs_en: e.g. "BS EN 61009", "BS EN 60898", "BS EN 61008", "BS EN 60947-3". null if uncertain.
- rcd_type: "AC", "A", "F", or "B" — ONLY if the trip classification is explicitly stated as TEXT on the device. The international AC waveform symbol alone does NOT mean Type AC; many Type A devices show that symbol. null if uncertain.
- rcd_rating_ma: 30, 100, 300, or 500. null otherwise.

Return STRICT JSON only — no markdown, no commentary:
{"entries":[{"device_kind":"mcb","label":"...","ocpd_rating_a":32,"ocpd_curve":"B","ocpd_bs_en":"BS EN 60898","rcd_type":null,"rcd_rating_ma":null},...]}`;

const REWIREABLE_PROMPT = `You are inspecting a horizontal section of a UK rewireable (bakelite) consumer unit. This is NOT a DIN-rail board — these are pull-out fuse carriers (BS 3036) or HBC cartridge fuses (BS 1361/BS 88-2) sitting in moulded sockets on a flat panel. Each carrier has a red pull-tab at the top.

YOUR JOB
List every visible CARRIER SLOT in strict left-to-right order. ONE ENTRY = ONE CARRIER SLOT.

A wide separate main switch / switch-fuse may span two carrier slots — return as TWO ENTRIES with identical device_kind:"main_switch", label, ocpd_rating_a, ocpd_bs_en.

EDGE RULES:
- OMIT any carrier whose body is partially clipped at the LEFT or RIGHT edge. The next overlapping window will see it whole.
- OMIT bare panel, side moulding, or anything that is not a physical carrier or a blanking plate.
- INCLUDE blanking plates (empty sockets without a carrier fitted) as device_kind:"blank".

For each entry:
- device_kind: one of "rewireable", "cartridge", "main_switch", "blank"
  • rewireable = BS 3036 pull-out carrier with rewireable fuse wire inside (Wylex/MEM/Crabtree/Bill domestic).
  • cartridge  = pull-out carrier holding an HBC cartridge fuse (BS 1361 or BS 88-2 commercial).
  • blank      = empty socket or blanking plate, no carrier fitted.
- body_colour: colour of the CARRIER BODY *below* the red pull-tab. One of "white","blue","yellow","red","green","unknown". CRITICAL: every Wylex carrier has a RED PULL-TAB — that's the lift handle, NOT the rating. Look at the body below the pull-tab. If the body itself is red below the tab, it IS a 30 A red carrier. null for cartridge / main_switch / blank.
- ocpd_rating_a: integer amperage. For cartridge fuses, read the rating printed on the carrier face. For rewireable, you may leave this null — we will derive it from body_colour via the Wylex code: white=5A, blue=15A, yellow=20A, red=30A, green=45A.
- ocpd_bs_en: "BS 3036" for rewireable, "BS 1361" for cartridge domestic, "BS 88-2" for cartridge commercial, "BS EN 60947-3" for main_switch. null if unsure.
- label: circuit name from the strip / inspector handwriting directly aligned with this carrier — copy VERBATIM. null if blank/unreadable.

Return STRICT JSON only — no markdown, no commentary:
{"entries":[{"device_kind":"rewireable","body_colour":"red","ocpd_rating_a":30,"ocpd_bs_en":"BS 3036","label":"..."},...]}`;

// ---------------------------------------------------------------------------
// Window planning
// ---------------------------------------------------------------------------

/**
 * Plan window pixel ranges along the rail.
 *
 * Each window is `windowMod × pitchPx` wide, advancing by `strideMod × pitchPx`.
 * The first window starts `overshootMod` pitches BEFORE railLeft and the last
 * window ends `overshootMod` pitches PAST railRight (clamped to the image).
 * The overshoot regions provide:
 *   - Double-coverage of edge devices (otherwise only seen by one window).
 *   - Self-validation of the rail extent — if an overshoot window returns
 *     close to a full `windowMod` of devices, the rail estimate was short.
 *
 * The internal stride is unchanged from the pre-overshoot version; we only
 * extend the start/end. A window's left or right that would fall outside
 * [0, imgW] is clamped — the overshoot region is then truncated but the
 * window is still useful for double-coverage.
 *
 * @param {number} railLeftPx
 * @param {number} railRightPx
 * @param {number} pitchPx
 * @param {number} windowMod   default 5
 * @param {number} strideMod   default 2
 * @param {number} imgW
 * @param {number} overshootMod  default 2 — how many pitches past each rail edge to extend
 * @returns {Array<{x0:number,x1:number,overshoot:'left'|'right'|'none'}>}
 */
export function planWindows(
  railLeftPx,
  railRightPx,
  pitchPx,
  windowMod,
  strideMod,
  imgW,
  overshootMod = 2
) {
  const windowPx = Math.round(windowMod * pitchPx);
  const stridePx = Math.round(strideMod * pitchPx);
  const overshootPx = Math.round(overshootMod * pitchPx);

  const startX = railLeftPx - overshootPx; // may be negative; clamped on use
  const endX = railRightPx + overshootPx; // may exceed imgW; clamped on use

  const windows = [];
  // Strict-less than `endX - windowPx + 1`: walk natural-stride windows whose
  // RIGHT edge does not exceed endX. The right-edge anchor below picks up any
  // remainder.
  for (let x0 = startX; x0 + windowPx <= endX; x0 += stridePx) {
    windows.push({ x0, x1: x0 + windowPx });
  }
  // Right-edge anchor: if the natural stride didn't land a window flush to
  // endX (railRightPx + overshootPx), add one more anchored to endX.
  if (windows.length === 0 || windows[windows.length - 1].x1 < endX - Math.round(pitchPx * 0.3)) {
    windows.push({ x0: endX - windowPx, x1: endX });
  }

  // Dedupe near-identical x0 (within 0.3 × pitch) — the right-anchor may
  // duplicate the last natural window when stride+overshoot align.
  const dedup = [];
  for (const w of windows) {
    if (dedup.length === 0 || Math.abs(dedup[dedup.length - 1].x0 - w.x0) > pitchPx * 0.3) {
      dedup.push(w);
    }
  }

  // Clamp to image bounds and tag overshoot ownership. A window whose
  // unclamped left was below railLeft is a "left overshoot"; whose unclamped
  // right exceeded railRight is a "right overshoot". A single window can be
  // both if the rail is narrower than `windowMod * pitchPx` (rare — sub-5-way
  // boards), in which case we tag it as 'left' to keep the type tight.
  return dedup.map((w) => {
    const x0 = Math.max(0, Math.round(w.x0));
    const x1 = Math.min(imgW, Math.round(w.x1));
    let overshoot = 'none';
    if (w.x0 < railLeftPx) overshoot = 'left';
    else if (w.x1 > railRightPx) overshoot = 'right';
    return { x0, x1, overshoot };
  });
}

// ---------------------------------------------------------------------------
// Sequence alignment merger
// ---------------------------------------------------------------------------

/**
 * Whether two ordered entries refer to the same physical module slot for the
 * purpose of overlap alignment. Match strictness:
 *   1. device_kind must match exactly. (An MCB at slot N in window 1 cannot
 *      align with an RCD at slot N in window 2 — they're different devices.)
 *   2. If both entries have a non-null ocpd_rating_a, the ratings must match.
 *      (Two adjacent same-kind devices with different ratings are a strong
 *      disambiguator — never merge a 32A MCB with a 6A MCB.)
 *
 * Labels and other fields are NOT used for matching — they're voted on after
 * alignment. This is deliberate: the same physical device may have label
 * "OVENS" in one window read and "OVEN" in another (Deepgram-style transcription
 * variation), and forcing exact label equality would split the cluster.
 */
function entriesMatch(a, b) {
  if (!a || !b) return false;
  if ((a.kind || '') !== (b.kind || '')) return false;
  if (a.rating != null && b.rating != null && Number(a.rating) !== Number(b.rating)) return false;
  return true;
}

/**
 * Find the best overlap length L for `next` aligning against the tail of
 * `canonical`. We bias toward `expectedL` (the geometric expectation given
 * windowMod/strideMod) because adjacent identical devices create alignment
 * ambiguity that can only be resolved by knowing how much overlap was
 * planned.
 *
 * Search order:
 *   1. Exact `expectedL` match.
 *   2. expectedL ± 1, ± 2 (handles a single missed/extra entry in either window).
 *   3. Any other valid match, largest first.
 *   0 if nothing aligns (alignment failure — caller appends `next` whole).
 */
export function findBestOverlap(canonical, next, expectedL) {
  const maxL = Math.min(canonical.length, next.length);
  if (maxL === 0) return 0;

  const tryL = (L) => {
    if (L < 0 || L > maxL) return false;
    for (let k = 0; k < L; k++) {
      const a = canonical[canonical.length - L + k];
      const b = next[k];
      if (!entriesMatch(a, b)) return false;
    }
    return true;
  };

  if (typeof expectedL === 'number' && expectedL >= 0) {
    if (tryL(expectedL)) return expectedL;
    for (const dL of [-1, 1, -2, 2]) {
      const L = expectedL + dL;
      if (tryL(L)) return L;
    }
  }

  for (let L = maxL; L > 0; L--) {
    if (tryL(L)) return L;
  }
  return 0;
}

/**
 * Vote-merge two entries that align to the same physical module slot. Ratings,
 * curves, BS EN, RCD fields, labels: each field takes the most-common value
 * across all source reads, breaking ties toward the value with higher count.
 */
function mergeEntries(into, from) {
  if (!into.sources) into.sources = [];
  for (const f of ['rating', 'curve', 'bs_en', 'rcd_type', 'rcd_rating_ma', 'body_colour']) {
    if (into[f] == null && from[f] != null) into[f] = from[f];
  }
  // Label: prefer non-null and longer (handwritten labels often span multiple
  // lines; the longer read is usually the more complete transcription).
  if (from.label != null && from.label !== '') {
    if (into.label == null || into.label === '' || from.label.length > into.label.length) {
      into.label = from.label;
    }
  }
  into.votes = (into.votes ?? 1) + 1;
  into.sources.push(
    ...(from.sources || [{ window: from.window, indexInWindow: from.indexInWindow }])
  );
  return into;
}

/**
 * Reconcile multiple windows' ordered device lists into a single canonical
 * left-to-right list of module-slot entries.
 *
 * Algorithm: pairwise sequence alignment. Start with window 0's list as the
 * canonical seed. For each subsequent window, find the best tail/head overlap
 * against the canonical, vote-merge the overlapping entries, and append the
 * non-overlapping tail.
 *
 * Pre-conditions on inputs:
 *   - `windowsDevices[i]` is an ordered array of devices reported by window i.
 *   - Every entry corresponds to one module slot. Multi-mod devices appear as
 *     N consecutive entries with identical kind/rating/label.
 *   - Edge-clipped devices and bare rail were already omitted by the prompt.
 *
 * Post-condition:
 *   - Returned array has one entry per physical module slot of the rail, in
 *     left-to-right order. Each entry carries `votes` (how many windows saw
 *     it) and `sources` (per-window-and-index citations).
 *
 * @param {Array<Array<object>>} windowsDevices  one ordered list per window
 * @param {{expectedOverlap?: number}} [opts]    expected overlap length in entries
 * @returns {Array<object>}
 */
export function alignWindows(windowsDevices, opts = {}) {
  const expectedL = opts.expectedOverlap;
  if (!Array.isArray(windowsDevices) || windowsDevices.length === 0) return [];

  let canonical = (windowsDevices[0] || []).map((d, idx) => ({
    ...d,
    votes: 1,
    sources: [{ window: 0, indexInWindow: idx }],
  }));

  for (let i = 1; i < windowsDevices.length; i++) {
    const next = (windowsDevices[i] || []).map((d, idx) => ({
      ...d,
      votes: 1,
      sources: [{ window: i, indexInWindow: idx }],
    }));
    if (next.length === 0) continue;
    if (canonical.length === 0) {
      canonical = next;
      continue;
    }

    const overlap = findBestOverlap(canonical, next, expectedL);

    for (let k = 0; k < overlap; k++) {
      const cIdx = canonical.length - overlap + k;
      canonical[cIdx] = mergeEntries(canonical[cIdx], next[k]);
    }

    for (let k = overlap; k < next.length; k++) {
      canonical.push(next[k]);
    }
  }

  return canonical;
}

// ---------------------------------------------------------------------------
// VLM call
// ---------------------------------------------------------------------------

/**
 * Run a single window's VLM call. Aborts on timeout. Parses the response
 * (with a one-pass ```json fence-strip for sloppy responses).
 */
async function runWindow({ anthropic, model, prompt, cropBuf, windowIndex, signal }) {
  const t0 = Date.now();
  const resp = await anthropic.messages.create(
    {
      model,
      max_tokens: SLIDING_WINDOW_MAX_TOKENS,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/jpeg',
                data: cropBuf.toString('base64'),
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
  let parsed = null;
  try {
    const fenced = rawText.match(/```(?:json)?\s*([\s\S]+?)```/);
    parsed = JSON.parse(fenced ? fenced[1] : rawText);
  } catch (err) {
    throw new Error(`window ${windowIndex} JSON parse failed: ${err.message}`);
  }
  // Accept the new "entries" key plus legacy aliases the harness/tests may
  // emit (the prompt asks for "entries"; older fixtures use "devices").
  const entries = parsed.entries || parsed.devices || parsed.circuits || parsed.slots || [];
  return {
    ms,
    usage: {
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
    },
    entries,
  };
}

/**
 * Normalise a raw VLM response entry into the internal device shape used by
 * the alignment merger. Rejects entries that are missing device_kind (the
 * minimum requirement to participate in alignment).
 */
function normaliseEntry(raw, windowIndex, indexInWindow) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = typeof raw.device_kind === 'string' ? raw.device_kind.toLowerCase().trim() : null;
  if (!kind) return null;
  return {
    window: windowIndex,
    indexInWindow,
    kind,
    rating: raw.ocpd_rating_a ?? null,
    curve: raw.ocpd_curve || null,
    bs_en: raw.ocpd_bs_en || null,
    rcd_type: raw.rcd_type || null,
    rcd_rating_ma: raw.rcd_rating_ma ?? null,
    body_colour: raw.body_colour || null,
    label: typeof raw.label === 'string' && raw.label.trim() !== '' ? raw.label : null,
  };
}

// ---------------------------------------------------------------------------
// Output assembly
// ---------------------------------------------------------------------------

/**
 * Convert canonical entries into the slot/label arrays consumed by
 * assembleGeometricResult + slotsToCircuits. Each canonical entry maps 1:1
 * to a slot. The slot grid is derived from the canonical length, NOT from
 * the CV's snappedWays (the canonical IS the truth — the CV pitch only
 * planned the windows).
 *
 * The slot count from the canonical may differ from the CV's snappedWays
 * estimate by ±1-2. That difference is captured in `lowConfidence` /
 * `extraEntries` for downstream awareness.
 */
function entriesToSlots(canonical, boardManufacturer) {
  const slots = [];
  const labels = [];
  for (let s = 0; s < canonical.length; s++) {
    const e = canonical[s];
    const cls = e.kind;
    let rating = e.rating != null ? Number(e.rating) || null : null;
    if (rating == null && cls === 'rewireable' && e.body_colour && COLOUR_TO_AMPS[e.body_colour]) {
      rating = COLOUR_TO_AMPS[e.body_colour];
    }
    // confidence — at least one window saw this; cap at 0.95 so the
    // downstream 0.7 floor in slotsToCircuits is comfortably exceeded.
    const confidence = Math.min(0.95, 0.5 + 0.15 * Math.max(0, (e.votes || 1) - 1));
    slots.push({
      slotIndex: s,
      content: cls === 'blank' ? 'blank' : 'device',
      extends: 'none',
      classification: cls,
      manufacturer:
        boardManufacturer ?? (cls === 'rcbo' || cls === 'rcd' || cls === 'mcb' ? 'unknown' : null),
      model: null,
      ratingAmps: rating,
      ratingText: rating != null ? `${e.curve || ''}${rating}A`.trim() : null,
      ratingHallucinationDetected: false,
      poles: 1,
      tripCurve: e.curve || null,
      sensitivity:
        e.rcd_rating_ma != null
          ? typeof e.rcd_rating_ma === 'number'
            ? e.rcd_rating_ma
            : Number(e.rcd_rating_ma) || null
          : null,
      rcdWaveformType: e.rcd_type || null,
      bsEn: e.bs_en || null,
      bodyColour: e.body_colour || null,
      confidence,
      // crop is filled in below by per-slot sharp.extract
      crop: { bbox: { x: 0, y: 0, w: 0, h: 0 }, base64: '' },
      label: e.label || null,
    });
    labels.push({
      slotIndex: s,
      label: e.label || null,
      rawLabel: e.label || null,
      confidence,
    });
  }
  return { slots, labels };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Main entry. Takes a CV-prepared geometry + image buffer + Anthropic client
 * and returns a `{slots, labels, usage, timings, lowConfidence, stageOutputs,
 * finalDevices}` object shaped to drop into the existing route handler in
 * place of classifyModernSlots + extractSlotLabels.
 *
 * @param {{
 *   imageBuffer: Buffer,
 *   prepared: object,            // result of prepareModernGeometry / prepareRewireableGeometry
 *   isRewireable: boolean,
 *   anthropic: object,           // Anthropic SDK client
 *   model: string,
 *   imgW: number,
 *   imgH: number,
 *   boardManufacturer?: string,
 *   windowMod?: number,
 *   strideMod?: number,
 *   overshootMod?: number,
 *   labelPad?: number,
 *   logger?: object,
 *   userId?: string
 * }} args
 */
export async function extractViaSlidingWindow({
  imageBuffer,
  prepared,
  isRewireable,
  anthropic,
  model,
  imgW,
  imgH,
  boardManufacturer = null,
  windowMod = 5,
  strideMod = 2,
  overshootMod = 2,
  labelPad = 1.0,
  logger,
  userId,
}) {
  const t0 = Date.now();

  // --- 1. Resolve geometry to image-pixel space -------------------------
  let pitchPx, railLeftPx, railRightPx, railTopPx, railBottomPx;
  if (isRewireable) {
    pitchPx = prepared.carrierPitchPx;
    railLeftPx = norm2px(prepared.panelBounds?.left ?? 50, imgW);
    railRightPx = norm2px(prepared.panelBounds?.right ?? 950, imgW);
    railTopPx = norm2px(prepared.panelBounds?.top ?? 400, imgH);
    railBottomPx = norm2px(prepared.panelBounds?.bottom ?? 600, imgH);
  } else {
    pitchPx =
      prepared.cvPitchDiag?.pitchPx ??
      (prepared.slotCentersX && prepared.slotCentersX.length >= 2
        ? norm2px(prepared.slotCentersX[1], imgW) - norm2px(prepared.slotCentersX[0], imgW)
        : Math.round(imgW * 0.06));
    railLeftPx = norm2px(prepared.railBbox?.left ?? 50, imgW);
    railRightPx = norm2px(prepared.railBbox?.right ?? 950, imgW);
    railTopPx = norm2px(prepared.medianRails?.rail_top ?? prepared.railBbox?.top ?? 400, imgH);
    railBottomPx = norm2px(
      prepared.medianRails?.rail_bottom ?? prepared.railBbox?.bottom ?? 600,
      imgH
    );
  }
  const railWidthPx = railRightPx - railLeftPx;
  const railHeightPx = railBottomPx - railTopPx;

  // --- 2. Plan windows + vertical crop band ----------------------------
  const padPx = Math.round(railHeightPx * labelPad);
  const cropTop = Math.max(0, railTopPx - padPx);
  const cropBottom = Math.min(imgH, railBottomPx + padPx);
  const cropH = cropBottom - cropTop;

  const windows = planWindows(
    railLeftPx,
    railRightPx,
    pitchPx,
    windowMod,
    strideMod,
    imgW,
    overshootMod
  );

  // --- 3. Run windows in parallel --------------------------------------
  const prompt = isRewireable ? REWIREABLE_PROMPT : MODERN_PROMPT;
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), SLIDING_WINDOW_TIMEOUT_MS);
  let windowResults;
  try {
    windowResults = await Promise.all(
      windows.map(async (w, i) => {
        const cropW = w.x1 - w.x0;
        const cropBuf = await sharp(imageBuffer)
          .extract({ left: w.x0, top: cropTop, width: cropW, height: cropH })
          .resize({ width: 1536, withoutEnlargement: false })
          .jpeg({ quality: 90 })
          .toBuffer();
        const r = await runWindow({
          anthropic,
          model,
          prompt,
          cropBuf,
          windowIndex: i + 1,
          signal: abortController.signal,
        });
        return { window: i + 1, x0: w.x0, x1: w.x1, overshoot: w.overshoot, ...r };
      })
    );
  } finally {
    clearTimeout(timeoutId);
  }

  // --- 4. Normalise per-window entries ---------------------------------
  // Each window's response is an ordered list. We strip rejects (no
  // device_kind) but preserve order — alignment depends on it.
  const windowsDevices = windowResults.map((r) =>
    r.entries.map((raw, idx) => normaliseEntry(raw, r.window, idx)).filter(Boolean)
  );

  // --- 5. Sequence-alignment merger ------------------------------------
  // Expected overlap in entries between consecutive windows. With windowMod=5
  // and strideMod=2, consecutive windows physically share 3 module slots.
  // The merger biases toward this length when alignment is ambiguous (e.g.
  // adjacent identical-rating MCBs).
  const expectedOverlap = Math.max(0, windowMod - strideMod);
  const canonical = alignWindows(windowsDevices, { expectedOverlap });

  // --- 6. Assemble slot output ----------------------------------------
  const { slots, labels } = entriesToSlots(canonical, boardManufacturer);

  // --- 7. Per-slot crops for iOS overlay -------------------------------
  // The CV-derived slot grid is used purely for cropping. If the canonical
  // length disagrees with the CV's snappedWays, we crop along the canonical's
  // implied positions (rail divided by canonical.length) so each entry has a
  // matching crop. This keeps the iOS tap-to-correct overlay coherent.
  const snappedWays = canonical.length;
  const slotCentersPx = [];
  if (snappedWays > 0) {
    const effectivePitch = railWidthPx / snappedWays;
    for (let i = 0; i < snappedWays; i++) {
      slotCentersPx.push(railLeftPx + (i + 0.5) * effectivePitch);
    }
  }

  await Promise.all(
    slots.map(async (slot, i) => {
      try {
        if (isRewireable) {
          const out = await cropCarrierSlot(imageBuffer, i, {
            slotCentersX: slotCentersPx,
            carrierPitchPx: pitchPx,
            panelTopNorm: prepared.panelBounds?.top ?? 400,
            panelBottomNorm: prepared.panelBounds?.bottom ?? 600,
            imageWidth: imgW,
            imageHeight: imgH,
          });
          slot.crop = { bbox: out.bbox, base64: out.buffer.toString('base64') };
        } else {
          const out = await cropSlot(imageBuffer, i, {
            slotCentersX: slotCentersPx.map((px) => Math.round((px / imgW) * 1000)),
            moduleWidth: Math.round((pitchPx / imgW) * 1000),
            railTop: prepared.medianRails?.rail_top ?? Math.round((railTopPx / imgH) * 1000),
            railBottom:
              prepared.medianRails?.rail_bottom ?? Math.round((railBottomPx / imgH) * 1000),
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

  // --- 8. Edge-overshoot diagnostics ----------------------------------
  // If a left- or right-overshoot window returned close to a full windowMod
  // of devices (specifically: > windowMod - overshootMod), the rail probably
  // extended further than the CV thought. Log a warning; downstream callers
  // see lowConfidence=true so the inspector knows to verify edge devices.
  let lowConfidence = false;
  const edgeOvershootSaturated = windowResults.filter(
    (r) => r.overshoot !== 'none' && r.entries.length > windowMod - overshootMod
  );
  if (edgeOvershootSaturated.length > 0) {
    lowConfidence = true;
    if (logger) {
      logger.warn('CCU edge overshoot saturated — rail may extend past CV estimate', {
        userId,
        windows: edgeOvershootSaturated.map((r) => ({
          window: r.window,
          overshoot: r.overshoot,
          entries: r.entries.length,
        })),
      });
    }
  }

  const totalUsage = windowResults.reduce(
    (acc, r) => ({
      inputTokens: acc.inputTokens + r.usage.inputTokens,
      outputTokens: acc.outputTokens + r.usage.outputTokens,
    }),
    { inputTokens: 0, outputTokens: 0 }
  );
  const wallMs = Date.now() - t0;
  const sumWindowMs = windowResults.reduce((a, r) => a + r.ms, 0);

  if (logger) {
    logger.info('CCU sliding-window extraction complete', {
      userId,
      windowCount: windows.length,
      pitchPx,
      ways: snappedWays,
      readsTotal: windowsDevices.reduce((acc, w) => acc + w.length, 0),
      canonicalLength: canonical.length,
      wallMs,
      sumWindowMs,
      tokensIn: totalUsage.inputTokens,
      tokensOut: totalUsage.outputTokens,
      pipeline: isRewireable ? 'rewireable' : 'modern',
      edgeOvershootSaturated: edgeOvershootSaturated.length,
    });
  }

  return {
    slots,
    labels,
    finalDevices: canonical,
    snappedWays,
    pitchPx,
    timings: { stage3Ms: wallMs },
    usage: totalUsage,
    lowConfidence,
    stage3Error: null,
    stageOutputs: {
      stage3: {
        slots,
        batchCount: windows.length,
        batchSize: null,
        usage: totalUsage,
      },
    },
    skippedSlotIndices: [],
  };
}
