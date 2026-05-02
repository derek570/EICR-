/**
 * Server-side rail-bbox tightening + multi-anchor module-pitch refinement.
 *
 * Replaces the Stage 1/2 VLM-based geometry detection (see ccu-geometric.js
 * `prepareGeometry`) with a direct CV approach: take the user's iOS railRoiHint
 * box, fine-tune each of its 4 edges to land on the actual rail-face
 * boundary, then derive module pitch from the photo via 8 strip probes
 * (4 left + 4 right) using same-side-pair median.
 *
 * Why we needed this:
 *   - The Stage 2 height-anchor formula (44.5 mm DIN face / 17.5 mm pitch)
 *     gives wrong counts on manufacturers whose physical module pitch
 *     deviates from the DIN nominal (Protek HDM ≈ 16.5 mm,
 *     older Hager ≈ 18.5–19 mm).
 *   - The Stage 2 CV-autocorr (Sobel-X column-sum + autocorrelation)
 *     finds spurious sub-module periodicities on multi-RCD boards
 *     (each 2-pole device has a mid-body seam at sub-module pitch).
 *   - The dual-anchor approach measures pitch LOCALLY at two anchor
 *     points and takes the median across same-side pair pitches, which
 *     ignores cross-rail bias (long-span pairs collapse to the
 *     formula's predicted pitch by averaging out the cumulative error).
 *
 * Validated against the 3-board annotated corpus 2026-04-30:
 *   Wylex 16/16, Hager 16/16, Protek 20/20.
 *
 * @module ccu-box-tighten
 */
import sharp from 'sharp';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

// Per-edge fine-tune strip half-width — fraction of the perpendicular box
// dimension. 0.02 means each edge can shift up to ±2 % of the box's width
// (for L/R edges) or height (for T/B edges) before the search stops. Wider
// → recovers from looser user crops, narrower → less risk of crossing a
// module boundary into a wrong feature. 0.02 was chosen empirically: keeps
// each edge move under ~0.3 of a module pitch on a typical 16-module rail.
export const EDGE_PAD = 0.02;

// DIN 43880 / 60898 physical constants — the formula uses these to derive
// an INITIAL pitch estimate (subsequently refined by the multi-anchor
// strip probes against the actual photo).
export const MCB_FACE_HEIGHT_MM = 44.5;
export const MODULE_PITCH_MM = 17.5;

// Multi-anchor probe strip half-width — fraction of the initial pitch.
// 0.25 is wide enough that a 5–10 % cumulative pitch error over 4 modules
// still puts the true boundary inside the search strip; narrow enough
// that adjacent module boundaries don't fit inside the same strip.
const PROBE_STRIP_HALF_FRAC = 0.25;

// Probe column-sum is restricted to the bottom 40 % of the rail face.
// The toggle slits sit in the upper half and dominate the column signal at
// sub-module pitch; the lower half has only the smooth body sides where
// the only strong vertical gradient is the actual module boundary.
const PROBE_BAND_TOP_FRAC = 0.6;

// Probe confidence floors — a probe contributes to the pitch estimate when
// SNR ≥ 1.4 AND sharpness ≥ 1.05. Tuned loose enough that "noisy plateau"
// probes still contribute via the median once enough pairs are in play.
const PROBE_SNR_FLOOR = 1.4;
const PROBE_SHARPNESS_FLOOR = 1.05;

// Pair pitches outside ±25 % of the initial pitch are dropped as outliers
// (typical cause: probe landed in the middle of a 2-module RCD where there
// is no real boundary).
const PAIR_DRIFT_MAX = 0.25;

