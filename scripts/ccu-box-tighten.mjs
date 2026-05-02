#!/usr/bin/env node
/**
 * Box-tightening harness for CCU rail RoI hints.
 *
 * Single-purpose: take the user's iOS railRoiHint box and produce a corrected
 * rail bbox by examining the actual rail features in the photo. Bidirectional —
 * tightens overshooting boxes AND expands clipped boxes by searching ±15 %
 * outside the user's box before locking in the rail edges.
 *
 * No CV-pitch, no autocorr ensemble, no module counting. Pure rail-edge
 * detection. The downstream height-anchor / chunker can consume the corrected
 * bbox the same way it consumes the user's raw box today.
 *
 * Algorithm:
 *   1. Pad the user box by ±15 % on every side → search region.
 *   2. Crop the image to the search region; greyscale + light blur.
 *   3. Sobel-Y row-sum across the search width → 1-D row-edge signal.
 *   4. Active vertical band = first/last row exceeding 30 % of max-row-sum.
 *      This is the rail face top → bottom.
 *   5. Sobel-X column-sum restricted to those rows → 1-D column-edge signal.
 *   6. Active horizontal band = first/last column exceeding 20 % of
 *      max-col-sum. Lower threshold than vertical because module-pitch peaks
 *      vary a lot column-to-column.
 *   7. Locate the central body seam (strongest peak between top and bottom
 *      after excluding the top/bottom 20 % of the band) → seamRatio.
 *      seamRatio in [0.30, 0.55] = valid tight bbox; outside that = the
 *      detected band probably includes silkscreen labels or doesn't bound
 *      the actual face.
 *
 * Usage:
 *   node scripts/ccu-box-tighten.mjs                 # run all annotated photos
 *   node scripts/ccu-box-tighten.mjs --id <id>       # single photo
 *   node scripts/ccu-box-tighten.mjs --stress        # also run loose/short stress variants
 *   node scripts/ccu-box-tighten.mjs --icloud        # mirror overlays to iCloud Drive
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, 'ccu-cv-corpus');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const ANNOTATIONS = JSON.parse(fs.readFileSync(path.join(ROOT, 'annotations.json'), 'utf8'));
const DEBUG_DIR = path.join(ROOT, 'debug-tighten');
fs.mkdirSync(DEBUG_DIR, { recursive: true });
const ICLOUD = path.join(os.homedir(), 'Library/Mobile Documents/com~apple~CloudDocs');

const argv = process.argv.slice(2);
const ONE_ID = argv.includes('--id') ? argv[argv.indexOf('--id') + 1] : null;
const STRESS = argv.includes('--stress');
const TO_ICLOUD = argv.includes('--icloud');
// `--all` includes corpus entries that don't have ground-truth annotations.
// They get overlays + per-photo telemetry but don't contribute to the
// count-accuracy summary.
const ALL = argv.includes('--all');

// Per-edge fine-tune algorithm:
//   For each of the 4 edges of the user's box, search a narrow strip ±EDGE_PAD
//   wide centred on that edge. Find the strongest perpendicular-gradient
//   row/column inside the strip — that's the actual rail edge. Move the user's
//   edge to it.
//
// EDGE_PAD = 0.02: the algorithm can shift each edge by at most 2 % of the
// perpendicular box dimension. Tightened from 5 % after the Protek 2026-04-30
// run moved the right edge 61 px (~ 0.84 of a full module pitch), which is
// too far for a single edge-tune — at that magnitude the strip can pick up
// the boundary BETWEEN modules instead of the rail-end. 2 % keeps each edge
// move under ~ 0.3 of a module on a typical 16–18-module board.
const EDGE_PAD = 0.02;

// Seam validation — keeps the bands honest. Manufacturer-dependent
// (Hager ~0.29, Protek ~0.37, Wylex ~0.56), so widened to [0.25, 0.60].
const SEAM_MIN = 0.25;
const SEAM_MAX = 0.60;

// DIN 43880 / 60898 physical constants for the height-width formula.
//   MCB_FACE_HEIGHT_MM — 44.5 mm front-zone height of the MCB face on a
//                       TH35 DIN rail (the seam-validated dimension).
//   MODULE_PITCH_MM    — 17.5 mm per "TE" (Teilungseinheit) — the strict
//                       DIN 43880 module unit. Some sources round to 18 mm
//                       casually, but the rail is laid out on 17.5 mm
//                       centres, so the chunker must use 17.5 to map a
//                       detected rail width to module count correctly.
const MCB_FACE_HEIGHT_MM = 44.5;
const MODULE_PITCH_MM = 17.5;

// ---------------------------------------------------------------------------
// Edge signals
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
        -grey[i - width - 1] - 2 * grey[i - width] - grey[i - width + 1] +
        grey[i + width - 1] + 2 * grey[i + width] + grey[i + width + 1];
      s += Math.abs(gy);
    }
    rows[yy] = s;
  }
  return rows;
}

/** Sobel-X column-sum, optionally restricted to a vertical band [yLo, yHi). */
async function sobelXColSum(buffer, width, height, yLo = 1, yHi = null) {
  const grey = await sharp(buffer).greyscale().blur(0.5).raw().toBuffer();
  const yEnd = yHi ?? height - 1;
  const cols = new Float32Array(width);
  for (let yy = Math.max(1, yLo); yy < Math.min(yEnd, height - 1); yy++) {
    const off = yy * width;
    for (let xx = 1; xx < width - 1; xx++) {
      const i = off + xx;
      const gx =
        -grey[i - width - 1] + grey[i - width + 1] +
        -2 * grey[i - 1]    + 2 * grey[i + 1] +
        -grey[i + width - 1] + grey[i + width + 1];
      cols[xx] += Math.abs(gx);
    }
  }
  return cols;
}

// ---------------------------------------------------------------------------
// Probe detectors (A and B) — replace the legacy column-sum-on-bottom-40 %
// approach that locked onto test buttons + rating-label text edges instead
// of the actual inter-device seam on Crabtree boards.
// ---------------------------------------------------------------------------

/**
 * Detector A — TALL-THIN filter.
 *
 * Real device-to-device seams run UNBROKEN from rail-top to rail-bottom. Test
 * buttons, rating-label text, and toggle slits all live in only a fraction
 * of the rail face. Score each column by the PRODUCT of three column-sum-of
 * -|Sobel-X| signals: full height × top 10 % × bottom 10 %. A column that
 * has no signal in any one band multiplies through to ~0; a column with
 * signal across the whole height multiplies to a high product. The product
 * is then normalised and treated as the column's "tall-thin score".
 */
async function tallThinScore(buffer, width, height) {
  const grey = await sharp(buffer).greyscale().blur(0.5).raw().toBuffer();
  const fullCols = new Float32Array(width);
  const topCols = new Float32Array(width);
  const botCols = new Float32Array(width);
  const topEnd = Math.max(2, Math.floor(height * 0.10));
  const botStart = Math.min(height - 2, Math.ceil(height * 0.90));
  for (let yy = 1; yy < height - 1; yy++) {
    const off = yy * width;
    for (let xx = 1; xx < width - 1; xx++) {
      const i = off + xx;
      const gx =
        -grey[i - width - 1] + grey[i - width + 1] +
        -2 * grey[i - 1]    + 2 * grey[i + 1] +
        -grey[i + width - 1] + grey[i + width + 1];
      const a = Math.abs(gx);
      fullCols[xx] += a;
      if (yy <= topEnd) topCols[xx] += a;
      if (yy >= botStart) botCols[xx] += a;
    }
  }
  // Normalise each band to [0,1] so the product isn't dominated by absolute
  // gradient magnitude — what matters is presence-of-signal in all three.
  const nm = (arr) => {
    let max = 0;
    for (const v of arr) if (v > max) max = v;
    if (max <= 0) return arr;
    const out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) out[i] = arr[i] / max;
    return out;
  };
  const full = nm(fullCols), top = nm(topCols), bot = nm(botCols);
  const score = new Float32Array(width);
  for (let i = 0; i < width; i++) score[i] = full[i] * top[i] * bot[i];
  return score;
}

/**
 * Detector B — DARK-VALLEY filter.
 *
 * The gap between two clipped-on DIN devices reveals the underlying rail
 * (metallic grey, often shadowed) — that gap appears as a NARROW DARK
 * COLUMN flanked by the bright body plastic of both devices. Score each
 * column by how much darker its median-brightness is than the local
 * neighbourhood (excluding self). Real seams: deep valley. Test buttons:
 * dark in middle but only span ~10 % of rail height, so the column-median
 * is barely darker than a body-plastic column.
 */
