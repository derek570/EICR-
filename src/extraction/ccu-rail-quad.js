/**
 * Perspective-aware rail geometry detection.
 *
 * Replaces the axis-aligned box model in `ccu-box-tighten.js`. The previous
 * approach picks a single Y for the top edge and a single Y for the bottom
 * edge by column-summing Sobel-Y across the whole rail width, then derives
 * one global `pxPerMm = faceHeight / 44.5` and one initial pitch via the
 * 17.5 mm DIN module-pitch formula. That works only when the camera is
 * dead-perpendicular to the board. As soon as the camera is off-axis (left
 * or right of dead-centre), the rail in the image is a TRAPEZOID, the per-
 * X face height varies linearly across the width, and a single global
 * `pxPerMm` over- or under-estimates the pitch enough to flip
 * `Math.round(faceWidth / pitch)` by ±1 — typically dropping an end device
 * (the Hob-disappearing problem repeatedly hit on Elucian CU1SPD275 in
 * production logs 2026-05-05).
 *
 * The fix here is structural:
 *
 *   1. Fit each rail edge as a LINE (least-squares with MAD-based outlier
 *      rejection over per-column / per-row gradient maxima), not a single
 *      strongest row / column. This recovers the real keystone slope.
 *
 *   2. Intersect the four fitted lines to get the four rail-face corners
 *      in image coordinates — a true quadrilateral.
 *
 *   3. Build a perspective-corrected 1-D column-sum signal by walking the
 *      quadrilateral via bilinear (u, v) parameterisation: for each of N
 *      uniformly-spaced u values, integrate |Sobel-X| along the v-axis line
 *      from the top edge to the bottom edge AT THAT u. Each sample of the
 *      signal corresponds to the same physical width of rail, regardless
 *      of how the perspective maps that to pixels.
 *
 *   4. Detect module pitch via autocorrelation on the rectified signal
 *      (same `autocorrPeak` as ccu-cv-pitch.js, just on a different input).
 *      The dominant peak is the true pitch in rectified-sample units.
 *
 *   5. Module count = round(N / pitchSamples). Slot centres at uniform
 *      u positions in [0, 1], mapped back to image coordinates via the
 *      same bilinear quadrilateral.
 *
 * Result: count is correct on photos where the formula path under-counts
 * (typically off-axis Elucian / Hager / Wylex shots), AND slot centres
 * land on the actual device midpoints in image pixels rather than on a
 * line that's right in the middle of the rail but wrong at the ends.
 *
 * The caller's API is identical to `tightenAndChunk` from
 * `ccu-box-tighten.js`, so this is a drop-in replacement gated by the
 * `CCU_QUAD_GEOMETRY` env var. Default ON; falls back to the legacy
 * box-tightener on any error.
 *
 * @module ccu-rail-quad
 */

import sharp from 'sharp';
import { autocorrPeak } from './ccu-cv-pitch.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

// Search-strip thickness around each edge of the user's iOS railRoiHint
// box, as a fraction of the box's perpendicular dimension. The user's box
// is already pretty close to the rail; we just need enough room to recover
// the actual edge when the box is a few % off.
const EDGE_SEARCH_PAD = 0.03;

// MAD multiplier for outlier rejection on edge points. Edge points whose
// distance from the median exceeds 3 × MAD are dropped before the line fit.
// 3 is conservative — keeps borderline points; an aggressive 1.5 would
// drop too many on photos with mild label noise.
const MAD_K = 3;

// Number of rectified-rail samples for the perspective-corrected column-sum.
// 1024 gives sub-percent pitch resolution on the typical 14–18 module rail
// (≈64 samples per module) without making autocorrelation slow.
export const RECT_SAMPLES = 1024;

// Vertical-direction sampling resolution when integrating the gradient along
// each rectified column. 32 samples covers the rail face at any reasonable
// crop height (typical face is ~200–1000 px); going higher is wasted compute
// because the rail-face vertical extent isn't where the periodic structure
// lives.
const RECT_VERTICAL_STEPS = 32;

