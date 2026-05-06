#!/usr/bin/env node
/**
 * audit-bs-en-values.js — Read-only pre-flight audit for the
 * 2026-05-06 BS-EN alignment sprint (Option B — prefixed canonical).
 *
 * WHAT
 *   Walks every row in `job_versions.data_snapshot` and reports the
 *   distribution of `ocpd_bs_en` and `rcd_bs_en` values currently in
 *   production. Output is purely diagnostic — no UPDATEs, no writes.
 *
 *   Used to size the migration window (`scripts/normalise-bs-en-values.js`)
 *   and surface unknown values that the mapping table doesn't cover, so
 *   the mapping table can be extended BEFORE the --apply run.
 *
 * USAGE
 *   DATABASE_URL=... node scripts/audit-bs-en-values.js
 *   DATABASE_URL=... node scripts/audit-bs-en-values.js > audit.json
 *
 * OUTPUT
 *   Single JSON object on stdout (so it can be redirected straight to a
 *   file). Counts on stderr for human reading. Schema:
 *
 *     {
 *       generated_at: "2026-05-06T...",
 *       total_rows_scanned: number,
 *       rows_with_ocpd_bs_en: number,
 *       rows_with_rcd_bs_en: number,
 *       ocpd_distribution: { "<value>": count, ... },
 *       rcd_distribution:  { "<value>": count, ... },
 *       unknown_ocpd_values: [ "<value>", ... ],   // top 20
 *       unknown_rcd_values:  [ "<value>", ... ],   // top 20
 *       rows_per_user_with_bs_en: { "<user-uuid>": count, ... }
 *     }
 *
 * SAFETY
 *   The only SQL the script issues is SELECT (verified by inspection
 *   below — no UPDATE / DELETE / INSERT calls anywhere). Each row is
 *   processed in memory; no transactions are opened.
 */

import { Pool } from 'pg';
import process from 'node:process';
import { _MAPS } from './normalise-bs-en-values.js';

// Pull the canonical option lists from the migration mapping table —
// values in the maps that already match the canonical (e.g. 'BS EN 60898')
// are the "known" set; everything else needing migration counts as
// "non-canonical but mapped" or "unknown".
const KNOWN_OCPD_TARGETS = new Set(Object.values(_MAPS.ocpd_bs_en));
const KNOWN_RCD_TARGETS = new Set(Object.values(_MAPS.rcd_bs_en));

function classifyValue(map, value) {
  if (value == null || value === '') return 'empty';
  if (typeof value !== 'string') return 'non_string';
  const trimmed = value.trim();
  if (trimmed === '') return 'empty';
  const knownTargets = map === _MAPS.ocpd_bs_en ? KNOWN_OCPD_TARGETS : KNOWN_RCD_TARGETS;
  if (knownTargets.has(trimmed)) return 'canonical';
  if (trimmed.toLowerCase() in map) return 'mappable';
  return 'unknown';
}