async function darkValleyScore(buffer, width, height) {
  const grey = await sharp(buffer).greyscale().blur(0.5).raw().toBuffer();
  // Per-column median brightness (uses the FULL strip height — a real seam
  // is dark across most of the column).
  const colBright = new Float32Array(width);
  const samples = new Float32Array(height);
  for (let xx = 0; xx < width; xx++) {
    for (let yy = 0; yy < height; yy++) samples[yy] = grey[yy * width + xx];
    // Quick median via sort copy (height small enough for this not to matter).
    const sorted = Array.from(samples).sort((a, b) => a - b);
    colBright[xx] = sorted[Math.floor(sorted.length / 2)];
  }
  // Valley score = (mean brightness of neighbourhood) − (this column's
  // brightness). Positive when this column is darker than its surroundings.
  // Neighbourhood radius scales with strip width (covers 1-2 device-width
  // candidate so we can compare the seam against true body-plastic).
  const radius = Math.max(3, Math.floor(width * 0.20));
  const score = new Float32Array(width);
  for (let i = 0; i < width; i++) {
    let sum = 0, count = 0;
    for (let j = i - radius; j <= i + radius; j++) {
      if (j < 0 || j >= width || j === i) continue;
      sum += colBright[j];
      count++;
    }
    const nbrMean = count > 0 ? sum / count : 0;
    score[i] = Math.max(0, nbrMean - colBright[i]);
  }
  return score;
}

/**
 * Find the strongest peak in `signal` plus the second-largest local maximum
 * and the mean. Shared by both detectors so the SNR / sharpness math stays
 * identical and the two are directly comparable.
 */
function peakStats(signal) {
  let peakI = 0, peakV = -Infinity, secondV = -Infinity, sum = 0;
  const n = signal.length;
  for (let i = 1; i < n - 1; i++) {
    const v = signal[i];
    sum += v;
    if (v > peakV) { secondV = peakV; peakV = v; peakI = i; }
    else if (v > secondV) { secondV = v; }
  }
  const mean = sum / Math.max(1, n - 2);
  const snr = mean > 0 ? peakV / mean : 0;
  const sharpness = secondV > 0 ? peakV / secondV : (peakV > 0 ? 5 : 0);
  return { peakI, peakV, secondV, mean, snr, sharpness };
}

function smooth3(signal) {
  const out = new Float32Array(signal.length);
  out[0] = signal[0];
  out[signal.length - 1] = signal[signal.length - 1];
  for (let i = 1; i < signal.length - 1; i++) out[i] = (signal[i - 1] + signal[i] + signal[i + 1]) / 3;
  return out;
}

/**
 * Find all contiguous active bands in `signal` (runs above `threshFrac × max`,
 * tolerating valleys up to `gapTolerance` samples wide), then return the one
 * whose extent best overlaps the seed index. Falls back to the largest band
 * if none contain the seed.
 *
 * Rationale: the rail face's row-signal has multiple sub-threshold valleys
 * between toggle features, so a single run-detection algorithm needs to
 * bridge those gaps. But there are often UNRELATED active regions far from
 * the rail (silkscreen text below the rail, "ON OFF" labels at the edges) —
 * those should be excluded by the seed-overlap selection.
 */
function activeBandContaining(signal, threshFrac, seedIdx, gapTolerance = 4) {
  let max = 0;
  for (const v of signal) if (v > max) max = v;
  if (max <= 0) return null;
  const thresh = max * threshFrac;

  // Sweep left-to-right, recording every contiguous above-threshold run with
  // gap tolerance.
  const bands = [];
  let runLo = -1, lastAbove = -1, gap = 0;
  for (let i = 0; i < signal.length; i++) {
    if (signal[i] >= thresh) {
      if (runLo < 0) runLo = i;
      lastAbove = i;
      gap = 0;
    } else {
      if (runLo < 0) continue;
      gap++;
      if (gap > gapTolerance) {
        bands.push({ lo: runLo, hi: lastAbove });
        runLo = -1;
        gap = 0;
      }
    }
  }
  if (runLo >= 0) bands.push({ lo: runLo, hi: lastAbove });
  if (bands.length === 0) return null;

  // Pick the band that contains the seed; otherwise the band whose centre
  // is nearest the seed; otherwise the largest band.
  const containing = bands.find((b) => seedIdx >= b.lo && seedIdx <= b.hi);
  let chosen;
  if (containing) {
    chosen = containing;
  } else {
    chosen = bands.slice().sort((a, b) => {
      const da = Math.abs((a.lo + a.hi) / 2 - seedIdx);
      const db = Math.abs((b.lo + b.hi) / 2 - seedIdx);
      return da - db;
    })[0];
  }
  return { lo: chosen.lo, hi: chosen.hi, max, thresh, allBands: bands };
}

/**
 * Strongest local maximum within the central band [bandLo, bandHi], excluding
 * the outer 20 % at each end. Used as the body-seam locator.
 */
function findCentralPeak(signal, bandLo, bandHi) {
  const span = bandHi - bandLo;
  if (span < 6) return null;
  const innerLo = bandLo + Math.floor(span * 0.20);
  const innerHi = bandHi - Math.floor(span * 0.20);
  let peakY = -1, peakV = -Infinity;
  for (let i = innerLo + 1; i <= innerHi - 1; i++) {
    if (signal[i] >= signal[i - 1] && signal[i] >= signal[i + 1] && signal[i] > peakV) {
      peakV = signal[i];
      peakY = i;
    }
  }
  return peakY < 0 ? null : { y: peakY, v: peakV };
}

// ---------------------------------------------------------------------------
// Tightener
// ---------------------------------------------------------------------------

/**
 * Per-edge box fine-tuner.
 *
 * Bounded local search: for each of the 4 edges of the user's box, examine a
 * strip ±EDGE_PAD of the perpendicular dimension wide, centred on the user's
 * edge. Find the strongest perpendicular-gradient row/column inside the strip
 * → that's the actual rail edge. Move the user's edge to it.
 *
 * Bounded by EDGE_PAD: each edge can shift at most 5 % of the box dimension
 * in either direction. Designed for the realistic case where the user crops
 * close to the rail and just needs each edge nudged onto the actual MCB face
 * boundary. The algorithm cannot recover wholesale-clipped devices (>5 %
 * off) — that's outside the design envelope.
 */
