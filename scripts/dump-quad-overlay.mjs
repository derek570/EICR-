#!/usr/bin/env node
/**
 * Dump a visual overlay showing exactly what the new quad-geometry
 * pipeline sends to the Stage 4 VLM for each circuit slot.
 *
 * Produces (in the chosen output directory):
 *   - overlay.png            — original photo with the rail quadrilateral
 *                              outlined, slot-centre vertical guides, and
 *                              per-slot crop rectangles labelled with their
 *                              slot index.
 *   - slot-NN.jpg            — the actual cropped image fed to Stage 4 for
 *                              slot NN (one file per slot).
 *   - quad-geometry.json     — full diagnostics from tightenAndChunkQuad
 *                              (corners, slot centres, line fit residuals).
 *
 * Usage:
 *   node scripts/dump-quad-overlay.mjs <photo> <out-dir> [--roi x,y,w,h]
 *
 *   --roi defaults to the user-box from the corpus manifest if the photo
 *   matches a corpus extractionId. Otherwise required as a CLI arg.
 *
 * Example:
 *   node scripts/dump-quad-overlay.mjs ~/photo.jpg ~/Desktop/overlay-out
 *   node scripts/dump-quad-overlay.mjs ~/photo.jpg ~/Desktop/out \
 *       --roi 0.044,0.353,0.940,0.224
 */

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { tightenAndChunkQuad } from '../src/extraction/ccu-rail-quad.js';
import { cropSlot } from '../src/extraction/ccu-geometric.js';
import { cropSlotLabelZone } from '../src/extraction/ccu-label-pass.js';

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: node scripts/dump-quad-overlay.mjs <photo> <out-dir> [--roi x,y,w,h]');
  process.exit(1);
}
const [photoPath, outDir] = args;
let roi = null;
const roiIdx = args.indexOf('--roi');
if (roiIdx !== -1 && args[roiIdx + 1]) {
  const parts = args[roiIdx + 1].split(',').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p))) {
    console.error('--roi must be 4 comma-separated floats: x,y,w,h');
    process.exit(1);
  }
  roi = { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

// Try to look the ROI up in the corpus manifest if not supplied.
if (!roi) {
  const manifestPath = path.resolve(import.meta.dirname, 'ccu-cv-corpus', 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const photoBase = path.basename(photoPath);
    const entry = manifest.entries.find(
      (e) =>
        e.photo &&
        (path.basename(e.photo) === photoBase ||
          photoPath.includes(e.extractionId))
    );
    if (entry?.userBox) {
      roi = entry.userBox;
      console.log(`[roi] from corpus manifest: ${entry.extractionId}`);
    }
  }
}

if (!roi) {
  console.error(
    '--roi required (no corpus manifest match). Pass --roi x,y,w,h with values from the iOS railRoiHint or CloudWatch logs.'
  );
  process.exit(1);
}

console.log(`[input] photo=${photoPath} roi=${JSON.stringify(roi)}`);
fs.mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------------------
// Run the quad-geometry pipeline
// ---------------------------------------------------------------------------

const photo = fs.readFileSync(path.resolve(photoPath));
const meta = await sharp(photo).metadata();
console.log(`[image] ${meta.width}×${meta.height}`);

const t0 = Date.now();
const tightened = await tightenAndChunkQuad(photo, roi);
const tElapsed = Date.now() - t0;

console.log(`[quad] ${tElapsed}ms — count=${tightened.moduleCount} pitch=${tightened.pitchPx.toFixed(1)} normCorr=${tightened.refinement.quadDiag.rectNormCorr}`);
console.log(`[quad] corners: TL(${Math.round(tightened.quadrilateral.tl.x)},${Math.round(tightened.quadrilateral.tl.y)}) TR(${Math.round(tightened.quadrilateral.tr.x)},${Math.round(tightened.quadrilateral.tr.y)}) BL(${Math.round(tightened.quadrilateral.bl.x)},${Math.round(tightened.quadrilateral.bl.y)}) BR(${Math.round(tightened.quadrilateral.br.x)},${Math.round(tightened.quadrilateral.br.y)})`);

fs.writeFileSync(
  path.join(outDir, 'quad-geometry.json'),
  JSON.stringify(tightened, null, 2)
);

// ---------------------------------------------------------------------------
// Build the SVG overlay
// ---------------------------------------------------------------------------

// Two crop tiers — Stage 3 (classification) is intentionally wide to
// capture 2-pole devices; Stage 4 (label OCR) is tight to avoid
// neighbour-label bleed.
//   Stage 3: halfWidth = pitch * 0.5 * 2.2  → total = 2.2× pitch
//   Stage 4: halfWidth = pitch * 0.6        → total = 1.2× pitch
const W = meta.width;
const H = meta.height;
const pitchPx = tightened.pitchPx;
const railTop = tightened.railFace.top;
const railBot = tightened.railFace.bottom;
const railHeight = railBot - railTop;
const stage3HalfX = pitchPx * 0.5 * 2.2;
const stage4HalfX = pitchPx * 0.6;
const stage3HalfY = (railHeight / 2) * 1.3; // 30% vertical pad on rail centerline
const stage4HalfY = railHeight * 0.55; // label pass is taller (labels live above/below)

const stage3Rects = tightened.slotCentersPx.map((cx, idx) => {
  const cy = (railTop + railBot) / 2;
  const x0 = Math.max(0, Math.round(cx - stage3HalfX));
  const x1 = Math.min(W, Math.round(cx + stage3HalfX));
  const y0 = Math.max(0, Math.round(cy - stage3HalfY));
  const y1 = Math.min(H, Math.round(cy + stage3HalfY));
  return { idx, x0, y0, w: x1 - x0, h: y1 - y0, cx };
});
const stage4Rects = tightened.slotCentersPx.map((cx, idx) => {
  const cy = (railTop + railBot) / 2;
  const x0 = Math.max(0, Math.round(cx - stage4HalfX));
  const x1 = Math.min(W, Math.round(cx + stage4HalfX));
  const y0 = Math.max(0, Math.round(cy - stage4HalfY));
  const y1 = Math.min(H, Math.round(cy + stage4HalfY));
  return { idx, x0, y0, w: x1 - x0, h: y1 - y0, cx };
});
// Aliased for the rest of the file (label rendering uses Stage 3 bounds).
const cropRects = stage3Rects;

const q = tightened.quadrilateral;
const slotLineColor = '#00ffff';
const cropRectColor = '#ff8800';
const quadColor = '#ff00ff';
const labelBg = 'rgba(0,0,0,0.7)';
const labelFg = '#ffffff';
const labelFontSize = Math.max(28, Math.round(railHeight * 0.18));

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <!-- Rail quadrilateral (magenta) -->
  <polygon points="${q.tl.x},${q.tl.y} ${q.tr.x},${q.tr.y} ${q.br.x},${q.br.y} ${q.bl.x},${q.bl.y}"
           fill="none" stroke="${quadColor}" stroke-width="6" stroke-dasharray="20,8" />

  <!-- Stage 3 classification crop rectangles (orange, wide — 2.2× pitch) -->
  ${stage3Rects
    .map(
      (r) =>
        `<rect x="${r.x0}" y="${r.y0}" width="${r.w}" height="${r.h}" fill="none" stroke="${cropRectColor}" stroke-width="3" />`
    )
    .join('\n  ')}

  <!-- Stage 4 label-pass crop rectangles (lime, tight — 1.2× pitch) -->
  ${stage4Rects
    .map(
      (r) =>
        `<rect x="${r.x0}" y="${r.y0}" width="${r.w}" height="${r.h}" fill="none" stroke="#00ff00" stroke-width="3" />`
    )
    .join('\n  ')}

  <!-- Slot-centre vertical guides (cyan, dashed) -->
  ${tightened.slotCentersPx
    .map(
      (cx) =>
        `<line x1="${cx}" y1="${railTop - stage3HalfY}" x2="${cx}" y2="${railBot + stage3HalfY}" stroke="${slotLineColor}" stroke-width="2" stroke-dasharray="6,6" />`
    )
    .join('\n  ')}

  <!-- Slot index labels -->
  ${cropRects
    .map((r, i) => {
      const labelW = labelFontSize * 1.6;
      const labelH = labelFontSize * 1.3;
      const lx = r.x0 + r.w / 2 - labelW / 2;
      const ly = r.y0 - labelH - 4;
      return `<g>
        <rect x="${lx}" y="${ly}" width="${labelW}" height="${labelH}" fill="${labelBg}" rx="4" />
        <text x="${lx + labelW / 2}" y="${ly + labelH * 0.75}" font-family="sans-serif" font-size="${labelFontSize}" font-weight="bold" fill="${labelFg}" text-anchor="middle">${i}</text>
      </g>`;
    })
    .join('\n  ')}

  <!-- Header banner -->
  <rect x="20" y="20" width="${Math.min(W - 40, 1200)}" height="${labelFontSize * 2.2}" fill="${labelBg}" rx="8" />
  <text x="40" y="${20 + labelFontSize * 1.4}" font-family="sans-serif" font-size="${labelFontSize * 0.9}" font-weight="bold" fill="${labelFg}">
    quad: count=${tightened.moduleCount} pitch=${tightened.pitchPx.toFixed(1)}px normCorr=${tightened.refinement.quadDiag.rectNormCorr.toFixed(3)} ${tightened.waysOverrideApplied ? '[ways-override]' : ''}
  </text>
</svg>`;

fs.writeFileSync(path.join(outDir, 'overlay.svg'), svg);

// Composite the SVG over the photo
const overlayPath = path.join(outDir, 'overlay.png');
await sharp(photo)
  .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
  .png()
  .toFile(overlayPath);
console.log(`[overlay] ${overlayPath}`);

// ---------------------------------------------------------------------------
// Dump per-slot crops (what Stage 4 actually sees)
// ---------------------------------------------------------------------------

// Build the geom shape that cropSlot expects (0-1000 normalised).
const geom = {
  slotCentersX: tightened.slotCentersPx.map((px) => (px / W) * 1000),
  moduleWidth: (pitchPx / W) * 1000,
  railTop: (railTop / H) * 1000,
  railBottom: (railBot / H) * 1000,
  imageWidth: W,
  imageHeight: H,
};

// Stage 4 label-pass uses a different geom shape (slotPitchPx, panelTop/BottomNorm)
const labelGeom = {
  slotCentersX: tightened.slotCentersPx, // pixels, not normalised — see ccu-label-pass
  slotPitchPx: pitchPx,
  panelTopNorm: (railTop / H) * 1000,
  panelBottomNorm: (railBot / H) * 1000,
  imageWidth: W,
  imageHeight: H,
};

let cropCount = 0;
for (let i = 0; i < tightened.moduleCount; i++) {
  // Stage 3 — classification crop (wide, 2.2× pitch)
  const { buffer: bufClassify, bbox: bboxClassify } = await cropSlot(photo, i, geom);
  fs.writeFileSync(
    path.join(outDir, `slot-${String(i).padStart(2, '0')}-classify.jpg`),
    bufClassify
  );
  // Stage 4 — label-pass crop (tight, 1.2× pitch)
  try {
    const { buffer: bufLabel } = await cropSlotLabelZone(photo, i, labelGeom);
    fs.writeFileSync(
      path.join(outDir, `slot-${String(i).padStart(2, '0')}-label.jpg`),
      bufLabel
    );
  } catch (err) {
    console.warn(`[crop] slot ${i} label-pass error: ${err.message}`);
  }
  cropCount += 1;
  console.log(
    `[crop] slot ${i} — classify ${bboxClassify.w}×${bboxClassify.h} (${(bboxClassify.w / pitchPx).toFixed(2)}× pitch), label ${Math.round(stage4HalfX * 2)}×${Math.round(stage4HalfY * 2)} (${((stage4HalfX * 2) / pitchPx).toFixed(2)}× pitch)`
  );
}

// ---------------------------------------------------------------------------
// Index file: quick HTML so the iCloud preview can show all crops in order
// ---------------------------------------------------------------------------

const indexHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>quad-overlay — ${path.basename(photoPath)}</title>
<style>
  body { font-family: -apple-system, sans-serif; margin: 24px; background: #111; color: #eee; }
  h1 { margin: 0 0 12px; }
  .meta { color: #aaa; margin-bottom: 24px; }
  img { max-width: 100%; border: 1px solid #333; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; margin-top: 24px; }
  .slot { background: #222; padding: 8px; border-radius: 6px; text-align: center; }
  .slot img { width: 100%; }
  .slot .idx { font-weight: bold; font-size: 18px; margin-top: 6px; }
</style></head>
<body>
  <h1>${path.basename(photoPath)}</h1>
  <div class="meta">
    quad geometry · count=${tightened.moduleCount} · pitch=${tightened.pitchPx.toFixed(1)}px ·
    normCorr=${tightened.refinement.quadDiag.rectNormCorr.toFixed(3)}
    ${tightened.waysOverrideApplied ? '· ways-override' : ''}
  </div>
  <img src="overlay.png" alt="overlay">
  <p style="color:#aaa; font-size:14px; margin-top: 12px;">
    <span style="color:#ff8800">orange</span> = Stage 3 classification crop (2.2× pitch — wide so 2-pole devices fit) ·
    <span style="color:#00ff00">green</span> = Stage 4 label-pass crop (1.2× pitch — tight to avoid neighbour bleed) ·
    <span style="color:#ff00ff">magenta</span> = rail quadrilateral ·
    <span style="color:#00ffff">cyan</span> = slot centres
  </p>
  <h2>Stage 3 classification crops (what the device-classifier sees, 2.2× pitch)</h2>
  <div class="grid">
    ${cropRects
      .map(
        (r, i) => `
    <div class="slot">
      <img src="slot-${String(i).padStart(2, '0')}-classify.jpg">
      <div class="idx">slot ${i}</div>
    </div>`
      )
      .join('')}
  </div>
  <h2>Stage 4 label crops (what the OCR sees, 1.2× pitch)</h2>
  <div class="grid">
    ${cropRects
      .map(
        (r, i) => `
    <div class="slot">
      <img src="slot-${String(i).padStart(2, '0')}-label.jpg">
      <div class="idx">slot ${i}</div>
    </div>`
      )
      .join('')}
  </div>
</body></html>`;
fs.writeFileSync(path.join(outDir, 'index.html'), indexHtml);

console.log(`\n✅ done — ${cropCount} crops + overlay.png + index.html in ${outDir}`);
