/**
 * CCU module-pitch detection via classical computer vision.
 *
 * Replaces the height-anchor calibration (MCB face = 44.5mm) for the case
 * where we have a usable rail bbox from the user's iOS railRoiHint. The
 * height-anchor approach depends on the user's box height being accurate
 * to the visible MCB face — sloppy framing produced systemic over- or
 * under-counts (Wylex Nano photo 2026-04-29: 6% short box → 17 modules
 * instead of 16). This module derives pitch directly from the periodic
 * structure of the MCB row in the image, with no calibration constant.
 *
 * Algorithm:
 *   1. Crop the image to the rail bbox (in pixel coords).
 *   2. Greyscale + light Gaussian blur (kill JPEG noise).
 *   3. Sobel-X kernel → vertical edge magnitude per pixel.
 *   4. Sum |edge| per column → 1D signal across rail width.
 *   5. Autocorrelate the signal across lags MIN_LAG..MAX_LAG → the lag
 *      with maximum correlation (length-normalised) IS the module pitch
 *      in pixels.
 *
 * The pitch number falls out directly with no DIN-pitch / MCB-height
 * standard required. Module count = round(railWidthPx / pitchPx).
 *
 * Compute: ~50–100 ms per typical photo on the Node backend. No external
 * dependencies beyond `sharp` (already in package.json).
 */
import sharp from 'sharp';

// Lag range for the autocorrelation peak hunt. UK domestic MCBs are 17.5mm
// pitch, which at typical phone-shot CCU photos works out to roughly
// 50-300 pixels per module depending on capture resolution.
//
// Lower bound 40 leaves room for very wide-angle shots.
//
// Upper bound used to be a hard 200, but high-resolution phone uploads
// (e.g. 5973×1119, 16.8 px/mm) put the real pitch at ~290 px — well above
// 200 — so the autocorrelator could only find noise inside [40, 200] and
// fell through to the low-confidence path on every prod attempt of the
// 2026-04-30 06:18-06:21 BST Hager job. Confirmed by harness test: at 3.5×
// the corpus photo (5600 px wide, 257 px true pitch), normCorr collapses
// from ~0.5 to 0.13 because the right peak is invisible.
//
// Fix: cap is now a function of rail width (rail / MIN_CYCLES, 4 cycles
// minimum). The MAX_LAG_CEILING below is a safety floor — even on absurdly
// large rails we won't search past 800 px (would be 45 mm/module physical,
// well outside any real DIN board). Performance is fine; autocorrelation
// is O((maxLag - minLag) × signalLength); 5161 wide × 1290 lags = ~6.6M
// ops, single-digit ms.
const MIN_LAG = 40;
const MAX_LAG_CEILING = 800;

// Confidence floor below which we should NOT trust the CV result and fall
// back to the height anchor. Tuned empirically: clean photos with periodic
// structure score 0.5–0.9 here; noisy or aperiodic crops score near zero.
const NORM_CORR_FLOOR = 0.3;

// Minimum number of cycles within the rail width for the autocorrelation
// to be statistically reliable. With fewer cycles (very small CUs, e.g.
// 4-way starter boards), the autocorrelation peak gets noisy.
const MIN_CYCLES = 4;

/**
 * Detect module pitch from a rail bounding box in the image.
 *
 * @param {Buffer} imageBuffer — full original image bytes (JPEG / PNG)
 * @param {{left:number, right:number, top:number, bottom:number}} railBboxPx
 *   — rail bounds IN PIXEL COORDS of the image (not normalised). Caller is
 *   responsible for converting from 0-1000 normalised or 0-1 fractional.
 * @returns {Promise<null | {
 *   pitchPx: number,
 *   normCorr: number,
 *   moduleCount: number,
 *   railWidthPx: number,
 *   railHeightPx: number,
 *   reason?: string,
 * }>}
 *   Returns null when the result is too low-confidence to use (caller should
 *   fall back). On success, `moduleCount = round(railWidthPx / pitchPx)`.
 */