export async function tightenBox(imageBuffer, userBox) {
  const meta = await sharp(imageBuffer).metadata();
  const W = meta.width, H = meta.height;

  // User-box edges in image px.
  const userPx = {
    x0: Math.round(userBox.x * W),
    y0: Math.round(userBox.y * H),
    x1: Math.round((userBox.x + userBox.w) * W),
    y1: Math.round((userBox.y + userBox.h) * H),
  };
  const userBoxWpx = userPx.x1 - userPx.x0;
  const userBoxHpx = userPx.y1 - userPx.y0;
  // Strip half-width = 5 % of the perpendicular box dimension.
  const padXpx = Math.max(4, Math.round(userBoxWpx * EDGE_PAD));
  const padYpx = Math.max(4, Math.round(userBoxHpx * EDGE_PAD));

  // Find the strongest row of horizontal edges within a strip. The strip is
  // the full user-box width × (2 × padYpx) tall, centred on `centreYpx`.
  // Restricting the X span to the user box width (not the padded image)
  // prevents silkscreen labels beside the rail from biasing the row signal.
  async function findHorizontalEdge(centreYpx) {
    const stripY0 = Math.max(0, centreYpx - padYpx);
    const stripY1 = Math.min(H, centreYpx + padYpx);
    const stripH = stripY1 - stripY0;
    if (stripH < 3) return { y: centreYpx, score: 0, snr: 0 };
    const stripBuf = await sharp(imageBuffer)
      .extract({
        left: Math.max(0, userPx.x0),
        top: stripY0,
        width: Math.min(W - userPx.x0, userBoxWpx),
        height: stripH,
      })
      .toBuffer();
    const rowRaw = await sobelYRowSum(stripBuf, userBoxWpx, stripH);
    const rowSig = smooth3(rowRaw);
    let peakI = 0, peakV = -Infinity, sum = 0;
    for (let i = 1; i < stripH - 1; i++) {
      if (rowSig[i] > peakV) { peakV = rowSig[i]; peakI = i; }
      sum += rowSig[i];
    }
    const mean = sum / Math.max(1, stripH - 2);
    return { y: stripY0 + peakI, score: peakV, snr: mean > 0 ? peakV / mean : 0 };
  }

  // Find the strongest column of vertical edges within a strip. Strip is
  // (2 × padXpx) wide × the user-box height tall.
  async function findVerticalEdge(centreXpx) {
    const stripX0 = Math.max(0, centreXpx - padXpx);
    const stripX1 = Math.min(W, centreXpx + padXpx);
    const stripW = stripX1 - stripX0;
    if (stripW < 3) return { x: centreXpx, score: 0, snr: 0 };
    const stripBuf = await sharp(imageBuffer)
      .extract({
        left: stripX0,
        top: Math.max(0, userPx.y0),
        width: stripW,
        height: Math.min(H - userPx.y0, userBoxHpx),
      })
      .toBuffer();
    const colRaw = await sobelXColSum(stripBuf, stripW, userBoxHpx);
    const colSig = smooth3(colRaw);
    let peakI = 0, peakV = -Infinity, sum = 0;
    for (let i = 1; i < stripW - 1; i++) {
      if (colSig[i] > peakV) { peakV = colSig[i]; peakI = i; }
      sum += colSig[i];
    }
    const mean = sum / Math.max(1, stripW - 2);
    return { x: stripX0 + peakI, score: peakV, snr: mean > 0 ? peakV / mean : 0 };
  }

  // Resolve all 4 edges in parallel.
  const [topR, botR, leftR, rightR] = await Promise.all([
    findHorizontalEdge(userPx.y0),
    findHorizontalEdge(userPx.y1),
    findVerticalEdge(userPx.x0),
    findVerticalEdge(userPx.x1),
  ]);

  const newTopY = topR.y, newBotY = botR.y;
  const newLeftX = leftR.x, newRightX = rightR.x;

  // --- Sanity / seam validation -------------------------------------------
  // Find the seam inside the new face (strongest row peak between top and
  // bottom, excluding the outer 20 %) — used purely as a confidence signal.
  const newFaceHeight = newBotY - newTopY;
  const newFaceWidth = newRightX - newLeftX;
  let seamY = null, seamRatio = null;
  if (newFaceHeight > 10) {
    const seamStripBuf = await sharp(imageBuffer)
      .extract({
        left: Math.max(0, newLeftX),
        top: newTopY,
        width: Math.max(1, newRightX - newLeftX),
        height: newFaceHeight,
      })
      .toBuffer();
    const rowRaw = await sobelYRowSum(seamStripBuf, newFaceWidth, newFaceHeight);
    const rowSig = smooth3(rowRaw);
    const seam = findCentralPeak(rowSig, 0, newFaceHeight - 1);
    if (seam) {
      seamY = newTopY + seam.y;
      seamRatio = seam.y / newFaceHeight;
    }
  }
  const tight = seamRatio != null && seamRatio >= SEAM_MIN && seamRatio <= SEAM_MAX;

  // --- Build outputs --------------------------------------------------------
  const tightenedBox = {
    x: newLeftX / W,
    y: newTopY / H,
    w: (newRightX - newLeftX) / W,
    h: (newBotY - newTopY) / H,
  };
  const diffPx = {
    top: newTopY - userPx.y0,
    bottom: newBotY - userPx.y1,
    left: newLeftX - userPx.x0,
    right: newRightX - userPx.x1,
  };

  // --- Height-width formula (DIN 43880) — initial pitch -------------------
  const pxPerMm = newFaceHeight / MCB_FACE_HEIGHT_MM;
  const modulePxFromHeight = pxPerMm * MODULE_PITCH_MM;
  const moduleCountRaw = newFaceWidth / modulePxFromHeight;
  const initialModuleCount = Math.max(1, Math.round(moduleCountRaw));
  const initialPitchPx = newFaceWidth / initialModuleCount;

  // --- Multi-anchor pitch refinement with confidence filtering --------------
  // The DIN 43880 17.5 mm constant is nominal — Protek HDM modules sit at
  // ~16.5 mm, older Hager at ~18.5 mm. After the initial chunk we know
  // roughly where boundaries SHOULD be; we then probe several boundaries
  // directly in the photo and derive the actual pitch from a consensus of
  // the high-confidence detections.
  //
  // Probe 8 boundaries (4 near the left edge, 4 near the right). Some will
  // land in the middle of a 2-module device (e.g. a 2-pole RCD body) where
  // there is no real boundary to find; the confidence rating discards
  // those measurements rather than letting a low-quality peak drive the
  // pitch estimate.
  //
  // Confidence per boundary:
  //   SNR        peakSignal / meanSignal across the strip — only "this
  //              strip has any signal at all" gate. Used to drop
  //              hopelessly noisy probes.
  //   sharpness  peakSignal / second-highest peak in the strip — high
  //              when the winner is singular, low when the strip is a
  //              plateau of similar gradients.
  //   centred    1 - |refined - predicted| / stripHalfWidth — informational
  //              only; we DON'T penalize off-centre peaks because if the
  //              initial pitch is wrong, all real boundaries land off
  //              their predictions in a systematic way (and the median of
  //              pair-wise pitches recovers the true pitch from those).
  // A probe contributes to the pitch estimate when SNR ≥ 1.4 AND
  // sharpness ≥ 1.05 (loose — even "noisy plateau" probes can still
  // contribute via the median once enough pairs are in play).
  let refinedPitchPx = initialPitchPx;
  let refinedModuleCount = initialModuleCount;
  let pitchDiag = null;
  // A/B detector outputs are computed in parallel; the harness picks one to
  // drive the slot grid (Detector A = tall-thin filter by default — see
  // PRIMARY_DETECTOR below). Both sets of refined positions / pitches are
  // surfaced in pitchDiag for side-by-side comparison.
  const PRIMARY_DETECTOR = (process.env.PROBE_DETECTOR || 'A').toUpperCase();
  if (initialModuleCount >= 8) {
    // Strip half-width = 25 % of initial pitch. Both detectors operate on
    // the FULL rail face height (not just the bottom 40 % the legacy
    // Sobel-X approach used) — Detector A *requires* the full height to
    // distinguish full-column features (seams) from short ones (test
    // buttons, rating-label text); Detector B's column-median equally
    // benefits from sampling the whole device face.
    const stripHalfWidth = Math.max(8, Math.round(initialPitchPx * 0.25));
    const stripTop = newTopY;
    const stripHeight = newFaceHeight;

    // Step 2: probe EVERY interior gap, idx 1 through N-1. The previous
    // 8-position scheme ([1..4, N-4..N-1]) starved the algorithm on any
    // rail with fewer-than-8 modules and gave it no signal in the middle
    // of the rail where perspective stretch needs the most evidence.
    const boundaryIndices = [];
    for (let i = 1; i < initialModuleCount; i++) boundaryIndices.push(i);

    const probes = await Promise.all(
      boundaryIndices.map(async (idx) => {
        const predictedX = newLeftX + initialPitchPx * idx;
        const stripX0 = Math.max(0, Math.round(predictedX - stripHalfWidth));
        const stripX1 = Math.min(W, Math.round(predictedX + stripHalfWidth));
        const stripW = stripX1 - stripX0;
        const blank = { refinedX: predictedX, snr: 0, sharpness: 0, confident: false };
        if (stripW < 4 || stripHeight < 4) {
          return { idx, predictedX, a: blank, b: blank, centred: 0 };
        }
        const stripBuf = await sharp(imageBuffer)
          .extract({ left: stripX0, top: stripTop, width: stripW, height: stripHeight })
          .toBuffer();
        // Run BOTH detectors on the same strip in parallel.
        const [sigA, sigB] = await Promise.all([
          tallThinScore(stripBuf, stripW, stripHeight).then(smooth3),
          darkValleyScore(stripBuf, stripW, stripHeight).then(smooth3),
        ]);
        const sa = peakStats(sigA);
        const sb = peakStats(sigB);
        const a = {
          refinedX: stripX0 + sa.peakI,
          snr: sa.snr,
          sharpness: sa.sharpness,
          // Detector A's product score amplifies sharpness — use a slightly
          // looser sharpness floor (1.03) but keep the SNR floor at 1.4
          // since the absolute magnitude story is similar.
          confident: sa.snr >= 1.4 && sa.sharpness >= 1.03,
        };
        const b = {
          refinedX: stripX0 + sb.peakI,
          snr: sb.snr,
          sharpness: sb.sharpness,
          // Detector B's score is brightness-difference (0–255 scale typical
          // peak 5–30); the SNR / sharpness ratios behave like edge ratios
          // so the same 1.4 / 1.03 floors are reasonable as a starting
          // point. Tighten in a follow-up if A/B comparison reveals false
          // positives at the boundaries of the floor.
          confident: sb.snr >= 1.4 && sb.sharpness >= 1.03,
        };
        return { idx, predictedX, a, b };
      })
    );

    // Step 2: consistency-checked anchor model per detector.
    //
    // 1. Collect every confident probe with (idx, refined x).
    // 2. Compute a working pitch from short-span (≤3) adjacent pair-pitches.
    // 3. Iteratively reject probes whose refined position deviates more
    //    than ±15 % of working pitch from the position predicted by
    //    "anchor at rightmost retained probe + walk leftward at working
    //    pitch". Repeat until stable.
    // 4. Output:
    //      • retained anchors (idx + refined x) — used as the grid pinning points
    //      • pitchL  (local pitch from leftmost two retained probes)
    //      • pitchR  (local pitch from rightmost two retained probes)
    //      • candidatePitchPx (mean of pitchL + pitchR — for module-count rounding)
    //
    // pitchL ≠ pitchR captures perspective stretch directly. The grid
    // builder uses both ends and interpolates linearly between them.
    const buildAnchorModel = (key) => {
      const all = probes
        .filter((p) => p[key].confident)
        .map((p) => ({
          idx: p.idx,
          x: p[key].refinedX,
          snr: p[key].snr,
          sharpness: p[key].sharpness,
        }))
        .sort((u, v) => u.idx - v.idx);
      const allIdx = all.map((p) => p.idx);

      if (all.length < 2) {
        return {
          confidentCount: all.length,
          retainedIdx: allIdx,
          rejectedIdx: [],
          pairs: [],
          candidatePitchPx: all.length === 1 ? initialPitchPx : null,
          pitchL: initialPitchPx,
          pitchR: initialPitchPx,
          anchorL: all[0] ? { idx: all[0].idx, x: all[0].x } : null,
          anchorR: all[0] ? { idx: all[0].idx, x: all[0].x } : null,
          drift: null,
          accepted: all.length === 1,
        };
      }

      // Iterative outlier rejection — but never below a safety floor of
      // max(4, 50 % of confident probes). On boards where probes don't
      // agree well (Hager-style 16-module mixed-device rails, where 2-
      // module devices like RCDs / main switches make many probes land on
      // non-seam features), aggressive rejection can collapse to 2 anchors
      // and produce a worse result than no rejection. The safety floor
      // means we either reject confidently or fall back to the full set
      // and let the linear-pitch fit absorb the spread.
      const MIN_RETAINED = Math.max(4, Math.floor(all.length * 0.5));
      let retained = [...all];
      for (let iter = 0; iter < 5; iter++) {
        if (retained.length < 2) break;
        // Working pitch = median of short-span (≤3) pair pitches among
        // retained probes. Restricting span ≤ 3 keeps the working pitch
        // *local* — it doesn't average across the whole rail (which would
        // mask perspective stretch).
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
        const sortedShortPairs = [...shortPairs].sort((u, v) => u - v);
        const workingPitch = sortedShortPairs[Math.floor(sortedShortPairs.length / 2)];

        // Anchor at the rightmost retained probe; walk leftward at
        // workingPitch. A retained probe whose refined x deviates from this
        // expected position by more than 15 % of pitch is rejected.
        const anchor = retained[retained.length - 1];
        const tol = workingPitch * 0.15;
        const next = retained.filter((p) => {
          const expected = anchor.x + (p.idx - anchor.idx) * workingPitch;
          return Math.abs(p.x - expected) <= tol;
        });
        if (next.length === retained.length) break; // converged
        if (next.length < MIN_RETAINED) break; // safety floor — keep current retained
        retained = next;
      }

      const retainedIdx = retained.map((p) => p.idx);
      const rejectedIdx = allIdx.filter((i) => !retainedIdx.includes(i));

      // Compute final pitches: pitchL = median of short-span (≤3) pair
      // pitches among the LEFT-HALF of retained probes; pitchR similarly
      // for the right half. Using medians (rather than just the leftmost-
      // adjacent pair) makes the end-pitch estimate robust to single bad
      // probes — Hager-style mixed-device boards in particular have a
      // single dodgy probe (idx 1 falling on a 2-module RCD body, etc.)
      // that derails any "use leftmost pair" heuristic.
      //
      // Step 2.1 — BLANK / MULTI-MODULE detection:
      // Pairs whose implied pitch is less than 60 % of the running median
      // are flagged as "anomalously short" — the signature of either a
      // blank slot between two probes (the (6,7)=35 case on Hager) or a
      // probe locked onto a feature inside a 2-module device (RCD body,
      // main switch). The probes involved in those anomalous pairs go
      // onto a "blank-suspect" list, and they are excluded from the
      // half-medians used for pitchL/pitchR. This protects the pitch
      // estimate from being dragged toward smaller values by the noisy
      // mid-rail region without losing the probes for the consistency
      // check (which still uses them to validate the linear model).
      const ANOMALOUS_PAIR_RATIO = 0.60;
      const collectShortPairs = (subset) => {
        const pairs = [];
        for (let i = 0; i < subset.length - 1; i++) {
          for (let j = i + 1; j < subset.length; j++) {
            const span = subset[j].idx - subset[i].idx;
            if (span > 0 && span <= 3) {
              pairs.push({
                from: subset[i].idx, to: subset[j].idx, span,
                pitch: (subset[j].x - subset[i].x) / span,
              });
            }
          }
        }
        return pairs;
      };
      // Find blank-suspect probes ACROSS THE WHOLE retained set first —
      // a single pass on all retained data so the suspect list is shared
      // by left-half and right-half pitch calculations.
      const allShortPairs = collectShortPairs(retained);
      const blankSuspectIdx = new Set();
      if (allShortPairs.length >= 3) {
        const sortedAll = [...allShortPairs.map((p) => p.pitch)].sort((u, v) => u - v);
        const initialMedian = sortedAll[Math.floor(sortedAll.length / 2)];
        const threshold = initialMedian * ANOMALOUS_PAIR_RATIO;
        for (const p of allShortPairs) {
          if (p.pitch < threshold) {
            blankSuspectIdx.add(p.from);
            blankSuspectIdx.add(p.to);
          }
        }
      }
      const cleanRetained = retained.filter((p) => !blankSuspectIdx.has(p.idx));
      // Use cleanRetained for pitch fitting if it still has ≥4 probes;
      // otherwise fall back to all retained (the blank filter would
      // have eaten too much signal — better to have noisy pitch than
      // none).
      const pitchSource = cleanRetained.length >= 4 ? cleanRetained : retained;

      const medianShortPairPitch = (subset) => {
        const pairs = collectShortPairs(subset).map((p) => p.pitch);
        if (pairs.length === 0) return null;
        const sorted = pairs.sort((u, v) => u - v);
        return sorted[Math.floor(sorted.length / 2)];
      };
      let pitchL, pitchR;
      if (pitchSource.length >= 4) {
        // Split into halves by position (not by count) so a board that
        // has all clean probes clustered on one side still gets a
        // meaningful split.
        const midIdx = (pitchSource[0].idx + pitchSource[pitchSource.length - 1].idx) / 2;
        const leftHalf = pitchSource.filter((p) => p.idx <= midIdx);
        const rightHalf = pitchSource.filter((p) => p.idx >= midIdx);
        pitchL = medianShortPairPitch(leftHalf) ?? medianShortPairPitch(pitchSource) ?? initialPitchPx;
        pitchR = medianShortPairPitch(rightHalf) ?? medianShortPairPitch(pitchSource) ?? initialPitchPx;
      } else if (pitchSource.length === 2 || pitchSource.length === 3) {
        const fallback = medianShortPairPitch(pitchSource) ?? initialPitchPx;
        pitchL = fallback;
        pitchR = fallback;
      } else {
        pitchL = pitchR = initialPitchPx;
      }

      // Detect uniform vs perspective-stretched: if pitchL and pitchR
      // agree to within 5 % use a single pitch (uniform model); otherwise
      // keep them split (linear model).
      const stretch = pitchL > 0 && pitchR > 0
        ? Math.abs(pitchR - pitchL) / ((pitchL + pitchR) / 2)
        : 0;
      const isStretched = stretch > 0.05;
      // Candidate pitch for module-count rounding: average of pitchL and
      // pitchR when stretched, else just pitchL (=pitchR since they agree).
      const candidate = isStretched
        ? (pitchL + pitchR) / 2
        : pitchL;

      // Pair-pitches for diagnostic display (all retained pairs ≤ span 3).
      const pairs = [];
      for (let i = 0; i < retained.length - 1; i++) {
        for (let j = i + 1; j < retained.length; j++) {
          const span = retained[j].idx - retained[i].idx;
          if (span > 0 && span <= 3) {
            pairs.push({
              from: retained[i].idx,
              to: retained[j].idx,
              pitch: (retained[j].x - retained[i].x) / span,
            });
          }
        }
      }

      const drift = Math.abs(candidate - initialPitchPx) / initialPitchPx;
      // Accept if the candidate is within ±25 % of initial AND we have at
      // least 2 retained anchors after consistency check.
      const accepted = retained.length >= 2 && drift <= 0.25;

      return {
        confidentCount: all.length,
        retainedIdx,
        rejectedIdx,
        pairs,
        candidatePitchPx: candidate,
        pitchL,
        pitchR,
        anchorL: retained.length > 0 ? { idx: retained[0].idx, x: retained[0].x } : null,
        anchorR: retained.length > 0 ? { idx: retained[retained.length - 1].idx, x: retained[retained.length - 1].x } : null,
        drift,
        accepted,
      };
    };
    const aResult = buildAnchorModel('a');
    const bResult = buildAnchorModel('b');

    // Apply the primary detector's candidate pitch (default A; override
    // with PROBE_DETECTOR=B). The other is logged for comparison only.
    const primary = PRIMARY_DETECTOR === 'B' ? bResult : aResult;
    if (primary.accepted) {
      refinedPitchPx = primary.candidatePitchPx;
      refinedModuleCount = Math.max(1, Math.round(newFaceWidth / refinedPitchPx));
    }

    const summariseDet = (r) => ({
      confidentCount: r.confidentCount,
      retainedIdx: r.retainedIdx,
      rejectedIdx: r.rejectedIdx,
      pairs: r.pairs.map((p) => ({
        from: p.from, to: p.to, pitch: Math.round(p.pitch * 10) / 10,
      })),
      candidatePitchPx: r.candidatePitchPx != null ? Math.round(r.candidatePitchPx * 10) / 10 : null,
      pitchL: r.pitchL != null ? Math.round(r.pitchL * 10) / 10 : null,
      pitchR: r.pitchR != null ? Math.round(r.pitchR * 10) / 10 : null,
      anchorL: r.anchorL ? { idx: r.anchorL.idx, x: Math.round(r.anchorL.x) } : null,
      anchorR: r.anchorR ? { idx: r.anchorR.idx, x: Math.round(r.anchorR.x) } : null,
      drift: r.drift != null ? Math.round(r.drift * 1000) / 1000 : null,
      accepted: r.accepted,
    });
    pitchDiag = {
      primaryDetector: PRIMARY_DETECTOR,
      stripHalfWidthPx: stripHalfWidth,
      stripBand: 'full-rail-face',
      probedAllGaps: true,
      probes: probes.map((p) => ({
        idx: p.idx,
        predicted: Math.round(p.predictedX),
        a: {
          refined: Math.round(p.a.refinedX),
          snr: Math.round(p.a.snr * 100) / 100,
          sharpness: Math.round(p.a.sharpness * 100) / 100,
          confident: p.a.confident,
        },
        b: {
          refined: Math.round(p.b.refinedX),
          snr: Math.round(p.b.snr * 100) / 100,
          sharpness: Math.round(p.b.sharpness * 100) / 100,
          confident: p.b.confident,
        },
      })),
      a: summariseDet(aResult),
      b: summariseDet(bResult),
      initialPitchPx: Math.round(initialPitchPx * 10) / 10,
    };
  }
  // Two-anchor tiling using the refined pitch — boundaries still land on
  // rail edges by design (count = round(width / pitch), then tilePitch =
  // width / count to absorb any sub-pixel rounding error).
  const moduleCount = refinedModuleCount;
  const tilePitchPx = newFaceWidth / moduleCount;
  const slotCentersPx = [];
  for (let i = 0; i < moduleCount; i++) {
    slotCentersPx.push(newLeftX + tilePitchPx * (i + 0.5));
  }

  return {
    tightenedBox,
    userBox,
    diffPx,
    seamRatio,
    tight,
    reason: tight ? 'ok' : seamRatio == null ? 'no-seam' : 'seam-off-band',
    moduleCount,
    moduleCountRaw,
    modulePxFromHeight,
    pxPerMm,
    tilePitchPx,
    slotCentersPx,
    pitchRefinement: pitchDiag,
    initialModuleCount,
    initialPitchPx,
    refinedPitchPx,
    diag: {
      // Image-coord positions (no per-edge crop origins anymore — each edge
      // was searched in its own strip). Slot grid renders in image coords.
      cropOriginPx: { x: 0, y: 0 },
      cropSizePx: { w: W, h: H },
      faceTopPx: newTopY, faceBottomPx: newBotY,
      faceLeftPx: newLeftX, faceRightPx: newRightX,
      faceWidthPx: newFaceWidth, faceHeightPx: newFaceHeight,
      seamPx: seamY,
      stripPadXpx: padXpx, stripPadYpx: padYpx,
      perEdgeSnr: {
        top: Math.round(topR.snr * 100) / 100,
        bottom: Math.round(botR.snr * 100) / 100,
        left: Math.round(leftR.snr * 100) / 100,
        right: Math.round(rightR.snr * 100) / 100,
      },
    },
  };
}