// ---------------------------------------------------------------------------
// V2 probe pipeline (CCU_PROBE_V2 — default ON)
// ---------------------------------------------------------------------------
// Replaces the v1 8-position Sobel-X-on-bottom-40 % column-sum with:
//   • TALL-THIN filter — column score = (full-rail-height Sobel-X column sum)
//     × (top-10 % column sum) × (bottom-10 % column sum), all normalised.
//     Real device-to-device seams have signal in all three bands; intra-
//     device features (test buttons, label letters, toggle slits) only span
//     part of the height and multiply through to ~0 in at least one band.
//   • EVERY-GAP probing — boundaryIndices = [1 … N-1] instead of [1-4 + N-4..N-1].
//   • CONSISTENCY rejection — iteratively drop probes whose refined position
//     deviates > 15 % of working pitch from "anchor at rightmost retained +
//     walk leftward at working pitch", with a safety floor at max(4, 50 % of
//     confident probes) to avoid collapsing to a single span on noisy boards.
//   • BLANK-SUSPECT detection — pairs with pitch < 60 % of running median
//     flag both probes as "blank-suspect" (signature of multi-module device
//     bodies or unpopulated DIN-rail blank stretches between probes); blank-
//     suspect probes are excluded from end-pitch fitting but kept for
//     consistency check coverage.
//   • LINEAR pitch model — pitchL from left-half short-pair median, pitchR
//     from right-half. When |pitchR − pitchL| / mean > 5 %, the slot grid is
//     laid down with linearly-interpolated pitch (captures perspective
//     stretch). When uniform, behaves identically to v1's two-anchor tiling.
const PROBE_V2_BLANK_PAIR_RATIO = 0.6;
const PROBE_V2_OUTLIER_TOLERANCE = 0.15;
const PROBE_V2_STRETCH_THRESHOLD = 0.05;
const PROBE_V2_TALL_THIN_SHARPNESS_FLOOR = 1.03;

function probeV2Enabled() {
  return (process.env.CCU_PROBE_V2 ?? 'true').toLowerCase() === 'true';
}

/**
 * TALL-THIN column scorer. Sobel-X gradient magnitude column-sum computed in
 * three vertical bands (full / top 10 % / bottom 10 %), each normalised to
 * [0, 1], then multiplied per column. Returns the per-column score as a
 * Float32Array of length `width`.
 */
async function tallThinScore(buffer, width, height) {
  const grey = await sharp(buffer).greyscale().blur(0.5).raw().toBuffer();
  const fullCols = new Float32Array(width);
  const topCols = new Float32Array(width);
  const botCols = new Float32Array(width);
  const topEnd = Math.max(2, Math.floor(height * 0.1));
  const botStart = Math.min(height - 2, Math.ceil(height * 0.9));
  for (let yy = 1; yy < height - 1; yy++) {
    const off = yy * width;
    for (let xx = 1; xx < width - 1; xx++) {
      const i = off + xx;
      const gx =
        -grey[i - width - 1] +
        grey[i - width + 1] +
        -2 * grey[i - 1] +
        2 * grey[i + 1] +
        -grey[i + width - 1] +
        grey[i + width + 1];
      const a = Math.abs(gx);
      fullCols[xx] += a;
      if (yy <= topEnd) topCols[xx] += a;
      if (yy >= botStart) botCols[xx] += a;
    }
  }
  const normalise = (arr) => {
    let max = 0;
    for (const v of arr) if (v > max) max = v;
    if (max <= 0) return arr;
    const out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) out[i] = arr[i] / max;
    return out;
  };
  const full = normalise(fullCols);
  const top = normalise(topCols);
  const bot = normalise(botCols);
  const score = new Float32Array(width);
  for (let i = 0; i < width; i++) score[i] = full[i] * top[i] * bot[i];
  return score;
}

/** Tall-thin probe — same shape as `probeBoundary` but uses the tall-thin
 *  multiplicative scorer over the full rail height. */
async function probeBoundaryV2(imageBuffer, W, H, predictedX, stripTop, stripHeight, halfWidth) {
  const stripX0 = Math.max(0, Math.round(predictedX - halfWidth));
  const stripX1 = Math.min(W, Math.round(predictedX + halfWidth));
  const stripW = stripX1 - stripX0;
  if (stripW < 4 || stripHeight < 4) {
    return { refinedX: predictedX, snr: 0, sharpness: 0, confident: false };
  }
  const stripBuf = await sharp(imageBuffer)
    .extract({ left: stripX0, top: stripTop, width: stripW, height: stripHeight })
    .toBuffer();
  const sig = smooth3(await tallThinScore(stripBuf, stripW, stripHeight));
  let peakI = 0;
  let peakV = -Infinity;
  let secondV = -Infinity;
  let sum = 0;
  for (let i = 1; i < stripW - 1; i++) {
    const v = sig[i];
    sum += v;
    if (v > peakV) {
      secondV = peakV;
      peakV = v;
      peakI = i;
    } else if (v > secondV) {
      secondV = v;
    }
  }
  const mean = sum / Math.max(1, stripW - 2);
  const snr = mean > 0 ? peakV / mean : 0;
  const sharpness = secondV > 0 ? peakV / secondV : peakV > 0 ? 5 : 0;
  return {
    refinedX: stripX0 + peakI,
    snr,
    sharpness,
    confident: snr >= PROBE_SNR_FLOOR && sharpness >= PROBE_V2_TALL_THIN_SHARPNESS_FLOOR,
  };
}

