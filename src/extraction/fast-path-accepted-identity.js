/**
 * Fast-path accepted-identity + fast-attempt ledger (Plan B, feedback ids
 * 118/119, B1.2 + B3.1).
 *
 * ONE combined TTL-scoped record per `correlationId`, deliberately folding
 * two concerns the plan allowed to be split OR combined ("your call, document
 * the choice"):
 *
 *   - B1.2 "accepted identity": the (field, circuit, boardId, canonicalValue,
 *     comparisonText) tuple the fast-TTS route committed for this
 *     correlation, used by the bundler (stage6-event-bundler.js) to decide
 *     whether a Sonnet-confirmed reading is the SAME thing the fast clip
 *     already spoke (B1.3 echo-stamping via `fast_correlation_id`).
 *   - B3.1 "fast-attempt ledger": the lifecycle state (`pending` →
 *     `playback_started` | `failed`) of that same fast-TTS attempt, read by
 *     the shadow-harness orphan net (stage6-shadow-harness.js) to decide
 *     whether a zero-tool-call turn should apologise, stay silent (the user
 *     already heard the fast clip), or speak a correlation-stamped fallback.
 *
 * Folding them into one record avoids a second correlationId-keyed Map with
 * its own independent TTL/lazy-sweep bookkeeping, and lets the "pending"
 * ledger state carry the SAME field/circuit/boardId the eventual identity
 * commit will use — so a pending-state fallback confirmation (B3.3) can be
 * built from partial data captured at `pending` time even before the fast
 * route's first `onAudio` byte has streamed (see `markFastAttemptPending`).
 *
 * Mirrors the TTL/lazy-sweep pattern in voice-latency-turn-summary.js
 * (`correlationToTurn`) — same 60s TTL convention, same sweep-on-threshold
 * shape, same `_resetForTests()`/`_peekStateForTests()` test-only exports.
 *
 * Lifecycle:
 *   1. `markFastAttemptPending` — called by voice-latency-fast-tts.js right
 *      after `validateBody` succeeds (sessionId/turnId/correlationId/
 *      candidate known), BEFORE any further gate can still reject. Captures
 *      field/circuit/boardId/rawValue (the UN-CLAMPED candidate.value) so a
 *      B3.1 "pending" fallback has *something* to work with even if the
 *      route never reaches synthesis. State: 'pending'.
 *   2. `commitAcceptedIdentity` — called ONCE, at the route's FIRST
 *      successful `onAudio` write (not at route entry — the HTTP fast
 *      request and the WS transcript are concurrent, so the route entry
 *      point races the transcript-carried correlation set). Upgrades the
 *      record with the CLAMPED canonicalValue and the renderer-aligned
 *      comparisonText (designation=null, matching the fast route's own
 *      render). Does NOT change `state`.
 *   3a. `markFastAttemptFailed` — called from the route's single
 *      `rejectWithDecrement` funnel (every gate reject + pre-first-byte
 *      synthesis failure). State: 'failed'. Never downgrades a record that
 *      already reached 'playback_started' (structurally shouldn't happen —
 *      playback can only follow a successful stream — but defensive).
 *   3b. `markFastAttemptPlaybackStarted` — called from
 *      voice-latency-playback-ack.js when iOS ACKs `source: 'fast_tts'` with
 *      a correlation_id. State: 'playback_started'. No-op if no record
 *      exists (e.g. an ask-path TTS ack that happens to carry a
 *      correlation_id never minted through this module).
 *
 * `resolveAcceptedIdentity` (B1.2 read) only returns a record once step 2 has
 * run (comparisonText is the sentinel — null before commit, always
 * non-null(ish) after, even though buildConfirmationText CAN return null for
 * a genuinely empty value: see the explicit `committed` flag below rather
 * than inferring commit-ness from comparisonText's own nullability).
 *
 * `getFastAttemptState` / `getFastAttemptRecord` (B3.1 reads) return
 * whatever is known regardless of commit stage.
 */

