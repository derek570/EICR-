/**
 * Loaded Barrel Phase 2.A — speculative-audio cache (plan v10 §B).
 *
 * In-process Map of pre-synthesised confirmation audio keyed by the
 * full slot tuple (sessionId, turnId, boardId, field, circuit,
 * expandedText). The speculator (loaded-barrel-speculator.js) writes
 * a 'pending' entry the moment it kicks off an ElevenLabs WS synth;
 * the synth's complete handler CAS's it pending→ready with the MP3
 * buffer; the iOS POST short-circuit (keys.js Phase 3) peeks the
 * entry and CAS's ready→claimed to serve it.
 *
 * State machine (FROZEN — plan v10 §B):
 *
 *   pending → ready                (synth complete; markReady CAS)
 *   pending → aborted              (invalidate/supersede/cap; markSuperseded)
 *   ready   → claimed              (iOS POST consumed it; claim CAS)
 *   ready   → ttl_expired          (15s elapsed without claim)
 *   ready   → aborted              (board_transition_prune)
 *
 * Terminal states: claimed, aborted, ttl_expired. Cache always
 * removes the entry from the LRU on transition to ANY terminal state.
 *
 * Forbidden transitions (asserted by Phase 5 fuzz):
 *   claimed → *   ttl_expired → *   aborted → *   ready → pending
 *
 * Capacity:
 *   per-session LRU = 20 entries (eviction order = insertion order;
 *                     oldest evicted entry is aborted if pending,
 *                     dropped if ready)
 *   global LRU      = 200 entries (same eviction rule)
 *
 * TTL: 15s from set(). plan v10 §F1 raised from v5's 2s to leave
 * comfortable headroom for iOS's up-to-8s TTS-defer behaviour. Each
 * entry holds a setTimeout (.unref()'d so it doesn't block process
 * exit); the timer is cleared when the entry transitions to a
 * terminal state.
 *
 * Memory: 200 entries × ~30KB MP3 average × 1.2 overhead ≈ 7MB
 * worst case at the global cap. Real steady state much lower.
 */

import crypto from 'node:crypto';

const TTL_MS = 15_000;
const GLOBAL_MAX = 200;
const PER_SESSION_MAX = 20;

/**
 * The cache lives at module scope — single backend instance, single
 * speculator-orchestrator. If we ever go multi-instance the cache
 * would need either Redis or session-sticky routing. Out of scope
 * for v10.
 */
const entries = new Map(); // key → entry
const sessionIndex = new Map(); // sessionId → Set<key>

/**
 * Build the canonical cache key. Both the speculator and the keys.js
 * short-circuit MUST call this so they hash the same byte sequence.
 */
export function buildCacheKey({ sessionId, turnId, boardId, field, circuit, expandedText }) {
  // Empty-string boardId is treated as 'no board' (matches the iOS
  // POST body shape where boardId is omitted on single-board sessions).
  const b = boardId == null ? '' : String(boardId);
  const c = circuit == null ? '' : String(circuit);
  const f = field == null ? '' : String(field);
  const t = String(turnId ?? '');
  const s = String(sessionId ?? '');
  const txt = String(expandedText ?? '');
  // Composite plaintext → sha1 hex (40 chars). SHA-1 is sufficient
  // here — collision resistance against malicious input is not a
  // security property; the hash is just a stable lookup key.
  return crypto.createHash('sha1').update(`${s}:${t}:${b}:${f}:${c}:${txt}`).digest('hex');
}

function _removeFromIndex(sessionId, key) {
  const set = sessionIndex.get(sessionId);
  if (!set) return;
  set.delete(key);
  if (set.size === 0) sessionIndex.delete(sessionId);
}

function _terminate(entry, newState, reason) {
  if (entry.state !== 'pending' && entry.state !== 'ready') return false;
  const prev = entry.state;
  entry.state = newState;
  entry.terminatedAt = Date.now();
  entry.terminationReason = reason;
  // Clear pending timer + abort the in-flight synth if still pending.
  if (entry._ttlTimer) {
    clearTimeout(entry._ttlTimer);
    entry._ttlTimer = null;
  }
  // If the entry had a pending promise, resolve with null so any
  // awaiter unblocks. Plan §A determinism note: the speculator MUST
  // only resolve the entry's promise AFTER calling markReady — so by
  // the time a pending entry is being terminated to aborted, no
  // awaiter has been served the buffer yet.
  if (prev === 'pending' && typeof entry._resolvePending === 'function') {
    try {
      entry._resolvePending(null);
    } catch (_e) {
      /* never throw from resolve */
    }
    entry._resolvePending = null;
  }
  // Abort the synth controller if still attached. Speculator's catch
  // path will record the cancelled terminal.
  if (prev === 'pending' && entry.controller && typeof entry.controller.abort === 'function') {
    try {
      entry.controller.abort();
    } catch (_e) {
      /* never throw from abort */
    }
  }
  entries.delete(entry.cacheKey);
  _removeFromIndex(entry.sessionId, entry.cacheKey);
  return true;
}

