/**
 * Plan 00B §B1 + 00B-2 C1/C3 — dormant per-entry evaluation lifecycle hooks
 * and the server-owned evaluation context.
 *
 * The semantic-oracle harness (scripts/model-ab, Plan 00B/00C) needs
 * evidence about a live session's lifecycle — successful frame sends,
 * confirmation deliveries, in-flight work counts and a quiescence-gated
 * completion freeze — WITHOUT changing production behaviour. This module is
 * that seam.
 *
 * Dormancy contract (load-bearing, test-pinned):
 *   - With no evaluation context registered on an entry, every hook here is
 *     a single optional property lookup that allocates nothing, serialises
 *     nothing, and changes no branch order or timing. Production traffic
 *     never registers a context — only the evaluation server option
 *     (initSonnetStream's `evaluationContextFactory`) does, and only in
 *     tests/evaluation runs.
 *   - Every evaluation key lives on NON-ENUMERABLE Symbol keys so no
 *     JSON.stringify of an entry (wire frames, logs, S3 uploads) can ever
 *     leak them.
 *
 * 00B-2 C1 — the factory result is normalised EXACTLY ONCE into one
 * server-owned evaluation context (`normaliseEvaluationContext`): the four
 * optional supplied roles ({observer, mutationObserver, askLedger,
 * deliveryLedger} — a bare observer object composes a lifecycle-only
 * context) plus server-owned state (the C2.1 ask runtime-binding map, the
 * per-turn askEmit/deliveryEmit callbacks, delivery-binding and
 * fast-correlation state, and the C3 producer counters). The caller's
 * object is never mutated. ONLY the normalised context is stashed
 * non-enumerably on the ENTRY via `EVALUATION_CONTEXT` — never on the
 * session — and every production seam resolves it from the active entry.
 *
 * 00B-2 C3 — freeze contract: boundary-keyed START and COMPLETION latches
 * under canonical keys (single-flight PER key, independent of the
 * descriptive boundary string). The COMPLETION freeze runs
 * `buildCandidate`/publish EVEN WHEN INELIGIBLE (00C's durable
 * `non_quiescent_at_stop` audit candidate) and latches the deep-frozen
 * `evidence` sibling — the ONLY judged evidence; live ledgers stay
 * diagnostics-only. Producer-aware quiescence: `beginProducer` counters for
 * every asynchronous producer kind fold into `readInFlightCounts`.
 */

import { MUTATION_OBSERVER } from './plan00-semantic-capture.js';
import {
  buildLiveAskKey,
  operationIdentityKey,
  PLAN00_ASK_EMIT_OBSERVER,
  PLAN00_DELIVERY_EMIT_OBSERVER,
  PLAN00_AUDIBILITY_DESCRIPTOR,
  PLAN00_FRAME_BINDING_REGISTRY,
} from './plan00-audibility-ledgers.js';

export const EVIDENCE_OBSERVER = Symbol('plan00.evidenceObserver');
export const LIFECYCLE_LEDGER = Symbol('plan00.lifecycleLedger');
export const EVALUATION_CONTEXT = Symbol('plan00.evaluationContext');
/**
 * C3 — evaluation-only per-round usage sink, stamped non-enumerably on the
 * session's CostTracker at fresh-create composition time. `ingestBillableUsage`
 * reads it via one Symbol lookup per ACCEPTED call; dormant otherwise.
 */
export const PLAN00_ROUND_USAGE_SINK = Symbol('plan00.roundUsageSink');

/**
 * C5 — THE canonical frozen list of every evaluation-only Symbol. The leak
 * sweep and parity matrix derive from THIS list; a new evaluation Symbol
 * that is not added here fails its focused RED leak test.
 */
export const EVALUATION_ONLY_SYMBOLS = Object.freeze([
  { name: 'EVIDENCE_OBSERVER', symbol: EVIDENCE_OBSERVER },
  { name: 'LIFECYCLE_LEDGER', symbol: LIFECYCLE_LEDGER },
  { name: 'EVALUATION_CONTEXT', symbol: EVALUATION_CONTEXT },
  { name: 'PLAN00_ROUND_USAGE_SINK', symbol: PLAN00_ROUND_USAGE_SINK },
  { name: 'MUTATION_OBSERVER', symbol: MUTATION_OBSERVER },
  { name: 'PLAN00_ASK_EMIT_OBSERVER', symbol: PLAN00_ASK_EMIT_OBSERVER },
  { name: 'PLAN00_DELIVERY_EMIT_OBSERVER', symbol: PLAN00_DELIVERY_EMIT_OBSERVER },
  { name: 'PLAN00_AUDIBILITY_DESCRIPTOR', symbol: PLAN00_AUDIBILITY_DESCRIPTOR },
  { name: 'PLAN00_FRAME_BINDING_REGISTRY', symbol: PLAN00_FRAME_BINDING_REGISTRY },
]);

