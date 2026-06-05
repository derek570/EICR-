/**
 * Loaded Barrel Phase 1.F readiness tracker (plan v10 §C + §G3).
 *
 * Tracks the adoption of iOS Phase 4a (`turnId` in the TTS POST body)
 * across a rolling 1h window so the operator can decide whether to
 * flip VOICE_LATENCY_LOADED_BARREL=true. Plan gate G3 requires ≥80%
 * of POSTs include `turnId` BEFORE the flag flip — without that
 * adoption, the speculator's cache would mostly be unreachable.
 *
 * Per-process, in-memory only. No cross-instance synchronisation —
 * for the single-user deployment this is sufficient. If we ever go
 * multi-tenant the readiness picture should aggregate across instances
 * via Redis or CloudWatch; the API stays the same.
 *
 * API:
 *   recordPost({userId, hasTurnId, hasExpanderVersion?})
 *     — call from /api/proxy/elevenlabs-tts. userId is the
 *       authenticated user id (string); falsy IDs skip recording.
 *   getReadinessSnapshot()
 *     — returns {windowMs, totalPosts, postsWithTurnId,
 *                postsWithExpanderVersion, adoptionPct,
 *                expanderVersionAdoptionPct, clients: [...] }
 *   pruneExpired()
 *     — internal: drop entries older than WINDOW_MS. Called
 *       implicitly by getReadinessSnapshot.
 *   _resetForTests()
 *     — internal: clear all state. Test-only.
 */

const WINDOW_MS = 60 * 60 * 1000; // 1 hour

/**
 * Per-client rolling state. Stored at module scope (single process).
 *
 * Map<userId, {totalPosts, withTurnId, withExpanderVersion,
 *              firstSeenAt, lastSeenAt}>
 *
 * `firstSeenAt` is used by pruneExpired to decide eviction — a client
 * whose LAST post is older than WINDOW_MS is dropped from the map.
 * `lastSeenAt` is exposed to the endpoint so the operator can see
 * how recently a client was active.
 */
const clientState = new Map();

export function recordPost({ userId, hasTurnId, hasExpanderVersion }) {
  if (!userId) return;
  const now = Date.now();
  let entry = clientState.get(userId);
  if (!entry) {
    entry = {
      totalPosts: 0,
      withTurnId: 0,
      withExpanderVersion: 0,
      firstSeenAt: now,
      lastSeenAt: now,
    };
    clientState.set(userId, entry);
  }
  entry.totalPosts += 1;
  if (hasTurnId) entry.withTurnId += 1;
  if (hasExpanderVersion) entry.withExpanderVersion += 1;
  entry.lastSeenAt = now;
}

export function pruneExpired(nowMs = Date.now()) {
  const cutoff = nowMs - WINDOW_MS;
  for (const [userId, entry] of clientState) {
    if (entry.lastSeenAt < cutoff) clientState.delete(userId);
  }
}

export function getReadinessSnapshot() {
  pruneExpired();
  let totalPosts = 0;
  let postsWithTurnId = 0;
  let postsWithExpanderVersion = 0;
  const clients = [];
  for (const [userId, entry] of clientState) {
    totalPosts += entry.totalPosts;
    postsWithTurnId += entry.withTurnId;
    postsWithExpanderVersion += entry.withExpanderVersion;
    clients.push({
      userId,
      totalPosts: entry.totalPosts,
      withTurnId: entry.withTurnId,
      withExpanderVersion: entry.withExpanderVersion,
      adoptionPct:
        entry.totalPosts > 0 ? Math.round((entry.withTurnId / entry.totalPosts) * 100) : 0,
      firstSeenAt: new Date(entry.firstSeenAt).toISOString(),
      lastSeenAt: new Date(entry.lastSeenAt).toISOString(),
    });
  }
  // Stable ordering: most recent client first so the operator's eye lands
  // on the active inspector.
  clients.sort((a, b) => (b.lastSeenAt < a.lastSeenAt ? -1 : 1));
  return {
    windowMs: WINDOW_MS,
    totalClients: clients.length,
    totalPosts,
    postsWithTurnId,
    postsWithExpanderVersion,
    adoptionPct: totalPosts > 0 ? Math.round((postsWithTurnId / totalPosts) * 100) : 0,
    expanderVersionAdoptionPct:
      totalPosts > 0 ? Math.round((postsWithExpanderVersion / totalPosts) * 100) : 0,
    clients,
  };
}

/** Test-only — clears all state. Production must never call this. */
export function _resetForTests() {
  clientState.clear();
}
