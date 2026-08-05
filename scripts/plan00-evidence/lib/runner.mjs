/**
 * Plan 00C §C2 — the authoritative attempt runner protocol.
 *
 * One shared harness for the pinned-IR and vendor-corpus commands: allocate
 * the cohort-wide logical ordinal (new work only), create + read back the
 * atomic per-attempt-generation PENDING, set the invocation-local dispatch
 * latch IMMEDIATELY before provider dispatch, execute the injected lane
 * executor, and publish EXACTLY ONE PASS/FAIL/INVALID terminal before
 * returning — a thrown executor is an INVALID terminal (infrastructure
 * failure is never semantic pass/fail), and an executor result carrying no
 * provider ids on a non-INVALID verdict is DOWNGRADED to INVALID with a
 * named reason (fail closed, never fabricated ids).
 *
 * There is NO live executor yet: the enumerated Plan 00B lane machinery is
 * mock/replay-only and mock verdicts must never enter the evidence store,
 * so the CLI run commands REFUSE before allocating anything. This protocol
 * is test-pinned against injected executors and a reviewed 00B successor
 * wires the real live dispatch (surfacing provider response ids) in.
 */

import { canonicalBytes, evidenceEventHash } from '../../field-replay/lib/canonical-crypto.mjs';
import { EVIDENCE_PREFIX } from './constants.mjs';
import { buildEvent, validateAttemptReport, validateStoredEvent } from './events.mjs';
import { publishDurable } from './store.mjs';

/** Content-addressed report key (the fold audits this prefix; a withheld
 *  or altered report can never hide behind its terminal). */
export function reportKey({ cohortId, reportDigest }) {
  return `${EVIDENCE_PREFIX}/reports/${cohortId}/${reportDigest}.json`;
}
import { allocateOrdinal, buildAttemptCandidate, buildOrdinalCandidate, reserveAttempt } from './reservations.mjs';

/** Map the semantic-judge verdict vocabulary onto terminal verdicts. */
export function mapLaneVerdict(laneVerdict) {
  if (laneVerdict === 'PASS') return 'PASS';
  if (laneVerdict === 'FAIL') return 'FAIL';
  return 'INVALID'; // INVALID_HOLD and anything unknown fail closed
}

/** Allocate the next unused ordinal in a lane, refolding between attempts
 *  (a taken ordinal means another contender won — pick the NEXT unused,
 *  never re-dispatch). */
export async function allocateNextOrdinal(store, { cohortId, lane, startAt = 1, maxScan = 10000 }) {
  for (let ordinal = startAt; ordinal < startAt + maxScan; ordinal += 1) {
    const candidate = buildOrdinalCandidate({ cohortId, lane, ordinal });
    const res = await allocateOrdinal(store, candidate);
    if (res.allocated) return { ordinal, versionId: res.versionId };
    if (res.taken) continue;
    return { hold: res.hold };
  }
  return { hold: { code: 'ordinal_scan_exhausted', lane } };
}

/**
 * Run ONE reserved attempt end-to-end. `execute()` is the provider dispatch
 * (injected; the CLI wires the live lane) returning
 * { verdict: 'PASS'|'FAIL'|'INVALID', reportDigest, providerCallIds,
 *   sampleIdentity?, mismatch?, reason? }.
 */