const REVISION_KINDS = Object.freeze([
  'successful_frame',
  'confirmation_delivery',
  'outbox_replay',
  'refinement',
  'extraction',
  'queued_transcript',
  'ask',
]);

/**
 * C3 — the CANONICAL producer-kind registry. Every asynchronous producer
 * whose in-flight work must hold an eligible freeze open has exactly one
 * kind here; an unknown kind at `beginProducer` marks the lane INVALID.
 */
export const PRODUCER_KINDS = Object.freeze([
  'frame_send',
  'outbox_replay',
  'refinement',
  'confirmation_drain',
  'fast_tts',
  'address_mirror_ingress',
  'address_mirror_answer',
  'address_mirror_ack',
]);

function createLedgerState() {
  const revisions = {};
  for (const kind of REVISION_KINDS) revisions[kind] = 0;
  const producerCounts = {};
  for (const kind of PRODUCER_KINDS) producerCounts[kind] = 0;
  return {
    revisions,
    // C3 — boundary-keyed latches under CANONICAL keys, single-flight per
    // key. The old single `frozen` latch could not serve 00C's separate
    // start/completion manifests (a second call with a different boundary
    // returned the first's frozen) — deliberately replaced.
    latches: { start: null, completion: null },
    // B3 sub-record streams — append-only, immutable rows. Stays
    // append-mutable post-freeze (the freeze latches its own copy).
    subRecords: [],
    producerCounts,
    producerInvalid: null,
  };
}

function markProducerInvalid(ledger, reason, detail) {
  if (!ledger.producerInvalid) {
    ledger.producerInvalid = Object.freeze({ reason, detail: detail ?? null });
  }
}

/**
 * C1 — server-owned lifecycle-ledger init, split from external-observer
 * registration: EVERY non-null normalised evaluation context gets a ledger
 * (the C2/C3 seams — beginProducer, sub-record appends, the freeze — all
 * require it), while observer callbacks register ONLY when the observer
 * role is supplied. `registerEvidenceObserver` calls this itself, keeping
 * its own behaviour identical.
 */
export function initLifecycleLedger(entry) {
  if (!entry || typeof entry !== 'object') throw new Error('initLifecycleLedger: entry required');
  if (entry[LIFECYCLE_LEDGER]) return entry[LIFECYCLE_LEDGER];
  Object.defineProperty(entry, LIFECYCLE_LEDGER, {
    value: createLedgerState(),
    enumerable: false,
    configurable: true,
  });
  return entry[LIFECYCLE_LEDGER];
}

/**
 * Attach an evaluation observer to an activeSessions entry. Must run at
 * entry creation, BEFORE any observable message traffic, so the ledger sees
 * the whole lifecycle. Idempotent-hostile by design: a second registration
 * on the same entry throws — two observers would double-count evidence.
 */
export function registerEvidenceObserver(entry, observer) {
  if (!entry || typeof entry !== 'object')
    throw new Error('registerEvidenceObserver: entry required');
  if (!observer || typeof observer !== 'object')
    throw new Error('registerEvidenceObserver: observer required');
  if (entry[EVIDENCE_OBSERVER])
    throw new Error('registerEvidenceObserver: observer already registered');
  initLifecycleLedger(entry);
  Object.defineProperty(entry, EVIDENCE_OBSERVER, {
    value: observer,
    enumerable: false,
    configurable: true,
  });
  if (typeof observer.onRegistered === 'function') {
    try {
      observer.onRegistered({ at: 'entry_creation' });
    } catch (_err) {
      // Observer failures are evidence problems, never production problems.
    }
  }
  return entry[LIFECYCLE_LEDGER];
}

export function hasEvidenceObserver(entry) {
  return Boolean(entry && entry[EVIDENCE_OBSERVER]);
}

export function getEvidenceObserver(entry) {
  return (entry && entry[EVIDENCE_OBSERVER]) || null;
}

export function getLifecycleLedger(entry) {
  return (entry && entry[LIFECYCLE_LEDGER]) || null;
}

export function getEvaluationContext(entry) {
  return (entry && entry[EVALUATION_CONTEXT]) || null;
}

function appendLedgerRow(ledger, observer, kind, detail) {
  if (!(kind in ledger.revisions)) ledger.revisions[kind] = 0;
  ledger.revisions[kind] += 1;
  const row = Object.freeze({ kind, revision: ledger.revisions[kind], ...detail });
  ledger.subRecords.push(row);
  if (observer && typeof observer.onLifecycleEvent === 'function') {
    try {
      observer.onLifecycleEvent(row);
    } catch (_err) {
      // Behaviour isolation: a throwing observer callback must never reach
      // the production send path (it fires AFTER a successful ws.send and
      // could otherwise abort frame-ledger completion). The sub-record and
      // revision above are already latched; the observer's own failure is
      // its own evidence problem.
    }
  }
  return row;
}

