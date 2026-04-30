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

  // 3. Multi-anchor refinement — 8 probes (4 left + 4 right). Skip when
  //    initialModuleCount < 8 (board too small to support anchors near
  //    both ends; just trust the height-anchor pitch).
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
