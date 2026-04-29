#!/usr/bin/env node
/**
 * Whole-stack CV prototype for CCU module-count detection.
 *
 * Replaces the height-anchor calibration (MCB_FACE_HEIGHT_MM = 44.5mm) with
 * direct edge detection on the photo. The user's hand-drawn box is treated
 * as a region-of-interest hint only — its precision doesn't matter.
 *
 * Algorithm:
 *   1. Crop to user box (with optional padding).
 *   2. Greyscale + Gaussian blur.
 *   3. Sobel-X (vertical-edge intensity) → column-sum across height.
 *   4. Autocorrelation across lags [50, 200] px → coarse pitch estimate.
 *   5. Peak-pick column-sum, min-separation = pitch × 0.6.
 *   6. Periodicity verification (median-of-spacings ≈ pitch ± 5%).
 *   7. moduleCount = round(railWidth / detectedPitch).
 *
 * Each step writes intermediate stats. For each test photo, also writes a
 * debug PNG showing the column-sum signal with detected peaks marked.
 *
 * Usage:
 *   node scripts/ccu-cv-prototype.mjs                    # all annotated photos
 *   node scripts/ccu-cv-prototype.mjs --id <extractionId> # one photo
 *   node scripts/ccu-cv-prototype.mjs --stress            # also run loose-box + tight-trim variants
 *
 * No Anthropic API calls. No network. ~50–100 ms per photo on the local box.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { detectModulePitchCv } from '../src/extraction/ccu-cv-pitch.js';

const ROOT = path.resolve(import.meta.dirname, 'ccu-cv-corpus');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const ANNOTATIONS = JSON.parse(fs.readFileSync(path.join(ROOT, 'annotations.json'), 'utf8'));

const argv = process.argv.slice(2);
const ONE_ID = argv.includes('--id') ? argv[argv.indexOf('--id') + 1] : null;
const STRESS = argv.includes('--stress');
const VERBOSE = argv.includes('-v') || argv.includes('--verbose');
const DEBUG_DIR = path.join(ROOT, 'debug');
fs.mkdirSync(DEBUG_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// CV core
// ---------------------------------------------------------------------------

/**
 * Crop image to user box (in 0–1 normalised coords) with optional padding.
 * Returns { buffer, width, height } of the cropped image.
 */
async function cropToBox(imageBuffer, userBox, padFrac = 0) {
  const meta = await sharp(imageBuffer).metadata();
  const padX = userBox.w * padFrac;
  const padY = userBox.h * padFrac;
  const x = Math.max(0, Math.round((userBox.x - padX) * meta.width));
  const y = Math.max(0, Math.round((userBox.y - padY) * meta.height));
  const x2 = Math.min(meta.width, Math.round((userBox.x + userBox.w + padX) * meta.width));
  const y2 = Math.min(meta.height, Math.round((userBox.y + userBox.h + padY) * meta.height));
  const w = x2 - x;
  const h = y2 - y;
  const buffer = await sharp(imageBuffer)
    .extract({ left: x, top: y, width: w, height: h })
    .toBuffer();
  return { buffer, width: w, height: h, srcWidth: meta.width, srcHeight: meta.height };
}

/**
 * Greyscale + Gaussian blur + Sobel-X → return Float32Array of column sums of |edge|.
 * Length = cropped image width.
 */
async function columnEdgeSignal(croppedBuffer, width, height) {
  // Greyscale, blur slightly to kill JPEG noise, raw 8-bit pixels out.
  const grey = await sharp(croppedBuffer)
    .greyscale()
    .blur(1.0)
    .raw()
    .toBuffer();
  // Sharp's `convolve()` works for Sobel but returns clamped 8-bit; we lose
  // sign and magnitude info. Implement Sobel-X manually for full precision.
  const colSums = new Float32Array(width);
  for (let yy = 1; yy < height - 1; yy++) {
    const yOff = yy * width;
    for (let xx = 1; xx < width - 1; xx++) {
      const idx = yOff + xx;
      // Sobel-X kernel: [-1 0 1; -2 0 2; -1 0 1]
      const gx =
        -grey[idx - width - 1] + grey[idx - width + 1] +
        -2 * grey[idx - 1]    + 2 * grey[idx + 1] +
        -grey[idx + width - 1] + grey[idx + width + 1];
      colSums[xx] += Math.abs(gx);
    }
  }
  return colSums;
}