function makeFallback(userBox, sx0, sy0, sw, sh, reason, diag) {
  return {
    tightenedBox: userBox,
    userBox,
    diffPx: { top: 0, bottom: 0, left: 0, right: 0 },
    seamRatio: null,
    tight: false,
    reason,
    diag: {
      cropOriginPx: { x: sx0, y: sy0 },
      cropSizePx: { w: sw, h: sh },
      ...diag,
    },
  };
}

// ---------------------------------------------------------------------------
// Visualisation
// ---------------------------------------------------------------------------

async function writeOverlay(imageBuffer, result, outPath, expectedCount = null) {
  const meta = await sharp(imageBuffer).metadata();
  const W = meta.width, H = meta.height;
  const { userBox, tightenedBox, diag, seamRatio, tight, reason, moduleCount, moduleCountRaw, slotCentersPx, tilePitchPx } = result;

  const userPx = {
    x0: userBox.x * W, y0: userBox.y * H,
    x1: (userBox.x + userBox.w) * W, y1: (userBox.y + userBox.h) * H,
  };
  const tightPx = {
    x0: tightenedBox.x * W, y0: tightenedBox.y * H,
    x1: (tightenedBox.x + tightenedBox.w) * W, y1: (tightenedBox.y + tightenedBox.h) * H,
  };
  const seamPx = diag?.seamPx != null ? diag.cropOriginPx.y + diag.seamPx : null;

  // Slot boundaries — vertical lines at every (faceLeftPx + i × tilePitchPx)
  // mapped back to image coords. Drawn faintly so the rail face stays
  // legible. Slot index labels at every 4th boundary to avoid clutter on
  // wide boards.
  const slotLines = [];
  if (Number.isFinite(tilePitchPx) && tilePitchPx > 0) {
    for (let i = 0; i <= moduleCount; i++) {
      const xInCrop = diag.faceLeftPx + tilePitchPx * i;
      const x = diag.cropOriginPx.x + xInCrop;
      slotLines.push(
        `<line x1="${x}" y1="${tightPx.y0}" x2="${x}" y2="${tightPx.y1}" stroke="rgba(255,170,40,0.85)" stroke-width="2"/>`
      );
    }
    for (const cx of slotCentersPx) {
      const labelX = diag.cropOriginPx.x + cx;
      const idx = slotCentersPx.indexOf(cx);
      slotLines.push(
        `<text x="${labelX}" y="${tightPx.y0 - 6}" font-family="-apple-system,Helvetica,sans-serif" font-size="14" font-weight="700" fill="rgb(255,170,40)" text-anchor="middle">${idx + 1}</text>`
      );
    }
  }

  const countDelta = expectedCount != null ? moduleCount - expectedCount : null;
  const countLabel =
    expectedCount != null
      ? `count=${moduleCount} (raw ${moduleCountRaw.toFixed(2)})  vs GT=${expectedCount}  ${countDelta === 0 ? '✓' : `Δ=${countDelta > 0 ? '+' : ''}${countDelta}`}`
      : `count=${moduleCount} (raw ${moduleCountRaw.toFixed(2)})`;
  const labelText = `${tight ? 'TIGHT' : 'LOOSE'} (${reason})  seam=${seamRatio == null ? '—' : seamRatio.toFixed(3)}   ${countLabel}`;
  const svg = `
    <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <rect x="${userPx.x0}" y="${userPx.y0}" width="${userPx.x1 - userPx.x0}" height="${userPx.y1 - userPx.y0}"
            fill="none" stroke="rgb(220,50,50)" stroke-width="3" stroke-dasharray="8,6"/>
      <rect x="${tightPx.x0}" y="${tightPx.y0}" width="${tightPx.x1 - tightPx.x0}" height="${tightPx.y1 - tightPx.y0}"
            fill="none" stroke="rgb(40,210,80)" stroke-width="4"/>
      ${diag.faceTopAdjPx != null
        ? `<line x1="${tightPx.x0}" y1="${diag.cropOriginPx.y + diag.faceTopAdjPx}" x2="${tightPx.x1}" y2="${diag.cropOriginPx.y + diag.faceTopAdjPx}" stroke="rgb(80,180,255)" stroke-width="2" stroke-dasharray="3,3"/>
           <line x1="${tightPx.x0}" y1="${diag.cropOriginPx.y + diag.faceBottomAdjPx}" x2="${tightPx.x1}" y2="${diag.cropOriginPx.y + diag.faceBottomAdjPx}" stroke="rgb(80,180,255)" stroke-width="2" stroke-dasharray="3,3"/>`
        : ''}
      ${slotLines.join('\n')}
      ${seamPx != null
        ? `<line x1="${tightPx.x0}" y1="${seamPx}" x2="${tightPx.x1}" y2="${seamPx}" stroke="rgb(255,200,40)" stroke-width="2" stroke-dasharray="6,4"/>`
        : ''}
      <rect x="0" y="${H - 56}" width="${W}" height="56" fill="rgba(20,20,20,0.85)"/>
      <text x="16" y="${H - 28}" font-family="-apple-system,Helvetica,sans-serif" font-size="22" font-weight="700" fill="rgb(40,210,80)">tight box</text>
      <text x="180" y="${H - 28}" font-family="-apple-system,Helvetica,sans-serif" font-size="22" fill="rgb(220,50,50)">user box</text>
      <text x="320" y="${H - 28}" font-family="-apple-system,Helvetica,sans-serif" font-size="22" fill="rgb(255,170,40)">slot grid</text>
      <text x="460" y="${H - 28}" font-family="-apple-system,Helvetica,sans-serif" font-size="22" fill="rgb(255,200,40)">seam</text>
      <text x="560" y="${H - 28}" font-family="-apple-system,Helvetica,sans-serif" font-size="22" fill="rgb(80,180,255)">inset (height-anchor band)</text>
      <text x="16" y="${H - 8}" font-family="-apple-system,Helvetica,sans-serif" font-size="18" fill="rgb(220,220,220)">${labelText}</text>
    </svg>
  `;
  await sharp(imageBuffer)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 88 })
    .toFile(outPath);
}

