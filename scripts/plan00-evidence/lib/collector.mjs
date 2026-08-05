/**
 * Plan 00C §C3 (operator half) — the session-manifest collector.
 *
 * The operator supplies session ids ONLY. The collector enumerates every
 * object version/delete marker in the exact session prefix (operator
 * credentials own the full version audit the deployed task role cannot
 * perform), rejects missing pairs, conflicting versions, overwrites,
 * delete markers or hash mismatches, accepts ONLY these server-authored
 * objects — never CloudWatch text, client summaries or mutable
 * cost_summary.json — and validates completion/fingerprint/timestamps.
 */

import { MANIFEST_PREFIX } from './constants.mjs';
import { loadAuditedPrefix, sha256Hex } from './store.mjs';

const KEY_RE = new RegExp(
  `^${MANIFEST_PREFIX}/([^/]+)/([^/]+)/(start|completion)-([0-9a-f]{64})\\.json$`
);

/**
 * Load + validate ONE session's manifest pair under a deployment
 * fingerprint prefix. Returns {start, completion, published_at, problems}.
 * `published_at` is the COMPLETION manifest's earliest valid receipt.
 */
export async function collectSessionManifests(store, { deploymentFingerprint, sessionId }) {
  const prefix = `${MANIFEST_PREFIX}/${deploymentFingerprint}/${sessionId}/`;
  const { records, holds } = await loadAuditedPrefix(store, prefix);
  const problems = holds.map((h) => ({ code: h.code, key: h.key ?? null }));
  let start = null;
  let completion = null;
  let completionPublishedAt = null;

  for (const rec of records) {
    const m = rec.key.match(KEY_RE);
    if (!m) {
      problems.push({ code: 'malformed_manifest_key', key: rec.key });
      continue;
    }
    const [, fp, sid, kind, nameHash] = m;
    if (fp !== deploymentFingerprint || sid !== sessionId) {
      problems.push({ code: 'manifest_prefix_mismatch', key: rec.key });
      continue;
    }
    if (sha256Hex(rec.bytes) !== nameHash) {
      problems.push({ code: 'manifest_content_hash_mismatch', key: rec.key });
      continue;
    }
    const payload = rec.payload;
    if (payload?.manifest_kind !== kind || payload?.session_id !== sessionId) {
      problems.push({ code: 'manifest_payload_identity_mismatch', key: rec.key });
      continue;
    }
    if (kind === 'start') {
      if (start) {
        problems.push({ code: 'duplicate_start_manifest', key: rec.key });
        continue;
      }
      start = payload;
    } else {
      if (completion) {
        problems.push({ code: 'duplicate_completion_manifest', key: rec.key });
        continue;
      }
      completion = payload;
      completionPublishedAt = rec.published_at;
    }
  }

  if (!start) problems.push({ code: 'start_manifest_missing' });
  if (!completion) problems.push({ code: 'completion_manifest_missing' });

  if (start && completion) {
    // Task-rollover / identity drift: start and completion must agree on
    // the FULL deployment identity — disagreement makes the session invalid.
    const a = JSON.stringify(start.deployment?.identity ?? null);
    const b = JSON.stringify(completion.deployment?.identity ?? null);
    if (a !== b) problems.push({ code: 'start_completion_identity_disagreement' });
    if (start.deployment?.identity == null || completion.deployment?.identity == null) {
      problems.push({ code: 'deployment_identity_missing' });
    }
    if (start.deployment?.fingerprint !== deploymentFingerprint) {
      problems.push({ code: 'deployment_fingerprint_mismatch' });
    }
    if (
      start.started_at != null &&
      completion.completed_at != null &&
      Date.parse(completion.completed_at) < Date.parse(start.started_at)
    ) {
      problems.push({ code: 'completion_before_start' });
    }
  }

  return { start, completion, published_at: completionPublishedAt, problems };
}
