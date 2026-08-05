/**
 * Plan 00C §C1/C2/C4/C5 — the Stage-A evidence-layer verification matrix.
 *
 * Runs hermetically against the committed in-memory versioned-S3 fake
 * (full version/delete-marker/conditional-create semantics). Groups:
 *   A. canonical events, append-only publish, bucket-versioning refusal
 *   B. version-audited fold reader (delete markers, divergence, shuffle,
 *      Europe/London day membership incl. midnight straddling)
 *   C. conditional-create reservations (crash boundaries, lost-200 412
 *      recovery, different-ref winners, 409 same-key retry, no lock-only
 *      attempt state)
 *   D. fold pairing + identity (orphans, conflicts, INVALID replacement,
 *      provider-id/sample-id single-use, validation precedence)
 *   E. semantic classification (safety FAIL blocks, non-safety mismatch
 *      holds until a Derek decision, wrong-key safety FAIL stays HOLD)
 *   F. manual + dialogue-hearing attestation matrices
 *   G. per-day gates (IR ordinals, corpus runs, Luna-Fast/Terra/cache
 *      counting rules, family gates) and the deterministic 0/3 → DONE walk
 *   H. lifecycle states, BLOCKED dominance, STALE_DEPLOYMENT
 *   I. collector pair audit + trusted-deploy verification + role proofs
 */

import { describe, test, expect } from '@jest/globals';
import { createHash } from 'node:crypto';

import { createMemoryStore } from '../../scripts/plan00-evidence/lib/memory-store.mjs';
import {
  EVIDENCE_PREFIX,
  MANIFEST_PREFIX,
  STAGE_A_COHORT,
  londonDayOf,
} from '../../scripts/plan00-evidence/lib/constants.mjs';
import {
  buildEvent,
  eventSchemaHash,
  validateStoredEvent,
} from '../../scripts/plan00-evidence/lib/events.mjs';
import {
  assertBucketVersioned,
  loadAuditedPrefix,
  publishDurable,
} from '../../scripts/plan00-evidence/lib/store.mjs';
import {
  allocateOrdinal,
  buildAttemptCandidate,
  buildOrdinalCandidate,
  reserveAttempt,
} from '../../scripts/plan00-evidence/lib/reservations.mjs';
import { foldEvidence } from '../../scripts/plan00-evidence/lib/fold.mjs';
import { computeFold } from '../../scripts/plan00-evidence/lib/fold-runner.mjs';
import { collectSessionManifests } from '../../scripts/plan00-evidence/lib/collector.mjs';
import {
  proveTaskRolePrefixAccessViaIam,
  verifyTrustedDeploy,
} from '../../scripts/plan00-evidence/lib/deployment.mjs';
import { computeCohortFingerprint } from '../../scripts/plan00-evidence/cli.mjs';
import {
  canonicalBytes,
  evidenceEventHash,
} from '../../scripts/field-replay/lib/canonical-crypto.mjs';

const COHORT = 'cohort-test0000000001';
const FP = 'f'.repeat(64);

const EXPECTATION_MANIFEST = {
  combined_sha256: '1a'.repeat(32),
  vendor_live_expectations: { fixture_ids: ['fx1', 'fx2'], sha256: '2b'.repeat(32) },
  deterministic_egress_expectations: { sha256: '3c'.repeat(32) },
  semantic_oracle_digest: 'oracle-digest',
};
const TEST_DIGESTS = { promptDigest: 'pd', toolDigest: 'td', expectationDigest: '2b'.repeat(32) };
const LIVE_OK = { available: true, fingerprint_matches: true };

// ── shared builders ──────────────────────────────────────────────────────

let clockMs = Date.parse('2026-08-10T09:00:00Z');
function tickClock(store, iso) {
  clockMs = iso ? Date.parse(iso) : clockMs + 1000;
  store._setNow(() => new Date(clockMs).toISOString());
}

async function publishEventAt(store, { kind, cohortId, namespace, body, at }) {
  if (at) tickClock(store, at);
  const event = buildEvent({ kind, cohortId, namespace, body });
  const receipt = await publishDurable(store, { key: event.key, bytes: event.bytes });
  if (!receipt.ok) throw new Error(`test publish failed: ${receipt.error}`);
  return { event, receipt };
}

