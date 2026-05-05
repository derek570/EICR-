/**
 * Sliding-window CCU extraction harness — v5 exploratory mock.
 *
 * Architecture:
 *   - CV is consulted ONLY for rail bbox + pitch — both come from line-
 *     fitting + autocorrelation, which are reliable. The CV's `moduleCount`
 *     is INTENTIONALLY IGNORED — its under-counting is exactly the bug
 *     this design is meant to dodge.
 *   - Windows are planned in PIXEL SPACE: each window is `windowMod`
 *     module-pitches wide, advancing by `strideMod` pitches per step.
 *   - The VLM is asked for a FLEXIBLE list of devices visible in each
 *     crop — could be 4, 5, 6, whatever it sees. No count constraint.
 *     For each device it returns a `position_pct` 0..1 — the fraction of
 *     the crop's width where the device's centre lies. The harness
 *     converts that to an image-space X coordinate.
 *   - Positional clustering: every cross-window read of the same physical
 *     device will land at approximately the same image X. Reads cluster
 *     when |Δx| < pitch/2 AND fingerprints (kind + rating + label tokens)
 *     are compatible. Each cluster = one physical device.
 *   - Per-cluster voting: most-common kind/rating/curve/bs_en/rcd_*;
 *     longest-common label.
 *
 * The total number of devices is whatever clustering produces — we are
 * NOT bound by the CV's possibly-wrong module count.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... node scripts/ccu-sliding-window.mjs <photo> \
 *     [--roi=x,y,w,h] [--window-mod=5] [--stride-mod=2] \
 *     [--label-pad=1.0] [--out=DIR] [--dry-run]
 *
 *   --window-mod=5  Window width in module-pitches (default 5).
 *   --stride-mod=2  Stride in module-pitches (default 2 → 3-pitch overlap).
 *                   Smaller stride = more redundancy, more cost.
 */
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { prepareModernGeometry } from '../src/extraction/ccu-geometric.js';

const photoPath = process.argv[2];
if (!photoPath) {
  console.error(
    'usage: node scripts/ccu-sliding-window.mjs <photo> [--roi=x,y,w,h] [--window-mod=5] [--stride-mod=2]'
  );
  process.exit(1);
}
const dryRun = process.argv.includes('--dry-run');
if (!dryRun && !process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY env var required (or use --dry-run)');
  process.exit(1);
}

const argFloat = (name, fallback) => {
  const flag = process.argv.find((a) => a.startsWith(`--${name}=`));
  return flag ? Number(flag.slice(name.length + 3)) : fallback;
};
const argStr = (name, fallback) => {
  const flag = process.argv.find((a) => a.startsWith(`--${name}=`));
  return flag ? flag.slice(name.length + 3) : fallback;
};

const roiFlag = argStr('roi', null);
let railRoiHint = null;
if (roiFlag) {
  const [x, y, w, h] = roiFlag.split(',').map(Number);
  railRoiHint = { x, y, w, h };
}
const windowMod = argFloat('window-mod', 5);
const strideMod = argFloat('stride-mod', 2);
const labelPad = argFloat('label-pad', 1.0);
const outDir = argStr('out', null);

if (outDir) fs.mkdirSync(outDir, { recursive: true });

console.log(`[harness] photo=${photoPath} window=${windowMod}× stride=${strideMod}× pitch`);

// --- 1. Load + replicate route-handler resize ---------------------------
const raw = fs.readFileSync(path.resolve(photoPath));
const MAX_RAW = Math.floor(5 * 1024 * 1024 * 0.74);
const imageBuffer =
  raw.length > MAX_RAW
    ? await sharp(raw)
        .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer()
    : raw;
const meta = await sharp(imageBuffer).metadata();
const imgW = meta.width;
const imgH = meta.height;
console.log(`[harness] image ${imgW}×${imgH}`);