/**
 * @typedef {Object} FastAttemptRecord
 * @property {string} sessionId
 * @property {string} turnId
 * @property {string} field
 * @property {number|null} circuit
 * @property {string|null} boardId — the WIRE boardId as received (unresolved
 *   — never the dispatcher-effective board), matching how the fast route
 *   itself treats `candidate.boardId`.
 * @property {string|null} rawValue — candidate.value, un-clamped, captured at
 *   `markFastAttemptPending`.
 * @property {string|null} canonicalValue — fastClamp.value, set at
 *   `commitAcceptedIdentity`.
 * @property {string|null} comparisonText — the fast route's own rendered
 *   text (designation=null), set at `commitAcceptedIdentity`.
 * @property {boolean} committed — true once `commitAcceptedIdentity` has run.
 * @property {'pending'|'playback_started'|'failed'} state
 * @property {number} expires_at_ms
 */

/** @type {Map<string, FastAttemptRecord>} */
const recordsByCorrelationId = new Map();

/** Mirrors voice-latency-turn-summary.js's CORRELATION_TURN_TTL_MS — long
 *  enough to cover the Sonnet round-trip that the orphan-net decision waits
 *  on, well past the fast route's ~500ms typical audio latency. */
const RECORD_TTL_MS = 60_000;

/** Mirrors voice-latency-turn-summary.js's LAZY_SWEEP_THRESHOLD. */
const LAZY_SWEEP_THRESHOLD = 10_000;

function lazyExpirySweep() {
  if (recordsByCorrelationId.size < LAZY_SWEEP_THRESHOLD) return;
  const now = Date.now();
  for (const [key, value] of recordsByCorrelationId) {
    if (value.expires_at_ms < now) recordsByCorrelationId.delete(key);
  }
}

function isExpired(record) {
  return !record || record.expires_at_ms < Date.now();
}

/**
 * B3.1 step 1 — mark a fast-TTS attempt as pending. Called right after
 * `validateBody` succeeds in voice-latency-fast-tts.js, before any further
 * gate (eligibility, session lookup, capability, boardId) has a chance to
 * still reject the request. Creates the record if absent, or refreshes it
 * (new TTL, fields overwritten) if a stale/expired one happens to share the
 * correlationId — correlation ids are client-minted UUIDv4s, so a genuine
 * collision would only ever be a stale replay of an ancient TTL-expired id.
 *
 * @param {string} correlationId
 * @param {{sessionId: string, turnId: string, field: string, circuit: number|null, boardId: string|null, rawValue: string|null}} fields
 */
export function markFastAttemptPending(correlationId, fields) {
  if (typeof correlationId !== 'string' || !correlationId) return;
  recordsByCorrelationId.set(correlationId, {
    sessionId: fields?.sessionId ?? null,
    turnId: fields?.turnId ?? null,
    field: fields?.field ?? null,
    circuit: Number.isInteger(fields?.circuit) ? fields.circuit : null,
    boardId: typeof fields?.boardId === 'string' && fields.boardId ? fields.boardId : null,
    rawValue: fields?.rawValue ?? null,
    canonicalValue: null,
    comparisonText: null,
    committed: false,
    state: 'pending',
    expires_at_ms: Date.now() + RECORD_TTL_MS,
  });
  lazyExpirySweep();
}

/**
 * B1.2 step 2 — commit the accepted identity. Called ONCE, at the fast
 * route's first successful `onAudio` write. Upgrades an existing 'pending'
 * record in place (preserving `state` — a record can only reach this point
 * before any playback/failure transition, since those require audio to have
 * already started streaming). Creates a minimal committed record if somehow
 * called without a prior `markFastAttemptPending` (defensive — should not
 * happen given both are called from the same route).
 *
 * @param {string} correlationId
 * @param {{sessionId: string, turnId: string, field: string, circuit: number|null, boardId: string|null, canonicalValue: string, comparisonText: string}} fields
 */
