/**
 * Local CCU pipeline harness — runs the updated per-slot pipeline end-to-end
 * against a photo on disk, using the same modules the production route
 * handler uses. No HTTP, no S3, no DB — just the extraction stages.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/ccu-local-run.mjs <path-to-jpg>
 *
 * Confirms, before deploy, that:
 *   - Stage 2 slot count matches the visible module count (Fix 1 clamp)
 *   - Disagreement gate fires when needed (Fix 2)
 *   - Stage 4 labelsRead > 0 on the Wylex NHRS12SL reproducer (Fix 3)
 */
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import {
  prepareModernGeometry,
  classifyModernSlots,
} from '../src/extraction/ccu-geometric.js';
import { extractSlotLabels } from '../src/extraction/ccu-label-pass.js';
import { slotsToCircuits } from '../src/routes/extraction.js';

const photoPath = process.argv[2];
if (!photoPath) {
  console.error('usage: node scripts/ccu-local-run.mjs <path-to-jpg>');
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY env var required');
  process.exit(1);
}

const raw = fs.readFileSync(path.resolve(photoPath));
console.log(`[harness] input: ${photoPath} (${(raw.length / 1024).toFixed(0)} KB)`);

// Replicate the route-handler resize (≤ 3.7MB raw → 2048x2048 fit=inside, q80).
const MAX_RAW = Math.floor(5 * 1024 * 1024 * 0.74);
const imageBuffer = raw.length > MAX_RAW
  ? await sharp(raw).resize(2048, 2048, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer()
  : raw;
const meta = await sharp(imageBuffer).metadata();
console.log(`[harness] resized: ${meta.width}x${meta.height} (${(imageBuffer.length / 1024).toFixed(0)} KB)`);

// --- Stage 1 + Stage 2 --------------------------------------------------
console.log('\n[harness] running Stage 1 + Stage 2 (prepareModernGeometry)…');
const t0 = Date.now();
const prepared = await prepareModernGeometry(imageBuffer);
const prepMs = Date.now() - t0;
console.log(`[harness] Stage 1+2 done in ${(prepMs / 1000).toFixed(1)}s`);
console.log(`  medianRails:        ${JSON.stringify(prepared.medianRails)}`);
console.log(`  moduleCount (post-clamp): ${prepared.moduleCount}`);
console.log(`  vlmCount (direct):        ${prepared.vlmCount}`);
console.log(`  disagreement:             ${prepared.disagreement}`);
console.log(`  truncatedFromDisagreement: ${prepared.truncatedFromDisagreement}`);
console.log(`  mainSwitchSide:           ${prepared.mainSwitchSide}`);
console.log(`  mainSwitchCenterX/Width:  ${prepared.mainSwitchCenterX} / ${prepared.mainSwitchWidth}`);
console.log(`  moduleWidth:              ${prepared.moduleWidth}`);
console.log(`  slotCentersX:             [${prepared.slotCentersX.map(x => Math.round(x)).join(', ')}]`);
console.log(`  lowConfidence:            ${prepared.lowConfidence}`);

// --- Stage 3 + Stage 4 in parallel (matches production order) -----------
console.log('\n[harness] running Stage 3 (classify) || Stage 4 (labels)…');
const panelTopNorm = prepared.medianRails.rail_top;
const panelBottomNorm = prepared.medianRails.rail_bottom;
const slotPitchNorm = prepared.moduleWidth;
const slotPitchPx = (slotPitchNorm / 1000) * prepared.imageWidth;
const slotCentersPx = prepared.slotCentersX.map(x => (x / 1000) * prepared.imageWidth);

const [classified, labelPass] = await Promise.all([
  classifyModernSlots(imageBuffer, prepared),
  extractSlotLabels(imageBuffer, {
    slotCentersX: slotCentersPx,
    slotPitchPx,
    panelTopNorm,
    panelBottomNorm,
    imageWidth: prepared.imageWidth,
    imageHeight: prepared.imageHeight,
  }),
]);
console.log(`[harness] Stage 3 done; error=${classified.stage3Error ?? 'null'}; slots=${classified.slots?.length ?? 0}`);
console.log(`[harness] Stage 4 done; labels=${labelPass.labels.length}, labelsRead=${labelPass.labels.filter(l => l.label != null).length}, skipped=${labelPass.skippedSlotIndices?.length ?? 0}`);
console.log(`  Stage 4 vlmMs: ${labelPass.timings?.vlmMs}  tokensIn/out: ${labelPass.usage?.inputTokens}/${labelPass.usage?.outputTokens}`);

// --- Attach labels onto slots (mirrors route handler) --------------------
const labelBySlotIndex = new Map(labelPass.labels.map(l => [l.slotIndex, l]));
const slotsWithLabels = (classified.slots ?? []).map(s => {
  const l = labelBySlotIndex.get(s.slotIndex);
  return l ? { ...s, label: l.label ?? null, labelRaw: l.rawLabel ?? null, labelConfidence: l.confidence } : s;
});

console.log('\n[harness] Per-slot result:');
for (const s of slotsWithLabels) {
  const lbl = s.label ? `"${s.label}"` : '—';
  const raw = s.labelRaw && s.labelRaw !== s.label ? ` (raw="${s.labelRaw}")` : '';
  const lblConf = s.labelConfidence != null ? ` lblConf=${s.labelConfidence.toFixed(2)}` : '';
  console.log(
    `  #${String(s.slotIndex).padStart(2, ' ')}  ${s.classification.padEnd(12, ' ')}  ` +
      `${(s.manufacturer ?? '-').padEnd(10, ' ')}  ` +
      `${(s.ratingAmps != null ? String(s.ratingAmps) + 'A' : '-').padEnd(4, ' ')}  ` +
      `${(s.tripCurve ?? '-').padEnd(2, ' ')}  ` +
      `conf=${(s.confidence ?? 0).toFixed(2)}  ` +
      `label=${lbl}${raw}${lblConf}`
  );
}

// --- Merger → circuits[] -------------------------------------------------
const mainSwitchSide = prepared.mainSwitchSide ?? 'right'; // fallback for boards w/o upstream hint
const circuits = slotsToCircuits({ slots: slotsWithLabels, mainSwitchSide });

console.log(`\n[harness] Merger → circuits[] (mainSwitchSide=${mainSwitchSide}):`);
if (!circuits) {
  console.log('  (merger returned null)');
} else {
  for (const c of circuits) {
    console.log(
      `  circuit ${String(c.circuit_number).padStart(2, ' ')}  ` +
        `label="${c.label ?? ''}"  ` +
        `${c.ocpd_type ?? '-'}${c.ocpd_rating_a ?? '-'}A  ` +
        `${c.ocpd_bs_en ?? '-'}  ` +
        `RCD: ${c.rcd_protected ? `${c.rcd_type ?? '?'}/${c.rcd_rating_ma ?? '?'}mA` : 'no'}` +
        (c.low_confidence ? '  [LOW-CONF]' : '')
    );
  }
  console.log(`  total circuits: ${circuits.length}`);
}

console.log('\n[harness] done.');
