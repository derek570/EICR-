#!/usr/bin/env node
/**
 * End-to-end test: run the box-tightener on a corpus board, generate per-slot
 * crops from the new chunking, and (optionally) feed them through the prod
 * Stage 3 classifier to see whether the new bbox + refined pitch produces
 * good enough slot images for reliable extraction.
 *
 * Usage:
 *   node scripts/ccu-extract-via-tightener.mjs                # all annotated boards
 *   node scripts/ccu-extract-via-tightener.mjs --id <id>      # one board
 *   ANTHROPIC_API_KEY=sk-... node scripts/ccu-extract-via-tightener.mjs --classify
 *      --classify also calls Stage 3 classifySlots on the crops and prints
 *      classification + label per slot.
 *
 * Outputs:
 *   scripts/ccu-cv-corpus/debug-extract/<id>/<slotIdx>.jpg    individual crops
 *   scripts/ccu-cv-corpus/debug-extract/<id>/montage.jpg      grid of all slots
 *   ~/Library/.../ccu-extract-<timestamp>/                    iCloud mirror
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';

const argv = process.argv.slice(2);
const ONE_ID = argv.includes('--id') ? argv[argv.indexOf('--id') + 1] : null;
const CLASSIFY = argv.includes('--classify');

const ROOT = path.resolve(import.meta.dirname, 'ccu-cv-corpus');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const ANNOTATIONS = JSON.parse(fs.readFileSync(path.join(ROOT, 'annotations.json'), 'utf8'));
const DEBUG_DIR = path.join(ROOT, 'debug-extract');
fs.mkdirSync(DEBUG_DIR, { recursive: true });
const ICLOUD = path.join(os.homedir(), 'Library/Mobile Documents/com~apple~CloudDocs');
const TIMESTAMP = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const ICLOUD_DEST = path.join(ICLOUD, `ccu-extract-${TIMESTAMP}`);
fs.mkdirSync(ICLOUD_DEST, { recursive: true });

// Lazy-load the heavy prod modules. If ANTHROPIC_API_KEY isn't set in env,
// pull it from AWS Secrets Manager `eicr/api-keys` (the same secret prod uses).
async function loadClassifier() {
  if (!process.env.ANTHROPIC_API_KEY) {
    const { execSync } = await import('node:child_process');
    try {
      const raw = execSync(
        '/opt/homebrew/bin/aws secretsmanager get-secret-value --secret-id eicr/api-keys --region eu-west-2 --query SecretString --output text',
        { stdio: ['ignore', 'pipe', 'pipe'] }
      ).toString();
      const secret = JSON.parse(raw);
      if (!secret.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not in eicr/api-keys');
      process.env.ANTHROPIC_API_KEY = secret.ANTHROPIC_API_KEY;
      console.log('  loaded ANTHROPIC_API_KEY from AWS Secrets Manager (eicr/api-keys)');
    } catch (err) {
      throw new Error(`failed to fetch key from AWS: ${err.message}`);
    }
  }
  const mod = await import('../src/extraction/ccu-geometric.js');
  return mod.classifySlots;
}

// ---------------------------------------------------------------------------
// Tightener — re-use the harness's `tightenBox` so the chunking stays in
// lockstep with whatever logic the prototype currently has. The harness
// returns the rail bbox + module count + tilePitch; we just need to convert
// those to slot bboxes for cropping.
// ---------------------------------------------------------------------------
import { tightenBox } from './ccu-box-tighten.mjs';

// Build slot bboxes from the harness's tightenBox result. Slot i spans
//   [faceLeftPx + i × tilePitch,  faceLeftPx + (i+1) × tilePitch]
// vertically across the full face height.
function bboxesFromTightener(t) {
  const { diag, moduleCount, tilePitchPx } = t;
  const out = [];
  for (let i = 0; i < moduleCount; i++) {
    out.push({
      x: diag.faceLeftPx + tilePitchPx * i,
      y: diag.faceTopPx,
      w: tilePitchPx,
      h: diag.faceHeightPx,
    });
  }
  return out;
}

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

async function findHorizontalEdge(imageBuffer, W, H, xRangeStart, xRangeEnd, centreYpx, padYpx) {
  const stripY0 = Math.max(0, centreYpx - padYpx);
  const stripY1 = Math.min(H, centreYpx + padYpx);
  const stripH = stripY1 - stripY0;
  const stripW = xRangeEnd - xRangeStart;
  if (stripH < 3 || stripW < 3) return centreYpx;
  const buf = await sharp(imageBuffer).extract({ left: xRangeStart, top: stripY0, width: stripW, height: stripH }).toBuffer();
  const rowSig = smooth3(await sobelYRowSum(buf, stripW, stripH));
  let peakI = 0, peakV = -Infinity;
  for (let i = 1; i < stripH - 1; i++) if (rowSig[i] > peakV) { peakV = rowSig[i]; peakI = i; }
  return stripY0 + peakI;
}

async function findVerticalEdge(imageBuffer, W, H, yRangeStart, yRangeEnd, centreXpx, padXpx) {
  const stripX0 = Math.max(0, centreXpx - padXpx);
  const stripX1 = Math.min(W, centreXpx + padXpx);
  const stripW = stripX1 - stripX0;
  const stripH = yRangeEnd - yRangeStart;
  if (stripW < 3 || stripH < 3) return centreXpx;
  const buf = await sharp(imageBuffer).extract({ left: stripX0, top: yRangeStart, width: stripW, height: stripH }).toBuffer();
  const colSig = smooth3(await sobelXColSum(buf, stripW, stripH));
  let peakI = 0, peakV = -Infinity;
  for (let i = 1; i < stripW - 1; i++) if (colSig[i] > peakV) { peakV = colSig[i]; peakI = i; }
  return stripX0 + peakI;
}

async function chunkRail(imageBuffer, userBox) {
  const meta = await sharp(imageBuffer).metadata();
  const W = meta.width, H = meta.height;
  const t = await tightenBox(imageBuffer, userBox);
  return {
    W, H,
    rail: {
      left: t.diag.faceLeftPx,
      right: t.diag.faceRightPx,
      top: t.diag.faceTopPx,
      bottom: t.diag.faceBottomPx,
    },
    initialPitchPx: t.initialPitchPx,
    pitchPx: t.tilePitchPx,
    moduleCount: t.moduleCount,
    slotCenters: t.slotCentersPx,
    slotBboxes: bboxesFromTightener(t),
    tightener: t,
  };
}

// ---------------------------------------------------------------------------
// Slot-crop generation — Stage 3 expects a tall portrait crop centred on each
// module that includes margin above + below the rail face for the toggle and
// silkscreen label.
// ---------------------------------------------------------------------------
const SLOT_VPAD_FRAC = 0.45;     // 45 % of face height padding above & below
const SLOT_HPAD_FRAC = 0.10;     // 10 % of slot width padding left & right (helps OCR)

async function generateSlotCrop(imageBuffer, slotBbox, W, H) {
  const padX = slotBbox.w * SLOT_HPAD_FRAC;
  const padY = slotBbox.h * SLOT_VPAD_FRAC;
  const x0 = Math.max(0, Math.round(slotBbox.x - padX));
  const y0 = Math.max(0, Math.round(slotBbox.y - padY));
  const x1 = Math.min(W, Math.round(slotBbox.x + slotBbox.w + padX));
  const y1 = Math.min(H, Math.round(slotBbox.y + slotBbox.h + padY));
  return sharp(imageBuffer)
    .extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 })
    .jpeg({ quality: 88 })
    .toBuffer();
}

async function buildMontage(crops, gridCols = 5) {
  const rows = Math.ceil(crops.length / gridCols);
  // Resize each to a uniform height of 360 px.
  const targetH = 360;
  const resized = await Promise.all(
    crops.map((c) => sharp(c.buffer).resize({ height: targetH }).jpeg().toBuffer())
  );
  // Compute composite layout.
  const cellW = await Promise.all(
    resized.map(async (r) => (await sharp(r).metadata()).width)
  );
  const colW = Math.max(...cellW);
  const totalW = colW * gridCols + 8 * (gridCols + 1);
  const rowH = targetH + 32; // +32 px for label strip below
  const totalH = rowH * rows + 8;
  const composites = [];
  for (let i = 0; i < resized.length; i++) {
    const col = i % gridCols, row = Math.floor(i / gridCols);
    const left = 8 + col * (colW + 8) + Math.floor((colW - cellW[i]) / 2);
    const top = 8 + row * rowH;
    composites.push({ input: resized[i], top, left });
    // Slot label as SVG below the crop.
    const labelSvg = `<svg width="${colW}" height="28">
      <rect width="${colW}" height="28" fill="rgb(20,20,20)"/>
      <text x="${colW / 2}" y="20" font-family="-apple-system,sans-serif" font-size="14" fill="rgb(220,220,220)" text-anchor="middle">slot ${i + 1}</text>
    </svg>`;
    composites.push({ input: Buffer.from(labelSvg), top: 8 + row * rowH + targetH, left: 8 + col * (colW + 8) });
  }
  return sharp({
    create: { width: totalW, height: totalH, channels: 3, background: { r: 30, g: 30, b: 30 } },
  }).composite(composites).jpeg({ quality: 85 }).toBuffer();
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------
const annotations = ANNOTATIONS.annotations || {};
const annotated = Object.keys(annotations).filter((id) => annotations[id].groundTruth != null);
const targets = ONE_ID ? [ONE_ID] : annotated;

let classifier = null;
if (CLASSIFY) classifier = await loadClassifier();

console.log(`Per-slot extract test — ${targets.length} board${targets.length === 1 ? '' : 's'}  (classify ${CLASSIFY ? 'ON' : 'OFF'})`);

for (const id of targets) {
  const entry = MANIFEST.entries.find((e) => e.extractionId === id);
  const ann = annotations[id] || {};
  if (!entry?.userBox) {
    console.warn(`[skip] ${id} — no userBox`);
    continue;
  }
  const photoPath = path.join(ROOT, entry.photo);
  const photoBytes = fs.readFileSync(photoPath);
  console.log(`\n--- ${id} (${entry.boardManufacturer ?? '?'}, GT=${ann.groundTruth ?? '?'}) ---`);

  const chunk = await chunkRail(photoBytes, entry.userBox);
  console.log(`  rail: ${chunk.rail.right - chunk.rail.left} × ${chunk.rail.bottom - chunk.rail.top} px`);
  console.log(`  pitch: ${chunk.pitchPx.toFixed(1)} px (initial ${chunk.initialPitchPx.toFixed(1)})  modules: ${chunk.moduleCount}`);

  const idDir = path.join(DEBUG_DIR, id);
  fs.mkdirSync(idDir, { recursive: true });
  const idICloud = path.join(ICLOUD_DEST, `${entry.boardManufacturer ?? 'board'}-${id}`);
  fs.mkdirSync(idICloud, { recursive: true });

  const crops = [];
  for (let i = 0; i < chunk.slotBboxes.length; i++) {
    const buf = await generateSlotCrop(photoBytes, chunk.slotBboxes[i], chunk.W, chunk.H);
    crops.push({ slotIndex: i, buffer: buf, bbox: chunk.slotBboxes[i] });
    fs.writeFileSync(path.join(idDir, `slot-${String(i + 1).padStart(2, '0')}.jpg`), buf);
  }
  // Build + save the slot montage so it's easy to eyeball all slots at once.
  const montage = await buildMontage(crops, 5);
  fs.writeFileSync(path.join(idDir, 'montage.jpg'), montage);
  fs.writeFileSync(path.join(idICloud, '00-montage.jpg'), montage);
  for (let i = 0; i < crops.length; i++) {
    fs.writeFileSync(path.join(idICloud, `slot-${String(i + 1).padStart(2, '0')}.jpg`), crops[i].buffer);
  }

  if (CLASSIFY && classifier) {
    console.log(`  classifying ${crops.length} slots via Stage 3 VLM...`);
    const t0 = Date.now();
    let result;
    try {
      result = await classifier(photoBytes, crops);
    } catch (err) {
      console.log(`  classify FAILED: ${err.message}`);
      continue;
    }
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  classified in ${dt}s  (${result.batchCount} batches, ${result.usage.inputTokens} tok in / ${result.usage.outputTokens} tok out)`);
    for (const slot of result.slots) {
      const cls = slot.classification ?? '?';
      const rt = slot.ratingText ?? '-';
      const lbl = slot.label ? ` "${slot.label}"` : '';
      const conf = slot.confidence != null ? ` conf=${slot.confidence.toFixed(2)}` : '';
      console.log(`    slot ${String(slot.slotIndex + 1).padStart(2)}: ${cls.padEnd(12)} ${String(rt).padEnd(8)}${lbl}${conf}`);
    }
    fs.writeFileSync(path.join(idICloud, 'classifier-result.json'), JSON.stringify(result, null, 2));
  }

  console.log(`  → debug:  ${path.relative(process.cwd(), idDir)}/`);
  console.log(`  → iCloud: ${path.relative(os.homedir(), idICloud)}`);
}

console.log(`\niCloud root: ${path.relative(os.homedir(), ICLOUD_DEST)}`);
