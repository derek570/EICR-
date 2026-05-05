/**
 * Sliding-window CCU extraction harness — exploratory mock.
 *
 * Alternative paradigm to the per-slot pipeline: instead of cropping each
 * module individually, take the user-framed rail ROI (with a bit of vertical
 * padding to capture the label strips), slide a 5-circuit-wide window across
 * it with a 2-stride (so windows overlap by 3 circuits), and ask the VLM
 * to extract whatever circuits it sees in each window. The merger then
 * reconciles overlap regions — if the VLM is off by ±1 device in any window,
 * the next window's overlap absorbs the error.
 *
 * Goal: see whether the VLM extracts circuits consistently inside a
 * multi-device crop. If yes, this could replace the geometric pipeline
 * with something far simpler (no pitch detection, no phase-lock, no
 * partial-crop bleed). If no, we know what reconciliation logic the
 * merger needs to handle.
 *
 * THIS IS A MOCK — does not write to any production code path. Pure
 * exploratory tool.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/ccu-sliding-window.mjs <photo> \
 *     --roi=x,y,w,h --ways=N [--window=5] [--stride=2] [--label-pad=1.0] \
 *     [--out=/tmp/sliding-window]
 *
 *   --roi=x,y,w,h    Normalised iOS rail-roi hint (0..1). Same shape as
 *                    /api/analyze-ccu accepts.
 *   --ways=N         Total module count on the rail. Drives window pitch.
 *   --window=5       Circuits per window (default 5).
 *   --stride=2       How many circuits to advance between windows (default 2,
 *                    so overlap = window - stride = 3).
 *   --label-pad=1.0  Vertical padding above/below rail as a multiple of rail
 *                    height. 1.0 = doubles rail height to capture labels.
 *   --out=DIR        Optional output directory: writes window crops + a
 *                    summary JSON for visual inspection.
 */
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';

const photoPath = process.argv[2];
if (!photoPath) {
  console.error(
    'usage: node scripts/ccu-sliding-window.mjs <photo> --roi=x,y,w,h --ways=N [--window=5] [--stride=2]'
  );
  process.exit(1);
}
const dryRun = process.argv.includes('--dry-run');
if (!dryRun && !process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY env var required (or use --dry-run to skip VLM calls)');
  process.exit(1);
}

const argFloat = (name, fallback) => {
  const flag = process.argv.find((a) => a.startsWith(`--${name}=`));
  return flag ? Number(flag.slice(name.length + 3)) : fallback;
};
const argInt = (name, fallback) => {
  const v = argFloat(name, fallback);
  return Number.isFinite(v) ? Math.round(v) : fallback;
};
const argStr = (name, fallback) => {
  const flag = process.argv.find((a) => a.startsWith(`--${name}=`));
  return flag ? flag.slice(name.length + 3) : fallback;
};

const roiFlag = argStr('roi', null);
if (!roiFlag) {
  console.error('--roi=x,y,w,h required (normalised 0..1)');
  process.exit(1);
}
const [roiX, roiY, roiW, roiH] = roiFlag.split(',').map(Number);
const ways = argInt('ways', null);
if (!Number.isFinite(ways) || ways < 1) {
  console.error('--ways=N required (total module count)');
  process.exit(1);
}
const windowSize = argInt('window', 5);
const stride = argInt('stride', 2);
const labelPad = argFloat('label-pad', 1.0);
const outDir = argStr('out', null);

if (outDir) fs.mkdirSync(outDir, { recursive: true });

console.log(
  `[harness] photo=${photoPath} ways=${ways} window=${windowSize} stride=${stride} labelPad=${labelPad}`
);

// --- 1. Load image, derive rail rect in pixel space --------------------
const raw = fs.readFileSync(path.resolve(photoPath));
const meta = await sharp(raw).metadata();
const imgW = meta.width;
const imgH = meta.height;
console.log(`[harness] image ${imgW}x${imgH}`);

