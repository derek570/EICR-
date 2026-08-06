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
 * Dispatch AUTHORITY (00B-4 §C1b) is decided before anything is consumed.
 * Against the DURABLE evidence store the caller must hold a SEALED
 * live-dispatch capability (lib/live-capability.mjs) — an injected `execute`
 * is refused outright, so a mock verdict cannot be published as durable
 * evidence even by mistake. Injected fakes remain fully supported against the
 * in-memory store, which is itself structurally unable to be handed the S3
 * adapter. The gate runs BEFORE `buildAttemptCandidate`, so a refusal costs no
 * ordinal, no reservation and no provider call.
 */

import { canonicalBytes, evidenceEventHash } from '../../field-replay/lib/canonical-crypto.mjs';
import { EVIDENCE_PREFIX } from './constants.mjs';
import { laneOrdinals, resolveAllocationVersionId, summariseRun } from './dispatch-plan.mjs';
import { buildEvent, validateAttemptReport, validateStoredEvent } from './events.mjs';
import { assertDispatchAuthority } from './live-capability.mjs';
import { publishDurable } from './store.mjs';

/** Content-addressed report key (the fold audits this prefix; a withheld
 *  or altered report can never hide behind its terminal). */
export function reportKey({ cohortId, reportDigest }) {
  return `${EVIDENCE_PREFIX}/reports/${cohortId}/${reportDigest}.json`;
}
import {
  allocateOrdinal,
  buildAttemptCandidate,
  buildOrdinalCandidate,
  reserveAttempt,
} from './reservations.mjs';

/** Map the semantic-judge verdict vocabulary onto terminal verdicts. */
export function mapLaneVerdict(laneVerdict) {
  if (laneVerdict === 'PASS') return 'PASS';
  if (laneVerdict === 'FAIL') return 'FAIL';
  return 'INVALID'; // INVALID_HOLD and anything unknown fail closed
}

/**
 * Allocate — or ADOPT — the logical ordinal for a run (00B-4 §C1d).
 *
 * The old behaviour was to walk straight to the NEXT ordinal whenever
 * `allocateOrdinal` reported taken. Its docstring claimed a refold that never
 * happened, and the effect was the opposite of what the comment promised: two
 * coordinators racing the same lane produced two SIBLING runs, and a
 * coordinator that died after allocating an ordinal but before finishing its
 * requirements left an abandoned run that nobody would ever resume — the next
 * contender skipped past it. Both are duplicate vendor spend on evidence that
 * can never be reconciled.
 *
 * So a taken ordinal now triggers a REFOLD and a re-decision from the refolded
 * state:
 *   - the winning run is INCOMPLETE  ⇒ ADOPT it (same ordinal, same allocation
 *     VersionId) and resume only its outstanding requirements;
 *   - the refold proves it COMPLETE  ⇒ dispatch nothing, unless a new
 *     repetition was explicitly requested, in which case allocate beyond the
 *     highest existing ordinal;
 *   - anything the fold would call an integrity problem ⇒ HOLD.
 *
 * Adoption is COOPERATIVE and this function is NOT the exclusivity mechanism.
 * Two coordinators may legitimately adopt the same ordinal and derive the same
 * outstanding set; exclusivity lives one level down in the conditional-create
 * PENDING reservation per (requirement key, attempt generation), so the
 * guarantee is exactly-once provider dispatch per (requirement, generation) —
 * not zero work by the allocation loser.
 *
 * `refold` MUST return a dispatch state (see lib/dispatch-plan.mjs). It is
 * required: without it there is no way to re-decide, and silently falling back
 * to the old skip-ahead behaviour would reintroduce sibling runs. Absent ⇒ HOLD.
 *
 * @param {object} store
 * @param {{cohortId: string, lane: string, startAt?: number, maxScan?: number,
 *          refold?: () => Promise<object>,
 *          runRequirements?: (ordinal: number) => string[],
 *          requestNewRepetition?: boolean}} opts
 */
export async function allocateNextOrdinal(
  store,
  {
    cohortId,
    lane,
    startAt = 1,
    maxScan = 10000,
    refold = null,
    runRequirements = null,
    requestNewRepetition = false,
  }
) {
  if (typeof refold !== 'function' || typeof runRequirements !== 'function') {
    return { hold: { code: 'refold_unavailable', lane } };
  }
  let ordinal = startAt;
  const limit = startAt + maxScan;
  while (ordinal < limit) {
    const candidate = buildOrdinalCandidate({ cohortId, lane, ordinal });
    const res = await allocateOrdinal(store, candidate);
    if (res.allocated) {
      return {
        ordinal,
        versionId: res.versionId,
        adopted: false,
        dispatch: runRequirements(ordinal).map((requirementKey) => ({
          requirementKey,
          generation: 1,
          allocationVersionId: res.versionId,
          reason: 'no_prior_attempt',
        })),
      };
    }
    if (!res.taken) return { hold: res.hold };

    // Taken — somebody else owns this ordinal. Re-decide from the truth.
    const state = await refold();
    const existing = laneOrdinals(state, lane);
    if (existing.length === 0) {
      // The reservation exists (the conditional create said taken) but the
      // refold cannot see it. Adopting blind would bind an unknown allocation;
      // skipping ahead would create the sibling this whole loop exists to
      // prevent. Neither is safe, so hold.
      return { hold: { code: 'ordinal_taken_but_unfolded', lane, ordinal } };
    }
    let highest = 0;
    for (const entry of existing) {
      if (entry.ordinal > highest) highest = entry.ordinal;
      const summary = summariseRun(state, runRequirements(entry.ordinal));
      if (summary.hold) return { hold: { ...summary.hold, lane, ordinal: entry.ordinal } };
      if (summary.complete) continue;
      const resolved = resolveAllocationVersionId(entry, summary.echoedVersionIds);
      if (resolved.hold) return { hold: { ...resolved.hold, lane } };
      return {
        ordinal: entry.ordinal,
        versionId: resolved.versionId,
        adopted: true,
        dispatch: summary.dispatch.map((d) => ({
          ...d,
          allocationVersionId: d.allocationVersionId ?? resolved.versionId,
        })),
      };
    }
    // Every existing run in this lane is complete.
    if (!requestNewRepetition) {
      return {
        ordinal: highest || null,
        versionId: null,
        adopted: false,
        complete: true,
        dispatch: [],
      };
    }
    ordinal = Math.max(ordinal + 1, highest + 1);
  }
  return { hold: { code: 'ordinal_scan_exhausted', lane } };
}

/**
 * Run ONE reserved attempt end-to-end. The dispatch function returns
 * { verdict: 'PASS'|'FAIL'|'INVALID', reportDigest, providerCallIds,
 *   sampleIdentity?, mismatch?, reason? }.
 *
 * Exactly one of `execute` (a plain injected function — memory store only) and
 * `liveDispatch` (a sealed capability — required for the durable store) is
 * supplied; `assertDispatchAuthority` decides which is legitimate here and
 * returns the executor actually authorised to run.
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
    execute = null,
    liveDispatch = null,
    nowIso = () => new Date().toISOString(),
  }
) {
  // 00B-4 §C1b — authority FIRST. A refusal here must cost nothing: no
  // ordinal is bound, no PENDING is created, no provider is called.
  const dispatch = assertDispatchAuthority(store, { execute, liveDispatch });

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
    outcome = await dispatch();
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

  let verdict =
    outcome.verdict === 'PASS' || outcome.verdict === 'FAIL' ? outcome.verdict : 'INVALID';
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