const ordinalCache = new WeakMap(); // store → Map('lane:ordinal' → versionId)
async function ensureOrdinal(store, { cohortId, lane, ordinal }) {
  if (!ordinalCache.has(store)) ordinalCache.set(store, new Map());
  const cache = ordinalCache.get(store);
  const cacheKey = `${cohortId}:${lane}:${ordinal}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const candidate = buildOrdinalCandidate({ cohortId, lane, ordinal });
  const res = await allocateOrdinal(store, candidate);
  if (!res.allocated) throw new Error(`test ordinal allocation failed: ${JSON.stringify(res)}`);
  cache.set(cacheKey, res.versionId);
  return res.versionId;
}

function stageABody(overrides = {}) {
  return {
    deploy_run: { run_id: '1', head_sha: 'a'.repeat(40), repository: 'derek570/EICR-' },
    runtime: {
      image_digest: 'sha256:img',
      task_def_arn: 'arn:task/377',
      task_family: 'eicr-backend',
      task_revision: '377',
      deployment_fingerprint: FP,
    },
    evidence_bucket: 'test-bucket',
    evidence_bucket_versioning: 'Enabled',
    config_fingerprint: 'cfg',
    tool_fingerprint: 'tool',
    prompt_fingerprint: 'prompt',
    semantic_oracle_digest: 'oracle-digest',
    deployed_evidence_runtime_digest: 'sha256:img',
    event_schema_hash: eventSchemaHash(),
    ...overrides,
  };
}

async function establishCohort(store, { at = '2026-08-09T08:00:00Z' } = {}) {
  const { event: stageA } = await publishEventAt(store, {
    kind: 'stage_a_deployed',
    cohortId: STAGE_A_COHORT,
    namespace: 'machine',
    body: stageABody(),
    at,
  });
  const { cohortId } = computeCohortFingerprint({
    stageAPayload: stageA.payload,
    combinedSha256: EXPECTATION_MANIFEST.combined_sha256,
    vendorLiveSha256: EXPECTATION_MANIFEST.vendor_live_expectations.sha256,
    deterministicEgressSha256: EXPECTATION_MANIFEST.deterministic_egress_expectations.sha256,
  });
  const { event: attested } = await publishEventAt(store, {
    kind: 'expectations_attested',
    cohortId,
    namespace: 'derek',
    body: {
      reviewer: 'Derek',
      attested_at: new Date(clockMs - 500).toISOString(),
      combined_sha256: EXPECTATION_MANIFEST.combined_sha256,
      vendor_live_sha256: EXPECTATION_MANIFEST.vendor_live_expectations.sha256,
      deterministic_egress_sha256: EXPECTATION_MANIFEST.deterministic_egress_expectations.sha256,
    },
  });
  const { fingerprint } = computeCohortFingerprint({
    stageAPayload: stageA.payload,
    combinedSha256: EXPECTATION_MANIFEST.combined_sha256,
    vendorLiveSha256: EXPECTATION_MANIFEST.vendor_live_expectations.sha256,
    deterministicEgressSha256: EXPECTATION_MANIFEST.deterministic_egress_expectations.sha256,
  });
  await publishEventAt(store, {
    kind: 'cohort_initialized',
    cohortId,
    namespace: 'derek',
    body: {
      cohort_fingerprint: fingerprint,
      stage_a_event_hash: evidenceEventHash(stageA.payload),
      expectations_event_hash: evidenceEventHash(attested.payload),
    },
  });
  return { cohortId, stageA, attested };
}

/** Write an atomic PENDING + its terminal, the runner way. */
async function publishAttempt(
  store,
  {
    cohortId,
    requirementKey,
    generation = 1,
    requirementClass = 'pinned_ir',
    verdict = 'PASS',
    model = 'gpt-5.6-luna',
    tier = 'fast',
    providerIds,
    repetitionOrdinal,
    corpusRunOrdinal,
    fixtureId,
    modelLane,
    mismatch,
    generatedAt,
    at,
    terminalAt,
    skipTerminal = false,
    attemptRefOverride,
  }
) {
  if (at) tickClock(store, at);
  // Ordinal-bound classes allocate their audited logical ordinal first and
  // echo its VersionId through PENDING and terminal (fold-verified).
  let allocationVersionId = null;
  if (
    (requirementClass === 'pinned_ir' && repetitionOrdinal != null) ||
    (requirementClass === 'vendor_corpus' && corpusRunOrdinal != null)
  ) {
    const lane = requirementClass === 'pinned_ir' ? 'ir-repetition' : `corpus-run-${modelLane}`;
    allocationVersionId = await ensureOrdinal(store, {
      cohortId,
      lane,
      ordinal: repetitionOrdinal ?? corpusRunOrdinal,
    });
  }
  const candidate = buildAttemptCandidate({
    cohortId,
    requirementKey,
    generation,
    requirement: {
      requirementClass,
      model,
      tier,
      allocationVersionId,
      ...TEST_DIGESTS,
    },
  });
  const res = await reserveAttempt(store, candidate, { dispatchLatch: { begun: false } });
  if (!res.authorised) throw new Error(`test reservation failed: ${JSON.stringify(res)}`);
  if (skipTerminal) return { candidate };
  if (terminalAt) tickClock(store, terminalAt);
  // Content-addressed report published BEFORE the terminal (fold-audited;
  // the fold cross-checks verdict/ids/requirement against it).
  const resolvedProviderIds =
    providerIds ?? (verdict === 'INVALID' ? [] : [`prov_${requirementKey}_${generation}`]);
  let reportDigest = null;
  if (verdict !== 'INVALID') {
    const reportBody = {
      schema_version: 1,
      kind: 'attempt_report',
      requirement_key: requirementKey,
      attempt_generation: generation,
      verdict,
      provider_call_ids: resolvedProviderIds,
      mismatch: mismatch ?? null,
    };
    reportDigest = evidenceEventHash(reportBody);
    const rr = await publishDurable(store, {
      key: `${EVIDENCE_PREFIX}/reports/${cohortId}/${reportDigest}.json`,
      bytes: canonicalBytes(reportBody),
    });
    if (!rr.ok) throw new Error(`test report publish failed: ${rr.error}`);
  }
  const sampleIdentity =
    verdict === 'INVALID'
      ? null
      : evidenceEventHash({
          provider_call_ids: resolvedProviderIds,
          deployment_fingerprint: FP,
          requirement_key: requirementKey,
          model,
          tier,
          prompt_digest: TEST_DIGESTS.promptDigest,
          tool_digest: TEST_DIGESTS.toolDigest,
          expectation_digest: TEST_DIGESTS.expectationDigest,
        });
  const body = {
    requirement_key: requirementKey,
    attempt_ref: attemptRefOverride ?? candidate.attemptRef,
    attempt_generation: generation,
    requirement_class: requirementClass,
    verdict,
    model,
    tier,
    allocation_version_id: allocationVersionId,
    prompt_digest: TEST_DIGESTS.promptDigest,
    tool_digest: TEST_DIGESTS.toolDigest,
    expectation_digest: TEST_DIGESTS.expectationDigest,
    report_digest: reportDigest,
    provider_call_ids: resolvedProviderIds,
    sample_identity: sampleIdentity,
    generated_at: generatedAt ?? new Date(clockMs - 100).toISOString(),
    ...(repetitionOrdinal != null ? { repetition_ordinal: repetitionOrdinal } : {}),
    ...(corpusRunOrdinal != null ? { corpus_run_ordinal: corpusRunOrdinal } : {}),
    ...(fixtureId != null ? { fixture_id: fixtureId } : {}),
    ...(modelLane != null ? { model_lane: modelLane } : {}),
    ...(mismatch != null ? { mismatch } : {}),
  };
  const { event } = await publishEventAt(store, {
    kind: 'attempt_terminal',
    cohortId,
    namespace: 'machine',
    body,
  });
  return { candidate, terminal: event };
}

function inspectorRound(overrides = {}) {
  return {
    provider: 'openai',
    api_transport: 'responses',
    requested_model: 'gpt-5.6-luna',
    requested_tier: 'fast',
    response_model: 'gpt-5.6-luna',
    response_tier: 'fast',
    billing_model: 'gpt-5.6-luna',
    billing_tier: 'fast',
    model_provenance: 'returned',
    tier_provenance: 'returned',
    attribution_status: 'attributed',
    reasoning_effort: 'none',
    prompt_cache_mode: 'explicit',
    prompt_cache_breakpoint_enabled: true,
    prompt_cache_key_id: 'pck',
    fresh_input_tokens: 100,
    cache_read_input_tokens: 5000,
    cache_write_input_tokens: 0,
    output_tokens: 50,
    round_idx: 0,
    billable_kind: 'inspector_live',
    loop_invocation_id: 'loop_1',
    ...overrides,
  };
}

function terraRound(overrides = {}) {
  return inspectorRound({
    requested_model: 'gpt-5.6-terra',
    response_model: 'gpt-5.6-terra',
    billing_model: 'gpt-5.6-terra',
    requested_tier: 'standard',
    response_tier: 'standard',
    billing_tier: 'standard',
    reasoning_effort: 'low',
    prompt_cache_mode: null,
    cache_read_input_tokens: 0,
    ...overrides,
  });
}

const MANUAL_OP = '{"turn":"t1","field":"measured_zs_ohm","circuit":4,"board_id":null,"ordinal":0}';
const DIALOGUE_OP = '{"turn":"t2","field":"r1_r2_ohm","circuit":7,"board_id":null,"ordinal":0}';
const MIRROR_OP =
  '{"turn":"t3","field":"client_address","circuit":null,"board_id":null,"ordinal":0}';

/** A fully-eligible completion manifest satisfying EVERY per-day gate. */
function eligibleCompletion({ sessionId, completedAt, overrides = {} }) {
  const base = {
    schema_version: 1,
    manifest_kind: 'completion',
    session_id: sessionId,
    boundary: 'session_stopped',
    completed_at: completedAt,
    status: { non_quiescent_at_stop: 0, revision_instability: 0, eligible_for_family_credit: true },
    deployment: {
      identity: {
        task_arn: 'arn:t',
        task_family: 'eicr-backend',
        task_revision: '377',
        image_id: 'sha256:img',
      },
      identity_unavailable_reason: null,
      fingerprint: FP,
      prompt_fingerprint: 'prompt',
      tool_fingerprint: 'tool',
      config_fingerprint: 'cfg',
    },
    evidence: {
      projection: 'evidence_projection_v1',
      session_id: sessionId,
      boundary: 'session_stopped',
      quiescence: { non_quiescent_at_stop: 0, revision_instability: 0 },
      open_asks: { dispatcher: 0, dialogue_script: 0, address_mirror: 0 },
      ineligible_conditions: [],
      unknown_producers: [],
      eligible_for_family_credit: true,
      ask_families: {},
      deliveries: {
        ordinary_confirmation: [
          {
            seq: 1,
            delivery_ref: 'd:1',
            at_seq: 1,
            producer_id: 'result_frame_confirmation',
            transport: 'ws_extraction',
            delivery_kind: 'confirmation',
            op_keys: [MANUAL_OP],
            claim_lineage: null,
            wire_turn_id: 't1',
            dedupe_token: null,
            correlation_id: null,
            delivery_claim_token: null,
          },
        ],
        dialogue_script: [
          {
            seq: 2,
            delivery_ref: 'd:2',
            at_seq: 2,
            producer_id: 'dialogue_confirmation',
            transport: 'dialogue_ws',
            delivery_kind: 'dialogue_confirmation',
            op_keys: [DIALOGUE_OP],
            claim_lineage: null,
            wire_turn_id: null,
            dedupe_token: null,
            correlation_id: null,
            delivery_claim_token: null,
          },
        ],
        address_mirror: [
          {
            seq: 3,
            delivery_ref: 'd:3',
            at_seq: 3,
            producer_id: 'address_mirror_terminal',
            transport: 'ws_vcr',
            delivery_kind: 'address_mirror_terminal',
            op_keys: [MIRROR_OP],
            claim_lineage: 'result:tok',
            wire_turn_id: null,
            dedupe_token: null,
            correlation_id: null,
            delivery_claim_token: 'clm',
          },
        ],
        fast_tts: [],
      },
      delivery_history_ambiguous_op_keys: [],
      rejected_deliveries: [],
      playbacks: {
        ordinary_confirmation: [
          {
            seq: 4,
            op_key: MANUAL_OP,
            ack_body_hash: '1'.repeat(64),
            source: 'ordinary',
            producer_id: 'playback_ack_slot',
            transport: 'http_playback_ack',
          },
        ],
        dialogue_script: [],
        address_mirror: [
          {
            seq: 5,
            op_key: MIRROR_OP,
            ack_body_hash: '2'.repeat(64),
            source: 'address_mirror_delivery_ack',
            producer_id: 'address_mirror_delivery_ack',
            transport: 'ws_ack',
          },
        ],
        fast_tts: [],
      },
      idempotent_playbacks: [],
      rejected_playbacks: [],
      round_usage: {
        rounds: [inspectorRound(), terraRound()],
        loop_invocations: 2,
        completed_rounds: 2,
        usage_revision: 4,
      },
      family_gates: {
        dialogue_script: { ask_lifecycle_complete: true, operation_bound_delivery: true },
        address_mirror: {
          ask_lifecycle_complete: true,
          operation_bound_delivery: true,
          playback_ack_proof: true,
        },
      },
      count_contradictions: [],
      unscoped_rejected_asks: [],
      rejection_regime_contradictions: [],
      lifecycle_state_contradictions: [],
    },
  };
  return deepMerge(base, overrides);
}

function deepMerge(base, overrides) {
  if (overrides == null) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(overrides)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function writeManifestPair(store, { sessionId, completion, at }) {
  if (at) tickClock(store, at);
  const start = {
    schema_version: 1,
    manifest_kind: 'start',
    session_id: sessionId,
    boundary: 'session_started',
    started_at: new Date(Date.parse(completion.completed_at) - 60_000).toISOString(),
    deployment: completion.deployment,
  };
  const hashes = {};
  for (const manifest of [start, completion]) {
    const bytes = canonicalBytes(manifest);
    const hash = createHash('sha256').update(bytes).digest('hex');
    hashes[manifest.manifest_kind] = hash;
    const key = `${MANIFEST_PREFIX}/${FP}/${sessionId}/${manifest.manifest_kind}-${hash}.json`;
    const receipt = await publishDurable(store, { key, bytes });
    if (!receipt.ok) throw new Error(`manifest publish failed: ${receipt.error}`);
  }
  return { startHash: hashes.start, completionHash: hashes.completion };
}

/** Bind a session + attest the day (manual pass) + dialogue hearing. */
async function bindAndAttestDay(
  store,
  {
    cohortId,
    sessionId,
    day,
    completedAt,
    completionOverrides,
    manualOverrides = {},
    dialogueOverrides = {},
    skipDialogue = false,
  }
) {
  const completion = eligibleCompletion({ sessionId, completedAt, overrides: completionOverrides });
  const hashes = await writeManifestPair(store, { sessionId, completion, at: `${day}T10:00:00Z` });
  await publishEventAt(store, {
    kind: 'production_session_bound',
    cohortId,
    namespace: 'machine',
    body: {
      field_session_id: sessionId,
      deployment_fingerprint: FP,
      start_manifest: { content_hash: hashes.startHash },
      completion_manifest: { content_hash: hashes.completionHash },
    },
    at: `${day}T10:05:00Z`,
  });
  await publishEventAt(store, {
    kind: 'manual_attestation',
    cohortId,
    namespace: 'derek',
    body: {
      day,
      field_session_ids: [sessionId],
      field_context: 'genuine_on_site',
      manual_heard_by: 'Derek',
      heard_completed_during_session: true,
      confirmation_ref: MANUAL_OP,
      confirmation_session_id: sessionId,
      attested_at: `${day}T11:00:00Z`,
      manual_result: 'pass',
      ...manualOverrides,
    },
    at: `${day}T11:05:00Z`,
  });
  if (!skipDialogue) {
    await publishEventAt(store, {
      kind: 'dialogue_hearing_attestation',
      cohortId,
      namespace: 'derek',
      body: {
        field_session_id: sessionId,
        dialogue_delivery_ref: 'd:2',
        manual_heard_by: 'Derek',
        heard_completed_during_session: true,
        manual_result: 'pass',
        attested_at: `${day}T11:10:00Z`,
        ...dialogueOverrides,
      },
      at: `${day}T11:15:00Z`,
    });
  }
}

/** Publish a full accepted-day evidence set. */
async function publishAcceptedDay(store, { cohortId, day, dayIndex }) {
  const sessionId = `sess_day${dayIndex}`;
  await bindAndAttestDay(store, {
    cohortId,
    sessionId,
    day,
    completedAt: `${day}T09:55:00Z`,
  });
  for (let rep = 1; rep <= 5; rep += 1) {
    const ordinal = (dayIndex - 1) * 5 + rep;
    await publishAttempt(store, {
      cohortId,
      requirementKey: `ir:${cohortId}:rep-${ordinal}`,
      requirementClass: 'pinned_ir',
      repetitionOrdinal: ordinal,
      at: `${day}T1${rep}:00:00Z`,
    });
  }
  for (const lane of ['haiku', 'luna']) {
    for (const fixtureId of EXPECTATION_MANIFEST.vendor_live_expectations.fixture_ids) {
      await publishAttempt(store, {
        cohortId,
        requirementKey: `corpus:${cohortId}:${lane}:run-${dayIndex}:${fixtureId}`,
        requirementClass: 'vendor_corpus',
        modelLane: lane,
        corpusRunOrdinal: dayIndex,
        fixtureId,
        model: lane === 'haiku' ? 'claude-haiku-4-5' : 'gpt-5.6-luna',
        tier: lane === 'haiku' ? null : 'fast',
        at: `${day}T16:0${lane === 'haiku' ? 0 : 5}:00Z`,
      });
    }
  }
}

async function foldNow(store, cohortId, { live = LIVE_OK } = {}) {
  return computeFold(store, {
    cohortId,
    expectationManifest: EXPECTATION_MANIFEST,
    recomputedOracleDigest: EXPECTATION_MANIFEST.semantic_oracle_digest,
    liveDeployment: live,
  });
}

// ═══ A. canonical events + append-only + versioning refusal ═══════════════

describe('A — canonical events, append-only publish, versioning refusal', () => {
  test('events are content-hash named and tier-1 valid', () => {
    const event = buildEvent({
      kind: 'attempt_terminal',
      cohortId: COHORT,
      namespace: 'machine',
      body: {
        requirement_key: 'k',
        attempt_ref: 'att_x',
        attempt_generation: 1,
        requirement_class: 'pinned_ir',
        verdict: 'PASS',
        model: 'm',
        tier: 't',
        report_digest: 'r',
        provider_call_ids: ['p1'],
        generated_at: '2026-08-10T09:00:00Z',
      },
    });
    expect(event.key).toBe(
      `${EVIDENCE_PREFIX}/events/${COHORT}/machine/${event.content_hash}.json`
    );
    expect(validateStoredEvent({ key: event.key, payload: event.payload })).toEqual([]);
  });

  test.each([
    ['wrong namespace: derek kind in machine path', 'manual_attestation', 'machine'],
    ['wrong namespace: machine kind in derek path', 'attempt_terminal', 'derek'],
  ])('%s is rejected at tier 1', (_n, kind, namespace) => {
    const event = buildEvent({ kind, cohortId: COHORT, namespace, body: {} });
    const problems = validateStoredEvent({ key: event.key, payload: event.payload });
    expect(problems.some((p) => p.code === 'wrong_kind_for_namespace')).toBe(true);
  });

  test('a non-stage_a kind under _stage-a is rejected; stage_a outside it is rejected', () => {
    const a = buildEvent({
      kind: 'attempt_terminal',
      cohortId: STAGE_A_COHORT,
      namespace: 'machine',
      body: {},
    });
    expect(
      validateStoredEvent({ key: a.key, payload: a.payload }).some(
        (p) => p.code === 'wrong_kind_for_stage_a_cohort'
      )
    ).toBe(true);
    const b = buildEvent({
      kind: 'stage_a_deployed',
      cohortId: COHORT,
      namespace: 'machine',
      body: {},
    });
    expect(
      validateStoredEvent({ key: b.key, payload: b.payload }).some(
        (p) => p.code === 'stage_a_event_outside_stage_a_cohort'
      )
    ).toBe(true);
  });

  test('tampered payload fails the content-hash name check', () => {
    const event = buildEvent({
      kind: 'cohort_blocked',
      cohortId: COHORT,
      namespace: 'machine',
      body: { reason: 'x' },
    });
    const problems = validateStoredEvent({
      key: event.key,
      payload: { ...event.payload, reason: 'tampered' },
    });
    expect(problems.some((p) => p.code === 'content_hash_name_mismatch')).toBe(true);
  });

  test('bucket-versioning refusal is fail-closed', async () => {
    const store = createMemoryStore({ versioning: 'Suspended' });
    await expect(assertBucketVersioned(store)).rejects.toThrow(/versioning/);
  });

  test('publishDurable: duplicate identical publish is ONE idempotent success; append-only holds', async () => {
    const store = createMemoryStore();
    const bytes = Buffer.from('{"a":1}');
    const first = await publishDurable(store, { key: 'k/x.json', bytes });
    const second = await publishDurable(store, { key: 'k/x.json', bytes });
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: true, idempotent: true, versionId: first.versionId });
    const third = await publishDurable(store, { key: 'k/x.json', bytes: Buffer.from('{"a":2}') });
    expect(third).toMatchObject({ ok: false, error: 'existing_content_mismatch' });
  });

  test('publishDurable: bounded 409 retry with the same body', async () => {
    const store = createMemoryStore();
    store._injectConflicts(2);
    const res = await publishDurable(
      store,
      { key: 'k/y.json', bytes: Buffer.from('{}') },
      { sleepMs: 0 }
    );
    expect(res.ok).toBe(true);
  });
});

// ═══ B. the version-audited reader ════════════════════════════════════════

describe('B — version-audited fold reader', () => {
  test('delete marker is a HOLD, never an omission (delete-marker-hidden FAIL)', async () => {
    const store = createMemoryStore();
    const { event } = await publishEventAt(store, {
      kind: 'cohort_blocked',
      cohortId: COHORT,
      namespace: 'machine',
      body: { reason: 'fail-evidence' },
    });
    store._delete(event.key);
    const { records, holds } = await loadAuditedPrefix(store, `${EVIDENCE_PREFIX}/events/`);
    expect(holds.some((h) => h.code === 'delete_marker_present' && h.key === event.key)).toBe(true);
    // The record itself still folds (versions remain readable) — never lost.
    expect(records.some((r) => r.key === event.key)).toBe(true);
  });

  test('same-key divergent bytes (overwrite) is a HOLD', async () => {
    const store = createMemoryStore();
    const { event } = await publishEventAt(store, {
      kind: 'cohort_blocked',
      cohortId: COHORT,
      namespace: 'machine',
      body: { reason: 'one' },
    });
    store._putUnconditional(event.key, Buffer.from('{"tampered":true}'));
    const { records, holds } = await loadAuditedPrefix(store, `${EVIDENCE_PREFIX}/events/`);
    expect(holds.some((h) => h.code === 'same_key_divergent_bytes')).toBe(true);
    expect(records.some((r) => r.key === event.key)).toBe(false);
  });

  test('byte-identical versions collapse to the EARLIEST LastModified (idempotent duplicates cannot move days, incl. across London midnight)', async () => {
    const store = createMemoryStore();
    // First receipt 23:30 UTC+1 (London) on Aug 10 = 22:30Z.
    tickClock(store, '2026-08-10T22:30:00Z');
    const event = buildEvent({
      kind: 'cohort_blocked',
      cohortId: COHORT,
      namespace: 'machine',
      body: { reason: 'midnight' },
    });
    await publishDurable(store, { key: event.key, bytes: event.bytes });
    // A later identical write lands AFTER London midnight.
    tickClock(store, '2026-08-11T01:00:00Z');
    store._putUnconditional(event.key, event.bytes);
    const { records, holds } = await loadAuditedPrefix(store, `${EVIDENCE_PREFIX}/events/`);
    expect(holds).toEqual([]);
    const rec = records.find((r) => r.key === event.key);
    expect(rec.version_ids).toHaveLength(2);
    expect(londonDayOf(rec.published_at)).toBe('2026-08-10');
  });

  test('shuffled rebuild is deterministic (order-independent fold input)', async () => {
    const store = createMemoryStore();
    const { cohortId } = await establishCohort(store);
    await publishAcceptedDay(store, { cohortId, day: '2026-08-10', dayIndex: 1 });
    const fold1 = await foldNow(store, cohortId);
    // Reverse the internal key iteration order by rebuilding the map reversed.
    const entries = [...store._objects.entries()].reverse();
    store._objects.clear();
    for (const [k, v] of entries) store._objects.set(k, v);
    const fold2 = await foldNow(store, cohortId);
    expect(fold2).toEqual(fold1);
  });

  test('three backdated claimed days published on one S3 day yield progress ≤ 1/3', async () => {
    const store = createMemoryStore();
    const { cohortId } = await establishCohort(store);
    // All three "days" of evidence land on 2026-08-10 with backdated --day
    // claims; the day-mismatch attestations are INVALID and only receipt-day
    // membership counts.
    for (const [i, claimedDay] of [
      ['1', '2026-08-07'],
      ['2', '2026-08-08'],
      ['3', '2026-08-09'],
    ]) {
      const sessionId = `sess_backdate_${i}`;
      await bindAndAttestDay(store, {
        cohortId,
        sessionId,
        day: '2026-08-10',
        completedAt: '2026-08-10T09:55:00Z',
        manualOverrides: { day: claimedDay },
      });
    }
    const fold = await foldNow(store, cohortId);
    const accepted = fold.accepted_days.length;
    expect(accepted).toBeLessThanOrEqual(1);
    expect(fold.state).not.toBe('DONE');
  });
});

// ═══ C. conditional-create reservations ═══════════════════════════════════

describe('C — reservations: crash boundaries, 412/409 recovery', () => {
  test('S3 conditional-create 200 → allocated with read-back', async () => {
    const store = createMemoryStore();
    const cand = buildOrdinalCandidate({ cohortId: COHORT, lane: 'ir-repetition', ordinal: 1 });
    const res = await allocateOrdinal(store, cand);
    expect(res.allocated).toBe(true);
    expect(res.versionId).toBeTruthy();
  });

  test('412: another winner ⇒ taken (call no provider, next ordinal after refold)', async () => {
    const store = createMemoryStore();
    const first = buildOrdinalCandidate({ cohortId: COHORT, lane: 'ir-repetition', ordinal: 1 });
    await allocateOrdinal(store, first);
    const second = buildOrdinalCandidate({ cohortId: COHORT, lane: 'ir-repetition', ordinal: 1 });
    const res = await allocateOrdinal(store, second);
    expect(res).toMatchObject({ allocated: false, taken: true });
    expect(res.winner.nonce).toBe(first.body.nonce);
  });

  test('409 never mints a new ordinal — same-key retry then success', async () => {
    const store = createMemoryStore();
    store._injectConflicts(2);
    const cand = buildOrdinalCandidate({ cohortId: COHORT, lane: 'corpus-run-luna', ordinal: 3 });
    const res = await allocateOrdinal(store, cand);
    expect(res.allocated).toBe(true);
    expect(store._objects.size).toBe(1);
  });

  test('lost-200 (transport error after durable write) recovers OUR allocation with the same candidate', async () => {
    const store = createMemoryStore();
    store._loseNext200();
    const cand = buildOrdinalCandidate({ cohortId: COHORT, lane: 'ir-repetition', ordinal: 2 });
    const res = await allocateOrdinal(store, cand);
    expect(res).toMatchObject({ allocated: true, recovered: true });
  });

  test('the atomic PENDING is the attempt record — crash BEFORE create leaves no state (safe retry)', async () => {
    const store = createMemoryStore();
    const { records } = await loadAuditedPrefix(store, `${EVIDENCE_PREFIX}/reservations/`);
    expect(records).toEqual([]);
    const cand = buildAttemptCandidate({
      cohortId: COHORT,
      requirementKey: 'ir:k:rep-1',
      generation: 1,
      requirement: { requirementClass: 'pinned_ir', model: 'm', tier: 't' },
    });
    const res = await reserveAttempt(store, cand, { dispatchLatch: { begun: false } });
    expect(res.authorised).toBe(true);
    // There is no separate lock object — exactly ONE reservation object.
    const after = await loadAuditedPrefix(store, `${EVIDENCE_PREFIX}/reservations/`);
    expect(after.records).toHaveLength(1);
    expect(after.records[0].payload.reservation_kind).toBe('attempt_pending');
  });

  test('lost-200 → same-ref 412 recovery authorises EXACTLY ONE dispatch', async () => {
    const store = createMemoryStore();
    store._loseNext200();
    const cand = buildAttemptCandidate({
      cohortId: COHORT,
      requirementKey: 'ir:k:rep-2',
      generation: 1,
      requirement: { requirementClass: 'pinned_ir', model: 'm', tier: 't' },
    });
    const latch = { begun: false };
    const res = await reserveAttempt(store, cand, { dispatchLatch: latch });
    expect(res).toMatchObject({ authorised: true, recovered: true });
    latch.begun = true; // dispatch begins
    // A later duplicate recovery attempt with dispatch begun must NOT re-authorise.
    const again = await reserveAttempt(store, cand, { dispatchLatch: latch });
    expect(again.authorised).toBe(false);
    expect(again.hold?.code).toBe('recovery_after_dispatch_began');
  });

  test('412 with a DIFFERENT ref = another winner ⇒ zero provider calls here', async () => {
    const store = createMemoryStore();
    const winner = buildAttemptCandidate({
      cohortId: COHORT,
      requirementKey: 'ir:k:rep-3',
      generation: 1,
      requirement: { requirementClass: 'pinned_ir', model: 'm', tier: 't' },
    });
    await reserveAttempt(store, winner, { dispatchLatch: { begun: false } });
    const loser = buildAttemptCandidate({
      cohortId: COHORT,
      requirementKey: 'ir:k:rep-3',
      generation: 1,
      requirement: { requirementClass: 'pinned_ir', model: 'm', tier: 't' },
    });
    const res = await reserveAttempt(store, loser, { dispatchLatch: { begun: false } });
    expect(res).toMatchObject({
      authorised: false,
      otherWinner: true,
      winnerRef: winner.attemptRef,
    });
  });

  test('same-ref mismatched body fails CLOSED as integrity', async () => {
    const store = createMemoryStore();
    const cand = buildAttemptCandidate({
      cohortId: COHORT,
      requirementKey: 'ir:k:rep-4',
      generation: 1,
      requirement: { requirementClass: 'pinned_ir', model: 'm', tier: 't' },
    });
    // A corrupted copy under the same key carrying the SAME ref but a
    // different body (operator mistake / partial write).
    const corrupted = { ...cand.body, model: 'DIFFERENT' };
    store._putUnconditional(cand.key, canonicalBytes(corrupted));
    const res = await reserveAttempt(store, cand, { dispatchLatch: { begun: false } });
    expect(res.authorised).toBe(false);
    expect(res.hold?.code).toBe('pending_integrity_conflict');
  });

  test('409 → same-ref retry → 412-style recovery for the SAME candidate', async () => {
    const store = createMemoryStore();
    store._injectConflicts(1);
    store._loseNext200();
    const cand = buildAttemptCandidate({
      cohortId: COHORT,
      requirementKey: 'corpus:k:luna:run-1:fx1',
      generation: 1,
      requirement: { requirementClass: 'vendor_corpus', model: 'm', tier: 't' },
    });
    const res = await reserveAttempt(store, cand, { dispatchLatch: { begun: false } });
    expect(res.authorised).toBe(true);
  });

  test('concurrent contenders for one generation: exactly one authorised', async () => {
    const store = createMemoryStore();
    const make = () =>
      buildAttemptCandidate({
        cohortId: COHORT,
        requirementKey: 'ir:k:rep-5',
        generation: 1,
        requirement: { requirementClass: 'pinned_ir', model: 'm', tier: 't' },
      });
    const results = await Promise.all(
      [make(), make(), make()].map((c) =>
        reserveAttempt(store, c, { dispatchLatch: { begun: false } })
      )
    );
    expect(results.filter((r) => r.authorised)).toHaveLength(1);
    expect(results.filter((r) => r.otherWinner)).toHaveLength(2);
  });

  test('delete-marker-hidden reservation is a HOLD, not a retry-through', async () => {
    const store = createMemoryStore();
    const winner = buildAttemptCandidate({
      cohortId: COHORT,
      requirementKey: 'ir:k:rep-6',
      generation: 1,
      requirement: { requirementClass: 'pinned_ir', model: 'm', tier: 't' },
    });
    await reserveAttempt(store, winner, { dispatchLatch: { begun: false } });
    store._delete(winner.key);
    const contender = buildAttemptCandidate({
      cohortId: COHORT,
      requirementKey: 'ir:k:rep-6',
      generation: 1,
      requirement: { requirementClass: 'pinned_ir', model: 'm', tier: 't' },
    });
    const res = await reserveAttempt(store, contender, { dispatchLatch: { begun: false } });
    expect(res.authorised).toBe(false);
    expect(res.hold?.code).toBe('pending_hidden_by_delete_marker');
  });
});

// ═══ D. fold pairing + identity ═══════════════════════════════════════════

describe('D — pairing, replacement, single-use identities', () => {
  async function cohortWithAttempt(opts = {}) {
    const store = createMemoryStore();
    const { cohortId } = await establishCohort(store);
    return { store, cohortId, ...opts };
  }

  test('normal pending/terminal pair counts; orphan PENDING holds', async () => {
    const { store, cohortId } = await cohortWithAttempt();
    await publishAttempt(store, {
      cohortId,
      requirementKey: `ir:${cohortId}:rep-1`,
      repetitionOrdinal: 1,
      at: '2026-08-10T09:00:00Z',
    });
    await publishAttempt(store, {
      cohortId,
      requirementKey: `ir:${cohortId}:rep-2`,
      repetitionOrdinal: 2,
      skipTerminal: true,
      at: '2026-08-10T09:10:00Z',
    });
    const fold = await foldNow(store, cohortId);
    expect(fold.holds.some((h) => h.code === 'orphan_pending')).toBe(true);
    expect(fold.state).toBe('HOLD_EVIDENCE');
  });

  test('terminal without pending is INVALID/HOLD (validation precedence, never semantic)', async () => {
    const { store, cohortId } = await cohortWithAttempt();
    // A FAIL terminal whose attempt_ref has no pending — even a SAFETY fail
    // must NOT reach BLOCKED (wrong-key safety FAIL case).
    const body = {
      requirement_key: `ir:${cohortId}:rep-9`,
      attempt_ref: 'att_ghost',
      attempt_generation: 1,
      requirement_class: 'pinned_ir',
      verdict: 'FAIL',
      model: 'm',
      tier: 't',
      report_digest: 'r',
      provider_call_ids: ['p_ghost'],
      generated_at: '2026-08-10T08:59:00Z',
    };
    await publishEventAt(store, {
      kind: 'attempt_terminal',
      cohortId,
      namespace: 'machine',
      body,
      at: '2026-08-10T09:00:00Z',
    });
    const fold = await foldNow(store, cohortId);
    expect(fold.state).not.toBe('BLOCKED');
    expect(
      fold.invalid.some((i) => i.problems.some((p) => p.code === 'terminal_without_pending'))
    ).toBe(true);
  });

  test('conflicting terminals for one ref BLOCK regardless of verdicts', async () => {
    const { store, cohortId } = await cohortWithAttempt();
    const { candidate } = await publishAttempt(store, {
      cohortId,
      requirementKey: `ir:${cohortId}:rep-3`,
      repetitionOrdinal: 3,
      at: '2026-08-10T09:00:00Z',
    });
    // A second, different terminal for the SAME attempt_ref (both PASS —
    // still an integrity conflict, stricter than the non-safety HOLD path).
    await publishEventAt(store, {
      kind: 'attempt_terminal',
      cohortId,
      namespace: 'machine',
      body: {
        requirement_key: `ir:${cohortId}:rep-3`,
        attempt_ref: candidate.attemptRef,
        attempt_generation: 1,
        requirement_class: 'pinned_ir',
        verdict: 'PASS',
        model: 'm',
        tier: 't',
        report_digest: 'DIFFERENT',
        provider_call_ids: ['p_conflict'],
        generated_at: '2026-08-10T09:01:00Z',
      },
    });
    const fold = await foldNow(store, cohortId);
    expect(fold.state).toBe('BLOCKED');
    expect(fold.blocks.some((b) => b.code === 'conflicting_terminals')).toBe(true);
  });

  test('INVALID → valid replacement on the SAME key counts once; INVALID on another key stays held', async () => {
    const { store, cohortId } = await cohortWithAttempt();
    const key = `ir:${cohortId}:rep-4`;
    await publishAttempt(store, {
      cohortId,
      requirementKey: key,
      generation: 1,
      verdict: 'INVALID',
      providerIds: [],
      repetitionOrdinal: 4,
      at: '2026-08-10T09:00:00Z',
    });
    await publishAttempt(store, {
      cohortId,
      requirementKey: key,
      generation: 2,
      verdict: 'PASS',
      repetitionOrdinal: 4,
      at: '2026-08-10T09:30:00Z',
    });
    // A different key with ONLY an INVALID — must hold, not be cleared by
    // the other key's replacement.
    await publishAttempt(store, {
      cohortId,
      requirementKey: `ir:${cohortId}:rep-5`,
      generation: 1,
      verdict: 'INVALID',
      providerIds: [],
      repetitionOrdinal: 5,
      at: '2026-08-10T09:40:00Z',
    });
    const fold = await foldNow(store, cohortId);
    expect(
      fold.holds
        .filter((h) => h.code === 'invalid_awaiting_replacement')
        .map((h) => h.requirement_key)
    ).toEqual([`ir:${cohortId}:rep-5`]);
  });

  test('two distinct VALID terminals for one requirement key BLOCK (never extra repetitions)', async () => {
    const { store, cohortId } = await cohortWithAttempt();
    const key = `ir:${cohortId}:rep-6`;
    await publishAttempt(store, {
      cohortId,
      requirementKey: key,
      generation: 1,
      repetitionOrdinal: 6,
      at: '2026-08-10T09:00:00Z',
    });
    await publishAttempt(store, {
      cohortId,
      requirementKey: key,
      generation: 2,
      repetitionOrdinal: 6,
      at: '2026-08-10T09:30:00Z',
    });
    const fold = await foldNow(store, cohortId);
    expect(fold.blocks.some((b) => b.code === 'duplicate_valid_terminals_for_key')).toBe(true);
  });

  test('zero provider ids is legal ONLY on INVALID', async () => {
    const { store, cohortId } = await cohortWithAttempt();
    await publishAttempt(store, {
      cohortId,
      requirementKey: `ir:${cohortId}:rep-7`,
      verdict: 'PASS',
      providerIds: [],
      repetitionOrdinal: 7,
      at: '2026-08-10T09:00:00Z',
    });
    const fold = await foldNow(store, cohortId);
    expect(
      fold.invalid.some((i) => i.problems.some((p) => p.code === 'terminal_missing_provider_ids'))
    ).toBe(true);
  });

  test('cross-attempt provider-id and sample-identity reuse BLOCK', async () => {
    const { store, cohortId } = await cohortWithAttempt();
    await publishAttempt(store, {
      cohortId,
      requirementKey: `ir:${cohortId}:rep-8`,
      providerIds: ['prov_shared'],
      repetitionOrdinal: 8,
      at: '2026-08-10T09:00:00Z',
    });
    await publishAttempt(store, {
      cohortId,
      requirementKey: `ir:${cohortId}:rep-9`,
      providerIds: ['prov_shared'],
      repetitionOrdinal: 9,
      at: '2026-08-10T09:30:00Z',
    });
    const fold = await foldNow(store, cohortId);
    expect(fold.blocks.some((b) => b.code === 'provider_call_id_reuse')).toBe(true);
  });

  test('rewrapped/copied report (same provider ids under a NEW ref) cannot count twice', async () => {
    const { store, cohortId } = await cohortWithAttempt();
    await publishAttempt(store, {
      cohortId,
      requirementKey: `ir:${cohortId}:rep-10`,
      providerIds: ['prov_wrap'],
      repetitionOrdinal: 10,
      at: '2026-08-10T09:00:00Z',
    });
    // The same provider evidence rewrapped as a fresh attempt on another key.
    await publishAttempt(store, {
      cohortId,
      requirementKey: `ir:${cohortId}:rep-11`,
      providerIds: ['prov_wrap'],
      repetitionOrdinal: 11,
      at: '2026-08-10T09:10:00Z',
    });
    const fold = await foldNow(store, cohortId);
    expect(fold.state).toBe('BLOCKED');
  });

  test('generated_at after the S3 receipt (future skew) is INVALID', async () => {
    const { store, cohortId } = await cohortWithAttempt();
    await publishAttempt(store, {
      cohortId,
      requirementKey: `ir:${cohortId}:rep-12`,
      repetitionOrdinal: 12,
      generatedAt: '2026-08-10T23:00:00Z',
      at: '2026-08-10T09:00:00Z',
      terminalAt: '2026-08-10T09:01:00Z',
    });
    const fold = await foldNow(store, cohortId);
    expect(
      fold.invalid.some((i) =>
        i.problems.some((p) => p.code === 'terminal_generated_after_receipt')
      )
    ).toBe(true);
  });
});

// ═══ E. semantic classification ═══════════════════════════════════════════

describe('E — semantic classification after structural validity', () => {
  test.each([['pinned_ir'], ['safety_certificate_mutation']])(
    'structurally valid %s FAIL blocks irreversibly (passing rerun cannot clear it)',
    async (cls) => {
      const store = createMemoryStore();
      const { cohortId } = await establishCohort(store);
      const key = `sf:${cohortId}:x`;
      await publishAttempt(store, {
        cohortId,
        requirementKey: key,
        requirementClass: cls,
        verdict: 'FAIL',
        repetitionOrdinal: 1,
        at: '2026-08-10T09:00:00Z',
      });
      let fold = await foldNow(store, cohortId);
      expect(fold.state).toBe('BLOCKED');
      expect(fold.blocks.some((b) => b.code === 'semantic_safety_fail')).toBe(true);
      // A later PASS on a DIFFERENT key cannot clear the block; a second valid
      // terminal on the SAME key would itself be a duplicate-valid block.
      await publishAttempt(store, {
        cohortId,
        requirementKey: `sf:${cohortId}:y`,
        requirementClass: cls,
        verdict: 'PASS',
        repetitionOrdinal: 2,
        at: '2026-08-10T10:00:00Z',
      });
      fold = await foldNow(store, cohortId);
      expect(fold.state).toBe('BLOCKED');
    }
  );

  test('non-safety vendor mismatch HOLDS until decided; rejected blocks; approved stays named', async () => {
    const store = createMemoryStore();
    const { cohortId } = await establishCohort(store);
    await publishAttempt(store, {
      cohortId,
      requirementKey: `corpus:${cohortId}:luna:run-1:fx1`,
      requirementClass: 'vendor_corpus',
      verdict: 'FAIL',
      modelLane: 'luna',
      corpusRunOrdinal: 1,
      fixtureId: 'fx1',
      mismatch: { mismatch_id: 'mm_1', safety_critical: false },
      at: '2026-08-10T09:00:00Z',
    });
    let fold = await foldNow(store, cohortId);
    expect(fold.state).toBe('HOLD_EVIDENCE');
    expect(fold.holds.some((h) => h.code === 'undecided_non_safety_mismatch')).toBe(true);

    await publishEventAt(store, {
      kind: 'non_safety_decision',
      cohortId,
      namespace: 'derek',
      body: {
        mismatch_id: 'mm_1',
        decision: 'approved',
        reviewer: 'Derek',
        decided_at: new Date(clockMs).toISOString(),
      },
    });
    fold = await foldNow(store, cohortId);
    expect(fold.holds.some((h) => h.code === 'undecided_non_safety_mismatch')).toBe(false);
    expect(fold.notes.some((n) => n.code === 'approved_non_safety_mismatch')).toBe(true);

    // A rejected decision on a different mismatch blocks.
    await publishAttempt(store, {
      cohortId,
      requirementKey: `corpus:${cohortId}:luna:run-1:fx2`,
      requirementClass: 'vendor_corpus',
      verdict: 'FAIL',
      modelLane: 'luna',
      corpusRunOrdinal: 1,
      fixtureId: 'fx2',
      mismatch: { mismatch_id: 'mm_2', safety_critical: false },
      at: '2026-08-10T10:00:00Z',
    });
    await publishEventAt(store, {
      kind: 'non_safety_decision',
      cohortId,
      namespace: 'derek',
      body: {
        mismatch_id: 'mm_2',
        decision: 'rejected',
        reviewer: 'Derek',
        decided_at: new Date(clockMs).toISOString(),
      },
    });
    fold = await foldNow(store, cohortId);
    expect(fold.state).toBe('BLOCKED');
    expect(fold.blocks.some((b) => b.code === 'non_safety_mismatch_rejected')).toBe(true);
  });

  test('a vendor FAIL carrying safety_critical:true blocks even though the class is vendor_corpus', async () => {
    const store = createMemoryStore();
    const { cohortId } = await establishCohort(store);
    await publishAttempt(store, {
      cohortId,
      requirementKey: `corpus:${cohortId}:haiku:run-1:fx1`,
      requirementClass: 'vendor_corpus',
      verdict: 'FAIL',
      model: 'claude-haiku-4-5',
      tier: null,
      modelLane: 'haiku',
      corpusRunOrdinal: 1,
      fixtureId: 'fx1',
      mismatch: { mismatch_id: 'mm_s', safety_critical: true },
      at: '2026-08-10T09:00:00Z',
    });
    const fold = await foldNow(store, cohortId);
    expect(fold.state).toBe('BLOCKED');
  });
});

// ═══ F. manual + dialogue attestation matrices ════════════════════════════

describe('F — manual attestation invariants', () => {
  async function base(manualOverrides, completionOverrides, opts = {}) {
    const store = createMemoryStore();
    const { cohortId } = await establishCohort(store);
    await bindAndAttestDay(store, {
      cohortId,
      sessionId: 'sess_m',
      day: '2026-08-10',
      completedAt: '2026-08-10T09:55:00Z',
      manualOverrides,
      completionOverrides,
      ...opts,
    });
    return { store, cohortId, fold: await foldNow(store, cohortId) };
  }

  test('a valid manifest-bound pass counts for the day', async () => {
    const { fold } = await base();
    const day = fold.day_evaluations.find((d) => d.day === '2026-08-10');
    expect(day.requirements.manual_pass).toBe(true);
    expect(day.requirements.bound_genuine_session).toBe(true);
  });

  test('false + pass is rejected at validation precedence (INVALID/HOLD, not BLOCK)', async () => {
    const { fold } = await base({ heard_completed_during_session: false, manual_result: 'pass' });
    expect(fold.state).toBe('HOLD_EVIDENCE');
    expect(fold.holds.some((h) => h.code === 'manual_attestation_invalid')).toBe(true);
    expect(fold.blocks).toEqual([]);
  });

  test('false + fail is a valid attestation and BLOCKS', async () => {
    const { fold } = await base({ heard_completed_during_session: false, manual_result: 'fail' });
    expect(fold.state).toBe('BLOCKED');
    expect(fold.blocks.some((b) => b.code === 'manual_heard_fail')).toBe(true);
  });

  test('unknown confirmation_ref is INVALID/HOLD', async () => {
    const { fold } = await base({
      confirmation_ref: '{"turn":"ghost","field":"x","circuit":1,"board_id":null,"ordinal":0}',
    });
    expect(fold.holds.some((h) => h.code === 'manual_attestation_invalid')).toBe(true);
  });

  test('zero playback starts cannot PASS (ACK after freeze ⇒ zero captured starts)', async () => {
    const { fold } = await base(undefined, {
      evidence: { playbacks: { ordinary_confirmation: [] } },
    });
    expect(fold.holds.some((h) => h.code === 'manual_attestation_invalid')).toBe(true);
  });

  test('a second distinct playback start for the operation cannot PASS', async () => {
    const { fold } = await base(undefined, {
      evidence: {
        playbacks: {
          ordinary_confirmation: [
            {
              seq: 4,
              op_key: MANUAL_OP,
              ack_body_hash: '1'.repeat(64),
              source: 'ordinary',
              producer_id: 'playback_ack_slot',
              transport: 'http_playback_ack',
            },
            {
              seq: 9,
              op_key: MANUAL_OP,
              ack_body_hash: '3'.repeat(64),
              source: 'ordinary',
              producer_id: 'playback_ack_slot',
              transport: 'http_playback_ack',
            },
          ],
        },
      },
    });
    expect(fold.holds.some((h) => h.code === 'manual_attestation_invalid')).toBe(true);
  });

  test('delivery_history_ambiguous on the chosen operation cannot PASS (replay ACK is HOLD)', async () => {
    const { fold } = await base(undefined, {
      evidence: { delivery_history_ambiguous_op_keys: [{ seq: 9, op_key: MANUAL_OP }] },
    });
    expect(fold.holds.some((h) => h.code === 'manual_attestation_invalid')).toBe(true);
  });

  test('attested_at before session completion is rejected (hearing outside the session)', async () => {
    const { fold } = await base({ attested_at: '2026-08-10T08:00:00Z' });
    expect(fold.holds.some((h) => h.code === 'manual_attestation_invalid')).toBe(true);
  });

  test('a session whose evidence is ineligible (freeze_invalid class) cannot host the manual pass', async () => {
    const { fold } = await base(undefined, {
      evidence: {
        eligible_for_family_credit: false,
        ineligible_conditions: [{ condition: 'delivery_invalid' }],
      },
    });
    expect(fold.holds.some((h) => h.code === 'manual_attestation_invalid')).toBe(true);
  });

  test('non-quiescent stop or open Tier-2 ask makes the bound session ineligible', async () => {
    for (const overrides of [
      { evidence: { quiescence: { non_quiescent_at_stop: 1 } } },
      { evidence: { open_asks: { dialogue_script: 1 } } },
      { evidence: { lifecycle_state_contradictions: [{ class: 'invalid_lifecycle_transition' }] } },
      { evidence: { count_contradictions: [{ key: 'open_asks_dispatcher' }] } },
    ]) {
      const { fold } = await base(undefined, overrides);
      expect(fold.holds.some((h) => h.code === 'manual_attestation_invalid')).toBe(true);
    }
  });
});

describe('F — dialogue_hearing_attestation matrix', () => {
  async function withDialogue(dialogueOverrides, opts = {}) {
    const store = createMemoryStore();
    const { cohortId } = await establishCohort(store);
    await bindAndAttestDay(store, {
      cohortId,
      sessionId: 'sess_d',
      day: '2026-08-10',
      completedAt: '2026-08-10T09:55:00Z',
      dialogueOverrides,
      ...opts,
    });
    return { store, cohortId, fold: await foldNow(store, cohortId) };
  }

  test('valid unique-ref pass satisfies the dialogue family gate', async () => {
    const { fold } = await withDialogue();
    const day = fold.day_evaluations.find((d) => d.day === '2026-08-10');
    expect(day.requirements.dialogue_script_family).toBe(true);
  });

  test('false + pass rejected at validation precedence', async () => {
    const { fold } = await withDialogue({
      heard_completed_during_session: false,
      manual_result: 'pass',
    });
    expect(fold.holds.some((h) => h.code === 'dialogue_hearing_invalid')).toBe(true);
    expect(fold.blocks).toEqual([]);
  });

  test('heard-but-wrong (true + fail) BLOCKS — mirrors the sibling manual lane', async () => {
    const { fold } = await withDialogue({ manual_result: 'fail' });
    expect(fold.state).toBe('BLOCKED');
    expect(fold.blocks.some((b) => b.code === 'dialogue_hearing_fail')).toBe(true);
  });

  test('unknown dialogue_delivery_ref is INVALID/HOLD', async () => {
    const { fold } = await withDialogue({ dialogue_delivery_ref: 'd:99' });
    expect(fold.holds.some((h) => h.code === 'dialogue_hearing_invalid')).toBe(true);
  });

  test('an op-less dialogue delivery cannot satisfy the ref (operation-bound only)', async () => {
    const { fold } = await withDialogue(undefined, {
      completionOverrides: {
        evidence: {
          deliveries: {
            dialogue_script: [
              {
                seq: 2,
                delivery_ref: 'd:2',
                at_seq: 2,
                producer_id: 'dialogue_confirmation',
                transport: 'dialogue_ws',
                delivery_kind: 'dialogue_confirmation',
                op_keys: [],
                claim_lineage: null,
                wire_turn_id: null,
                dedupe_token: null,
                correlation_id: null,
                delivery_claim_token: null,
              },
            ],
          },
        },
      },
    });
    expect(fold.holds.some((h) => h.code === 'dialogue_hearing_invalid')).toBe(true);
  });

  test('genuine-on-site fold rule: a hearing for a session NOT bound under a genuine daily attestation is INVALID/HOLD', async () => {
    const store = createMemoryStore();
    const { cohortId } = await establishCohort(store);
    // Bind + manifests for sess_x but the daily attestation names OTHER sessions.
    await bindAndAttestDay(store, {
      cohortId,
      sessionId: 'sess_other',
      day: '2026-08-10',
      completedAt: '2026-08-10T09:55:00Z',
      skipDialogue: true,
    });
    const completion = eligibleCompletion({
      sessionId: 'sess_x',
      completedAt: '2026-08-10T09:50:00Z',
    });
    await writeManifestPair(store, { sessionId: 'sess_x', completion, at: '2026-08-10T10:00:00Z' });
    await publishEventAt(store, {
      kind: 'production_session_bound',
      cohortId,
      namespace: 'machine',
      body: {
        field_session_id: 'sess_x',
        deployment_fingerprint: FP,
        start_manifest: { published_hash: 'sh' },
        completion_manifest: { published_hash: 'ch' },
      },
      at: '2026-08-10T10:06:00Z',
    });
    await publishEventAt(store, {
      kind: 'dialogue_hearing_attestation',
      cohortId,
      namespace: 'derek',
      body: {
        field_session_id: 'sess_x',
        dialogue_delivery_ref: 'd:2',
        manual_heard_by: 'Derek',
        heard_completed_during_session: true,
        manual_result: 'pass',
        attested_at: '2026-08-10T11:00:00Z',
      },
      at: '2026-08-10T11:05:00Z',
    });
    const fold = await foldNow(store, cohortId);
    expect(
      fold.invalid.some((i) =>
        i.problems.some((p) => p.code === 'session_not_genuine_on_site_bound')
      )
    ).toBe(true);
  });
});

// ═══ G. per-day gates + counting rules ════════════════════════════════════

describe('G — per-day route/cache/family/IR/corpus gates', () => {
  async function dayFold(completionOverrides, opts = {}) {
    const store = createMemoryStore();
    const { cohortId } = await establishCohort(store);
    await bindAndAttestDay(store, {
      cohortId,
      sessionId: 'sess_g',
      day: '2026-08-10',
      completedAt: '2026-08-10T09:55:00Z',
      completionOverrides,
      ...opts,
    });
    const fold = await foldNow(store, cohortId);
    return fold.day_evaluations.find((d) => d.day === '2026-08-10');
  }

  test('reading-only Luna day: Terra + cache gates stay false', async () => {
    const day = await dayFold({
      evidence: {
        round_usage: {
          rounds: [inspectorRound({ prompt_cache_mode: null, cache_read_input_tokens: 0 })],
        },
      },
    });
    expect(day.requirements.luna_fast_round).toBe(true);
    expect(day.requirements.terra_observation_round).toBe(false);
    expect(day.requirements.explicit_cache_evidence).toBe(false);
    expect(day.accepted).toBe(false);
  });

  test('configured-but-uninvoked Terra (zero rounds) never satisfies the gate', async () => {
    const day = await dayFold({ evidence: { round_usage: { rounds: [inspectorRound()] } } });
    expect(day.requirements.terra_observation_round).toBe(false);
  });

  test('wrong Terra tier or effort fails the gate', async () => {
    for (const bad of [
      terraRound({ reasoning_effort: 'medium' }),
      terraRound({ billing_tier: 'fast', response_tier: 'fast' }),
    ]) {
      const day = await dayFold({ evidence: { round_usage: { rounds: [inspectorRound(), bad] } } });
      expect(day.requirements.terra_observation_round).toBe(false);
    }
  });

  test('a chat_completions observation round is a NEGATIVE for the Terra gate', async () => {
    const day = await dayFold({
      evidence: {
        round_usage: {
          rounds: [
            inspectorRound(),
            terraRound({ api_transport: 'chat_completions', reasoning_effort: null }),
          ],
        },
      },
    });
    expect(day.requirements.terra_observation_round).toBe(false);
  });

  test('keepalive / orphan-review / legacy rows NEVER count for any gate', async () => {
    const day = await dayFold({
      evidence: {
        round_usage: {
          rounds: [
            inspectorRound({ billable_kind: 'cache_keepalive' }),
            terraRound({ billable_kind: 'orphan_review' }),
            inspectorRound({ billable_kind: 'inspector_legacy' }),
          ],
        },
      },
    });
    expect(day.requirements.luna_fast_round).toBe(false);
    expect(day.requirements.terra_observation_round).toBe(false);
    expect(day.requirements.explicit_cache_evidence).toBe(false);
  });

  test('cold-only cache rows (write>0, read=0) are insufficient', async () => {
    const day = await dayFold({
      evidence: {
        round_usage: {
          rounds: [inspectorRound({ cache_read_input_tokens: 0, cache_write_input_tokens: 9000 })],
        },
      },
    });
    expect(day.requirements.explicit_cache_evidence).toBe(false);
  });

  test('missing address-mirror playback ACK proof fails that family gate', async () => {
    const day = await dayFold({
      evidence: {
        family_gates: {
          address_mirror: {
            ask_lifecycle_complete: true,
            operation_bound_delivery: true,
            playback_ack_proof: false,
          },
        },
      },
    });
    expect(day.requirements.address_mirror_family).toBe(false);
  });

  test('a dialogue family gate without a hearing attestation is NOT satisfied', async () => {
    const store = createMemoryStore();
    const { cohortId } = await establishCohort(store);
    await bindAndAttestDay(store, {
      cohortId,
      sessionId: 'sess_nodh',
      day: '2026-08-10',
      completedAt: '2026-08-10T09:55:00Z',
      skipDialogue: true,
    });
    const fold = await foldNow(store, cohortId);
    const day = fold.day_evaluations.find((d) => d.day === '2026-08-10');
    expect(day.requirements.dialogue_script_family).toBe(false);
  });

  test('IR repetitions below five, or reused ordinals, do not satisfy the day', async () => {
    const store = createMemoryStore();
    const { cohortId } = await establishCohort(store);
    for (let rep = 1; rep <= 4; rep += 1) {
      await publishAttempt(store, {
        cohortId,
        requirementKey: `ir:${cohortId}:rep-${rep}`,
        repetitionOrdinal: rep,
        at: `2026-08-10T0${rep}:00:00Z`,
      });
    }
    let fold = await foldNow(store, cohortId);
    let day = fold.day_evaluations.find((d) => d.day === '2026-08-10');
    expect(day.requirements.pinned_ir).toBe(false);
    // A fifth repetition REUSING ordinal 4 on a different key blocks.
    await publishAttempt(store, {
      cohortId,
      requirementKey: `ir:${cohortId}:rep-5x`,
      repetitionOrdinal: 4,
      at: '2026-08-10T05:00:00Z',
    });
    fold = await foldNow(store, cohortId);
    expect(fold.blocks.some((b) => b.code === 'ir_ordinal_reuse_within_day')).toBe(true);
  });

  test('an incomplete corpus run fails the lane; a FIXTURE-ID deferral is INVALID and excuses nothing', async () => {
    const store = createMemoryStore();
    const { cohortId } = await establishCohort(store);
    await publishAttempt(store, {
      cohortId,
      requirementKey: `corpus:${cohortId}:luna:run-1:fx1`,
      requirementClass: 'vendor_corpus',
      modelLane: 'luna',
      corpusRunOrdinal: 1,
      fixtureId: 'fx1',
      at: '2026-08-10T09:00:00Z',
    });
    let fold = await foldNow(store, cohortId);
    let day = fold.day_evaluations.find((d) => d.day === '2026-08-10');
    expect(day.requirements.corpus_luna).toBe(false);
    await publishEventAt(store, {
      kind: 'corpus_gap_decision',
      cohortId,
      namespace: 'derek',
      body: {
        stratum_or_fixture: 'fx2',
        decision: 'approved',
        safety_critical: false,
        reviewer: 'Derek',
        decided_at: new Date(clockMs).toISOString(),
      },
    });
    fold = await foldNow(store, cohortId);
    day = fold.day_evaluations.find((d) => d.day === '2026-08-10');
    // Unclassified targets default to safety-critical: a whole attested
    // fixture is NEVER deferrable, so the lane stays incomplete and the
    // decision itself is held invalid.
    expect(day.requirements.corpus_luna).toBe(false);
    expect(fold.holds.some((h) => h.code === 'corpus_gap_decision_invalid')).toBe(true);
  });
});

// ═══ H. lifecycle states, dominance, staleness ════════════════════════════

describe('H — fold states and the deterministic 0/3 → DONE walk', () => {
  test('empty store is NOT_STARTED; stage_a alone is STAGE_A_IMPLEMENTED; init is HOLD 0/3', async () => {
    const store = createMemoryStore();
    let fold = await foldNow(store, null);
    expect(fold.state).toBe('NOT_STARTED');
    await publishEventAt(store, {
      kind: 'stage_a_deployed',
      cohortId: STAGE_A_COHORT,
      namespace: 'machine',
      body: stageABody(),
      at: '2026-08-09T08:00:00Z',
    });
    fold = await foldNow(store, null);
    expect(fold.state).toBe('STAGE_A_IMPLEMENTED');
    const store2 = createMemoryStore();
    const { cohortId } = await establishCohort(store2);
    fold = await foldNow(store2, cohortId);
    expect(fold.state).toBe('HOLD_EVIDENCE');
    expect(fold.progress).toBe('0/3');
  });

  test('cohort init with a mismatched stage-a/attested hash is INVALID and cannot initialise', async () => {
    const store = createMemoryStore();
    const { event: stageA } = await publishEventAt(store, {
      kind: 'stage_a_deployed',
      cohortId: STAGE_A_COHORT,
      namespace: 'machine',
      body: stageABody(),
      at: '2026-08-09T08:00:00Z',
    });
    const { cohortId } = computeCohortFingerprint({
      stageAPayload: stageA.payload,
      combinedSha256: EXPECTATION_MANIFEST.combined_sha256,
      vendorLiveSha256: EXPECTATION_MANIFEST.vendor_live_expectations.sha256,
      deterministicEgressSha256: EXPECTATION_MANIFEST.deterministic_egress_expectations.sha256,
    });
    await publishEventAt(store, {
      kind: 'cohort_initialized',
      cohortId,
      namespace: 'derek',
      body: {
        cohort_fingerprint: {},
        stage_a_event_hash: 'wrong',
        expectations_event_hash: 'wrong',
      },
    });
    const fold = await foldNow(store, cohortId);
    // Visible invalid evidence is HOLD, never a clean stage-only state
    // (Codex cycle-1 fail-closed rule).
    expect(fold.state).toBe('HOLD_EVIDENCE');
    expect(fold.cohort_initialized).toBeNull();
  });

  test('expectations_attested with a changed combined hash prevents initialisation', async () => {
    const store = createMemoryStore();
    const { event: stageA } = await publishEventAt(store, {
      kind: 'stage_a_deployed',
      cohortId: STAGE_A_COHORT,
      namespace: 'machine',
      body: stageABody(),
      at: '2026-08-09T08:00:00Z',
    });
    const { cohortId } = computeCohortFingerprint({
      stageAPayload: stageA.payload,
      combinedSha256: EXPECTATION_MANIFEST.combined_sha256,
      vendorLiveSha256: EXPECTATION_MANIFEST.vendor_live_expectations.sha256,
      deterministicEgressSha256: EXPECTATION_MANIFEST.deterministic_egress_expectations.sha256,
    });
    const { event: attested } = await publishEventAt(store, {
      kind: 'expectations_attested',
      cohortId,
      namespace: 'derek',
      body: {
        reviewer: 'Derek',
        attested_at: new Date(clockMs).toISOString(),
        combined_sha256: '9f'.repeat(32),
        vendor_live_sha256: '9e'.repeat(32),
        deterministic_egress_sha256: '9d'.repeat(32),
      },
    });
    await publishEventAt(store, {
      kind: 'cohort_initialized',
      cohortId,
      namespace: 'derek',
      body: {
        cohort_fingerprint: {},
        stage_a_event_hash: evidenceEventHash(stageA.payload),
        expectations_event_hash: evidenceEventHash(attested.payload),
      },
    });
    const fold = await foldNow(store, cohortId);
    expect(fold.holds.some((h) => h.code === 'expectation_hash_mismatch')).toBe(true);
    expect(fold.cohort_initialized).toBeNull();
  });

  test('semantic-oracle digest drift on the checked-out sources HOLDS', async () => {
    const store = createMemoryStore();
    const { cohortId } = await establishCohort(store);
    const fold = await computeFold(store, {
      cohortId,
      expectationManifest: EXPECTATION_MANIFEST,
      recomputedOracleDigest: 'DIFFERENT-DIGEST',
      liveDeployment: LIVE_OK,
    });
    expect(fold.holds.some((h) => h.code === 'semantic_oracle_digest_drift')).toBe(true);
    expect(fold.state).not.toBe('DONE');
  });

  test('deterministic walk: 1/3 → 2/3 → DONE on the third accepted day', async () => {
    const store = createMemoryStore();
    const { cohortId } = await establishCohort(store);
    await publishAcceptedDay(store, { cohortId, day: '2026-08-10', dayIndex: 1 });
    let fold = await foldNow(store, cohortId);
    expect(fold.state).toBe('HOLD_EVIDENCE');
    expect(fold.progress).toBe('1/3');
    expect(fold.accepted_days).toEqual(['2026-08-10']);

    await publishAcceptedDay(store, { cohortId, day: '2026-08-12', dayIndex: 2 });
    fold = await foldNow(store, cohortId);
    expect(fold.progress).toBe('2/3');

    await publishAcceptedDay(store, { cohortId, day: '2026-08-14', dayIndex: 3 });
    fold = await foldNow(store, cohortId);
    expect(fold.state).toBe('DONE');
    expect(fold.progress).toBe('3/3');
  });

  test('BLOCKED dominance: a safety fail flips a would-be DONE cohort to BLOCKED', async () => {
    const store = createMemoryStore();
    const { cohortId } = await establishCohort(store);
    for (const [i, day] of [
      ['2026-08-10', 1],
      ['2026-08-12', 2],
      ['2026-08-14', 3],
    ].map((x, i) => [i, x])) {
      await publishAcceptedDay(store, { cohortId, day: day[0], dayIndex: day[1] });
    }
    await publishAttempt(store, {
      cohortId,
      requirementKey: `ir:${cohortId}:rep-99`,
      requirementClass: 'pinned_ir',
      verdict: 'FAIL',
      repetitionOrdinal: 99,
      at: '2026-08-14T20:00:00Z',
    });
    const fold = await foldNow(store, cohortId);
    expect(fold.state).toBe('BLOCKED');
  });

  test('a saved DONE cannot survive runtime drift: STALE_DEPLOYMENT holds', async () => {
    const store = createMemoryStore();
    const { cohortId } = await establishCohort(store);
    for (const [day, idx] of [
      ['2026-08-10', 1],
      ['2026-08-12', 2],
      ['2026-08-14', 3],
    ]) {
      await publishAcceptedDay(store, { cohortId, day, dayIndex: idx });
    }
    let fold = await foldNow(store, cohortId);
    expect(fold.state).toBe('DONE');
    fold = await foldNow(store, cohortId, {
      live: { available: true, fingerprint_matches: false, reason: 'deployment_drift' },
    });
    expect(fold.state).toBe('HOLD_EVIDENCE');
    expect(fold.stale_deployment).toBe(true);
    fold = await foldNow(store, cohortId, {
      live: { available: false, fingerprint_matches: false },
    });
    expect(fold.state).toBe('HOLD_EVIDENCE');
    expect(fold.stale_deployment).toBe(true);
  });

  test('terminals published BEFORE cohort initialisation are INVALID (after-deployment rule)', async () => {
    const store = createMemoryStore();
    // Stage A + attested, but attempts land BEFORE cohort_initialized.
    const { event: stageA } = await publishEventAt(store, {
      kind: 'stage_a_deployed',
      cohortId: STAGE_A_COHORT,
      namespace: 'machine',
      body: stageABody(),
      at: '2026-08-09T08:00:00Z',
    });
    const { cohortId, fingerprint } = computeCohortFingerprint({
      stageAPayload: stageA.payload,
      combinedSha256: EXPECTATION_MANIFEST.combined_sha256,
      vendorLiveSha256: EXPECTATION_MANIFEST.vendor_live_expectations.sha256,
      deterministicEgressSha256: EXPECTATION_MANIFEST.deterministic_egress_expectations.sha256,
    });
    await publishAttempt(store, {
      cohortId,
      requirementKey: `ir:${cohortId}:rep-1`,
      repetitionOrdinal: 1,
      at: '2026-08-09T09:00:00Z',
    });
    const { event: attested } = await publishEventAt(store, {
      kind: 'expectations_attested',
      cohortId,
      namespace: 'derek',
      body: {
        reviewer: 'Derek',
        attested_at: new Date(clockMs).toISOString(),
        combined_sha256: EXPECTATION_MANIFEST.combined_sha256,
        vendor_live_sha256: EXPECTATION_MANIFEST.vendor_live_expectations.sha256,
        deterministic_egress_sha256: EXPECTATION_MANIFEST.deterministic_egress_expectations.sha256,
      },
      at: '2026-08-09T10:00:00Z',
    });
    await publishEventAt(store, {
      kind: 'cohort_initialized',
      cohortId,
      namespace: 'derek',
      body: {
        cohort_fingerprint: fingerprint,
        stage_a_event_hash: evidenceEventHash(stageA.payload),
        expectations_event_hash: evidenceEventHash(attested.payload),
      },
      at: '2026-08-09T11:00:00Z',
    });
    const fold = await foldNow(store, cohortId);
    // The PENDING-side check fires first (the atomic reservation predates
    // deployment), which structurally covers the terminal too.
    expect(
      fold.invalid.some((i) =>
        i.problems.some(
          (p) =>
            p.code === 'pending_before_cohort_deployment' ||
            p.code === 'terminal_before_cohort_deployment'
        )
      )
    ).toBe(true);
  });
});

// ═══ I. collector + trusted deploy + role proofs ══════════════════════════

describe('I — collector pair audit', () => {
  test('a valid pair collects with zero problems', async () => {
    const store = createMemoryStore();
    const completion = eligibleCompletion({
      sessionId: 'sess_c',
      completedAt: '2026-08-10T09:55:00Z',
    });
    await writeManifestPair(store, { sessionId: 'sess_c', completion, at: '2026-08-10T10:00:00Z' });
    const pair = await collectSessionManifests(store, {
      deploymentFingerprint: FP,
      sessionId: 'sess_c',
    });
    expect(pair.problems).toEqual([]);
    expect(pair.start.manifest_kind).toBe('start');
    expect(pair.completion.manifest_kind).toBe('completion');
    expect(pair.published_at).toBeTruthy();
  });

  test('missing completion, delete markers, overwrites and rollover all reject', async () => {
    const store = createMemoryStore();
    const completion = eligibleCompletion({
      sessionId: 'sess_c2',
      completedAt: '2026-08-10T09:55:00Z',
    });
    await writeManifestPair(store, {
      sessionId: 'sess_c2',
      completion,
      at: '2026-08-10T10:00:00Z',
    });

    // Delete marker on one object.
    const { versions } = await store.listAllVersions({
      prefix: `${MANIFEST_PREFIX}/${FP}/sess_c2/`,
    });
    store._delete(versions[0].key);
    let pair = await collectSessionManifests(store, {
      deploymentFingerprint: FP,
      sessionId: 'sess_c2',
    });
    expect(pair.problems.some((p) => p.code === 'delete_marker_present')).toBe(true);

    // Overwrite (divergent same-key version).
    const store2 = createMemoryStore();
    await writeManifestPair(store2, {
      sessionId: 'sess_c3',
      completion: eligibleCompletion({ sessionId: 'sess_c3', completedAt: '2026-08-10T09:55:00Z' }),
      at: '2026-08-10T10:00:00Z',
    });
    const v2 = await store2.listAllVersions({ prefix: `${MANIFEST_PREFIX}/${FP}/sess_c3/` });
    store2._putUnconditional(v2.versions[0].key, Buffer.from('{"evil":true}'));
    pair = await collectSessionManifests(store2, {
      deploymentFingerprint: FP,
      sessionId: 'sess_c3',
    });
    expect(pair.problems.some((p) => p.code === 'same_key_divergent_bytes')).toBe(true);

    // Missing pair entirely.
    pair = await collectSessionManifests(store2, {
      deploymentFingerprint: FP,
      sessionId: 'sess_none',
    });
    expect(pair.problems.some((p) => p.code === 'start_manifest_missing')).toBe(true);
    expect(pair.problems.some((p) => p.code === 'completion_manifest_missing')).toBe(true);

    // Task rollover: start/completion identity disagreement.
    const store3 = createMemoryStore();
    const c4 = eligibleCompletion({ sessionId: 'sess_c4', completedAt: '2026-08-10T09:55:00Z' });
    const start4 = {
      schema_version: 1,
      manifest_kind: 'start',
      session_id: 'sess_c4',
      boundary: 'session_started',
      started_at: '2026-08-10T09:00:00Z',
      deployment: {
        ...c4.deployment,
        identity: { ...c4.deployment.identity, task_revision: '376' },
      },
    };
    for (const manifest of [start4, c4]) {
      const bytes = canonicalBytes(manifest);
      const hash = createHash('sha256').update(bytes).digest('hex');
      await publishDurable(store3, {
        key: `${MANIFEST_PREFIX}/${FP}/sess_c4/${manifest.manifest_kind}-${hash}.json`,
        bytes,
      });
    }
    pair = await collectSessionManifests(store3, {
      deploymentFingerprint: FP,
      sessionId: 'sess_c4',
    });
    expect(pair.problems.some((p) => p.code === 'start_completion_identity_disagreement')).toBe(
      true
    );
  });

  test('null deployment identity (non-ECS/local session) rejects at collection', async () => {
    const store = createMemoryStore();
    const completion = eligibleCompletion({
      sessionId: 'sess_c5',
      completedAt: '2026-08-10T09:55:00Z',
      overrides: {
        deployment: {
          identity: null,
          identity_unavailable_reason: 'no_ecs_metadata_uri',
          fingerprint: FP,
        },
      },
    });
    await writeManifestPair(store, {
      sessionId: 'sess_c5',
      completion,
      at: '2026-08-10T10:00:00Z',
    });
    const pair = await collectSessionManifests(store, {
      deploymentFingerprint: FP,
      sessionId: 'sess_c5',
    });
    expect(pair.problems.some((p) => p.code === 'deployment_identity_missing')).toBe(true);
  });
});

describe('I — trusted deploy + task-role proof', () => {
  const GOOD_RUN = {
    repository: 'derek570/EICR-',
    workflow_path: '.github/workflows/deploy.yml',
    event: 'push',
    ref: 'refs/heads/main',
    head_sha: 'a'.repeat(40),
    conclusion: 'success',
    artifact_name: null,
    jobs: [{ name: 'Deploy to AWS ECS (Production)', conclusion: 'success' }],
  };

  test('a good run verifies; wrong repo / failed deploy job / wrong sha reject', async () => {
    const ok = await verifyTrustedDeploy({
      runId: 1,
      headSha: 'a'.repeat(40),
      fetchRun: async () => GOOD_RUN,
    });
    expect(ok.ok).toBe(true);
    const badRepo = await verifyTrustedDeploy({
      runId: 1,
      headSha: 'a'.repeat(40),
      fetchRun: async () => ({ ...GOOD_RUN, repository: 'evil/repo' }),
    });
    expect(badRepo.ok).toBe(false);
    const badJob = await verifyTrustedDeploy({
      runId: 1,
      headSha: 'a'.repeat(40),
      fetchRun: async () => ({
        ...GOOD_RUN,
        jobs: [{ name: 'Deploy to AWS ECS (Production)', conclusion: 'failure' }],
      }),
    });
    expect(badJob.ok).toBe(false);
    expect(badJob.errors).toContain('deploy_job_not_successful');
    const badSha = await verifyTrustedDeploy({
      runId: 1,
      headSha: 'b'.repeat(40),
      fetchRun: async () => GOOD_RUN,
    });
    expect(badSha.ok).toBe(false);
  });

  test('IAM role proof: effective-permission simulation — allowed proves; ANY deny refuses', async () => {
    const runner = (decisions) => async (args) => {
      const cmd = args.join(' ');
      if (cmd.startsWith('ecs describe-task-definition')) {
        return { taskDefinition: { taskRoleArn: 'arn:aws:iam::1:role/eicr-task-role' } };
      }
      if (cmd.startsWith('iam simulate-principal-policy')) {
        return {
          EvaluationResults: [
            { EvalActionName: 's3:PutObject', EvalDecision: decisions[0] },
            { EvalActionName: 's3:GetObject', EvalDecision: decisions[1] },
          ],
        };
      }
      throw new Error(`unexpected ${cmd}`);
    };
    const yes = await proveTaskRolePrefixAccessViaIam({
      awsRunner: runner(['allowed', 'allowed']),
      taskDefArn: 'x',
    });
    expect(yes.proven).toBe(true);
    for (const decisions of [
      ['allowed', 'implicitDeny'],
      ['explicitDeny', 'allowed'],
    ]) {
      const no = await proveTaskRolePrefixAccessViaIam({
        awsRunner: runner(decisions),
        taskDefArn: 'x',
      });
      expect(no.proven).toBe(false);
    }
  });
});

// ═══ J. Codex cycle-1 fix coverage ════════════════════════════════════════

describe('J — cycle-1: real-traffic route normalization', () => {
  test('an inspector_live round with returned tier `priority` satisfies the Luna-Fast gate', async () => {
    const store = createMemoryStore();
    const { cohortId } = await establishCohort(store);
    await bindAndAttestDay(store, {
      cohortId,
      sessionId: 'sess_rt',
      day: '2026-08-10',
      completedAt: '2026-08-10T09:55:00Z',
      completionOverrides: {
        evidence: {
          round_usage: {
            rounds: [
              inspectorRound({
                billable_kind: 'inspector_live',
                billing_tier: 'priority',
                response_tier: 'priority',
                billing_model: 'gpt-5.6-luna-2026-06',
              }),
              terraRound({ billable_kind: 'inspector_live' }),
            ],
          },
        },
      },
    });
    const fold = await foldNow(store, cohortId);
    const day = fold.day_evaluations.find((d) => d.day === '2026-08-10');
    expect(day.requirements.luna_fast_round).toBe(true);
    expect(day.requirements.terra_observation_round).toBe(true);
  });

  test('an inspector_extraction (direct-ingest default) Luna row does NOT satisfy the ordinary-reading gate', async () => {
    const store = createMemoryStore();
    const { cohortId } = await establishCohort(store);
    await bindAndAttestDay(store, {
      cohortId,
      sessionId: 'sess_ie',
      day: '2026-08-10',
      completedAt: '2026-08-10T09:55:00Z',
      completionOverrides: {
        evidence: {
          round_usage: { rounds: [inspectorRound({ billable_kind: 'inspector_extraction' })] },
        },
      },
    });
    const fold = await foldNow(store, cohortId);
    const day = fold.day_evaluations.find((d) => d.day === '2026-08-10');
    expect(day.requirements.luna_fast_round).toBe(false);
  });

  test('an UNATTRIBUTED Terra-shaped row never satisfies the Terra gate', async () => {
    const store = createMemoryStore();
    const { cohortId } = await establishCohort(store);
    await bindAndAttestDay(store, {
      cohortId,
      sessionId: 'sess_ua',
      day: '2026-08-10',
      completedAt: '2026-08-10T09:55:00Z',
      completionOverrides: {
        evidence: {
          round_usage: {
            rounds: [inspectorRound(), terraRound({ attribution_status: 'validation_error' })],
          },
        },
      },
    });
    const fold = await foldNow(store, cohortId);
    const day = fold.day_evaluations.find((d) => d.day === '2026-08-10');
    expect(day.requirements.terra_observation_round).toBe(false);
  });
});

describe('J — cycle-1: generation-chain ordering', () => {
  test('a replacement whose PENDING predates the predecessor terminal BLOCKS', async () => {
    const store = createMemoryStore();
    const { cohortId } = await establishCohort(store);
    const key = `ir:${cohortId}:rep-40`;
    // Gen 2 pending is reserved BEFORE gen 1's INVALID terminal exists.
    const { candidate: g1 } = await publishAttempt(store, {
      cohortId,
      requirementKey: key,
      generation: 1,
      verdict: 'INVALID',
      providerIds: [],
      repetitionOrdinal: 40,
      skipTerminal: true,
      at: '2026-08-10T09:00:00Z',
    });
    // Reserve gen 2 now (09:05), then publish gen 1's terminal later (09:10).
    tickClock(store, '2026-08-10T09:05:00Z');
    const allocationVersionId = await ensureOrdinal(store, {
      cohortId,
      lane: 'ir-repetition',
      ordinal: 40,
    });
    const g2 = buildAttemptCandidate({
      cohortId,
      requirementKey: key,
      generation: 2,
      requirement: {
        requirementClass: 'pinned_ir',
        model: 'gpt-5.6-luna',
        tier: 'fast',
        allocationVersionId,
        ...TEST_DIGESTS,
      },
    });
    await reserveAttempt(store, g2, { dispatchLatch: { begun: false } });
    tickClock(store, '2026-08-10T09:10:00Z');
    await publishEventAt(store, {
      kind: 'attempt_terminal',
      cohortId,
      namespace: 'machine',
      body: {
        requirement_key: key,
        attempt_ref: g1.attemptRef,
        attempt_generation: 1,
        requirement_class: 'pinned_ir',
        verdict: 'INVALID',
        model: 'gpt-5.6-luna',
        tier: 'fast',
        allocation_version_id: allocationVersionId,
        prompt_digest: 'pd',
        tool_digest: 'td',
        expectation_digest: '2b'.repeat(32),
        report_digest: 'r1',
        provider_call_ids: [],
        generated_at: '2026-08-10T09:09:00Z',
        repetition_ordinal: 40,
      },
    });
    tickClock(store, '2026-08-10T09:20:00Z');
    const g2Report = {
      schema_version: 1,
      kind: 'attempt_report',
      requirement_key: key,
      attempt_generation: 2,
      verdict: 'PASS',
      provider_call_ids: ['p_g2'],
      mismatch: null,
    };
    const g2ReportDigest = evidenceEventHash(g2Report);
    const g2Sample = evidenceEventHash({
      provider_call_ids: ['p_g2'],
      deployment_fingerprint: FP,
      requirement_key: key,
      model: 'gpt-5.6-luna',
      tier: 'fast',
      prompt_digest: 'pd',
      tool_digest: 'td',
      expectation_digest: '2b'.repeat(32),
    });
    await publishDurable(store, {
      key: `${EVIDENCE_PREFIX}/reports/${cohortId}/${g2ReportDigest}.json`,
      bytes: canonicalBytes(g2Report),
    });
    await publishEventAt(store, {
      kind: 'attempt_terminal',
      cohortId,
      namespace: 'machine',
      body: {
        requirement_key: key,
        attempt_ref: g2.attemptRef,
        attempt_generation: 2,
        requirement_class: 'pinned_ir',
        verdict: 'PASS',
        model: 'gpt-5.6-luna',
        tier: 'fast',
        allocation_version_id: allocationVersionId,
        prompt_digest: 'pd',
        tool_digest: 'td',
        expectation_digest: '2b'.repeat(32),
        report_digest: g2ReportDigest,
        provider_call_ids: ['p_g2'],
        sample_identity: g2Sample,
        generated_at: '2026-08-10T09:19:00Z',
        repetition_ordinal: 40,
      },
    });
    const fold = await foldNow(store, cohortId);
    expect(fold.blocks.some((b) => b.code === 'replacement_before_predecessor_terminal')).toBe(
      true
    );
  });

  test('a replacement generation after a VALID terminal BLOCKS', async () => {
    const store = createMemoryStore();
    const { cohortId } = await establishCohort(store);
    const key = `ir:${cohortId}:rep-41`;
    await publishAttempt(store, {
      cohortId,
      requirementKey: key,
      generation: 1,
      verdict: 'PASS',
      repetitionOrdinal: 41,
      at: '2026-08-10T09:00:00Z',
    });
    await publishAttempt(store, {
      cohortId,
      requirementKey: key,
      generation: 2,
      verdict: 'INVALID',
      providerIds: [],
      repetitionOrdinal: 41,
      at: '2026-08-10T09:30:00Z',
    });
    const fold = await foldNow(store, cohortId);
    expect(
      fold.blocks.some(
        (b) =>
          b.code === 'replacement_after_valid_terminal' ||
          b.code === 'valid_terminal_not_final_generation'
      )
    ).toBe(true);
  });
});

describe('J — cycle-1: binding + scoping integrity', () => {
  test('a bound event whose recorded manifest hashes mismatch the collected pair is INVALID', async () => {
    const store = createMemoryStore();
    const { cohortId } = await establishCohort(store);
    const completion = eligibleCompletion({
      sessionId: 'sess_bh',
      completedAt: '2026-08-10T09:55:00Z',
    });
    await writeManifestPair(store, {
      sessionId: 'sess_bh',
      completion,
      at: '2026-08-10T10:00:00Z',
    });
    await publishEventAt(store, {
      kind: 'production_session_bound',
      cohortId,
      namespace: 'machine',
      body: {
        field_session_id: 'sess_bh',
        deployment_fingerprint: FP,
        start_manifest: { content_hash: 'f'.repeat(64) },
        completion_manifest: { content_hash: 'f'.repeat(64) },
      },
      at: '2026-08-10T10:05:00Z',
    });
    const fold = await foldNow(store, cohortId);
    expect(fold.holds.some((h) => h.code === 'session_binding_invalid')).toBe(true);
  });

  test('records under a FOREIGN cohort prefix cannot contribute — integrity hold', async () => {
    const store = createMemoryStore();
    const { cohortId } = await establishCohort(store);
    // A structurally valid decision event under a DIFFERENT cohort id fed
    // into this fold's record set.
    await publishEventAt(store, {
      kind: 'non_safety_decision',
      cohortId: 'cohort-foreign000001',
      namespace: 'derek',
      body: {
        mismatch_id: 'mm_x',
        decision: 'approved',
        reviewer: 'Derek',
        decided_at: new Date(clockMs).toISOString(),
      },
    });
    const { loadAuditedPrefix: load } = await import('../../scripts/plan00-evidence/lib/store.mjs');
    const all = await load(store, `${EVIDENCE_PREFIX}/events/`);
    const stageA = all.records.filter((r) => r.key.includes(`/${STAGE_A_COHORT}/`));
    const rest = all.records.filter((r) => !r.key.includes(`/${STAGE_A_COHORT}/`));
    const fold = foldEvidence({
      stageARecords: stageA,
      cohortId,
      cohortRecords: rest, // includes the foreign record
      reservationRecords: [],
      integrityHolds: [],
      manifestsBySession: new Map(),
      expectationManifest: EXPECTATION_MANIFEST,
      recomputedOracleDigest: EXPECTATION_MANIFEST.semantic_oracle_digest,
      liveDeployment: LIVE_OK,
    });
    expect(fold.holds.some((h) => h.code === 'record_outside_fold_cohort')).toBe(true);
  });

  test('a manifest-named NON-SAFETY gap stratum deferral is accepted (but reduces no fixture set)', async () => {
    const store = createMemoryStore();
    const { cohortId } = await establishCohort(store);
    await publishEventAt(store, {
      kind: 'corpus_gap_decision',
      cohortId,
      namespace: 'derek',
      body: {
        stratum_or_fixture: 'multi_board_routing',
        decision: 'approved',
        safety_critical: false,
        reviewer: 'Derek',
        decided_at: new Date(clockMs).toISOString(),
      },
    });
    const fold = await computeFold(store, {
      cohortId,
      expectationManifest: {
        ...EXPECTATION_MANIFEST,
        strata_named_gaps: [{ stratum: 'multi_board_routing', safety_critical: false }],
      },
      recomputedOracleDigest: EXPECTATION_MANIFEST.semantic_oracle_digest,
      liveDeployment: LIVE_OK,
    });
    expect(fold.holds.some((h) => h.code === 'corpus_gap_decision_invalid')).toBe(false);
  });

  test('an unknown corpus-gap deferral target is INVALID and defers nothing', async () => {
    const store = createMemoryStore();
    const { cohortId } = await establishCohort(store);
    await publishEventAt(store, {
      kind: 'corpus_gap_decision',
      cohortId,
      namespace: 'derek',
      body: {
        stratum_or_fixture: 'not-a-real-fixture',
        decision: 'approved',
        safety_critical: false,
        reviewer: 'Derek',
        decided_at: new Date(clockMs).toISOString(),
      },
    });
    const fold = await foldNow(store, cohortId);
    expect(fold.holds.some((h) => h.code === 'corpus_gap_decision_invalid')).toBe(true);
  });
});

describe('J — cycle-1: the runner protocol', () => {
  const { default: _unused } = {};

  async function runnerCohort() {
    const store = createMemoryStore();
    const { cohortId } = await establishCohort(store);
    return { store, cohortId };
  }

  test('a PASS execution with provider ids publishes exactly one PASS terminal echoing the PENDING', async () => {
    const { runReservedAttempt } = await import('../../scripts/plan00-evidence/lib/runner.mjs');
    const { store, cohortId } = await runnerCohort();
    tickClock(store, '2026-08-10T09:00:00Z');
    const res = await runReservedAttempt(store, {
      cohortId,
      requirementKey: `ir:${cohortId}:rep-1`,
      generation: 1,
      requirementClass: 'pinned_ir',
      model: 'gpt-5.6-luna',
      tier: 'fast',
      repetitionOrdinal: 1,
      execute: async () => ({
        verdict: 'PASS',
        reportDigest: 'rep',
        providerCallIds: ['prov_1'],
      }),
      nowIso: () => new Date(clockMs).toISOString(),
    });
    expect(res.dispatched).toBe(true);
    expect(res.verdict).toBe('PASS');
    expect(res.terminalPublished).toBe(true);
    const fold = await foldNow(store, cohortId);
    expect(fold.blocks).toEqual([]);
    expect(fold.holds.filter((h) => h.code === 'orphan_pending')).toEqual([]);
  });

  test('a throwing executor publishes an INVALID terminal (infrastructure, never semantic)', async () => {
    const { runReservedAttempt } = await import('../../scripts/plan00-evidence/lib/runner.mjs');
    const { store, cohortId } = await runnerCohort();
    tickClock(store, '2026-08-10T09:00:00Z');
    const res = await runReservedAttempt(store, {
      cohortId,
      requirementKey: `ir:${cohortId}:rep-2`,
      generation: 1,
      requirementClass: 'pinned_ir',
      model: 'gpt-5.6-luna',
      tier: 'fast',
      repetitionOrdinal: 2,
      execute: async () => {
        throw new Error('provider down');
      },
      nowIso: () => new Date(clockMs).toISOString(),
    });
    expect(res.verdict).toBe('INVALID');
    expect(res.terminalPublished).toBe(true);
    const fold = await foldNow(store, cohortId);
    expect(fold.holds.some((h) => h.code === 'invalid_awaiting_replacement')).toBe(true);
  });

  test('a PASS with ZERO provider ids is DOWNGRADED to INVALID — never fabricated identity', async () => {
    const { runReservedAttempt } = await import('../../scripts/plan00-evidence/lib/runner.mjs');
    const { store, cohortId } = await runnerCohort();
    tickClock(store, '2026-08-10T09:00:00Z');
    const res = await runReservedAttempt(store, {
      cohortId,
      requirementKey: `ir:${cohortId}:rep-3`,
      generation: 1,
      requirementClass: 'pinned_ir',
      model: 'gpt-5.6-luna',
      tier: 'fast',
      repetitionOrdinal: 3,
      execute: async () => ({ verdict: 'PASS', reportDigest: 'rep', providerCallIds: [] }),
      nowIso: () => new Date(clockMs).toISOString(),
    });
    expect(res.verdict).toBe('INVALID');
    expect(res.reason).toBe('provider_ids_unavailable');
  });

  test('losing the reservation race means ZERO dispatch and ZERO terminal', async () => {
    const { runReservedAttempt } = await import('../../scripts/plan00-evidence/lib/runner.mjs');
    const { store, cohortId } = await runnerCohort();
    tickClock(store, '2026-08-10T09:00:00Z');
    const winner = buildAttemptCandidate({
      cohortId,
      requirementKey: `ir:${cohortId}:rep-4`,
      generation: 1,
      requirement: { requirementClass: 'pinned_ir', model: 'gpt-5.6-luna', tier: 'fast' },
    });
    await reserveAttempt(store, winner, { dispatchLatch: { begun: false } });
    let executed = false;
    const res = await runReservedAttempt(store, {
      cohortId,
      requirementKey: `ir:${cohortId}:rep-4`,
      generation: 1,
      requirementClass: 'pinned_ir',
      model: 'gpt-5.6-luna',
      tier: 'fast',
      repetitionOrdinal: 4,
      execute: async () => {
        executed = true;
        return { verdict: 'PASS', reportDigest: 'x', providerCallIds: ['p'] };
      },
    });
    expect(res.dispatched).toBe(false);
    expect(executed).toBe(false);
    expect(res.reservation.otherWinner).toBe(true);
  });
});

describe('J — cycle-1: collector closed schemas', () => {
  test('a start manifest carrying a completion field (even null) rejects', async () => {
    const store = createMemoryStore();
    const good = eligibleCompletion({ sessionId: 'sess_cs', completedAt: '2026-08-10T09:55:00Z' });
    const badStart = {
      schema_version: 1,
      manifest_kind: 'start',
      session_id: 'sess_cs',
      boundary: 'session_started',
      started_at: '2026-08-10T09:00:00Z',
      deployment: good.deployment,
      completed_at: null,
    };
    tickClock(store, '2026-08-10T10:00:00Z');
    for (const manifest of [badStart, good]) {
      const bytes = canonicalBytes(manifest);
      const hash = createHash('sha256').update(bytes).digest('hex');
      await publishDurable(store, {
        key: `${MANIFEST_PREFIX}/${FP}/sess_cs/${manifest.manifest_kind}-${hash}.json`,
        bytes,
      });
    }
    const pair = await collectSessionManifests(store, {
      deploymentFingerprint: FP,
      sessionId: 'sess_cs',
    });
    expect(pair.problems.some((p) => p.code === 'start_manifest_completion_field_present')).toBe(
      true
    );
  });

  test('a completion manifest without the evidence projection rejects', async () => {
    const store = createMemoryStore();
    const good = eligibleCompletion({ sessionId: 'sess_ce', completedAt: '2026-08-10T09:55:00Z' });
    const bad = { ...good, evidence: { projection: 'something_else' } };
    tickClock(store, '2026-08-10T10:00:00Z');
    const start = {
      schema_version: 1,
      manifest_kind: 'start',
      session_id: 'sess_ce',
      boundary: 'session_started',
      started_at: '2026-08-10T09:00:00Z',
      deployment: good.deployment,
    };
    for (const manifest of [start, bad]) {
      const bytes = canonicalBytes(manifest);
      const hash = createHash('sha256').update(bytes).digest('hex');
      await publishDurable(store, {
        key: `${MANIFEST_PREFIX}/${FP}/sess_ce/${manifest.manifest_kind}-${hash}.json`,
        bytes,
      });
    }
    const pair = await collectSessionManifests(store, {
      deploymentFingerprint: FP,
      sessionId: 'sess_ce',
    });
    expect(pair.problems.some((p) => p.code === 'completion_evidence_projection_missing')).toBe(
      true
    );
  });
});

// ═══ K. cycle-2 fix coverage ══════════════════════════════════════════════

describe('K — cycle-2: cohort-wide single-use + reports + decisions', () => {
  test('reusing an IR ordinal on a LATER day (fresh requirement key) BLOCKS', async () => {
    const store = createMemoryStore();
    const { cohortId } = await establishCohort(store);
    await publishAttempt(store, {
      cohortId,
      requirementKey: `ir:${cohortId}:rep-1`,
      repetitionOrdinal: 1,
      at: '2026-08-10T09:00:00Z',
    });
    // Day 2 mints a DIFFERENT requirement key but claims the same ordinal.
    await publishAttempt(store, {
      cohortId,
      requirementKey: `ir:${cohortId}:rep-1-day2`,
      repetitionOrdinal: 1,
      at: '2026-08-12T09:00:00Z',
    });
    const fold = await foldNow(store, cohortId);
    expect(fold.blocks.some((b) => b.code === 'ir_ordinal_reuse_across_days')).toBe(true);
  });

  test('a WITHHELD report: FAIL still blocks (cannot hide), PASS can never count', async () => {
    const store = createMemoryStore();
    const { cohortId } = await establishCohort(store);
    // Publish a PASS terminal whose report object is then hidden by a
    // divergent overwrite (the audited reader drops it).
    await publishAttempt(store, {
      cohortId,
      requirementKey: `ir:${cohortId}:rep-7`,
      repetitionOrdinal: 7,
      at: '2026-08-10T09:00:00Z',
    });
    const { versions } = await store.listAllVersions({
      prefix: `${EVIDENCE_PREFIX}/reports/${cohortId}/`,
    });
    store._putUnconditional(versions[0].key, Buffer.from('{"tampered":true}'));
    const fold = await foldNow(store, cohortId);
    expect(
      fold.holds.some(
        (h) =>
          h.code === 'pass_report_missing' ||
          h.code === 'report_content_hash_mismatch' ||
          h.code === 'same_key_divergent_bytes'
      )
    ).toBe(true);
    expect(fold.state).not.toBe('DONE');
  });

  test('an unclassified vendor FAIL (no mismatch identity) is unwaivably BLOCKED', async () => {
    const store = createMemoryStore();
    const { cohortId } = await establishCohort(store);
    await publishAttempt(store, {
      cohortId,
      requirementKey: `corpus:${cohortId}:luna:run-1:fx1`,
      requirementClass: 'vendor_corpus',
      verdict: 'FAIL',
      modelLane: 'luna',
      corpusRunOrdinal: 1,
      fixtureId: 'fx1',
      at: '2026-08-10T09:00:00Z',
    });
    const fold = await foldNow(store, cohortId);
    expect(fold.blocks.some((b) => b.code === 'unclassified_mismatch_fail')).toBe(true);
  });

  test('a REJECTED mismatch decision is irreversible — a later approval cannot overwrite it', async () => {
    const store = createMemoryStore();
    const { cohortId } = await establishCohort(store);
    await publishAttempt(store, {
      cohortId,
      requirementKey: `corpus:${cohortId}:luna:run-1:fx1`,
      requirementClass: 'vendor_corpus',
      verdict: 'FAIL',
      modelLane: 'luna',
      corpusRunOrdinal: 1,
      fixtureId: 'fx1',
      mismatch: { mismatch_id: 'mm_rr', safety_critical: false },
      at: '2026-08-10T09:00:00Z',
    });
    for (const decision of ['rejected', 'approved']) {
      tickClock(store);
      await publishEventAt(store, {
        kind: 'non_safety_decision',
        cohortId,
        namespace: 'derek',
        body: {
          mismatch_id: 'mm_rr',
          decision,
          reviewer: 'Derek',
          decided_at: new Date(clockMs).toISOString(),
        },
      });
    }
    const fold = await foldNow(store, cohortId);
    expect(fold.state).toBe('BLOCKED');
    expect(fold.blocks.some((b) => b.code === 'non_safety_mismatch_rejected')).toBe(true);
  });

  test('a decision published BEFORE its mismatch terminal is INVALID', async () => {
    const store = createMemoryStore();
    const { cohortId } = await establishCohort(store);
    await publishEventAt(store, {
      kind: 'non_safety_decision',
      cohortId,
      namespace: 'derek',
      body: {
        mismatch_id: 'mm_early',
        decision: 'approved',
        reviewer: 'Derek',
        decided_at: new Date(clockMs).toISOString(),
      },
      at: '2026-08-10T08:00:00Z',
    });
    await publishAttempt(store, {
      cohortId,
      requirementKey: `corpus:${cohortId}:luna:run-1:fx1`,
      requirementClass: 'vendor_corpus',
      verdict: 'FAIL',
      modelLane: 'luna',
      corpusRunOrdinal: 1,
      fixtureId: 'fx1',
      mismatch: { mismatch_id: 'mm_early', safety_critical: false },
      at: '2026-08-10T09:00:00Z',
    });
    const fold = await foldNow(store, cohortId);
    expect(
      fold.invalid.some((i) => i.problems.some((p) => p.code === 'decision_predates_mismatch'))
    ).toBe(true);
    // The mismatch therefore stays UNDECIDED (held), never silently approved.
    expect(fold.holds.some((h) => h.code === 'undecided_non_safety_mismatch')).toBe(true);
  });

  test('a wrong-model pinned-IR terminal (Terra on the IR lane) is INVALID', async () => {
    const store = createMemoryStore();
    const { cohortId } = await establishCohort(store);
    await publishAttempt(store, {
      cohortId,
      requirementKey: `ir:${cohortId}:rep-1`,
      repetitionOrdinal: 1,
      model: 'gpt-5.6-terra',
      tier: 'standard',
      at: '2026-08-10T09:00:00Z',
    });
    const fold = await foldNow(store, cohortId);
    expect(
      fold.invalid.some((i) =>
        i.problems.some((p) => p.code === 'terminal_model_contract_violation')
      )
    ).toBe(true);
  });

  test('pre-initialisation live-deployment drift already HOLDS as STALE_DEPLOYMENT', async () => {
    const store = createMemoryStore();
    await publishEventAt(store, {
      kind: 'stage_a_deployed',
      cohortId: STAGE_A_COHORT,
      namespace: 'machine',
      body: stageABody(),
      at: '2026-08-09T08:00:00Z',
    });
    const fold = await foldNow(store, null, {
      live: { available: true, fingerprint_matches: false, reason: 'deployment_drift' },
    });
    expect(fold.state).toBe('HOLD_EVIDENCE');
    expect(fold.stale_deployment).toBe(true);
  });
});
