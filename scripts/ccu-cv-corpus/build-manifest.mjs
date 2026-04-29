#!/usr/bin/env node
/**
 * Walk scripts/ccu-cv-corpus/raw/<extractionId>/ entries, read result.json, and
 * build a single manifest.json describing each photo: image hash (so we can
 * dedupe), the user's hand-drawn box (medianRails → x/y/w/h normalised),
 * the previous pipeline's reported moduleCount + circuitCount, board
 * manufacturer + model, and the photo's pixel dimensions.
 *
 * The manifest is the input that ccu-cv-prototype.mjs reads — annotations.json
 * (ground-truth module counts, hand-marked) sits alongside and is keyed by
 * extractionId.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';

const corpusDir = path.resolve(import.meta.dirname, 'raw');
const ids = fs.readdirSync(corpusDir).filter((f) => fs.statSync(path.join(corpusDir, f)).isDirectory());
const entries = [];

for (const id of ids) {
  const photoPath = path.join(corpusDir, id, 'original.jpg');
  const resultPath = path.join(corpusDir, id, 'result.json');
  if (!fs.existsSync(photoPath) || !fs.existsSync(resultPath)) {
    console.warn(`[skip] ${id}: missing photo or result.json`);
    continue;
  }

  const photoBytes = fs.readFileSync(photoPath);
  const sha = crypto.createHash('sha256').update(photoBytes).digest('hex').slice(0, 16);
  const meta = await sharp(photoBytes).metadata();

  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const a = result.analysis ?? {};
  const g = a.geometric ?? {};
  const mr = g.medianRails ?? null;

  // medianRails is in 0-1000 normalised; convert to 0-1 box {x,y,w,h}.
  let userBox = null;
  if (mr && typeof mr.rail_left === 'number') {
    userBox = {
      x: mr.rail_left / 1000,
      y: mr.rail_top / 1000,
      w: (mr.rail_right - mr.rail_left) / 1000,
      h: (mr.rail_bottom - mr.rail_top) / 1000,
    };
  }

  entries.push({
    extractionId: id,
    photo: `raw/${id}/original.jpg`,
    timestamp: result.meta?.timestamp ?? null,
    width: meta.width,
    height: meta.height,
    bytes: photoBytes.length,
    sha16: sha,
    boardTechnology: a.board_technology ?? null,
    boardManufacturer: a.board_manufacturer ?? null,
    boardModel: a.board_model ?? null,
    userBox,
    prevModuleCount: g.moduleCount ?? null,
    prevCircuitCount: Array.isArray(a.circuits) ? a.circuits.length : null,
    extractionSource: a.extraction_source ?? null,
  });
}

// Group duplicates by sha16 so we can pick one representative per unique photo.
const bySha = new Map();
for (const e of entries) {
  if (!bySha.has(e.sha16)) bySha.set(e.sha16, []);
  bySha.get(e.sha16).push(e.extractionId);
}

const dupes = [...bySha.entries()].filter(([, ids]) => ids.length > 1);

const out = {
  generatedAt: new Date().toISOString(),
  totalEntries: entries.length,
  uniquePhotos: bySha.size,
  duplicates: dupes.map(([sha, ids]) => ({ sha16: sha, ids })),
  entries: entries.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || '')),
};

fs.writeFileSync(path.join(import.meta.dirname, 'manifest.json'), JSON.stringify(out, null, 2));
console.log(`[manifest] ${entries.length} entries, ${bySha.size} unique photos, ${dupes.length} duplicate groups`);