// --- 2. CV — extract rail bbox + pitch ONLY (count is ignored) ----------
//
// Coordinate-system note: prepareModernGeometry returns mixed units.
//   - slotCentersX, railBbox, medianRails: NORMALISED 0..1000
//   - cvPitchDiag.pitchPx, chunkingDiag.railWidthPx: IMAGE PIXELS
// Convert everything to image pixels here.
console.log(`[harness] running prepareModernGeometry…`);
const tCV0 = Date.now();
const prepared = await prepareModernGeometry(imageBuffer, { railRoiHint });
const cvMs = Date.now() - tCV0;

const norm2px = (v, dim) => Math.round((v / 1000) * dim);

const pitchPx =
  prepared.cvPitchDiag?.pitchPx ??
  (prepared.slotCentersX && prepared.slotCentersX.length >= 2
    ? norm2px(prepared.slotCentersX[1], imgW) - norm2px(prepared.slotCentersX[0], imgW)
    : Math.round(imgW * 0.06));

const railLeftPx = norm2px(prepared.railBbox?.left ?? 50, imgW);
const railRightPx = norm2px(prepared.railBbox?.right ?? 950, imgW);
const railTopPx = norm2px(
  prepared.medianRails?.rail_top ?? prepared.railBbox?.top ?? 400,
  imgH
);
const railBottomPx = norm2px(
  prepared.medianRails?.rail_bottom ?? prepared.railBbox?.bottom ?? 600,
  imgH
);
const railWidthPx = railRightPx - railLeftPx;
const railHeightPx = railBottomPx - railTopPx;

console.log(
  `[harness] CV done in ${(cvMs / 1000).toFixed(1)}s — pitch=${pitchPx.toFixed(1)}px railWidth=${railWidthPx}px y=${railTopPx}..${railBottomPx}  (CV-suggested ways=${prepared.moduleCount} — IGNORED)`
);

// --- 3. Vertical crop band (covers labels above + below rail) ----------
const padPx = Math.round(railHeightPx * labelPad);
const cropTop = Math.max(0, railTopPx - padPx);
const cropBottom = Math.min(imgH, railBottomPx + padPx);
const cropH = cropBottom - cropTop;

// --- 4. Plan windows in PIXEL space ------------------------------------
const windowPx = Math.round(windowMod * pitchPx);
const stridePx = Math.round(strideMod * pitchPx);
const windows = [];
for (let x0 = railLeftPx; x0 + windowPx <= railRightPx + pitchPx * 0.3; x0 += stridePx) {
  windows.push({
    x0: Math.max(0, Math.round(x0)),
    x1: Math.min(imgW, Math.round(x0 + windowPx)),
  });
}
// Anchor a final window on the right if the last one doesn't cover the
// rightmost edge.
if (
  windows.length === 0 ||
  windows[windows.length - 1].x1 < railRightPx - pitchPx * 0.3
) {
  windows.push({
    x0: Math.max(0, Math.round(railRightPx - windowPx)),
    x1: Math.min(imgW, railRightPx),
  });
}
// Dedupe (in case the right-anchor matches the last natural window)
const dedup = [];
for (const w of windows) {
  if (dedup.length === 0 || Math.abs(dedup[dedup.length - 1].x0 - w.x0) > pitchPx * 0.3) {
    dedup.push(w);
  }
}
const finalWindows = dedup;
console.log(
  `[harness] planned ${finalWindows.length} windows (${windowPx}px wide, ${stridePx}px stride):`
);
for (const w of finalWindows) {
  console.log(`  x=${w.x0}..${w.x1} (${w.x1 - w.x0}px ≈ ${((w.x1 - w.x0) / pitchPx).toFixed(1)} modules)`);
}