/**
 * Record one immutable sub-record for a message/outbox/timer invocation and
 * bump the kind's monotonic revision. No-op (single property lookup) when no
 * ledger is initialised.
 */
export function recordLifecycleEvent(entry, kind, detail) {
  const ledger = entry && entry[LIFECYCLE_LEDGER];
  if (!ledger) return;
  appendLedgerRow(ledger, entry[EVIDENCE_OBSERVER], kind, detail);
}

/** Successful-frame callback (post-successful ws.send only). */
export function notifySuccessfulFrame(entry, detail) {
  recordLifecycleEvent(entry, 'successful_frame', detail);
}

/** Confirmation-delivery callback (B3 delivery_attempt evidence). */
export function notifyConfirmationDelivery(entry, detail) {
  recordLifecycleEvent(entry, 'confirmation_delivery', detail);
}

const NOOP_PRODUCER_HANDLE = Object.freeze({ complete() {} });

/**
 * C3 — begin one asynchronous producer of the given canonical kind.
 * Returns a SINGLE-USE completion handle, completed in `finally` at the
 * outermost producer boundary. Dormant no-op (one Symbol lookup, shared
 * frozen handle, zero allocation) without a ledger. Unknown kind, double
 * completion or counter underflow marks the lane INVALID — never throws
 * into production.
 */
export function beginProducer(entry, kind) {
  const ledger = entry && entry[LIFECYCLE_LEDGER];
  if (!ledger) return NOOP_PRODUCER_HANDLE;
  if (!(kind in ledger.producerCounts)) {
    markProducerInvalid(ledger, 'unknown_producer_kind', { kind });
    return NOOP_PRODUCER_HANDLE;
  }
  ledger.producerCounts[kind] += 1;
  let completed = false;
  return {
    complete() {
      if (completed) {
        markProducerInvalid(ledger, 'producer_double_completion', { kind });
        return;
      }
      completed = true;
      if (ledger.producerCounts[kind] <= 0) {
        markProducerInvalid(ledger, 'producer_counter_underflow', { kind });
        return;
      }
      ledger.producerCounts[kind] -= 1;
    },
  };
}

/**
 * Derive the in-flight work counts from REAL entry state, with the C3
 * per-kind producer counters folded in beside them. Every count must be
 * zero for an eligible completion freeze. The allowlist is deliberate and
 * exhaustive — each row names the production state it reads so a future
 * lifecycle addition shows up as a review question here, not a silent gap.
 */
export function readInFlightCounts(entry) {
  const session = entry?.session || null;
  const costTracker = session?.costTracker || null;
  const producerCounts = entry?.[LIFECYCLE_LEDGER]?.producerCounts || null;
  return {
    // 00A billable scopes — inspector AND non-inspector (keepalive, orphan
    // review) loops still holding an open begin..end scope.
    billable_invocations_in_flight: costTracker?.inFlightBillableInvocationCount ?? 0,
    // A live tool-loop turn currently running for this entry.
    extraction_in_flight: entry?.isExtracting ? 1 : 0,
    // Buffered transcripts waiting behind an in-flight extraction.
    queued_transcripts: Array.isArray(entry?.pendingTranscripts)
      ? entry.pendingTranscripts.length
      : 0,
    // Utterances buffered inside the session's batcher (flushed by stop).
    buffered_utterances: Array.isArray(session?.utteranceBuffer)
      ? session.utteranceBuffer.length
      : 0,
    // Extraction result frames produced while the socket was down, waiting
    // for a reconnect flush.
    pending_extraction_frames: Array.isArray(entry?.pendingExtractions)
      ? entry.pendingExtractions.length
      : 0,
    // Address-mirror outbox retry timer armed = a delivery is still owed.
    outbox_retry_armed: entry?.addressMirrorOutboxRetryHandle ? 1 : 0,
    // Observation refinements sent but not yet matched by the client.
    refinements_in_flight: entry?.pendingRefinements?.size ?? 0,
    // Blocking asks still outstanding (registry exposes a numeric getter).
    pending_asks: typeof entry?.pendingAsks?.size === 'number' ? entry.pendingAsks.size : 0,
    // C3 — producer start/completion counters, one per canonical kind.
    producer_frame_send: producerCounts?.frame_send ?? 0,
    producer_outbox_replay: producerCounts?.outbox_replay ?? 0,
    producer_refinement: producerCounts?.refinement ?? 0,
    producer_confirmation_drain: producerCounts?.confirmation_drain ?? 0,
    producer_fast_tts: producerCounts?.fast_tts ?? 0,
    producer_address_mirror_ingress: producerCounts?.address_mirror_ingress ?? 0,
    producer_address_mirror_answer: producerCounts?.address_mirror_answer ?? 0,
    producer_address_mirror_ack: producerCounts?.address_mirror_ack ?? 0,
  };
}