async function writeProbeOverlay(imageBuffer, result, outPath, expectedCount = null) {
  const meta = await sharp(imageBuffer).metadata();
  const W = meta.width, H = meta.height;
  const { tightenedBox, diag, moduleCount, pitchRefinement } = result;
  if (!pitchRefinement) {
    // No probes were run (initial count too small). Skip.
    return;
  }
  const tightPx = {
    x0: tightenedBox.x * W, y0: tightenedBox.y * H,
    x1: (tightenedBox.x + tightenedBox.w) * W, y1: (tightenedBox.y + tightenedBox.h) * H,
  };
  // A/B overlay — three visual bands so probe markers and slot grids never
  // get visually confused:
  //
  //   Band 1: PROBE markers — saturated solid lines + label
  //     A confident ✓: bright GREEN, top-half vertical line
  //     A rejected  ✗: dim ORANGE, label + 12 px tick only (no full line —
  //                    so a rejected probe never reads as a grid candidate)
  //     B confident ✓: bright CYAN, bottom-half vertical line
  //     B rejected  ✗: dim MAGENTA, label + 12 px tick only
  //
  //   Band 2: SLOT GRIDS — pale dashed full-height lines, clearly distinct
  //                       hue from the probe colours so the eye doesn't
  //                       conflate them with rejected probes
  //     Grid A: pale LIME-WHITE  rgb(220,255,200)
  //     Grid B: pale GOLD-WHITE  rgb(255,235,180)
  //
  //   Band 3: PREDICTED initial-pitch positions — thin dashed RED reference
  const COLOR_A_OK = 'rgb(40,210,80)';
  const COLOR_A_FAIL = 'rgb(255,170,40)';
  const COLOR_B_OK = 'rgb(80,200,255)';
  const COLOR_B_FAIL = 'rgb(220,140,255)';
  const COLOR_PRED = 'rgb(230,60,60)';
  const COLOR_GRID_A = 'rgb(220,255,200)';
  const COLOR_GRID_B = 'rgb(255,235,180)';

  // Per-probe markers. A on top half, B on bottom half so they don't overlap
  // when both lock onto the same column. Failed probes shrink to a short
  // tick + label only (no full half-height line) so they're clearly out
  // of the running for a grid position.
  const midY = (tightPx.y0 + tightPx.y1) / 2;
  const TICK_LEN = 14;
  const probeFragments = pitchRefinement.probes.map((p) => {
    const predX = p.predicted;
    const aColor = p.a.confident ? COLOR_A_OK : COLOR_A_FAIL;
    const bColor = p.b.confident ? COLOR_B_OK : COLOR_B_FAIL;
    // A marker — full half-height if confident, short tick if not.
    const aMarker = p.a.confident
      ? `<line x1="${p.a.refined}" y1="${tightPx.y0}" x2="${p.a.refined}" y2="${midY}" stroke="${aColor}" stroke-width="3"/>`
      : `<line x1="${p.a.refined}" y1="${tightPx.y0}" x2="${p.a.refined}" y2="${tightPx.y0 + TICK_LEN}" stroke="${aColor}" stroke-width="2" stroke-dasharray="2,2" opacity="0.65"/>`;
    const bMarker = p.b.confident
      ? `<line x1="${p.b.refined}" y1="${midY}" x2="${p.b.refined}" y2="${tightPx.y1}" stroke="${bColor}" stroke-width="3"/>`
      : `<line x1="${p.b.refined}" y1="${tightPx.y1 - TICK_LEN}" x2="${p.b.refined}" y2="${tightPx.y1}" stroke="${bColor}" stroke-width="2" stroke-dasharray="2,2" opacity="0.65"/>`;
    return `
      <line x1="${predX}" y1="${tightPx.y0}" x2="${predX}" y2="${tightPx.y1}" stroke="${COLOR_PRED}" stroke-width="1" stroke-dasharray="2,5" opacity="0.45"/>
      ${aMarker}
      ${bMarker}
      <text x="${p.a.refined}" y="${tightPx.y0 - 30}" font-family="-apple-system,Helvetica,sans-serif" font-size="13" font-weight="700" fill="${aColor}" text-anchor="middle">A:${p.idx}${p.a.confident ? '✓' : '✗'}</text>
      <text x="${p.a.refined}" y="${tightPx.y0 - 14}" font-family="-apple-system,Helvetica,sans-serif" font-size="10" fill="${aColor}" text-anchor="middle">${p.a.snr.toFixed(2)}/${p.a.sharpness.toFixed(2)}</text>
      <text x="${p.b.refined}" y="${tightPx.y1 + 16}" font-family="-apple-system,Helvetica,sans-serif" font-size="13" font-weight="700" fill="${bColor}" text-anchor="middle">B:${p.idx}${p.b.confident ? '✓' : '✗'}</text>
      <text x="${p.b.refined}" y="${tightPx.y1 + 32}" font-family="-apple-system,Helvetica,sans-serif" font-size="10" fill="${bColor}" text-anchor="middle">${p.b.snr.toFixed(2)}/${p.b.sharpness.toFixed(2)}</text>
    `;
  }).join('\n');

  // Slot grids — pale near-white tinted lines, distinct from the saturated
  // probe markers and from rejected-probe ticks.
  //
  // Step 1 grid anchoring: instead of laying a uniform tile down from
  // faceLeftPx (the old behaviour, which produced gold/lime lines drifting
  // through the middle of devices on the left end of a perspective-stretched
  // Crabtree), the grid is now ANCHORED on the rightmost two confident
  // probes for that detector.
  //   • Right-side pitch = (refined_b − refined_a) / (idx_b − idx_a)
  //     where a/b are the two highest-idx confident probes.
  //   • Anchor point = refined_b at idx_b.
  //   • Lines walk leftward at that pitch from the anchor.
  // This guarantees the right-side grid lines pass through the known-good
  // probe positions. The left side will only be correct insofar as the
  // local right-side pitch matches the rail's whole-row pitch — which it
  // *won't* under perspective stretch (Crabtree right ≈ 106, left ≈ 85).
  // That mismatch is the visual evidence we need to motivate step 2
  // (consistency-checked all-position probing).
  //
  // Fallbacks:
  //   • <2 confident probes  → lay the grid uniform from faceLeftPx
  //                            (legacy behaviour, last resort).
  //   • Anchor pitch outside ±25 % of candidate pitch → reject anchor,
  //                            fall back to uniform. (Catches a degenerate
  //                            case where the two rightmost confidents
  //                            happen to be both wrong in the same way.)
  // Step 2 grid lay-down: linear pitch interpolation between left and right
  // anchors (the consistency-checked retained probes from buildAnchorModel).
  //
  //   • If both anchorL and anchorR exist with anchorL.idx < anchorR.idx:
  //       Between them: pitch(j) = pitchL + (pitchR - pitchL) × (j - anchorL.idx) / (anchorR.idx - anchorL.idx)
  //       Position(i) integrates pitch from anchorL leftward / rightward.
  //       Outside [anchorL.idx, anchorR.idx]: extrapolate at end-pitch.
  //   • Single anchor: uniform pitch from that anchor (step-1 behaviour).
  //   • No anchor: uniform pitch from faceLeftPx (legacy fallback).
  const buildGrid = (det, colour) => {
    if (!det.candidatePitchPx) return { lines: '', mode: 'none' };
    const faceWidth = diag.faceRightPx - diag.faceLeftPx;
    const aL = det.anchorL, aR = det.anchorR;
    const haveTwo = aL && aR && aL.idx !== aR.idx;
    const haveOne = !haveTwo && aL;
    const pitchL = det.pitchL;
    const pitchR = det.pitchR;

    // Position-of-slot-boundary i — closed form for the integral of a
    // linear pitch function between anchors, with constant-pitch
    // extrapolation outside.
    const positionOf = (i) => {
      if (haveTwo) {
        const span = aR.idx - aL.idx;
        if (i <= aL.idx) return aL.x - (aL.idx - i) * pitchL;
        if (i >= aR.idx) return aR.x + (i - aR.idx) * pitchR;
        const di = i - aL.idx;
        const slope = (pitchR - pitchL) / span;
        // Sum_{k=0..di-1} (pitchL + slope * k) = di * pitchL + slope * di*(di-1)/2
        return aL.x + di * pitchL + slope * di * (di - 1) / 2;
      }
      if (haveOne) return aL.x + (i - aL.idx) * det.candidatePitchPx;
      return diag.faceLeftPx + det.candidatePitchPx * i;
    };

    const count = Math.max(1, Math.round(faceWidth / det.candidatePitchPx));
    const lines = [];
    for (let i = 0; i <= count; i++) {
      const x = positionOf(i);
      lines.push(
        `<line x1="${x}" y1="${tightPx.y0}" x2="${x}" y2="${tightPx.y1}" stroke="${colour}" stroke-width="1.5" stroke-dasharray="6,3" opacity="0.75"/>`
      );
    }
    return {
      lines: lines.join('\n'),
      mode: haveTwo ? 'linear' : (haveOne ? 'single-anchor' : 'fallback'),
      pitchL, pitchR, aL, aR,
    };
  };
  const gridARes = buildGrid(pitchRefinement.a, COLOR_GRID_A);
  const gridBRes = buildGrid(pitchRefinement.b, COLOR_GRID_B);
  const gridA = gridARes.lines;
  const gridB = gridBRes.lines;

  // Highlight the full-rail-face strip band that was actually searched.
  const bandFragment = `
    <rect x="${tightPx.x0}" y="${diag.faceTopPx}" width="${tightPx.x1 - tightPx.x0}" height="${diag.faceBottomPx - diag.faceTopPx}"
          fill="rgba(140,140,200,0.05)" stroke="rgba(140,140,200,0.30)" stroke-width="1" stroke-dasharray="4,4"/>
  `;

  const probeCount = pitchRefinement.probes.length;
  const describeGrid = (det, gridRes) => {
    if (gridRes.mode === 'linear') {
      return `LINEAR  pitchL=${det.pitchL?.toFixed(1)}px → pitchR=${det.pitchR?.toFixed(1)}px  anchors idx${det.anchorL.idx}/${det.anchorR.idx}  retained=${det.retainedIdx.length}/${det.confidentCount} rejected=${det.rejectedIdx.length}`;
    }
    if (gridRes.mode === 'single-anchor') {
      return `SINGLE-ANCHOR  pitch=${det.candidatePitchPx}px  anchor=idx${det.anchorL?.idx}  retained=${det.retainedIdx.length}/${det.confidentCount}`;
    }
    return `FALLBACK  pitch=${det.candidatePitchPx ?? '—'}px  no consistent anchors`;
  };
  const aLine = `det.A tall-thin: ${describeGrid(pitchRefinement.a, gridARes)}  ${pitchRefinement.a.accepted ? '✓' : '✗'}`;
  const bLine = `det.B dark-valley: ${describeGrid(pitchRefinement.b, gridBRes)}  ${pitchRefinement.b.accepted ? '✓' : '✗'}`;
  const headerLine = `count=${moduleCount}${expectedCount != null ? ` vs GT=${expectedCount} ${moduleCount === expectedCount ? '✓' : 'Δ' + (moduleCount - expectedCount)}` : ''}  ·  initial=${pitchRefinement.initialPitchPx}px  ·  primary=${pitchRefinement.primaryDetector}`;

  const svg = `
    <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <rect x="${tightPx.x0}" y="${tightPx.y0}" width="${tightPx.x1 - tightPx.x0}" height="${tightPx.y1 - tightPx.y0}"
            fill="none" stroke="rgb(80,80,90)" stroke-width="2"/>
      ${bandFragment}
      ${gridA}
      ${gridB}
      ${probeFragments}
      <rect x="0" y="${H - 110}" width="${W}" height="110" fill="rgba(15,15,18,0.92)"/>
      <text x="16" y="${H - 86}" font-family="-apple-system,Helvetica,sans-serif" font-size="16" font-weight="700" fill="${COLOR_A_OK}">A — TALL-THIN  ·  top-half markers</text>
      <text x="${W / 2 + 16}" y="${H - 86}" font-family="-apple-system,Helvetica,sans-serif" font-size="16" font-weight="700" fill="${COLOR_B_OK}">B — DARK-VALLEY  ·  bottom-half markers</text>
      <text x="16" y="${H - 66}" font-family="-apple-system,Helvetica,sans-serif" font-size="13" fill="${COLOR_A_OK}">${aLine}</text>
      <text x="${W / 2 + 16}" y="${H - 66}" font-family="-apple-system,Helvetica,sans-serif" font-size="13" fill="${COLOR_B_OK}">${bLine}</text>
      <text x="16" y="${H - 44}" font-family="-apple-system,Helvetica,sans-serif" font-size="12" fill="${COLOR_A_OK}">probe ✓ green solid</text>
      <text x="170" y="${H - 44}" font-family="-apple-system,Helvetica,sans-serif" font-size="12" fill="${COLOR_A_FAIL}">probe ✗ orange tick (rejected, label only)</text>
      <text x="500" y="${H - 44}" font-family="-apple-system,Helvetica,sans-serif" font-size="12" fill="${COLOR_GRID_A}">grid A pale-lime dashed</text>
      <text x="${W / 2 + 16}" y="${H - 44}" font-family="-apple-system,Helvetica,sans-serif" font-size="12" fill="${COLOR_B_OK}">probe ✓ cyan solid</text>
      <text x="${W / 2 + 170}" y="${H - 44}" font-family="-apple-system,Helvetica,sans-serif" font-size="12" fill="${COLOR_B_FAIL}">probe ✗ magenta tick</text>
      <text x="${W / 2 + 500}" y="${H - 44}" font-family="-apple-system,Helvetica,sans-serif" font-size="12" fill="${COLOR_GRID_B}">grid B pale-gold dashed</text>
      <text x="16" y="${H - 22}" font-family="-apple-system,Helvetica,sans-serif" font-size="12" fill="${COLOR_PRED}">predicted-from-initial-pitch (red dashed)</text>
      <text x="16" y="${H - 6}" font-family="-apple-system,Helvetica,sans-serif" font-size="14" font-weight="700" fill="rgb(230,230,230)">${headerLine}</text>
    </svg>
  `;
  await sharp(imageBuffer)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 88 })
    .toFile(outPath);
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

