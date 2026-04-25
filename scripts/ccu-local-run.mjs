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
import { slotsToCircuits, classifyBoardTechnology } from '../src/routes/extraction.js';
import Anthropic from '@anthropic-ai/sdk';

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

// Sonnet 4.6 pricing (as of 2026-04, per Anthropic published rates).
// Override via env if pricing changes without redeploy.
const IN_PER_MTOK = Number(process.env.SONNET_IN_PER_MTOK || 3.0);
const OUT_PER_MTOK = Number(process.env.SONNET_OUT_PER_MTOK || 15.0);
function costUsd(usage) {
  const inT = usage?.inputTokens ?? 0;
  const outT = usage?.outputTokens ?? 0;
  return (inT * IN_PER_MTOK + outT * OUT_PER_MTOK) / 1_000_000;
}
const stageCosts = {};
const MODEL = (process.env.CCU_MODEL || 'claude-sonnet-4-6').trim();

// --- Stage 1b — board-technology classifier (runs FIRST in production) ---
console.log('\n[harness] running Stage 1b (classifyBoardTechnology)…');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const base64 = imageBuffer.toString('base64');
const t1b = Date.now();
const boardClass = await classifyBoardTechnology(base64, anthropic, MODEL);
const t1bMs = Date.now() - t1b;
stageCosts.stage1b = {
  tokensIn: boardClass.usage.inputTokens,
  tokensOut: boardClass.usage.outputTokens,
  usd: costUsd(boardClass.usage),
  ms: t1bMs,
};
console.log(`  board_technology=${boardClass.boardTechnology}  mainSwitch=${boardClass.mainSwitchPosition}  conf=${boardClass.confidence}  (${(t1bMs/1000).toFixed(1)}s)`);

// --- Stage 1 + Stage 2 --------------------------------------------------
// Optional: pass `--roi x,y,w,h` to simulate the iOS framing-box hint and
// verify the Stage 1 bypass path locally. Values are 0-1 normalised image
// coords (top-left + size). Without the flag, the VLM rail-detection path
// runs as before.
let railRoiHint = null;
const roiFlag = process.argv.find((a) => a.startsWith('--roi='));
if (roiFlag) {
  const [x, y, w, h] = roiFlag.slice('--roi='.length).split(',').map(Number);
  railRoiHint = { x, y, w, h };
  console.log(`[harness] using ROI hint: ${JSON.stringify(railRoiHint)}`);
}

console.log('\n[harness] running Stage 1 + Stage 2 (prepareModernGeometry)…');
const t0 = Date.now();
const prepared = await prepareModernGeometry(imageBuffer, { railRoiHint });
const prepMs = Date.now() - t0;
stageCosts.stage1_2 = {
  tokensIn: prepared.usage.inputTokens,
  tokensOut: prepared.usage.outputTokens,
  usd: costUsd(prepared.usage),
  ms: prepMs,
};
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

const parT0 = Date.now();
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
const parMs = Date.now() - parT0;
stageCosts.stage3 = {
  tokensIn: classified.usage?.inputTokens ?? 0,
  tokensOut: classified.usage?.outputTokens ?? 0,
  usd: costUsd(classified.usage),
  ms: classified.timings?.stage3Ms ?? 0,
};
stageCosts.stage4 = {
  tokensIn: labelPass.usage?.inputTokens ?? 0,
  tokensOut: labelPass.usage?.outputTokens ?? 0,
  usd: costUsd(labelPass.usage),
  ms: labelPass.timings?.vlmMs ?? 0,
};
stageCosts.parallelWallMs = parMs;
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

// --- Cost + timing summary ----------------------------------------------
console.log('\n[harness] COST / TOKEN SUMMARY  (model: ' + MODEL + ')');
console.log(`  pricing assumed: $${IN_PER_MTOK.toFixed(2)}/Mtok in · $${OUT_PER_MTOK.toFixed(2)}/Mtok out`);
console.log('');
const stageRows = [
  ['Stage 1b  board-tech classifier   ', stageCosts.stage1b],
  ['Stage 1+2 rail geom + module count', stageCosts.stage1_2],
  ['Stage 3   per-slot classify       ', stageCosts.stage3],
  ['Stage 4   per-slot label read     ', stageCosts.stage4],
];
let totalIn = 0, totalOut = 0, totalUsd = 0, totalSeqMs = 0;
for (const [name, row] of stageRows) {
  if (!row) continue;
  console.log(
    `  ${name}  in=${String(row.tokensIn).padStart(6)}  out=${String(row.tokensOut).padStart(5)}  ` +
      `$${row.usd.toFixed(4)}  (${(row.ms / 1000).toFixed(1)}s)`
  );
  totalIn += row.tokensIn;
  totalOut += row.tokensOut;
  totalUsd += row.usd;
  totalSeqMs += row.ms;
}
console.log('  ' + '-'.repeat(90));
console.log(
  `  TOTAL (per-slot pipeline)           in=${String(totalIn).padStart(6)}  out=${String(totalOut).padStart(5)}  $${totalUsd.toFixed(4)}`
);
console.log(`  wall clock (Stage 3 || Stage 4):    ${(stageCosts.parallelWallMs / 1000).toFixed(1)}s`);
console.log('');
console.log('  NOTE: production also runs a whole-board single-shot VLM pass');
console.log('        (~5k-6k tokens in, ~2k-3k out, ~$0.05-0.06) in parallel for');
console.log('        board-level metadata fallback. Not exercised by this harness.');
console.log(`        So production cost per extraction ≈ $${(totalUsd + 0.055).toFixed(4)}.`);
const margin = 3.0; // £3/cert typical
const usdGbp = 0.79;
const prodUsdTotal = totalUsd + 0.055;
const prodGbp = prodUsdTotal * usdGbp;
console.log(`        At £${margin}/cert (typical), that is ${((prodGbp / margin) * 100).toFixed(1)}% of margin (~£${prodGbp.toFixed(3)}).`);
console.log('\n[harness] done.');