async function runAudit() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set. Aborting.');
    process.exit(2);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const ocpdDist = new Map();
  const rcdDist = new Map();
  const unknownOcpd = new Map();
  const unknownRcd = new Map();
  const rowsPerUser = new Map();
  let totalRowsScanned = 0;
  let rowsWithOcpd = 0;
  let rowsWithRcd = 0;

  try {
    const PAGE = 200;
    let offset = 0;
    while (true) {
      const result = await pool.query(
        `SELECT j.id AS job_id, j.user_id, jv.data_snapshot
         FROM job_versions jv
         JOIN jobs j ON j.id = jv.job_id
         ORDER BY jv.created_at ASC
         LIMIT $1 OFFSET $2`,
        [PAGE, offset]
      );
      if (result.rows.length === 0) break;

      for (const row of result.rows) {
        totalRowsScanned += 1;
        const snapshot = row.data_snapshot;
        if (!snapshot || !Array.isArray(snapshot.circuits)) continue;

        let rowHasOcpd = false;
        let rowHasRcd = false;

        for (const circuit of snapshot.circuits) {
          if (!circuit || typeof circuit !== 'object') continue;

          if ('ocpd_bs_en' in circuit) {
            const v = circuit.ocpd_bs_en;
            if (v != null && v !== '') {
              rowHasOcpd = true;
              const key = String(v);
              ocpdDist.set(key, (ocpdDist.get(key) || 0) + 1);
              if (classifyValue(_MAPS.ocpd_bs_en, v) === 'unknown') {
                unknownOcpd.set(key, (unknownOcpd.get(key) || 0) + 1);
              }
            }
          }

          if ('rcd_bs_en' in circuit) {
            const v = circuit.rcd_bs_en;
            if (v != null && v !== '') {
              rowHasRcd = true;
              const key = String(v);
              rcdDist.set(key, (rcdDist.get(key) || 0) + 1);
              if (classifyValue(_MAPS.rcd_bs_en, v) === 'unknown') {
                unknownRcd.set(key, (unknownRcd.get(key) || 0) + 1);
              }
            }
          }
        }

        if (rowHasOcpd) rowsWithOcpd += 1;
        if (rowHasRcd) rowsWithRcd += 1;
        if ((rowHasOcpd || rowHasRcd) && row.user_id) {
          const u = String(row.user_id);
          rowsPerUser.set(u, (rowsPerUser.get(u) || 0) + 1);
        }
      }

      offset += result.rows.length;
    }

    const sortedDist = (m) =>
      Object.fromEntries([...m.entries()].sort(([, a], [, b]) => b - a));
    const topUnknowns = (m, n) =>
      [...m.entries()]
        .sort(([, a], [, b]) => b - a)
        .slice(0, n)
        .map(([key]) => key);

    const summary = {
      generated_at: new Date().toISOString(),
      total_rows_scanned: totalRowsScanned,
      rows_with_ocpd_bs_en: rowsWithOcpd,
      rows_with_rcd_bs_en: rowsWithRcd,
      ocpd_distribution: sortedDist(ocpdDist),
      rcd_distribution: sortedDist(rcdDist),
      unknown_ocpd_values: topUnknowns(unknownOcpd, 20),
      unknown_rcd_values: topUnknowns(unknownRcd, 20),
      rows_per_user_with_bs_en: sortedDist(rowsPerUser),
    };

    // Human-readable summary on stderr; machine-readable JSON on stdout.
    console.error('\n========== BS-EN AUDIT SUMMARY ==========');
    console.error(`Total job_versions scanned : ${totalRowsScanned}`);
    console.error(`Rows with ocpd_bs_en       : ${rowsWithOcpd}`);
    console.error(`Rows with rcd_bs_en        : ${rowsWithRcd}`);
    console.error('\nTop ocpd_bs_en values:');
    for (const [k, n] of Object.entries(summary.ocpd_distribution).slice(0, 15)) {
      console.error(`  ${k.padEnd(20)} ×${n}`);
    }
    console.error('\nTop rcd_bs_en values:');
    for (const [k, n] of Object.entries(summary.rcd_distribution).slice(0, 15)) {
      console.error(`  ${k.padEnd(20)} ×${n}`);
    }
    if (summary.unknown_ocpd_values.length > 0) {
      console.error(
        `\nUnknown ocpd values (extend OCPD_BS_EN_MAP if non-trivial): ${summary.unknown_ocpd_values.join(', ')}`
      );
    }
    if (summary.unknown_rcd_values.length > 0) {
      console.error(
        `\nUnknown rcd values (extend RCD_BS_EN_MAP if non-trivial): ${summary.unknown_rcd_values.join(', ')}`
      );
    }
    console.error(`\nRows-per-user (top 5): ${Object.entries(summary.rows_per_user_with_bs_en).slice(0, 5).map(([u, n]) => `${u}:${n}`).join(', ')}`);
    console.error('=========================================\n');

    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } finally {
    await pool.end();
  }
}

const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  runAudit().catch((err) => {
    console.error('Audit failed:', err);
    process.exit(1);
  });
}
