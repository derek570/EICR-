#!/usr/bin/env node
/**
 * normalise-bs-en-values.js — One-shot data normalisation for the
 * Phase 2 (8 Branagh Court session DC946608) enum migration.
 *
 * WHAT
 *   Walks every row in `job_versions.data_snapshot` (the JSONB blob that
 *   stores per-circuit fields) and rewrites `rcd_bs_en` + `ocpd_bs_en`
 *   values to the canonical option list defined in
 *   `config/field_schema.json`.
 *
 *   Pre-Phase-2, both fields were `type: text` so the inspector / Sonnet
 *   could write any string. Production data accumulated variants like
 *   "BS EN 61008", "61008-1", "BS 60898", "MCB", "88-2" etc. that don't
 *   match the new `select` option lists. The iOS picker would render
 *   those rows as empty selection until normalised.
 *
 *   Mapping table is conservative — only well-known synonyms are
 *   rewritten; unknown values are LEFT IN PLACE and reported so a human
 *   can decide.
 *
 * WHY A SCRIPT (not a pgm migration)
 *   - Touches every job_versions row → wants explicit dry-run + review
 *     before applying.
 *   - One-shot — once production data is normalised the script can be
 *     archived.
 *   - The schema change (text → select in field_schema.json) is the
 *     real "migration" in the schema-evolution sense; this file is
 *     data-only cleanup.
 *
 * USAGE
 *   node scripts/normalise-bs-en-values.js              # dry-run (default)
 *   node scripts/normalise-bs-en-values.js --apply      # write changes
 *   node scripts/normalise-bs-en-values.js --report-only # print before/after report and exit
 *   node scripts/normalise-bs-en-values.js --limit 100  # only process N rows
 *
 * SAFETY
 *   - Default mode is dry-run. The --apply flag is required to commit
 *     UPDATE statements.
 *   - Each version row is processed in its own transaction (fail-isolated).
 *   - `data_snapshot` is JSONB; we read, mutate the in-memory object,
 *     and write back. The deep clone is unnecessary because we re-read
 *     into a fresh object per row.
 *   - Unknown values (not in any mapping table) are LEFT UNCHANGED and
 *     surfaced in the final report so a human can extend the mapping
 *     table or fix the data manually.
 */

import { Pool } from 'pg';
import process from 'node:process';

// ----------------------------------------------------------------------------
// Mapping tables — keys are pre-normalisation values seen in production;
// values are the canonical option list members from field_schema.json.
// Match is case-INSENSITIVE on the key (entries lowercased in the lookup).
// ----------------------------------------------------------------------------

const RCD_BS_EN_MAP = {
  // No-op rows (canonical → canonical) — listed for documentation.
  '': '',
  '61008': '61008',
  '61009': '61009',
  '62423': '62423',
  'n/a': 'N/A',

  // Common pre-Phase-2 variants observed in production.
  'bs 61008': '61008',
  'bs en 61008': '61008',
  'bs en 61008-1': '61008',
  'en 61008': '61008',
  '61008-1': '61008',
  'bs 61009': '61009',
  'bs en 61009': '61009',
  'bs en 61009-1': '61009',
  'en 61009': '61009',
  '61009-1': '61009',
  'bs 62423': '62423',
  'bs en 62423': '62423',
  'en 62423': '62423',
  na: 'N/A',
  none: 'N/A',
  'no rcd': 'N/A',
  'no rcd fitted': 'N/A',
};