const railLeftPx = Math.round(roiX * imgW);
const railTopPx = Math.round(roiY * imgH);
const railWPx = Math.round(roiW * imgW);
const railHPx = Math.round(roiH * imgH);
const railRightPx = railLeftPx + railWPx;
const railBottomPx = railTopPx + railHPx;
const pitchPx = railWPx / ways;
console.log(
  `[harness] rail rect: x=${railLeftPx} y=${railTopPx} w=${railWPx} h=${railHPx} pitch=${pitchPx.toFixed(1)}px`
);

// --- 2. Compute label-padded crop band ---------------------------------
// Vertical extent: rail + labelPad×railH above + below, clamped to image.
const padPx = Math.round(railHPx * labelPad);
const cropTop = Math.max(0, railTopPx - padPx);
const cropBottom = Math.min(imgH, railBottomPx + padPx);
const cropH = cropBottom - cropTop;
console.log(`[harness] label-padded band: y=${cropTop}..${cropBottom} h=${cropH}`);

// --- 3. Plan windows ---------------------------------------------------
// Each window covers `windowSize` circuits in module space, advancing by
// `stride` circuits per step. The last window is anchored on the right
// edge so we never under-cover the rightmost circuits.
const windows = [];
let firstCircuit = 1;
while (firstCircuit + windowSize - 1 <= ways) {
  windows.push({
    firstCircuit,
    lastCircuit: firstCircuit + windowSize - 1,
  });
  firstCircuit += stride;
}
// Anchor the final window on the right so we cover the rightmost circuits
// even when (ways - 1) % stride !== 0.
if (windows.length === 0 || windows[windows.length - 1].lastCircuit < ways) {
  windows.push({
    firstCircuit: Math.max(1, ways - windowSize + 1),
    lastCircuit: ways,
  });
}
console.log(
  `[harness] planned ${windows.length} windows: ${windows
    .map((w) => `[${w.firstCircuit}..${w.lastCircuit}]`)
    .join(' ')}`
);

// --- 4. VLM prompt -----------------------------------------------------
// Asks for whatever circuits the model SEES in this window — does not
// pin to exactly N. The merger will reconcile counts via overlap regions.
// Prompt deliberately tells the VLM to ignore partial devices at the
// crop edges (a circuit only appears once, in its own home window).
const PROMPT = `You are inspecting a section of a UK consumer unit's main DIN rail.

The image shows a horizontal rail with circuit-protective devices (MCBs, RCBOs, RCDs, blanking plates, possibly a main switch or SPD) plus a label strip above and/or below the rail with handwritten or printed circuit names.

Your job: identify EVERY device whose body is FULLY VISIBLE in this image (centred or near-centred), in left-to-right order. For each one, return:

- position_index: 1-based, left to right, in this image
- label: the circuit name read from the strip above/below the device (null if blank/unreadable)
- device_kind: one of "mcb", "rcbo", "rcd", "main_switch", "spd", "blank"
- ocpd_rating_a: integer amperage if visible (e.g. 32), null otherwise
- ocpd_curve: "B", "C", "D" if visible (MCBs/RCBOs only), null otherwise
- ocpd_bs_en: BS EN standard if visible (e.g. "BS EN 61009-1"), null otherwise
- rcd_type: "AC", "A", "F", "B" for RCDs/RCBOs, null otherwise
- rcd_rating_ma: 30, 100, 300, 500 (mA) for RCDs/RCBOs, null otherwise
- partial: true if the device's body is clipped at the LEFT or RIGHT edge of the image (do NOT include partial devices in your output unless you are confident about its identity)

CRUCIAL: a clipped/half-visible device at the leftmost or rightmost edge of the image should be EXCLUDED unless you can identify it confidently. The next window will capture it. Better to skip than to guess.

Return JSON only, no commentary, no markdown fence:
{"circuits": [{"position_index": 1, ...}, ...]}`;