export async function runReservedAttempt(
  store,
  {
    cohortId,
    requirementKey,
    generation,
    requirementClass,
    model,
    tier,
    allocationVersionId = null,
    deploymentFingerprint = null,
    promptDigest = null,
    toolDigest = null,
    expectationDigest = null,
    repetitionOrdinal = null,
    corpusRunOrdinal = null,
    fixtureId = null,
    modelLane = null,
    execute,
    nowIso = () => new Date().toISOString(),
  }
) {
  const candidate = buildAttemptCandidate({
    cohortId,
    requirementKey,
    generation,
    requirement: {
      requirementClass,
      model,
      tier,
      allocationVersionId,
      promptDigest,
      toolDigest,
      expectationDigest,
    },
  });
  const dispatchLatch = { begun: false };
  const reservation = await reserveAttempt(store, candidate, { dispatchLatch });
  if (!reservation.authorised) {
    // Another winner or an integrity hold — this invocation calls NO
    // provider and publishes NO terminal.
    return { dispatched: false, reservation };
  }

  let outcome;
  dispatchLatch.begun = true;
  try {
    outcome = await execute();
    // Cycle-3 — a malformed executor RESULT is a harness failure exactly
    // like a throw: normalise to INVALID, never dereference blind (an
    // orphan PENDING here would be an avoidable cohort-ender).
    if (!outcome || typeof outcome !== 'object') {
      outcome = {
        verdict: 'INVALID',
        providerCallIds: [],
        reason: 'executor_result_malformed',
      };
    }
  } catch (err) {
    outcome = {
      verdict: 'INVALID',
      providerCallIds: [],
      reason: `executor_threw:${err?.message ?? 'unknown'}`,
    };
  }

  let verdict = outcome.verdict === 'PASS' || outcome.verdict === 'FAIL' ? outcome.verdict : 'INVALID';
  let reason = outcome.reason ?? null;
  // Cycle-5 — the mismatch is NORMALISED ONCE into the closed shape and
  // that normalised value (or nothing) is what reaches BOTH the report and
  // the terminal: a malformed executor mismatch (extra prose, customer
  // data) can never leak into the append-only stream.
  //
  // 00B-4 §C1a — the normaliser is a WHITELIST, so it silently DESTROYED any
  // field it did not name. `mismatch_kind` is now carried explicitly, and a
  // kind-less executor FAIL terminates INVALID rather than persisting a
  // mismatch nothing downstream can classify: the fold's only alternative
  // would be an irreversible `unclassified_mismatch_fail` BLOCK on evidence
  // that was merely mis-plumbed. Note this rebuild is what keeps the free-form
  // half out — the judge's `reason` string and its raw expected/actual detail
  // (field values, transcript fragments, circuit text) are dropped HERE and
  // exist only in the run console.
  let mismatch = null;
  if (outcome.mismatch != null) {
    const mm = outcome.mismatch;
    if (
      mm &&
      typeof mm === 'object' &&
      typeof mm.mismatch_id === 'string' &&
      mm.mismatch_id.length > 0 &&
      typeof mm.mismatch_kind === 'string' &&
      mm.mismatch_kind.length > 0 &&
      typeof mm.safety_critical === 'boolean'
    ) {
      mismatch = {
        mismatch_id: mm.mismatch_id,
        mismatch_kind: mm.mismatch_kind,
        safety_critical: mm.safety_critical,
      };
    } else {
      verdict = 'INVALID';
      reason = 'mismatch_shape_invalid';
    }
  }
  if (verdict === 'PASS' && mismatch != null) {
    verdict = 'INVALID';
    reason = 'pass_with_mismatch';
    mismatch = null;
  }
  // Cycle-6 — STRICT: a malformed provider-id representation is a harness
  // failure, never sanitised down to the well-formed subset (the dropped
  // element would escape reuse checks and the sample identity).
  let providerCallIds;
  if (outcome.providerCallIds == null) {
    providerCallIds = [];
  } else if (
    Array.isArray(outcome.providerCallIds) &&
    outcome.providerCallIds.every((id) => typeof id === 'string' && id.length > 0)
  ) {
    providerCallIds = outcome.providerCallIds;
  } else {
    providerCallIds = [];
    verdict = 'INVALID';
    reason = 'provider_ids_malformed';
  }
  if (verdict !== 'INVALID' && providerCallIds.length === 0) {
    // Fail CLOSED: a semantic verdict without provider identity cannot
    // count; it stays replaceable under the same requirement key.
    verdict = 'INVALID';
    reason = 'provider_ids_unavailable';
  }
  // C2 — the sample identity is a terminal-evidence canonical hash of the
  // ordered provider-call ids, deployed fingerprint, requirement key,
  // model/tier and digests; caller timestamps/ids cannot alter it. Null
  // ONLY on INVALID.
  // Cycle-4 — the identity is computed whenever ORDERED PROVIDER IDS
  // exist, whatever the verdict; null ONLY for an INVALID terminal that
  // received no provider id. Never caller-supplied.
  const sampleIdentity =
    providerCallIds.length === 0
      ? null
      : evidenceEventHash({
          provider_call_ids: providerCallIds,
          deployment_fingerprint: deploymentFingerprint ?? null,
          requirement_key: requirementKey,
          model,
          tier,
          prompt_digest: promptDigest,
          tool_digest: toolDigest,
          expectation_digest: expectationDigest,
        });

  // Referenced-report integrity (C2): the canonical PII-free report is a
  // CLOSED schema BUILT HERE from validated fields only (never a free-form
  // executor object — that would be a PII/agreement hole), published
  // content-addressed BEFORE its terminal so the fold can cross-check the
  // terminal against it.
  let reportDigest = null;
  if (verdict !== 'INVALID') {
    const reportBody = {
      schema_version: 1,
      kind: 'attempt_report',
      requirement_key: requirementKey,
      attempt_generation: generation,
      verdict,
      provider_call_ids: providerCallIds,
      mismatch,
    };
    const reportProblems = validateAttemptReport(reportBody);
    if (reportProblems.length > 0) {
      verdict = 'INVALID';
      reason = `report_schema_invalid:${reportProblems[0].code}`;
    }
    reportDigest = reportProblems.length === 0 ? evidenceEventHash(reportBody) : null;
    const reportReceipt = reportProblems.length
      ? { ok: true }
      : await publishDurable(store, {
      key: reportKey({ cohortId, reportDigest }),
      bytes: canonicalBytes(reportBody),
    });
    if (!reportReceipt.ok) {
      verdict = 'INVALID';
      reason = `report_publish_failed:${reportReceipt.error}`;
      reportDigest = null;
    }
  }

  const body = {
    requirement_key: requirementKey,
    attempt_ref: candidate.attemptRef,
    attempt_generation: generation,
    requirement_class: requirementClass,
    verdict,
    model,
    tier,
    // The terminal ECHOES the atomic PENDING identity and digests.
    allocation_version_id: allocationVersionId,
    prompt_digest: promptDigest,
    tool_digest: toolDigest,
    expectation_digest: expectationDigest,
    report_digest: reportDigest,
    provider_call_ids: providerCallIds,
    sample_identity: sampleIdentity,
    generated_at: nowIso(),
    ...(reason != null ? { invalid_reason: reason } : {}),
    ...(repetitionOrdinal != null ? { repetition_ordinal: repetitionOrdinal } : {}),
    ...(corpusRunOrdinal != null ? { corpus_run_ordinal: corpusRunOrdinal } : {}),
    ...(fixtureId != null ? { fixture_id: fixtureId } : {}),
    ...(modelLane != null ? { model_lane: modelLane } : {}),
    ...(mismatch != null ? { mismatch } : {}),
  };
  const event = buildEvent({ kind: 'attempt_terminal', cohortId, namespace: 'machine', body });
  const problems = validateStoredEvent({ key: event.key, payload: event.payload });
  if (problems.length > 0) {
    return { dispatched: true, terminalPublished: false, problems, reservation };
  }
  const receipt = await publishDurable(store, { key: event.key, bytes: event.bytes });
  return {
    dispatched: true,
    terminalPublished: receipt.ok,
    receipt,
    verdict,
    reason,
    attemptRef: candidate.attemptRef,
    event,
    reservation,
  };
}
