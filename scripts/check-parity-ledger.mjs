#!/usr/bin/env node
/**
 * Parity-ledger staleness warner (WS1 of the iOS↔Web Full-Parity Program).
 *
 * WHAT: given the list of files a PR touches, look up each file's parity-
 * ledger rows via web/docs/parity-ledger-files.json (file → [row id]) and
 * emit GitHub `::warning::` annotations when a touched file's rows are
 * stale — i.e. their `last-verified` date is blank, invalid, or older than
 * 30 days. Blank-dated rows are collapsed into ONE summary warning line so
 * the step is signal, not noise (most rows started blank when the column
 * was introduced 2026-07-02); rows with a REAL-but-stale date warn per-row.
 *
 * WHY: ledger rows marked `match` decay silently — refactors after the row
 * was verified are never re-scanned (the 2026-04 "missing: 0" ledger had
 * re-opened gaps within weeks). This step makes the decay visible on the
 * exact PR that touches a mapped surface, without ever blocking a deploy.
 *
 * GUARANTEES:
 *  - ALWAYS exits 0 (warn-only by contract; CI also sets
 *    continue-on-error on the job as belt-and-braces).
 *  - Row identity is the stable `id` slug column — NEVER markdown line
 *    numbers or row indexes (table edits must not shift identity).
 *  - Only markdown tables whose header row contains BOTH an `id` and a
 *    `last-verified` column are parsed; summary/count tables without those
 *    headers are skipped silently, not warned about.
 *  - Touched files with no entry in the map are silently ignored by
 *    design — the map only covers ledger-tracked parity surfaces.
 *  - An id present in the JSON map but missing from the ledger is itself
 *    a warn condition, as is a duplicate id within the ledger.
 *
 * Usage:
 *   node scripts/check-parity-ledger.mjs \
 *     --ledger web/docs/parity-ledger.md \
 *     --map web/docs/parity-ledger-files.json \
 *     --changed-files /tmp/parity-ledger-changed-files.txt
 */
import { readFileSync } from 'node:fs';

const STALE_DAYS = 30;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function warn(msg) {
  // GitHub annotation format; shows on the run summary + PR checks tab.
  console.log(`::warning::${msg}`);
}

try {
  const ledgerPath = arg('ledger');
  const mapPath = arg('map');
  const changedPath = arg('changed-files');
  if (!ledgerPath || !mapPath || !changedPath) {
    warn('check-parity-ledger: missing --ledger/--map/--changed-files argument — skipping check');
    process.exit(0);
  }

  const ledger = readFileSync(ledgerPath, 'utf8');
  const map = JSON.parse(readFileSync(mapPath, 'utf8'));
  const changed = readFileSync(changedPath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // ---- parse the ledger: rows indexed by id ----------------------------
  /** @type {Map<string, {lastVerified: string}>} */
  const rows = new Map();
  const duplicateIds = new Set();
  let inTable = false;
  let idIdx = -1;
  let lvIdx = -1;

  for (const line of ledger.split('\n')) {
    if (!line.startsWith('|')) {
      inTable = false;
      continue;
    }
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    const lower = cells.map((c) => c.toLowerCase());
    if (lower.includes('id') && lower.includes('last-verified')) {
      // header row of a parity-mapping table
      inTable = true;
      idIdx = lower.indexOf('id');
      lvIdx = lower.indexOf('last-verified');
      continue;
    }
    if (!inTable) continue;
    if (/^:?-+:?$/.test(cells[0] || '')) continue; // separator row
    const id = cells[idIdx];
    if (!id) continue;
    if (rows.has(id)) duplicateIds.add(id);
    rows.set(id, { lastVerified: cells[lvIdx] ?? '' });
  }

  for (const id of duplicateIds) {
    warn(`parity-ledger: duplicate row id "${id}" in ${ledgerPath} — row identity must be unique; fix the ledger`);
  }

  // ---- evaluate staleness for touched, mapped files --------------------
  const now = Date.now();
  const staleMs = STALE_DAYS * 24 * 60 * 60 * 1000;
  const blankRowFiles = new Set(); // files with >=1 blank-dated row (collapsed summary)
  let datedStaleCount = 0;

  for (const file of changed) {
    const ids = map[file];
    if (!ids) continue; // unmapped file: silently ignored by design
    for (const id of ids) {
      const row = rows.get(id);
      if (!row) {
        warn(`parity-ledger: "${file}" maps to row id "${id}" which no longer exists in ${ledgerPath} — update web/docs/parity-ledger-files.json or restore the row`);
        continue;
      }
      const lv = row.lastVerified;
      if (!lv) {
        blankRowFiles.add(file); // collapsed into one summary line below
        continue;
      }
      const parsed = /^\d{4}-\d{2}-\d{2}$/.test(lv) ? Date.parse(lv) : NaN;
      if (Number.isNaN(parsed)) {
        datedStaleCount++;
        warn(`parity-ledger: row "${id}" (touched via ${file}) has invalid last-verified date "${lv}" — use ISO YYYY-MM-DD`);
      } else if (now - parsed > staleMs) {
        datedStaleCount++;
        warn(`parity-ledger: row "${id}" (touched via ${file}) last verified ${lv} — over ${STALE_DAYS} days ago; re-verify against current iOS source and update the date`);
      }
    }
  }

  if (blankRowFiles.size > 0) {
    warn(`parity-ledger: ${blankRowFiles.size} touched file(s) have unverified ledger rows (blank last-verified) — consider re-verifying the mapped rows in web/docs/parity-ledger.md: ${[...blankRowFiles].join(', ')}`);
  }

  console.log(
    `check-parity-ledger: ${changed.length} changed file(s), ${rows.size} ledger row(s); ` +
      `${blankRowFiles.size} file(s) with blank-dated rows, ${datedStaleCount} dated-stale row warning(s), ` +
      `${duplicateIds.size} duplicate id(s).`
  );
} catch (err) {
  // NEVER fail the deploy path — a broken check degrades to a warning.
  warn(`check-parity-ledger: internal error (${err?.message ?? err}) — check skipped`);
}
process.exit(0);