/**
 * Evict the oldest entry of `sessionId` if the per-session cap is
 * already at PER_SESSION_MAX. Oldest = insertion order (Set preserves
 * insertion order in JS). If the evicted entry is pending, mark it
 * aborted (so the speculator's synth-complete handler will skip it).
 */
function _evictOldestIfOverCap(sessionId) {
  const set = sessionIndex.get(sessionId);
  if (!set || set.size < PER_SESSION_MAX) return;
  const oldest = set.values().next().value;
  if (!oldest) return;
  const entry = entries.get(oldest);
  if (!entry) {
    set.delete(oldest);
    return;
  }
  _terminate(entry, 'aborted', 'per_session_cap_eviction');
}

function _evictOldestGlobalIfOverCap() {
  if (entries.size < GLOBAL_MAX) return;
  // Map iteration order = insertion order.
  const oldest = entries.keys().next().value;
  if (!oldest) return;
  const entry = entries.get(oldest);
  if (!entry) {
    entries.delete(oldest);
    return;
  }
  _terminate(entry, 'aborted', 'global_cap_eviction');
}

/**
 * Insert a NEW pending entry. The speculator builds {promise,
 * resolvePromise, controller} via `Promise.withResolvers()`-style
 * pattern (or a small adapter) and hands them in here. set() bumps
 * the per-session and global LRUs.
 *
 * Returns the entry on success; throws on duplicate key (caller bug).
 */
export function set({
  cacheKey,
  sessionId,
  turnId,
  boardId,
  field,
  circuit,
  expandedText,
  correlationId,
  promise,
  resolvePromise,
  controller,
}) {
  if (!cacheKey || !sessionId) {
    throw new TypeError('loaded-barrel-cache.set: cacheKey + sessionId required');
  }
  if (entries.has(cacheKey)) {
    // Idempotent: returning the existing entry is safer than throwing —
    // a duplicate set probably means the speculator double-fired
    // because of an upstream retry. Caller can detect via referential
    // equality if it cares.
    return entries.get(cacheKey);
  }
  _evictOldestIfOverCap(sessionId);
  _evictOldestGlobalIfOverCap();

  const now = Date.now();
  const entry = {
    cacheKey,
    state: 'pending',
    sessionId,
    turnId,
    boardId: boardId ?? null,
    field,
    circuit: circuit ?? null,
    expandedText,
    correlationId,
    createdAt: now,
    expiresAt: now + TTL_MS,
    mp3Buffer: null,
    completeAt: null,
    terminatedAt: null,
    terminationReason: null,
    // Internal — speculator side only:
    promise,
    _resolvePending: resolvePromise,
    controller,
    _ttlTimer: null,
  };
  entries.set(cacheKey, entry);
  let set = sessionIndex.get(sessionId);
  if (!set) {
    set = new Set();
    sessionIndex.set(sessionId, set);
  }
  set.add(cacheKey);

  // Schedule TTL expiry. .unref() so an idle cache doesn't keep the
  // event loop alive.
  entry._ttlTimer = setTimeout(() => {
    const e = entries.get(cacheKey);
    if (!e) return;
    if (e.state === 'ready') {
      _terminate(e, 'ttl_expired', 'ttl_fire_ready');
    } else if (e.state === 'pending') {
      // Pending past TTL → speculator's synth never completed. Treat
      // as aborted (the speculator's terminal handler will record
      // 'cancelled_ttl').
      _terminate(e, 'aborted', 'ttl_fire_pending');
    }
  }, TTL_MS);
  if (typeof entry._ttlTimer.unref === 'function') entry._ttlTimer.unref();
  return entry;
}

/**
 * Read-only peek. Does NOT bump LRU. Does NOT change state. Returns
 * null if the key is absent or in a terminal state (which means the
 * entry was already removed from the Map — terminal entries are
 * physically purged in _terminate).
 */
export function peek(cacheKey) {
  const entry = entries.get(cacheKey);
  if (!entry) return null;
  return entry;
}

/**
 * CAS ready → claimed. Returns true on success, false otherwise.
 * On success, the entry is REMOVED from the cache (terminal state).
 * Caller then serves entry.mp3Buffer to iOS.
 */
export function claim(cacheKey) {
  const entry = entries.get(cacheKey);
  if (!entry) return false;
  if (entry.state !== 'ready') return false;
  entry.state = 'claimed';
  entry.terminatedAt = Date.now();
  entry.terminationReason = 'claimed_by_ios_post';
  if (entry._ttlTimer) {
    clearTimeout(entry._ttlTimer);
    entry._ttlTimer = null;
  }
  entries.delete(cacheKey);
  _removeFromIndex(entry.sessionId, cacheKey);
  return true;
}