/**
 * Autocorrelate the column-sum signal. Returns the lag (in pixels) with the
 * strongest correlation in [minLag, maxLag], plus the correlation value
 * normalised against the zero-lag baseline.
 */
function autocorrPeak(signal, minLag, maxLag) {
  // Subtract mean to centre the signal.
  let sum = 0;
  for (let i = 0; i < signal.length; i++) sum += signal[i];
  const mean = sum / signal.length;
  const centred = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) centred[i] = signal[i] - mean;

  let bestLag = minLag;
  let bestCorr = -Infinity;
  // Zero-lag baseline (= variance × N) for normalisation.
  let zero = 0;
  for (let i = 0; i < centred.length; i++) zero += centred[i] * centred[i];

  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    const limit = centred.length - lag;
    for (let i = 0; i < limit; i++) corr += centred[i] * centred[i + lag];
    // Normalise by sample count to remove the length bias — without this,
    // smaller lags accumulate larger sums simply because there are more
    // (len - lag) terms, biasing the peak below the true pitch.
    const normalised = limit > 0 ? corr / limit : 0;
    if (normalised > bestCorr) {
      bestCorr = normalised;
      bestLag = lag;
    }
  }
  // Re-normalise against zero-lag-per-sample for a unitless score.
  const zeroPerSample = zero / centred.length;
  // Capture the full lag→corr curve for diagnostics — lets us see whether
  // the chosen peak is the true pitch or a sub-harmonic (true pitch should
  // also peak at 2× the chosen lag).
  const curve = new Float32Array(maxLag - minLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    const limit = centred.length - lag;
    for (let i = 0; i < limit; i++) corr += centred[i] * centred[i + lag];
    curve[lag - minLag] = limit > 0 ? corr / limit : 0;
  }
  return {
    lag: bestLag,
    normCorr: zeroPerSample > 0 ? bestCorr / zeroPerSample : 0,
    curve,
    minLag,
  };
}

/**
 * Find local maxima in the column-sum signal that are at least `minSep` apart.
 * Greedy: walk top-down by intensity, mark a peak, exclude its ±minSep
 * neighbourhood, continue until no candidates remain.
 */
function pickPeaks(signal, minSep, threshold) {
  // Build (index, value) pairs above threshold.
  const candidates = [];
  for (let i = 1; i < signal.length - 1; i++) {
    if (signal[i] > threshold && signal[i] >= signal[i - 1] && signal[i] >= signal[i + 1]) {
      candidates.push({ i, v: signal[i] });
    }
  }
  candidates.sort((a, b) => b.v - a.v);

  const taken = new Uint8Array(signal.length);
  const peaks = [];
  for (const { i, v } of candidates) {
    let conflict = false;
    for (let k = Math.max(0, i - minSep); k <= Math.min(signal.length - 1, i + minSep); k++) {
      if (taken[k]) { conflict = true; break; }
    }
    if (conflict) continue;
    peaks.push({ i, v });
    taken[i] = 1;
  }
  peaks.sort((a, b) => a.i - b.i);
  return peaks;
}

/**
 * Render a debug PNG showing the column-sum signal and detected peaks.
 * Width matches the signal length; height is fixed at 200 px.
 */
