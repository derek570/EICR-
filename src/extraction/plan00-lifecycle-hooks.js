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
import {
  producerEntry,
  NON_QUIESCENT_TERMINALS,
  REJECTION_REASONS,
} from './plan00-evidence-registry.js';
import {
  createCaptureBudget,
  makeBudgetHolder,
  CAPTURE_BUDGET_OVERFLOW_KIND,
} from './plan00-capture-budget.js';
import logger from '../logger.js';

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
    // Plan 00B C3 — capture/row budget holder. A PRIVATE default keeps a
    // standalone ledger bounded (tests, hand-built eval shapes); the
    // session-shared budget is adopted once by `attachEvaluationContext`, so
    // the ceiling is on TOTAL evidence memory rather than per-collection.
    budgetHolder: makeBudgetHolder(),
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
  // Plan 00B C3 — THE row-admission gate for every lifecycle sub-record. The
  // reserved overflow marker is exempt BY NAME: that exemption IS the plan's
  // "reserved capacity for exactly one overflow marker row" (it is minted
  // exactly once, from the first-wins sink below, so the exemption cannot be
  // spent twice). Declining here bumps no revision, appends no row and fires
  // no observer callback — and because NO caller consumes this return value,
  // production control flow is untouched.
  if (
    kind !== CAPTURE_BUDGET_OVERFLOW_KIND &&
    ledger.budgetHolder &&
    !ledger.budgetHolder.current.admit('lifecycle_row')
  ) {
    return null;
  }
  if (!(kind in ledger.revisions)) ledger.revisions[kind] = 0;
  ledger.revisions[kind] += 1;
  // Codex r3 finding 4 — DEEP freeze: a shallow-frozen row left nested
  // evidence (op_keys arrays) mutable through the observer callback, and a
  // corrupted value would sit in the live ledger for the completion freeze
  // to copy. deepFreezeCopy is the same helper the freeze latches use.
  const row = deepFreezeCopy({ kind, revision: ledger.revisions[kind], ...detail });
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
  // Plan 00B-3 C2 — per-family open-ask counts from the evaluation ask
  // ledger, one key per ASK_QUIESCENCE_FAMILIES member. An entry is OPEN
  // for quiescence while produced/emitted, AND when terminal-resolved with
  // a STOP-BOUNDARY terminal (an ask open AT the stop boundary renders the
  // freeze ineligible even after stop-expiry resolves it — the closed
  // non-quiescent set; any other terminal closes it). Dormant: one Symbol
  // lookup when no evaluation context is attached.
  const evalCtx = entry?.[EVALUATION_CONTEXT] ?? null;
  const askLedger = evalCtx?.askLedger ?? null;
  const openAsks = { dispatcher: 0, dialogue_script: 0, address_mirror: 0 };
  if (askLedger) {
    // Codex r1 (C-3) — entries OPEN when teardown began stay counted even
    // if they resolve with a quiescence-compatible terminal during the
    // teardown's awaited flushes: open AT the stop boundary is the fact
    // the freeze must see (the latch is a Set of entry references).
    const stopLatched = evalCtx?.stopBoundaryOpenAsks ?? null;
    const boundaryCut = evalCtx?.stopBoundaryEntryCount ?? null;
    for (let idx = 0; idx < askLedger.entries.length; idx += 1) {
      const e = askLedger.entries[idx];
      const open =
        e.state === 'produced' ||
        e.state === 'emitted' ||
        // Codex r1 (B-5) — `unknown_terminal` joins the stop-boundary set:
        // a genuinely unknown outcome must not quietly close an ask.
        NON_QUIESCENT_TERMINALS.includes(e.state) ||
        (stopLatched != null && stopLatched.has(e)) ||
        // Mini-review M-5 — produced AFTER the stop boundary: born during
        // teardown, non-quiescent whatever its terminal.
        (boundaryCut != null && idx >= boundaryCut);
      if (!open) continue;
      const family = e.meta?.family;
      if (family in openAsks) openAsks[family] += 1;
    }
  }
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
    // Plan 00B-3 C2 — Tier-2 ask quiescence: every family's open-ask count
    // must be zero for an eligible completion freeze.
    open_asks_dispatcher: openAsks.dispatcher,
    open_asks_dialogue_script: openAsks.dialogue_script,
    open_asks_address_mirror: openAsks.address_mirror,
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
  // C2.7 — settle any finish-then-receipt fast-TTS promotions BEFORE the
  // revision/quiescence measurement (Codex r2 finding 2: settling after the
  // snapshot left the frozen revisions stale relative to the promotion's
  // delivery/playback writes, so an eligible freeze could carry an unbound
  // delivery).
  if (ctx && typeof ctx.settleFastTts === 'function') {
    try {
      ctx.settleFastTts();
    } catch (_err) {
      // isolated
    }
  }
  // Plan 00B-3 C5 — freeze-time canonical rows, in the PINNED ordering:
  // AFTER ctx.settleFastTts() and BEFORE the revisionsBefore read, so the
  // rows are covered by the frozen revisions AND the latched snapshot and
  // can never trip revision_instability.
  if (ctx) {
    // Unconsumed fast-TTS provisionals FOLD into the delivery-ledger invalid
    // latch via the EXISTING non-throwing check (one derivation — never a
    // parallel unconsumed-provisional scan, never a throw into teardown).
    if (
      ctx.deliveryLedger &&
      typeof ctx.deliveryLedger.assertNoUnconsumedProvisionals === 'function'
    ) {
      try {
        ctx.deliveryLedger.assertNoUnconsumedProvisionals();
      } catch (_err) {
        // isolated
      }
    }
    // Condition-gated: a row is appended ONLY when the invalid/outstanding
    // condition holds — never a zero/null placeholder (schema-v1
    // freeze_invalid). Any of these rows renders the 00C session INELIGIBLE
    // for family credit; the latch's own `eligible` flag deliberately keeps
    // its quiescence-only meaning (the judge reads the latches separately).
    const freezeObserver = entry[EVIDENCE_OBSERVER];
    const freezeRow = (detail) => appendLedgerRow(ledger, freezeObserver, 'freeze_invalid', detail);
    if (ctx.askLedger?.invalid) {
      freezeRow({
        condition: 'ask_invalid',
        reason: ctx.askLedger.invalid.reason ?? null,
        count: null,
      });
    }
    if (ctx.deliveryLedger?.invalid) {
      freezeRow({
        condition: 'delivery_invalid',
        reason: ctx.deliveryLedger.invalid.reason ?? null,
        count: null,
      });
    }
    if (ledger.producerInvalid) {
      freezeRow({
        condition: 'producer_invalid',
        reason: ledger.producerInvalid.reason ?? null,
        count: null,
      });
    }
    if (ctx.mutationObserver?.invalid) {
      freezeRow({
        condition: 'mutation_invalid',
        reason: ctx.mutationObserver.invalid.reason ?? null,
        count: null,
      });
    }
    if (ctx.deliveryPrepared.size > 0) {
      freezeRow({
        condition: 'delivery_prepared_outstanding',
        reason: null,
        count: ctx.deliveryPrepared.size,
      });
    }
  }
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
  // Plan 00B-3 C5 — WHICH API served the round (adapter-stamped actual
  // transport: anthropic_messages | chat_completions | responses; never
  // configuration). The Terra/cache gates consume the actual transport.
  'api_transport',
  // Plan 00B live-lane C5 — WHICH KIND of loop produced the round
  // (observation | reading), threaded from the shadow harness's
  // routeToObservationTier decision. The Terra gate requires an explicit
  // 'observation'; every other loop class normalises to 'reading' at the
  // producer, so an absent/malformed value can never earn Terra credit.
  'turn_kind',
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
    // Plan 00B C3 — THE session-shared capture budget. Created here because
    // this is the single place every evidence role of one session meets; the
    // roles adopt it below (first-wins) so the bound is on total evidence
    // memory rather than per-collection.
    captureBudget: createCaptureBudget(),
  };

  // Adopt the shared budget into every role that owns an unbounded collection.
  // Each role also carries a private default, so a role used standalone (or a
  // hand-built partial context) is still bounded.
  for (const role of [askLedger, deliveryLedger, mutationObserver]) {
    role?.adoptCaptureBudget?.(ctx.captureBudget);
  }

  const ledgerOf = () => ctx.entryRef?.[LIFECYCLE_LEDGER] ?? null;
  const appendSub = (kind, detail) => {
    const ledger = ledgerOf();
    if (!ledger) return;
    appendLedgerRow(ledger, ctx.observer, kind, detail);
  };

  // Plan 00B-3 C3 — registry admission. record* APIs accept REGISTRY IDs,
  // never free-form family strings; an UNKNOWN id (or an id of the wrong
  // event class) appends an uncreditable `producer_unknown` row and marks
  // the OWNING ledger invalid — fail-loud, never silent absence.
  const resolveProducer = (producerId, eventClass) => {
    const producer = producerEntry(producerId);
    if (producer && producer.event_class === eventClass) return producer;
    appendSub('producer_unknown', {
      event_class: eventClass,
      producer_id_raw: producerId ?? null,
    });
    const owner = eventClass === 'ask' ? ctx.askLedger : ctx.deliveryLedger;
    owner?.markInvalid?.('unknown_producer_id', {
      producer_id: producerId ?? null,
      event_class: eventClass,
    });
    return null;
  };

  // Plan 00B-3 C1 — the rejected-audit append (one mutually exclusive row
  // per attempted transition; distinct discriminator, projects zero credit).
  const appendAskRejected = ({ family, stageAttempted, runtimeId, terminalAttempted, reason }) => {
    const detail = {
      family: family ?? null,
      stage_attempted: stageAttempted,
      runtime_id: runtimeId ?? null,
      reason,
    };
    if (terminalAttempted !== undefined) detail.terminal_attempted = terminalAttempted;
    appendSub('ask_transition_rejected', detail);
  };

  // ── ask lifecycle helpers (exactly-once ownership map callers) ──
  // Plan 00B-3 C1 — every sub-record is DERIVED FROM the ledger verdict
  // (one derivation, never a parallel append beside it).
  ctx.recordAskProduced = ({
    producerId,
    runtimeId,
    liveAskKey,
    meta = null,
    replacesRuntimeId = null,
  }) => {
    if (!ctx.askLedger) return;
    const producer = resolveProducer(producerId, 'ask');
    if (!producer) return;
    const family = producer.quiescence_family;
    if (ctx.askRuntimeBindings.has(runtimeId)) {
      ctx.askLedger.markInvalid('duplicate_runtime_binding', { runtimeId });
      appendAskRejected({
        family,
        stageAttempted: 'produced',
        runtimeId,
        reason: 'duplicate_runtime_binding',
      });
      return;
    }
    // Plan 00B C3 — the ctx binding maps are evidence-side only (nothing in
    // production reads them), so past the budget the binding is simply not
    // retained. A later miss can only take a rejected/unknown branch whose
    // append is already blocked by the same budget, so no row can be minted
    // from the absence.
    if (ctx.captureBudget?.admit('ask_runtime_binding') !== false) {
      ctx.askRuntimeBindings.set(runtimeId, { key: liveAskKey, family, producerId, meta });
    }
    // Codex r1 (B-1) — the REGISTRY-derived family wins over caller meta:
    // spreading meta after `family` let a caller overwrite the ledger
    // family, splitting the quiescence count from the sub-record family.
    const verdict = ctx.askLedger.produced(liveAskKey, { ...(meta ?? {}), family });
    if (verdict?.accepted) {
      const detail = {
        family,
        stage: 'produced',
        runtime_id: runtimeId,
        live_ask_key: liveAskKey,
      };
      // Codex r1 (C-7) — the successor's produced row carries the broker
      // predecessor lineage, so a link-only replacement (already-terminal
      // predecessor, no transition row) stays reconstructable from
      // sub_records alone.
      if (replacesRuntimeId != null) detail.replaces_runtime_id = replacesRuntimeId;
      appendSub('ask_lifecycle', detail);
    }
  };

  ctx.recordAskEmitted = ({ runtimeId }) => {
    if (!ctx.askLedger) return;
    const binding = ctx.askRuntimeBindings.get(runtimeId);
    if (!binding) {
      ctx.askLedger.markInvalid('emitted_without_binding', { runtimeId });
      appendAskRejected({
        family: null,
        stageAttempted: 'emitted',
        runtimeId,
        reason: 'emitted_without_binding',
      });
      return;
    }
    const already = ctx.askLedger.entries.find(
      (e) => e.runtime_id === runtimeId && e.state !== 'produced'
    );
    if (already) {
      // Same-id re-send (reconnect/resume replay of the address-mirror
      // direct question — the only production same-id re-send).
      const verdict = ctx.askLedger.reissuedAttempt(runtimeId);
      if (verdict?.accepted) {
        appendSub('ask_lifecycle', {
          family: binding.family,
          stage: 'reissued_attempt',
          runtime_id: runtimeId,
        });
      } else {
        appendAskRejected({
          family: binding.family,
          stageAttempted: 'reissued_attempt',
          runtimeId,
          reason: verdict?.reason ?? null,
        });
      }
      return;
    }
    const verdict = ctx.askLedger.emitted(binding.key, runtimeId);
    if (verdict?.accepted) {
      appendSub('ask_lifecycle', {
        family: binding.family,
        stage: 'emitted',
        runtime_id: runtimeId,
      });
    } else {
      appendAskRejected({
        family: binding.family,
        stageAttempted: 'emitted',
        runtimeId,
        reason: verdict?.reason ?? null,
      });
    }
  };

  ctx.recordAskResolved = ({ runtimeId, terminal, detail = {} }) => {
    if (!ctx.askLedger) return;
    const binding = ctx.askRuntimeBindings.get(runtimeId) ?? null;
    const verdict = ctx.askLedger.resolved(runtimeId, terminal, detail);
    if (verdict?.accepted) {
      appendSub('ask_lifecycle', {
        family: binding?.family ?? null,
        stage: 'resolved',
        runtime_id: runtimeId,
        terminal,
      });
    } else {
      appendAskRejected({
        family: binding?.family ?? null,
        stageAttempted: 'resolved',
        runtimeId,
        terminalAttempted: terminal ?? null,
        reason: verdict?.reason ?? null,
      });
    }
  };

  ctx.recordAskReplacement = ({ predecessorRuntimeId, successorRuntimeId }) => {
    if (!ctx.askLedger) return;
    const family = ctx.askRuntimeBindings.get(predecessorRuntimeId)?.family ?? null;
    const verdict = ctx.askLedger.linkReplacement(predecessorRuntimeId, successorRuntimeId);
    if (verdict?.accepted && verdict.transitioned) {
      appendSub('ask_lifecycle', {
        family,
        stage: 'replaced',
        runtime_id: predecessorRuntimeId,
        successor_runtime_id: successorRuntimeId,
      });
    } else if (verdict && !verdict.accepted) {
      appendAskRejected({
        family,
        stageAttempted: 'replaced',
        runtimeId: predecessorRuntimeId,
        reason: verdict.reason ?? null,
      });
    }
    // accepted-but-not-transitioned = a link-only annotation on an already
    // terminal predecessor: no transition happened, no row (the successor's
    // own produced row carries the lineage).
  };

  // ── C2.4 srv-* two-half join ──
  ctx.recordSrvAnswerFrame = ({ runtimeId, consumedUtteranceId }) => {
    if (!ctx.askLedger) return;
    // Plan 00B C3 — budgeted; an unretained half can only leave the join
    // unresolved, and the row that join would have appended is blocked too.
    if (ctx.captureBudget?.admit('srv_answer_half') === false) return;
    ctx.srvAnswerHalves.set(runtimeId, { consumedUtteranceId: consumedUtteranceId ?? null });
  };

  ctx.resolveSrvEngineConsumption = ({ utteranceId }) => {
    if (!ctx.askLedger || utteranceId == null) return;
    // Codex r4 finding 3 — ONE dialogue transcript resolves EXACTLY ONE
    // srv-* ask. Two open bindings both naming this utterance (duplicate /
    // stale frames) are an ambiguity the join must fail CLOSED on — never
    // two answered terminals from one spoken reply.
    const candidates = [];
    for (const [runtimeId, half] of ctx.srvAnswerHalves) {
      if (half.consumedUtteranceId !== utteranceId) continue;
      if (!ctx.askRuntimeBindings.has(runtimeId)) continue;
      candidates.push(runtimeId);
    }
    if (candidates.length === 0) return;
    if (candidates.length > 1) {
      for (const runtimeId of candidates) ctx.srvAnswerHalves.delete(runtimeId);
      ctx.askLedger.markInvalid('srv_answer_ambiguous', {
        utterance_id: utteranceId,
        candidates: candidates.length,
      });
      appendAskRejected({
        family: 'dialogue_script',
        stageAttempted: 'resolved',
        runtimeId: null,
        reason: 'srv_answer_ambiguous',
      });
      return;
    }
    const runtimeId = candidates[0];
    ctx.srvAnswerHalves.delete(runtimeId);
    ctx.recordAskResolved({
      runtimeId,
      terminal: 'answered',
      detail: { answer_frame_id: runtimeId, transcript_resolved: true },
    });
  };

  // Codex r1 (C-3) — stop-boundary open-ask latch, invoked SYNCHRONOUSLY at
  // teardown begin (before any awaited flush). An ask open at this instant
  // renders THIS session's completion freeze ineligible even if it resolves
  // with a quiescence-compatible terminal during the teardown's awaits.
  ctx.stopBoundaryOpenAsks = null;
  ctx.stopBoundaryEntryCount = null;
  ctx.latchStopBoundary = () => {
    if (ctx.stopBoundaryOpenAsks || !ctx.askLedger) return;
    const latched = new Set();
    for (const e of ctx.askLedger.entries) {
      if (e.state === 'produced' || e.state === 'emitted') latched.add(e);
    }
    ctx.stopBoundaryOpenAsks = latched;
    // Mini-review M-5 — an ask PRODUCED after the boundary (during the
    // teardown's awaited flushes) is non-quiescent whatever terminal it
    // later reaches; the entries array is append-only, so the index cut
    // identifies post-boundary entries without new state on them.
    ctx.stopBoundaryEntryCount = ctx.askLedger.entries.length;
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
  // Plan 00B-3 C3 — registry-ID admission; the SEMANTIC family and the
  // transport are DERIVED from the registry entry and stamped as separate
  // fields (the legacy overloaded `family` key is retired). C5 — the row
  // carries the ledger's stable delivery_ref + at_seq and the operation
  // aliases (claim lineage, wire turn id, dedupe token). NEVER the spoken
  // text (00C PII rule).
  ctx.recordDelivery = (
    opIdentities,
    {
      producerId,
      kind,
      claimLineage = null,
      claimToken = null,
      text = null,
      wireTurnId = null,
      dedupeToken = null,
      correlationId = null,
    } = {}
  ) => {
    if (!ctx.deliveryLedger) return;
    const producer = resolveProducer(producerId, 'delivery');
    if (!producer) return;
    const row = ctx.deliveryLedger.recordDeliveryAttempt(opIdentities, {
      kind,
      transport: producer.transport,
      claimLineage,
      text,
      wireTurnId,
      dedupeToken,
      producerId,
      semanticFamily: producer.semantic_family,
      correlationId,
      deliveryClaimToken: claimToken,
    });
    appendSub('delivery_evidence', {
      producer_id: producerId,
      semantic_family: producer.semantic_family,
      transport: producer.transport,
      delivery_kind: kind ?? 'confirmation',
      op_keys: [...row.op_keys],
      delivery_ref: row.delivery_ref,
      at_seq: row.at_seq,
      claim_lineage: claimLineage,
      // Codex r1 (C-5) — the PERSISTED outbox delivery-claim token (process
      // lineage); claim_lineage stays the logical kind:token ACK alias.
      delivery_claim_token: claimToken,
      wire_turn_id: wireTurnId,
      dedupe_token: dedupeToken,
      correlation_id: correlationId,
    });
  };

  // Plan 00B-3 C1 — an attempted operation-backed delivery whose receipt
  // binding failed: latch + the visible-but-uncreditable rejected audit row,
  // in ONE derivation.
  ctx.recordDeliveryRejected = ({
    producerId,
    reason,
    field = null,
    circuit = null,
    claimLineage = null,
    detail = null,
  }) => {
    // Codex r1 (A-4/B-4) — the closed vocabularies stay closed HERE too:
    // an unregistered producer id routes through the producer_unknown
    // fail-loud path, and an unregistered reason is recorded as the
    // fail-loud `unknown_rejection_reason` (schema-v1 rejection_reasons).
    const producer = resolveProducer(producerId, 'delivery');
    if (!producer) return;
    // Mini-review M-2 — the reason must be a DELIVERY structural-latch
    // reason whose declared row kind IS delivery_rejected; an ask/playback/
    // pre-admission/freeze reason routed here contradicts its own regime
    // and fails loud as unknown_rejection_reason.
    const spec = Object.prototype.hasOwnProperty.call(REJECTION_REASONS, reason)
      ? REJECTION_REASONS[reason]
      : null;
    const knownReason =
      spec &&
      spec.source_ledger === 'delivery' &&
      spec.regime === 'structural_latch' &&
      spec.row_kind === 'delivery_rejected'
        ? reason
        : 'unknown_rejection_reason';
    ctx.deliveryLedger?.markInvalid?.(knownReason, detail ?? { field, circuit });
    appendSub('delivery_rejected', {
      producer_id: producerId,
      reason: knownReason,
      field,
      circuit,
      claim_lineage: claimLineage,
    });
  };

  ctx.recordPlayback = (
    ackBody,
    matchingOps,
    { producerId, source = null, correlationId = null } = {}
  ) => {
    if (!ctx.deliveryLedger) return null;
    const producer = resolveProducer(producerId, 'playback');
    if (!producer) return null;
    const verdict = ctx.deliveryLedger.recordPlaybackAck(ackBody, matchingOps, {
      producerId,
      semanticFamily: producer.semantic_family,
      transport: producer.transport,
      source,
    });
    if (verdict.accepted === 'authoritative') {
      appendSub('playback_evidence', {
        producer_id: producerId,
        semantic_family: producer.semantic_family,
        transport: producer.transport,
        op_key: verdict.row.op_key,
        source,
        ack_body_hash: verdict.row.ack_body_hash,
        correlation_id: correlationId,
      });
      return verdict.row;
    }
    if (verdict.accepted === 'idempotent') {
      // C1 ternary — byte-identical retransmission: an idempotent audit row
      // keyed to the EXISTING authoritative event; no additional credit.
      appendSub('playback_idempotent', {
        producer_id: producerId,
        semantic_family: producer.semantic_family,
        transport: producer.transport,
        op_key: verdict.existing.op_key,
        ack_body_hash: verdict.existing.ack_body_hash,
      });
      return null;
    }
    // integrity rejection at the ledger admission layer — the invalidating
    // rejected audit row (the latch fired inside the ledger).
    appendSub('playback_rejected', {
      producer_id: producerId,
      reason: verdict.reason ?? null,
      matches: verdict.matches ?? null,
    });
    return null;
  };

  // C2.6 — route-side playback forwarding. A fast_tts ACK stages beside its
  // correlation reservation (promotion later resolves it); an ordinary ACK
  // becomes a playback_start ONLY when its slot resolves to EXACTLY ONE
  // delivered audibility unit — zero/ambiguous matches stay telemetry-only
  // (never guessed, never invalid at this seam; the judge's missing-playback
  // negatives read the absence).
  ctx.stageFastPlaybackAck = ({ correlationId, ackBody }) => {
    if (!ctx.deliveryLedger) return;
    const r = ctx.fastTtsReservations.get(correlationId);
    if (!r) {
      // Codex r1 (C-2) — wrong/stale/unknown correlation: PRE-ADMISSION
      // telemetry (no row, no latch); a later valid ACK succeeds.
      return;
    }
    if (r.promoted && r.promotedOp) {
      // Codex r1 (C-1) — the COMMON ordering: finish -> promotion ->
      // client playback ACK. The reservation is already resolved to its
      // authoritative operation, so the ACK resolves immediately through
      // the ordinary ternary playback path instead of being staged into a
      // bucket nothing will ever consume.
      ctx.recordPlayback(ackBody, [r.promotedOp], {
        producerId: 'fast_tts_staged_ack',
        source: 'fast_tts',
        correlationId,
      });
      return;
    }
    ctx.deliveryLedger.stageFastAck(correlationId, ackBody);
  };

  ctx.resolvePlaybackFromSlot = ({ slot, ackBody, source = null, turnId = null }) => {
    if (!ctx.deliveryLedger) return null;
    // Codex r2 finding 7 — turn-exact ACK binding: when BOTH the ACK and a
    // delivery row carry a wire turn id, only same-turn rows are candidates.
    // A row recorded without one (older producers) stays turn-agnostic.
    const turnCompatible = (d) =>
      turnId == null || d.wire_turn_id == null || d.wire_turn_id === turnId;
    if (!slot || typeof slot.field !== 'string') {
      // A slot-less ACK (production iOS omits the slot for board-scope
      // confirmations, whose circuit has no 0-99 integer form) can still
      // resolve to EXACTLY ONE delivered audibility unit: when the ledger
      // holds precisely one delivery row, the resolution is unambiguous;
      // anything else stays telemetry.
      const slotless = ctx.deliveryLedger.deliveries.filter(turnCompatible);
      if (slotless.length !== 1) return null;
      const only = slotless[0];
      const key = (only.op_keys ?? [only.op_key])[0];
      let id;
      try {
        id = JSON.parse(key);
      } catch {
        return null;
      }
      return ctx.recordPlayback(
        ackBody,
        [
          {
            extractionTurnId: id.turn ?? null,
            field: id.field,
            circuit: id.circuit ?? null,
            boardId: id.board_id ?? null,
            ordinal: id.ordinal ?? 0,
          },
        ],
        { producerId: 'playback_ack_slot', source }
      );
    }
    const seen = new Set();
    const matches = [];
    for (const d of ctx.deliveryLedger.deliveries) {
      if (!turnCompatible(d)) continue;
      const keys = Array.isArray(d.op_keys) ? d.op_keys : d.op_key ? [d.op_key] : [];
      for (const key of keys) {
        if (seen.has(key)) continue;
        let id;
        try {
          id = JSON.parse(key);
        } catch {
          continue;
        }
        const circuitMatches = (id.circuit ?? null) === (slot.circuit ?? null);
        const boardMatches =
          slot.boardId == null || id.board_id == null || id.board_id === slot.boardId;
        if (id.field === slot.field && circuitMatches && boardMatches) {
          seen.add(key);
          matches.push({
            extractionTurnId: id.turn ?? null,
            field: id.field,
            circuit: id.circuit ?? null,
            boardId: id.board_id ?? null,
            ordinal: id.ordinal ?? 0,
          });
        }
      }
    }
    if (matches.length !== 1) return null;
    return ctx.recordPlayback(ackBody, matches, { producerId: 'playback_ack_slot', source });
  };

  ctx.recordNonMutatingAudible = ({ channel, kind, text = null }) => {
    // Plan 00B C3 — budgeted. `appendSub` carries its own admission gate, so
    // past the budget neither the mirror array nor the row grows.
    if (ctx.captureBudget?.admit('non_mutating_audible') !== false) {
      ctx.nonMutatingAudible.push(
        Object.freeze({ channel: channel ?? null, kind: kind ?? null, text })
      );
    }
    appendSub('non_mutating_audible', { channel: channel ?? null, audible_kind: kind ?? null });
  };

  // ── C2.5 authoritative receipt binding for operation-backed speech ──
  // A spoken read-back binds to the CANONICAL mutation receipt (the
  // authoritative identity: the receipt's own extraction_turn_id +
  // turn_ordinal + slot), never to a synthesized partial key. Each receipt
  // is claimable by at most ONE delivery; zero or multiple unclaimed
  // matches are a binding failure (INVALID is reserved for operation-backed
  // speech lacking its binding).
  ctx.deliveryClaimedReceipts = new Set();
  ctx.resolveDeliveryReceipt = ({
    field,
    circuit = null,
    boardId = null,
    value = null,
    turnId = null,
  }) => {
    const mo = ctx.mutationObserver;
    if (!mo) return { identity: null, unresolved: 'no_mutation_observer' };
    const matches = mo.receipts.filter(
      (rc) =>
        (rc.kind === 'reading' || rc.kind === 'board_reading') &&
        !ctx.deliveryClaimedReceipts.has(rc.operation_id) &&
        rc.field === field &&
        (rc.circuit ?? null) === (circuit ?? null) &&
        (boardId == null || rc.board_id == null || rc.board_id === boardId) &&
        (value == null || rc.value == null || String(rc.value) === String(value)) &&
        (turnId == null || rc.extraction_turn_id === turnId)
    );
    if (matches.length !== 1) {
      return { identity: null, unresolved: matches.length === 0 ? 'unmatched' : 'ambiguous' };
    }
    const rc = matches[0];
    // Plan 00B C3 — budgeted. The claim set only guards evidence-side
    // double-binding; past the budget every row it would have guarded is
    // already refused, so an unrecorded claim cannot manufacture credit.
    if (ctx.captureBudget?.admit('delivery_claimed_receipt') !== false) {
      ctx.deliveryClaimedReceipts.add(rc.operation_id);
    }
    return {
      identity: {
        extractionTurnId: rc.extraction_turn_id ?? null,
        field: rc.field,
        circuit: rc.circuit ?? null,
        boardId: rc.board_id ?? null,
        ordinal: rc.turn_ordinal ?? 0,
      },
      unresolved: null,
    };
  };

  // ── C2.5/C2.6 address-mirror audibility units (Tier 2) ──
  // The collapsed terminal is ONE multi-operation unit keyed by its
  // delivery claim lineage; `address_mirror_delivery_ack` correlates by
  // token + claim lineage to exactly one unit. Duplicate/stale/wrong-token
  // acks resolve to no unit and stay non-authoritative telemetry.
  ctx.addressMirrorUnits = new Map();
  // C2.6 — recovery provenance: replayAddressMirrorOutbox flags a lineage
  // BEFORE its recovered send. A recovery under a claim lineage this
  // process has NO prior-send evidence for records the replay normally but
  // marks every bound operation `delivery_history_ambiguous` — exactly-once
  // history is never reconstructed (00C may never use an ambiguous
  // operation for a manual exactly-once PASS).
  ctx.pendingRecoveryLineages = new Set();
  ctx.noteAddressMirrorRecovery = (claimLineage) => {
    // Plan 00B C3 — budgeted. The lineage set only decides whether a
    // recovered send is flagged ambiguous; past the budget the delivery rows
    // it would have flagged are already refused.
    if (!claimLineage) return;
    if (ctx.captureBudget?.admit('recovery_lineage') === false) return;
    ctx.pendingRecoveryLineages.add(claimLineage);
  };
  ctx.recordAddressMirrorTerminal = ({
    claimLineage,
    ops,
    text = null,
    claimToken = null,
    attempt = null,
  }) => {
    const existing = ctx.addressMirrorUnits.get(claimLineage);
    if (existing) {
      // The same result can surface the terminal on more than one frame
      // (extraction + VCR) — one unit per claim lineage, never two. But a
      // REPLAY (a NEW frame-binding attempt ordinal) is a distinct
      // successful send and must append its own delivery attempt (Codex r1
      // C-6: 00C's delivery_attempt preserves every send/replay; the unit
      // and its ACK correlation stay singular).
      // Mini-review M-1 — identity is a SET of observed send generations
      // (never a monotonic ordinal): a reconstructed outbox result's frames
      // arrive under a fresh generation whatever its internal counters say,
      // while the dual frame of one send shares its generation. A null
      // generation is indistinguishable from the dual frame and is skipped
      // (conservative: the pre-A2 status quo, never a double-count).
      if (
        attempt != null &&
        !existing.observedAttempts.has(attempt) &&
        existing.identities.length > 0
      ) {
        existing.observedAttempts.add(attempt);
        ctx.recordDelivery(existing.identities, {
          producerId: 'address_mirror_terminal',
          kind: 'address_mirror_terminal',
          claimLineage,
          claimToken,
        });
      }
      return;
    }
    const identities = Array.isArray(ops) ? ops : [];
    if (identities.length === 0) {
      // No operation-backed content — the spoken terminal is non-mutating
      // audible evidence (e.g. a 'no'/'copied' acknowledgement).
      ctx.recordNonMutatingAudible({ channel: 'ws_vcr', kind: 'address_mirror_terminal', text });
      return;
    }
    if (!ctx.deliveryLedger) return;
    const isForeignRecovery = ctx.pendingRecoveryLineages.delete(claimLineage);
    ctx.recordDelivery(identities, {
      producerId: 'address_mirror_terminal',
      kind: 'address_mirror_terminal',
      claimLineage,
      claimToken,
    });
    // Plan 00B C3 — budgeted. Past the budget the unit is not retained, so a
    // later ack resolves to no unit and stays non-authoritative telemetry —
    // the same fail-closed shape a stale/wrong-token ack already takes.
    if (ctx.captureBudget?.admit('address_mirror_unit') !== false) {
      ctx.addressMirrorUnits.set(claimLineage, {
        identities,
        observedAttempts: new Set(attempt != null ? [attempt] : []),
      });
    }
    if (isForeignRecovery) {
      for (const op of identities) {
        ctx.deliveryLedger.markDeliveryHistoryAmbiguous(op);
      }
      appendSub('delivery_evidence', {
        producer_id: 'address_mirror_terminal',
        semantic_family: 'address_mirror',
        transport: 'ws_vcr',
        delivery_kind: 'delivery_history_ambiguous',
        op_keys: identities.map((op) => operationIdentityKey(op)),
        delivery_ref: null,
        at_seq: null,
        claim_lineage: claimLineage,
        wire_turn_id: null,
        dedupe_token: null,
        correlation_id: null,
      });
    }
  };
  ctx.recordAddressMirrorAck = ({ claimLineage, ackBody }) => {
    const unit = ctx.addressMirrorUnits.get(claimLineage);
    if (!unit || unit.identities.length === 0) return null;
    return ctx.recordPlayback(ackBody, [unit.identities[0]], {
      producerId: 'address_mirror_delivery_ack',
      source: 'address_mirror_delivery_ack',
    });
  };

  // ── C2.7 fast-TTS reservation lifecycle ──
  // A NON-DELIVERY reservation created before key lookup/synthesis; ONLY a
  // response `finish` transitions toward a provisional delivered attempt;
  // close-before-finish / synthesis failure / owner disappearance removes
  // the reservation with NO delivery evidence. Promotion requires finish +
  // the uniquely bound mutation receipt, in EITHER arrival order (the
  // freeze-time settle pass covers finish-then-receipt).
  ctx.fastTtsReservations = new Map();
  ctx.reserveFastTts = ({ correlationId, candidate }) => {
    if (!ctx.deliveryLedger) return;
    ctx.deliveryLedger.recordProvisionalFastDelivery({
      correlationId,
      ownerVerified: true,
      candidate,
    });
    // Plan 00B C3 — budgeted. Past the budget the reservation is not
    // retained, so `finishFastTts`/`attemptFastPromotion` simply find nothing
    // and return — no promotion, and therefore no row that could be credited.
    if (ctx.captureBudget?.admit('fast_tts_reservation') === false) return;
    ctx.fastTtsReservations.set(correlationId, {
      candidate: {
        field: candidate?.field ?? null,
        circuit: candidate?.circuit ?? null,
        board_id: candidate?.board_id ?? null,
        value: candidate?.value == null ? null : String(candidate.value),
      },
      finished: false,
      promoted: false,
      // Codex r1 (C-1) — set at promotion so a post-promotion client ACK
      // resolves immediately against the authoritative operation.
      promotedOp: null,
    });
  };
  ctx.finishFastTts = (correlationId) => {
    const r = ctx.fastTtsReservations.get(correlationId);
    if (!r || !ctx.deliveryLedger) return;
    r.finished = true;
    ctx.attemptFastPromotion(correlationId);
  };
  ctx.abortFastTts = (correlationId, _reason) => {
    if (!ctx.deliveryLedger) return;
    ctx.fastTtsReservations.delete(correlationId);
    ctx.deliveryLedger.withdrawProvisional(correlationId);
  };
  ctx.attemptFastPromotion = (correlationId) => {
    const r = ctx.fastTtsReservations.get(correlationId);
    if (!r || !r.finished || r.promoted || !ctx.deliveryLedger) return;
    const mo = ctx.mutationObserver;
    if (!mo) return;
    // The fast-path correlation contract binds this client-minted
    // correlation id to exactly one server-minted extraction turn at
    // transcript ingress (bindFastCorrelation). Promotion REQUIRES that
    // binding — a missing binding treated as a wildcard would let ANY
    // later same-field receipt promote the reservation across turns
    // (mini-review r1 finding 3). Fail closed instead: the unpromoted
    // provisional then invalidates the capture at completion freeze,
    // never crediting the wrong operation. Board identity participates in
    // the match so two boards' identical slots stay distinct.
    const boundTurn = mo.fastCorrelationTurn(correlationId);
    if (boundTurn == null) return;
    const candidateOps = mo.receipts
      .filter(
        (rc) =>
          rc.kind === 'reading' &&
          rc.field === r.candidate.field &&
          rc.extraction_turn_id === boundTurn &&
          (r.candidate.board_id == null ||
            rc.board_id == null ||
            rc.board_id === r.candidate.board_id)
      )
      .map((rc) => ({
        extractionTurnId: rc.extraction_turn_id ?? null,
        field: rc.field,
        circuit: rc.circuit ?? null,
        boardId: rc.board_id ?? null,
        ordinal: rc.turn_ordinal ?? 0,
        value: rc.value,
      }));
    if (candidateOps.length === 0) return; // receipt may still arrive — settle later
    const promotion = ctx.deliveryLedger.promoteProvisional(correlationId, candidateOps);
    r.promoted = true;
    if (promotion?.accepted) r.promotedOp = promotion.op;
    if (!promotion?.accepted) {
      // One derivation from the ledger verdict — the promotion failure
      // latched inside the ledger; this is its rejected audit row.
      appendSub('delivery_rejected', {
        producer_id: 'fast_tts_promotion',
        reason: promotion?.reason ?? null,
        field: r.candidate.field ?? null,
        circuit: r.candidate.circuit ?? null,
        claim_lineage: null,
      });
      return;
    }
    appendSub('delivery_evidence', {
      producer_id: 'fast_tts_promotion',
      semantic_family: 'fast_tts',
      transport: 'fast_tts',
      delivery_kind: 'fast_tts',
      op_keys: [...promotion.delivery_row.op_keys],
      delivery_ref: promotion.delivery_row.delivery_ref,
      at_seq: promotion.delivery_row.at_seq,
      claim_lineage: null,
      wire_turn_id: null,
      dedupe_token: null,
      correlation_id: correlationId,
    });
    // Staged early ACKs consumed by this promotion — ONE playback sub-record
    // per AUTHORITATIVE start, each carrying its own ACK-body hash (C5), so
    // the frozen builder snapshot carries the playback evidence 00C derives
    // its confirmation/ACK ledger from.
    for (const prow of promotion.playback_rows) {
      appendSub('playback_evidence', {
        producer_id: 'fast_tts_staged_ack',
        semantic_family: 'fast_tts',
        transport: 'http_playback_ack',
        op_key: prow.op_key,
        source: 'fast_tts',
        ack_body_hash: prow.ack_body_hash,
        correlation_id: correlationId,
      });
    }
    // Codex r1 (A-3/B-3) — byte-identical staged retransmissions keep their
    // accepted-IDEMPOTENT audit rows through promotion (the ordinary ACK
    // path already appends them; the staged path must not lose them).
    for (const idem of promotion.idempotent_rows ?? []) {
      appendSub('playback_idempotent', {
        producer_id: 'fast_tts_staged_ack',
        semantic_family: 'fast_tts',
        transport: 'http_playback_ack',
        op_key: idem.op_key,
        ack_body_hash: idem.ack_body_hash,
      });
    }
  };
  ctx.settleFastTts = () => {
    for (const id of ctx.fastTtsReservations.keys()) ctx.attemptFastPromotion(id);
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
      ctx.recordAskProduced({ producerId: 'dialogue_script_ask', runtimeId, liveAskKey: key });
    },
    emitted(payload) {
      if (!ctx.askLedger || !payload) return;
      ctx.recordAskEmitted({ runtimeId: payload.tool_call_id });
    },
  };

  ctx.deliveryEmit = {
    prepare(payload, descriptor) {
      // Plan 00B C3 — budgeted. A prepare whose commit never arrives is the
      // leak here; past the budget the descriptor is not retained and the
      // matching commit simply finds nothing (its rows are refused anyway).
      if (ctx.captureBudget?.admit('delivery_prepared') === false) return;
      ctx.deliveryPrepared.set(payload, descriptor);
    },
    commit(payload, descriptor) {
      ctx.deliveryPrepared.delete(payload);
      const ops = descriptor?.operations ?? [];
      if (ops.length === 0) return;
      // Bind each descriptor slot to its CANONICAL mutation receipt. The
      // dialogue completion read-back legitimately acknowledges slots
      // WRITTEN IN EARLIER TURNS of the same episode (each answer turn
      // drains its own write), so the binding matches across turns on
      // slot + value + unclaimed — a same-slot-same-value duplicate across
      // turns is ambiguous and fails closed. A slot that resolves to zero
      // or multiple unclaimed receipts is operation-backed speech lacking
      // its binding — INVALID.
      const identities = [];
      for (const op of ops) {
        const res = ctx.resolveDeliveryReceipt({
          field: op.field,
          circuit: op.circuit,
          boardId: op.board_id,
          value: op.value,
        });
        if (!res.identity) {
          ctx.recordDeliveryRejected({
            producerId: 'dialogue_confirmation',
            reason: `dialogue_delivery_binding_${res.unresolved}`,
            field: op.field ?? null,
            circuit: op.circuit ?? null,
          });
          return;
        }
        identities.push(res.identity);
      }
      ctx.recordDelivery(identities, {
        producerId: 'dialogue_confirmation',
        kind: 'dialogue_confirmation',
        text: payload?.question ?? null,
      });
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
  bindCaptureBudget(entry, ctx);
  return ctx;
}

/**
 * Plan 00B C3 — join the session-shared capture budget to the lifecycle
 * ledger, and register the ONE overflow sink.
 *
 * This is the only place both the `entry` (which owns the lifecycle ledger)
 * and the `ctx` (which owns the shared budget) are in scope, which is why the
 * sink lives here rather than in the budget module — and the reserved marker
 * row MUST be appended from this file regardless (the evidence source-scan
 * test forbids `appendLedgerRow` calls outside the adapters).
 *
 * The sink fires SYNCHRONOUSLY from inside the first refused `admit()`, and
 * it does its work in a deliberate order:
 *
 *  1. Latch every evidence role INVALID FIRST. Downstream code is about to
 *     see collections that stopped growing (an entry that was never pushed,
 *     a delivery that was never retained) and may latch its own, misleading
 *     reason — `emitted_without_produced`, `playback_without_delivery_attempt`.
 *     All of these latches are first-wins, so claiming them here guarantees
 *     the recorded reason is the true one.
 *  2. Append the single reserved `capture_budget_overflow` row (exempt from
 *     the admission gate by kind, and mintable only once because the sink
 *     itself is first-wins).
 *  3. Emit exactly one bounded telemetry line.
 */
function bindCaptureBudget(entry, ctx) {
  const budget = ctx?.captureBudget;
  if (!budget || typeof budget.onFirstOverflow !== 'function') return;
  const ledger = entry?.[LIFECYCLE_LEDGER] ?? null;
  ledger?.budgetHolder?.adopt?.(budget);
  budget.onFirstOverflow(({ site, limit, admitted }) => {
    const detail = { site: site ?? null, limit, admitted };
    if (ledger) markProducerInvalid(ledger, CAPTURE_BUDGET_OVERFLOW_KIND, detail);
    ctx.askLedger?.markInvalid?.(CAPTURE_BUDGET_OVERFLOW_KIND, detail);
    ctx.deliveryLedger?.markInvalid?.(CAPTURE_BUDGET_OVERFLOW_KIND, detail);
    ctx.mutationObserver?.markInvalid?.(CAPTURE_BUDGET_OVERFLOW_KIND, detail);
    appendLedgerRow(ledger, ctx.observer ?? null, CAPTURE_BUDGET_OVERFLOW_KIND, {
      capture_site: site ?? null,
      row_limit: limit,
      admitted_rows: admitted,
    });
    logger.warn('plan00.capture_budget_overflow', detail);
  });
}

export const _internals = Object.freeze({
  REVISION_KINDS,
  readRevisionSnapshot,
  sameRevisions,
  deepFreezeCopy,
  composeFrozenEvidence,
  ROUND_USAGE_ALLOWLIST,
});
