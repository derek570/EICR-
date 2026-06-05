// sonnet-session-store.js
// In-memory, TTL-bounded, LRU-capped store for rehydratable Sonnet sessions.
//
// HISTORY / WHY: Added for Wave 4c.5 (Sonnet `session_resume` on reconnect).
// The existing `activeSessions` map in `sonnet-stream.js` is keyed by the
// *client-supplied* sessionId and is the authoritative runtime state for an
// open WS connection. On reconnect the client historically re-used its own
// sessionId via `session_start` — but the web client does not persist one
// across hard reloads, so a dropped socket lost all Sonnet multi-turn
// context.
//
// This store gives us a *server-minted* rehydration token (UUID v4) that the
// server sends back in the first `session_ack`. On reconnect the client
// sends `session_resume { sessionId }` and we look the original runtime
// entry up by that token, validate it belongs to the same authenticated
// user, and hand it back to the WS handler.
//
// Design constraints from the Wave 4c.5 brief:
// 1. In-memory only (no Redis/persistence this wave).
// 2. TTL bounded — default 5 minutes, configurable via env.
// 3. LRU-capped to prevent unbounded growth from abandoned sessions.
// 4. Must never rehydrate across user boundaries (security).
//
// The cap covers the pathological case where many sessions are minted but
// never resumed (e.g. a browser that opens a connection and crashes before
// any rehydration). Without an LRU cap the map would grow unboundedly.

import crypto from 'node:crypto';

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes — covers Deepgram sleep/wake
const DEFAULT_MAX_ENTRIES = 1000; // LRU cap — each entry is small (metadata only)

/**
 * Create a new session-rehydration store.
 *
 * @param {object} [options]
 * @param {number} [options.ttlMs] — entry lifetime in ms (defaults to SONNET_SESSION_TTL_MS env var, else 5 min)
 * @param {number} [options.maxEntries] — LRU cap (defaults to SONNET_SESSION_MAX_ENTRIES env var, else 1000)
 * @param {() => number} [options.now] — injectable clock for tests
 * @param {() => string} [options.mintId] — injectable UUID minter for tests
 * @returns {{
 *   create: (userId: string, payload: object) => string,
 *   resume: (sessionId: string, userId: string) => object | null,
 *   remove: (sessionId: string) => boolean,
 *   size: () => number,
 *   clear: () => void,
 * }}
 */
