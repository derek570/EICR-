/**
 * Local CCU pipeline harness — runs the production per-slot pipeline end-to-end
 * against a photo on disk, using the same modules the route handler uses.
 * No HTTP, no S3, no DB — just the extraction stages.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/ccu-local-run.mjs <path-to-jpg>
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/ccu-local-run.mjs <path-to-jpg> --roi=0.1,0.4,0.8,0.2
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/ccu-local-run.mjs <path-to-jpg> --dump-crops=/tmp/crops
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/ccu-local-run.mjs <path-to-jpg> --dump-overlay=/tmp/overlay.jpg
 *
 * Mirrors `POST /api/analyze-ccu` (src/routes/extraction.js) including:
 *   - resize-to-fit if raw bytes > 3.7 MB
 *   - Stage 1b classifier (board_technology, manufacturer, main switch, SPD)
 *   - Branch on boardTechnology → modern OR rewireable/cartridge/mixed prepare path
 *   - Stage 3 (per-slot classify) || Stage 4 (per-slot label-read) in parallel
 *   - Coordinate-space conversion for label crops (modern: 0-1000 norm → px,
 *     rewireable: pixels pass-through)
 *   - mainSwitchSide priority: Stage 3 main_switch slot → mainSwitchOffset →
 *     classifier hint → 'none'
 *   - Post-merge enrichers (applyBsEnFallback, normaliseCircuitLabels)
 *
 * Single-shot was retired 2026-04-29; per-slot is the only path. Cost ~$0.04.
 *
 * NOT mirrored (deliberately, to keep the harness offline):
 *   - lookupMissingRcdTypes (gpt-5-search-api web call)
 *   - Training-sample S3 upload + geometric sidecar
 *   - Idempotency middleware
 */
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import {
  prepareModernGeometry,
  classifyModernSlots,
} from '../src/extraction/ccu-geometric.js';
import {
  prepareRewireableGeometry,
  classifyRewireableSlots,
} from '../src/extraction/ccu-geometric-rewireable.js';
import { extractSlotLabels, cropSlotLabelZone } from '../src/extraction/ccu-label-pass.js';
import {
  slotsToCircuits,
  classifyBoardTechnology,
  applyBsEnFallback,
  normaliseCircuitLabels,
} from '../src/routes/extraction.js';
import Anthropic from '@anthropic-ai/sdk';

const photoPath = process.argv[2];
if (!photoPath) {
  console.error('usage: node scripts/ccu-local-run.mjs <path-to-jpg> [--roi=x,y,w,h]');
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY env var required');
  process.exit(1);
}

const raw = fs.readFileSync(path.resolve(photoPath));
console.log(`[harness] input: ${photoPath} (${(raw.length / 1024).toFixed(0)} KB)`);