// Autocorrelation lag bounds in rectified-sample units. RECT_SAMPLES = 1024
// means a typical 16-module rail has pitch ~64 samples/module. Search
// 32–256 to cover 4–32 modules; anything outside that isn't a UK domestic
// CU.
export const RECT_MIN_LAG = 32;
export const RECT_MAX_LAG = 256;

// Below this autocorrelation strength we don't trust the rectified pitch
// and should fall back to the legacy box-tightener. Tuned conservatively;
// real periodic rails score 0.4+, noise scores under 0.2.
const RECT_NORMCORR_FLOOR = 0.25;

// ---------------------------------------------------------------------------
// Edge-line fitting
// ---------------------------------------------------------------------------

/**
 * Compute Sobel-Y gradient magnitude grid for a raw greyscale buffer.
 * Returns Float32Array length width × height.
 */
export function sobelYGrid(grey, width, height) {
  const out = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    const yOff = y * width;
    for (let x = 1; x < width - 1; x++) {
      const i = yOff + x;
      const g =
        -grey[i - width - 1] -
        2 * grey[i - width] -
        grey[i - width + 1] +
        grey[i + width - 1] +
        2 * grey[i + width] +
        grey[i + width + 1];
      out[i] = Math.abs(g);
    }
  }
  return out;
}

/**
 * Compute Sobel-X gradient magnitude grid. Same shape as sobelYGrid but
 * the kernel detects vertical edges (which is what module boundaries are).
 */
export function sobelXGrid(grey, width, height) {
  const out = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    const yOff = y * width;
    for (let x = 1; x < width - 1; x++) {
      const i = yOff + x;
      const g =
        -grey[i - width - 1] +
        grey[i - width + 1] +
        -2 * grey[i - 1] +
        2 * grey[i + 1] +
        -grey[i + width - 1] +
        grey[i + width + 1];
      out[i] = Math.abs(g);
    }
  }
  return out;
}

function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mad(arr, med) {
  if (arr.length === 0) return 0;
  const dev = arr.map((v) => Math.abs(v - med));
  return median(dev);
}

/**
 * Robust least-squares fit of `y = m·x + b` over (x, y) pairs.
 * MAD-rejects points whose y-coordinate is more than `MAD_K · MAD` from
 * the median y, then fits the survivors. Returns null when fewer than 3
 * survivors remain (line is undefined under-determined).
 */
export function fitLineLeastSquares(points) {
  if (!Array.isArray(points) || points.length < 3) return null;
  const ys = points.map((p) => p.y);
  const med = median(ys);
  const m_ = mad(ys, med);
  const cutoff = MAD_K * Math.max(m_, 0.5);
  const survivors = points.filter((p) => Math.abs(p.y - med) <= cutoff);
  if (survivors.length < 3) return null;

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (const p of survivors) {
    sumX += p.x;
    sumY += p.y;
    sumXY += p.x * p.y;
    sumXX += p.x * p.x;
  }
  const n = survivors.length;
  const denom = n * sumXX - sumX * sumX;
  if (Math.abs(denom) < 1e-9) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return {
    slope,
    intercept,
    n,
    rejected: points.length - n,
    median: med,
    mad: m_,
  };
}

/**
 * Find one edge point per X column inside a horizontal search strip. The
 * point is the y of maximum |Sobel-Y| within `[stripY0, stripY1)` at that
 * column. Returns an array of {x, y} pairs in CROP-LOCAL pixel coords.
 *
 * @param {Float32Array} gradY  width × height grid of |Sobel-Y|
 */
export function collectHorizontalEdgePoints(gradY, width, height, stripY0, stripY1) {
  const y0 = Math.max(0, Math.floor(stripY0));
  const y1 = Math.min(height, Math.ceil(stripY1));
  const points = [];
  for (let x = 1; x < width - 1; x++) {
    let best = -Infinity;
    let bestY = y0;
    for (let y = y0; y < y1; y++) {
      const v = gradY[y * width + x];
      if (v > best) {
        best = v;
        bestY = y;
      }
    }
    points.push({ x, y: bestY, gradient: best });
  }
  return points;
}

/**
 * Same as the horizontal collector but transposed: one (x, y) per Y row,
 * where x is the column of maximum |Sobel-X| inside the vertical search
 * strip. Used for left + right rail edges.
 */