/**
 * V2 refinement — drives the probes, runs consistency rejection + blank
 * detection, returns { pitchL, pitchR, anchorL, anchorR, candidatePitchPx,
 * accepted, refinement } where `refinement` matches the v1 shape so the
 * route handler can log it uniformly.
 */
async function refineV2(imageBuffer, W, H, geometry) {
  const { topY, botY, leftX, faceWidth, faceHeight, initialPitchPx, initialModuleCount } = geometry;
  const halfWidth = Math.max(8, Math.round(initialPitchPx * PROBE_STRIP_HALF_FRAC));
  // Tall-thin needs the FULL rail face — top + bottom bands matter.
  const stripTop = topY;
  const stripHeight = faceHeight;
  const idxs = [];
  for (let i = 1; i < initialModuleCount; i++) idxs.push(i);

  const probes = await Promise.all(
    idxs.map(async (idx) => {
      const predictedX = leftX + initialPitchPx * idx;
      const r = await probeBoundaryV2(
        imageBuffer,
        W,
        H,
        predictedX,
        stripTop,
        stripHeight,
        halfWidth
      );
      return { idx, predictedX, ...r };
    })
  );

  const allConfident = probes
    .filter((p) => p.confident)
    .map((p) => ({ idx: p.idx, x: p.refinedX }))
    .sort((u, v) => u.idx - v.idx);

  // Consistency rejection w/ safety floor.
  const MIN_RETAINED = Math.max(4, Math.floor(allConfident.length * 0.5));
  let retained = [...allConfident];
  for (let iter = 0; iter < 5; iter++) {
    if (retained.length < 2) break;
    const shortPairs = [];
    for (let i = 0; i < retained.length - 1; i++) {
      for (let j = i + 1; j < retained.length; j++) {
        const span = retained[j].idx - retained[i].idx;
        if (span > 0 && span <= 3) {
          shortPairs.push((retained[j].x - retained[i].x) / span);
        }
      }
    }
    if (shortPairs.length === 0) break;
    const sortedShort = [...shortPairs].sort((u, v) => u - v);
    const workingPitch = sortedShort[Math.floor(sortedShort.length / 2)];
    const anchor = retained[retained.length - 1];
    const tol = workingPitch * PROBE_V2_OUTLIER_TOLERANCE;
    const next = retained.filter((p) => {
      const expected = anchor.x + (p.idx - anchor.idx) * workingPitch;
      return Math.abs(p.x - expected) <= tol;
    });
    if (next.length === retained.length) break;
    if (next.length < MIN_RETAINED) break;
    retained = next;
  }

  // Blank-suspect detection.
  const collectShortPairs = (subset) => {
    const out = [];
    for (let i = 0; i < subset.length - 1; i++) {
      for (let j = i + 1; j < subset.length; j++) {
        const span = subset[j].idx - subset[i].idx;
        if (span > 0 && span <= 3) {
          out.push({
            from: subset[i].idx,
            to: subset[j].idx,
            span,
            pitch: (subset[j].x - subset[i].x) / span,
          });
        }
      }
    }
    return out;
  };
  const allShort = collectShortPairs(retained);
  const blankSuspect = new Set();
  if (allShort.length >= 3) {
    const sortedAll = [...allShort.map((p) => p.pitch)].sort((u, v) => u - v);
    const median0 = sortedAll[Math.floor(sortedAll.length / 2)];
    const threshold = median0 * PROBE_V2_BLANK_PAIR_RATIO;
    for (const p of allShort) {
      if (p.pitch < threshold) {
        blankSuspect.add(p.from);
        blankSuspect.add(p.to);
      }
    }
  }
  const cleanRetained = retained.filter((p) => !blankSuspect.has(p.idx));
  const pitchSource = cleanRetained.length >= 4 ? cleanRetained : retained;

  // Half-half median pitch + stretch detection.
  const medianShortPair = (subset) => {
    const pairs = collectShortPairs(subset).map((p) => p.pitch);
    if (pairs.length === 0) return null;
    const sorted = pairs.sort((u, v) => u - v);
    return sorted[Math.floor(sorted.length / 2)];
  };
  let pitchL = initialPitchPx;
  let pitchR = initialPitchPx;
  if (pitchSource.length >= 4) {
    const midIdx = (pitchSource[0].idx + pitchSource[pitchSource.length - 1].idx) / 2;
    const leftHalf = pitchSource.filter((p) => p.idx <= midIdx);
    const rightHalf = pitchSource.filter((p) => p.idx >= midIdx);
    pitchL = medianShortPair(leftHalf) ?? medianShortPair(pitchSource) ?? initialPitchPx;
    pitchR = medianShortPair(rightHalf) ?? medianShortPair(pitchSource) ?? initialPitchPx;
  } else if (pitchSource.length === 2 || pitchSource.length === 3) {
    const fallback = medianShortPair(pitchSource) ?? initialPitchPx;
    pitchL = fallback;
    pitchR = fallback;
  }
  const stretch =
    pitchL > 0 && pitchR > 0 ? Math.abs(pitchR - pitchL) / ((pitchL + pitchR) / 2) : 0;
  const isStretched = stretch > PROBE_V2_STRETCH_THRESHOLD;
  const candidatePitchPx = isStretched ? (pitchL + pitchR) / 2 : pitchL;
  const drift = Math.abs(candidatePitchPx - initialPitchPx) / initialPitchPx;
  const accepted = retained.length >= 2 && drift <= PAIR_DRIFT_MAX;

  const anchorL = retained.length > 0 ? retained[0] : null;
  const anchorR = retained.length > 0 ? retained[retained.length - 1] : null;

  return {
    probes,
    retained,
    blankSuspect,
    pitchL,
    pitchR,
    isStretched,
    candidatePitchPx,
    drift,
    accepted,
    anchorL,
    anchorR,
  };
}