// Replicate the route-handler resize (≤ 3.7 MB raw → 2048x2048 fit=inside, q80).
const MAX_RAW = Math.floor(5 * 1024 * 1024 * 0.74);
const imageBuffer = raw.length > MAX_RAW
  ? await sharp(raw).resize(2048, 2048, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer()
  : raw;
const meta = await sharp(imageBuffer).metadata();
console.log(`[harness] resized: ${meta.width}x${meta.height} (${(imageBuffer.length / 1024).toFixed(0)} KB)`);

// Sonnet 4.6 pricing (per Anthropic published rates, override via env if changed).
const IN_PER_MTOK = Number(process.env.SONNET_IN_PER_MTOK || 3.0);
const OUT_PER_MTOK = Number(process.env.SONNET_OUT_PER_MTOK || 15.0);
function costUsd(usage) {
  const inT = usage?.inputTokens ?? 0;
  const outT = usage?.outputTokens ?? 0;
  return (inT * IN_PER_MTOK + outT * OUT_PER_MTOK) / 1_000_000;
}
const stageCosts = {};
const MODEL = (process.env.CCU_MODEL || 'claude-sonnet-4-6').trim();

// --- Stage 1b — board-technology classifier (production runs this FIRST) ---
console.log('\n[harness] Stage 1b — classifyBoardTechnology…');
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
console.log(`  boardTechnology=${boardClass.boardTechnology}  manufacturer=${boardClass.boardManufacturer}  model=${boardClass.boardModel ?? '-'}`);
console.log(`  mainSwitchPosition=${boardClass.mainSwitchPosition}  mainSwitchRating=${boardClass.mainSwitchRating}  spdPresent=${boardClass.spdPresent}`);
console.log(`  confidence=${boardClass.confidence}  (${(t1bMs/1000).toFixed(1)}s)`);

// --- Branch on board_technology (mirrors extraction.js:1416-1419) -------
const chooseRewireable =
  boardClass.boardTechnology === 'rewireable_fuse' ||
  boardClass.boardTechnology === 'cartridge_fuse' ||
  boardClass.boardTechnology === 'mixed';
const pipelinePath = chooseRewireable ? 'rewireable' : 'modern';
console.log(`\n[harness] pipeline path: ${pipelinePath}`);

// --- Stage 1 + Stage 2 (geometric prepare) ------------------------------
// Optional: pass `--roi=x,y,w,h` to simulate the iOS framing-box hint
// (modern path only — rewireable does not currently accept a hint).
let railRoiHint = null;
const roiFlag = process.argv.find((a) => a.startsWith('--roi='));
if (roiFlag) {
  const [x, y, w, h] = roiFlag.slice('--roi='.length).split(',').map(Number);
  railRoiHint = { x, y, w, h };
  if (chooseRewireable) {
    console.log(`[harness] WARN --roi ignored on rewireable path (production also ignores it)`);
    railRoiHint = null;
  } else {
    console.log(`[harness] using ROI hint: ${JSON.stringify(railRoiHint)}`);
  }
}

console.log(`\n[harness] Stage 1 + Stage 2 — prepare${chooseRewireable ? 'Rewireable' : 'Modern'}Geometry…`);
const t0 = Date.now();
const prepared = chooseRewireable
  ? await prepareRewireableGeometry(imageBuffer)
  : await prepareModernGeometry(imageBuffer, { railRoiHint });
const prepMs = Date.now() - t0;
stageCosts.stage1_2 = {
  tokensIn: prepared.usage.inputTokens,
  tokensOut: prepared.usage.outputTokens,
  usd: costUsd(prepared.usage),
  ms: prepMs,
};
console.log(`[harness] Stage 1+2 done in ${(prepMs / 1000).toFixed(1)}s`);
if (!chooseRewireable) {
  // Modern-only diagnostics (cv pitch + chunking diag) — exactly the
  // fields the route handler logs as "CCU geometric extraction attached".
  console.log(`  medianRails:               ${JSON.stringify(prepared.medianRails)}`);
  console.log(`  moduleCount (post-clamp):  ${prepared.moduleCount}`);
  console.log(`  vlmCount (direct):         ${prepared.vlmCount}`);
  console.log(`  disagreement:              ${prepared.disagreement}`);
  console.log(`  truncatedFromDisagreement: ${prepared.truncatedFromDisagreement}`);
  console.log(`  moduleWidth (norm):        ${prepared.moduleWidth}`);
  console.log(`  pitchSource:               ${prepared.pitchSource ?? '-'}`);
  if (prepared.cvPitchDiag) {
    const d = prepared.cvPitchDiag;
    console.log(`  cvPitchDiag:               pitchPx=${d.pitchPx} normCorr=${(d.normCorr ?? 0).toFixed(3)} reason=${d.reason ?? '-'}`);
  }
  if (prepared.pitchCrossCheck) {
    console.log(`  pitchCrossCheck:           ${JSON.stringify(prepared.pitchCrossCheck)}`);
  }
  if (prepared.chunkingDiag) {
    console.log(`  chunkingDiag:              ${JSON.stringify(prepared.chunkingDiag)}`);
  }
  if (prepared.railBbox) {
    console.log(`  railBbox (px):             ${JSON.stringify(prepared.railBbox)}`);
  }
  console.log(`  slotCentersX (norm):       [${prepared.slotCentersX.map((x) => Math.round(x)).join(', ')}]`);
} else {
  // Rewireable diagnostics
  console.log(`  panelBounds:               ${JSON.stringify(prepared.panelBounds)}`);
  console.log(`  carrierCount:              ${prepared.carrierCount}`);
  console.log(`  carrierPitchPx:            ${prepared.carrierPitchPx}`);
  console.log(`  mainSwitchOffset:          ${prepared.mainSwitchOffset ?? '-'}`);
  console.log(`  mainSwitchSlotIndex:       ${prepared.mainSwitchSlotIndex ?? '-'}`);
  console.log(`  slotCentersX (px):         [${(prepared.slotCentersX || []).map((x) => Math.round(x)).join(', ')}]`);
}
console.log(`  mainSwitchSide (Stage 1):  ${prepared.mainSwitchSide ?? '-'}`);
console.log(`  lowConfidence:             ${prepared.lowConfidence}`);

// --- Stage 3 || Stage 4 in parallel (mirrors extraction.js:1478-1497) ----
// Coordinate space differs between paths: modern emits 0-1000 normalised,
// rewireable emits pixels. extractSlotLabels needs pixels.
const isRewireablePipeline = typeof prepared.carrierPitchPx === 'number';
const imageWidthForConvert = prepared.imageWidth || 0;
const convertNormToPx = (v) =>
  typeof v === 'number' && imageWidthForConvert > 0
    ? Math.round((v / 1000) * imageWidthForConvert)
    : null;

const panelTopNorm = prepared.panelBounds?.top ?? prepared.medianRails?.rail_top ?? null;
const panelBottomNorm = prepared.panelBounds?.bottom ?? prepared.medianRails?.rail_bottom ?? null;

const labelGeom = {
  slotCentersX: isRewireablePipeline
    ? prepared.slotCentersX
    : (prepared.slotCentersX || []).map((v) => convertNormToPx(v)),
  slotPitchPx: isRewireablePipeline
    ? prepared.carrierPitchPx
    : convertNormToPx(prepared.moduleWidth),
  panelTopNorm,
  panelBottomNorm,
  imageWidth: prepared.imageWidth,
  imageHeight: prepared.imageHeight,
  slotsForSkipHint: null,
};

const labelGeomValid =
  Number.isFinite(labelGeom.slotPitchPx) &&
  Number.isFinite(labelGeom.panelTopNorm) &&
  Number.isFinite(labelGeom.panelBottomNorm);
if (!labelGeomValid) {
  console.log(`[harness] WARN labelGeom invalid (slotPitchPx=${labelGeom.slotPitchPx}, panelTopNorm=${panelTopNorm}, panelBottomNorm=${panelBottomNorm}) — Stage 4 skipped`);
}

const classifyFn = isRewireablePipeline ? classifyRewireableSlots : classifyModernSlots;
console.log(`\n[harness] Stage 3 (${classifyFn.name}) || Stage 4 (extractSlotLabels)…`);
const parT0 = Date.now();
const [classified, labelPass] = await Promise.all([
  classifyFn(imageBuffer, prepared).catch((err) => {
    console.log(`[harness] Stage 3 failed: ${err.message}`);
    return null;
  }),
  labelGeomValid
    ? extractSlotLabels(imageBuffer, labelGeom).catch((err) => {
        console.log(`[harness] Stage 4 failed: ${err.message}`);
        return { __error: err.message, labels: [], usage: { inputTokens: 0, outputTokens: 0 } };
      })
    : Promise.resolve({ labels: [], usage: { inputTokens: 0, outputTokens: 0 } }),
]);
const parMs = Date.now() - parT0;
stageCosts.stage3 = {
  tokensIn: classified?.usage?.inputTokens ?? 0,
  tokensOut: classified?.usage?.outputTokens ?? 0,
  usd: costUsd(classified?.usage),
  ms: classified?.timings?.stage3Ms ?? 0,
};
stageCosts.stage4 = {
  tokensIn: labelPass.usage?.inputTokens ?? 0,
  tokensOut: labelPass.usage?.outputTokens ?? 0,
  usd: costUsd(labelPass.usage),
  ms: labelPass.timings?.vlmMs ?? 0,
};
stageCosts.parallelWallMs = parMs;

const slotCount = classified?.slots?.length ?? 0;
const labelsRead = labelPass.labels.filter((l) => l.label != null).length;
const totalLabels = labelPass.labels.length;
console.log(`[harness] Stage 3: error=${classified?.stage3Error ?? 'null'}; slots=${slotCount}`);
console.log(`[harness] Stage 4: ${labelsRead}/${totalLabels} labels read; vlmMs=${labelPass.timings?.vlmMs ?? '-'}`);

// --- Optional: render slot bboxes as overlay on original photo ----------
// Single-image diagnostic: shows where each slot boundary lands relative
// to the actual breakers in the photo. Useful when you suspect slot
// centres have drifted off the rail (over-count, undersized rail bbox,
// VLM-detection coord drift). Replaces the need to ls a dump dir of
// individual crops to spot mis-alignments.
const overlayFlag = process.argv.find((a) => a.startsWith('--dump-overlay='));
if (overlayFlag) {
  const overlayPath = path.resolve(overlayFlag.slice('--dump-overlay='.length));
  const W = prepared.imageWidth;
  const H = prepared.imageHeight;
  const labelByIdx = new Map(labelPass.labels.map((l) => [l.slotIndex, l]));
  const classByIdx = new Map((classified?.slots ?? []).map((s) => [s.slotIndex, s]));

  // Pixel coordinates for the rail panel. labelGeom.slotCentersX is already
  // in pixels (modern path was converted; rewireable was native pixels).
  const panelTopPx = (labelGeom.panelTopNorm / 1000) * H;
  const panelBottomPx = (labelGeom.panelBottomNorm / 1000) * H;
  const panelHeightPx = panelBottomPx - panelTopPx;
  const halfPitchPx = (labelGeom.slotPitchPx || 0) / 2;

  // Status colour per slot — drives both the box stroke and the text colour.
  // Green=labelled MCB/RCBO, blue=structural (no label expected), orange=blank,
  // red=MCB with null label (real miss), grey=stage 3 didn't classify it.
  const colourForSlot = (cls, label) => {
    if (!cls) return '#888';
    const c = cls.toLowerCase();
    if (c === 'main_switch' || c === 'spd' || c === 'rcd') return '#2980b9'; // structural
    if (c === 'blank' || c === 'empty') return '#e67e22'; // expected spare
    if (c === 'unknown') return '#888';
    if (c === 'mcb' || c === 'rcbo' || c === 'rewireable' || c === 'cartridge') {
      return label ? '#27ae60' : '#c0392b'; // green if labelled, red if null
    }
    return '#888';
  };

  const escXml = (s) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  // Build SVG. We draw three things per slot:
  //   1. A box from (cx - pitch/2, panelTop) to (cx + pitch/2, panelBottom).
  //      This is the slot DIVIDER — the line readers care about.
  //   2. The slot index above the panel.
  //   3. cls + ratingAmps + label below the panel.
  // Plus one outer rail bbox in dashed yellow so you can see how tight the
  // rail localisation is overall.
  const fontSize = Math.max(11, Math.round(panelHeightPx * 0.18));
  const labelOffset = Math.round(panelHeightPx * 0.4);
  const slotShapes = [];
  for (let i = 0; i < labelGeom.slotCentersX.length; i++) {
    const cx = labelGeom.slotCentersX[i];
    const left = cx - halfPitchPx;
    const right = cx + halfPitchPx;
    const cls = classByIdx.get(i)?.classification ?? null;
    const lbl = labelByIdx.get(i);
    const colour = colourForSlot(cls, lbl?.label);
    const ratingAmps = classByIdx.get(i)?.ratingAmps;
    const labelText = lbl?.label ?? (lbl?.rawLabel ? `(${lbl.rawLabel})` : '—');
    const labelConf = lbl?.confidence ?? 0;

    slotShapes.push(`
      <rect x="${left}" y="${panelTopPx}" width="${right - left}" height="${panelHeightPx}"
            fill="none" stroke="${colour}" stroke-width="3" />
      <text x="${cx}" y="${panelTopPx - 8}" font-family="sans-serif" font-size="${fontSize}"
            fill="${colour}" font-weight="bold" text-anchor="middle">${i}</text>
      <text x="${cx}" y="${panelBottomPx + labelOffset}" font-family="sans-serif" font-size="${fontSize}"
            fill="${colour}" text-anchor="middle">${escXml(cls ?? '?')}${ratingAmps ? ' ' + ratingAmps + 'A' : ''}</text>
      <text x="${cx}" y="${panelBottomPx + labelOffset + fontSize + 4}" font-family="sans-serif"
            font-size="${Math.round(fontSize * 0.85)}" fill="${colour}" text-anchor="middle">${escXml(labelText.slice(0, 18))}</text>
      <text x="${cx}" y="${panelBottomPx + labelOffset + fontSize * 2 + 8}" font-family="sans-serif"
            font-size="${Math.round(fontSize * 0.7)}" fill="${colour}" text-anchor="middle" font-style="italic">conf=${labelConf.toFixed(2)}</text>
    `);
  }

  // Outer rail bbox (dashed yellow) — Stage 1 / ROI hint output.
  const railLeftPx = Math.min(...labelGeom.slotCentersX) - halfPitchPx;
  const railRightPx = Math.max(...labelGeom.slotCentersX) + halfPitchPx;
  const railOutline = `
    <rect x="${railLeftPx}" y="${panelTopPx}"
          width="${railRightPx - railLeftPx}" height="${panelHeightPx}"
          fill="none" stroke="#f1c40f" stroke-width="2" stroke-dasharray="8,4" />
  `;

  // Header strip: filename + module count + pitch + path
  const header = `
    <rect x="0" y="0" width="${W}" height="${Math.round(fontSize * 1.6)}" fill="rgba(0,0,0,0.65)" />
    <text x="8" y="${Math.round(fontSize * 1.15)}" font-family="sans-serif" font-size="${fontSize}" fill="#fff">
      ${escXml(path.basename(photoPath))} · ${prepared.moduleCount ?? '?'} modules · pitch ${(labelGeom.slotPitchPx || 0).toFixed(0)}px · pitchSource=${escXml(prepared.pitchSource ?? '-')} · path=${pipelinePath}${railRoiHint ? ' · ROI-hint' : ' · VLM-detected'}
    </text>
  `;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
${header}
${railOutline}
${slotShapes.join('\n')}
</svg>`;

  // Composite the SVG over the resized image (which is what the pipeline
  // actually saw — sub-2048 if the original was bigger). For the rendered
  // overlay to align, we composite onto imageBuffer (post-resize), since
  // labelGeom coords are in that buffer's pixel space.
  fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
  await sharp(imageBuffer)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 90 })
    .toFile(overlayPath);
  console.log(`\n[harness] --dump-overlay=${overlayPath} — wrote annotated photo (${labelGeom.slotCentersX.length} slot boxes)`);
}

// --- Optional: dump every Stage 4 label crop to disk --------------------
// Re-runs `cropSlotLabelZone` (the exact function Stage 4 used internally)
// on the prepared geometry. Output is byte-identical to what was sent to
// Claude. Filename encodes class + confidence + label so `ls` answers
// "what did Claude see for the slot that came back null?" at a glance.
const dumpFlag = process.argv.find((a) => a.startsWith('--dump-crops='));
if (dumpFlag && labelGeomValid) {
  const dumpDir = path.resolve(dumpFlag.slice('--dump-crops='.length));
  fs.mkdirSync(dumpDir, { recursive: true });
  const labelByIdx = new Map(labelPass.labels.map((l) => [l.slotIndex, l]));
  const classByIdx = new Map((classified?.slots ?? []).map((s) => [s.slotIndex, s]));
  const sanitise = (s) =>
    String(s ?? 'NULL')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 28) || 'empty';
  const summary = [];
  console.log(`\n[harness] --dump-crops=${dumpDir} — writing label crops + summary…`);
  for (let i = 0; i < labelGeom.slotCentersX.length; i++) {
    const lbl = labelByIdx.get(i);
    const cls = classByIdx.get(i);
    let crop;
    try {
      crop = await cropSlotLabelZone(imageBuffer, i, labelGeom);
    } catch (err) {
      console.log(`  slot ${i}: crop failed — ${err.message}`);
      continue;
    }
    const conf = lbl?.confidence ?? 0;
    const confStr = String(Math.round(conf * 100)).padStart(3, '0');
    const labelStr = sanitise(lbl?.rawLabel ?? lbl?.label ?? 'null');
    const clsStr = sanitise(cls?.classification ?? 'unknown');
    const fname = `slot-${String(i).padStart(2, '0')}_cls-${clsStr}_conf-${confStr}_lbl-${labelStr}.jpg`;
    fs.writeFileSync(path.join(dumpDir, fname), crop.buffer);
    summary.push({
      slotIndex: i,
      filename: fname,
      bbox: crop.bbox,
      classification: cls?.classification ?? null,
      classConfidence: cls?.confidence ?? null,
      ratingAmps: cls?.ratingAmps ?? null,
      tripCurve: cls?.tripCurve ?? null,
      label: lbl?.label ?? null,
      rawLabel: lbl?.rawLabel ?? null,
      labelConfidence: conf,
      // null label + rawLabel != null = confidence-gated null (raw text below
      // 0.5 threshold). null label + rawLabel == null = VLM emitted null
      // directly (couldn't read anything).
      gatedByConfidence: lbl?.label == null && lbl?.rawLabel != null,
    });
  }
  fs.writeFileSync(
    path.join(dumpDir, 'summary.json'),
    JSON.stringify(
      {
        photoPath: path.resolve(photoPath),
        photoBytes: raw.length,
        resizedDims: { width: meta.width, height: meta.height },
        boardClassification: {
          boardTechnology: boardClass.boardTechnology,
          mainSwitchPosition: boardClass.mainSwitchPosition,
          boardManufacturer: boardClass.boardManufacturer,
          boardModel: boardClass.boardModel,
          mainSwitchRating: boardClass.mainSwitchRating,
          spdPresent: boardClass.spdPresent,
          confidence: boardClass.confidence,
        },
        labelGeom,
        slots: summary,
      },
      null,
      2
    )
  );
  const gated = summary.filter((s) => s.gatedByConfidence).length;
  const vlmNull = summary.filter((s) => s.label == null && s.rawLabel == null).length;
  console.log(`  wrote ${summary.length} crops + summary.json`);
  console.log(`  null labels: ${vlmNull} VLM-emitted-null, ${gated} confidence-gated (rawLabel present but conf < 0.5)`);
} else if (dumpFlag && !labelGeomValid) {
  console.log(`[harness] --dump-crops set but labelGeom invalid — nothing to dump`);
}

// --- Attach labels onto slots (mirrors extraction.js merger input) ------
const labelBySlotIndex = new Map(labelPass.labels.map((l) => [l.slotIndex, l]));
const slotsWithLabels = (classified?.slots ?? []).map((s) => {
  const l = labelBySlotIndex.get(s.slotIndex);
  return l
    ? { ...s, label: l.label ?? null, labelRaw: l.rawLabel ?? null, labelConfidence: l.confidence }
    : s;
});

console.log('\n[harness] Per-slot result:');
for (const s of slotsWithLabels) {
  const lbl = s.label ? `"${s.label}"` : '—';
  const raw = s.labelRaw && s.labelRaw !== s.label ? ` (raw="${s.labelRaw}")` : '';
  const lblConf = s.labelConfidence != null ? ` lblConf=${s.labelConfidence.toFixed(2)}` : '';
  console.log(
    `  #${String(s.slotIndex).padStart(2, ' ')}  ${(s.classification ?? '?').padEnd(12, ' ')}  ` +
      `${(s.manufacturer ?? '-').padEnd(10, ' ')}  ` +
      `${(s.ratingAmps != null ? String(s.ratingAmps) + 'A' : '-').padEnd(4, ' ')}  ` +
      `${(s.tripCurve ?? '-').padEnd(2, ' ')}  ` +
      `conf=${(s.confidence ?? 0).toFixed(2)}  ` +
      `label=${lbl}${raw}${lblConf}`
  );
}