export function collectVerticalEdgePoints(gradX, width, height, stripX0, stripX1) {
  const x0 = Math.max(0, Math.floor(stripX0));
  const x1 = Math.min(width, Math.ceil(stripX1));
  const points = [];
  for (let y = 1; y < height - 1; y++) {
    let best = -Infinity;
    let bestX = x0;
    for (let x = x0; x < x1; x++) {
      const v = gradX[y * width + x];
      if (v > best) {
        best = v;
        bestX = x;
      }
    }
    // Returned shape is {x, y} where the FREE variable is y and the
    // dependent is x — we'll fit `x = m·y + b` for vertical edges.
    points.push({ x: y, y: bestX, gradient: best });
  }
  return points;
}

// ---------------------------------------------------------------------------
// Quadrilateral geometry
// ---------------------------------------------------------------------------

/**
 * Intersect a horizontal line `y = m_h·x + b_h` with a vertical line
 * `x = m_v·y + b_v`. Returns the corner point.
 */
function intersectHorizontalVertical(hLine, vLine) {
  // y = m_h(m_v y + b_v) + b_h
  // y(1 - m_h m_v) = m_h b_v + b_h
  const denom = 1 - hLine.slope * vLine.slope;
  if (Math.abs(denom) < 1e-9) return null;
  const y = (hLine.slope * vLine.intercept + hLine.intercept) / denom;
  const x = vLine.slope * y + vLine.intercept;
  return { x, y };
}

/**
 * Bilinear interpolation of a point inside the quadrilateral defined by
 * its four corners in image coordinates. (u, v) ∈ [0,1]² maps to:
 *   P(u,v) = (1-u)(1-v)·TL + u(1-v)·TR + (1-u)v·BL + uv·BR
 * Equivalent to a planar parameterisation; for small perspective angles
 * (typical CCU photos) it differs from a true projective map by < 1 pixel.
 */
export function bilinearQuad(corners, u, v) {
  const a = (1 - u) * (1 - v);
  const b = u * (1 - v);
  const c = (1 - u) * v;
  const d = u * v;
  return {
    x: a * corners.tl.x + b * corners.tr.x + c * corners.bl.x + d * corners.br.x,
    y: a * corners.tl.y + b * corners.tr.y + c * corners.bl.y + d * corners.br.y,
  };
}

/**
 * Bilinear-sample a Float32Array gradient grid at fractional (x, y) in
 * crop-local coords. Out-of-bounds samples return 0.
 */
export function sampleGradient(grid, width, height, x, y) {
  if (x < 0 || y < 0 || x >= width - 1 || y >= height - 1) return 0;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const i00 = y0 * width + x0;
  const i01 = i00 + 1;
  const i10 = i00 + width;
  const i11 = i10 + 1;
  return (
    grid[i00] * (1 - fx) * (1 - fy) +
    grid[i01] * fx * (1 - fy) +
    grid[i10] * (1 - fx) * fy +
    grid[i11] * fx * fy
  );
}

/**
 * Maximum phase offset as a fraction of pitch. Phases beyond this cap are
 * almost certainly the matched filter snapping to a label / toggle-slit /
 * mid-module gradient that's stronger than the actual boundary gradient,
 * not a real overshoot of the line-fitter. The line-fitter's left-edge
 * accuracy is empirically within ~10% of pitch on real photos, so anything
 * beyond ~12% suggests a false maximum and the safer fallback is 0
 * (uniform `(i + 0.5) / N` placement).
 *
 * 2026-05-05 production data points used to calibrate:
 *   - Working photo (10:02): phase = 5 samples = 7% of pitch → applied.
 *   - Failing photo (10:56): phase = 15 samples = 22% of pitch → over-
 *     shifted, dropped Ovens. Cap rejects this and falls back to phase=0.
 */
const PHASE_CAP_FRACTION = 0.12;

