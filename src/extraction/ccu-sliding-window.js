/**
 * Sliding-window CCU extraction — production-grade port of the harness
 * at scripts/ccu-sliding-window.mjs (v5c). Replaces the per-slot Stage 3
 * + Stage 4 batch path with a CV-anchored sliding-window VLM pipeline +
 * position-clustered merge.
 *
 * Design summary (full rationale in the harness file's header comment):
 *   - CV (prepareModernGeometry / prepareRewireableGeometry) supplies
 *     pitchPx + rail bbox. Both are reliable from line-fitting +
 *     autocorrelation. The CV's `moduleCount` is INTENTIONALLY IGNORED —
 *     count comes from the cluster output, not from the CV.
 *   - Windows are planned in PIXEL space: each window is `windowMod ×
 *     pitchPx` wide, advancing by `strideMod × pitchPx`. Default 5-mod
 *     wide, 2-mod stride → 3-mod overlap.
 *   - The VLM is asked for a FLEXIBLE list of devices visible in each
 *     crop — could be 3, 4, 5, 6, 7, however many it sees. Each device
 *     returns a `position_pct` 0..1 telling us the fraction of the crop
 *     width where its centre lies. The harness converts that to an
 *     image-space X.
 *   - Position-based clustering: every cross-window read of the same
 *     physical device lands at approximately the same image X. Reads
 *     cluster when |Δx| < 0.7 × pitchPx AND kinds are compatible.
 *     Labels are NOT used for clustering — they're voted on per cluster.
 *   - Output is reshaped into the same `{slots, labels, usage, timings}`
 *     shape that classifyModernSlots + extractSlotLabels produced, so
 *     the existing post-merge enrichment chain (assembleGeometricResult,
 *     slotsToCircuits, applyRcdTypeLookup, applyBsEnFallback,
 *     normaliseCircuitLabels, lookupMissingRcdTypes,
 *     flagRcdWaveformOutliers) works UNCHANGED on the result.
 *
 * Why no per-slot bleed: every slot sits well inside ≥1 window with no
 * edge clipping, so the 2-pole-neighbour-bleed bug class (Ovens RCBO
 * next to a 2-pole main switch losing its rating because Stage 3 was
 * looking at a 2.2× pitch crop that captured half the main switch) is
 * structurally impossible.
 *
 * Why no count-from-CV bug: the cluster count is what comes out of the
 * VLM reads, so even if the CV under-counts ways by 1, the sliding
 * window recovers the true device count.
 */
import sharp from 'sharp';
import { cropSlot } from './ccu-geometric.js';
import { cropCarrierSlot } from './ccu-geometric-rewireable.js';

const SLIDING_WINDOW_TIMEOUT_MS = Number(process.env.CCU_SLIDING_WINDOW_TIMEOUT_MS || 60_000);
const SLIDING_WINDOW_MAX_TOKENS = 2048;

// Wylex BS 3036 colour-code lookup for rewireable carriers. Only used
// when the VLM left ocpd_rating_a null on a rewireable.
const COLOUR_TO_AMPS = {
  white: 5,
  blue: 15,
  yellow: 20,
  red: 30,
  green: 45,
};

const norm2px = (v, dim) => Math.round((v / 1000) * dim);