/**
 * Lay down `count` slot CENTRES from a v2 model. When stretched, integrates
 * the linear pitch from anchorL to anchorR; outside the anchor span,
 * extrapolates at the corresponding end-pitch.
 */
function slotCentersV2({ leftX, rightX, faceWidth, count, model }) {
  const { isStretched, pitchL, pitchR, anchorL, anchorR, candidatePitchPx } = model;
  const haveTwo = anchorL && anchorR && anchorL.idx !== anchorR.idx;
  const haveOne = !haveTwo && anchorL;
  const positionOf = (i) => {
    if (haveTwo && isStretched) {
      const span = anchorR.idx - anchorL.idx;
      if (i <= anchorL.idx) return anchorL.x - (anchorL.idx - i) * pitchL;
      if (i >= anchorR.idx) return anchorR.x + (i - anchorR.idx) * pitchR;
      const di = i - anchorL.idx;
      const slope = (pitchR - pitchL) / span;
      return anchorL.x + di * pitchL + (slope * di * (di - 1)) / 2;
    }
    if (haveTwo) {
      // Uniform: anchor at rightmost confident probe, walk back at candidate.
      return anchorR.x + (i - anchorR.idx) * candidatePitchPx;
    }
    if (haveOne) return anchorL.x + (i - anchorL.idx) * candidatePitchPx;
    // Fallback: two-anchor tiling from rail edges (matches v1 behaviour).
    return leftX + (faceWidth / count) * i;
  };
  const centres = [];
  for (let i = 0; i < count; i++) {
    centres.push((positionOf(i) + positionOf(i + 1)) / 2);
  }
  return centres;
}

// ---------------------------------------------------------------------------
// Edge-detection primitives
// ---------------------------------------------------------------------------

async function sobelYRowSum(buffer, width, height) {
  const grey = await sharp(buffer).greyscale().blur(0.5).raw().toBuffer();
  const rows = new Float32Array(height);
  for (let yy = 1; yy < height - 1; yy++) {
    let s = 0;
    const off = yy * width;
    for (let xx = 1; xx < width - 1; xx++) {
      const i = off + xx;
      const gy =
        -grey[i - width - 1] -
        2 * grey[i - width] -
        grey[i - width + 1] +
        grey[i + width - 1] +
        2 * grey[i + width] +
        grey[i + width + 1];
      s += Math.abs(gy);
    }
    rows[yy] = s;
  }
  return rows;
}