/**
 * Find the phase offset of a periodic signal at a known period.
 *
 * Autocorrelation tells us the dominant PERIOD (pitch in samples) but
 * gives no information about WHERE in the signal the periodic structure
 * starts. Two signals can have identical autocorrelation peaks but
 * different start positions — a "comb" of peaks at samples
 * [0, P, 2P, 3P, ...] and one at [10, 10+P, 10+2P, ...] both
 * autocorrelate at lag P with full strength.
 *
 * For our use case, the rectified column-sum has strong gradient peaks
 * at module BOUNDARIES (where one device ends and the next begins).
 * To place slot centres correctly, we need to find which offset in
 * [-cap, +cap] aligns a comb of P-spaced positions to the actual
 * gradient peaks in the signal.
 *
 * SEARCH WINDOW IS BOUNDED — `[-cap·P, +cap·P]` not `[0, P)`. The cap
 * (12% of pitch by default) prevents the matched filter from latching
 * onto a non-boundary feature (a label rule, a body seam, a toggle slit)
 * that scores higher than the actual boundaries. Without this, a single
 * photo with strong intra-module gradients can produce a 22%-of-pitch
 * shift that pushes the rightmost slot's wide Stage 3 crop into the next
 * device — see commit fc1602a's revert. The cap is symmetric (negative
 * and positive offsets allowed) because line-fitter error can go either
 * way: rail edge picked too far left → negative phase; too far right →
 * positive phase.
 *
 * Algorithm:
 *   For every integer offset in [-floor(cap·P), +floor(cap·P)]:
 *     Sum signal[offset + k·P] for valid k
 *   Pick the offset that maximises that sum.
 *
 * Returns the offset that places module BOUNDARIES at
 * `offset + k·pitchSamples` for k = 0, 1, ..., moduleCount.
 * Module CENTRES are then `offset + (i + 0.5)·pitchSamples`.
 *
 * @param {Float32Array} signal — the rectified column-sum
 * @param {number} pitchSamples — period from autocorrelation
 * @param {{ capFraction?: number }} [opts] — override the default cap
 *        (mostly for tests)
 */
export function findBoundaryPhase(signal, pitchSamples, opts = {}) {
  if (!Number.isFinite(pitchSamples) || pitchSamples <= 0) return 0;
  const P = Math.round(pitchSamples);
  const N = signal.length;
  const cap = Math.max(1, Math.floor(P * (opts.capFraction ?? PHASE_CAP_FRACTION)));
  let bestOffset = 0;
  let bestScore = -Infinity;
  for (let offset = -cap; offset <= cap; offset++) {
    let score = 0;
    let count = 0;
    for (let k = 0; ; k++) {
      const idx = offset + k * P;
      if (idx >= N) break;
      if (idx >= 0) {
        score += signal[idx];
        count += 1;
      }
    }
    // Normalise by number of in-range samples so negative-offset windows
    // (which lose a sample at the left) aren't penalised vs positive ones.
    const normalised = count > 0 ? score / count : 0;
    if (normalised > bestScore) {
      bestScore = normalised;
      bestOffset = offset;
    }
  }
  return bestOffset;
}

/**
 * Compute the perspective-corrected column-sum across the rectified rail.
 * For each of `RECT_SAMPLES` uniformly-spaced u values, integrate the
 * |Sobel-X| gradient along the v-axis line from the top edge to the bottom
 * edge AT THAT u. Each sample of the returned signal corresponds to the
 * same physical width of rail, so the autocorrelator sees a uniform
 * periodic signal regardless of perspective.
 */