const MODERN_PROMPT = `You are inspecting a horizontal section of a UK consumer unit's main DIN rail.

The image shows circuit-protective devices (MCBs, RCBOs, RCDs, blanking plates, main switches, SPDs) with a label strip above and/or below the rail. Identify EVERY device whose body is FULLY VISIBLE in this crop, in strict left-to-right order. Skip devices clipped at the left or right edge — the next window will capture them.

Return as many devices as you see — could be 3, 4, 5, 6, 7, or more. Don't be constrained by any expected count.

For multi-module devices (a 2-pole main switch or 2-module RCD spans two adjacent module slots): return ONE entry for the whole device. Indicate its width via \`width_modules\` (1 for normal MCB/RCBO/SPD, 2 for typical 2-pole main switch / 2-module RCD).

For each device:
- position_pct: NUMBER between 0.0 and 1.0 — the fraction of THE IMAGE WIDTH where this device's CENTRE lies (left edge=0.0, right edge=1.0). Be precise: the device's geometric centre.
- width_modules: 1 or 2 (rarely 3 or 4 for very wide isolators).
- device_kind: one of "mcb", "rcbo", "rcd", "main_switch", "spd", "blank"
- label: circuit name from the strip directly aligned with this device's CENTRE — copy VERBATIM (preserve exact spelling, including handwritten quirks). Do NOT aggregate or paraphrase from neighbouring devices. null if blank/unreadable.

DEVICE FACE FIELDS (null if not clearly readable — never guess):
- ocpd_rating_a: integer amperage from the device face (e.g. 32 for "B32A").
- ocpd_curve: "B", "C", or "D" for MCBs/RCBOs.
- ocpd_bs_en: e.g. "BS EN 61009", "BS EN 60898", "BS EN 61008", "BS EN 60947-3".
- rcd_type: "AC", "A", "F", or "B" — ONLY if the trip classification is explicitly stated as TEXT on the device. The international AC waveform symbol alone does NOT mean Type AC; many Type A devices show that symbol. If unsure, return null.
- rcd_rating_ma: 30, 100, 300, or 500.

Return STRICT JSON only — no markdown, no commentary:
{"devices":[{"position_pct":0.1,"width_modules":1,"device_kind":"rcbo",...},...]}`;

const REWIREABLE_PROMPT = `You are inspecting a horizontal section of a UK rewireable (bakelite) consumer unit. This is NOT a DIN-rail board — these are pull-out fuse carriers (BS 3036) or HBC cartridge fuses (BS 1361/BS 88-2) sitting in moulded sockets on a flat panel. Each carrier has a red pull-tab at the top.

Identify EVERY device whose body is FULLY VISIBLE in this crop, in strict left-to-right order. Skip devices clipped at the left or right edge — the next window will capture them.

Return as many devices as you see — could be 3, 4, 5, 6, 7, or more. Don't be constrained by any expected count.

Most rewireable devices are single-module. Some boards have a separate main switch / switch-fuse to one side of the carrier row that may span 2 modules (\`width_modules: 2\`).

For each device:
- position_pct: NUMBER between 0.0 and 1.0 — fraction of IMAGE WIDTH where this device's CENTRE lies. Be precise.
- width_modules: 1 normally; 2 for a wide separate main switch.
- device_kind: one of "rewireable", "cartridge", "main_switch", "blank"
  • rewireable = BS 3036 pull-out carrier with rewireable fuse wire inside (Wylex/MEM/Crabtree/Bill domestic).
  • cartridge  = pull-out carrier holding an HBC cartridge fuse (BS 1361 or BS 88-2 commercial).
  • blank      = empty socket or blanking plate, no carrier fitted.
- body_colour: colour of the CARRIER BODY *below* the red pull-tab. One of "white","blue","yellow","red","green","unknown". CRITICAL: every Wylex carrier has a RED PULL-TAB — that's the lift handle, NOT the rating. Look at the body below the pull-tab. If the body itself is red below the tab, it IS a 30 A red carrier. null for cartridge / main_switch / blank.
- ocpd_rating_a: integer amperage. For cartridge fuses, read the rating printed on the carrier face. For rewireable, you may leave this null — we will derive it from body_colour via the Wylex code: white=5A, blue=15A, yellow=20A, red=30A, green=45A.
- ocpd_bs_en: "BS 3036" for rewireable, "BS 1361" for cartridge domestic, "BS 88-2" for cartridge commercial, "BS EN 60947-3" for main_switch. null if unsure.
- label: circuit name from the strip / inspector handwriting directly aligned with this carrier's CENTRE — copy VERBATIM. null if blank/unreadable.

Return STRICT JSON only — no markdown, no commentary:
{"devices":[{"position_pct":0.1,"width_modules":1,"device_kind":"rewireable","body_colour":"red",...},...]}`;

/**
 * Plan window pixel ranges along the rail. Windows are `windowMod ×
 * pitchPx` wide, advancing by `strideMod × pitchPx`. A right-anchored
 * window is added if the natural-stride sequence under-covers the
 * rightmost edge.
 *
 * @param {number} railLeftPx
 * @param {number} railRightPx
 * @param {number} pitchPx
 * @param {number} windowMod  — default 5
 * @param {number} strideMod  — default 2
 * @param {number} imgW
 * @returns {Array<{x0:number,x1:number}>}
 */
