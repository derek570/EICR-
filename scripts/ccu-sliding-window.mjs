/**
 * Sliding-window CCU extraction harness — exploratory mock (v2).
 *
 * Reuses the existing CV pipeline (prepareModernGeometry — line-fitted rail
 * edges, bilinear quadrilateral, autocorrelation pitch, bounded phase-lock)
 * to derive `ways` and per-slot pixel positions, THEN crops sliding windows
 * along slot boundaries so each window contains exactly N centred devices.
 * No more guessing module count or asking the VLM to skip clipped edges —
 * each crop spans EXACTLY N modules from slot-N's centre minus half a pitch
 * to slot-(N+windowSize-1)'s centre plus half a pitch.
 *
 * Position-anchored merge: every VLM circuit is mapped to the global slot
 * column it occupies (window.firstSlot + position_offset). Each slot then
 * gets one row built by voting across all windows that covered it. Multi-
 * module devices (2-pole main switch, 2-module RCD) are anchored on their
 * leftmost slot and span `module_columns_used` columns.
 *
 * Pure exploratory tool. No production wiring.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/ccu-sliding-window.mjs <photo> \
 *     [--roi=x,y,w,h] [--window=5] [--stride=2] [--label-pad=1.0] \
 *     [--out=DIR] [--dry-run]
 *
 *   --roi=x,y,w,h    Optional iOS rail-roi hint (normalised 0..1). Skipping
 *                    it falls back to VLM-only rail detection (slower, but
 *                    proves the harness works without iOS framing).
 *   --window=5       Slots per window (default 5).
 *   --stride=2       Slot-stride between windows (default 2 → 3-slot overlap).
 *   --label-pad=1.0  Vertical padding above/below rail as a multiple of
 *                    rail height. Captures label strips.
 *   --out=DIR        Write window crops + summary.json for inspection.
 *   --dry-run        Skip VLM calls (still runs CV + writes crops).
 */
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { prepareModernGeometry } from '../src/extraction/ccu-geometric.js';