// Skip the CLI driver when this file is imported (so consumers can use
// `tightenBox` without triggering the harness driver against the corpus).
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (!isMain) {
  // Imported as a library — stop here, exports above are all that's needed.
} else {

const annotations = ANNOTATIONS.annotations || {};
const annotatedIds = new Set(
  Object.keys(annotations).filter((id) => annotations[id].groundTruth != null)
);

let filtered;
if (ONE_ID) {
  filtered = MANIFEST.entries
    .filter((e) => e.extractionId === ONE_ID && e.userBox)
    .map((e) => e.extractionId);
  if (filtered.length === 0) {
    console.error(`[error] no entry for id=${ONE_ID}`);
    process.exit(1);
  }
} else if (ALL) {
  filtered = MANIFEST.entries
    .filter((e) => e.userBox) // only entries that have a railRoiHint to tighten
    .map((e) => e.extractionId);
} else {
  filtered = [...annotatedIds];
}

if (filtered.length === 0) {
  console.error('[error] no entries to run');
  process.exit(1);
}

console.log(`Box tightener — ${filtered.length} annotated photo${filtered.length === 1 ? '' : 's'}`);
console.log(`  per-edge strip: ±${(EDGE_PAD * 100).toFixed(0)}% of perpendicular box dimension   seam band: [${SEAM_MIN}, ${SEAM_MAX}]`);

const summary = [];

for (const id of filtered) {
  const entry = MANIFEST.entries.find((e) => e.extractionId === id);
  const ann = annotations[id] || {};
  if (!entry?.userBox) {
    console.warn(`[skip] ${id} — no userBox`);
    continue;
  }
  const photoPath = path.join(ROOT, entry.photo);
  const photoBytes = fs.readFileSync(photoPath);

  const variants = [{ tag: 'tight', mutateBox: (b) => b }];
  if (STRESS) {
    variants.push({
      tag: 'loose+20%',
      mutateBox: (b) => ({
        x: Math.max(0, b.x - b.w * 0.20),
        y: Math.max(0, b.y - b.h * 0.20),
        w: Math.min(1, b.w * 1.40),
        h: Math.min(1, b.h * 1.40),
      }),
    });
    // Vertical-only over-tight crop — clips the rail face top + bottom by 6 %.
    variants.push({
      tag: 'undercrop-v6%',
      mutateBox: (b) => ({ x: b.x, y: b.y + b.h * 0.06, w: b.w, h: b.h * 0.88 }),
    });
    // Horizontal-only over-tight crop — clips one device on each side.
    variants.push({
      tag: 'undercrop-h6%',
      mutateBox: (b) => ({ x: b.x + b.w * 0.06, y: b.y, w: b.w * 0.88, h: b.h }),
    });
  }

  const gt = ann.groundTruth ?? null;
  const prevModCt = entry.prevModuleCount ?? null;
  const gtTag = gt != null ? `GT=${gt}` : `prod=${prevModCt ?? '?'}`;
  console.log(`\n--- ${id} (${entry.boardManufacturer ?? '?'} ${entry.boardModel ?? ''}, ${gtTag}) ---`);
  if (ann.notes) console.log(`    note: ${ann.notes.slice(0, 100)}${ann.notes.length > 100 ? '…' : ''}`);

  for (const v of variants) {
    const ub = v.mutateBox(entry.userBox);
    const r = await tightenBox(photoBytes, ub);
    const userArea = ub.w * ub.h;
    const tightArea = r.tightenedBox.w * r.tightenedBox.h;
    const areaDelta = ((tightArea - userArea) / userArea) * 100;
    let scoreTag;
    if (gt != null) {
      const d = r.moduleCount - gt;
      scoreTag = `vs GT=${gt} ${d === 0 ? '✓' : `Δ${d > 0 ? '+' : ''}${d}`}`;
    } else if (prevModCt != null) {
      const d = r.moduleCount - prevModCt;
      scoreTag = `vs prod=${prevModCt} ${d === 0 ? '=' : `Δ${d > 0 ? '+' : ''}${d}`}`;
    } else {
      scoreTag = '(no reference)';
    }
    console.log(
      `    [${v.tag.padEnd(14)}]  ` +
      `tight=${r.tight ? '✓' : '✗'}  ` +
      `seam=${r.seamRatio == null ? '—' : r.seamRatio.toFixed(3)}  ` +
      `Δedges(px) top=${r.diffPx.top.toFixed(0)} bot=${r.diffPx.bottom.toFixed(0)} ` +
      `left=${r.diffPx.left.toFixed(0)} right=${r.diffPx.right.toFixed(0)}  ` +
      `count=${r.moduleCount} (raw ${r.moduleCountRaw.toFixed(2)}, pitch ${r.tilePitchPx.toFixed(1)}px) ` +
      `${scoreTag}  ` +
      `area Δ=${areaDelta >= 0 ? '+' : ''}${areaDelta.toFixed(1)}%  ` +
      `reason=${r.reason}`
    );
    if (r.pitchRefinement) {
      const p = r.pitchRefinement;
      const renderDetector = (label, det) => {
        const star = label === p.primaryDetector ? '★' : ' ';
        const k = label.toLowerCase();
        const retSet = new Set(det.retainedIdx);
        const rejSet = new Set(det.rejectedIdx);
        console.log(
          `      ${star} det.${label}: pitch L=${det.pitchL ?? '—'}px R=${det.pitchR ?? '—'}px ` +
          `(candidate ${det.candidatePitchPx ?? '—'}, drift ${det.drift != null ? (det.drift * 100).toFixed(1) + '%' : '—'}) ` +
          `confident=${det.confidentCount}/${p.probes.length} retained=${det.retainedIdx.length} rejected=${det.rejectedIdx.length}  ` +
          `${det.accepted ? 'applied ✓' : 'rejected'}`
        );
        const anc = (det.anchorL && det.anchorR && det.anchorL.idx !== det.anchorR.idx)
          ? `anchorL=idx${det.anchorL.idx}@${det.anchorL.x}px anchorR=idx${det.anchorR.idx}@${det.anchorR.x}px`
          : (det.anchorL ? `single anchor @ idx${det.anchorL.idx}` : 'no anchors');
        console.log(`        ${anc}`);
        const probesLine = p.probes.map((pr) => {
          const status = pr[k].confident
            ? (retSet.has(pr.idx) ? '✓' : (rejSet.has(pr.idx) ? '✗rej' : '✓'))
            : '✗';
          return `${pr.idx}:${pr[k].refined - pr.predicted >= 0 ? '+' : ''}${pr[k].refined - pr.predicted}${status}`;
        }).join(' ');
        console.log(`        probes: ${probesLine}`);
        if (det.pairs.length > 0) {
          const pairSummary = det.pairs.slice(0, 8).map((s) => `${s.from}→${s.to}=${s.pitch}px`).join(' ');
          console.log(`        pairs:  ${pairSummary}${det.pairs.length > 8 ? ` ...(${det.pairs.length})` : ''}`);
        }
      };
      console.log(`      A/B PROBE — primary=${p.primaryDetector}  initialN=${r.initialModuleCount} → finalN=${r.moduleCount}  strip=${p.stripBand}  probed=${p.probes.length} gaps`);
      renderDetector('A', p.a);
      renderDetector('B', p.b);
    }
    const outName = `${id}_${v.tag}.jpg`;
    await writeOverlay(photoBytes, r, path.join(DEBUG_DIR, outName), gt);
    await writeProbeOverlay(photoBytes, r, path.join(DEBUG_DIR, `${id}_${v.tag}_probes.jpg`), gt);
    if (TO_ICLOUD) {
      await writeOverlay(photoBytes, r, path.join(ICLOUD, `tighten-${outName}`), gt);
      await writeProbeOverlay(photoBytes, r, path.join(ICLOUD, `tighten-${id}_${v.tag}_probes.jpg`), gt);
    }
    summary.push({ id, variant: v.tag, ...r, _userArea: userArea, _tightArea: tightArea, _expected: gt, _prev: prevModCt });
  }
}

function summarise(label, rows) {
  const annotated = rows.filter((r) => r._expected != null);
  const unannotated = rows.filter((r) => r._expected == null);
  const seamOk = rows.filter((r) => r.tight).length;
  let line = `=== ${label.padEnd(14)} ${rows.length} runs   seam ✓ ${seamOk}/${rows.length}`;
  if (annotated.length > 0) {
    const countOk = annotated.filter((r) => r.moduleCount === r._expected).length;
    const countWithin1 = annotated.filter((r) => Math.abs(r.moduleCount - r._expected) <= 1).length;
    line += `   GT-count ✓ ${countOk}/${annotated.length}   ±1 ${countWithin1}/${annotated.length}`;
  }
  if (unannotated.length > 0) {
    const withPrev = unannotated.filter((r) => r._prev != null);
    if (withPrev.length > 0) {
      const matchPrev = withPrev.filter((r) => r.moduleCount === r._prev).length;
      const within1Prev = withPrev.filter((r) => Math.abs(r.moduleCount - r._prev) <= 1).length;
      line += `   prod-agree = ${matchPrev}/${withPrev.length}   ±1 ${within1Prev}/${withPrev.length}`;
    }
  }
  console.log(line + ' ===');
}
console.log('');
summarise('tight', summary.filter((s) => s.variant === 'tight'));
if (STRESS) {
  for (const tag of ['loose+20%', 'undercrop-v6%', 'undercrop-h6%']) {
    summarise(tag, summary.filter((s) => s.variant === tag));
  }
}

// Histogram of count-vs-prod deltas across the unannotated corpus —
// quickly surfaces whether the per-edge tightener systematically agrees,
// over-counts, or under-counts vs the production extractor.
const tightRuns = summary.filter((s) => s.variant === 'tight' && s._expected == null && s._prev != null);
if (tightRuns.length > 0) {
  const histogram = new Map();
  for (const r of tightRuns) {
    const d = r.moduleCount - r._prev;
    histogram.set(d, (histogram.get(d) || 0) + 1);
  }
  const keys = [...histogram.keys()].sort((a, b) => a - b);
  console.log(`\n  Count vs prod (${tightRuns.length} unannotated boards):`);
  for (const d of keys) {
    const sign = d > 0 ? `+${d}` : `${d}`;
    console.log(`    Δ${sign.padStart(3)}: ${histogram.get(d)}`);
  }
}
console.log(`\nOverlays → ${path.relative(process.cwd(), DEBUG_DIR)}/`);
if (TO_ICLOUD) console.log(`iCloud   → ${ICLOUD}/tighten-*.jpg`);

} // end of CLI-driver guard