export function commitAcceptedIdentity(correlationId, fields) {
  if (typeof correlationId !== 'string' || !correlationId) return;
  const existing = recordsByCorrelationId.get(correlationId);
  const base =
    existing && !isExpired(existing)
      ? existing
      : {
          sessionId: fields?.sessionId ?? null,
          turnId: fields?.turnId ?? null,
          field: fields?.field ?? null,
          circuit: Number.isInteger(fields?.circuit) ? fields.circuit : null,
          boardId: typeof fields?.boardId === 'string' && fields.boardId ? fields.boardId : null,
          rawValue: null,
          state: 'pending',
        };
  recordsByCorrelationId.set(correlationId, {
    ...base,
    field: fields?.field ?? base.field,
    circuit: Number.isInteger(fields?.circuit) ? fields.circuit : base.circuit,
    boardId: typeof fields?.boardId === 'string' && fields.boardId ? fields.boardId : base.boardId,
    canonicalValue: fields?.canonicalValue ?? null,
    comparisonText: fields?.comparisonText ?? null,
    committed: true,
    expires_at_ms: Date.now() + RECORD_TTL_MS,
  });
  lazyExpirySweep();
}

/**
 * B3.1 step 3a — mark a fast-TTS attempt as failed. Called from
 * voice-latency-fast-tts.js's single `rejectWithDecrement` funnel. Never
 * downgrades a record already at 'playback_started' (structurally
 * unreachable in practice — playback requires bytes to have already
 * streamed, which requires `commitAcceptedIdentity` to have already run —
 * but defensive against future call-site changes). Creates a minimal
 * 'failed' record if no prior 'pending' mark exists (e.g. the validateBody
 * failure path itself, which rejects before any pending mark is possible).
 *
 * @param {string} sessionId
 * @param {string} correlationId
 */
export function markFastAttemptFailed(sessionId, correlationId) {
  if (typeof correlationId !== 'string' || !correlationId) return;
  const existing = recordsByCorrelationId.get(correlationId);
  if (existing && !isExpired(existing) && existing.state === 'playback_started') return;
  if (existing && !isExpired(existing)) {
    recordsByCorrelationId.set(correlationId, {
      ...existing,
      state: 'failed',
      expires_at_ms: Date.now() + RECORD_TTL_MS,
    });
    return;
  }
  recordsByCorrelationId.set(correlationId, {
    sessionId: sessionId ?? null,
    turnId: null,
    field: null,
    circuit: null,
    boardId: null,
    rawValue: null,
    canonicalValue: null,
    comparisonText: null,
    committed: false,
    state: 'failed',
    expires_at_ms: Date.now() + RECORD_TTL_MS,
  });
  lazyExpirySweep();
}

/**
 * B3.1 step 3b — mark a fast-TTS attempt as having actually started
 * playback on iOS. Called from voice-latency-playback-ack.js when
 * `source === 'fast_tts'` and a `correlation_id` is present. No-op if no
 * record exists for this correlationId (an ask-path TTS ack, or a
 * correlation id this module never saw) — defensive; this module must never
 * fabricate identity from an ACK body alone.
 *
 * @param {string} sessionId
 * @param {string} correlationId
 */
export function markFastAttemptPlaybackStarted(sessionId, correlationId) {
  if (typeof correlationId !== 'string' || !correlationId) return;
  const existing = recordsByCorrelationId.get(correlationId);
  if (!existing || isExpired(existing)) return;
  // Defensive session scoping — a cross-session correlation id collision
  // should be structurally impossible (client-minted UUIDv4), but never let
  // one session's ACK mutate another's ledger entry.
  if (existing.sessionId && sessionId && existing.sessionId !== sessionId) return;
  recordsByCorrelationId.set(correlationId, {
    ...existing,
    state: 'playback_started',
    expires_at_ms: Date.now() + RECORD_TTL_MS,
  });
}

/**
 * B1.2 read — the accepted identity for echo-stamping. Only returns a
 * record once `commitAcceptedIdentity` has actually run (never a bare
 * 'pending' mark) — the bundler's `fast_correlation_id` stamp is a value/
 * text-identity claim, and pre-commit fields (rawValue, no comparisonText)
 * are not enough to make that claim safely.
 *
 * @param {string} correlationId
 * @returns {FastAttemptRecord|null}
 */
export function resolveAcceptedIdentity(correlationId) {
  if (typeof correlationId !== 'string' || !correlationId) return null;
  const record = recordsByCorrelationId.get(correlationId);
  if (!record || isExpired(record) || !record.committed) return null;
  return record;
}