const photoPath = process.argv[2];
if (!photoPath) {
  console.error(
    'usage: node scripts/ccu-sliding-window.mjs <photo> [--roi=x,y,w,h] [--window=5] [--stride=2]'
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
const argInt = (name, fallback) => {
  const v = argFloat(name, fallback);
  return Number.isFinite(v) ? Math.round(v) : fallback;
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
const windowSize = argInt('window', 5);
const stride = argInt('stride', 2);
const labelPad = argFloat('label-pad', 1.0);
const outDir = argStr('out', null);

if (outDir) fs.mkdirSync(outDir, { recursive: true });

console.log(`[harness] photo=${photoPath} window=${windowSize} stride=${stride}`);

// --- 1. Load + replicate route-handler resize ----------------------------
// The production route resizes images > ~3.7 MB raw to fit 2048×2048 q80.
// CV output coords reference whatever buffer we pass in, so we MUST do the
// same resize before calling prepareModernGeometry, otherwise the slot
// centres won't match where we crop.
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
console.log(`[harness] image ${imgW}×${imgH} (post-resize, ${(imageBuffer.length / 1024).toFixed(0)} KB)`);

// --- 2. Run CV pipeline (the existing prepareModernGeometry) -------------
console.log(`[harness] running prepareModernGeometry…`);
const tCV0 = Date.now();
const prepared = await prepareModernGeometry(imageBuffer, { railRoiHint });
const cvMs = Date.now() - tCV0;
const ways = prepared.moduleCount;
const pitchSource = prepared.pitchSource;
const slotCentersNorm = prepared.slotCentersX || [];
const slotCentersPx = slotCentersNorm.map((v) => Math.round((v / 1000) * imgW));
const railTopNorm = prepared.medianRails?.rail_top;
const railBottomNorm = prepared.medianRails?.rail_bottom;
const railTopPx =
  railTopNorm != null
    ? Math.round((railTopNorm / 1000) * imgH)
    : prepared.railBbox?.top ?? Math.round(imgH * 0.35);
const railBottomPx =
  railBottomNorm != null
    ? Math.round((railBottomNorm / 1000) * imgH)
    : prepared.railBbox?.bottom ?? Math.round(imgH * 0.55);
const railHPx = railBottomPx - railTopPx;
const pitchPx = slotCentersPx.length >= 2 ? slotCentersPx[1] - slotCentersPx[0] : railHPx; // crude fallback
console.log(
  `[harness] CV done in ${(cvMs / 1000).toFixed(1)}s — ways=${ways} pitch=${pitchPx}px source=${pitchSource}  railY=${railTopPx}..${railBottomPx}`
);
console.log(`[harness] slot centres (px): [${slotCentersPx.join(', ')}]`);

// --- 3. Vertical crop band (covers labels above + below rail) ------------
const padPx = Math.round(railHPx * labelPad);
const cropTop = Math.max(0, railTopPx - padPx);
const cropBottom = Math.min(imgH, railBottomPx + padPx);
const cropH = cropBottom - cropTop;
console.log(`[harness] vertical band: y=${cropTop}..${cropBottom} h=${cropH}`);

// --- 4. Plan windows by slot index ---------------------------------------
// Each window covers `windowSize` consecutive slots (0-indexed). The last
// window is anchored on the rightmost slot so we never under-cover.
const windows = [];
let firstSlot = 0;
while (firstSlot + windowSize - 1 < ways) {
  windows.push({ firstSlot, lastSlot: firstSlot + windowSize - 1 });
  firstSlot += stride;
}
if (windows.length === 0 || windows[windows.length - 1].lastSlot < ways - 1) {
  windows.push({
    firstSlot: Math.max(0, ways - windowSize),
    lastSlot: ways - 1,
  });
}
console.log(
  `[harness] planned ${windows.length} windows: ${windows
    .map((w) => `[${w.firstSlot}..${w.lastSlot}]`)
    .join(' ')}`
);

// --- 5. VLM prompt — one entry per module slot --------------------------
// Hard-constraint approach: tell the VLM exactly how many DIN modules
// the image contains and ask for ONE entry per module slot. For multi-
// module devices (2-pole main switches, 2-module RCDs) the VLM returns
// IDENTICAL entries across the slots they span. The merger then collapses
// consecutive identical (kind, rating, label) reads into a single logical
// device. This avoids the VLM-side ambiguity around "module_columns_used"
// that bit the v3 corpus run on Crabtree (every device returned as 2c
// or 1c per window inconsistently — module count math broke entirely).
//
// Built per-window: window K covers `slotCount` modules and that count
// is interpolated into the prompt below.
const buildPrompt = (slotCount) => `You are inspecting a horizontal section of a UK consumer unit's main DIN rail.

THIS IMAGE SHOWS EXACTLY ${slotCount} DIN-RAIL MODULE SLOTS side-by-side. Each slot is the same physical width (about 17.5 mm). A typical single-pole MCB or RCBO occupies ONE slot. A 2-pole main switch or 2-module RCD occupies TWO adjacent slots — it is ONE logical device but spans two slots.

Return EXACTLY ${slotCount} entries — one per slot, in strict left-to-right order. For a multi-module device (e.g. a 2-pole main switch spanning 2 slots), return TWO entries with identical kind/rating/label/bs_en. For a blank slot or missing module, return device_kind="blank".

REQUIRED FIELDS PER SLOT:
- slot_index: 1..${slotCount}, left to right
- device_kind: one of "mcb", "rcbo", "rcd", "main_switch", "spd", "blank"
- label: circuit name from the strip directly aligned with this slot's CENTRE — copy VERBATIM, preserve exact spelling. Do NOT aggregate text from other slots. null if blank/unreadable. For a multi-slot device, REPEAT the label on every slot it spans.

DEVICE FACE FIELDS (null if not readable):
- ocpd_rating_a: integer amperage. Never guess if any digit is unclear.
- ocpd_curve: "B", "C", or "D" for MCBs/RCBOs.
- ocpd_bs_en: e.g. "BS EN 61009-1", "BS EN 60898-1", "BS EN 61008-1", "BS EN 60947-3".
- rcd_type: "AC", "A", "F", or "B" — only if trip classification is explicitly stated as TEXT on the device. The AC waveform symbol alone does NOT mean Type AC.
- rcd_rating_ma: 30, 100, 300, or 500.

Return STRICT JSON only — no markdown, no commentary:
{"slots":[{"slot_index":1,"device_kind":"mcb",...},{"slot_index":2,...},...]}`;

// --- 6. Run windows in parallel ------------------------------------------
const anthropic = dryRun ? null : new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = (process.env.CCU_MODEL || 'claude-sonnet-4-6').trim();
const IN_PER_MTOK = Number(process.env.SONNET_IN_PER_MTOK || 3.0);
const OUT_PER_MTOK = Number(process.env.SONNET_OUT_PER_MTOK || 15.0);

const wallClockStart = Date.now();
const tasks = windows.map(async (w, i) => {
  // Crop: from leftSlot.center − pitch/2 to rightSlot.center + pitch/2.
  // This places each window's edges on the BOUNDARY between slots, so all
  // N devices are fully centred and visible.
  const cropX0 = Math.max(0, slotCentersPx[w.firstSlot] - Math.round(pitchPx / 2));
  const cropX1 = Math.min(imgW, slotCentersPx[w.lastSlot] + Math.round(pitchPx / 2));
  const cropW = cropX1 - cropX0;

  const cropBuf = await sharp(imageBuffer)
    .extract({ left: cropX0, top: cropTop, width: cropW, height: cropH })
    .resize({ width: 1536, withoutEnlargement: false })
    .jpeg({ quality: 90 })
    .toBuffer();

  if (outDir) {
    const fname = `window-${String(i + 1).padStart(2, '0')}-s${w.firstSlot}-${w.lastSlot}.jpg`;
    fs.writeFileSync(path.join(outDir, fname), cropBuf);
  }

  if (dryRun) {
    return {
      window: i + 1,
      slotRange: { first: w.firstSlot, last: w.lastSlot },
      cropPx: { x: cropX0, y: cropTop, w: cropW, h: cropH },
      vlm: null,
      parsed: null,
      parseErr: null,
      rawText: '(dry-run)',
    };
  }

  const slotCount = w.lastSlot - w.firstSlot + 1;
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
          { type: 'text', text: buildPrompt(slotCount) },
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
    slotRange: { first: w.firstSlot, last: w.lastSlot },
    cropPx: { x: cropX0, y: cropTop, w: cropW, h: cropH },
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

for (const r of results) {
  console.log(
    `\n[harness] window ${r.window}/${windows.length} slots ${r.slotRange.first}..${r.slotRange.last}  crop=${r.cropPx.w}×${r.cropPx.h}px`
  );
  if (r.vlm) {
    console.log(`  ${r.vlm.ms}ms  $${r.vlm.cost.toFixed(4)}`);
  }
  if (r.parseErr) {
    console.log(`  [parse error] ${r.parseErr}`);
    console.log(`  raw: ${r.rawText.slice(0, 200)}…`);
  } else if (r.parsed) {
    const sl = r.parsed.slots || [];
    const expected = r.slotRange.last - r.slotRange.first + 1;
    console.log(`  VLM returned ${sl.length} slot reads (expected ${expected}):`);
    sl.forEach((c, idx) => {
      console.log(
        `    ${idx + 1}. ${c.device_kind || '?'}  ${c.ocpd_curve || ''}${c.ocpd_rating_a || '?'}A  label="${c.label || ''}"  ${c.rcd_type ? `Type ${c.rcd_type}/${c.rcd_rating_ma}mA` : ''}`
      );
    });
  }
}

console.log(
  `\n[harness] CV ${(cvMs / 1000).toFixed(1)}s + VLM wall ${(wallClockMs / 1000).toFixed(1)}s (sum ${(sumWindowMs / 1000).toFixed(1)}s)  ways=${ways} cost=$${totalCostUsd.toFixed(4)}`
);

if (dryRun) {
  console.log('\n[harness] dry-run — VLM skipped.');
  if (outDir) {
    fs.writeFileSync(
      path.join(outDir, 'summary.json'),
      JSON.stringify({ ways, windowSize, stride, dryRun: true, results }, null, 2)
    );
  }
  process.exit(0);
}

// --- 7. Per-slot merge with consensus voting + collapse ---------------
// Each window asked the VLM for one entry per module slot (constraint
// embedded in the prompt). The merger:
//
//   1. For each window, align its response to the global slot grid.
//      Ideal: response length === window slot count, position i → slot
//      firstSlot + i. If lengths drift, try offsets {0, ±1, ±2} and pick
//      the offset that maximises (kind, rating, label) agreement with
//      reads already collected from earlier windows.
//   2. Each global slot accumulates all reads from windows that covered
//      it. Per-field consensus voting picks the most-common non-null
//      value (ties broken by longest label, etc.).
//   3. After per-slot consensus, collapse consecutive slots with
//      identical (kind, rating, label) into one logical device. That
//      gives us 2-pole main switches and 2-module RCDs as single rows.

/** @type {Map<number, Array<{window:number,kind?:string,rating?:number,curve?:string,bs_en?:string,rcd_type?:string,rcd_rating_ma?:number,label?:string}>>} */
const slotReads = new Map();
const reasons = [];

function tokenOverlap(a, b) {
  const ta = new Set(String(a).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const tb = new Set(String(b).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  return hit / Math.max(ta.size, tb.size);
}

const TWO_PASSES = 2;
for (let pass = 0; pass < TWO_PASSES; pass++) {
  // Pass 0: builds initial reads in natural order. Pass 1: re-aligns each
  // window against the now-comprehensive read set, accepting better offsets.
  if (pass === 1) slotReads.clear();
  for (const r of results) {
    const sl = r.parsed?.slots || [];
    if (sl.length === 0) continue;

    const expected = r.slotRange.last - r.slotRange.first + 1;

    // Hard-constrain offsets: every placed read MUST fall within
    // [firstSlot..lastSlot]. The crops are physically anchored at slot
    // boundaries — there's no scenario where a correct read should land
    // outside the window's slot range.
    //   sl.length === expected → only offset 0 valid
    //   sl.length <  expected → VLM dropped slots; try [0..expected-sl.length]
    //   sl.length >  expected → VLM over-counted; offset 0, trim trailing reads
    let candidateOffsets;
    if (sl.length === expected) {
      candidateOffsets = [0];
    } else if (sl.length < expected) {
      candidateOffsets = Array.from(
        { length: expected - sl.length + 1 },
        (_, i) => i
      );
    } else {
      candidateOffsets = [0];
    }

    let bestOffset = 0;
    let bestScore = -Infinity;
    for (const offset of candidateOffsets) {
      let score = 0;
      const placedCount = Math.min(sl.length, expected - offset);
      for (let i = 0; i < placedCount; i++) {
        const globalSlot = r.slotRange.first + offset + i;
        const reads = slotReads.get(globalSlot) || [];
        if (reads.length === 0) continue;
        const kind = mostCommon(reads.map((v) => v.kind));
        const rating = mostCommon(reads.map((v) => v.rating));
        const label = bestLabel(reads.map((v) => v.label));
        if ((sl[i].device_kind || null) === kind && kind != null) score += 2;
        if ((sl[i].ocpd_rating_a ?? null) === rating && rating != null) score += 1;
        if (sl[i].label && label && tokenOverlap(sl[i].label, label) >= 0.5) score += 0.5;
      }
      if (score > bestScore) {
        bestScore = score;
        bestOffset = offset;
      }
    }
    if (pass === 1) {
      reasons.push(
        `pass2 window ${r.window} len=${sl.length}/${expected} chose offset=${bestOffset} score=${bestScore.toFixed(1)}`
      );
    }

    const placedCount = Math.min(sl.length, expected - bestOffset);
    for (let i = 0; i < placedCount; i++) {
      const globalSlot = r.slotRange.first + bestOffset + i;
      if (globalSlot < 0 || globalSlot >= ways) continue;
      if (globalSlot < r.slotRange.first || globalSlot > r.slotRange.last) continue;
      if (!slotReads.has(globalSlot)) slotReads.set(globalSlot, []);
      const c = sl[i];
      slotReads.get(globalSlot).push({
        window: r.window,
        kind: c.device_kind || null,
        rating: c.ocpd_rating_a ?? null,
        curve: c.ocpd_curve || null,
        bs_en: c.ocpd_bs_en || null,
        rcd_type: c.rcd_type || null,
        rcd_rating_ma: c.rcd_rating_ma ?? null,
        label: c.label || null,
      });
    }
  }
}

console.log('\n[merge] alignment decisions:');
for (const r of reasons) console.log(`  ${r}`);

// Per-slot consensus: for each global slot, vote on each field across
// all reads from windows that covered it.
const perSlot = [];
for (let s = 0; s < ways; s++) {
  const reads = slotReads.get(s) || [];
  if (reads.length === 0) {
    perSlot.push({ slot: s, votes: 0, synthetic: true });
    continue;
  }
  perSlot.push({
    slot: s,
    votes: reads.length,
    kind: mostCommon(reads.map((v) => v.kind)),
    rating: mostCommon(reads.map((v) => v.rating)),
    curve: mostCommon(reads.map((v) => v.curve)),
    bs_en: mostCommon(reads.map((v) => v.bs_en)),
    rcd_type: mostCommon(reads.map((v) => v.rcd_type)),
    rcd_rating_ma: mostCommon(reads.map((v) => v.rcd_rating_ma)),
    label: bestLabel(reads.map((v) => v.label)),
  });
}

// Collapse consecutive slots with identical (kind, rating, label) — that
// reflects a multi-module device the VLM repeated across slots per the
// prompt instruction.
const devices = [];
for (const slot of perSlot) {
  const last = devices[devices.length - 1];
  if (
    last &&
    !slot.synthetic &&
    !last.synthetic &&
    last.kind === slot.kind &&
    last.rating === slot.rating &&
    (last.label || '') === (slot.label || '') &&
    last.startSlot + last.colsUsed === slot.slot
  ) {
    last.colsUsed += 1;
    last.votes += slot.votes;
    continue;
  }
  devices.push({
    startSlot: slot.slot,
    colsUsed: 1,
    votes: slot.votes,
    synthetic: slot.synthetic,
    kind: slot.kind,
    rating: slot.rating,
    curve: slot.curve,
    bs_en: slot.bs_en,
    rcd_type: slot.rcd_type,
    rcd_rating_ma: slot.rcd_rating_ma,
    label: slot.label,
  });
}

// Vote per field across all reads of each device.
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
  // Most common; tie-break on length (longer = more info).
  const counts = new Map();
  for (const l of valid) counts.set(l, (counts.get(l) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0];
}

console.log(`\n[merge] final schedule (${devices.length} devices, ${ways} slots):`);
const finalRows = devices.map((d) => ({
  slot: d.startSlot,
  cols: d.colsUsed,
  votes: d.votes,
  device_kind: d.kind,
  ocpd_rating_a: d.rating,
  ocpd_curve: d.curve,
  ocpd_bs_en: d.bs_en,
  rcd_type: d.rcd_type,
  rcd_rating_ma: d.rcd_rating_ma,
  label: d.label,
  missing: !!d.synthetic,
}));

finalRows.forEach((r, idx) => {
  if (r.missing) {
    console.log(`  ${idx + 1}. slot=${r.slot} ❌ NO READS`);
    return;
  }
  console.log(
    `  ${idx + 1}. slot=${r.slot} [${r.cols}c×${r.votes}v]  ${r.device_kind || '?'}  ${r.ocpd_curve || ''}${r.ocpd_rating_a ?? '?'}A  label="${r.label || ''}"  ${r.rcd_type ? `Type ${r.rcd_type}/${r.rcd_rating_ma}mA` : ''}`
  );
});

const expectedDevices = ways;
const totalCols = finalRows.reduce((s, r) => s + (r.cols || 1), 0);
console.log(
  `\n[merge] total cols=${totalCols} (vs ways=${expectedDevices}) — ${totalCols === expectedDevices ? '✓ MATCH' : '✗ MISMATCH'}`
);

if (outDir) {
  fs.writeFileSync(
    path.join(outDir, 'summary.json'),
    JSON.stringify(
      {
        ways,
        windowSize,
        stride,
        labelPad,
        cvMs,
        wallClockMs,
        totalCostUsd,
        sumWindowMs,
        results,
        finalRows,
      },
      null,
      2
    )
  );
  console.log(`\n[harness] wrote crops + summary.json to ${outDir}`);
}