// --- 5. VLM prompt — flexible count + position estimate ---------------
const PROMPT = `You are inspecting a horizontal section of a UK consumer unit's main DIN rail.

The image shows circuit-protective devices (MCBs, RCBOs, RCDs, blanking plates, main switches, SPDs) with a label strip above and/or below the rail. Identify EVERY device whose body is FULLY VISIBLE in this crop, in strict left-to-right order. Skip devices clipped at the left or right edge — the next window will capture them.

Return as many devices as you see — could be 3, 4, 5, 6, 7, or more. Don't be constrained by any expected count.

For multi-module devices (a 2-pole main switch or 2-module RCD spans two adjacent module slots): return ONE entry for the whole device. Indicate its width via \`width_modules\` (1 for normal MCB/RCBO/SPD, 2 for typical 2-pole main switch / 2-module RCD).

For each device:
- position_pct: NUMBER between 0.0 and 1.0 — the fraction of THE IMAGE WIDTH where this device's CENTRE lies (left edge=0.0, right edge=1.0). Be precise: the device's geometric centre.
- width_modules: 1 or 2 (rarely 3 or 4 for very wide isolators).
- device_kind: one of "mcb", "rcbo", "rcd", "main_switch", "spd", "blank"
- label: circuit name from the strip directly aligned with this device's CENTRE — copy VERBATIM (preserve exact spelling, including handwritten quirks). Do NOT aggregate or paraphrase from neighbouring devices. null if blank/unreadable.

DEVICE FACE FIELDS (null if not clearly readable — never guess):
- ocpd_rating_a: integer amperage from the device face (e.g. 32 for "B32A").
- ocpd_curve: "B", "C", or "D" for MCBs/RCBOs.
- ocpd_bs_en: e.g. "BS EN 61009-1", "BS EN 60898-1", "BS EN 61008-1", "BS EN 60947-3".
- rcd_type: "AC", "A", "F", or "B" — ONLY if the trip classification is explicitly stated as TEXT on the device. The international AC waveform symbol alone does NOT mean Type AC; many Type A devices show that symbol. If unsure, return null.
- rcd_rating_ma: 30, 100, 300, or 500.

Return STRICT JSON only — no markdown, no commentary:
{"devices":[{"position_pct":0.1,"width_modules":1,"device_kind":"rcbo",...},...]}`;

// --- 6. Run windows in parallel ----------------------------------------
const anthropic = dryRun ? null : new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = (process.env.CCU_MODEL || 'claude-sonnet-4-6').trim();
const IN_PER_MTOK = Number(process.env.SONNET_IN_PER_MTOK || 3.0);
const OUT_PER_MTOK = Number(process.env.SONNET_OUT_PER_MTOK || 15.0);