// --- mainSwitchSide priority (mirrors extraction.js:1640-1656) ---------
let mainSwitchSide = 'none';
const stage3MainSwitchSlot = slotsWithLabels.find((s) => s?.classification === 'main_switch');
if (stage3MainSwitchSlot) {
  const halfwayIdx = (slotsWithLabels.length - 1) / 2;
  mainSwitchSide = stage3MainSwitchSlot.slotIndex >= halfwayIdx ? 'right' : 'left';
} else if (prepared.mainSwitchOffset === 'right-edge') {
  mainSwitchSide = 'right';
} else if (prepared.mainSwitchOffset === 'left-edge') {
  mainSwitchSide = 'left';
} else if (
  boardClass?.mainSwitchPosition === 'left' ||
  boardClass?.mainSwitchPosition === 'right'
) {
  mainSwitchSide = boardClass.mainSwitchPosition;
}

// --- Merger → circuits[] -----------------------------------------------
let circuits = slotsToCircuits({ slots: slotsWithLabels, mainSwitchSide });

// --- Post-merge enrichers (mirrors extraction.js:1671-1672) ------------
let analysis = {
  board_manufacturer: boardClass.boardManufacturer,
  board_model: boardClass.boardModel,
  board_technology: boardClass.boardTechnology,
  main_switch_position: boardClass.mainSwitchPosition,
  main_switch_rating: boardClass.mainSwitchRating,
  main_switch_current: boardClass.mainSwitchRating,
  spd_present: boardClass.spdPresent,
  circuits: circuits ?? [],
};
if (circuits && circuits.length > 0) {
  analysis = applyBsEnFallback(analysis);
  analysis = normaliseCircuitLabels(analysis);
  circuits = analysis.circuits;
}

