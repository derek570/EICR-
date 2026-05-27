#!/usr/bin/env node
/**
 * audit-redacted-job-addresses.js — Find jobs corrupted by the
 * 2026-05-27 logger-mutation bug, and report the recovery path.
 *
 * WHAT
 *   Between when the logger PII-redactor started mutating live caller
 *   data via the recursion in `redactPiiInPlace` and when commits
 *   5bf304ac (logger copy-on-write) + d5adb2e3 (route call-site
 *   cleanup) shipped, every GET /api/job/:userId/:jobId would
 *   overwrite the live `extractedData.installation_details` object's
 *   PII fields ('address', 'postcode', 'client_name', 'client_phone',
 *   'client_email') with the literal string '[REDACTED]'. The handler
 *   returned the mutated object to the client; the client's next PUT
 *   persisted the redacted payload to S3 (`extracted_data.json`) and
 *   the `jobs.address` / `jobs.folder_name` DB columns.
 *
 *   This script scans the `jobs` table for affected rows and, for
 *   each, looks up the most recent pre-corruption snapshot in
 *   `job_versions.data_snapshot`. `job_versions` is written BEFORE
 *   each PUT overwrites S3 (see routes/jobs.js:711), so for any job
 *   whose first corrupting PUT landed after the redactor regressed,
 *   exactly ONE pre-corruption version will exist with the real
 *   address. Subsequent versions will snapshot the redacted value.
 *
 * USAGE
 *   DATABASE_URL=... node scripts/audit-redacted-job-addresses.js
 *   DATABASE_URL=... node scripts/audit-redacted-job-addresses.js > redacted.json
 *
 * OUTPUT
 *   JSON on stdout, human summary on stderr. Schema:
 *     {
 *       generated_at: ISO8601,
 *       total_jobs_scanned: number,
 *       redacted_jobs: [
 *         {
 *           job_id, user_id, address, folder_name, client_name,
 *           updated_at,
 *           recovery: {
 *             source: "job_versions" | "none",
 *             version_id, version_number, version_created_at,
 *             recovered_address, recovered_postcode,
 *             recovered_client_name, recovered_client_phone,
 *             recovered_client_email
 *           }
 *         },
 *         ...
 *       ]
 *     }
 *
 * SAFETY
 *   Read-only — issues only SELECT queries. No UPDATEs, no S3 writes,
 *   no API calls. To actually restore an address after reviewing this
 *   output, either (a) PUT the recovered installation_details back via
 *   the normal API (the auto-version snapshot will preserve the
 *   redacted state for audit), or (b) UPDATE the jobs row + rewrite
 *   the S3 extracted_data.json by hand. The deliberate split is so a
 *   human eyeballs the recovered values before they're committed —
 *   addresses are user-facing legal-document data.
 */

import { Pool } from 'pg';
import process from 'node:process';

const REDACTED = '[REDACTED]';
const PII_KEYS = ['address', 'postcode', 'client_name', 'client_phone', 'client_email'];

function isRedacted(value) {
  return typeof value === 'string' && value === REDACTED;
}

async function findPreCorruptionVersion(pool, jobId) {
  // Walk versions newest-first; return the first one whose snapshot
  // installation_details.address is a real value (not redacted, not
  // null/empty). That's the latest snapshot taken BEFORE the first
  // corrupting PUT — auto-versions snapshot current S3 state before
  // overwrite, so the corrupt PUT's own snapshot will be the LAST
  // clean one.
  const result = await pool.query(
    `SELECT id, version_number, created_at, data_snapshot
     FROM job_versions
     WHERE job_id = $1
     ORDER BY version_number DESC`,
    [jobId]
  );
  for (const row of result.rows) {
    const installation = row.data_snapshot?.installation_details;
    if (!installation || typeof installation !== 'object') continue;
    const address = installation.address;
    if (!address || isRedacted(address)) continue;
    return {
      source: 'job_versions',
      version_id: row.id,
      version_number: row.version_number,
      version_created_at: row.created_at,
      recovered_address: installation.address ?? null,
      recovered_postcode: installation.postcode ?? null,
      recovered_client_name: installation.client_name ?? null,
      recovered_client_phone: installation.client_phone ?? null,
      recovered_client_email: installation.client_email ?? null,
    };
  }
  return { source: 'none' };
}

async function runAudit() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set. Aborting.');
    process.exit(2);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const affected = [];
  let totalScanned = 0;

  try {
    const PAGE = 200;
    let offset = 0;
    while (true) {
      const result = await pool.query(
        `SELECT id, user_id, address, folder_name, client_name, updated_at
         FROM jobs
         ORDER BY COALESCE(updated_at, created_at::TIMESTAMP) DESC
         LIMIT $1 OFFSET $2`,
        [PAGE, offset]
      );
      if (result.rows.length === 0) break;

      for (const row of result.rows) {
        totalScanned += 1;
        const corrupted =
          isRedacted(row.address) ||
          isRedacted(row.folder_name) ||
          isRedacted(row.client_name);
        if (!corrupted) continue;

        const recovery = await findPreCorruptionVersion(pool, row.id);
        affected.push({
          job_id: row.id,
          user_id: row.user_id,
          address: row.address,
          folder_name: row.folder_name,
          client_name: row.client_name,
          updated_at: row.updated_at,
          recovery,
        });
      }

      offset += result.rows.length;
    }

    const summary = {
      generated_at: new Date().toISOString(),
      total_jobs_scanned: totalScanned,
      redacted_jobs: affected,
    };

    console.error('\n========== REDACTED ADDRESS AUDIT ==========');
    console.error(`Total jobs scanned          : ${totalScanned}`);
    console.error(`Redacted jobs found         : ${affected.length}`);
    const recoverable = affected.filter((j) => j.recovery.source === 'job_versions').length;
    console.error(`Recoverable from job_versions: ${recoverable}`);
    console.error(`Unrecoverable               : ${affected.length - recoverable}`);
    if (affected.length > 0) {
      console.error('\nAffected jobs (first 20):');
      for (const job of affected.slice(0, 20)) {
        const rec = job.recovery.source === 'job_versions'
          ? `→ "${job.recovery.recovered_address}" (v${job.recovery.version_number}, ${job.recovery.version_created_at})`
          : '→ NO PRE-CORRUPTION VERSION FOUND';
        console.error(`  ${job.job_id} (${job.user_id}) ${rec}`);
      }
    }
    console.error('============================================\n');

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

export { isRedacted, findPreCorruptionVersion, PII_KEYS };