export function planWindows(railLeftPx, railRightPx, pitchPx, windowMod, strideMod, imgW) {
  const windowPx = Math.round(windowMod * pitchPx);
  const stridePx = Math.round(strideMod * pitchPx);
  const windows = [];
  for (let x0 = railLeftPx; x0 + windowPx <= railRightPx + pitchPx * 0.3; x0 += stridePx) {
    windows.push({
      x0: Math.max(0, Math.round(x0)),
      x1: Math.min(imgW, Math.round(x0 + windowPx)),
    });
  }
  if (windows.length === 0 || windows[windows.length - 1].x1 < railRightPx - pitchPx * 0.3) {
    windows.push({
      x0: Math.max(0, Math.round(railRightPx - windowPx)),
      x1: Math.min(imgW, railRightPx),
    });
  }
  // Dedupe: the right-anchor may match the last natural window's x0
  // within < 0.3 × pitch (we'd be running the same VLM call twice).
  const dedup = [];
  for (const w of windows) {
    if (dedup.length === 0 || Math.abs(dedup[dedup.length - 1].x0 - w.x0) > pitchPx * 0.3) {
      dedup.push(w);
    }
  }
  return dedup;
}

function fingerprintCompatible(a, b) {
  const aKind = (a.kind || '').toLowerCase();
  const bKind = (b.kind || '').toLowerCase();
  // Different non-null kinds are incompatible (e.g. main_switch vs mcb at the
  // same x — definitely different devices).
  if (aKind && bKind && aKind !== bKind) return false;
  return true;
}