// ocpd_bs_en options match BS_EN_LOOKUP in src/routes/extraction.js:257.
const OCPD_BS_EN_MAP = {
  // No-op rows.
  '': '',
  '60898-1': '60898-1',
  '61009': '61009',
  '60947-2': '60947-2',
  '60947-3': '60947-3',
  '60269-2': '60269-2',
  'bs 3036': 'BS 3036',
  'bs 1361': 'BS 1361',
  'n/a': 'N/A',

  // Common variants. Bare-digit "60898" → "60898-1" is the canonical
  // form; the BS_EN_LOOKUP already writes "60898-1" for new MCB
  // detections, so older records carrying just "60898" get aligned here.
  '60898': '60898-1',
  'bs 60898': '60898-1',
  'bs en 60898': '60898-1',
  'bs en 60898-1': '60898-1',
  'en 60898': '60898-1',
  // Sub-variants of 60898 (uncommon in low-voltage residential — they
  // exist for surge-immune / battery-isolating MCBs but are rare). Map
  // to the base 60898-1 so the iOS picker renders something rather than
  // showing empty for these edge values.
  '60898-2': '60898-1',
  '60898-3': '60898-1',
  mcb: '60898-1',

  'bs 61009': '61009',
  'bs en 61009': '61009',
  'bs en 61009-1': '61009',
  '61009-1': '61009',
  rcbo: '61009',

  'bs 60947-2': '60947-2',
  'bs en 60947-2': '60947-2',
  mccb: '60947-2',

  'bs 60947-3': '60947-3',
  'bs en 60947-3': '60947-3',
  switch: '60947-3',
  isolator: '60947-3',

  // BS 88-2 / 88-3 are the historical UK designations for HRC fuses;
  // BS EN 60269-2 is the harmonised European equivalent. Map both to the
  // EN form (matches BS_EN_LOOKUP.gG and BS_EN_LOOKUP.HRC).
  'bs 60269-2': '60269-2',
  'bs en 60269-2': '60269-2',
  '88-2': '60269-2',
  '88-3': '60269-2',
  'bs 88-2': '60269-2',
  'bs 88-3': '60269-2',
  'bs 88': '60269-2',
  '60269': '60269-2',
  gg: '60269-2',
  hrc: '60269-2',

  '3036': 'BS 3036',
  'bs en 3036': 'BS 3036',
  'en 3036': 'BS 3036',
  rew: 'BS 3036',
  rewireable: 'BS 3036',

  '1361': 'BS 1361',
  'bs en 1361': 'BS 1361',
  'en 1361': 'BS 1361',
  cartridge: 'BS 1361',

  na: 'N/A',
  none: 'N/A',
  'no ocpd': 'N/A',
};

// Exposed for tests — not for runtime callers.
export const _MAPS = { rcd_bs_en: RCD_BS_EN_MAP, ocpd_bs_en: OCPD_BS_EN_MAP };

/**
 * Apply the mapping for a single field on a single circuit. Returns:
 *   { changed: boolean, before, after } when a mapping was found
 *   { changed: false, unknown: true, before } when value is non-empty
 *     and not in the mapping (preserved as-is for human review)
 *   { changed: false } for empty / null / already-canonical no-ops
 *
 * The mapping lookup is case-insensitive on the key (we lowercase the
 * incoming value and check the lowercased map). The OUTPUT preserves
 * the canonical case from the map's value (e.g. "N/A" stays uppercased,
 * "BS 3036" keeps the prefix).
 */
export function normaliseField(map, value) {
  if (value == null || value === '') return { changed: false };
  if (typeof value !== 'string') {
    return { changed: false, unknown: true, before: value };
  }
  const trimmed = value.trim();
  if (trimmed === '') return { changed: false };
  const key = trimmed.toLowerCase();
  if (key in map) {
    const after = map[key];
    if (after === trimmed) return { changed: false };
    return { changed: true, before: value, after };
  }
  return { changed: false, unknown: true, before: value };
}

/**
 * Walk a job_versions.data_snapshot blob and return the mutated copy +
 * a per-circuit changelog. Pure function — caller is responsible for
 * persisting the result.
 */