async function writeDebugPng(outPath, signal, peaks, label) {
  const W = signal.length;
  const H = 220;
  const HEADER = 20;
  const PLOT_H = H - HEADER;
  // Find max for normalisation.
  let max = 0;
  for (let i = 0; i < W; i++) if (signal[i] > max) max = signal[i];
  const buf = Buffer.alloc(W * H * 3, 0xFF); // white background

  // Header bar (light grey)
  for (let y = 0; y < HEADER; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 3;
      buf[o] = 240; buf[o + 1] = 240; buf[o + 2] = 240;
    }
  }

  // Plot signal (dark grey line approximated as filled bars)
  for (let x = 0; x < W; x++) {
    const v = max > 0 ? signal[x] / max : 0;
    const barH = Math.round(v * PLOT_H);
    for (let y = H - barH; y < H; y++) {
      const o = (y * W + x) * 3;
      buf[o] = 100; buf[o + 1] = 100; buf[o + 2] = 100;
    }
  }

  // Peak markers (vertical red lines)
  for (const { i } of peaks) {
    for (let y = HEADER; y < H; y++) {
      const o = (y * W + i) * 3;
      buf[o] = 220; buf[o + 1] = 30; buf[o + 2] = 30;
    }
  }

  await sharp(buf, { raw: { width: W, height: H, channels: 3 } })
    .png()
    .toFile(outPath);
}

/**
 * Sliding-window maximum filter — for each position i, returns max of
 * signal[i-window..i+window]. Used to compute the signal envelope without
 * being fooled by single-pixel dropouts inside the rail (e.g. dim toggle on
 * a partially-shadowed MCB).
 */