function readRevisionSnapshot(entry) {
  const ledger = entry[LIFECYCLE_LEDGER];
  const costTracker = entry?.session?.costTracker || null;
  return Object.freeze({
    ...ledger.revisions,
    usage_revision: costTracker?.usageRevision ?? 0,
  });
}

function sameRevisions(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

function deepFreezeCopy(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map(deepFreezeCopy));
  const out = {};
  for (const k of Object.keys(value)) out[k] = deepFreezeCopy(value[k]);
  return Object.freeze(out);
}

/**
 * C3 — compose the deep-frozen judged-evidence sibling at the freeze
 * chokepoint. A suspended producer resuming post-freeze can still mutate
 * the LIVE ledgers, so every verdict consumer judges ONLY this latched
 * copy; live ledgers stay diagnostics-only. Null when no evaluation
 * context is present.
 */
function composeFrozenEvidence(ctx, ledger, subRecordsSnapshot) {
  const mo = ctx.mutationObserver;
  const askLedger = ctx.askLedger;
  const deliveryLedger = ctx.deliveryLedger;
  return Object.freeze({
    receipts: deepFreezeCopy(mo ? [...mo.receipts] : []),
    mutation_invalid: deepFreezeCopy(mo?.invalid ?? null),
    ask_entries: deepFreezeCopy(askLedger ? [...askLedger.entries] : []),
    ask_invalid: deepFreezeCopy(askLedger?.invalid ?? null),
    deliveries: deepFreezeCopy(deliveryLedger ? [...deliveryLedger.deliveries] : []),
    playbacks: deepFreezeCopy(deliveryLedger ? [...deliveryLedger.playbacks] : []),
    provisionals: deepFreezeCopy(deliveryLedger ? [...deliveryLedger.provisionals] : []),
    delivery_invalid: deepFreezeCopy(deliveryLedger?.invalid ?? null),
    ambiguous_op_keys: deepFreezeCopy(
      typeof deliveryLedger?.ambiguousOpKeys === 'function' ? deliveryLedger.ambiguousOpKeys() : []
    ),
    non_mutating_audible: deepFreezeCopy([...ctx.nonMutatingAudible]),
    delivery_prepared_outstanding: ctx.deliveryPrepared.size,
    producer_counts: Object.freeze({ ...ledger.producerCounts }),
    producer_invalid: ledger.producerInvalid,
    sub_records: subRecordsSnapshot,
  });
}

function invokeBuilderAndPublish(observer, snapshot) {
  // Null-guarded on EVERY access — an observer-less (role-absent) context
  // still latches with candidate:null / publishPromise:null.
  let candidate = null;
  let builderThrew = null;
  if (observer && typeof observer.buildCandidate === 'function') {
    try {
      candidate = observer.buildCandidate(snapshot);
    } catch (err) {
      builderThrew = err?.message ?? String(err);
      candidate = null;
    }
  }
  let publishPromise = null;
  if (builderThrew == null && observer && typeof observer.publish === 'function') {
    publishPromise = Promise.resolve().then(() => observer.publish(candidate));
    // Latched promise — a rejection is the observer's own evidence problem;
    // never let it become an unhandled rejection that kills teardown.
    publishPromise.catch(() => {});
  }
  return { candidate, publishPromise, builderThrew };
}

function notifyFrozen(observer, frozen) {
  try {
    if (observer && typeof observer.onEvidenceFrozen === 'function')
      observer.onEvidenceFrozen(frozen);
  } catch (_err) {
    // isolated
  }
}

/**
 * C3 — the START-boundary candidate, invoked exactly once on the C1
 * fresh-create path after context/observer registration. Reconnect/resume
 * REUSE the latched start candidate, never re-invoke. The start latch
 * exists ONLY for 00C's start manifest — it can never satisfy the
 * post-session semantic verdict (test-pinned).
 */
