/**
 * Plan 00C §C1 — canonical evidence events: schema validation, content-hash
 * naming and namespace enforcement. Reuses the field-replay primitives
 * (`canonicalBytes`, `evidenceEventHash`) — one crypto implementation.
 *
 * Validation precedence (plan §C1): schema and namespace are evaluated
 * BEFORE reservation/PENDING pairing, attempt-ref identity, referenced-
 * report integrity and manifest binding, and ALL of those before semantic
 * outcome. This module owns the first tier only; the fold owns the rest.
 */

import { canonicalBytes, evidenceEventHash } from '../../field-replay/lib/canonical-crypto.mjs';
import {
  DEREK_EVENT_KINDS,
  EVIDENCE_PREFIX,
  EVIDENCE_SCHEMA_VERSION,
  MACHINE_EVENT_KINDS,
  REQUIREMENT_CLASSES,
  STAGE_A_COHORT,
  STAGE_A_EVENT_KINDS,
  TERMINAL_VERDICTS,
} from './constants.mjs';

/** Per-kind required fields (beyond schema_version/kind/cohort_id). */
const KIND_REQUIRED_FIELDS = Object.freeze({
  stage_a_deployed: [
    'deploy_run',
    'runtime',
    'evidence_bucket',
    'evidence_bucket_versioning',
    'config_fingerprint',
    'tool_fingerprint',
    'prompt_fingerprint',
    'semantic_oracle_digest',
    'deployed_evidence_runtime_digest',
    'event_schema_hash',
  ],
  attempt_terminal: [
    'requirement_key',
    'attempt_ref',
    'attempt_generation',
    'requirement_class',
    'verdict',
    'model',
    'tier',
    'report_digest',
    'provider_call_ids',
    'generated_at',
  ],
  production_session_bound: ['field_session_id', 'start_manifest', 'completion_manifest'],
  cohort_blocked: ['reason'],
  expectations_attested: [
    'reviewer',
    'attested_at',
    'combined_sha256',
    'vendor_live_sha256',
    'deterministic_egress_sha256',
  ],
  manual_attestation: [
    'day',
    'field_session_ids',
    'field_context',
    'manual_heard_by',
    'heard_completed_during_session',
    'confirmation_ref',
    'confirmation_session_id',
    'attested_at',
    'manual_result',
  ],
  dialogue_hearing_attestation: [
    'field_session_id',
    'dialogue_delivery_ref',
    'manual_heard_by',
    'heard_completed_during_session',
    'manual_result',
    'attested_at',
  ],
  non_safety_decision: ['mismatch_id', 'decision', 'reviewer', 'decided_at'],
  corpus_gap_decision: ['stratum_or_fixture', 'decision', 'reviewer', 'decided_at'],
  cohort_initialized: ['cohort_fingerprint', 'stage_a_event_hash', 'expectations_event_hash'],
});

/** The stable hash of the event schema itself — bound into stage_a_deployed
 *  so a schema change is visible as deployment/cohort drift. */
export function eventSchemaHash() {
  return evidenceEventHash({
    schema_version: EVIDENCE_SCHEMA_VERSION,
    machine_kinds: MACHINE_EVENT_KINDS,
    derek_kinds: DEREK_EVENT_KINDS,
    verdicts: TERMINAL_VERDICTS,
    requirement_classes: REQUIREMENT_CLASSES,
    kind_required_fields: KIND_REQUIRED_FIELDS,
  });
}

/** The CLOSED attempt_report schema shared by the runner (producer) and
 *  the fold (verifier) — cycle-4: one validator, exact keys, exact
 *  mismatch shape; a report is REJECTED on any unknown key or malformed
 *  field so a contradictory/extra-field report can never advance. */
const REPORT_ALLOWED_KEYS = Object.freeze([
  'schema_version',
  'kind',
  'requirement_key',
  'attempt_generation',
  'verdict',
  'provider_call_ids',
  'mismatch',
]);
const MISMATCH_ALLOWED_KEYS = Object.freeze(['mismatch_id', 'safety_critical']);