export function createSessionStore(options = {}) {
  const ttlMs =
    options.ttlMs ??
    (Number(process.env.SONNET_SESSION_TTL_MS) > 0
      ? Number(process.env.SONNET_SESSION_TTL_MS)
      : DEFAULT_TTL_MS);

  const maxEntries =
    options.maxEntries ??
    (Number(process.env.SONNET_SESSION_MAX_ENTRIES) > 0
      ? Number(process.env.SONNET_SESSION_MAX_ENTRIES)
      : DEFAULT_MAX_ENTRIES);

  const now = options.now || (() => Date.now());
  const mintId = options.mintId || (() => crypto.randomUUID());

  // Map preserves insertion order. We re-insert on each read (delete+set) so the
  // iteration order matches LRU recency — oldest-used entry is always .keys().next().
  const entries = new Map();

  function evictExpired() {
    const t = now();
    for (const [id, entry] of entries) {
      if (t - entry.createdAt >= ttlMs) {
        entries.delete(id);
      } else {
        // First non-expired wins — rest are younger because insertion order is ~chronological.
        // (Touching on resume moves an entry to the tail, which is fine; a touched entry
        // has a newer `createdAt`? No — `createdAt` is the original mint time so TTL is
        // anchored there, not on the last resume. We deliberately do NOT refresh createdAt
        // on touch: the brief says "resume within TTL" → the token should expire on a
        // fixed window, not be indefinitely extendable by repeated reconnects.)
        break;
      }
    }
  }

  function evictLRU() {
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  return {
    /**
     * Mint a new session ID and store the payload under it.
     * Returns the minted ID.
     */
    create(userId, payload) {
      if (!userId) throw new Error('userId required');
      evictExpired();
      const sessionId = mintId();
      entries.set(sessionId, {
        userId,
        payload,
        createdAt: now(),
      });
      evictLRU();
      return sessionId;
    },

    /**
     * Look up a session by the rehydration ID. Returns the stored payload if
     * - the ID exists
     * - the entry is within TTL
     * - the requesting userId matches the stored userId
     *
     * Otherwise returns null. On user-mismatch we return null AND remove the
     * entry (cheap defence — a mismatch is either a bug or an attack, either
     * way the token is now blown).
     */
    resume(sessionId, userId) {
      if (!sessionId || !userId) return null;
      const entry = entries.get(sessionId);
      if (!entry) return null;

      if (now() - entry.createdAt >= ttlMs) {
        entries.delete(sessionId);
        return null;
      }

      if (entry.userId !== userId) {
        // Do not leak existence: caller gets the same null it would for an
        // unknown ID. We delete to invalidate the token post-abuse.
        entries.delete(sessionId);
        return null;
      }

      // Touch: move to the tail so this entry is least-likely to be evicted next.
      entries.delete(sessionId);
      entries.set(sessionId, entry);
      return entry.payload;
    },

    /**
     * Plan 06-08 r7-#2 (MAJOR) — non-mutating read.
     *
     * Returns the same payload as `resume()` for valid hits but does NOT
     * touch LRU and does NOT delete on miss/expired/user-mismatch.
     * peek() is the validate-only primitive; consumption + security
     * defence (e.g. blow-token-on-wrong-user) is the caller's choice
     * via a follow-up `remove()`.
     *
     * Why a SEPARATE method (not a flag on resume): callers in
     * `sonnet-stream.js`'s `handleSessionResumeRehydrate` use `peek` to
     * VALIDATE the inbound `protocol_version` BEFORE committing the
     * rebind via `resume`. The peek/resume split makes the call site
     * self-documenting: "I'm reading to validate" vs "I'm committing
     * the rebind". A rejected protocol_version validation must leave
     * the token valid so the iOS client can retry without burning its
     * only resume credential.
     *
     * Today's `resume()` is non-consuming on the happy path (LRU bump
     * only). But the Wave 4c.5 brief explicitly anticipates evolving
     * this in-memory store to a Redis-backed implementation with
     * GETDEL-style consuming-on-read semantics. A future change there
     * would silently break the retry-after-reject flow if the
     * rehydrate path called `resume` first. Splitting into peek +
     * resume now means that future re-implementation only changes
     * the `resume` body — peek's contract is already
     * "validate without consume".
     *
     * Why the user-mismatch path does NOT delete here: peek is a
     * primitive — deletion is the caller's choice. The wrong-user-
     * probe defence in the existing `resume()` contract is preserved
     * by the `handleSessionResumeRehydrate` caller calling
     * `sonnetSessionStore.remove(...)` on the !peeked branch (which
     * fires for missing OR TTL-expired OR user-mismatch — peek's null
     * doesn't disambiguate, but `remove()` is idempotent, so blanket-
     * removing on any null is safe and preserves the defence). See
     * the comment on `handleSessionResumeRehydrate`'s !peeked branch.
     *
     * @param {string} sessionId
     * @param {string} userId
     * @returns {object | null} The stored payload if the entry is
     *   valid, in-TTL, and owned by `userId`. Otherwise null.
     */
    peek(sessionId, userId) {
      if (!sessionId || !userId) return null;
      const entry = entries.get(sessionId);
      if (!entry) return null;
      if (now() - entry.createdAt >= ttlMs) return null;
      if (entry.userId !== userId) return null;
      return entry.payload;
    },

    /**
     * Explicit removal (used when `session_stop` fires — no point keeping a
     * token around for a cleanly-closed session).
     */
    remove(sessionId) {
      return entries.delete(sessionId);
    },

    /** Current live entry count (post-lazy-expiry). Useful for tests + metrics. */
    size() {
      evictExpired();
      return entries.size;
    },

    /** Wipe all entries. Used by tests; not called in production. */
    clear() {
      entries.clear();
    },
  };
}

/** Shared default instance used by the Sonnet WS handler. */
export const sonnetSessionStore = createSessionStore();