export function freezeEvidenceStart(entry, { sessionId }) {
  const ledger = entry && entry[LIFECYCLE_LEDGER];
  if (!ledger) return null;
  if (ledger.latches.start) return ledger.latches.start;

  const observer = entry[EVIDENCE_OBSERVER];
  const counts = Object.freeze(readInFlightCounts(entry));
  const revisions = readRevisionSnapshot(entry);
  const subRecordsSnapshot = deepFreezeCopy([...ledger.subRecords]);
  // The SAME immutable five-key allowlisted snapshot shape as completion.
  const snapshot = Object.freeze({
    sessionId,
    boundary: 'session_started',
    counts,
    revisions,
    sub_records: subRecordsSnapshot,
  });
  const { candidate, publishPromise, builderThrew } = invokeBuilderAndPublish(observer, snapshot);
  ledger.latches.start = Object.freeze({
    latch_key: 'start',
    eligible: builderThrew == null,
    reason: builderThrew == null ? null : 'candidate_builder_threw',
    ...(builderThrew == null ? {} : { error: builderThrew }),
    boundary: 'session_started',
    sessionId,
    counts,
    revisions,
    candidate,
    publishPromise,
    evidence: null,
  });
  notifyFrozen(observer, ledger.latches.start);
  return ledger.latches.start;
}

/**
 * C3 — quiescence-gated COMPLETION freeze. Single-flight on the canonical
 * `completion` key; retries and duplicate teardown callers receive the
 * latched result. Returns null when dormant (no ledger).
 *
 * The completion builder runs EVEN WHEN INELIGIBLE — a
 * `non_quiescent_at_stop` completion still builds/publishes 00C's durable
 * audit candidate (always evidence-INELIGIBLE per 00C's own rule). The
 * quiescence outcome is encoded as two numeric keys inside the snapshot's
 * `counts` member (`non_quiescent_at_stop`, `revision_instability`),
 * composed HERE at freeze time — never by `readInFlightCounts` (deriving
 * the outcome inside the counts reader would be circular).
 */
export function freezeEvidenceCompletion(entry, { sessionId, boundary }) {
  const ledger = entry && entry[LIFECYCLE_LEDGER];
  if (!ledger) return null;
  if (ledger.latches.completion) return ledger.latches.completion;

  const observer = entry[EVIDENCE_OBSERVER];
  const ctx = entry[EVALUATION_CONTEXT] || null;
  const revisionsBefore = readRevisionSnapshot(entry);
  const inFlight = readInFlightCounts(entry);
  const revisionsAfter = readRevisionSnapshot(entry);
  const countsZero = Object.values(inFlight).every((v) => v === 0);
  const revisionsStable = sameRevisions(revisionsBefore, revisionsAfter);
  const quiescent = countsZero && revisionsStable;

  const counts = Object.freeze({
    ...inFlight,
    non_quiescent_at_stop: countsZero ? 0 : 1,
    revision_instability: revisionsStable ? 0 : 1,
  });

  // ONE latched immutable sub-record copy, used IDENTICALLY as the builder
  // snapshot's `sub_records` and as `frozen.evidence.sub_records` (identity
  // agreement is test-pinned). The live array stays append-mutable.
  const subRecordsSnapshot = deepFreezeCopy([...ledger.subRecords]);

  // Judged evidence is latched BEFORE the registered builder hook runs and
  // on BOTH eligible and ineligible freezes.
  const evidence = ctx ? composeFrozenEvidence(ctx, ledger, subRecordsSnapshot) : null;

  // Immutable allowlisted lifecycle/ledger snapshot for the pure builder —
  // exactly the five top-level keys {sessionId, boundary, counts, revisions,
  // sub_records}; family evidence rides the sub_records channel, never a
  // new top-level key and never a raw evidence/ledger object.
  const snapshot = Object.freeze({
    sessionId,
    boundary,
    counts,
    revisions: revisionsAfter,
    sub_records: subRecordsSnapshot,
  });

  const { candidate, publishPromise, builderThrew } = invokeBuilderAndPublish(observer, snapshot);

  let eligible = quiescent;
  let reason = null;
  if (!quiescent) reason = 'non_quiescent_at_stop';
  if (builderThrew != null) {
    eligible = false;
    if (reason == null) reason = 'candidate_builder_threw';
  }

  ledger.latches.completion = Object.freeze({
    latch_key: 'completion',
    eligible,
    reason,
    ...(builderThrew == null ? {} : { error: builderThrew }),
    boundary,
    sessionId,
    counts,
    revisions: revisionsAfter,
    candidate,
    publishPromise,
    evidence,
  });
  notifyFrozen(observer, ledger.latches.completion);
  return ledger.latches.completion;
}

/**
 * C3/C4 — the EXPLICIT completion-latch accessor: the ONLY read path for
 * the lane driver and the judge adapter. The start latch can never satisfy
 * the post-session semantic verdict.
 */
export function getCompletionFreeze(entry) {
  return entry?.[LIFECYCLE_LEDGER]?.latches?.completion ?? null;
}

export function getStartFreeze(entry) {
  return entry?.[LIFECYCLE_LEDGER]?.latches?.start ?? null;
}