// --- 5. Run windows ----------------------------------------------------
const anthropic = dryRun ? null : new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = (process.env.CCU_MODEL || 'claude-sonnet-4-6').trim();
const IN_PER_MTOK = Number(process.env.SONNET_IN_PER_MTOK || 3.0);
const OUT_PER_MTOK = Number(process.env.SONNET_OUT_PER_MTOK || 15.0);

const results = [];
let totalCostUsd = 0;
let totalMs = 0;

for (let i = 0; i < windows.length; i++) {
  const w = windows[i];
  // Translate circuit-range to pixel-range. Module index 0 = leftmost.
  const moduleStartIdx = w.firstCircuit - 1;
  const moduleEndIdx = w.lastCircuit; // exclusive
  const cropX0 = railLeftPx + Math.round(moduleStartIdx * pitchPx);
  const cropX1 = railLeftPx + Math.round(moduleEndIdx * pitchPx);
  const cropW = Math.min(imgW, cropX1) - Math.max(0, cropX0);
  const cropX = Math.max(0, cropX0);

  const cropBuf = await sharp(raw)
    .extract({ left: cropX, top: cropTop, width: cropW, height: cropH })
    .resize({ width: 1536, withoutEnlargement: false })
    .jpeg({ quality: 90 })
    .toBuffer();

  if (outDir) {
    const fname = `window-${String(i + 1).padStart(2, '0')}-c${w.firstCircuit}-${w.lastCircuit}.jpg`;
    fs.writeFileSync(path.join(outDir, fname), cropBuf);
  }

  console.log(
    `\n[harness] window ${i + 1}/${windows.length} circuits ${w.firstCircuit}..${w.lastCircuit}  crop=${cropW}x${cropH}px  imagePx=${cropX}..${cropX + cropW}`
  );

  if (dryRun) {
    results.push({
      window: i + 1,
      expectedCircuits: { first: w.firstCircuit, last: w.lastCircuit },
      cropPx: { x: cropX, y: cropTop, w: cropW, h: cropH },
      vlm: null,
      parsed: null,
      parseErr: null,
      rawText: '(dry-run, no VLM call)',
    });
    continue;
  }

  const t0 = Date.now();
  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1500,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: cropBuf.toString('base64') },
          },
          { type: 'text', text: PROMPT },
        ],
      },
    ],
  });
  const ms = Date.now() - t0;
  totalMs += ms;
  const usage = resp.usage || {};
  const cost = ((usage.input_tokens ?? 0) * IN_PER_MTOK + (usage.output_tokens ?? 0) * OUT_PER_MTOK) / 1_000_000;
  totalCostUsd += cost;

  const textBlock = resp.content.find((b) => b.type === 'text');
  const rawText = textBlock?.text ?? '';
  let parsed = null;
  let parseErr = null;
  try {
    // Strip ``` fences if present (the prompt asks for none, but the model
    // sometimes adds them anyway).
    const fenced = rawText.match(/```(?:json)?\s*([\s\S]+?)```/);
    parsed = JSON.parse(fenced ? fenced[1] : rawText);
  } catch (err) {
    parseErr = err.message;
  }

  console.log(
    `  ${ms}ms  in=${usage.input_tokens ?? 0}  out=${usage.output_tokens ?? 0}  $${cost.toFixed(4)}`
  );
  if (parseErr) {
    console.log(`  [parse error] ${parseErr}`);
    console.log(`  raw: ${rawText.slice(0, 200)}…`);
  } else {
    const cs = parsed.circuits || [];
    console.log(`  VLM returned ${cs.length} circuits (expected window=${windowSize}):`);
    cs.forEach((c, idx) => {
      console.log(
        `    ${idx + 1}. ${c.device_kind || '?'}  ${c.ocpd_curve || ''}${c.ocpd_rating_a || '?'}A  label="${c.label || ''}"  ${c.rcd_type ? `Type ${c.rcd_type}/${c.rcd_rating_ma}mA` : ''}`
      );
    });
  }

  results.push({
    window: i + 1,
    expectedCircuits: { first: w.firstCircuit, last: w.lastCircuit },
    cropPx: { x: cropX, y: cropTop, w: cropW, h: cropH },
    vlm: { ms, usage, cost },
    parsed,
    parseErr,
    rawText,
  });
}