async function sobelXColSum(buffer, width, height) {
  const grey = await sharp(buffer).greyscale().blur(0.5).raw().toBuffer();
  const cols = new Float32Array(width);
  for (let yy = 1; yy < height - 1; yy++) {
    const off = yy * width;
    for (let xx = 1; xx < width - 1; xx++) {
      const i = off + xx;
      const gx =
        -grey[i - width - 1] +
        grey[i - width + 1] +
        -2 * grey[i - 1] +
        2 * grey[i + 1] +
        -grey[i + width - 1] +
        grey[i + width + 1];
      cols[xx] += Math.abs(gx);
    }
  }
  return cols;
}

function smooth3(signal) {
  const out = new Float32Array(signal.length);
  out[0] = signal[0];
  out[signal.length - 1] = signal[signal.length - 1];
  for (let i = 1; i < signal.length - 1; i++) {
    out[i] = (signal[i - 1] + signal[i] + signal[i + 1]) / 3;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-edge fine-tune
// ---------------------------------------------------------------------------

/**
 * Find the strongest horizontal-edge row inside a strip running the user
 * box's full width × (2 × padYpx) tall, centred on `centreYpx`.
 *
 * The X span is restricted to the user box width so silkscreen labels
 * outside the rail (left/right of the device row) don't bias the row
 * signal.
 */
async function findHorizontalEdge(imageBuffer, W, H, userPx, centreYpx, padYpx) {
  const stripY0 = Math.max(0, centreYpx - padYpx);
  const stripY1 = Math.min(H, centreYpx + padYpx);
  const stripH = stripY1 - stripY0;
  if (stripH < 3) return centreYpx;
  const stripX0 = Math.max(0, userPx.x0);
  const stripW = Math.min(W - stripX0, userPx.x1 - userPx.x0);
  if (stripW < 3) return centreYpx;
  const stripBuf = await sharp(imageBuffer)
    .extract({ left: stripX0, top: stripY0, width: stripW, height: stripH })
    .toBuffer();
  const rowSig = smooth3(await sobelYRowSum(stripBuf, stripW, stripH));
  let peakI = 0;
  let peakV = -Infinity;
  for (let i = 1; i < stripH - 1; i++) {
    if (rowSig[i] > peakV) {
      peakV = rowSig[i];
      peakI = i;
    }
  }
  return stripY0 + peakI;
}

/**
 * Find the strongest vertical-edge column inside a strip running the
 * user box's full height × (2 × padXpx) wide, centred on `centreXpx`.
 */
async function findVerticalEdge(imageBuffer, W, H, userPx, centreXpx, padXpx) {
  const stripX0 = Math.max(0, centreXpx - padXpx);
  const stripX1 = Math.min(W, centreXpx + padXpx);
  const stripW = stripX1 - stripX0;
  if (stripW < 3) return centreXpx;
  const stripY0 = Math.max(0, userPx.y0);
  const stripH = Math.min(H - stripY0, userPx.y1 - userPx.y0);
  if (stripH < 3) return centreXpx;
  const stripBuf = await sharp(imageBuffer)
    .extract({ left: stripX0, top: stripY0, width: stripW, height: stripH })
    .toBuffer();
  const colSig = smooth3(await sobelXColSum(stripBuf, stripW, stripH));
  let peakI = 0;
  let peakV = -Infinity;
  for (let i = 1; i < stripW - 1; i++) {
    if (colSig[i] > peakV) {
      peakV = colSig[i];
      peakI = i;
    }
  }
  return stripX0 + peakI;
}

// ---------------------------------------------------------------------------
// Multi-anchor pitch refinement
// ---------------------------------------------------------------------------

async function probeBoundary(imageBuffer, W, H, predictedX, stripTop, stripHeight, halfWidth) {
  const stripX0 = Math.max(0, Math.round(predictedX - halfWidth));
  const stripX1 = Math.min(W, Math.round(predictedX + halfWidth));
  const stripW = stripX1 - stripX0;
  if (stripW < 4 || stripHeight < 4) {
    return { refinedX: predictedX, snr: 0, sharpness: 0, confident: false };
  }
  const stripBuf = await sharp(imageBuffer)
    .extract({ left: stripX0, top: stripTop, width: stripW, height: stripHeight })
    .toBuffer();
  const colSig = smooth3(await sobelXColSum(stripBuf, stripW, stripHeight));
  let peakI = 0;
  let peakV = -Infinity;
  let secondV = -Infinity;
  let sum = 0;
  for (let i = 1; i < stripW - 1; i++) {
    const v = colSig[i];
    sum += v;
    if (v > peakV) {
      secondV = peakV;
      peakV = v;
      peakI = i;
    } else if (v > secondV) {
      secondV = v;
    }
  }
  const mean = sum / Math.max(1, stripW - 2);
  const snr = mean > 0 ? peakV / mean : 0;
  const sharpness = secondV > 0 ? peakV / secondV : peakV > 0 ? 5 : 0;
  return {
    refinedX: stripX0 + peakI,
    snr,
    sharpness,
    confident: snr >= PROBE_SNR_FLOOR && sharpness >= PROBE_SHARPNESS_FLOOR,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fine-tune each edge of the user box, derive an initial pitch from the
 * height-anchor formula, then refine the pitch using same-side-pair
 * median across multi-anchor probes.
 *
 * @param {Buffer} imageBuffer
 * @param {{x:number, y:number, w:number, h:number}} userBox in [0,1]
 *        normalised image-coords
 * @returns {Promise<{
 *   imageWidth: number,
 *   imageHeight: number,
 *   railFace: { left:number, top:number, right:number, bottom:number },
 *     // tightened bbox in pixel coords on the source image
 *   moduleCount: number,
 *   pitchPx: number,
 *   slotCentersPx: number[],   // image-px X coords, one per slot
 *   initialPitchPx: number,
 *   refinement: {
 *     accepted: boolean,
 *     candidatePitchPx: number|null,
 *     pairCount: number,
 *     leftPairCount: number,
 *     rightPairCount: number,
 *     probes: Array<{idx,predicted,refined,snr,sharpness,confident}>,
 *   }
 * }>}
 */
export async function tightenAndChunk(imageBuffer, userBox) {
  const meta = await sharp(imageBuffer).metadata();
  const W = meta.width;
  const H = meta.height;
  const userPx = {
    x0: Math.round(userBox.x * W),
    y0: Math.round(userBox.y * H),
    x1: Math.round((userBox.x + userBox.w) * W),
    y1: Math.round((userBox.y + userBox.h) * H),
  };
  const userW = userPx.x1 - userPx.x0;
  const userH = userPx.y1 - userPx.y0;
  const padX = Math.max(4, Math.round(userW * EDGE_PAD));
  const padY = Math.max(4, Math.round(userH * EDGE_PAD));

  // 1. Per-edge fine-tune — 4 strips searched in parallel.
  const [topY, botY, leftX, rightX] = await Promise.all([
    findHorizontalEdge(imageBuffer, W, H, userPx, userPx.y0, padY),
    findHorizontalEdge(imageBuffer, W, H, userPx, userPx.y1, padY),
    findVerticalEdge(imageBuffer, W, H, userPx, userPx.x0, padX),
    findVerticalEdge(imageBuffer, W, H, userPx, userPx.x1, padX),
  ]);
  const faceWidth = rightX - leftX;
  const faceHeight = botY - topY;

  // 2. Initial pitch from height-anchor formula. The two-anchor tiling
  //    (count from face width, pitch from face_width / count) absorbs any
  //    sub-pixel rounding error and forces slot 0 to sit half-pitch from
  //    the rail-left edge and slot N-1 to sit half-pitch from the right.
  const pxPerMm = faceHeight / MCB_FACE_HEIGHT_MM;
  const modulePxFromHeight = pxPerMm * MODULE_PITCH_MM;
  const moduleCountRaw = faceWidth / modulePxFromHeight;
  const initialModuleCount = Math.max(1, Math.round(moduleCountRaw));
  const initialPitchPx = faceWidth / initialModuleCount;

  // 3. Multi-anchor refinement. Two paths:
  //    • V2 (CCU_PROBE_V2 = 'true', default ON): tall-thin filter + every-
  //      gap probing + consistency rejection + blank-suspect detection +
  //      linear pitch model. See PROBE_V2_* constants block at top of file
  //      for the design rationale.
  //    • V1 (CCU_PROBE_V2 = 'false'): legacy 8-position Sobel-X-on-bottom-
  //      40 % column-sum with same-side pair median. Kept as kill-switch
  //      fallback for any unexpected v2 regression in production.
  let pitchPx = initialPitchPx;
  let moduleCount = initialModuleCount;
  let refinement = {
    accepted: false,
    candidatePitchPx: null,
    pairCount: 0,
    leftPairCount: 0,
    rightPairCount: 0,
    probes: [],
  };
  const v2Enabled = probeV2Enabled() && initialModuleCount >= 8;
  if (v2Enabled) {
    const result = await refineV2(imageBuffer, W, H, {
      topY,
      botY,
      leftX,
      faceWidth,
      faceHeight,
      initialPitchPx,
      initialModuleCount,
    });
    if (result.accepted) {
      pitchPx = result.candidatePitchPx;
      moduleCount = Math.max(1, Math.round(faceWidth / pitchPx));
    }
    const retainedSet = new Set(result.retained.map((r) => r.idx));
    refinement = {
      // Same-shape v1 fields kept populated so the route handler logging
      // works without a code change.
      accepted: result.accepted,
      candidatePitchPx:
        result.candidatePitchPx != null ? Math.round(result.candidatePitchPx * 10) / 10 : null,
      pairCount: result.retained.length, // # anchors retained as proxy
      leftPairCount: result.retained.filter(
        (r) => r.idx <= (result.anchorL?.idx ?? 0) + Math.floor(initialModuleCount / 2)
      ).length,
      rightPairCount: result.retained.filter(
        (r) => r.idx > (result.anchorL?.idx ?? 0) + Math.floor(initialModuleCount / 2)
      ).length,
      probes: result.probes.map((p) => ({
        idx: p.idx,
        predicted: Math.round(p.predictedX),
        refined: Math.round(p.refinedX),
        snr: Math.round(p.snr * 100) / 100,
        sharpness: Math.round(p.sharpness * 100) / 100,
        confident: p.confident,
      })),
      // V2-specific diagnostics.
      version: 'v2',
      pitchLPx: result.pitchL != null ? Math.round(result.pitchL * 10) / 10 : null,
      pitchRPx: result.pitchR != null ? Math.round(result.pitchR * 10) / 10 : null,
      isStretched: result.isStretched,
      retainedIdx: result.retained.map((r) => r.idx),
      blankSuspectIdx: [...result.blankSuspect],
      anchorL: result.anchorL ? { idx: result.anchorL.idx, x: Math.round(result.anchorL.x) } : null,
      anchorR: result.anchorR ? { idx: result.anchorR.idx, x: Math.round(result.anchorR.x) } : null,
    };
    // Slot centres from the v2 model; falls back to two-anchor tiling
    // when no anchors retained (uniform pitch from rail edges).
    const centres = slotCentersV2({
      leftX,
      rightX,
      faceWidth,
      count: moduleCount,
      model: {
        isStretched: result.isStretched,
        pitchL: result.pitchL,
        pitchR: result.pitchR,
        anchorL: result.anchorL,
        anchorR: result.anchorR,
        candidatePitchPx: result.candidatePitchPx,
      },
    });
    return {
      imageWidth: W,
      imageHeight: H,
      railFace: { left: leftX, top: topY, right: rightX, bottom: botY },
      moduleCount,
      pitchPx: faceWidth / moduleCount,
      slotCentersPx: centres,
      initialPitchPx: Math.round(initialPitchPx * 10) / 10,
      refinement,
    };
  }
  if (initialModuleCount >= 8) {
    const halfWidth = Math.max(8, Math.round(initialPitchPx * PROBE_STRIP_HALF_FRAC));
    const stripTop = topY + Math.round(faceHeight * PROBE_BAND_TOP_FRAC);
    const stripHeight = faceHeight - Math.round(faceHeight * PROBE_BAND_TOP_FRAC);
    const idxs = [
      1,
      2,
      3,
      4,
      initialModuleCount - 4,
      initialModuleCount - 3,
      initialModuleCount - 2,
      initialModuleCount - 1,
    ];
    const probes = await Promise.all(
      idxs.map(async (idx) => {
        const predictedX = leftX + initialPitchPx * idx;
        const r = await probeBoundary(
          imageBuffer,
          W,
          H,
          predictedX,
          stripTop,
          stripHeight,
          halfWidth
        );
        return { idx, predictedX, ...r };
      })
    );
    const left = probes.filter((p) => p.idx <= 4 && p.confident);
    const right = probes.filter((p) => p.idx >= initialModuleCount - 4 && p.confident);

    // Same-side pair pitches only — cross-rail pairs (left + right) average
    // their span over many modules, masking the cumulative pitch bias and
    // collapsing to the formula's predicted pitch.
    const collectPairs = (group) => {
      const out = [];
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const span = group[j].idx - group[i].idx;
          if (span <= 0) continue;
          const p = (group[j].refinedX - group[i].refinedX) / span;
          if (Math.abs(p - initialPitchPx) / initialPitchPx > PAIR_DRIFT_MAX) continue;
          out.push(p);
        }
      }
      return out;
    };
    const leftPairs = collectPairs(left);
    const rightPairs = collectPairs(right);
    const allPairs = [...leftPairs, ...rightPairs];
    let candidatePitch = null;
    if (allPairs.length > 0) {
      const sorted = [...allPairs].sort((a, b) => a - b);
      candidatePitch = sorted[Math.floor(sorted.length / 2)];
    }
    const drift =
      candidatePitch != null ? Math.abs(candidatePitch - initialPitchPx) / initialPitchPx : null;
    const accepted = drift != null && drift <= PAIR_DRIFT_MAX;
    if (accepted) {
      pitchPx = candidatePitch;
      moduleCount = Math.max(1, Math.round(faceWidth / pitchPx));
    }
    refinement = {
      accepted,
      candidatePitchPx: candidatePitch != null ? Math.round(candidatePitch * 10) / 10 : null,
      pairCount: allPairs.length,
      leftPairCount: leftPairs.length,
      rightPairCount: rightPairs.length,
      probes: probes.map((p) => ({
        idx: p.idx,
        predicted: Math.round(p.predictedX),
        refined: Math.round(p.refinedX),
        snr: Math.round(p.snr * 100) / 100,
        sharpness: Math.round(p.sharpness * 100) / 100,
        confident: p.confident,
      })),
    };
  }

  // 4. Two-anchor tiling — slot 0 sits half-pitch from rail-left, slot N-1
  //    sits half-pitch from rail-right. Final pitch absorbs any sub-pixel
  //    rounding so chunk boundaries land exactly on the rail edges.
  const tilePitchPx = faceWidth / moduleCount;
  const slotCentersPx = [];
  for (let i = 0; i < moduleCount; i++) {
    slotCentersPx.push(leftX + tilePitchPx * (i + 0.5));
  }

  return {
    imageWidth: W,
    imageHeight: H,
    railFace: { left: leftX, top: topY, right: rightX, bottom: botY },
    moduleCount,
    pitchPx: tilePitchPx,
    slotCentersPx,
    initialPitchPx: Math.round(initialPitchPx * 10) / 10,
    refinement,
  };
}

/**
 * Adapter — convert tightenAndChunk output to the same shape that
 * `prepareGeometry` returns (used by Stage 3 cropSlot + classifySlots).
 *
 * Coordinates: `prepareGeometry` returns positions in 0-1000 normalised
 * space over the source image. We convert image-px → 0-1000 by multiplying
 * by 1000 / imageWidth (or imageHeight for Y).
 */
export function asPreparedGeom(tightened, opts = {}) {
  const { imageWidth, imageHeight, railFace, moduleCount, pitchPx, slotCentersPx } = tightened;
  const xToNorm = (x) => (x / imageWidth) * 1000;
  const yToNorm = (y) => (y / imageHeight) * 1000;
  return {
    schemaVersion: opts.schemaVersion ?? 1,
    moduleCount,
    vlmCount: moduleCount, // no separate VLM count — we derive count from CV
    disagreement: 0,
    lowConfidence: !tightened.refinement.accepted,
    medianRails: {
      rail_top: yToNorm(railFace.top),
      rail_bottom: yToNorm(railFace.bottom),
      rail_left: xToNorm(railFace.left),
      rail_right: xToNorm(railFace.right),
    },
    panelBounds: null,
    slotCentersX: slotCentersPx.map(xToNorm),
    moduleWidth: (pitchPx / imageWidth) * 1000,
    mainSwitchWidth: null,
    mainSwitchCenterX: null,
    mainSwitchSide: null,
    imageWidth,
    imageHeight,
    pitchSource: 'box-tightener',
    cvPitchDiag: {
      pitchPx,
      moduleCountFromCv: moduleCount,
      railWidthPx: railFace.right - railFace.left,
      reason: tightened.refinement.accepted ? null : 'no-multi-anchor-refinement',
    },
    boxTightenRefinement: tightened.refinement, // diagnostic only
  };
}