console.log(`\n[harness] Merger → circuits[] (mainSwitchSide=${mainSwitchSide}):`);
if (!circuits || circuits.length === 0) {
  console.log('  (no circuits produced)');
} else {
  for (const c of circuits) {
    const num = c.circuit_number != null ? String(c.circuit_number).padStart(2, ' ') : ' —';
    const rcd = c.rcd_protected ? `${c.rcd_type ?? '?'}/${c.rcd_rating_ma ?? '?'}mA` : 'no';
    console.log(
      `  ${num}  label="${c.label ?? ''}"  ` +
        `${c.ocpd_type ?? '-'}${c.ocpd_rating_a ?? '-'}A  ` +
        `${c.ocpd_bs_en ?? '-'}  ` +
        `RCD: ${rcd}` +
        (c.is_rcd_device ? '  [RCD-DEVICE-ROW]' : '') +
        (c.low_confidence ? '  [LOW-CONF]' : '')
    );
  }
  console.log(`  total circuits: ${circuits.length}`);
}

// --- Cost + timing summary ---------------------------------------------
console.log('\n[harness] COST / TOKEN SUMMARY  (model: ' + MODEL + ')');
console.log(`  pricing assumed: $${IN_PER_MTOK.toFixed(2)}/Mtok in · $${OUT_PER_MTOK.toFixed(2)}/Mtok out`);
console.log('');
const stageRows = [
  ['Stage 1b  board-tech classifier   ', stageCosts.stage1b],
  ['Stage 1+2 rail/panel + slot count ', stageCosts.stage1_2],
  ['Stage 3   per-slot classify       ', stageCosts.stage3],
  ['Stage 4   per-slot label read     ', stageCosts.stage4],
];
let totalIn = 0, totalOut = 0, totalUsd = 0;
for (const [name, row] of stageRows) {
  if (!row) continue;
  console.log(
    `  ${name}  in=${String(row.tokensIn).padStart(6)}  out=${String(row.tokensOut).padStart(5)}  ` +
      `$${row.usd.toFixed(4)}  (${(row.ms / 1000).toFixed(1)}s)`
  );
  totalIn += row.tokensIn;
  totalOut += row.tokensOut;
  totalUsd += row.usd;
}
console.log('  ' + '-'.repeat(90));
console.log(
  `  TOTAL                                in=${String(totalIn).padStart(6)}  out=${String(totalOut).padStart(5)}  $${totalUsd.toFixed(4)}`
);
console.log(`  wall clock (Stage 3 || Stage 4):    ${(stageCosts.parallelWallMs / 1000).toFixed(1)}s`);

// At £3/cert margin, USD/GBP ≈ 0.79.
const usdGbp = 0.79;
const gbp = totalUsd * usdGbp;
const margin = 3.0;
console.log('');
console.log(`  Per-extraction cost: ~$${totalUsd.toFixed(4)} (~£${gbp.toFixed(3)}) = ${((gbp / margin) * 100).toFixed(1)}% of £${margin}/cert margin`);
console.log(`  (single-shot retired 2026-04-29; per-slot is the only path now)`);
console.log('\n[harness] done.');