const wallClockStart = Date.now();
const tasks = finalWindows.map(async (w, i) => {
  const cropW = w.x1 - w.x0;
  const cropBuf = await sharp(imageBuffer)
    .extract({ left: w.x0, top: cropTop, width: cropW, height: cropH })
    .resize({ width: 1536, withoutEnlargement: false })
    .jpeg({ quality: 90 })
    .toBuffer();

  if (outDir) {
    const fname = `window-${String(i + 1).padStart(2, '0')}-x${w.x0}-${w.x1}.jpg`;
    fs.writeFileSync(path.join(outDir, fname), cropBuf);
  }

  if (dryRun) {
    return {
      window: i + 1,
      cropPx: { x: w.x0, y: cropTop, w: cropW, h: cropH },
      vlm: null,
      parsed: null,
      parseErr: null,
      rawText: '(dry-run)',
    };
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
  const usage = resp.usage || {};
  const cost =
    ((usage.input_tokens ?? 0) * IN_PER_MTOK + (usage.output_tokens ?? 0) * OUT_PER_MTOK) /
    1_000_000;

  const textBlock = resp.content.find((b) => b.type === 'text');
  const rawText = textBlock?.text ?? '';
  let parsed = null;
  let parseErr = null;
  try {
    const fenced = rawText.match(/```(?:json)?\s*([\s\S]+?)```/);
    parsed = JSON.parse(fenced ? fenced[1] : rawText);
  } catch (err) {
    parseErr = err.message;
  }

  return {
    window: i + 1,
    cropPx: { x: w.x0, y: cropTop, w: cropW, h: cropH },
    vlm: { ms, usage, cost },
    parsed,
    parseErr,
    rawText,
  };
});

const results = await Promise.all(tasks);
const wallClockMs = Date.now() - wallClockStart;
const totalCostUsd = results.reduce((s, r) => s + (r.vlm?.cost ?? 0), 0);
const sumWindowMs = results.reduce((s, r) => s + (r.vlm?.ms ?? 0), 0);

// Convert each device's position_pct → image-space centre X.
const allReads = [];
for (const r of results) {
  console.log(
    `\n[harness] window ${r.window}/${finalWindows.length} crop=${r.cropPx.w}×${r.cropPx.h}px x=${r.cropPx.x}..${r.cropPx.x + r.cropPx.w}`
  );
  if (r.vlm) console.log(`  ${r.vlm.ms}ms  $${r.vlm.cost.toFixed(4)}`);
  if (r.parseErr) {
    console.log(`  [parse error] ${r.parseErr}`);
    console.log(`  raw: ${r.rawText.slice(0, 200)}…`);
    continue;
  }
  if (!r.parsed) continue;
  const devices = r.parsed.devices || r.parsed.circuits || [];
  console.log(`  VLM returned ${devices.length} devices:`);
  devices.forEach((d, idx) => {
    const pct = Number(d.position_pct);
    const validPct = Number.isFinite(pct) && pct >= 0 && pct <= 1;
    const xImage = validPct ? r.cropPx.x + pct * r.cropPx.w : null;
    if (xImage != null) {
      allReads.push({
        window: r.window,
        xImage,
        widthMod: Number(d.width_modules) || 1,
        kind: d.device_kind || null,
        rating: d.ocpd_rating_a ?? null,
        curve: d.ocpd_curve || null,
        bs_en: d.ocpd_bs_en || null,
        rcd_type: d.rcd_type || null,
        rcd_rating_ma: d.rcd_rating_ma ?? null,
        label: d.label || null,
      });
    }
    console.log(
      `    ${idx + 1}. pct=${validPct ? pct.toFixed(2) : '?'} w=${d.width_modules || 1}m  ${d.device_kind || '?'}  ${d.ocpd_curve || ''}${d.ocpd_rating_a || '?'}A  label="${d.label || ''}"  ${d.rcd_type ? `Type ${d.rcd_type}/${d.rcd_rating_ma}mA` : ''}`
    );
  });
}

console.log(
  `\n[harness] CV ${(cvMs / 1000).toFixed(1)}s + VLM wall ${(wallClockMs / 1000).toFixed(1)}s (sum ${(sumWindowMs / 1000).toFixed(1)}s) cost=$${totalCostUsd.toFixed(4)}  reads=${allReads.length}`
);

if (dryRun) {
  console.log('\n[harness] dry-run — VLM skipped.');
  if (outDir) {
    fs.writeFileSync(
      path.join(outDir, 'summary.json'),
      JSON.stringify({ windowMod, strideMod, dryRun: true, finalWindows, results }, null, 2)
    );
  }
  process.exit(0);
}

// --- 7. Position-based clustering -------------------------------------
// Two reads are the same physical device when:
//   - Their image-space X positions are within CLUSTER_TOLERANCE_PX of
//     each other (0.7 × pitch — a bit looser than half-pitch to absorb
//     VLM position-estimate noise, but still tight enough that adjacent
//     slots one pitch apart never merge).
//   - Their kinds match (a 2-pole main_switch and a 1-pole MCB at
//     similar positions are different devices).
//   - LABELS ARE NOT REQUIRED TO MATCH — the VLM frequently misreads
//     adjacent labels (HOB → UTILITY, OVENS → HOB, etc.). Letting the
//     position+kind dominate, then voting on the label per cluster,
//     gives the right answer when labels disagree across windows.
//
// For SAME-NAME ADJACENT circuits (e.g., two LIGHTING circuits one slot
// apart), separation is one full pitch → > 0.7 × pitch tolerance →
// they remain distinct clusters. Position is the disambiguator.
const CLUSTER_TOLERANCE_PX = pitchPx * 0.7;
allReads.sort((a, b) => a.xImage - b.xImage);

function fingerprintCompatible(a, b) {
  const aKind = (a.kind || '').toLowerCase();
  const bKind = (b.kind || '').toLowerCase();
  if (aKind && bKind && aKind !== bKind) return false;
  return true;
}

const clusters = [];
for (const r of allReads) {
  const last = clusters[clusters.length - 1];
  if (last) {
    const lastMeanX = last.reads.reduce((s, x) => s + x.xImage, 0) / last.reads.length;
    if (
      Math.abs(r.xImage - lastMeanX) < CLUSTER_TOLERANCE_PX &&
      fingerprintCompatible(r, last.reads[0])
    ) {
      last.reads.push(r);
      continue;
    }
  }
  clusters.push({ reads: [r] });
}

console.log(`\n[merge] ${clusters.length} clusters from ${allReads.length} reads (tolerance=${CLUSTER_TOLERANCE_PX.toFixed(0)}px ≈ pitch/2)`);

// --- 8. Per-cluster consensus voting -----------------------------------
function mostCommon(values) {
  const counts = new Map();
  for (const v of values) {
    if (v == null || v === '') continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}
function bestLabel(labels) {
  const valid = labels.filter((l) => l && String(l).trim().length > 0);
  if (valid.length === 0) return null;
  const counts = new Map();
  for (const l of valid) counts.set(l, (counts.get(l) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0];
}

const finalDevices = clusters.map((c) => {
  const meanX = c.reads.reduce((s, r) => s + r.xImage, 0) / c.reads.length;
  return {
    xImage: Math.round(meanX),
    relX: Math.round(((meanX - railLeftPx) / Math.max(1, railWidthPx)) * 100) / 100,
    width_modules: mostCommon(c.reads.map((r) => r.widthMod)) || 1,
    device_kind: mostCommon(c.reads.map((r) => r.kind)),
    ocpd_rating_a: mostCommon(c.reads.map((r) => r.rating)),
    ocpd_curve: mostCommon(c.reads.map((r) => r.curve)),
    ocpd_bs_en: mostCommon(c.reads.map((r) => r.bs_en)),
    rcd_type: mostCommon(c.reads.map((r) => r.rcd_type)),
    rcd_rating_ma: mostCommon(c.reads.map((r) => r.rcd_rating_ma)),
    label: bestLabel(c.reads.map((r) => r.label)),
    votes: c.reads.length,
  };
});

console.log(`\n[harness] FINAL: ${finalDevices.length} devices (CV-suggested ways=${prepared.moduleCount}, IGNORED)`);
finalDevices.forEach((d, idx) => {
  console.log(
    `  ${idx + 1}. x=${d.xImage}px (relX=${(d.relX * 100).toFixed(0)}%) w=${d.width_modules}m votes=${d.votes}  ${d.device_kind || '?'}  ${d.ocpd_curve || ''}${d.ocpd_rating_a ?? '?'}A  label="${d.label || ''}"  ${d.rcd_type ? `Type ${d.rcd_type}/${d.rcd_rating_ma}mA` : ''}`
  );
});

const totalModules = finalDevices.reduce((s, d) => s + (d.width_modules || 1), 0);
console.log(
  `\n[harness] sum width_modules = ${totalModules}  (rail width / pitch = ${(railWidthPx / pitchPx).toFixed(1)})`
);

if (outDir) {
  fs.writeFileSync(
    path.join(outDir, 'summary.json'),
    JSON.stringify(
      {
        windowMod,
        strideMod,
        labelPad,
        cvMs,
        wallClockMs,
        totalCostUsd,
        sumWindowMs,
        pitchPx,
        railLeftPx,
        railRightPx,
        railWidthPx,
        cvSuggestedWays: prepared.moduleCount,
        finalWindows,
        results,
        finalDevices,
      },
      null,
      2
    )
  );
  console.log(`\n[harness] wrote crops + summary.json to ${outDir}`);
}
