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
  if (initialModuleCount >= 8) {
    // Strip half-width = 25 % of initial pitch. Wide enough to reach the
    // actual MCB edge even when the initial 17.5 mm formula is ~5–10 % off
    // the manufacturer's true pitch (Protek HDM at ~16.5 mm vs 17.5 mm
    // produces ~3 px/module compounding error — at idx 4 that's already
    // 12 px, beyond a 10 % strip). Narrow enough that adjacent module
    // boundaries don't fit inside the same strip (½ pitch is the absolute
    // ceiling — at 25 % we have 25 % of pitch headroom on either side).
    const stripHalfWidth = Math.max(8, Math.round(initialPitchPx * 0.25));
    const stripTop = newTopY + Math.round(newFaceHeight * 0.60);
    const stripHeight = newFaceHeight - Math.round(newFaceHeight * 0.60);

    // Boundary indices to probe: 1, 2, 3, 4 (left side) and N-4, N-3, N-2, N-1 (right side).
    const boundaryIndices = [1, 2, 3, 4, initialModuleCount - 4, initialModuleCount - 3, initialModuleCount - 2, initialModuleCount - 1];

    const probes = await Promise.all(
      boundaryIndices.map(async (idx) => {
        const predictedX = newLeftX + initialPitchPx * idx;
        const stripX0 = Math.max(0, Math.round(predictedX - stripHalfWidth));
        const stripX1 = Math.min(W, Math.round(predictedX + stripHalfWidth));
        const stripW = stripX1 - stripX0;
        if (stripW < 4 || stripHeight < 4) {
          return { idx, predictedX, refinedX: predictedX, snr: 0, sharpness: 0, centred: 0, confident: false };
        }
        const stripBuf = await sharp(imageBuffer)
          .extract({ left: stripX0, top: stripTop, width: stripW, height: stripHeight })
          .toBuffer();
        const colSig = smooth3(await sobelXColSum(stripBuf, stripW, stripHeight));
        // Single-pass: find peak + second-largest local max + mean.
        let peakI = 0, peakV = -Infinity, secondV = -Infinity, sum = 0;
        for (let i = 1; i < stripW - 1; i++) {
          const v = colSig[i];
          sum += v;
          if (v > peakV) { secondV = peakV; peakV = v; peakI = i; }
          else if (v > secondV) { secondV = v; }
        }
        const mean = sum / Math.max(1, stripW - 2);
        const refinedX = stripX0 + peakI;
        const snr = mean > 0 ? peakV / mean : 0;
        const sharpness = secondV > 0 ? peakV / secondV : (peakV > 0 ? 5 : 0);
        const centred = 1 - Math.abs(refinedX - predictedX) / stripHalfWidth;
        const confident = snr >= 1.4 && sharpness >= 1.05;
        return { idx, predictedX, refinedX, snr, sharpness, centred, confident };
      })
    );

    // Pitch from same-side pairs only — cross-rail pairs (left-probe paired
    // with right-probe) average their span over many modules, which masks
    // any cumulative pitch bias and gives the formula's predicted pitch back
    // (e.g. on Protek, pairs spanning 12+ modules from idx 3 → idx 15-18
    // landed at ~70 px because both endpoints had similar systematic offset
    // and the long-span average cancelled the bias). Same-side pairs see
    // ONLY the local pitch, which is what we actually want.
    //
    // Pairs whose implied pitch falls outside ±25 % of the initial pitch
    // are discarded as outliers (typical cause: probe landed in the middle
    // of a 2-module RCD where there is no real boundary).
    const confident = probes.filter((p) => p.confident);
    const leftConfident = confident.filter((p) => p.idx <= 4);
    const rightConfident = confident.filter((p) => p.idx >= initialModuleCount - 4);
    const sameSidePairs = [];
    for (const group of [leftConfident, rightConfident]) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i], b = group[j];
          const span = b.idx - a.idx;
          if (span <= 0) continue;
          const p = (b.refinedX - a.refinedX) / span;
          const drift = Math.abs(p - initialPitchPx) / initialPitchPx;
          if (drift > 0.25) continue;
          sameSidePairs.push({
            from: a.idx,
            to: b.idx,
            pitch: p,
            side: a.idx <= 4 ? 'L' : 'R',
          });
        }
      }
    }
    const pairwisePitches = sameSidePairs.map((p) => p.pitch);
    let candidatePitch = null;
    if (pairwisePitches.length > 0) {
      const sorted = [...pairwisePitches].sort((a, b) => a - b);
      candidatePitch = sorted[Math.floor(sorted.length / 2)];
    }
    // Sanity check vs the height-anchor estimate (drift > 25 % means
    // something went badly wrong — fall back).
    const drift = candidatePitch != null
      ? Math.abs(candidatePitch - initialPitchPx) / initialPitchPx
      : null;
    const accepted = drift != null && drift <= 0.25;
    if (accepted) {
      refinedPitchPx = candidatePitch;
      refinedModuleCount = Math.max(1, Math.round(newFaceWidth / refinedPitchPx));
    }
    pitchDiag = {
      stripHalfWidthPx: stripHalfWidth,
      probes: probes.map((p) => ({
        idx: p.idx,
        predicted: Math.round(p.predictedX),
        refined: Math.round(p.refinedX),
        snr: Math.round(p.snr * 100) / 100,
        sharpness: Math.round(p.sharpness * 100) / 100,
        centred: Math.round(p.centred * 100) / 100,
        confident: p.confident,
      })),
      confidentCount: confident.length,
      leftConfidentCount: leftConfident.length,
      rightConfidentCount: rightConfident.length,
      pairwisePitchesPx: pairwisePitches.map((p) => Math.round(p * 10) / 10),
      sameSidePairs: sameSidePairs.map((p) => ({
        from: p.from, to: p.to, pitch: Math.round(p.pitch * 10) / 10, side: p.side,
      })),
      candidatePitchPx: candidatePitch != null ? Math.round(candidatePitch * 10) / 10 : null,
      initialPitchPx: Math.round(initialPitchPx * 10) / 10,
      driftFromHeight: drift != null ? Math.round(drift * 1000) / 1000 : null,
      accepted,
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
  const stripBandY0 = diag.faceTopPx + (diag.faceBottomPx - diag.faceTopPx) * 0.60;
  const stripBandY1 = diag.faceBottomPx;

  // Build per-probe SVG fragments. Predicted = red dashed; refined = solid
  // bright-green if confident, orange if not. Label above the rail with the
  // line index + SNR + sharpness.
  const probeFragments = pitchRefinement.probes.map((p) => {
    const predX = p.predicted;
    const refX = p.refined;
    const colour = p.confident ? 'rgb(40,210,80)' : 'rgb(255,140,40)';
    const labelY = tightPx.y0 - 28;
    return `
      <line x1="${predX}" y1="${tightPx.y0}" x2="${predX}" y2="${tightPx.y1}" stroke="rgb(220,50,50)" stroke-width="1.5" stroke-dasharray="3,4" opacity="0.7"/>
      <line x1="${refX}" y1="${tightPx.y0}" x2="${refX}" y2="${tightPx.y1}" stroke="${colour}" stroke-width="3"/>
      <text x="${refX}" y="${labelY}" font-family="-apple-system,Helvetica,sans-serif" font-size="14" font-weight="700" fill="${colour}" text-anchor="middle">${p.idx} ${p.confident ? '✓' : '✗'}</text>
      <text x="${refX}" y="${tightPx.y1 + 28}" font-family="-apple-system,Helvetica,sans-serif" font-size="11" fill="${colour}" text-anchor="middle">snr=${p.snr.toFixed(2)} sh=${p.sharpness.toFixed(2)}</text>
    `;
  }).join('\n');

  // Highlight the bottom-40 % strip band that was actually searched.
  const bandFragment = `
    <rect x="${tightPx.x0}" y="${stripBandY0}" width="${tightPx.x1 - tightPx.x0}" height="${stripBandY1 - stripBandY0}"
          fill="rgba(80,180,255,0.10)" stroke="rgba(80,180,255,0.45)" stroke-width="1" stroke-dasharray="4,4"/>
  `;

  const captionParts = [
    `count=${moduleCount}${expectedCount != null ? ` vs GT=${expectedCount}` : ''}`,
    `initial pitch ${pitchRefinement.initialPitchPx}px → refined ${pitchRefinement.candidatePitchPx ?? '—'}px`,
    `confident ${pitchRefinement.confidentCount}/${pitchRefinement.probes.length}`,
    `pairs ${pitchRefinement.pairwisePitchesPx.length}`,
    pitchRefinement.accepted ? '✓ accepted' : '✗ rejected',
  ];
  const caption = captionParts.join('  ·  ');

  const svg = `
    <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <rect x="${tightPx.x0}" y="${tightPx.y0}" width="${tightPx.x1 - tightPx.x0}" height="${tightPx.y1 - tightPx.y0}"
            fill="none" stroke="rgb(40,210,80)" stroke-width="3"/>
      ${bandFragment}
      ${probeFragments}
      <rect x="0" y="${H - 56}" width="${W}" height="56" fill="rgba(20,20,20,0.85)"/>
      <text x="16" y="${H - 28}" font-family="-apple-system,Helvetica,sans-serif" font-size="20" font-weight="700" fill="rgb(40,210,80)">refined ✓</text>
      <text x="170" y="${H - 28}" font-family="-apple-system,Helvetica,sans-serif" font-size="20" font-weight="700" fill="rgb(255,140,40)">refined ✗ (low confidence)</text>
      <text x="600" y="${H - 28}" font-family="-apple-system,Helvetica,sans-serif" font-size="20" fill="rgb(220,50,50)">predicted (dashed)</text>
      <text x="900" y="${H - 28}" font-family="-apple-system,Helvetica,sans-serif" font-size="20" fill="rgb(80,180,255)">strip band (cyan)</text>
      <text x="16" y="${H - 8}" font-family="-apple-system,Helvetica,sans-serif" font-size="16" fill="rgb(220,220,220)">${caption}</text>
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
      const lPairs = (p.sameSidePairs || []).filter((s) => s.side === 'L').length;
      const rPairs = (p.sameSidePairs || []).filter((s) => s.side === 'R').length;
      console.log(
        `      pitch refine: initial=${p.initialPitchPx}px → candidate=${p.candidatePitchPx}px ` +
        `(L:${p.leftConfidentCount} probes/${lPairs} pairs, R:${p.rightConfidentCount} probes/${rPairs} pairs, ` +
        `drift ${p.driftFromHeight != null ? (p.driftFromHeight * 100).toFixed(1) + '%' : '—'}) ` +
        `${p.accepted ? 'applied ✓' : 'rejected'}  initialN=${r.initialModuleCount} → finalN=${r.moduleCount}`
      );
      const summary = p.probes.map((pr) =>
        `${pr.idx}:${pr.refined - pr.predicted >= 0 ? '+' : ''}${pr.refined - pr.predicted}` +
        `(snr=${pr.snr.toFixed(2)},sh=${pr.sharpness.toFixed(2)})${pr.confident ? '✓' : '✗'}`
      ).join('  ');
      console.log(`      probes: ${summary}`);
      if (p.sameSidePairs && p.sameSidePairs.length > 0) {
        const pairSummary = p.sameSidePairs.map((s) => `${s.side}${s.from}→${s.to}=${s.pitch}px`).join(' ');
        console.log(`      pairs:  ${pairSummary}`);
      }
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
