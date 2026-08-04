/**
 * Plan 00B §B1 — dormant per-entry evaluation lifecycle hooks.
 *
 * The semantic-oracle harness (scripts/model-ab, Plan 00B/00C) needs
 * evidence about a live session's lifecycle — successful frame sends,
 * confirmation deliveries, in-flight work counts and a quiescence-gated
 * completion freeze — WITHOUT changing production behaviour. This module is
 * that seam.
 *
 * Dormancy contract (load-bearing, test-pinned):
 *   - With no evidence observer registered on an entry, every hook here is
 *     a single optional property lookup that allocates nothing, serialises
 *     nothing, and changes no branch order or timing. Production traffic
 *     never registers an observer — only the evaluation server option
 *     (initSonnetStream's `evaluationContextFactory`) does, and only in
 *     tests/evaluation runs.
 *   - The observer and its ledger live on NON-ENUMERABLE Symbol keys so no
 *     JSON.stringify of an entry (wire frames, logs, S3 uploads) can ever
 *     leak them.
 *
 * Freeze contract (§B1): the teardown arbiter calls
 * `freezeEvidenceCompletion` exactly once per entry, after the existing
 * flush/reject points. An ELIGIBLE freeze requires every in-flight count to
 * be zero and every revision unchanged across the synchronous check;
 * anything else freezes evidence-INELIGIBLE with `non_quiescent_at_stop`.
 * The registered pure candidate builder is invoked synchronously exactly
 * once with an immutable allowlisted snapshot; its result and one publish
 * promise are latched — retries reuse them, they are never rebuilt. The
 * later Plan 00C consumer owns the manifest schema; this seam owns only
 * WHEN and EXACTLY ONCE the candidate is frozen.
 */

export const EVIDENCE_OBSERVER = Symbol('plan00.evidenceObserver');
export const LIFECYCLE_LEDGER = Symbol('plan00.lifecycleLedger');

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
 * Attach an evaluation observer to an activeSessions entry. Must run at
 * entry creation, BEFORE session start/rehydration, so the ledger sees the
 * whole lifecycle. Idempotent-hostile by design: a second registration on
 * the same entry throws — two observers would double-count evidence.
 */
export function registerEvidenceObserver(entry, observer) {
  if (!entry || typeof entry !== 'object')
    throw new Error('registerEvidenceObserver: entry required');
  if (!observer || typeof observer !== 'object')
    throw new Error('registerEvidenceObserver: observer required');
  if (entry[EVIDENCE_OBSERVER])
    throw new Error('registerEvidenceObserver: observer already registered');
  const revisions = {};
  for (const kind of REVISION_KINDS) revisions[kind] = 0;
  Object.defineProperty(entry, EVIDENCE_OBSERVER, {
    value: observer,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(entry, LIFECYCLE_LEDGER, {
    value: {
      revisions,
      frozen: null,
      // B3 sub-record streams — append-only, immutable rows.
      subRecords: [],
    },
    enumerable: false,
    configurable: true,
  });
  if (typeof observer.onRegistered === 'function') {
    observer.onRegistered({ at: 'entry_creation' });
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

/**
 * Record one immutable sub-record for a message/outbox/timer invocation and
 * bump the kind's monotonic revision. No-op (single property lookup) when no
 * observer is registered.
 */
export function recordLifecycleEvent(entry, kind, detail) {
  const ledger = entry && entry[LIFECYCLE_LEDGER];
  if (!ledger) return;
  if (!(kind in ledger.revisions)) ledger.revisions[kind] = 0;
  ledger.revisions[kind] += 1;
  const row = Object.freeze({ kind, revision: ledger.revisions[kind], ...detail });
  ledger.subRecords.push(row);
  const observer = entry[EVIDENCE_OBSERVER];
  if (observer && typeof observer.onLifecycleEvent === 'function') {
    observer.onLifecycleEvent(row);
  }
}

/** Successful-frame callback (post-successful ws.send only). */
export function notifySuccessfulFrame(entry, detail) {
  recordLifecycleEvent(entry, 'successful_frame', detail);
}

/** Confirmation-delivery callback (B3 delivery_attempt evidence). */
export function notifyConfirmationDelivery(entry, detail) {
  recordLifecycleEvent(entry, 'confirmation_delivery', detail);
}

/**
 * Derive the in-flight work counts from REAL entry state. Every count must
 * be zero for an eligible completion freeze. The allowlist is deliberate
 * and exhaustive — each row names the production state it reads so a future
 * lifecycle addition shows up as a review question here, not a silent gap.
 */
export function readInFlightCounts(entry) {
  const session = entry?.session || null;
  const costTracker = session?.costTracker || null;
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

/**
 * Quiescence-gated completion freeze. Exactly once per entry; retries and
 * duplicate teardown callers receive the latched result. Returns null when
 * dormant (no observer).
 */
export function freezeEvidenceCompletion(entry, { sessionId, boundary }) {
  const ledger = entry && entry[LIFECYCLE_LEDGER];
  if (!ledger) return null;
  if (ledger.frozen) return ledger.frozen;

  const observer = entry[EVIDENCE_OBSERVER];
  const revisionsBefore = readRevisionSnapshot(entry);
  const counts = Object.freeze(readInFlightCounts(entry));
  const revisionsAfter = readRevisionSnapshot(entry);
  const quiescent =
    Object.values(counts).every((v) => v === 0) && sameRevisions(revisionsBefore, revisionsAfter);

  if (!quiescent) {
    ledger.frozen = Object.freeze({
      eligible: false,
      reason: 'non_quiescent_at_stop',
      boundary,
      sessionId,
      counts,
      revisions: revisionsAfter,
      candidate: null,
      publishPromise: null,
    });
    if (typeof observer.onEvidenceFrozen === 'function') observer.onEvidenceFrozen(ledger.frozen);
    return ledger.frozen;
  }

  // Immutable allowlisted lifecycle/ledger snapshot for the pure builder.
  const snapshot = Object.freeze({
    sessionId,
    boundary,
    counts,
    revisions: revisionsAfter,
    sub_records: Object.freeze([...ledger.subRecords]),
  });
  let candidate = null;
  if (typeof observer.buildCandidate === 'function') {
    // Pure, synchronous, exactly once. The builder returns the latched
    // {timestamp, canonical bytes, content hash/key, checksum} shape the
    // 00C consumer will publish; we latch whatever it returns verbatim.
    candidate = observer.buildCandidate(snapshot);
  }
  let publishPromise = null;
  if (typeof observer.publish === 'function') {
    publishPromise = Promise.resolve().then(() => observer.publish(candidate));
    // Latched promise — a rejection is the observer's own evidence problem;
    // never let it become an unhandled rejection that kills teardown.
    publishPromise.catch(() => {});
  }
  ledger.frozen = Object.freeze({
    eligible: true,
    reason: null,
    boundary,
    sessionId,
    counts,
    revisions: revisionsAfter,
    candidate,
    publishPromise,
  });
  if (typeof observer.onEvidenceFrozen === 'function') observer.onEvidenceFrozen(ledger.frozen);
  return ledger.frozen;
}

export const _internals = Object.freeze({
  REVISION_KINDS,
  readRevisionSnapshot,
  sameRevisions,
});
