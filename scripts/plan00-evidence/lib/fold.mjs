/**
 * Plan 00C §C1/C4/C5 — THE deterministic fold.
 *
 * Pure: consumes version-audited records (loaded by the store reader) plus
 * the committed expectation manifest and an optional fresh live-deployment
 * check result, and returns the fold state + per-day progress + every hold
 * and block. JSON/Markdown, consumed ids, days and status are PROJECTIONS
 * of this fold only.
 *
 * Validation precedence (plan §C1, mandatory): schema/namespace →
 * reservation/PENDING pairing → attempt-ref/requirement identity →
 * referenced-report integrity → production-manifest/manual-reference
 * binding → ONLY THEN semantic outcome. A structurally invalid FAIL is
 * INVALID/HOLD, never BLOCKED. Conflicting terminals for one attempt are
 * ALWAYS an evidence-integrity BLOCK. HOLD is reserved for
 * PENDING/infrastructure/unattested expectations and undecided non-safety
 * mismatch.
 *
 * Determinism (Codex cycle-1): every record set is canonically ordered at
 * fold entry by (published_at, key); cohort-initialisation dependencies are
 * resolved by their EXPLICIT event hashes, never "the newest event"; and
 * every record is verified to belong to the cohort under fold before it can
 * contribute anything.
 */

import { evidenceEventHash } from '../../field-replay/lib/canonical-crypto.mjs';
import {
  FAST_TIERS,
  INSPECTOR_ROUND_BILLABLE_KINDS,
  IR_REPS_PER_DAY,
  LUNA_MODEL_FAMILY,
  REQUIRED_DAYS,
  SAFETY_BLOCKING_CLASSES,
  STAGE_A_COHORT,
  STANDARD_TIERS,
  TERRA_MODEL_FAMILY,
  londonDayOf,
} from './constants.mjs';
import { validateStoredEvent } from './events.mjs';
import { attemptPendingKey } from './reservations.mjs';

const CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Strict timestamp parse — a malformed timestamp must never coerce to NaN
 *  comparisons that silently pass (Codex cycle-1). */