export function rectifiedColumnSum(gradX, width, height, corners) {
  const out = new Float32Array(RECT_SAMPLES);
  for (let i = 0; i < RECT_SAMPLES; i++) {
    const u = (i + 0.5) / RECT_SAMPLES;
    let sum = 0;
    for (let s = 0; s < RECT_VERTICAL_STEPS; s++) {
      const v = (s + 0.5) / RECT_VERTICAL_STEPS;
      const p = bilinearQuad(corners, u, v);
      sum += sampleGradient(gradX, width, height, p.x, p.y);
    }
    out[i] = sum / RECT_VERTICAL_STEPS;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Perspective-aware tighten-and-chunk. Same return shape as
 * `tightenAndChunk` from ccu-box-tighten.js so the route handler can swap
 * implementations behind a feature flag.
 *
 * @param {Buffer} imageBuffer
 * @param {{x:number, y:number, w:number, h:number}} userBox in [0,1]
 *        normalised image-coords
 * @param {{ waysOverride?: number }} [opts]
 *        When `waysOverride` is a positive integer, the autocorrelation-
 *        derived count is overridden by the override value. Refinement
 *        quality is still reported as a sanity check (waysWarning fires
 *        downstream when CV count and override disagree).
 * @returns {Promise<{
 *   imageWidth: number,
 *   imageHeight: number,
 *   railFace: { left:number, top:number, right:number, bottom:number },
 *   quadrilateral: { tl:{x,y}, tr:{x,y}, bl:{x,y}, br:{x,y} },
 *   moduleCount: number,
 *   pitchPx: number,
 *   slotCentersPx: number[],
 *   initialPitchPx: number,
 *   waysOverrideApplied: boolean,
 *   refinement: {
 *     accepted: boolean,
 *     candidatePitchPx: number|null,
 *     pairCount: number,
 *     leftPairCount: number,
 *     rightPairCount: number,
 *     probes: Array,
 *     // V2 diagnostics — populated for parity with the legacy shape.
 *     version: 'quad-v1',
 *     pitchLPx: null,
 *     pitchRPx: null,
 *     isStretched: boolean,
 *     retainedIdx: number[],
 *     blankSuspectIdx: number[],
 *     anchorL: { idx:number, x:number }|null,
 *     anchorR: { idx:number, x:number }|null,
 *     // Quad-specific diagnostics
 *     quadDiag: {
 *       topEdge:    { slope, intercept, n, rejected },
 *       bottomEdge: { slope, intercept, n, rejected },
 *       leftEdge:   { slope, intercept, n, rejected },
 *       rightEdge:  { slope, intercept, n, rejected },
 *       rectNormCorr: number,
 *       rectPitchSamples: number,
 *     }
 *   }
 * }>}
 */
export async function tightenAndChunkQuad(imageBuffer, userBox, opts = {}) {
  const meta = await sharp(imageBuffer).metadata();
  const W = meta.width;
  const H = meta.height;

  // 1. Crop a slightly-padded search region around the user's box. The
  //    pad gives the line-fitter room to find the true rail edges when
  //    the user's box is a few % off — typical for hand-held framing.
  const padX = userBox.w * EDGE_SEARCH_PAD;
  const padY = userBox.h * EDGE_SEARCH_PAD;
  const cropX0 = Math.max(0, Math.round((userBox.x - padX) * W));
  const cropY0 = Math.max(0, Math.round((userBox.y - padY) * H));
  const cropX1 = Math.min(W, Math.round((userBox.x + userBox.w + padX) * W));
  const cropY1 = Math.min(H, Math.round((userBox.y + userBox.h + padY) * H));
  const cropW = cropX1 - cropX0;
  const cropH = cropY1 - cropY0;
  if (cropW < 16 || cropH < 16) {
    throw new Error(`tightenAndChunkQuad: crop too small (${cropW}×${cropH})`);
  }

  // 2. Greyscale + small blur + raw 8-bit pixels.
  const grey = await sharp(imageBuffer)
    .extract({ left: cropX0, top: cropY0, width: cropW, height: cropH })
    .greyscale()
    .blur(0.8)
    .raw()
    .toBuffer();

  const gradY = sobelYGrid(grey, cropW, cropH);
  const gradX = sobelXGrid(grey, cropW, cropH);

  // 3. Fit each of the 4 edge lines.
  //    For top/bot: search a horizontal strip near the box edge, find one
  //    edge point per column, fit y = m·x + b.
  //    For left/right: search a vertical strip near the box edge, find
  //    one edge point per row, fit x = m·y + b.
  const userBoxLocalY0 = (userBox.y * H - cropY0) / 1; // already in crop-local px
  const userBoxLocalY1 = ((userBox.y + userBox.h) * H - cropY0) / 1;
  const userBoxLocalX0 = (userBox.x * W - cropX0) / 1;
  const userBoxLocalX1 = ((userBox.x + userBox.w) * W - cropX0) / 1;
  const edgePadPx = Math.max(4, Math.round(cropH * EDGE_SEARCH_PAD));
  const edgePadPxX = Math.max(4, Math.round(cropW * EDGE_SEARCH_PAD));

  const topPoints = collectHorizontalEdgePoints(
    gradY,
    cropW,
    cropH,
    userBoxLocalY0 - edgePadPx,
    userBoxLocalY0 + edgePadPx
  );
  const botPoints = collectHorizontalEdgePoints(
    gradY,
    cropW,
    cropH,
    userBoxLocalY1 - edgePadPx,
    userBoxLocalY1 + edgePadPx
  );
  const leftPoints = collectVerticalEdgePoints(
    gradX,
    cropW,
    cropH,
    userBoxLocalX0 - edgePadPxX,
    userBoxLocalX0 + edgePadPxX
  );
  const rightPoints = collectVerticalEdgePoints(
    gradX,
    cropW,
    cropH,
    userBoxLocalX1 - edgePadPxX,
    userBoxLocalX1 + edgePadPxX
  );

  const topLine = fitLineLeastSquares(topPoints);
  const botLine = fitLineLeastSquares(botPoints);
  const leftLine = fitLineLeastSquares(leftPoints); // returns x-as-fn-of-y
  const rightLine = fitLineLeastSquares(rightPoints);

  if (!topLine || !botLine || !leftLine || !rightLine) {
    throw new Error('tightenAndChunkQuad: could not fit one or more edge lines');
  }

  // 4. Intersect the four lines to get the four quad corners (crop-local).
  const tl = intersectHorizontalVertical(topLine, leftLine);
  const tr = intersectHorizontalVertical(topLine, rightLine);
  const bl = intersectHorizontalVertical(botLine, leftLine);
  const br = intersectHorizontalVertical(botLine, rightLine);
  if (!tl || !tr || !bl || !br) {
    throw new Error('tightenAndChunkQuad: degenerate quadrilateral');
  }
  const cropLocalCorners = { tl, tr, bl, br };

  // 5. Build the perspective-corrected column-sum signal.
  const rectColSum = rectifiedColumnSum(gradX, cropW, cropH, cropLocalCorners);

  // 6. Autocorrelation → pitch in rectified-sample units.
  const ac = autocorrPeak(rectColSum, RECT_MIN_LAG, RECT_MAX_LAG);
  const rectAcceptable = ac.normCorr >= RECT_NORMCORR_FLOOR && ac.lag > 0;

  let moduleCount;
  const waysOverride =
    Number.isFinite(opts.waysOverride) && opts.waysOverride > 0
      ? Math.round(opts.waysOverride)
      : null;
  const waysOverrideApplied = waysOverride != null;

  if (waysOverrideApplied) {
    moduleCount = waysOverride;
  } else if (rectAcceptable) {
    moduleCount = Math.max(1, Math.round(RECT_SAMPLES / ac.lag));
  } else {
    throw new Error(
      `tightenAndChunkQuad: autocorrelation below confidence floor (normCorr=${ac.normCorr.toFixed(2)})`
    );
  }

  // 7. Slot centres — bounded phase-lock to actual device boundaries.
  //
  //    Bilinear interpolation of uniform `u = (i + 0.5) / N` already places
  //    centres on real-world-uniform positions across the rail (because
  //    DIN module pitch is uniform). But the line-fitter's edges can be
  //    a few % off, which translates to a small phase error in the
  //    rectified signal. Phase-lock corrects it: matched filter against
  //    the rectified column-sum finds the offset that aligns module
  //    BOUNDARIES to actual gradient peaks; slot CENTRES are then
  //    `phaseOffset + (i + 0.5) × pitchSamples`.
  //
  //    findBoundaryPhase is BOUNDED — searches only ±12% of pitch around
  //    zero (PHASE_CAP_FRACTION). Without that bound the matched filter
  //    can latch onto a non-boundary gradient (a label rule, a toggle
  //    slit, a body seam) that scores higher than the actual boundaries
  //    and shift everything by ~22% of pitch — that bug shipped briefly
  //    on 2026-05-05 (commit 0356357) and dropped the rightmost RCBO
  //    out of the schedule. The bounded search keeps the small
  //    correction (Derek's overlay test 2026-05-05 had phase = 7% of
  //    pitch — well within cap, applied → cyan lines on device centres)
  //    while rejecting the runaway false maxima.
  const pitchSamples = waysOverrideApplied ? RECT_SAMPLES / moduleCount : ac.lag;
  const phaseOffset = findBoundaryPhase(rectColSum, pitchSamples);

  const slotCentersPx = [];
  for (let i = 0; i < moduleCount; i++) {
    const sampleX = phaseOffset + (i + 0.5) * pitchSamples;
    const u = Math.min(1, Math.max(0, sampleX / RECT_SAMPLES));
    const p = bilinearQuad(cropLocalCorners, u, 0.5);
    slotCentersPx.push(cropX0 + p.x);
  }

  // 8. Build legacy-compatible refinement diagnostics. Because we don't
  //    use multi-anchor probes, we synthesise a probes[] array from the
  //    slot centres so downstream logging code that iterates probes still
  //    works, but mark version='quad-v1' so a reader can tell.
  const railFace = {
    left: cropX0 + Math.min(tl.x, bl.x),
    top: cropY0 + Math.min(tl.y, tr.y),
    right: cropX0 + Math.max(tr.x, br.x),
    bottom: cropY0 + Math.max(bl.y, br.y),
  };
  const faceWidthCrop = Math.max(tr.x, br.x) - Math.min(tl.x, bl.x);
  const initialPitchPx = faceWidthCrop / moduleCount;

  return {
    imageWidth: W,
    imageHeight: H,
    railFace,
    quadrilateral: {
      tl: { x: cropX0 + tl.x, y: cropY0 + tl.y },
      tr: { x: cropX0 + tr.x, y: cropY0 + tr.y },
      bl: { x: cropX0 + bl.x, y: cropY0 + bl.y },
      br: { x: cropX0 + br.x, y: cropY0 + br.y },
    },
    moduleCount,
    pitchPx: initialPitchPx,
    slotCentersPx,
    initialPitchPx: Math.round(initialPitchPx * 10) / 10,
    waysOverrideApplied,
    refinement: {
      accepted: rectAcceptable,
      candidatePitchPx:
        rectAcceptable && ac.lag > 0
          ? Math.round((faceWidthCrop / (RECT_SAMPLES / ac.lag)) * 10) / 10
          : null,
      pairCount: rectAcceptable ? Math.round(RECT_SAMPLES / Math.max(1, ac.lag)) : 0,
      leftPairCount: 0,
      rightPairCount: 0,
      probes: [],
      version: 'quad-v1',
      pitchLPx: null,
      pitchRPx: null,
      isStretched:
        Math.abs(tl.y - tr.y) > Math.abs(tl.y - bl.y) * 0.05 ||
        Math.abs(bl.y - br.y) > Math.abs(tl.y - bl.y) * 0.05,
      retainedIdx: [],
      blankSuspectIdx: [],
      anchorL: null,
      anchorR: null,
      quadDiag: {
        topEdge: pickLineDiag(topLine),
        bottomEdge: pickLineDiag(botLine),
        leftEdge: pickLineDiag(leftLine),
        rightEdge: pickLineDiag(rightLine),
        rectNormCorr: Math.round(ac.normCorr * 1000) / 1000,
        rectPitchSamples: ac.lag,
        phaseOffsetSamples: phaseOffset,
        // Phase shift in image-pixel units — useful diagnostic. If this
        // sits well above ~10% of pitch, the line-fitted left edge is
        // over-shooting the actual leftmost device boundary by that much
        // and the slot grid would have been mis-aligned without phase
        // correction.
        phaseShiftPx: Math.round((phaseOffset / RECT_SAMPLES) * faceWidthCrop * 10) / 10,
      },
    },
  };
}

function pickLineDiag(line) {
  return {
    slope: Math.round(line.slope * 1000) / 1000,
    intercept: Math.round(line.intercept * 10) / 10,
    n: line.n,
    rejected: line.rejected,
  };
}
