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

/** Closed START-manifest key set — completion/actual-execution keys must be
 *  ABSENT (never null); their PRESENCE rejects (Codex cycle-1). */
const START_ALLOWED_KEYS = new Set([
  'schema_version',
  'manifest_kind',
  'session_id',
  'boundary',
  'started_at',
  'deployment',
]);
const COMPLETION_FORBIDDEN_IN_START = [
  'completed_at',
  'status',
  'evidence',
  'round_usage',
];

function parseableInstant(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validateStartManifest(payload) {
  const problems = [];
  if (payload.schema_version !== 1) problems.push({ code: 'start_schema_version_unknown' });
  if (payload.boundary !== 'session_started') problems.push({ code: 'start_boundary_invalid' });
  for (const key of Object.keys(payload)) {
    if (!START_ALLOWED_KEYS.has(key)) {
      problems.push({ code: 'start_manifest_extra_key', field: key });
    }
  }
  for (const key of COMPLETION_FORBIDDEN_IN_START) {
    if (key in payload) problems.push({ code: 'start_manifest_completion_field_present', field: key });
  }
  if (!parseableInstant(payload.started_at)) problems.push({ code: 'start_started_at_unparseable' });
  return problems;
}

function validateCompletionManifest(payload) {
  const problems = [];
  if (payload.schema_version !== 1) problems.push({ code: 'completion_schema_version_unknown' });
  if (!parseableInstant(payload.completed_at)) problems.push({ code: 'completion_completed_at_unparseable' });
  if (!payload.status || typeof payload.status !== 'object') {
    problems.push({ code: 'completion_missing_status' });
  }
  const ev = payload.evidence;
  if (!ev || typeof ev !== 'object' || ev.projection !== 'evidence_projection_v1') {
    problems.push({ code: 'completion_evidence_projection_missing' });
  } else {
    if (ev.session_id !== payload.session_id) problems.push({ code: 'completion_evidence_session_mismatch' });
    if (ev.boundary !== payload.boundary) problems.push({ code: 'completion_evidence_boundary_mismatch' });
  }
  return problems;
}

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
  let startContentHash = null;
  let completionContentHash = null;

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
      problems.push(...validateStartManifest(payload).map((pb) => ({ ...pb, key: rec.key })));
      start = payload;
      startContentHash = nameHash;
    } else {
      if (completion) {
        problems.push({ code: 'duplicate_completion_manifest', key: rec.key });
        continue;
      }
      problems.push(...validateCompletionManifest(payload).map((pb) => ({ ...pb, key: rec.key })));
      completion = payload;
      completionContentHash = nameHash;
      completionPublishedAt = rec.published_at;
    }
  }

  if (!start) problems.push({ code: 'start_manifest_missing' });
  if (!completion) problems.push({ code: 'completion_manifest_missing' });

  if (start && completion) {
    // Task-rollover / identity drift: start and completion must agree on
    // the WHOLE deployment section (identity + every fingerprint) —
    // disagreement makes the session invalid (mini-review widened this
    // from identity-only).
    const a = JSON.stringify(start.deployment ?? null);
    const b = JSON.stringify(completion.deployment ?? null);
    if (a !== b) problems.push({ code: 'start_completion_identity_disagreement' });
    if (start.deployment?.identity == null || completion.deployment?.identity == null) {
      problems.push({ code: 'deployment_identity_missing' });
    }
    if (start.deployment?.fingerprint !== deploymentFingerprint) {
      problems.push({ code: 'deployment_fingerprint_mismatch' });
    }
    if (completion.deployment?.fingerprint !== deploymentFingerprint) {
      problems.push({ code: 'completion_fingerprint_mismatch' });
    }
    const startAt = Date.parse(start.started_at ?? '');
    const completedAt = Date.parse(completion.completed_at ?? '');
    if (!Number.isFinite(startAt) || !Number.isFinite(completedAt) || completedAt < startAt) {
      problems.push({ code: 'completion_before_start' });
    }
  }

  return {
    start,
    completion,
    published_at: completionPublishedAt,
    start_content_hash: startContentHash,
    completion_content_hash: completionContentHash,
    problems,
  };
}