// ── C1 — the server-owned evaluation context ────────────────────────────────

const CONTEXT_ROLE_KEYS = Object.freeze([
  'observer',
  'mutationObserver',
  'askLedger',
  'deliveryLedger',
]);

const ROUND_USAGE_ALLOWLIST = Object.freeze([
  'provider',
  'requested_model',
  'requested_tier',
  'response_model',
  'response_tier',
  'billing_model',
  'billing_tier',
  'model_provenance',
  'tier_provenance',
  'attribution_status',
  'reasoning_effort',
  'prompt_cache_mode',
  'prompt_cache_breakpoint_enabled',
  'prompt_cache_key_id',
  'fresh_input_tokens',
  'cache_read_input_tokens',
  'cache_write_input_tokens',
  'output_tokens',
  'round_idx',
]);

/**
 * C1 — normalise a factory result into the ONE server-owned evaluation
 * context. A bare observer (the pre-00B-2 factory shape) composes a
 * lifecycle-only context; the full {observer, mutationObserver, askLedger,
 * deliveryLedger} shape is optional per role. Returns null for a
 * null/undefined factory result. The caller's object is never mutated.
 */
export function normaliseEvaluationContext(rawResult, { sessionId = null } = {}) {
  if (!rawResult || typeof rawResult !== 'object') return null;
  const isFullShape = CONTEXT_ROLE_KEYS.some((k) =>
    Object.prototype.hasOwnProperty.call(rawResult, k)
  );
  const observer = isFullShape ? (rawResult.observer ?? null) : rawResult;
  const mutationObserver = isFullShape ? (rawResult.mutationObserver ?? null) : null;
  const askLedger = isFullShape ? (rawResult.askLedger ?? null) : null;
  const deliveryLedger = isFullShape ? (rawResult.deliveryLedger ?? null) : null;

  const ctx = {
    sessionId,
    observer,
    mutationObserver,
    askLedger,
    deliveryLedger,
    entryRef: null,
    // C2.1 — context-local runtime binding map: runtime id → full
    // liveAskKey + semantic metadata, populated at every producer before
    // its wire send.
    askRuntimeBindings: new Map(),
    // C2.4 — srv-* two-half join state: runtimeId → { consumedUtteranceId }.
    srvAnswerHalves: new Map(),
    // C2.5 — emitted NON-MUTATING audible evidence (outside both the ask
    // ledger and the deliveryLedger; the judge reads it from frozen
    // evidence).
    nonMutatingAudible: [],
    // C2.5 — dialogue delivery prepare/commit state (payload → descriptor).
    deliveryPrepared: new Map(),
  };

  const ledgerOf = () => ctx.entryRef?.[LIFECYCLE_LEDGER] ?? null;
  const appendSub = (kind, detail) => {
    const ledger = ledgerOf();
    if (!ledger) return;
    appendLedgerRow(ledger, ctx.observer, kind, detail);
  };

  // ── ask lifecycle helpers (exactly-once ownership map callers) ──
  ctx.recordAskProduced = ({ family, runtimeId, liveAskKey, meta = null }) => {
    if (!ctx.askLedger) return;
    if (ctx.askRuntimeBindings.has(runtimeId)) {
      ctx.askLedger.markInvalid('duplicate_runtime_binding', { runtimeId });
      return;
    }
    ctx.askRuntimeBindings.set(runtimeId, { key: liveAskKey, family, meta });
    ctx.askLedger.produced(liveAskKey, { family, ...(meta ?? {}) });
    appendSub('ask_lifecycle', {
      family,
      stage: 'produced',
      runtime_id: runtimeId,
      live_ask_key: liveAskKey,
    });
  };

  ctx.recordAskEmitted = ({ runtimeId }) => {
    if (!ctx.askLedger) return;
    const binding = ctx.askRuntimeBindings.get(runtimeId);
    if (!binding) {
      ctx.askLedger.markInvalid('emitted_without_binding', { runtimeId });
      return;
    }
    const already = ctx.askLedger.entries.find(
      (e) => e.runtime_id === runtimeId && e.state !== 'produced'
    );
    if (already) {
      // Same-id re-send (reconnect/resume replay of the address-mirror
      // direct question — the only production same-id re-send).
      ctx.askLedger.reissuedAttempt(runtimeId);
      appendSub('ask_lifecycle', {
        family: binding.family,
        stage: 'reissued_attempt',
        runtime_id: runtimeId,
      });
      return;
    }
    ctx.askLedger.emitted(binding.key, runtimeId);
    appendSub('ask_lifecycle', {
      family: binding.family,
      stage: 'emitted',
      runtime_id: runtimeId,
    });
  };

  ctx.recordAskResolved = ({ runtimeId, terminal, detail = {} }) => {
    if (!ctx.askLedger) return;
    const binding = ctx.askRuntimeBindings.get(runtimeId) ?? null;
    ctx.askLedger.resolved(runtimeId, terminal, detail);
    appendSub('ask_lifecycle', {
      family: binding?.family ?? null,
      stage: 'resolved',
      runtime_id: runtimeId,
      terminal,
    });
  };

  ctx.recordAskReplacement = ({ predecessorRuntimeId, successorRuntimeId }) => {
    if (!ctx.askLedger) return;
    ctx.askLedger.linkReplacement(predecessorRuntimeId, successorRuntimeId);
    appendSub('ask_lifecycle', {
      family: ctx.askRuntimeBindings.get(predecessorRuntimeId)?.family ?? null,
      stage: 'replaced',
      runtime_id: predecessorRuntimeId,
      successor_runtime_id: successorRuntimeId,
    });
  };

  // ── C2.4 srv-* two-half join ──
  ctx.recordSrvAnswerFrame = ({ runtimeId, consumedUtteranceId }) => {
    if (!ctx.askLedger) return;
    ctx.srvAnswerHalves.set(runtimeId, { consumedUtteranceId: consumedUtteranceId ?? null });
  };

  ctx.resolveSrvEngineConsumption = ({ utteranceId }) => {
    if (!ctx.askLedger || utteranceId == null) return;
    for (const [runtimeId, half] of ctx.srvAnswerHalves) {
      if (half.consumedUtteranceId !== utteranceId) continue;
      if (!ctx.askRuntimeBindings.has(runtimeId)) continue;
      ctx.srvAnswerHalves.delete(runtimeId);
      ctx.recordAskResolved({
        runtimeId,
        terminal: 'answered',
        detail: { answer_frame_id: runtimeId, transcript_resolved: true },
      });
    }
  };

  ctx.expireSrvJoins = (reason) => {
    if (ctx.srvAnswerHalves.size > 0) {
      appendSub('ask_lifecycle', {
        family: 'dialogue_script',
        stage: 'join_expired',
        expired: ctx.srvAnswerHalves.size,
        reason: reason ?? null,
      });
      ctx.srvAnswerHalves.clear();
    }
  };

  // ── delivery / playback / non-mutating audible ──
  ctx.recordDelivery = (opIdentities, { kind, transport = null, claimLineage = null } = {}) => {
    if (!ctx.deliveryLedger) return;
    ctx.deliveryLedger.recordDeliveryAttempt(opIdentities, {
      kind,
      transport,
      claimLineage,
    });
    const keys = (Array.isArray(opIdentities) ? opIdentities : [opIdentities]).map((op) =>
      operationIdentityKey(op)
    );
    appendSub('delivery_evidence', {
      family: transport ?? null,
      delivery_kind: kind ?? 'confirmation',
      op_keys: keys,
    });
  };

  ctx.recordPlayback = (ackBody, matchingOps, { source = null } = {}) => {
    if (!ctx.deliveryLedger) return null;
    const row = ctx.deliveryLedger.recordPlaybackAck(ackBody, matchingOps);
    if (row) {
      appendSub('playback_evidence', { op_key: row.op_key, source });
    }
    return row;
  };

  ctx.recordNonMutatingAudible = ({ channel, kind, text = null }) => {
    ctx.nonMutatingAudible.push(
      Object.freeze({ channel: channel ?? null, kind: kind ?? null, text })
    );
    appendSub('non_mutating_audible', { channel: channel ?? null, audible_kind: kind ?? null });
  };

  // ── C2.5/C2.6 address-mirror audibility units (Tier 2) ──
  // The collapsed terminal is ONE multi-operation unit keyed by its
  // delivery claim lineage; `address_mirror_delivery_ack` correlates by
  // token + claim lineage to exactly one unit. Duplicate/stale/wrong-token
  // acks resolve to no unit and stay non-authoritative telemetry.
  ctx.addressMirrorUnits = new Map();
  ctx.recordAddressMirrorTerminal = ({ claimLineage, ops, text = null }) => {
    const identities = Array.isArray(ops) ? ops : [];
    if (identities.length === 0) {
      // No operation-backed content — the spoken terminal is non-mutating
      // audible evidence (e.g. a 'no'/'copied' acknowledgement).
      ctx.recordNonMutatingAudible({ channel: 'ws_vcr', kind: 'address_mirror_terminal', text });
      return;
    }
    if (!ctx.deliveryLedger) return;
    ctx.recordDelivery(identities, {
      kind: 'address_mirror_terminal',
      transport: 'ws_vcr',
      claimLineage,
    });
    ctx.addressMirrorUnits.set(claimLineage, identities);
  };
  ctx.recordAddressMirrorAck = ({ claimLineage, ackBody }) => {
    const identities = ctx.addressMirrorUnits.get(claimLineage);
    if (!identities) return null;
    return ctx.recordPlayback(ackBody, [identities[0]], {
      source: 'address_mirror_delivery_ack',
    });
  };

  // ── C3 round_usage sink (attached to the CostTracker pre-start) ──
  ctx.roundUsageSink = (row, { loopInvocationId, billableKind } = {}) => {
    const ledger = ledgerOf();
    if (!ledger) return;
    // HAND-BUILT allowlisted detail — never a spread of the raw evidence
    // row (`recordLifecycleEvent` spreads detail AFTER its own `kind`
    // field, so a raw row carrying `kind` would overwrite the
    // `round_usage` discriminator; test-pinned).
    const detail = {};
    for (const k of ROUND_USAGE_ALLOWLIST) {
      detail[k] = row?.[k] ?? null;
    }
    detail.billable_kind = billableKind ?? null;
    detail.loop_invocation_id = loopInvocationId ?? null;
    appendLedgerRow(ledger, ctx.observer, 'round_usage', detail);
  };

  // ── per-turn ws-stamped sibling observers (dialogue engine safeSend) ──
  ctx.askEmit = {
    // Admission rule (ASK-LEDGER-ONLY): expected_answer_shape:'none' frames
    // are dialogue speech, not asks — safeSend routes them to deliveryEmit.
    produced(payload) {
      if (!ctx.askLedger || !payload) return;
      const runtimeId = payload.tool_call_id;
      if (ctx.askRuntimeBindings.has(runtimeId)) return; // re-send: emit phase reissues
      const key = buildLiveAskKey({
        origin: 'dialogue_script',
        purpose: payload.purpose ?? null,
        reason: payload.reason ?? null,
        contextField: payload.context_field ?? null,
        boardId: null,
        circuits: payload.context_circuit != null ? [payload.context_circuit] : [],
        expectedAnswerShape: payload.expected_answer_shape ?? null,
        observationClarificationKind: null,
        pendingWrite: null,
        chainRole: null,
      });
      ctx.recordAskProduced({ family: 'dialogue_script', runtimeId, liveAskKey: key });
    },
    emitted(payload) {
      if (!ctx.askLedger || !payload) return;
      ctx.recordAskEmitted({ runtimeId: payload.tool_call_id });
    },
  };

  ctx.deliveryEmit = {
    prepare(payload, descriptor) {
      ctx.deliveryPrepared.set(payload, descriptor);
    },
    commit(payload, descriptor) {
      ctx.deliveryPrepared.delete(payload);
      const ops = descriptor?.operations ?? [];
      if (ops.length === 0) return;
      ctx.recordDelivery(
        ops.map((op) => ({
          extractionTurnId: ctx.mutationObserver?.openTurnId ?? null,
          field: op.field,
          circuit: op.circuit,
          boardId: op.board_id,
        })),
        { kind: 'dialogue_confirmation', transport: 'dialogue_ws' }
      );
    },
    abort(payload, _reason) {
      ctx.deliveryPrepared.delete(payload);
    },
    nonMutating(payload) {
      ctx.recordNonMutatingAudible({
        channel: 'dialogue_ws',
        kind: 'info',
        text: payload?.question ?? null,
      });
    },
  };

  return ctx;
}