/**
 * CAS pending → ready. Stores the MP3 buffer + completeAt. Returns
 * true on success, false if the entry was already terminated (caller
 * should discard the buffer on false).
 *
 * Plan §A determinism note: the speculator's complete handler MUST
 * call this BEFORE resolving the entry.promise so any peer awaiter
 * doesn't race a ready→claimed CAS against the resolve.
 */
export function markReady(cacheKey, mp3Buffer) {
  const entry = entries.get(cacheKey);
  if (!entry) return false;
  if (entry.state !== 'pending') return false;
  entry.state = 'ready';
  entry.mp3Buffer = mp3Buffer;
  entry.completeAt = Date.now();
  // Caller (speculator) resolves the entry.promise AFTER this returns
  // true. We do NOT resolve here — the resolve is the speculator's
  // signal to its own bookkeeping.
  return true;
}

/**
 * CAS pending → aborted. Used by invalidate/supersede/cap paths.
 * Resolves the pending promise with null and aborts the controller.
 * Returns true if CAS succeeded.
 */
export function markSuperseded(cacheKey, reason = 'superseded') {
  const entry = entries.get(cacheKey);
  if (!entry) return false;
  if (entry.state !== 'pending') return false;
  return _terminate(entry, 'aborted', reason);
}

/**
 * Drop every entry of `sessionId` whose slot matches (boardId, field,
 * circuit). Used when clear_reading fires or a same-slot re-record
 * overwrites a prior speculation. Returns the number of entries
 * invalidated.
 */
export function invalidateBySlot(sessionId, { boardId, field, circuit }) {
  const set = sessionIndex.get(sessionId);
  if (!set) return 0;
  const wantedBoard = boardId == null ? null : String(boardId);
  const wantedField = field == null ? null : String(field);
  const wantedCircuit = circuit == null ? null : String(circuit);
  let invalidated = 0;
  // Snapshot iteration order; _terminate mutates the Set under us.
  const keys = Array.from(set);
  for (const k of keys) {
    const e = entries.get(k);
    if (!e) continue;
    const eBoard = e.boardId == null ? null : String(e.boardId);
    const eCircuit = e.circuit == null ? null : String(e.circuit);
    if (eBoard !== wantedBoard) continue;
    if (e.field !== wantedField) continue;
    if (eCircuit !== wantedCircuit) continue;
    if (_terminate(e, 'aborted', 'invalidate_by_slot')) invalidated++;
  }
  return invalidated;
}

/**
 * Drop every entry of `sessionId` whose boardId is null. Used when
 * add_board fires — pre-existing unboarded readings may have been
 * re-attributed to the new board by the model, so their cached audio
 * (which references the old slot identity) is stale.
 */
export function pruneSessionUnboardedEntries(sessionId) {
  const set = sessionIndex.get(sessionId);
  if (!set) return 0;
  let pruned = 0;
  for (const k of Array.from(set)) {
    const e = entries.get(k);
    if (!e || e.boardId != null) continue;
    if (_terminate(e, 'aborted', 'prune_unboarded_on_add_board')) pruned++;
  }
  return pruned;
}

/**
 * Drop every entry of `sessionId` whose boardId !== currentBoardId.
 * Used when select_board fires — entries for boards other than the
 * working one are stale (the model's next writes will land on the new
 * board, and the slot identity differs).
 */
export function pruneMismatchedBoardEntries(sessionId, currentBoardId) {
  const set = sessionIndex.get(sessionId);
  if (!set) return 0;
  const wanted = currentBoardId == null ? null : String(currentBoardId);
  let pruned = 0;
  for (const k of Array.from(set)) {
    const e = entries.get(k);
    if (!e) continue;
    const eBoard = e.boardId == null ? null : String(e.boardId);
    if (eBoard === wanted) continue;
    if (_terminate(e, 'aborted', 'prune_on_select_board')) pruned++;
  }
  return pruned;
}

/**
 * Drop ALL entries of `sessionId`. Called on session_stop / WS close.
 * Returns the number of entries dropped.
 */
export function pruneForSession(sessionId) {
  const set = sessionIndex.get(sessionId);
  if (!set) return 0;
  let pruned = 0;
  for (const k of Array.from(set)) {
    const e = entries.get(k);
    if (!e) continue;
    if (_terminate(e, 'aborted', 'prune_on_session_stop')) pruned++;
  }
  return pruned;
}

/**
 * Diagnostic / test introspection: snapshot the current cache state.
 * NOT a public production API.
 */
export function _snapshot() {
  const out = { totalEntries: entries.size, sessions: {} };
  for (const [sid, set] of sessionIndex) {
    out.sessions[sid] = { count: set.size };
  }
  return out;
}

/** Test-only — wipe all state. */
export function _resetForTests() {
  for (const entry of entries.values()) {
    if (entry._ttlTimer) clearTimeout(entry._ttlTimer);
  }
  entries.clear();
  sessionIndex.clear();
}

export const _internals = Object.freeze({
  TTL_MS,
  GLOBAL_MAX,
  PER_SESSION_MAX,
});
