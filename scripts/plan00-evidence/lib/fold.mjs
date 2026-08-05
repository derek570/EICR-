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
 */

import { evidenceEventHash } from '../../field-replay/lib/canonical-crypto.mjs';
import {
  INSPECTOR_ROUND_BILLABLE_KINDS,
  IR_REPS_PER_DAY,
  LUNA_MODEL,
  LUNA_TIER,
  REQUIRED_DAYS,
  SAFETY_BLOCKING_CLASSES,
  STAGE_A_COHORT,
  TERRA_MODEL,
  TERRA_TIER,
  londonDayOf,
} from './constants.mjs';
import { validateStoredEvent } from './events.mjs';

const CLOCK_SKEW_MS = 5 * 60 * 1000;

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
 *  one operation-bound dialogue_script delivery. */
export function resolveDialogueDeliveryRef(completionManifest, deliveryRef) {
  const rows = (completionManifest?.evidence?.deliveries?.dialogue_script ?? []).filter(
    (d) => d.delivery_ref === deliveryRef && (d.op_keys ?? []).length > 0
  );
  if (rows.length === 1) return { resolved: true, row: rows[0] };
  return { resolved: false, reason: rows.length === 0 ? 'ref_unknown' : 'ref_ambiguous' };
}

/** Family gates read from one bound completion manifest (00B-2 §C2). */
export function familyGatesOf(completionManifest) {
  const gates = completionManifest?.evidence?.family_gates ?? {};
  return {
    dialogue_script:
      gates.dialogue_script?.ask_lifecycle_complete === true &&
      gates.dialogue_script?.operation_bound_delivery === true,
    address_mirror:
      gates.address_mirror?.ask_lifecycle_complete === true &&
      gates.address_mirror?.operation_bound_delivery === true &&
      gates.address_mirror?.playback_ack_proof === true,
  };
}

/** Round-usage gates (00B-2 §C2 counting rules). Luna-Fast ordinary-reading
 *  evidence counts ONLY from accepted inspector rounds; a Terra observation
 *  round is provable ONLY on the Responses transport with LOW effort and
 *  Standard/omitted tier; cache evidence requires a WARM read on the
 *  explicit route (cold-only write rows are insufficient). */
export function roundUsageGatesOf(completionManifest) {
  const rounds = completionManifest?.evidence?.round_usage?.rounds ?? [];
  const inspector = rounds.filter((r) =>
    INSPECTOR_ROUND_BILLABLE_KINDS.includes(r.billable_kind)
  );
  const lunaFast = inspector.some(
    (r) =>
      r.billing_model === LUNA_MODEL &&
      (r.billing_tier === LUNA_TIER || r.response_tier === LUNA_TIER) &&
      r.attribution_status === 'attributed'
  );
  const terraObservation = inspector.some(
    (r) =>
      r.api_transport === 'responses' &&
      r.billing_model === TERRA_MODEL &&
      r.reasoning_effort === 'low' &&
      (r.billing_tier === TERRA_TIER || r.billing_tier == null || r.response_tier === TERRA_TIER)
  );
  const explicitCacheRead = inspector.some(
    (r) => r.prompt_cache_mode === 'explicit' && (r.cache_read_input_tokens ?? 0) > 0
  );
  return { lunaFast, terraObservation, explicitCacheRead };
}

// ── the fold ─────────────────────────────────────────────────────────────

/**
 * @param {object} input
 *  - stageARecords: audited records under events/_stage-a/
 *  - cohortId: the cohort under fold (null ⇒ stage-A-only status)
 *  - cohortRecords: audited records under events/<cohortId>/
 *  - reservationRecords: audited records under reservations/<cohortId>/
 *  - integrityHolds: holds from the audited loader (all prefixes)
 *  - manifestsBySession: Map sessionId → {start, completion, published_at,
 *      problems: []} (loaded + pair-validated by the collector)
 *  - expectationManifest: committed scripts/model-ab manifest content
 *  - recomputedOracleDigest: computeSemanticOracleDigest(repoRoot) result
 *  - liveDeployment: {available, fingerprint_matches, reason} | null
 */