/**
 * C1 — stash the normalised context on the ENTRY (never the session),
 * initialise the server-owned lifecycle ledger, and register observer
 * callbacks only when the observer role is supplied. Runs EXACTLY ONCE per
 * fresh entry — reconnect and resume preserve the same context instance
 * (double registration throws by design via registerEvidenceObserver).
 */
export function attachEvaluationContext(entry, ctx) {
  if (!entry || typeof entry !== 'object')
    throw new Error('attachEvaluationContext: entry required');
  if (!ctx || typeof ctx !== 'object')
    throw new Error('attachEvaluationContext: normalised context required');
  if (entry[EVALUATION_CONTEXT])
    throw new Error('attachEvaluationContext: context already attached');
  initLifecycleLedger(entry);
  Object.defineProperty(entry, EVALUATION_CONTEXT, {
    value: ctx,
    enumerable: false,
    configurable: true,
  });
  ctx.entryRef = entry;
  if (ctx.observer) {
    registerEvidenceObserver(entry, ctx.observer);
  }
  return ctx;
}

export const _internals = Object.freeze({
  REVISION_KINDS,
  readRevisionSnapshot,
  sameRevisions,
  deepFreezeCopy,
  composeFrozenEvidence,
  ROUND_USAGE_ALLOWLIST,
});