function parseInstant(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function byReceiptThenKey(a, b) {
  const ta = parseInstant(a.published_at) ?? 0;
  const tb = parseInstant(b.published_at) ?? 0;
  if (ta !== tb) return ta - tb;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

// ── manifest-derived helpers ─────────────────────────────────────────────

/** Session evidence eligibility per the C5 fold rule: any freeze_invalid or
 *  producer_unknown row, any non-quiescent/unstable stop, any open ask at
 *  the boundary ⇒ INELIGIBLE (zero family credit for every family). */
export function sessionEvidenceEligible(completionManifest) {
  const ev = completionManifest?.evidence;
  if (!ev) return false;
  if (ev.eligible_for_family_credit !== true) return false;
  if ((ev.quiescence?.non_quiescent_at_stop ?? 1) !== 0) return false;
  if ((ev.quiescence?.revision_instability ?? 1) !== 0) return false;
  const asks = ev.open_asks ?? {};
  if ((asks.dispatcher ?? 1) !== 0) return false;
  if ((asks.dialogue_script ?? 1) !== 0) return false;
  if ((asks.address_mirror ?? 1) !== 0) return false;
  if ((ev.count_contradictions ?? []).length > 0) return false;
  if ((ev.rejection_regime_contradictions ?? []).length > 0) return false;
  if ((ev.lifecycle_state_contradictions ?? []).length > 0) return false;
  return true;
}

function allDeliveries(ev) {
  const out = [];
  for (const family of Object.keys(ev?.deliveries ?? {})) {
    for (const d of ev.deliveries[family]) out.push({ ...d, semantic_family: family });
  }
  return out;
}

function allPlaybacks(ev) {
  const out = [];
  for (const family of Object.keys(ev?.playbacks ?? {})) {
    for (const p of ev.playbacks[family]) out.push({ ...p, semantic_family: family });
  }
  return out;
}

/** Resolve a manual confirmation_ref (an exact op_key) inside one bound
 *  completion manifest. Returns the C4 verdict for that operation. */
export function resolveManualConfirmationRef(completionManifest, confirmationRef) {
  const ev = completionManifest?.evidence;
  if (!ev) return { resolved: false, reason: 'no_completion_evidence' };
  const deliveries = allDeliveries(ev).filter((d) => (d.op_keys ?? []).includes(confirmationRef));
  if (deliveries.length === 0) return { resolved: false, reason: 'confirmation_ref_unknown' };
  // The ref names ONE persisted logical operation; delivery-attempt count
  // may exceed one (fast + suppressed canonical, replays) without harm.
  const ambiguous = (ev.delivery_history_ambiguous_op_keys ?? []).some(
    (row) => row.op_key === confirmationRef
  );
  const playbackStarts = allPlaybacks(ev).filter((p) => p.op_key === confirmationRef);
  return {
    resolved: true,
    ambiguous,
    delivery_count: deliveries.length,
    playback_start_count: playbackStarts.length,
  };
}

/** Resolve a dialogue_delivery_ref (a delivery_ref like `d:2`) to exactly
 *  one operation-bound dialogue_script delivery whose operations carry no
 *  ambiguous lineage (Codex cycle-1). */
export function resolveDialogueDeliveryRef(completionManifest, deliveryRef) {
  const ev = completionManifest?.evidence;
  const rows = (ev?.deliveries?.dialogue_script ?? []).filter(
    (d) => d.delivery_ref === deliveryRef && (d.op_keys ?? []).length > 0
  );
  if (rows.length !== 1) {
    return { resolved: false, reason: rows.length === 0 ? 'ref_unknown' : 'ref_ambiguous' };
  }
  const ambiguousKeys = new Set((ev?.delivery_history_ambiguous_op_keys ?? []).map((r) => r.op_key));
  if (rows[0].op_keys.some((k) => ambiguousKeys.has(k))) {
    return { resolved: false, reason: 'delivery_lineage_ambiguous' };
  }
  return { resolved: true, row: rows[0] };
}

/** Family gates read from one bound completion manifest (00B-2 §C2). The
 *  address-mirror playback proof must name an operation actually delivered
 *  by an address-mirror row with unambiguous lineage — an aggregate boolean
 *  alone never satisfies the gate (Codex cycle-1). */
export function familyGatesOf(completionManifest) {
  const ev = completionManifest?.evidence;
  const gates = ev?.family_gates ?? {};
  const ambiguousKeys = new Set((ev?.delivery_history_ambiguous_op_keys ?? []).map((r) => r.op_key));
  const mirrorDeliveredOps = new Set(
    (ev?.deliveries?.address_mirror ?? []).flatMap((d) => d.op_keys ?? [])
  );
  const mirrorAckBound = (ev?.playbacks?.address_mirror ?? []).some(
    (p) =>
      p.producer_id === 'address_mirror_delivery_ack' &&
      mirrorDeliveredOps.has(p.op_key) &&
      !ambiguousKeys.has(p.op_key)
  );
  const dialogueUnambiguous = (ev?.deliveries?.dialogue_script ?? []).some(
    (d) => (d.op_keys ?? []).length > 0 && !d.op_keys.some((k) => ambiguousKeys.has(k))
  );
  return {
    dialogue_script:
      gates.dialogue_script?.ask_lifecycle_complete === true &&
      gates.dialogue_script?.operation_bound_delivery === true &&
      dialogueUnambiguous,
    address_mirror:
      gates.address_mirror?.ask_lifecycle_complete === true &&
      gates.address_mirror?.operation_bound_delivery === true &&
      gates.address_mirror?.playback_ack_proof === true &&
      mirrorAckBound,
  };
}

/** Round-usage gates (00B-2 §C2 counting rules, Codex-cycle-1 normalized).
 *  Luna-Fast counts ONLY attributed OpenAI rounds from accepted inspector
 *  kinds; billing_tier carries the RAW returned label so `priority` IS
 *  Fast; a Terra observation round is provable ONLY on the Responses
 *  transport with LOW effort and Standard/omitted tier; cache evidence
 *  requires a WARM read on the explicit route of an attributed inspector
 *  round (cold-only write rows are insufficient by design). */
export function roundUsageGatesOf(completionManifest) {
  const rounds = completionManifest?.evidence?.round_usage?.rounds ?? [];
  const inspector = rounds.filter(
    (r) =>
      INSPECTOR_ROUND_BILLABLE_KINDS.includes(r.billable_kind) &&
      r.provider === 'openai' &&
      r.attribution_status === 'attributed'
  );
  const isLuna = (r) => typeof r.billing_model === 'string' && r.billing_model.startsWith(LUNA_MODEL_FAMILY);
  const isTerra = (r) => typeof r.billing_model === 'string' && r.billing_model.startsWith(TERRA_MODEL_FAMILY);
  const lunaFast = inspector.some(
    (r) => isLuna(r) && (FAST_TIERS.includes(r.billing_tier) || FAST_TIERS.includes(r.response_tier))
  );
  const terraObservation = inspector.some(
    (r) =>
      isTerra(r) &&
      r.api_transport === 'responses' &&
      r.reasoning_effort === 'low' &&
      (r.billing_tier == null || STANDARD_TIERS.includes(r.billing_tier))
  );
  const explicitCacheRead = inspector.some(
    (r) =>
      (isLuna(r) || isTerra(r)) &&
      r.api_transport === 'responses' &&
      r.prompt_cache_mode === 'explicit' &&
      (r.cache_read_input_tokens ?? 0) > 0
  );
  return { lunaFast, terraObservation, explicitCacheRead };
}

// ── the fold ─────────────────────────────────────────────────────────────

export function foldEvidence({
  stageARecords = [],
  cohortId = null,
  cohortRecords = [],
  reservationRecords = [],
  reportRecords = [],
  integrityHolds = [],
  manifestsBySession = new Map(),
  expectationManifest = null,
  recomputedOracleDigest = null,
  liveDeployment = null,
}) {
  const holds = [...integrityHolds.map((h) => ({ tier: 'integrity', ...h }))];
  const blocks = [];
  const invalid = [];
  const notes = [];

  // Canonical total order — the fold is deterministic under any input
  // permutation (test-pinned by the shuffled-rebuild case).
  const stageASorted = [...stageARecords].sort(byReceiptThenKey);
  const cohortSorted = [...cohortRecords].sort(byReceiptThenKey);
  const reservationsSorted = [...reservationRecords].sort(byReceiptThenKey);

  // ── tier 1: schema/namespace + cohort scoping over every stored record ──
  const validEvents = [];
  for (const rec of [...stageASorted, ...cohortSorted]) {
    const problems = validateStoredEvent({ key: rec.key, payload: rec.payload });
    if (problems.length > 0) {
      invalid.push({ key: rec.key, problems });
      continue;
    }
    // Cohort scoping: a record can only contribute to the cohort whose
    // prefix it lives under AND that this fold was asked about.
    const isStageA = rec.key.includes(`/events/${STAGE_A_COHORT}/`);
    if (!isStageA && cohortId != null && rec.payload.cohort_id !== cohortId) {
      holds.push({ tier: 'integrity', code: 'record_outside_fold_cohort', key: rec.key });
      continue;
    }
    validEvents.push(rec);
  }
  for (const rec of reservationsSorted) {
    if (cohortId != null && rec.payload?.cohort_id !== cohortId) {
      holds.push({ tier: 'integrity', code: 'reservation_outside_fold_cohort', key: rec.key });
    }
  }

  const byKind = (kind) => validEvents.filter((r) => r.payload.kind === kind);

  // ── stage_a_deployed + expectations + cohort init (hash-resolved) ──
  const stageAEvents = byKind('stage_a_deployed').filter((r) =>
    r.key.includes(`/events/${STAGE_A_COHORT}/machine/`)
  );
  const attested = byKind('expectations_attested');
  const initEvents = byKind('cohort_initialized');

  let cohortInit = null;
  let stageAEvent = null;
  let attestedEvent = null;

  if (initEvents.length > 1) {
    blocks.push({
      code: 'multiple_cohort_initializations',
      keys: initEvents.map((r) => r.key),
    });
  } else if (initEvents.length === 1) {
    const rec = initEvents[0];
    const p = rec.payload;
    // Resolve dependencies by EXPLICIT hash — a later stage-A deploy or a
    // second attestation can never retroactively invalidate this binding.
    const boundStageA =
      stageAEvents.find((r) => evidenceEventHash(r.payload) === p.stage_a_event_hash) ?? null;
    const boundAttested =
      attested.find((r) => evidenceEventHash(r.payload) === p.expectations_event_hash) ?? null;
    if (!boundStageA || !boundAttested) {
      invalid.push({
        key: rec.key,
        problems: [
          {
            code: 'cohort_init_version_mismatch',
            stage_a_ok: boundStageA != null,
            attested_ok: boundAttested != null,
          },
        ],
      });
    } else if (
      expectationManifest &&
      boundAttested.payload.combined_sha256 !== expectationManifest.combined_sha256
    ) {
      holds.push({ tier: 'attestation', code: 'expectation_hash_mismatch', key: boundAttested.key });
    } else {
      cohortInit = rec;
      stageAEvent = boundStageA;
      attestedEvent = boundAttested;
    }
  }

  // Without an initialisation, the NEWEST stage-A event anchors stage-only
  // status; the NEWEST matching attestation is prospective only.
  if (!stageAEvent && stageAEvents.length > 0) {
    stageAEvent = stageASorted.filter((r) => stageAEvents.includes(r)).at(-1);
  }
  if (!attestedEvent && attested.length > 0) {
    const last = attested.at(-1);
    if (
      !expectationManifest ||
      last.payload.combined_sha256 === expectationManifest.combined_sha256
    ) {
      attestedEvent = last;
    } else {
      holds.push({ tier: 'attestation', code: 'expectation_hash_mismatch', key: last.key });
    }
  }

  if (
    stageAEvent &&
    expectationManifest &&
    recomputedOracleDigest &&
    stageAEvent.payload.semantic_oracle_digest !== recomputedOracleDigest
  ) {
    holds.push({
      tier: 'fingerprint',
      code: 'semantic_oracle_digest_drift',
      stage_a_key: stageAEvent.key,
    });
  }

  const stageADeploymentFingerprint = stageAEvent?.payload?.runtime?.deployment_fingerprint ?? null;
  const initPublishedAt = cohortInit ? parseInstant(cohortInit.published_at) : null;

  // ── reservations: logical ordinals + PENDING records (key-verified) ──
  const ordinalByVersionId = new Map(); // allocation VersionId → {lane, ordinal}
  for (const rec of reservationsSorted) {
    if (rec.payload?.reservation_kind !== 'logical_ordinal') continue;
    for (const vid of rec.version_ids ?? []) {
      ordinalByVersionId.set(vid, {
        lane: rec.payload.lane,
        ordinal: rec.payload.ordinal,
        key: rec.key,
      });
    }
  }
  const pendings = [];
  for (const rec of reservationsSorted) {
    if (rec.payload?.reservation_kind !== 'attempt_pending') continue;
    const p = rec.payload;
    const expectedKey =
      p.requirement_key != null && p.attempt_generation != null && p.cohort_id != null
        ? attemptPendingKey({
            cohortId: p.cohort_id,
            requirementKey: p.requirement_key,
            generation: p.attempt_generation,
          })
        : null;
    if (expectedKey !== rec.key) {
      holds.push({ tier: 'integrity', code: 'pending_key_derivation_mismatch', key: rec.key });
      continue;
    }
    pendings.push(rec);
  }
  const pendingByRef = new Map();
  for (const p of pendings) {
    const ref = p.payload.attempt_ref;
    if (pendingByRef.has(ref)) {
      blocks.push({ code: 'duplicate_attempt_ref_pending', attempt_ref: ref });
      continue;
    }
    pendingByRef.set(ref, p);
  }

  // Audited content-addressed reports: name must equal the recomputed
  // content hash (evidenceEventHash of the payload).
  const auditedReportDigests = new Set();
  for (const rec of [...reportRecords].sort(byReceiptThenKey)) {
    const m = rec.key.match(/\/reports\/[^/]+\/([0-9a-f]{64})\.json$/);
    if (!m) {
      holds.push({ tier: 'integrity', code: 'report_key_malformed', key: rec.key });
      continue;
    }
    if (evidenceEventHash(rec.payload) !== m[1]) {
      holds.push({ tier: 'integrity', code: 'report_content_hash_mismatch', key: rec.key });
      continue;
    }
    auditedReportDigests.add(m[1]);
  }

  // ── terminals: pairing + identity (tiers 2/3) ──
  const terminals = byKind('attempt_terminal');
  const terminalsByRef = new Map();
  for (const t of terminals) {
    const ref = t.payload.attempt_ref;
    if (!terminalsByRef.has(ref)) terminalsByRef.set(ref, []);
    terminalsByRef.get(ref).push(t);
  }

  /** attempt_ref → the ONE structurally valid terminal record */
  const validTerminals = new Map();
  for (const [ref, list] of terminalsByRef) {
    // Byte-equal duplicates share a content hash ⇒ same key ⇒ one record;
    // two RECORDS for one ref are conflicting terminals ⇒ BLOCKED
    // regardless of safety class (stricter than the non-safety HOLD path,
    // by design).
    if (list.length > 1) {
      blocks.push({
        code: 'conflicting_terminals',
        attempt_ref: ref,
        keys: list.map((t) => t.key),
      });
      continue;
    }
    const t = list[0];
    const pending = pendingByRef.get(ref) ?? null;
    if (!pending) {
      invalid.push({
        key: t.key,
        problems: [{ code: 'terminal_without_pending', attempt_ref: ref }],
      });
      continue;
    }
    const p = pending.payload;
    const tp = t.payload;
    // The terminal must ECHO the atomic PENDING identity AND digests
    // (plan §C1: "Exactly one terminal echoes the atomic PENDING identity
    // and digests"). Codex cycle-1: allocation version + every digest.
    const mismatched =
      p.requirement_key !== tp.requirement_key ||
      p.attempt_generation !== tp.attempt_generation ||
      (p.requirement_class ?? null) !== (tp.requirement_class ?? null) ||
      (p.model ?? null) !== (tp.model ?? null) ||
      (p.tier ?? null) !== (tp.tier ?? null) ||
      (p.allocation_version_id ?? null) !== (tp.allocation_version_id ?? null) ||
      (p.prompt_digest ?? null) !== (tp.prompt_digest ?? null) ||
      (p.tool_digest ?? null) !== (tp.tool_digest ?? null) ||
      (p.expectation_digest ?? null) !== (tp.expectation_digest ?? null);
    if (mismatched) {
      invalid.push({
        key: t.key,
        problems: [{ code: 'terminal_pending_identity_mismatch', attempt_ref: ref }],
      });
      continue;
    }
    const ids = Array.isArray(tp.provider_call_ids) ? tp.provider_call_ids : [];
    if (tp.verdict !== 'INVALID') {
      // Mini-review — PASS/FAIL evidence must carry REAL identity: non-empty
      // string provider ids, a non-empty report digest and a non-null
      // sample identity (null is legal ONLY on INVALID).
      if (ids.length === 0 || ids.some((id) => typeof id !== 'string' || id.length === 0)) {
        invalid.push({ key: t.key, problems: [{ code: 'terminal_missing_provider_ids' }] });
        continue;
      }
      if (typeof tp.report_digest !== 'string' || tp.report_digest.length === 0) {
        invalid.push({ key: t.key, problems: [{ code: 'terminal_missing_report_digest' }] });
        continue;
      }
      // Cycle-2 — a PASS/FAIL sample identity may NEVER be null (the plan
      // reserves null for INVALID terminals with no provider id).
      if (typeof tp.sample_identity !== 'string' || tp.sample_identity.length === 0) {
        invalid.push({ key: t.key, problems: [{ code: 'terminal_sample_identity_missing' }] });
        continue;
      }
      // Cycle-2 — the terminal must be bound to the attested lane contract:
      // digests non-empty, expectation digest anchored to the attested
      // vendor manifest, and the model consistent with the class/lane.
      const missingDigest = ['prompt_digest', 'tool_digest', 'expectation_digest'].find(
        (dg) => typeof tp[dg] !== 'string' || tp[dg].length === 0
      );
      if (missingDigest) {
        invalid.push({
          key: t.key,
          problems: [{ code: 'terminal_digest_missing', field: missingDigest }],
        });
        continue;
      }
      const attestedVendorSha = expectationManifest?.vendor_live_expectations?.sha256 ?? null;
      if (attestedVendorSha != null && tp.expectation_digest !== attestedVendorSha) {
        invalid.push({ key: t.key, problems: [{ code: 'terminal_expectation_digest_unattached' }] });
        continue;
      }
      const modelStr = typeof tp.model === 'string' ? tp.model : '';
      if (tp.requirement_class === 'pinned_ir') {
        if (!modelStr.startsWith(LUNA_MODEL_FAMILY) || !FAST_TIERS.includes(tp.tier)) {
          invalid.push({ key: t.key, problems: [{ code: 'terminal_model_contract_violation' }] });
          continue;
        }
      }
      if (tp.requirement_class === 'vendor_corpus') {
        const laneOk =
          (tp.model_lane === 'luna' && modelStr.startsWith(LUNA_MODEL_FAMILY)) ||
          (tp.model_lane === 'haiku' && modelStr.startsWith('claude-haiku'));
        if (!laneOk) {
          invalid.push({ key: t.key, problems: [{ code: 'terminal_model_lane_mismatch' }] });
          continue;
        }
      }
      // Cycle-2 — referenced-report integrity: the content-addressed report
      // must EXIST in the audited reports prefix. Missing content is
      // classified per the recorded verdict: a FAIL cannot hide (BLOCK), a
      // PASS can never count (HOLD).
      if (!auditedReportDigests.has(tp.report_digest)) {
        if (tp.verdict === 'FAIL') {
          blocks.push({ code: 'fail_report_withheld', key: t.key, report_digest: tp.report_digest });
        } else {
          holds.push({ tier: 'report', code: 'pass_report_missing', key: t.key });
          invalid.push({ key: t.key, problems: [{ code: 'terminal_report_missing' }] });
          continue;
        }
      }
      // Ordinal binding: a pinned-IR / vendor-corpus terminal must bind its
      // allocation VersionId to an AUDITED logical-ordinal reservation whose
      // lane + ordinal agree with the terminal's own ordinal fields.
      if (tp.requirement_class === 'pinned_ir' || tp.requirement_class === 'vendor_corpus') {
        const allocation =
          tp.allocation_version_id != null ? ordinalByVersionId.get(tp.allocation_version_id) : null;
        if (!allocation) {
          invalid.push({ key: t.key, problems: [{ code: 'terminal_allocation_unresolved' }] });
          continue;
        }
        const expectedOrdinal =
          tp.requirement_class === 'pinned_ir' ? tp.repetition_ordinal : tp.corpus_run_ordinal;
        const expectedLane =
          tp.requirement_class === 'pinned_ir' ? 'ir-repetition' : `corpus-run-${tp.model_lane}`;
        if (allocation.ordinal !== expectedOrdinal || allocation.lane !== expectedLane) {
          invalid.push({ key: t.key, problems: [{ code: 'terminal_allocation_ordinal_mismatch' }] });
          continue;
        }
      }
    }
    const generatedAt = parseInstant(tp.generated_at);
    const receiptAt = parseInstant(t.published_at);
    if (tp.generated_at != null && generatedAt == null) {
      invalid.push({ key: t.key, problems: [{ code: 'terminal_generated_at_unparseable' }] });
      continue;
    }
    if (generatedAt != null && receiptAt != null && generatedAt > receiptAt + CLOCK_SKEW_MS) {
      invalid.push({ key: t.key, problems: [{ code: 'terminal_generated_after_receipt' }] });
      continue;
    }
    // Same-London-day PENDING/terminal + post-initialisation PENDING
    // (plan Stage-B receipt-day contract, enforced structurally here).
    const pendingAt = parseInstant(pending.published_at);
    if (pendingAt == null || receiptAt == null) {
      invalid.push({ key: t.key, problems: [{ code: 'attempt_receipt_unparseable' }] });
      continue;
    }
    if (londonDayOf(pendingAt) !== londonDayOf(receiptAt)) {
      invalid.push({ key: t.key, problems: [{ code: 'pending_terminal_day_mismatch' }] });
      continue;
    }
    if (initPublishedAt != null && pendingAt < initPublishedAt) {
      invalid.push({ key: t.key, problems: [{ code: 'pending_before_cohort_deployment' }] });
      continue;
    }
    validTerminals.set(ref, { terminal: t, pending });
  }

  // Provider ids / sample identities are cohort-wide single-use.
  const seenProviderIds = new Map();
  const seenSampleIds = new Map();
  for (const [ref, { terminal }] of validTerminals) {
    for (const id of terminal.payload.provider_call_ids ?? []) {
      if (seenProviderIds.has(id) && seenProviderIds.get(id) !== ref) {
        blocks.push({ code: 'provider_call_id_reuse', provider_call_id: id });
      } else {
        seenProviderIds.set(id, ref);
      }
    }
    const sid = terminal.payload.sample_identity ?? null;
    if (sid != null) {
      if (seenSampleIds.has(sid) && seenSampleIds.get(sid) !== ref) {
        blocks.push({ code: 'sample_identity_reuse', sample_identity: sid });
      } else {
        seenSampleIds.set(sid, ref);
      }
    }
  }
  // Report digests are cohort-wide single-use too (a rewrapped report under
  // a fresh ref cannot count twice).
  const seenReportDigests = new Map();
  for (const [ref, { terminal }] of validTerminals) {
    const rd = terminal.payload.report_digest ?? null;
    if (rd == null) continue;
    if (seenReportDigests.has(rd) && seenReportDigests.get(rd) !== ref) {
      blocks.push({ code: 'report_digest_reuse', report_digest: rd });
    } else {
      seenReportDigests.set(rd, ref);
    }
  }
  // Cycle-2 — allocations and IR repetition ordinals are COHORT-wide
  // single-use across days: one allocation VersionId binds exactly one
  // requirement key, and one repetition ordinal counts exactly once.
  // A pinned-IR allocation backs exactly ONE requirement; a vendor-corpus
  // allocation backs exactly one (lane, run) GROUP — every fixture of that
  // run shares it BY DESIGN ("include that ordinal in every fixture/turn
  // requirement key for the run"), but a second lane/run may never reuse it.
  const seenAllocationUse = new Map(); // allocation_version_id → use identity string
  const seenIrOrdinals = new Map(); // repetition_ordinal → requirement_key
  for (const [, { terminal }] of validTerminals) {
    const tp = terminal.payload;
    if (tp.allocation_version_id != null) {
      const use =
        tp.requirement_class === 'vendor_corpus'
          ? `corpus:${tp.model_lane}:${tp.corpus_run_ordinal}`
          : `single:${tp.requirement_key}`;
      const prior = seenAllocationUse.get(tp.allocation_version_id);
      if (prior != null && prior !== use) {
        blocks.push({
          code: 'allocation_reused_across_requirements',
          allocation_version_id: tp.allocation_version_id,
        });
      } else {
        seenAllocationUse.set(tp.allocation_version_id, use);
      }
    }
    if (tp.requirement_class === 'pinned_ir' && tp.repetition_ordinal != null) {
      const prior = seenIrOrdinals.get(tp.repetition_ordinal);
      if (prior != null && prior !== tp.requirement_key) {
        blocks.push({
          code: 'ir_ordinal_reuse_across_days',
          repetition_ordinal: tp.repetition_ordinal,
        });
      } else {
        seenIrOrdinals.set(tp.repetition_ordinal, tp.requirement_key);
      }
    }
  }

  // ── per-requirement resolution (generation chain, INVALID replacement) ──
  const requirements = new Map();
  for (const [ref, pair] of validTerminals) {
    const key = pair.terminal.payload.requirement_key;
    if (!requirements.has(key)) requirements.set(key, { counted: null, invalids: [], all: [] });
    requirements.get(key).all.push({ ref, ...pair });
  }
  for (const [key, req] of requirements) {
    req.all.sort((a, b) => (a.pending.payload.attempt_generation ?? 0) - (b.pending.payload.attempt_generation ?? 0));
    const valids = req.all.filter((r) => r.terminal.payload.verdict !== 'INVALID');
    req.invalids = req.all.filter((r) => r.terminal.payload.verdict === 'INVALID');
    if (valids.length > 1) {
      blocks.push({ code: 'duplicate_valid_terminals_for_key', requirement_key: key });
      continue;
    }
    // Codex cycle-1 + mini-review — the replacement GENERATION CHAIN is
    // validated over ALL audited PENDINGs for this requirement key, not
    // just structurally valid terminals: a malformed link makes successors
    // UNVERIFIABLE (HOLD, uncreditable), while genuinely CONTRADICTORY
    // shapes (a replacement racing/preceding its predecessor terminal, or
    // any generation after a valid terminal) BLOCK.
    let chainOk = true;
    const allPendingsForKey = pendings
      .filter((rec) => rec.payload.requirement_key === key)
      .sort((a, b) => (a.payload.attempt_generation ?? 0) - (b.payload.attempt_generation ?? 0));
    const generationsPresent = allPendingsForKey.map((rec) => rec.payload.attempt_generation);
    for (let i = 0; i < generationsPresent.length; i += 1) {
      if (generationsPresent[i] !== i + 1) {
        holds.push({
          tier: 'attempt',
          code: 'attempt_generation_chain_broken',
          requirement_key: key,
          generations: generationsPresent,
        });
        chainOk = false;
        break;
      }
    }
    if (chainOk) {
      // Requirement-defining metadata must be byte-identical across
      // generations (a replacement reuses the EXACT requirement).
      const first = allPendingsForKey[0]?.payload ?? null;
      for (const rec of allPendingsForKey.slice(1)) {
        const q = rec.payload;
        if (
          (q.requirement_class ?? null) !== (first.requirement_class ?? null) ||
          (q.model ?? null) !== (first.model ?? null) ||
          (q.tier ?? null) !== (first.tier ?? null) ||
          (q.allocation_version_id ?? null) !== (first.allocation_version_id ?? null) ||
          (q.prompt_digest ?? null) !== (first.prompt_digest ?? null) ||
          (q.tool_digest ?? null) !== (first.tool_digest ?? null) ||
          (q.expectation_digest ?? null) !== (first.expectation_digest ?? null)
        ) {
          holds.push({
            tier: 'attempt',
            code: 'replacement_metadata_drift',
            requirement_key: key,
            generation: q.attempt_generation,
          });
          chainOk = false;
          break;
        }
      }
    }
    if (chainOk) {
      const terminalByGeneration = new Map(
        req.all.map((r) => [r.pending.payload.attempt_generation, r])
      );
      for (const rec of allPendingsForKey) {
        const gen = rec.payload.attempt_generation;
        if (gen === 1) continue;
        const predecessor = terminalByGeneration.get(gen - 1) ?? null;
        if (!predecessor) {
          // The predecessor terminal is missing or structurally invalid —
          // this generation is UNVERIFIABLE (its own orphan/invalid state is
          // already held elsewhere); successors stay uncreditable.
          holds.push({
            tier: 'attempt',
            code: 'replacement_chain_unverifiable',
            requirement_key: key,
            generation: gen,
          });
          chainOk = false;
          break;
        }
        if (predecessor.terminal.payload.verdict !== 'INVALID') {
          blocks.push({
            code: 'replacement_after_valid_terminal',
            requirement_key: key,
            generation: gen,
          });
          chainOk = false;
          break;
        }
        const predTerminalAt = parseInstant(predecessor.terminal.published_at);
        const pendingAt = parseInstant(rec.published_at);
        if (predTerminalAt == null || pendingAt == null || pendingAt < predTerminalAt) {
          blocks.push({
            code: 'replacement_before_predecessor_terminal',
            requirement_key: key,
            generation: gen,
          });
          chainOk = false;
          break;
        }
      }
    }
    if (!chainOk) continue;
    if (valids.length === 1) {
      const valid = valids[0];
      if (valid !== req.all[req.all.length - 1]) {
        blocks.push({ code: 'valid_terminal_not_final_generation', requirement_key: key });
        continue;
      }
      req.counted = valid;
    } else if (req.invalids.length > 0) {
      holds.push({ tier: 'attempt', code: 'invalid_awaiting_replacement', requirement_key: key });
    }
  }

  // Orphan PENDING: a pending with dispatch possible and no terminal.
  for (const [ref, pending] of pendingByRef) {
    if (!terminalsByRef.has(ref)) {
      holds.push({
        tier: 'attempt',
        code: 'orphan_pending',
        attempt_ref: ref,
        requirement_key: pending.payload.requirement_key,
      });
    }
  }

  // ── semantic classification (ONLY structurally valid, uniquely paired) ──
  // Cycle-2 — decisions are hardened: a REJECTION is irreversible (a later
  // approval cannot overwrite it), a decision must reference a real
  // mismatch and postdate its terminal, and conflicting outcomes surface.
  const decisions = byKind('non_safety_decision');
  const mismatchTerminals = new Map(); // mismatch_id → terminal record
  for (const [, { terminal }] of validTerminals) {
    const mm = terminal.payload.mismatch?.mismatch_id ?? null;
    if (mm != null) mismatchTerminals.set(mm, terminal);
  }
  const decisionByMismatch = new Map();
  for (const d of decisions) {
    const id = d.payload.mismatch_id;
    const target = mismatchTerminals.get(id) ?? null;
    if (!target) {
      invalid.push({ key: d.key, problems: [{ code: 'decision_unmatched_mismatch', mismatch_id: id }] });
      continue;
    }
    if (!['approved', 'rejected'].includes(d.payload.decision)) {
      invalid.push({ key: d.key, problems: [{ code: 'decision_unknown_outcome' }] });
      continue;
    }
    const dAt = parseInstant(d.published_at);
    const tAt = parseInstant(target.published_at);
    if (dAt == null || tAt == null || dAt < tAt) {
      invalid.push({ key: d.key, problems: [{ code: 'decision_predates_mismatch' }] });
      continue;
    }
    const prior = decisionByMismatch.get(id);
    if (prior === 'rejected') continue; // irreversible
    if (prior != null && prior !== d.payload.decision) {
      blocks.push({ code: 'conflicting_mismatch_decisions', mismatch_id: id });
    }
    decisionByMismatch.set(id, d.payload.decision);
  }

  for (const [key, req] of requirements) {
    const counted = req.counted;
    if (!counted) continue;
    const tp = counted.terminal.payload;
    if (tp.verdict === 'FAIL') {
      const safety =
        SAFETY_BLOCKING_CLASSES.includes(tp.requirement_class) ||
        tp.mismatch?.safety_critical === true;
      if (safety) {
        blocks.push({
          code: 'semantic_safety_fail',
          requirement_key: key,
          requirement_class: tp.requirement_class,
        });
      } else if (tp.mismatch?.mismatch_id == null || typeof tp.mismatch?.safety_critical !== 'boolean') {
        // Cycle-2 — an UNCLASSIFIED vendor FAIL is unwaivable: without an
        // explicit mismatch identity + boolean safety classification no
        // decision can ever legitimately apply.
        blocks.push({ code: 'unclassified_mismatch_fail', requirement_key: key });
      } else {
        const mismatchId = tp.mismatch.mismatch_id;
        const decision = decisionByMismatch.get(mismatchId);
        if (decision === 'rejected') {
          blocks.push({ code: 'non_safety_mismatch_rejected', mismatch_id: mismatchId });
        } else if (decision !== 'approved') {
          holds.push({
            tier: 'semantic',
            code: 'undecided_non_safety_mismatch',
            mismatch_id: mismatchId,
            requirement_key: key,
          });
        } else {
          notes.push({ code: 'approved_non_safety_mismatch', mismatch_id: mismatchId });
        }
      }
    }
  }

  // ── production sessions (bound-event ↔ collected-manifest verification) ──
  const boundSessions = byKind('production_session_bound');
  const boundBySession = new Map();
  for (const b of boundSessions) {
    const sid = b.payload.field_session_id;
    if (boundBySession.has(sid)) {
      blocks.push({ code: 'session_bound_twice', field_session_id: sid });
      continue;
    }
    // Codex cycle-1 — the binding event must actually BIND: its recorded
    // manifest hashes must match the collected pair, its deployment
    // fingerprint must be the cohort's stage-A fingerprint, and its receipt
    // must postdate initialisation.
    const manifests = manifestsBySession.get(sid) ?? null;
    const problems = [];
    if (!manifests || manifests.problems?.length) {
      problems.push({ code: 'bound_session_manifests_invalid' });
    } else {
      if (
        b.payload.start_manifest?.content_hash !== manifests.start_content_hash ||
        b.payload.completion_manifest?.content_hash !== manifests.completion_content_hash
      ) {
        problems.push({ code: 'bound_manifest_hash_mismatch' });
      }
      if (
        stageADeploymentFingerprint != null &&
        b.payload.deployment_fingerprint !== stageADeploymentFingerprint
      ) {
        problems.push({ code: 'bound_deployment_fingerprint_mismatch' });
      }
      // Mini-review — the bound manifests' prompt/tool/config fingerprints
      // and deployment fingerprint must equal the cohort's stage-A event.
      if (stageAEvent && manifests?.completion?.deployment) {
        const d = manifests.completion.deployment;
        const sp = stageAEvent.payload;
        if (
          (stageADeploymentFingerprint != null && d.fingerprint !== stageADeploymentFingerprint) ||
          (sp.prompt_fingerprint != null && d.prompt_fingerprint !== sp.prompt_fingerprint) ||
          (sp.tool_fingerprint != null && d.tool_fingerprint !== sp.tool_fingerprint) ||
          (sp.config_fingerprint != null && d.config_fingerprint !== sp.config_fingerprint)
        ) {
          problems.push({ code: 'bound_manifest_fingerprint_drift' });
        }
      }
      const boundAt = parseInstant(b.published_at);
      if (initPublishedAt != null && (boundAt == null || boundAt < initPublishedAt)) {
        problems.push({ code: 'bound_before_cohort_deployment' });
      }
      const manifestAt = parseInstant(manifests.published_at);
      if (initPublishedAt != null && (manifestAt == null || manifestAt < initPublishedAt)) {
        problems.push({ code: 'manifest_before_cohort_deployment' });
      }
    }
    if (problems.length > 0) {
      invalid.push({ key: b.key, problems });
      holds.push({ tier: 'binding', code: 'session_binding_invalid', field_session_id: sid });
      continue;
    }
    boundBySession.set(sid, b);
  }

  // ── manual + dialogue attestations ──
  const manuals = byKind('manual_attestation');
  const dialogueHearings = byKind('dialogue_hearing_attestation');
  const validManualByDay = new Map();
  for (const m of manuals) {
    const p = m.payload;
    const problems = [];
    if (p.heard_completed_during_session === false && p.manual_result === 'pass') {
      problems.push({ code: 'false_plus_pass' });
    }
    if (!['pass', 'fail'].includes(p.manual_result)) problems.push({ code: 'unknown_manual_result' });
    if (p.manual_heard_by !== 'Derek') problems.push({ code: 'unknown_hearer' });
    if (p.field_context !== 'genuine_on_site') problems.push({ code: 'not_genuine_on_site' });
    const receiptAt = parseInstant(m.published_at);
    const attestedAt = parseInstant(p.attested_at);
    if (receiptAt == null || attestedAt == null) problems.push({ code: 'attestation_time_unparseable' });
    const receiptDay = receiptAt != null ? londonDayOf(receiptAt) : null;
    if (p.day != null && receiptDay != null && p.day !== receiptDay) {
      problems.push({ code: 'claimed_day_receipt_day_mismatch', claimed: p.day, receipt: receiptDay });
    }
    const sid = p.confirmation_session_id;
    if (!Array.isArray(p.field_session_ids) || !p.field_session_ids.includes(sid)) {
      problems.push({ code: 'confirmation_session_not_bound_to_day' });
    }
    // Codex cycle-1 — EVERY listed session must be genuinely bound with a
    // valid manifest pair, not just the confirmation session.
    for (const listed of Array.isArray(p.field_session_ids) ? p.field_session_ids : []) {
      const bm = manifestsBySession.get(listed) ?? null;
      if (!boundBySession.has(listed) || !bm || bm.problems?.length) {
        problems.push({ code: 'listed_session_unbound_or_invalid', field_session_id: listed });
      }
    }
    const manifests = manifestsBySession.get(sid) ?? null;
    if (!boundBySession.has(sid) || !manifests || manifests.problems?.length) {
      problems.push({ code: 'session_manifests_unavailable' });
    } else {
      if (!sessionEvidenceEligible(manifests.completion)) {
        problems.push({ code: 'session_evidence_ineligible' });
      }
      const completedAt = parseInstant(manifests.completion?.completed_at ?? null);
      if (
        completedAt == null ||
        attestedAt == null ||
        receiptAt == null ||
        attestedAt <= completedAt ||
        attestedAt >= receiptAt + CLOCK_SKEW_MS
      ) {
        problems.push({ code: 'attested_at_ordering_invalid' });
      }
      // Mini-review — the heard confirmation must belong to THIS day: the
      // confirmation session's completion-manifest receipt shares the
      // attestation's Europe/London day.
      const confPublishedAt = parseInstant(manifests.published_at);
      if (receiptDay != null && (confPublishedAt == null || londonDayOf(confPublishedAt) !== receiptDay)) {
        problems.push({ code: 'confirmation_session_day_mismatch' });
      }
      const res = resolveManualConfirmationRef(manifests.completion, p.confirmation_ref);
      if (!res.resolved) {
        problems.push({ code: 'confirmation_ref_unresolved', reason: res.reason });
      } else if (p.manual_result === 'pass') {
        if (p.heard_completed_during_session !== true) problems.push({ code: 'pass_without_heard' });
        if (res.ambiguous) problems.push({ code: 'delivery_history_ambiguous' });
        if (res.playback_start_count !== 1) {
          problems.push({ code: 'playback_start_count_invalid', count: res.playback_start_count });
        }
      }
    }
    if (problems.length > 0) {
      invalid.push({ key: m.key, problems });
      holds.push({ tier: 'manual', code: 'manual_attestation_invalid', key: m.key });
      continue;
    }
    if (p.manual_result === 'fail') {
      blocks.push({ code: 'manual_heard_fail', key: m.key });
      continue;
    }
    if (!validManualByDay.has(receiptDay)) validManualByDay.set(receiptDay, []);
    validManualByDay.get(receiptDay).push({ event: m, payload: p });
  }

  const validDialogueHearingsBySession = new Map();
  for (const dh of dialogueHearings) {
    const p = dh.payload;
    const problems = [];
    if (p.heard_completed_during_session === false && p.manual_result === 'pass') {
      problems.push({ code: 'false_plus_pass' });
    }
    if (!['pass', 'fail'].includes(p.manual_result)) problems.push({ code: 'unknown_manual_result' });
    if (p.manual_heard_by !== 'Derek') problems.push({ code: 'unknown_hearer' });
    const receiptAt = parseInstant(dh.published_at);
    const attestedAt = parseInstant(p.attested_at);
    if (receiptAt == null || attestedAt == null) problems.push({ code: 'attestation_time_unparseable' });
    const receiptDay = receiptAt != null ? londonDayOf(receiptAt) : null;
    // Fold rule (no new schema field): the session must be bound under a
    // valid same-day genuine-on-site daily attestation.
    const dayManuals = receiptDay != null ? (validManualByDay.get(receiptDay) ?? []) : [];
    const genuine = dayManuals.some((m) => m.payload.field_session_ids.includes(p.field_session_id));
    if (!genuine) problems.push({ code: 'session_not_genuine_on_site_bound' });
    const manifests = manifestsBySession.get(p.field_session_id) ?? null;
    if (!manifests || manifests.problems?.length) {
      problems.push({ code: 'session_manifests_unavailable' });
    } else {
      if (!sessionEvidenceEligible(manifests.completion)) {
        problems.push({ code: 'session_evidence_ineligible' });
      }
      const res = resolveDialogueDeliveryRef(manifests.completion, p.dialogue_delivery_ref);
      if (!res.resolved) {
        problems.push({ code: 'dialogue_delivery_ref_unresolved', reason: res.reason });
      }
      const completedAt = parseInstant(manifests.completion?.completed_at ?? null);
      if (
        completedAt == null ||
        attestedAt == null ||
        receiptAt == null ||
        attestedAt <= completedAt ||
        attestedAt >= receiptAt + CLOCK_SKEW_MS
      ) {
        problems.push({ code: 'attested_at_ordering_invalid' });
      }
    }
    if (problems.length > 0) {
      invalid.push({ key: dh.key, problems });
      holds.push({ tier: 'manual', code: 'dialogue_hearing_invalid', key: dh.key });
      continue;
    }
    if (p.manual_result === 'fail') {
      blocks.push({ code: 'dialogue_hearing_fail', key: dh.key });
      continue;
    }
    if (!validDialogueHearingsBySession.has(p.field_session_id)) {
      validDialogueHearingsBySession.set(p.field_session_id, []);
    }
    validDialogueHearingsBySession.get(p.field_session_id).push({ event: dh, payload: p });
  }

  // ── per-day acceptance ──
  const gapDecisions = byKind('corpus_gap_decision');
  const attestedFixtureIds = expectationManifest?.vendor_live_expectations?.fixture_ids ?? [];
  const namedGapStrata = new Set(
    (expectationManifest?.strata_named_gaps ?? [])
      .filter((g) => g.safety_critical === false)
      .map((g) => g.stratum)
  );
  const approvedDeferrals = new Set();
  for (const g of gapDecisions) {
    const p = g.payload;
    // Mini-review — UNCLASSIFIED targets default to SAFETY-CRITICAL: only a
    // manifest-named gap stratum EXPLICITLY carrying safety_critical:false
    // is deferrable. Whole attested fixtures carry no per-expectation
    // safety classification and can NEVER be deferred (follow-up:
    // per-fixture safety metadata in the expectation manifest).
    const known = namedGapStrata.has(p.stratum_or_fixture);
    if (!known || p.safety_critical === true) {
      invalid.push({
        key: g.key,
        problems: [{ code: 'corpus_gap_target_invalid', target: p.stratum_or_fixture ?? null }],
      });
      holds.push({ tier: 'semantic', code: 'corpus_gap_decision_invalid', key: g.key });
      continue;
    }
    if (p.decision === 'approved') approvedDeferrals.add(p.stratum_or_fixture);
  }

  const countedByDay = new Map();
  for (const [, req] of requirements) {
    if (!req.counted) continue;
    const t = req.counted.terminal;
    const receiptAt = parseInstant(t.published_at);
    if (initPublishedAt != null && receiptAt != null && receiptAt < initPublishedAt) {
      invalid.push({ key: t.key, problems: [{ code: 'terminal_before_cohort_deployment' }] });
      continue;
    }
    const day = receiptAt != null ? londonDayOf(receiptAt) : null;
    if (day == null) continue;
    if (!countedByDay.has(day)) countedByDay.set(day, []);
    countedByDay.get(day).push(req.counted);
  }

  const dayEvaluations = new Map();
  const allDays = new Set([...countedByDay.keys(), ...validManualByDay.keys()]);
  for (const day of [...allDays].sort()) {
    const dayTerminals = countedByDay.get(day) ?? [];
    const evaluation = { day, requirements: {}, accepted: false };

    const irPasses = dayTerminals.filter(
      (r) =>
        r.terminal.payload.requirement_class === 'pinned_ir' &&
        r.terminal.payload.verdict === 'PASS'
    );
    const irOrdinals = new Set(irPasses.map((r) => r.terminal.payload.repetition_ordinal));
    if (irOrdinals.size !== irPasses.length) {
      blocks.push({ code: 'ir_ordinal_reuse_within_day', day });
    }
    evaluation.requirements.pinned_ir = irOrdinals.size >= IR_REPS_PER_DAY;

    const corpusComplete = {};
    for (const lane of ['haiku', 'luna']) {
      const laneTerminals = dayTerminals.filter(
        (r) =>
          r.terminal.payload.requirement_class === 'vendor_corpus' &&
          r.terminal.payload.model_lane === lane &&
          r.terminal.payload.verdict === 'PASS'
      );
      const byRun = new Map();
      for (const r of laneTerminals) {
        const run = r.terminal.payload.corpus_run_ordinal;
        if (!byRun.has(run)) byRun.set(run, new Set());
        byRun.get(run).add(r.terminal.payload.fixture_id);
      }
      const requiredFixtures = attestedFixtureIds.filter((id) => !approvedDeferrals.has(id));
      corpusComplete[lane] = [...byRun.values()].some((fixtures) =>
        requiredFixtures.every((id) => fixtures.has(id))
      );
    }
    evaluation.requirements.corpus_haiku = corpusComplete.haiku === true;
    evaluation.requirements.corpus_luna = corpusComplete.luna === true;

    const dayManuals = validManualByDay.get(day) ?? [];
    evaluation.requirements.manual_pass = dayManuals.length > 0;
    const daySessionIds = new Set(dayManuals.flatMap((m) => m.payload.field_session_ids));
    let lunaFast = false;
    let terraObservation = false;
    let explicitCacheRead = false;
    let dialogueFamily = false;
    let addressMirrorFamily = false;
    let boundSameDay = false;
    for (const sid of daySessionIds) {
      if (!boundBySession.has(sid)) continue;
      const manifests = manifestsBySession.get(sid) ?? null;
      if (!manifests || manifests.problems?.length) continue;
      if (!sessionEvidenceEligible(manifests.completion)) continue;
      const publishedAt = parseInstant(manifests.published_at);
      if (publishedAt == null || londonDayOf(publishedAt) !== day) continue;
      // Cycle-2 — the BINDING EVENT's receipt must share the day too: a
      // later-day bind cannot retroactively satisfy an earlier day.
      const boundEventAt = parseInstant(boundBySession.get(sid).published_at);
      if (boundEventAt == null || londonDayOf(boundEventAt) !== day) continue;
      boundSameDay = true;
      const gates = roundUsageGatesOf(manifests.completion);
      lunaFast = lunaFast || gates.lunaFast;
      terraObservation = terraObservation || gates.terraObservation;
      explicitCacheRead = explicitCacheRead || gates.explicitCacheRead;
      const fam = familyGatesOf(manifests.completion);
      const hearing = (validDialogueHearingsBySession.get(sid) ?? []).length > 0;
      dialogueFamily = dialogueFamily || (fam.dialogue_script && hearing);
      addressMirrorFamily = addressMirrorFamily || fam.address_mirror;
    }
    evaluation.requirements.bound_genuine_session = boundSameDay;
    evaluation.requirements.luna_fast_round = lunaFast;
    evaluation.requirements.terra_observation_round = terraObservation;
    evaluation.requirements.explicit_cache_evidence = explicitCacheRead;
    evaluation.requirements.dialogue_script_family = dialogueFamily;
    evaluation.requirements.address_mirror_family = addressMirrorFamily;

    evaluation.accepted = Object.values(evaluation.requirements).every((v) => v === true);
    dayEvaluations.set(day, evaluation);
  }

  const acceptedDays = [...dayEvaluations.values()].filter((e) => e.accepted).map((e) => e.day);

  // ── state resolution ──
  // BLOCKED dominates; visible corruption/invalid evidence is HOLD, never
  // omission, even before initialisation (Codex cycle-1).
  let state;
  let progress = null;
  let staleDeployment = false;
  const corruptionVisible = holds.length > 0 || invalid.length > 0;
  // Cycle-2 — the fresh live check binds from the moment a stage-A event
  // exists: pre-initialisation drift holds too (a stale deploy must not
  // look like a clean STAGE_A_IMPLEMENTED).
  const liveDrifted =
    stageAEvent != null &&
    liveDeployment != null &&
    (!liveDeployment.available || !liveDeployment.fingerprint_matches);
  if (blocks.length > 0) {
    state = 'BLOCKED';
  } else if (!cohortInit) {
    if (liveDrifted) {
      state = 'HOLD_EVIDENCE';
      staleDeployment = true;
    } else if (corruptionVisible) {
      state = 'HOLD_EVIDENCE';
    } else if (!stageAEvent) {
      state = 'NOT_STARTED';
    } else {
      state = 'STAGE_A_IMPLEMENTED';
    }
  } else {
    progress = `${Math.min(acceptedDays.length, REQUIRED_DAYS)}/${REQUIRED_DAYS}`;
    if (liveDeployment == null || !liveDeployment.available || !liveDeployment.fingerprint_matches) {
      state = 'HOLD_EVIDENCE';
      staleDeployment = true;
    } else if (acceptedDays.length >= REQUIRED_DAYS && !corruptionVisible) {
      state = 'DONE';
    } else {
      state = 'HOLD_EVIDENCE';
    }
  }

  return {
    state,
    progress,
    stale_deployment: staleDeployment,
    stage_a_event: stageAEvent ? { key: stageAEvent.key } : null,
    cohort_id: cohortId,
    cohort_initialized: cohortInit ? { key: cohortInit.key } : null,
    accepted_days: acceptedDays,
    day_evaluations: [...dayEvaluations.values()],
    holds,
    blocks,
    invalid,
    notes,
  };
}