/**
 * B3.1 read — the fast-attempt ledger state. Returns null when this module
 * has no (unexpired) record for the correlationId at all — the caller
 * (stage6-shadow-harness.js's orphan-net precedence chain) treats null the
 * SAME as 'pending' per the plan's explicit default ("the pending state, not
 * absence, must be the default whenever [the ACK] has not [landed]") — this
 * module deliberately does NOT bake that default in itself, so a caller that
 * wants to distinguish "genuinely never attempted" from "attempted but not
 * yet resolved" still can (by cross-checking the correlationId came from
 * `entry.fastPathCorrelationIdByTurn`, which the harness already does).
 *
 * @param {string} correlationId
 * @returns {'pending'|'playback_started'|'failed'|null}
 */
export function getFastAttemptState(correlationId) {
  if (typeof correlationId !== 'string' || !correlationId) return null;
  const record = recordsByCorrelationId.get(correlationId);
  if (!record || isExpired(record)) return null;
  return record.state;
}

/**
 * B3.1 read — the raw record regardless of commit stage. Used by the
 * orphan-net's 'pending' fallback path when it needs SOME field/circuit
 * context even before `commitAcceptedIdentity` has run (though the
 * confirmation-building call site still prefers `resolveAcceptedIdentity`'s
 * clamped `canonicalValue` over this record's un-clamped `rawValue` — see
 * stage6-shadow-harness.js's `resolveFastLedgerOutcomeForTurn`).
 *
 * @param {string} correlationId
 * @returns {FastAttemptRecord|null}
 */
export function getFastAttemptRecord(correlationId) {
  if (typeof correlationId !== 'string' || !correlationId) return null;
  const record = recordsByCorrelationId.get(correlationId);
  if (!record || isExpired(record)) return null;
  return record;
}

/**
 * Build the slot-key join used to match a bundler-projected reading against
 * an accepted identity. Mirrors `buildSlotKey` in voice-latency-fast-tts.js
 * byte-for-byte (same normalisation: boardId '' when falsy) so both sides
 * compute the identical string for the identical (field, circuit, boardId)
 * tuple.
 *
 * @param {{field: string, circuit: number|null, boardId: string|null}} parts
 * @returns {string}
 */
export function buildFastAttemptSlotKey({ field, circuit, boardId }) {
  const normBoardId = typeof boardId === 'string' && boardId.length > 0 ? boardId : '';
  return `${field}::${circuit ?? 'null'}::${normBoardId}`;
}

/**
 * B1.2 — resolve accepted identities for a turn's attempted correlation ids
 * into a `Map<slotKey, {correlationId, field, circuit, boardId,
 * canonicalValue, comparisonText}>`, keyed the SAME way the bundler's
 * per-reading slotKey is built (see stage6-event-bundler.js). Called
 * IMMEDIATELY BEFORE `bundleToolCallsIntoResult` at both call sites in
 * stage6-shadow-harness.js — resolving earlier could miss a route accepted
 * mid-turn (the HTTP fast request and the WS transcript are concurrent).
 *
 * @param {Set<string>|null|undefined} correlationIds
 * @returns {Map<string, {correlationId: string, field: string, circuit: number|null, boardId: string|null, canonicalValue: string, comparisonText: string}>}
 */
export function resolveFastAttemptSlotIdentities(correlationIds) {
  const bySlotKey = new Map();
  if (!correlationIds || correlationIds.size === 0) return bySlotKey;
  for (const cid of correlationIds) {
    const identity = resolveAcceptedIdentity(cid);
    if (!identity) continue;
    const slotKey = buildFastAttemptSlotKey({
      field: identity.field,
      circuit: identity.circuit,
      boardId: identity.boardId,
    });
    bySlotKey.set(slotKey, {
      correlationId: cid,
      field: identity.field,
      circuit: identity.circuit,
      boardId: identity.boardId,
      canonicalValue: identity.canonicalValue,
      comparisonText: identity.comparisonText,
    });
  }
  return bySlotKey;
}