console.log(
  `\n[harness] total: ${windows.length} windows  ${(totalMs / 1000).toFixed(1)}s  $${totalCostUsd.toFixed(4)}`
);

if (dryRun) {
  console.log('\n[harness] dry-run complete — crops written, VLM skipped.');
  if (outDir) {
    fs.writeFileSync(
      path.join(outDir, 'summary.json'),
      JSON.stringify({ ways, windowSize, stride, labelPad, dryRun: true, results }, null, 2)
    );
    console.log(`[harness] wrote crops + summary.json to ${outDir}`);
  }
  process.exit(0);
}

// --- 6. Naive merger (label+rating overlap alignment) ------------------
// Walk windows left-to-right, building a single circuit array. For each
// new window, align its first 1-3 circuits against the previous window's
// last 1-3 circuits using (label, rating, device_kind) as the match key.
// Confirmed overlap = circuits seen in both windows; these are taken
// from the earlier window. New circuits = those past the overlap.
//
// This is intentionally minimal — the harness is here to LET YOU SEE
// what the merger has to deal with, not to be production-quality.
function alignKey(c) {
  if (!c) return '∅';
  const lab = (c.label || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return `${c.device_kind || '?'}/${c.ocpd_rating_a ?? '?'}/${lab.slice(0, 12)}`;
}

const merged = [];
for (let i = 0; i < results.length; i++) {
  const r = results[i];
  const cs = r.parsed?.circuits || [];
  if (i === 0) {
    merged.push(...cs);
    continue;
  }
  // Try to find the longest tail-of-merged that matches a head-of-cs.
  let bestOffset = -1;
  let bestMatch = 0;
  const maxOverlap = Math.min(merged.length, cs.length, windowSize);
  for (let off = 1; off <= maxOverlap; off++) {
    let match = 0;
    for (let k = 0; k < off; k++) {
      const left = merged[merged.length - off + k];
      const right = cs[k];
      if (alignKey(left) === alignKey(right)) match++;
    }
    if (match > bestMatch) {
      bestMatch = match;
      bestOffset = off;
    }
  }
  if (bestOffset > 0 && bestMatch >= Math.max(1, Math.floor(bestOffset / 2))) {
    // Trust the alignment; append everything past the overlap.
    merged.push(...cs.slice(bestOffset));
    console.log(
      `[merge] window ${i + 1}: aligned ${bestMatch}/${bestOffset} overlap → +${cs.length - bestOffset} new`
    );
  } else {
    // Couldn't find a confident overlap — append all and flag.
    merged.push(...cs);
    console.log(
      `[merge] window ${i + 1}: NO confident overlap (best=${bestMatch}/${bestOffset}) → appended all ${cs.length}`
    );
  }
}

console.log(`\n[harness] merged total: ${merged.length} circuits (vs ways=${ways})`);
merged.forEach((c, idx) => {
  console.log(
    `  ${idx + 1}. ${c.device_kind || '?'}  ${c.ocpd_curve || ''}${c.ocpd_rating_a || '?'}A  label="${c.label || ''}"  ${c.rcd_type ? `Type ${c.rcd_type}/${c.rcd_rating_ma}mA` : ''}`
  );
});

if (outDir) {
  fs.writeFileSync(
    path.join(outDir, 'summary.json'),
    JSON.stringify({ ways, windowSize, stride, labelPad, results, merged }, null, 2)
  );
  console.log(`\n[harness] wrote crops + summary.json to ${outDir}`);
}