function movingMax(signal, window) {
  const out = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) {
    let m = -Infinity;
    const lo = Math.max(0, i - window);
    const hi = Math.min(signal.length - 1, i + window);
    for (let k = lo; k <= hi; k++) if (signal[k] > m) m = signal[k];
    out[i] = m;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Algorithm
// ---------------------------------------------------------------------------

const MIN_LAG = 40;
const MAX_LAG = 200;
const PEAK_MIN_SEP_FRAC = 0.6; // peaks must be ≥ 0.6 × pitch apart
const PEAK_THRESHOLD_FRAC = 0.25; // peaks must be ≥ 25% of max signal value

async function detect(photoPath, userBox, opts = {}) {
  const photoBytes = fs.readFileSync(photoPath);
  const cropped = await cropToBox(photoBytes, userBox, opts.padFrac ?? 0);

  // Cross-check: run the production CV module against the same input, log
  // whether prototype and production agree on pitch.
  const meta = await sharp(photoBytes).metadata();
  const padX = userBox.w * (opts.padFrac ?? 0);
  const padY = userBox.h * (opts.padFrac ?? 0);
  const railBboxPx = {
    left: Math.max(0, (userBox.x - padX) * meta.width),
    right: Math.min(meta.width, (userBox.x + userBox.w + padX) * meta.width),
    top: Math.max(0, (userBox.y - padY) * meta.height),
    bottom: Math.min(meta.height, (userBox.y + userBox.h + padY) * meta.height),
  };
  const prodCv = await detectModulePitchCv(photoBytes, railBboxPx);

  const signal = await columnEdgeSignal(cropped.buffer, cropped.width, cropped.height);

  // Smooth the signal a bit (3-tap moving average) so single-pixel noise
  // doesn't dominate the autocorrelation.
  const smoothed = new Float32Array(signal.length);
  for (let i = 1; i < signal.length - 1; i++) {
    smoothed[i] = (signal[i - 1] + signal[i] + signal[i + 1]) / 3;
  }
  smoothed[0] = signal[0];
  smoothed[signal.length - 1] = signal[signal.length - 1];

  const ac = autocorrPeak(smoothed, MIN_LAG, MAX_LAG);
  const pitchPx = ac.lag;

  // Detect the actual rail extent within the cropped image. The column-sum
  // signal will be high inside the rail (toggles, labels, edges) and low
  // outside (background, casing). Find the leftmost and rightmost columns
  // where a smoothed envelope crosses 30% of the signal max.
  const ENV_WINDOW = pitchPx; // average over one module of pitch
  const envelope = movingMax(smoothed, ENV_WINDOW);
  let envMax = 0;
  for (let i = 0; i < envelope.length; i++) if (envelope[i] > envMax) envMax = envelope[i];
  const envThreshold = 0.3 * envMax;
  let railLeft = 0;
  for (let i = 0; i < envelope.length; i++) {
    if (envelope[i] >= envThreshold) { railLeft = i; break; }
  }
  let railRight = envelope.length - 1;
  for (let i = envelope.length - 1; i >= 0; i--) {
    if (envelope[i] >= envThreshold) { railRight = i; break; }
  }
  const railWidthPxFromEnvelope = Math.max(1, railRight - railLeft);

  // Threshold = fraction of the max value within the signal.
  let max = 0;
  for (let i = 0; i < smoothed.length; i++) if (smoothed[i] > max) max = smoothed[i];
  const threshold = PEAK_THRESHOLD_FRAC * max;

  const peaks = pickPeaks(smoothed, Math.round(pitchPx * PEAK_MIN_SEP_FRAC), threshold);

  // Median spacing between peaks (alternative pitch estimate).
  const spacings = [];
  for (let i = 1; i < peaks.length; i++) spacings.push(peaks[i].i - peaks[i - 1].i);
  spacings.sort((a, b) => a - b);
  const medianSpacing = spacings.length > 0 ? spacings[Math.floor(spacings.length / 2)] : null;

  // Use cropWidth (= user's box width) as the rail width. Envelope-based
  // rail-edge detection turned out to over-shrink boards with low-texture
  // devices on the rail (RCDs without toggles, main switches), so for v1
  // we trust the user's box and tackle loose-box recovery separately.
  const railWidthPx = cropped.width;
  const moduleCountFromAutocorr = Math.round(railWidthPx / pitchPx);
  const moduleCountFromPeaks = peaks.length > 1 ? peaks.length - 1 : null;
  const moduleCountFromMedian = medianSpacing ? Math.round(railWidthPx / medianSpacing) : null;

  return {
    cropWidth: cropped.width,
    cropHeight: cropped.height,
    pitchPx,
    autocorrNorm: ac.normCorr,
    peakCount: peaks.length,
    medianSpacing,
    railLeft,
    railRight,
    railWidthPxFromEnvelope,
    moduleCountFromAutocorr,
    moduleCountFromPeaks,
    moduleCountFromMedian,
    signal: smoothed,
    peaks,
    _acCurve: ac.curve,
    _acMinLag: ac.minLag,
    prodCv, // production-module result for cross-check
  };
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

const annotations = ANNOTATIONS.annotations || {};
const targets = Object.keys(annotations).filter((id) => annotations[id].groundTruth != null);
const filtered = ONE_ID ? targets.filter((id) => id === ONE_ID) : targets;

if (filtered.length === 0) {
  console.error(ONE_ID ? `[error] no annotated entry for id=${ONE_ID}` : '[error] no annotated entries in annotations.json');
  process.exit(1);
}

const results = [];
for (const id of filtered) {
  const ann = annotations[id];
  const entry = MANIFEST.entries.find((e) => e.extractionId === id);
  if (!entry) {
    console.warn(`[skip] ${id} not in manifest`);
    continue;
  }
  if (!entry.userBox) {
    console.warn(`[skip] ${id} no userBox`);
    continue;
  }
  const photoPath = path.join(ROOT, entry.photo);

  const variants = [{ tag: 'tight', padFrac: 0 }];
  if (STRESS) {
    variants.push({ tag: 'loose+20%', padFrac: 0.20 });
    variants.push({ tag: 'tight-right-trim', padFrac: 0, mutateBox: (b) => ({ ...b, w: b.w * 0.92 }) });
    variants.push({ tag: 'tight-left-trim', padFrac: 0, mutateBox: (b) => ({ ...b, x: b.x + b.w * 0.08, w: b.w * 0.92 }) });
  }

  const expected = ann.groundTruth;
  console.log(`\n--- ${id} (${entry.boardManufacturer ?? '?'} ${entry.boardModel ?? ''}, expected ${expected}) ---`);
  if (ann.notes) console.log(`    note: ${ann.notes}`);

  for (const v of variants) {
    const box = v.mutateBox ? v.mutateBox(entry.userBox) : entry.userBox;
    const r = await detect(photoPath, box, { padFrac: v.padFrac });
    const choices = [r.moduleCountFromAutocorr, r.moduleCountFromPeaks, r.moduleCountFromMedian].filter((x) => x != null);
    const best = pickBestEstimate(choices, r);
    const ok = best === expected;
    const prodTag = r.prodCv?.pitchPx
      ? `prod=${r.prodCv.pitchPx}px/${r.prodCv.moduleCount}mod(nc=${r.prodCv.normCorr.toFixed(2)})`
      : `prod=null(${r.prodCv?.reason ?? 'err'})`;
    console.log(
      `    [${v.tag.padEnd(18)}] crop=${r.cropWidth}×${r.cropHeight}  rail=[${r.railLeft},${r.railRight}](${r.railWidthPxFromEnvelope}px)  ` +
      `pitchPx=${r.pitchPx.toString().padStart(4)}  peaks=${r.peakCount.toString().padStart(3)}  ` +
      `→ autoc=${r.moduleCountFromAutocorr} peaks=${r.moduleCountFromPeaks ?? '—'} median=${r.moduleCountFromMedian ?? '—'}  ${prodTag}  ` +
      `${ok ? '✓' : '✗'} (best=${best})`
    );

    // Write debug PNG for the primary tight variant only.
    if (v.tag === 'tight') {
      const dbg = path.join(DEBUG_DIR, `${id}_signal.png`);
      await writeDebugPng(dbg, r.signal, r.peaks, id);
      if (VERBOSE) {
        console.log(`    debug → ${path.relative(process.cwd(), dbg)}`);
        // Print the top-5 autocorrelation peaks so we can see if the chosen
        // lag is the dominant one or has competition.
        if (r._acCurve) {
          const peaks = [];
          for (let i = 1; i < r._acCurve.length - 1; i++) {
            if (r._acCurve[i] > r._acCurve[i - 1] && r._acCurve[i] > r._acCurve[i + 1]) {
              peaks.push({ lag: i + r._acMinLag, val: r._acCurve[i] });
            }
          }
          peaks.sort((a, b) => b.val - a.val);
          const top = peaks.slice(0, 5).map((p) => `${p.lag}px:${p.val.toFixed(0)}`).join('  ');
          console.log(`    autocorr top-5 peaks → ${top}`);
        }
      }
    }

    results.push({ id, variant: v.tag, expected, best, ok, ...r, signal: undefined, peaks: undefined });
  }
}

const tightResults = results.filter((r) => r.variant === 'tight');
const passed = tightResults.filter((r) => r.ok).length;
console.log(`\n=== Tight (default) variant: ${passed}/${tightResults.length} pass ===`);

if (STRESS) {
  for (const tag of ['loose+20%', 'tight-right-trim', 'tight-left-trim']) {
    const v = results.filter((r) => r.variant === tag);
    const p = v.filter((r) => r.ok).length;
    console.log(`=== ${tag.padEnd(18)}: ${p}/${v.length} pass ===`);
  }
}

function pickBestEstimate(choices, r) {
  // Heuristic: prefer the autocorrelation estimate when normCorr is strong;
  // fall back to median spacing if peak detection looks reliable; otherwise
  // peaks-as-count. v1 — refine after seeing real data.
  if (r.autocorrNorm > 0.4 && r.moduleCountFromAutocorr > 0) return r.moduleCountFromAutocorr;
  if (r.medianSpacing != null && r.peakCount > 4) return r.moduleCountFromMedian;
  return r.moduleCountFromPeaks ?? r.moduleCountFromAutocorr;
}