/**
 * B3.1 — resolve the orphan-net precedence outcome for a turn's attempted
 * correlation ids. Returns:
 *   - `{kind: 'suppress'}` when ANY attempted correlation reached
 *     'playback_started' — the user already heard a fast clip for this
 *     turn's candidate; no second line.
 *   - `{kind: 'pending', correlationId, identity}` when no correlation
 *     reached 'playback_started' but at least one is still 'pending' (or
 *     unresolved — treated as pending per the plan's default) AND has a
 *     COMMITTED accepted identity (`resolveAcceptedIdentity`) to build a
 *     real, CLAMPED fallback confirmation from.
 *   - `{kind: 'pending_uncommitted', correlationId, rawRecord}` — Codex
 *     diff-review F2 (2026-08-13): the SAME 'pending, not absence' default,
 *     but for the race where the orphan-net decision fires BEFORE the fast
 *     route's first `onAudio` byte (so `commitAcceptedIdentity` hasn't run
 *     yet and `resolveAcceptedIdentity` returns null). Without this branch
 *     the caller previously fell through to `null` — silently defaulting to
 *     ABSENCE, exactly the outcome the plan's "pending, not absence" rule
 *     forbids. `rawRecord` is the UN-CLAMPED `getFastAttemptRecord(cid)`
 *     captured at `markFastAttemptPending` time (field/circuit/boardId/
 *     rawValue) — the caller is responsible for clamping `rawValue` before
 *     building a spoken confirmation from it (this module has no clamp
 *     helper and deliberately doesn't grow one just for this fallback).
 *   - `null` when every attempted correlation failed, or a genuinely
 *     unattempted correlation id has no ledger record at all (never
 *     fabricate a placeholder confirmation — falls through to the caller's
 *     existing behaviour).
 *
 * Precedence when a turn attempts multiple correlations: a committed
 * identity anywhere in the set wins over an uncommitted one, regardless of
 * iteration order — matching `resolveAcceptedIdentity`'s own preference for
 * the clamped value over a pending record's raw one.
 *
 * @param {Set<string>|null|undefined} correlationIds
 * @returns {{kind: 'suppress'}|{kind: 'pending', correlationId: string, identity: FastAttemptRecord}|{kind: 'pending_uncommitted', correlationId: string, rawRecord: FastAttemptRecord}|null}
 */
export function resolveFastLedgerOutcomeForTurn(correlationIds) {
  if (!correlationIds || correlationIds.size === 0) return null;
  let pendingWithIdentity = null;
  let pendingUncommitted = null;
  for (const cid of correlationIds) {
    const state = getFastAttemptState(cid);
    if (state === 'playback_started') {
      return { kind: 'suppress' };
    }
    if (state === 'failed') continue;
    // state === 'pending' OR null (unresolved race — the plan's explicit
    // "pending, not absence" default) — try to attach a committed identity
    // first; a committed identity anywhere in the set always wins.
    if (!pendingWithIdentity) {
      const identity = resolveAcceptedIdentity(cid);
      if (identity) {
        pendingWithIdentity = { correlationId: cid, identity };
        continue;
      }
    }
    // F2 — not committed (yet). Fall back to the raw pre-commit record so a
    // decision firing before `commitAcceptedIdentity` still yields a
    // 'pending'-flavoured outcome instead of silently treating the turn as
    // though nothing was attempted. Only remembers the FIRST such record —
    // mirrors `pendingWithIdentity`'s own "first candidate wins" shape,
    // superseded immediately if a later cid in the set turns out committed.
    if (!pendingWithIdentity && !pendingUncommitted) {
      const rawRecord = getFastAttemptRecord(cid);
      if (rawRecord) {
        pendingUncommitted = { correlationId: cid, rawRecord };
      }
    }
  }
  if (pendingWithIdentity) {
    return { kind: 'pending', ...pendingWithIdentity };
  }
  if (pendingUncommitted) {
    return { kind: 'pending_uncommitted', ...pendingUncommitted };
  }
  return null;
}

/**
 * Test-only: reset module state. Used by Jest `afterEach`.
 */
export function _resetForTests() {
  recordsByCorrelationId.clear();
}

/**
 * Test-only: introspect module state.
 */
export function _peekStateForTests() {
  return {
    size: recordsByCorrelationId.size,
    records: new Map(recordsByCorrelationId),
  };
}