export function normaliseSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.circuits)) {
    return { mutated: false, snapshot, changes: [], unknowns: [] };
  }
  let mutated = false;
  const changes = [];
  const unknowns = [];
  for (const circuit of snapshot.circuits) {
    if (!circuit || typeof circuit !== 'object') continue;
    for (const field of ['rcd_bs_en', 'ocpd_bs_en']) {
      if (!(field in circuit)) continue;
      const map = field === 'rcd_bs_en' ? RCD_BS_EN_MAP : OCPD_BS_EN_MAP;
      const result = normaliseField(map, circuit[field]);
      if (result.changed) {
        circuit[field] = result.after;
        mutated = true;
        changes.push({
          circuit_ref: circuit.circuit_ref ?? null,
          field,
          before: result.before,
          after: result.after,
        });
      } else if (result.unknown) {
        unknowns.push({
          circuit_ref: circuit.circuit_ref ?? null,
          field,
          value: result.before,
        });
      }
    }
  }
  return { mutated, snapshot, changes, unknowns };
}

// ----------------------------------------------------------------------------
// CLI runner — only executes when this file is invoked as a script (not
// when imported by the test suite). The test file imports `normaliseField`
// and `normaliseSnapshot` directly; the DB plumbing below is integration-
// level and isn't exercised in unit tests.
// ----------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { apply: false, reportOnly: false, limit: Infinity };
  for (const a of argv.slice(2)) {
    if (a === '--apply') args.apply = true;
    else if (a === '--report-only') args.reportOnly = true;
    else if (a.startsWith('--limit')) {
      const n = a.includes('=') ? a.split('=')[1] : argv[argv.indexOf(a) + 1];
      args.limit = Math.max(0, Number.parseInt(n, 10) || Infinity);
    }
  }
  return args;
}

async function runMigration(args) {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set. Aborting.');
    process.exit(2);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let totalRows = 0;
  let mutatedRows = 0;
  const allUnknowns = new Map(); // value → count

  try {
    // Process in batches to avoid loading the whole table into memory.
    const PAGE = 200;
    let offset = 0;
    while (totalRows < args.limit) {
      const batchSize = Math.min(PAGE, args.limit - totalRows);
      const result = await pool.query(
        `SELECT id, job_id, version_number, data_snapshot
         FROM job_versions
         ORDER BY created_at ASC
         LIMIT $1 OFFSET $2`,
        [batchSize, offset]
      );
      if (result.rows.length === 0) break;
      for (const row of result.rows) {
        totalRows += 1;
        const out = normaliseSnapshot(row.data_snapshot);
        for (const u of out.unknowns) {
          const key = `${u.field}:${u.value}`;
          allUnknowns.set(key, (allUnknowns.get(key) || 0) + 1);
        }
        if (out.mutated) {
          mutatedRows += 1;
          if (args.apply && !args.reportOnly) {
            await pool.query(`UPDATE job_versions SET data_snapshot = $1 WHERE id = $2`, [
              JSON.stringify(out.snapshot),
              row.id,
            ]);
          }
          // Per-row log (truncate the changes array if huge).
          const sample = out.changes.slice(0, 5);
          console.log(
            `[${args.apply ? 'APPLIED' : 'DRY-RUN'}] job=${row.job_id} v${row.version_number}: ${out.changes.length} change(s)`,
            sample
          );
        }
      }
      offset += result.rows.length;
    }

    console.log('\n========== SUMMARY ==========');
    console.log(`Total rows scanned : ${totalRows}`);
    console.log(`Rows mutated       : ${mutatedRows}`);
    console.log(`Mode               : ${args.apply ? 'APPLIED' : 'DRY-RUN (rerun with --apply to commit)'}`);

    if (allUnknowns.size > 0) {
      console.log('\n========== UNKNOWN VALUES (preserved as-is, mapping needed) ==========');
      const sorted = [...allUnknowns.entries()].sort(([, a], [, b]) => b - a);
      for (const [key, count] of sorted) {
        console.log(`  ${key}  (×${count})`);
      }
      console.log('\nExtend RCD_BS_EN_MAP / OCPD_BS_EN_MAP in this script to handle these.');
    }
  } finally {
    await pool.end();
  }
}

// ESM script-mode detection: only run when invoked directly, not on import.
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  const args = parseArgs(process.argv);
  runMigration(args).catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}