export function validateAttemptReport(report) {
  const problems = [];
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return [{ code: 'report_not_object' }];
  }
  for (const key of Object.keys(report)) {
    if (!REPORT_ALLOWED_KEYS.includes(key)) problems.push({ code: 'report_extra_key', field: key });
  }
  if (report.schema_version !== 1) problems.push({ code: 'report_schema_version' });
  if (report.kind !== 'attempt_report') problems.push({ code: 'report_kind' });
  if (typeof report.requirement_key !== 'string' || !report.requirement_key.length) {
    problems.push({ code: 'report_requirement_key' });
  }
  if (!Number.isInteger(report.attempt_generation)) problems.push({ code: 'report_generation' });
  if (!TERMINAL_VERDICTS.includes(report.verdict)) problems.push({ code: 'report_verdict' });
  if (
    !Array.isArray(report.provider_call_ids) ||
    report.provider_call_ids.some((id) => typeof id !== 'string' || !id.length)
  ) {
    problems.push({ code: 'report_provider_ids' });
  }
  if (report.mismatch !== null && report.mismatch !== undefined) {
    const mm = report.mismatch;
    if (!mm || typeof mm !== 'object' || Array.isArray(mm)) {
      problems.push({ code: 'report_mismatch_shape' });
    } else {
      for (const key of Object.keys(mm)) {
        if (!MISMATCH_ALLOWED_KEYS.includes(key)) {
          problems.push({ code: 'report_mismatch_extra_key', field: key });
        }
      }
      if (typeof mm.mismatch_id !== 'string' || !mm.mismatch_id.length) {
        problems.push({ code: 'report_mismatch_id' });
      }
      if (typeof mm.safety_critical !== 'boolean') {
        problems.push({ code: 'report_mismatch_safety_flag' });
      }
    }
  }
  return problems;
}

/** Build a canonical event: payload + content hash + its authoritative key. */
export function buildEvent({ kind, cohortId, namespace, body }) {
  const payload = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    kind,
    cohort_id: cohortId,
    ...body,
  };
  const hash = evidenceEventHash(payload);
  return {
    payload,
    bytes: canonicalBytes(payload),
    content_hash: hash,
    key: `${EVIDENCE_PREFIX}/events/${cohortId}/${namespace}/${hash}.json`,
  };
}

/**
 * First-tier validation of one stored event object: schema shape, kind ↔
 * namespace, kind ↔ cohort, name ↔ content hash. Returns a list of
 * structural problems (empty = structurally valid at this tier).
 */
export function validateStoredEvent({ key, payload }) {
  const problems = [];
  const m = key.match(
    new RegExp(`^${EVIDENCE_PREFIX}/events/([^/]+)/(machine|derek)/([0-9a-f]{64})\\.json$`)
  );
  if (!m) {
    return [{ code: 'malformed_event_key', key }];
  }
  const [, cohortId, namespace, nameHash] = m;
  if (!payload || typeof payload !== 'object') {
    return [{ code: 'unparseable_event_payload', key }];
  }
  if (payload.schema_version !== EVIDENCE_SCHEMA_VERSION) {
    problems.push({ code: 'unknown_schema_version', key, got: payload.schema_version ?? null });
  }
  const kind = payload.kind;
  const allowlist = namespace === 'machine' ? MACHINE_EVENT_KINDS : DEREK_EVENT_KINDS;
  if (!allowlist.includes(kind)) {
    problems.push({ code: 'wrong_kind_for_namespace', key, kind: kind ?? null, namespace });
  }
  if (cohortId === STAGE_A_COHORT && !STAGE_A_EVENT_KINDS.includes(kind)) {
    problems.push({ code: 'wrong_kind_for_stage_a_cohort', key, kind: kind ?? null });
  }
  if (cohortId !== STAGE_A_COHORT && kind === 'stage_a_deployed') {
    problems.push({ code: 'stage_a_event_outside_stage_a_cohort', key });
  }
  if (payload.cohort_id !== cohortId) {
    problems.push({
      code: 'cohort_id_mismatch',
      key,
      payload_cohort: payload.cohort_id ?? null,
      key_cohort: cohortId,
    });
  }
  const required = KIND_REQUIRED_FIELDS[kind] ?? null;
  if (required) {
    for (const field of required) {
      if (payload[field] === undefined) {
        problems.push({ code: 'missing_required_field', key, kind, field });
      }
    }
  }
  if (kind === 'stage_a_deployed') {
    // Codex cycle-1 — the deployment cross-binding is only real when the
    // fingerprints EXIST: null placeholders cannot bind a cohort.
    for (const field of ['config_fingerprint', 'tool_fingerprint', 'prompt_fingerprint']) {
      if (typeof payload[field] !== 'string' || payload[field].length === 0) {
        problems.push({ code: 'stage_a_fingerprint_missing', key, field });
      }
    }
    if (
      typeof payload.runtime?.deployment_fingerprint !== 'string' ||
      payload.runtime.deployment_fingerprint.length === 0
    ) {
      problems.push({ code: 'stage_a_deployment_fingerprint_missing', key });
    }
  }
  if (kind === 'attempt_terminal' && !TERMINAL_VERDICTS.includes(payload.verdict)) {
    problems.push({ code: 'unknown_verdict', key, verdict: payload.verdict ?? null });
  }
  if (kind === 'attempt_terminal' && !REQUIREMENT_CLASSES.includes(payload.requirement_class)) {
    problems.push({
      code: 'unknown_requirement_class',
      key,
      requirement_class: payload.requirement_class ?? null,
    });
  }
  const recomputed = evidenceEventHash(payload);
  if (recomputed !== nameHash) {
    problems.push({ code: 'content_hash_name_mismatch', key, recomputed });
  }
  return problems;
}