function mostCommon(values) {
  const counts = new Map();
  for (const v of values) {
    if (v == null || v === '') continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

// Same patterns as MAIN_SWITCH_LABEL_PATTERNS in src/routes/extraction.js.
// Duplicated locally to keep ccu-sliding-window.js free of route-handler
// imports — these two patterns + the routes-side rescue must move together.
const MAIN_SWITCH_LABEL_PATTERNS_LOCAL = [
  /^\s*main\s*switch\s*$/i,
  /^\s*main\s*isolator\s*$/i,
  /^\s*main\s*isol\.?\s*$/i,
  /^\s*mains\s*switch\s*$/i,
  /^\s*switch\s*disconnector\s*$/i,
  /^\s*isolator\s*$/i,
];

function labelLooksLikeMainSwitchLocal(label) {
  if (typeof label !== 'string' || label.trim() === '') return false;
  return MAIN_SWITCH_LABEL_PATTERNS_LOCAL.some((p) => p.test(label));
}

function bestLabel(labels) {
  const valid = labels.filter((l) => l && String(l).trim().length > 0);
  if (valid.length === 0) return null;
  // Most common; tie-break on length (longer = more info).
  const counts = new Map();
  for (const l of valid) counts.set(l, (counts.get(l) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0];
}

/**
 * Cluster cross-window reads into one entry per physical device.
 *
 * Two reads are the same physical device when:
 *   - Their image-space X positions are within 0.7 × pitchPx of each
 *     other (a bit looser than half-pitch to absorb VLM position-
 *     estimate noise, but tight enough that adjacent slots one full
 *     pitch apart never merge — which would wrongly collapse same-
 *     name adjacent circuits e.g. "LIGHTING" / "LIGHTING").
 *   - Their kinds are compatible (a 2-pole main_switch and a 1-pole
 *     MCB at similar positions are different devices).
 *   - Labels are NOT required to match — the VLM frequently misreads
 *     adjacent strip labels (HOB → UTILITY, OVENS → HOB), so position
 *     + kind dominate and the label is voted on per cluster.
 *
 * @param {Array<Object>} allReads — collected from all windows
 * @param {number} pitchPx
 * @returns {Array<{reads:Array<Object>}>}
 */
export function clusterReads(allReads, pitchPx) {
  const TOLERANCE = pitchPx * 0.7;
  const sorted = [...allReads].sort((a, b) => a.xImage - b.xImage);
  const clusters = [];
  for (const r of sorted) {
    const last = clusters[clusters.length - 1];
    if (last) {
      const lastMeanX = last.reads.reduce((s, x) => s + x.xImage, 0) / last.reads.length;
      if (Math.abs(r.xImage - lastMeanX) < TOLERANCE && fingerprintCompatible(r, last.reads[0])) {
        last.reads.push(r);
        continue;
      }
    }
    clusters.push({ reads: [r] });
  }
  return clusters;
}

/**
 * Merge adjacent main_switch clusters that the VLM reported as separate
 * 1-module devices.
 *
 * A 2-pole or 3-pole isolator's mechanically-linked toggle handles can each
 * present like a single-module main switch to the VLM — particularly when
 * no single window cleanly captures the whole device. clusterReads keeps
 * them as separate clusters because their image-X positions are ≥ 1 pitch
 * apart (the 0.7 × pitch tolerance exists to stop adjacent same-name
 * circuits like "LIGHTING / LIGHTING" from collapsing into one).
 *
 * Repro: extraction 1778043419386-zmidoj (Elucian CU2MS100, 2026-05-06).
 * The 2-pole isolator was read as two widthMod=1 main_switch devices, one
 * per visible toggle. Snapping placed both as main_switch slots side-by-side
 * (slots 12 and 13). Downstream `trimSpuriousMainSwitchClusterRuns` saw a
 * 2-slot run with poles=[1,1], voted expected=1, demoted slot 12 to
 * 'unknown' — and it leaked into the schedule as circuit #1 "MAINS SWITCH".
 *
 * Restricted to main_switch only:
 *   - Genuine adjacent main_switch devices are vanishingly rare on UK
 *     domestic boards (one isolator per board is the norm). Even on the
 *     edge case of a dual-isolator board, an over-merge only hides one
 *     main_switch from the iOS overlay — never produces a wrong circuit
 *     row, because main_switch slots aren't emitted as circuits.
 *   - Adjacent RCDs DO occur on split-load boards (bedroom RCD next to
 *     kitchen RCD), so an analogous RCD-merge would be unsafe. Multi-module
 *     RCDs are handled downstream by the `prevWasRcd` gap-fill in
 *     slotsToCircuits which combines two adjacent rcd slots into one
 *     rcdEntry without changing slot count.
 *
 * The merged cluster carries `mergedSpan` (count of constituent clusters)
 * so the widthMod calculation downstream can use the larger of the
 * VLM-reported widthMod and the merged span — i.e. a correctly-reported
 * widthMod=2 single cluster keeps widthMod=2, but two merged widthMod=1
 * clusters become widthMod=2.
 */
export function mergeAdjacentMainSwitchClusters(clusters, pitchPx) {
  if (!Array.isArray(clusters) || clusters.length === 0) return clusters;
  const TOLERANCE = pitchPx * 1.5;
  const merged = [];
  for (const c of clusters) {
    const last = merged[merged.length - 1];
    if (last) {
      const lastKind = mostCommon(last.reads.map((r) => r.kind));
      const currKind = mostCommon(c.reads.map((r) => r.kind));
      if (lastKind === 'main_switch' && currKind === 'main_switch') {
        // Compare to the LAST READ's xImage (rightmost edge of the
        // already-merged cluster), not the cluster mean — the mean drifts
        // as we fold more clusters in, which would let a 3-cluster chain
        // miss the third merge by a hair when the centroid sits midway
        // between the second and third devices.
        const lastRightX = Math.max(...last.reads.map((r) => r.xImage));
        const currLeftX = Math.min(...c.reads.map((r) => r.xImage));
        if (currLeftX - lastRightX < TOLERANCE) {
          // Label compatibility gate: refuse the merge when there is
          // POSITIVE evidence one of the clusters is actually a real
          // circuit row (Stage 3's per-slot VLM has a documented failure
          // mode where it mis-classifies an adjacent RCBO as main_switch
          // — see trimSpuriousMainSwitchClusterRuns in extraction.js).
          // If the strip label clearly says "Ovens" or "Cooker", that's
          // not the other half of the isolator. Both-null is allowed
          // because handwritten or illegible strips are common; both-
          // main-switch-shaped is the bug case we're fixing.
          const lastLabel = bestLabel(last.reads.map((r) => r.label));
          const currLabel = bestLabel(c.reads.map((r) => r.label));
          const lastIsCircuitName =
            typeof lastLabel === 'string' &&
            lastLabel.trim() !== '' &&
            !labelLooksLikeMainSwitchLocal(lastLabel);
          const currIsCircuitName =
            typeof currLabel === 'string' &&
            currLabel.trim() !== '' &&
            !labelLooksLikeMainSwitchLocal(currLabel);
          if (!lastIsCircuitName && !currIsCircuitName) {
            last.reads.push(...c.reads);
            last.mergedSpan = (last.mergedSpan ?? 1) + 1;
            continue;
          }
        }
      }
    }
    merged.push({ ...c, mergedSpan: c.mergedSpan ?? 1 });
  }
  return merged;
}

/**
 * Run a single window's VLM call. Aborts on timeout. Parses the response
 * (with one ```json fence-strip pass for sloppy responses) and returns
 * normalised devices + usage counters.
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
  return {
    ms,
    usage: {
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
    },
    devices: parsed.devices || parsed.circuits || parsed.slots || [],
  };
}

/**
 * Main entry. Takes a CV-prepared geometry + image buffer + Anthropic
 * client and returns a `{slots, labels, usage, timings, lowConfidence,
 * stageOutputs, finalDevices}` object shaped to drop into the existing
 * route handler in place of `classifyModernSlots` + `extractSlotLabels`.
 *
 * @param {{
 *   imageBuffer: Buffer,
 *   prepared: object,            // result of prepareModernGeometry / prepareRewireableGeometry
 *   isRewireable: boolean,
 *   anthropic: object,           // Anthropic SDK client
 *   model: string,
 *   imgW: number,
 *   imgH: number,
 *   boardManufacturer?: string,  // from Stage 1b classifier; stamped onto every slot for outlier-detection compatibility
 *   windowMod?: number,
 *   strideMod?: number,
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
  labelPad = 1.0,
  logger,
  userId,
}) {
  const t0 = Date.now();

  // --- 1. Resolve geometry to image-pixel space -------------------------
  // Modern: slotCentersX / railBbox / medianRails are normalised 0..1000;
  //         cvPitchDiag.pitchPx is image px.
  // Rewireable: slotCentersX + carrierPitchPx are pixels; panelBounds is
  //         normalised 0..1000.
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

  const windows = planWindows(railLeftPx, railRightPx, pitchPx, windowMod, strideMod, imgW);

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
        return { window: i + 1, x0: w.x0, x1: w.x1, ...r };
      })
    );
  } finally {
    clearTimeout(timeoutId);
  }

  // --- 4. Convert each device's position_pct → image-space X ------------
  const allReads = [];
  for (const r of windowResults) {
    const cropW = r.x1 - r.x0;
    for (const d of r.devices) {
      const pct = Number(d.position_pct);
      if (!Number.isFinite(pct) || pct < 0 || pct > 1) continue;
      const xImage = r.x0 + pct * cropW;
      allReads.push({
        window: r.window,
        xImage,
        widthMod: Number(d.width_modules) || 1,
        kind: d.device_kind || null,
        rating: d.ocpd_rating_a ?? null,
        curve: d.ocpd_curve || null,
        bs_en: d.ocpd_bs_en || null,
        rcd_type: d.rcd_type || null,
        rcd_rating_ma: d.rcd_rating_ma ?? null,
        body_colour: d.body_colour || null,
        label: d.label || null,
      });
    }
  }

  // --- 5. Cluster reads → final devices --------------------------------
  const rawClusters = clusterReads(allReads, pitchPx);
  // Merge a 2-pole / 3-pole isolator that the VLM split into adjacent
  // 1-module main_switch reads back into one device. See function-level
  // comment on mergeAdjacentMainSwitchClusters for the failure mode.
  const clusters = mergeAdjacentMainSwitchClusters(rawClusters, pitchPx);

  // Per-cluster consensus voting + mean image X.
  const finalDevices = clusters.map((c) => {
    const meanX = c.reads.reduce((s, r) => s + r.xImage, 0) / c.reads.length;
    let rating = mostCommon(c.reads.map((r) => r.rating));
    const colour = mostCommon(c.reads.map((r) => r.body_colour));
    const kind = mostCommon(c.reads.map((r) => r.kind));
    if (rating == null && kind === 'rewireable' && colour && COLOUR_TO_AMPS[colour]) {
      rating = COLOUR_TO_AMPS[colour];
    }
    // mergedSpan is set when mergeAdjacentMainSwitchClusters folded multiple
    // clusters into this one (each with widthMod=1). Keep the larger of the
    // VLM-voted widthMod and the merged span — a single cluster that
    // correctly reported widthMod=2 stays widthMod=2.
    const widthModFromReads = mostCommon(c.reads.map((r) => r.widthMod)) || 1;
    const widthMod = Math.max(c.mergedSpan ?? 1, widthModFromReads);
    return {
      xImage: Math.round(meanX),
      widthMod,
      kind,
      rating,
      curve: mostCommon(c.reads.map((r) => r.curve)),
      bs_en: mostCommon(c.reads.map((r) => r.bs_en)),
      rcd_type: mostCommon(c.reads.map((r) => r.rcd_type)),
      rcd_rating_ma: mostCommon(c.reads.map((r) => r.rcd_rating_ma)),
      body_colour: colour,
      label: bestLabel(c.reads.map((r) => r.label)),
      votes: c.reads.length,
    };
  });

  // --- 6. Map devices to a canonical slot grid -------------------------
  // Snap each device's centre X to the nearest slot in a (railLeftPx,
  // railRightPx, pitchPx)-defined grid. The grid has `Math.round(railWidth/pitch)`
  // slots; multi-module devices occupy `widthMod` consecutive slots
  // starting at the device's snap-to-leftmost-slot.
  const snappedWays = Math.max(1, Math.round(railWidthPx / pitchPx));
  const slotCentersPx = [];
  for (let i = 0; i < snappedWays; i++) {
    slotCentersPx.push(railLeftPx + (i + 0.5) * pitchPx);
  }
  function snapToSlot(xImage, widthMod) {
    // For a 2-mod device, its centre sits between two slot centres; we
    // place its leftmost slot at the slot whose centre is < xImage by
    // ~pitchPx/2. For 1-mod, snap to nearest slot centre.
    if (widthMod >= 2) {
      // Centre falls between slots leftmost+0 and leftmost + (widthMod-1).
      // Compute leftmost = round((xImage - (widthMod-1)/2 * pitch - railLeft)/pitch - 0.5)
      const leftmostCenter = xImage - ((widthMod - 1) / 2) * pitchPx;
      let i = Math.round((leftmostCenter - railLeftPx) / pitchPx - 0.5);
      i = Math.max(0, Math.min(snappedWays - widthMod, i));
      return i;
    }
    let i = Math.round((xImage - railLeftPx) / pitchPx - 0.5);
    i = Math.max(0, Math.min(snappedWays - 1, i));
    return i;
  }

  // Sort by xImage and snap. Resolve any collisions by preferring higher
  // vote count, then larger widthMod.
  finalDevices.sort((a, b) => a.xImage - b.xImage);
  const slotOwner = new Array(snappedWays).fill(null);
  const placedDevices = [];
  for (const d of finalDevices) {
    const start = snapToSlot(d.xImage, d.widthMod || 1);
    const cols = d.widthMod || 1;
    let conflict = false;
    for (let s = start; s < start + cols && s < snappedWays; s++) {
      if (slotOwner[s] && slotOwner[s].votes >= d.votes) {
        conflict = true;
        break;
      }
    }
    if (conflict) continue;
    for (let s = start; s < start + cols && s < snappedWays; s++) {
      slotOwner[s] = d;
    }
    placedDevices.push({ ...d, startSlot: start, colsUsed: cols });
  }

  // --- 7. Synthesise the slots[] + labels[] arrays in the shape that  --
  // classifyModernSlots / extractSlotLabels would have produced. The
  // existing route-handler flow (assembleGeometricResult, slotsToCircuits,
  // applyRcdTypeLookup, applyBsEnFallback, normaliseCircuitLabels,
  // lookupMissingRcdTypes, flagRcdWaveformOutliers) consumes this shape
  // unchanged.
  //
  // For multi-module devices we replicate the device's data across ALL
  // its slots; slotsToCircuits then handles the de-duplication (e.g. an
  // 'rcd' classification produces one schedule row per pair, and a
  // 'main_switch' is skipped entirely).
  const slots = [];
  const labels = [];

  // Precompute per-slot crops in parallel (sharp.extract — no VLM).
  // iOS uses these for its tap-to-correct overlays (LiveFillState.slotCrops).
  const slotCrops = await Promise.all(
    Array.from({ length: snappedWays }, async (_, i) => {
      try {
        const geomShared = {
          slotCentersX: isRewireable
            ? slotCentersPx
            : slotCentersPx.map((px) => Math.round((px / imgW) * 1000)),
          imageWidth: imgW,
          imageHeight: imgH,
        };
        if (isRewireable) {
          const out = await cropCarrierSlot(imageBuffer, i, {
            slotCentersX: slotCentersPx,
            carrierPitchPx: pitchPx,
            panelTopNorm: prepared.panelBounds?.top ?? 400,
            panelBottomNorm: prepared.panelBounds?.bottom ?? 600,
            imageWidth: imgW,
            imageHeight: imgH,
          });
          return out;
        }
        const out = await cropSlot(imageBuffer, i, {
          slotCentersX: geomShared.slotCentersX,
          moduleWidth: Math.round((pitchPx / imgW) * 1000),
          railTop: prepared.medianRails?.rail_top ?? Math.round((railTopPx / imgH) * 1000),
          railBottom: prepared.medianRails?.rail_bottom ?? Math.round((railBottomPx / imgH) * 1000),
          imageWidth: imgW,
          imageHeight: imgH,
        });
        return out;
      } catch {
        return { buffer: Buffer.alloc(0), bbox: { x: 0, y: 0, w: 1, h: 1 } };
      }
    })
  );

  for (let s = 0; s < snappedWays; s++) {
    const owner = slotOwner[s];
    const crop = slotCrops[s];
    const crop64 = crop.buffer.length > 0 ? crop.buffer.toString('base64') : '';

    if (!owner) {
      slots.push({
        slotIndex: s,
        content: 'empty',
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
        crop: { bbox: crop.bbox, base64: crop64 },
      });
      labels.push({
        slotIndex: s,
        label: null,
        rawLabel: null,
        confidence: 0,
      });
      continue;
    }

    const ownsStartSlot = owner.startSlot === s;
    const cls = (owner.kind || 'unknown').toLowerCase();
    // Normalise device_kind to what the existing slotsToCircuits / merger
    // expects — the harness emits "rewireable"/"cartridge"/"main_switch"/"spd"/"blank"
    // as-is and the modern emits "mcb"/"rcbo"/"rcd"/etc.
    const classification = cls;
    // Confidence: scale by votes (3 votes ≈ full confidence). Cluster
    // votes are 1..N where N is window count; cap at 0.95 so the
    // existing 0.7 confidence floor in slotsToCircuits is comfortably
    // exceeded.
    const confidence = Math.min(0.95, 0.5 + 0.15 * (owner.votes - 1));

    slots.push({
      slotIndex: s,
      content: owner.kind === 'blank' ? 'blank' : 'device',
      extends: owner.colsUsed > 1 ? (ownsStartSlot ? 'right' : 'left') : 'none',
      classification,
      manufacturer:
        boardManufacturer ?? (cls === 'rcbo' || cls === 'rcd' || cls === 'mcb' ? 'unknown' : null),
      model: null,
      ratingAmps: typeof owner.rating === 'number' ? owner.rating : Number(owner.rating) || null,
      ratingText: owner.rating != null ? `${owner.curve || ''}${owner.rating}A`.trim() : null,
      ratingHallucinationDetected: false,
      poles: owner.colsUsed >= 2 ? 2 : 1,
      tripCurve: owner.curve || null,
      sensitivity:
        owner.rcd_rating_ma != null
          ? typeof owner.rcd_rating_ma === 'number'
            ? owner.rcd_rating_ma
            : Number(owner.rcd_rating_ma) || null
          : null,
      rcdWaveformType: owner.rcd_type || null,
      bsEn: owner.bs_en || null,
      bodyColour: owner.body_colour || null,
      confidence,
      crop: { bbox: crop.bbox, base64: crop64 },
    });
    labels.push({
      slotIndex: s,
      label: owner.label || null,
      rawLabel: owner.label || null,
      confidence,
    });
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
      readsTotal: allReads.length,
      clusters: clusters.length,
      placed: placedDevices.length,
      wallMs,
      sumWindowMs,
      tokensIn: totalUsage.inputTokens,
      tokensOut: totalUsage.outputTokens,
      pipeline: isRewireable ? 'rewireable' : 'modern',
    });
  }

  return {
    slots,
    labels,
    finalDevices: placedDevices,
    snappedWays,
    pitchPx,
    timings: { stage3Ms: wallMs },
    usage: totalUsage,
    lowConfidence: false,
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
