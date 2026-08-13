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
 * Mirrors the TTL/lazy-sweep MECHANISM in voice-latency-turn-summary.js
 * (`correlationToTurn`) — same sweep-on-threshold shape, same
 * `_resetForTests()`/`_peekStateForTests()` test-only exports — but
 * DELIBERATELY DIVERGES on the TTL VALUE itself (Codex diff-review F9,
 * 2026-08-13): `RECORD_TTL_MS` is 300_000ms (300s), not the 60s
 * `CORRELATION_TURN_TTL_MS` convention, because a turn that legitimately
 * waits on an ask or runs multiple extraction rounds can take up to
 * ~3m15s (`sonnet-stream.js`'s `EXTRACTION_WATCHDOG_ABSOLUTE_MS`) — see
 * `RECORD_TTL_MS`'s own doc comment below for the full derivation.
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
 *
 * Every reader below also takes an OPTIONAL `sessionId` (Codex diff-review
 * F5, 2026-08-13) and treats a session mismatch identically to "not found" —
 * see `sessionMismatch`'s doc comment just above the readers for the exact
 * (permissive) matching rule.
 */

/**
 * @typedef {Object} FastAttemptRecord
 * @property {string} sessionId
 * @property {string} turnId
 * @property {string} field
 * @property {number|null} circuit
 * @property {string|null} boardId — at `markFastAttemptPending` time, the
 *   WIRE boardId exactly as received (unresolved). At `commitAcceptedIdentity`
 *   time (M1, Codex diff-review mini-review, 2026-08-13), the route resolves a
 *   null/omitted wire boardId to the session's main-board fallback
 *   (`getMainBoardId`) BEFORE committing, so the slot-key join in
 *   `resolveFastAttemptSlotIdentities`/`buildFastAttemptSlotKey` matches the
 *   bundler's `effectiveBoardOf` resolution for the same ordinary
 *   (bare-`board_id`) write — see voice-latency-fast-tts.js's
 *   `resolveIdentityBoardId`.
 * @property {string|null} rawValue — candidate.value, un-clamped, captured at
 *   `markFastAttemptPending`.
 * @property {string|null} canonicalValue — fastClamp.value, set at
 *   `commitAcceptedIdentity`.
 * @property {string|null} comparisonText — the fast route's own rendered
 *   text (designation=null), set at `commitAcceptedIdentity`.
 * @property {{original: string, corrected: string}|null} correction —
 *   Codex diff-review cycle 3 D2 — the clamp-correction pair
 *   (`fastClamp.correction` from `clampReadingForDispatch`) computed at the
 *   SAME point `canonicalValue`/`comparisonText` are, set at
 *   `commitAcceptedIdentity`. Carries the "— I corrected 16 to 1.6" clause
 *   the fast clip's OWN audio spoke, so a later B3.3 committed-'pending'
 *   fallback confirmation (built when the fast clip streamed but never got
 *   an iOS playback-start ACK) can include the same clause instead of
 *   silently dropping it — a pending fallback speaks the value itself, so a
 *   missing correction clause here would be a safety-relevant omission (the
 *   fallback would claim "16" when the certificate actually stores "1.6").
 *   Also folded into the M4 coalescing group key (`resolveZeroToolCallDuplicateOutcome`)
 *   so two attempts that land on the SAME final value via DIFFERENT
 *   correction provenance (one clamp-corrected, one not) are never wrongly
 *   coalesced into a single spoken outcome — their correction clauses (or
 *   absence of one) differ, so what gets spoken must differ too.
 * @property {boolean} committed — true once `commitAcceptedIdentity` has run.
 * @property {'pending'|'playback_started'|'failed'} state
 * @property {number} expires_at_ms
 */

/** @type {Map<string, FastAttemptRecord>} */
const recordsByCorrelationId = new Map();

// [DEVIATION] F9 (Codex diff-review, 2026-08-13, sanctioned) — the previous
// value (60_000, mirroring voice-latency-turn-summary.js's
// CORRELATION_TURN_TTL_MS) was SHORTER than the pipeline's actual maximum
// supported single-turn duration: sonnet-stream.js's
// EXTRACTION_WATCHDOG_ABSOLUTE_MS = 3 * ASK_USER_TIMEOUT_MS (45_000, from
// stage6-dispatcher-ask.js) + 2 * EXTRACTION_WATCHDOG_MS (30_000) = 195_000ms
// — a turn that legitimately waits on an ask or runs multiple extraction
// rounds can take up to ~3m15s, well past the old 60s TTL. A record
// expiring mid-turn would silently regress the orphan-net/echo-stamp logic
// to duplicate/silent behaviour for a turn that is still genuinely in
// flight — the exact class of bug this module exists to prevent. Set
// comfortably above the watchdog ceiling with real headroom (not a
// close-shave value) rather than mirroring CORRELATION_TURN_TTL_MS, which
// was never validated against this pipeline's actual worst-case turn
// duration. Same Audio-First evidence as F8 (a turn that legitimately runs
// long must not lose its fast-attempt bookkeeping mid-turn and silently
// regress to duplicate/silent behaviour). The iOS-side mirrored constant
// (`AlertManager.fastPathCorrelationTTL`, CertMateUnified) is updated
// separately, out of scope for this backend-only worktree.
const RECORD_TTL_MS = 300_000;

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
 * Codex diff-review F5 (2026-08-13) — session-scoping guard, mirroring the
 * EXACT permissive pattern `markFastAttemptPlaybackStarted` already used
 * (that was the only site with this guard before F5; every READER —
 * `resolveAcceptedIdentity`, `getFastAttemptState`, `getFastAttemptRecord`,
 * `resolveFastAttemptSlotIdentities`, `resolveFastLedgerOutcomeForTurn` — had
 * none, so a stale/foreign correlationId (client replay, a UUID collision
 * with a HELD-open record from a different session) could resolve another
 * session's identity/state on read). A mismatch is only declared when BOTH
 * sides carry a non-empty sessionId and they differ — a record with no
 * sessionId (defensive minimal records built without one) or a caller that
 * doesn't pass one is treated as unscoped, same as the existing writer guard.
 *
 * Codex diff-review M3 (2026-08-13, per-fix mini-review) — F5's own comment
 * above (superseded here) claimed `markFastAttemptFailed` already had this
 * guard before F5; it did not — it only ever checked `state ===
 * 'playback_started'`, never the caller's `sessionId` against the record's.
 * `markFastAttemptPending` and `commitAcceptedIdentity` had no session guard
 * at all either. All three now use this same helper — see each function's
 * own doc comment.
 *
 * @param {FastAttemptRecord|undefined|null} record
 * @param {string|undefined|null} sessionId
 * @returns {boolean}
 */
function sessionMismatch(record, sessionId) {
  return Boolean(record?.sessionId && sessionId && record.sessionId !== sessionId);
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
 * Codex diff-review F5 (2026-08-13) — mirrors the downgrade guard
 * `markFastAttemptFailed` already had: a STRAY call for a correlationId that
 * has already progressed to 'playback_started', OR already been committed
 * (`commitAcceptedIdentity` has run), is a no-op. Without this, a
 * duplicate/delayed `markFastAttemptPending` invocation (e.g. a client retry
 * reusing the same correlationId, or an out-of-order arrival at the route)
 * would silently REGRESS an already-resolved record back to a bare
 * 'pending' state with the OLDER un-clamped `rawValue` — un-doing
 * `commitAcceptedIdentity`'s clamped `canonicalValue`/`comparisonText`, or
 * even a genuine `playback_started` mark, mid-flight.
 *
 * Codex diff-review M3 (2026-08-13, per-fix mini-review) — F5 session-scoped
 * every READER but left every WRITER open to a cross-session correlationId
 * collision. Symmetric with the read-side guard (and with
 * `markFastAttemptPlaybackStarted`'s pre-existing guard below): an unexpired
 * record belonging to a DIFFERENT non-null session is never mutated here,
 * regardless of its state — a colliding correlationId (astronomically rare,
 * client-minted UUIDv4s, but this module's own stated design principle is
 * defense-in-depth) must never let one session's dictation overwrite
 * another's ledger entry.
 *
 * @param {string} correlationId
 * @param {{sessionId: string, turnId: string, field: string, circuit: number|null, boardId: string|null, rawValue: string|null}} fields
 */
export function markFastAttemptPending(correlationId, fields) {
  if (typeof correlationId !== 'string' || !correlationId) return;
  const existing = recordsByCorrelationId.get(correlationId);
  if (existing && !isExpired(existing) && sessionMismatch(existing, fields?.sessionId)) {
    return;
  }
  if (
    existing &&
    !isExpired(existing) &&
    (existing.state === 'playback_started' || existing.committed)
  ) {
    return;
  }
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
 * Codex diff-review M3 (2026-08-13, per-fix mini-review) — an existing
 * record belonging to a DIFFERENT non-null session is never merged onto:
 * merging would produce a hybrid record carrying one session's identity
 * (sessionId/turnId/field/circuit/boardId from `base`) alongside another
 * session's just-committed data (canonicalValue/comparisonText from
 * `fields`) — internally inconsistent in exactly the way the whole
 * accepted-identity ledger exists to prevent. No-op (skip entirely, same as
 * the sibling writers) rather than fabricate a "properly scoped" record from
 * `fields` alone that would silently clobber the foreign session's entry at
 * this same correlationId — a colliding id is astronomically rare
 * (client-minted UUIDv4s) and defense-in-depth here means refusing to act,
 * not choosing which session's data wins.
 *
 * @param {string} correlationId
 * @param {{sessionId: string, turnId: string, field: string, circuit: number|null, boardId: string|null, canonicalValue: string, comparisonText: string, correction?: {original: string, corrected: string}|null}} fields
 */
export function commitAcceptedIdentity(correlationId, fields) {
  if (typeof correlationId !== 'string' || !correlationId) return;
  const existing = recordsByCorrelationId.get(correlationId);
  if (existing && !isExpired(existing) && sessionMismatch(existing, fields?.sessionId)) {
    return;
  }
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
    // Codex diff-review cycle 3 D2 — the clamp-correction pair, threaded
    // through from voice-latency-fast-tts.js's `fastClamp.correction`
    // (computed at the SAME clamp call canonicalValue/comparisonText come
    // from). Validated defensively — a malformed/foreign shape becomes null
    // rather than propagating garbage into a spoken confirmation clause.
    correction:
      fields?.correction &&
      typeof fields.correction === 'object' &&
      typeof fields.correction.original === 'string' &&
      typeof fields.correction.corrected === 'string'
        ? { original: fields.correction.original, corrected: fields.correction.corrected }
        : null,
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
 * Codex diff-review M3 (2026-08-13, per-fix mini-review) — this writer took
 * NO sessionId parameter validation at all before this fix: `sessionId` was
 * accepted positionally and used unconditionally, whether or not it matched
 * the stored record's own `sessionId`. Added the same session-scope guard
 * every other writer now has — a mismatched sessionId is a no-op, mirroring
 * `markFastAttemptPlaybackStarted`'s pre-existing guard.
 *
 * @param {string} sessionId
 * @param {string} correlationId
 */
export function markFastAttemptFailed(sessionId, correlationId) {
  if (typeof correlationId !== 'string' || !correlationId) return;
  const existing = recordsByCorrelationId.get(correlationId);
  if (existing && !isExpired(existing) && sessionMismatch(existing, sessionId)) return;
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
 * @param {string|null} [sessionId] — F5: a mismatch is treated as not-found.
 * @returns {FastAttemptRecord|null}
 */
export function resolveAcceptedIdentity(correlationId, sessionId) {
  if (typeof correlationId !== 'string' || !correlationId) return null;
  const record = recordsByCorrelationId.get(correlationId);
  if (!record || isExpired(record) || !record.committed) return null;
  if (sessionMismatch(record, sessionId)) return null;
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
 * @param {string|null} [sessionId] — F5: a mismatch is treated as not-found.
 * @returns {'pending'|'playback_started'|'failed'|null}
 */
export function getFastAttemptState(correlationId, sessionId) {
  if (typeof correlationId !== 'string' || !correlationId) return null;
  const record = recordsByCorrelationId.get(correlationId);
  if (!record || isExpired(record)) return null;
  if (sessionMismatch(record, sessionId)) return null;
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
 * @param {string|null} [sessionId] — F5: a mismatch is treated as not-found.
 * @returns {FastAttemptRecord|null}
 */
export function getFastAttemptRecord(correlationId, sessionId) {
  if (typeof correlationId !== 'string' || !correlationId) return null;
  const record = recordsByCorrelationId.get(correlationId);
  if (!record || isExpired(record)) return null;
  if (sessionMismatch(record, sessionId)) return null;
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
 * @param {string|null} [sessionId] — F5: threaded through to `resolveAcceptedIdentity`.
 * @returns {Map<string, {correlationId: string, field: string, circuit: number|null, boardId: string|null, canonicalValue: string, comparisonText: string}>}
 */
export function resolveFastAttemptSlotIdentities(correlationIds, sessionId) {
  const bySlotKey = new Map();
  if (!correlationIds || correlationIds.size === 0) return bySlotKey;
  for (const cid of correlationIds) {
    const identity = resolveAcceptedIdentity(cid, sessionId);
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
 * correlation ids. Returns an ARRAY with EXACTLY one entry per attempted
 * correlation id (Codex diff-review cycle 2 finding C2, 2026-08-13 — see
 * the [DEVIATION] note below), or `null` only when `correlationIds` itself
 * is empty/absent. Each entry is one of:
 *   - `{correlationId, kind: 'suppress'}` — this correlation reached
 *     'playback_started'; the user already heard THIS clip. No second line
 *     for it — but this does NOT affect any sibling entry.
 *   - `{correlationId, kind: 'pending', identity}` — still 'pending' (or
 *     unresolved — treated as pending per the plan's default) AND has a
 *     COMMITTED accepted identity (`resolveAcceptedIdentity`) to build a
 *     real, CLAMPED fallback confirmation from.
 *   - `{correlationId, kind: 'pending_uncommitted', rawRecord}` — Codex
 *     diff-review F2 (2026-08-13): the SAME 'pending, not absence' default,
 *     but for the race where the orphan-net decision fires BEFORE the fast
 *     route's first `onAudio` byte (so `commitAcceptedIdentity` hasn't run
 *     yet and `resolveAcceptedIdentity` returns null). `rawRecord` is the
 *     UN-CLAMPED `getFastAttemptRecord(cid)` captured at
 *     `markFastAttemptPending` time (field/circuit/boardId/rawValue) — the
 *     caller is responsible for clamping `rawValue` before building a
 *     spoken confirmation from it (this module has no clamp helper and
 *     deliberately doesn't grow one just for this fallback).
 *   - `{correlationId, kind: 'pending_unrecorded'}` — Codex diff-review C2
 *     (2026-08-13): this module has NO record at all for this cid — not
 *     even a `markFastAttemptPending` mark. This is the genuine
 *     WS-before-HTTP race: the transcript-carried correlation set (built
 *     from `regex_fast_correlation_id` on the wire) can list a
 *     correlationId before the fast-tts route's own `markFastAttemptPending`
 *     call has actually run server-side. Per the plan's explicit "pending,
 *     not absence" default, this is STILL an attempted correlation the
 *     caller must account for — it just carries no identity data at all
 *     (the caller falls back to a turn-level re-parse; see
 *     stage6-shadow-harness.js's `resolveZeroToolCallDuplicateOutcome`).
 *   - `{correlationId, kind: 'failed'}` — Codex diff-review C2 (2026-08-13):
 *     this correlation's fast-TTS attempt definitively failed
 *     (`markFastAttemptFailed` ran). Previously this contributed NO entry
 *     at all (a bare `continue`), which meant a turn with ANY OTHER
 *     represented correlation (e.g. a sibling that reached
 *     'playback_started') looked "fully handled" to the caller and the
 *     failed correlation's own dictated reading was silently dropped —
 *     worse than before Plan B existed. Now every failed correlation gets
 *     an explicit entry so the caller can positively account for it
 *     (falling through to the ordinary duplicate/orphan-prompt path)
 *     instead of just not seeing it.
 *
 * [DEVIATION] F8 (Codex diff-review, 2026-08-13, sanctioned) — this used to
 * collapse the ENTIRE turn's attempted correlation set to ONE outcome: the
 * first `playback_started` correlation suppressed EVERYTHING for the turn,
 * and only the FIRST `pending` correlation with a committed identity got a
 * fallback; any OTHER correlation in the same turn (a second reading whose
 * fast clip is still pending/failed while a different reading's fast clip
 * already played) was silently dropped from consideration entirely. On a
 * genuinely multi-reading turn this could suppress or drop readings that
 * Audio-First invariant #1 requires be heard exactly once. The plan's
 * literal precedence table didn't spell out the multi-correlation case, but
 * the Audio-First mandate ("every dictated reading read back EXACTLY once
 * — never 0, never 2") affirmatively requires each attempted correlation be
 * accounted for independently — hence the array shape, judged in-intent by
 * the orchestrating session rather than a literal-plan requirement.
 *
 * [DEVIATION] C2 (Codex diff-review cycle 2, 2026-08-13, sanctioned) — F8's
 * array already gave every attempted correlation its own slot, but TWO
 * cases still silently contributed nothing: a `failed` correlation (bare
 * `continue`) and a correlation with NO ledger record at all (fell through
 * every branch, contributed nothing). Both are now explicit entries
 * (`kind: 'failed'` / `kind: 'pending_unrecorded'`) so a MIXED-state turn
 * (one correlation suppressed/pending, a sibling failed/unrecorded) can
 * never look "fully handled" to the caller while one reading goes
 * completely unaccounted for.
 *
 * @param {Set<string>|null|undefined} correlationIds
 * @param {string|null} [sessionId] — F5: threaded through to every per-cid lookup below.
 * @returns {Array<{correlationId: string, kind: 'suppress'}|{correlationId: string, kind: 'pending', identity: FastAttemptRecord}|{correlationId: string, kind: 'pending_uncommitted', rawRecord: FastAttemptRecord}|{correlationId: string, kind: 'pending_unrecorded'}|{correlationId: string, kind: 'failed'}>|null}
 */
export function resolveFastLedgerOutcomeForTurn(correlationIds, sessionId) {
  if (!correlationIds || correlationIds.size === 0) return null;
  const outcomes = [];
  for (const cid of correlationIds) {
    const state = getFastAttemptState(cid, sessionId);
    if (state === 'failed') {
      // C2 — explicit entry, no longer a silent `continue`. See the
      // 'failed' case in this function's own doc comment above.
      outcomes.push({ correlationId: cid, kind: 'failed' });
      continue;
    }
    if (state === 'playback_started') {
      outcomes.push({ correlationId: cid, kind: 'suppress' });
      continue;
    }
    // state === 'pending' OR null (unresolved race — the plan's explicit
    // "pending, not absence" default) — try to attach a committed identity
    // first for THIS correlation.
    const identity = resolveAcceptedIdentity(cid, sessionId);
    if (identity) {
      outcomes.push({ correlationId: cid, kind: 'pending', identity });
      continue;
    }
    // F2 — not committed (yet). Fall back to the raw pre-commit record so a
    // decision firing before `commitAcceptedIdentity` still yields a
    // 'pending'-flavoured outcome for THIS correlation instead of silently
    // treating it as though it was never attempted.
    const rawRecord = getFastAttemptRecord(cid, sessionId);
    if (rawRecord) {
      outcomes.push({ correlationId: cid, kind: 'pending_uncommitted', rawRecord });
      continue;
    }
    // C2 — genuinely no ledger record at all for this cid: the
    // WS-before-HTTP race (the transcript-carried correlation set named
    // this cid before the route's own `markFastAttemptPending` ran) OR a
    // TTL-expired record. Still an explicit, accounted-for entry — never a
    // silent drop.
    outcomes.push({ correlationId: cid, kind: 'pending_unrecorded' });
  }
  return outcomes;
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