export function foldEvidence({
  stageARecords = [],
  cohortId = null,
  cohortRecords = [],
  reservationRecords = [],
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

  // ── tier 1: schema/namespace over every stored event ──
  const validEvents = [];
  for (const rec of [...stageARecords, ...cohortRecords]) {
    const problems = validateStoredEvent({ key: rec.key, payload: rec.payload });
    if (problems.length > 0) {
      invalid.push({ key: rec.key, problems });
      continue;
    }
    validEvents.push(rec);
  }

  const byKind = (kind) => validEvents.filter((r) => r.payload.kind === kind);

  // ── stage_a_deployed ──
  const stageAEvents = byKind('stage_a_deployed').filter((r) =>
    r.key.includes(`/events/${STAGE_A_COHORT}/machine/`)
  );
  let stageAEvent = null;
  if (stageAEvents.length > 0) {
    // Multiple stage_a_deployed events are legitimate history (each deploy
    // may publish one); the newest by published_at anchors the CURRENT
    // stage; cohort binding pins the exact one via its content hash.
    stageAEvent = [...stageAEvents].sort(
      (a, b) => Date.parse(a.published_at) - Date.parse(b.published_at)
    )[stageAEvents.length - 1];
    if (
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
  }

  // ── expectations_attested + cohort_initialized ──
  const attested = byKind('expectations_attested');
  let attestedEvent = null;
  if (attested.length > 0) {
    attestedEvent = attested[attested.length - 1];
    if (
      expectationManifest &&
      attestedEvent.payload.combined_sha256 !== expectationManifest.combined_sha256
    ) {
      holds.push({
        tier: 'attestation',
        code: 'expectation_hash_mismatch',
        key: attestedEvent.key,
      });
      attestedEvent = null;
    }
  }

  const initEvents = byKind('cohort_initialized');
  let cohortInit = null;
  for (const rec of initEvents) {
    const p = rec.payload;
    const stageAHashOk =
      stageAEvent != null && p.stage_a_event_hash === evidenceEventHash(stageAEvent.payload);
    const attestedHashOk =
      attestedEvent != null &&
      p.expectations_event_hash === evidenceEventHash(attestedEvent.payload);
    if (!stageAHashOk || !attestedHashOk) {
      invalid.push({
        key: rec.key,
        problems: [
          {
            code: 'cohort_init_version_mismatch',
            stage_a_ok: stageAHashOk,
            attested_ok: attestedHashOk,
          },
        ],
      });
      continue;
    }
    cohortInit = rec;
  }

  // ── reservations: PENDING records ──
  const pendings = [];
  for (const rec of reservationRecords) {
    if (rec.payload?.reservation_kind === 'attempt_pending') {
      pendings.push(rec);
    }
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
      blocks.push({ code: 'conflicting_terminals', attempt_ref: ref, keys: list.map((t) => t.key) });
      continue;
    }
    const t = list[0];
    const pending = pendingByRef.get(ref) ?? null;
    if (!pending) {
      invalid.push({ key: t.key, problems: [{ code: 'terminal_without_pending', attempt_ref: ref }] });
      continue;
    }
    const p = pending.payload;
    const tp = t.payload;
    if (
      p.requirement_key !== tp.requirement_key ||
      p.attempt_generation !== tp.attempt_generation ||
      (p.model ?? null) !== (tp.model ?? null) ||
      (p.tier ?? null) !== (tp.tier ?? null)
    ) {
      invalid.push({
        key: t.key,
        problems: [{ code: 'terminal_pending_identity_mismatch', attempt_ref: ref }],
      });
      continue;
    }
    // Referenced-report integrity: a terminal must carry its report digest;
    // provider ids may be empty ONLY on INVALID.
    const ids = Array.isArray(tp.provider_call_ids) ? tp.provider_call_ids : [];
    if (tp.verdict !== 'INVALID' && ids.length === 0) {
      invalid.push({ key: t.key, problems: [{ code: 'terminal_missing_provider_ids' }] });
      continue;
    }
    // Ordering assertions cannot move receipt days: generated_at must not
    // postdate the S3 receipt (small skew allowed).
    if (
      tp.generated_at != null &&
      Date.parse(tp.generated_at) > Date.parse(t.published_at) + CLOCK_SKEW_MS
    ) {
      invalid.push({ key: t.key, problems: [{ code: 'terminal_generated_after_receipt' }] });
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

  // ── per-requirement resolution (INVALID replacement, duplicates) ──
  /** requirement_key → { counted: {ref, terminal} | null, invalids: [] } */
  const requirements = new Map();
  for (const [ref, pair] of validTerminals) {
    const key = pair.terminal.payload.requirement_key;
    if (!requirements.has(key)) requirements.set(key, { counted: null, invalids: [], all: [] });
    requirements.get(key).all.push({ ref, ...pair });
  }
  for (const [key, req] of requirements) {
    const valids = req.all.filter((r) => r.terminal.payload.verdict !== 'INVALID');
    req.invalids = req.all.filter((r) => r.terminal.payload.verdict === 'INVALID');
    if (valids.length > 1) {
      blocks.push({ code: 'duplicate_valid_terminals_for_key', requirement_key: key });
      continue;
    }
    if (valids.length === 1) {
      req.counted = valids[0];
    } else if (req.invalids.length > 0) {
      // INVALID leaves the requirement unsatisfied and HOLDS only while no
      // later valid terminal exists for this exact key.
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
  const decisions = byKind('non_safety_decision');
  const decisionByMismatch = new Map();
  for (const d of decisions) decisionByMismatch.set(d.payload.mismatch_id, d.payload.decision);

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
      } else {
        const mismatchId = tp.mismatch?.mismatch_id ?? null;
        const decision = mismatchId != null ? decisionByMismatch.get(mismatchId) : undefined;
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

  // ── production sessions + manual/dialogue attestations (tier: binding) ──
  const boundSessions = byKind('production_session_bound');
  const boundBySession = new Map();
  for (const b of boundSessions) {
    const sid = b.payload.field_session_id;
    if (boundBySession.has(sid)) {
      blocks.push({ code: 'session_bound_twice', field_session_id: sid });
      continue;
    }
    boundBySession.set(sid, b);
  }

  const manuals = byKind('manual_attestation');
  const dialogueHearings = byKind('dialogue_hearing_attestation');
  const validManualByDay = new Map(); // receipt day → [{event, genuineSessions}]
  for (const m of manuals) {
    const p = m.payload;
    const problems = [];
    if (p.heard_completed_during_session === false && p.manual_result === 'pass') {
      problems.push({ code: 'false_plus_pass' });
    }
    if (!['pass', 'fail'].includes(p.manual_result)) problems.push({ code: 'unknown_manual_result' });
    if (p.manual_heard_by !== 'Derek') problems.push({ code: 'unknown_hearer' });
    if (p.field_context !== 'genuine_on_site') problems.push({ code: 'not_genuine_on_site' });
    const receiptDay = londonDayOf(m.published_at);
    if (p.day != null && p.day !== receiptDay) {
      problems.push({ code: 'claimed_day_receipt_day_mismatch', claimed: p.day, receipt: receiptDay });
    }
    const sid = p.confirmation_session_id;
    if (!Array.isArray(p.field_session_ids) || !p.field_session_ids.includes(sid)) {
      problems.push({ code: 'confirmation_session_not_bound_to_day' });
    }
    const bound = boundBySession.get(sid) ?? null;
    const manifests = manifestsBySession.get(sid) ?? null;
    if (!bound || !manifests || manifests.problems?.length) {
      problems.push({ code: 'session_manifests_unavailable' });
    } else {
      if (!sessionEvidenceEligible(manifests.completion)) {
        problems.push({ code: 'session_evidence_ineligible' });
      }
      const completedAt = manifests.completion?.completed_at ?? null;
      if (
        completedAt == null ||
        Date.parse(p.attested_at) <= Date.parse(completedAt) ||
        Date.parse(p.attested_at) >= Date.parse(m.published_at) + CLOCK_SKEW_MS
      ) {
        problems.push({ code: 'attested_at_ordering_invalid' });
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
      // A structurally invalid attestation can never reach semantic BLOCK.
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
    const receiptDay = londonDayOf(dh.published_at);
    // Fold rule (no new schema field): the session must be bound under a
    // valid same-day genuine-on-site daily attestation.
    const dayManuals = validManualByDay.get(receiptDay) ?? [];
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
      if (!res.resolved) problems.push({ code: 'dialogue_delivery_ref_unresolved', reason: res.reason });
      const completedAt = manifests.completion?.completed_at ?? null;
      if (
        completedAt == null ||
        Date.parse(p.attested_at) <= Date.parse(completedAt) ||
        Date.parse(p.attested_at) >= Date.parse(dh.published_at) + CLOCK_SKEW_MS
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
      // Heard-but-semantically-wrong dialogue BLOCKS (mirrors the manual lane).
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
  const approvedDeferrals = new Set(
    gapDecisions
      .filter((g) => g.payload.decision === 'approved' && g.payload.safety_critical !== true)
      .map((g) => g.payload.stratum_or_fixture)
  );
  const attestedFixtureIds = expectationManifest?.vendor_live_expectations?.fixture_ids ?? [];

  const initPublishedAt = cohortInit ? Date.parse(cohortInit.published_at) : null;
  const dayEvaluations = new Map();
  const countedByDay = new Map();
  for (const [, req] of requirements) {
    if (!req.counted) continue;
    const t = req.counted.terminal;
    if (initPublishedAt != null && Date.parse(t.published_at) < initPublishedAt) {
      invalid.push({ key: t.key, problems: [{ code: 'terminal_before_cohort_deployment' }] });
      continue;
    }
    const day = londonDayOf(t.published_at);
    if (!countedByDay.has(day)) countedByDay.set(day, []);
    countedByDay.get(day).push(req.counted);
  }

  const allDays = new Set([...countedByDay.keys(), ...validManualByDay.keys()]);
  for (const day of [...allDays].sort()) {
    const dayTerminals = countedByDay.get(day) ?? [];
    const evaluation = { day, requirements: {}, accepted: false };

    // 5 valid PASS pinned-IR repetitions, distinct cohort-unique ordinals.
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

    // One complete corpus run per model lane.
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

    // Bound genuine session(s) + manifest route/cache/family gates + manual PASS.
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
      const manifests = manifestsBySession.get(sid) ?? null;
      if (!manifests || manifests.problems?.length) continue;
      if (!sessionEvidenceEligible(manifests.completion)) continue;
      if (manifests.published_at == null || londonDayOf(manifests.published_at) !== day) continue;
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

  // ── state resolution (BLOCKED dominates; stale deployment holds) ──
  let state;
  let progress = null;
  let staleDeployment = false;
  if (blocks.length > 0) {
    state = 'BLOCKED';
  } else if (!stageAEvent) {
    state = 'NOT_STARTED';
  } else if (!cohortInit) {
    state = 'STAGE_A_IMPLEMENTED';
  } else {
    progress = `${Math.min(acceptedDays.length, REQUIRED_DAYS)}/${REQUIRED_DAYS}`;
    if (liveDeployment == null || !liveDeployment.available || !liveDeployment.fingerprint_matches) {
      state = 'HOLD_EVIDENCE';
      staleDeployment = true;
    } else if (
      acceptedDays.length >= REQUIRED_DAYS &&
      holds.length === 0 &&
      invalid.length === 0
    ) {
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