export async function detectModulePitchCv(imageBuffer, railBboxPx) {
  const { left, right, top, bottom } = railBboxPx;
  const railWidthPx = Math.round(right - left);
  const railHeightPx = Math.round(bottom - top);
  if (railWidthPx <= 0 || railHeightPx <= 0) {
    return { ...emptyResult(railWidthPx, railHeightPx), reason: 'empty-bbox' };
  }
  // Need at least MIN_CYCLES * MIN_LAG worth of width for autocorrelation to
  // resolve a peak. If the rail is too narrow, bail early.
  if (railWidthPx < MIN_CYCLES * MIN_LAG) {
    return { ...emptyResult(railWidthPx, railHeightPx), reason: 'rail-too-narrow' };
  }

  const cropX = Math.max(0, Math.round(left));
  const cropY = Math.max(0, Math.round(top));
  const cropW = railWidthPx;
  const cropH = railHeightPx;

  // Crop + greyscale + blur + raw 8-bit pixels in one pipeline.
  const greyBuffer = await sharp(imageBuffer)
    .extract({ left: cropX, top: cropY, width: cropW, height: cropH })
    .greyscale()
    .blur(1.0)
    .raw()
    .toBuffer();

  // Sobel-X (manual loop — sharp's convolve clamps to 8-bit and loses
  // signed gradient magnitude). Sum absolute gradient per column.
  const colSums = sobelXColumnSum(greyBuffer, cropW, cropH);

  // 3-tap moving average smooths single-pixel noise without blurring the
  // periodic structure (period is 50+ px, much wider than 3).
  const smoothed = movingAverage3(colSums);

  const ac = autocorrPeak(
    smoothed,
    MIN_LAG,
    Math.min(MAX_LAG_CEILING, Math.floor(cropW / MIN_CYCLES))
  );

  if (ac.normCorr < NORM_CORR_FLOOR) {
    return {
      ...emptyResult(railWidthPx, railHeightPx),
      pitchPx: ac.lag,
      normCorr: ac.normCorr,
      reason: 'low-confidence',
    };
  }

  const pitchPx = ac.lag;
  const moduleCount = Math.round(railWidthPx / pitchPx);

  return {
    pitchPx,
    normCorr: ac.normCorr,
    moduleCount,
    railWidthPx,
    railHeightPx,
  };
}

// ---------------------------------------------------------------------------
// Internals — exported for unit testing only
// ---------------------------------------------------------------------------

/**
 * Compute the sum of |Sobel-X| per column. greyBuffer is row-major raw 8-bit.
 * Returns Float32Array of length `width`.
 */
export function sobelXColumnSum(greyBuffer, width, height) {
  const colSums = new Float32Array(width);
  // Sobel-X kernel: [-1 0 1; -2 0 2; -1 0 1]
  for (let yy = 1; yy < height - 1; yy++) {
    const yOff = yy * width;
    for (let xx = 1; xx < width - 1; xx++) {
      const idx = yOff + xx;
      const gx =
        -greyBuffer[idx - width - 1] +
        greyBuffer[idx - width + 1] +
        -2 * greyBuffer[idx - 1] +
        2 * greyBuffer[idx + 1] +
        -greyBuffer[idx + width - 1] +
        greyBuffer[idx + width + 1];
      colSums[xx] += Math.abs(gx);
    }
  }
  return colSums;
}

/** 3-tap moving average. Edges keep their input value. */
export function movingAverage3(signal) {
  const out = new Float32Array(signal.length);
  out[0] = signal[0];
  out[signal.length - 1] = signal[signal.length - 1];
  for (let i = 1; i < signal.length - 1; i++) {
    out[i] = (signal[i - 1] + signal[i] + signal[i + 1]) / 3;
  }
  return out;
}

/**
 * Autocorrelation peak in [minLag, maxLag], length-normalised so smaller
 * lags don't accumulate larger sums purely from having more terms. Returns
 * the peak lag and its correlation strength relative to zero-lag.
 */
export function autocorrPeak(signal, minLag, maxLag) {
  // Centre the signal (subtract mean).
  let sum = 0;
  for (let i = 0; i < signal.length; i++) sum += signal[i];
  const mean = sum / signal.length;
  const centred = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) centred[i] = signal[i] - mean;

  // Zero-lag baseline (per-sample variance).
  let zero = 0;
  for (let i = 0; i < centred.length; i++) zero += centred[i] * centred[i];
  const zeroPerSample = centred.length > 0 ? zero / centred.length : 0;

  let bestLag = minLag;
  let bestCorr = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    const limit = centred.length - lag;
    if (limit <= 0) break;
    for (let i = 0; i < limit; i++) corr += centred[i] * centred[i + lag];
    const normalised = corr / limit;
    if (normalised > bestCorr) {
      bestCorr = normalised;
      bestLag = lag;
    }
  }
  return {
    lag: bestLag,
    normCorr: zeroPerSample > 0 ? bestCorr / zeroPerSample : 0,
  };
}

function emptyResult(railWidthPx, railHeightPx) {
  return {
    pitchPx: null,
    normCorr: 0,
    moduleCount: null,
    railWidthPx,
    railHeightPx,
  };
}
