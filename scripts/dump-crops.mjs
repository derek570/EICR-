/**
 * Dump the actual Stage 3 + Stage 4 crops for a photo so we can eyeball
 * what the VLM is seeing. Useful for diagnosing:
 *   - Low-confidence Stage 3 readings (crop too tight? face obscured?)
 *   - Label bleed-in (neighbour handwriting dominating the crop)
 *
 * Usage:
 *   node scripts/dump-crops.mjs <path-to-jpg> <out-dir>
 */
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { cropSlot } from '../src/extraction/ccu-geometric.js';
import { cropSlotLabelZone } from '../src/extraction/ccu-label-pass.js';

const [photoPath, outDir] = process.argv.slice(2);
if (!photoPath || !outDir) {
  console.error('usage: node scripts/dump-crops.mjs <photo> <out-dir>');
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

const raw = fs.readFileSync(path.resolve(photoPath));
const MAX_RAW = Math.floor(5 * 1024 * 1024 * 0.74);
const imageBuffer = raw.length > MAX_RAW
  ? await sharp(raw).resize(2048, 2048, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer()
  : raw;
const meta = await sharp(imageBuffer).metadata();
console.log('resized:', meta.width, 'x', meta.height);

// Use the geometry from harness-run3.txt.
const geom = {
  slotCentersX: [110, 160, 210, 260, 310, 360, 410, 460, 510, 560, 610, 660, 710, 760, 810, 860],
  moduleWidth: 50,
  railTop: 480,
  railBottom: 590,
  imageWidth: meta.width,
  imageHeight: meta.height,
};
const labelGeom = {
  slotCentersX: geom.slotCentersX.map(x => (x / 1000) * meta.width),
  slotPitchPx: (geom.moduleWidth / 1000) * meta.width,
  panelTopNorm: geom.railTop,
  panelBottomNorm: geom.railBottom,
  imageWidth: meta.width,
  imageHeight: meta.height,
};

for (const slotIndex of [0, 1, 6, 7, 8, 9, 10, 11, 14, 15]) {
  const { buffer: stage3Buf, bbox: stage3Box } = await cropSlot(imageBuffer, slotIndex, geom);
  const stage3Path = path.join(outDir, `slot-${String(slotIndex).padStart(2, '0')}-stage3.jpg`);
  fs.writeFileSync(stage3Path, stage3Buf);
  console.log(`slot ${slotIndex}: stage3 bbox ${stage3Box.x},${stage3Box.y} ${stage3Box.w}x${stage3Box.h}  →  ${stage3Path}`);

  const { buffer: stage4Buf, bbox: stage4Box } = await cropSlotLabelZone(imageBuffer, slotIndex, labelGeom);
  const stage4Path = path.join(outDir, `slot-${String(slotIndex).padStart(2, '0')}-stage4.jpg`);
  fs.writeFileSync(stage4Path, stage4Buf);
  console.log(`slot ${slotIndex}: stage4 bbox ${stage4Box.x},${stage4Box.y} ${stage4Box.w}x${stage4Box.h}  →  ${stage4Path}`);
}
console.log('done.');
