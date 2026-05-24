// active-sessions.js
// Central registry of live Sonnet extraction sessions, keyed by sessionId.
//
// Pulled out of sonnet-stream.js so that route modules (keys.js) and tests
// can import the registry + attribution helpers without dragging the full WS
// handler graph (storage.js, anthropic SDK, S3, etc.) into their module
// context. Jest in particular trips on storage.js's `import.meta.dirname`
// when sonnet-stream.js is imported in a unit test.
//
// sonnet-stream.js still owns all mutation of this map — it is the only
// writer of `Entry.session`. Route-side consumers only read + attribute
// side-effects onto `session.costTracker`.

/** @type {Map<string, { session: any, questionGate: any, ws: any, [k: string]: any }>} */
export const activeSessions = new Map();

/**
 * Record ElevenLabs TTS character usage against a live session's CostTracker.
 *
 * Called by the `/api/proxy/elevenlabs-tts` route after a successful TTS
 * proxy response. Silently no-ops when the session is unknown (e.g. TTS is
 * fired after the WS closed during a reconnect race, or the caller is an
 * admin tool replaying text outside a session). Returns `true` if the usage
 * was applied so the caller can log that the tracker was found.
 *
 * @param {string} sessionId
 * @param {number} characterCount
 * @returns {boolean} true if tracker found and usage recorded, false otherwise
 */
export function recordElevenLabsUsageForSession(sessionId, characterCount) {
  if (!sessionId || typeof characterCount !== 'number' || characterCount <= 0) {
    return false;
  }
  const entry = activeSessions.get(sessionId);
  if (!entry || !entry.session || !entry.session.costTracker) return false;
  entry.session.costTracker.addElevenLabsUsage(characterCount);
  return true;
}

/**
 * Stage 2 commit 2.6 — attribute streaming-TTS started chars to a session's
 * CostTracker, idempotent per correlationId. Mirrors the convenience pattern
 * of recordElevenLabsUsageForSession above (sessionId → tracker lookup +
 * silent no-op when unknown).
 *
 * @returns {boolean} true if attribution applied; false on missing session or
 *                    duplicate correlationId.
 */
export function recordElevenLabsStreamingStartedForSession(
  sessionId,
  characterCount,
  correlationId
) {
  if (!sessionId || typeof characterCount !== 'number' || characterCount <= 0 || !correlationId) {
    return false;
  }
  const entry = activeSessions.get(sessionId);
  if (!entry?.session?.costTracker?.recordElevenLabsStreamingStarted) return false;
  return entry.session.costTracker.recordElevenLabsStreamingStarted(characterCount, correlationId);
}

/**
 * Stage 2 commit 2.6 — attribute streaming-TTS terminal state to a session.
 * Idempotent per correlationId; no-op when session unknown.
 *
 * @param {string} sessionId
 * @param {string} correlationId
 * @param {'completed'|'cancelled'|'failed'} terminal
 * @param {number} [characterCount=0]
 */
export function recordElevenLabsStreamingTerminalForSession(
  sessionId,
  correlationId,
  terminal,
  characterCount = 0
) {
  if (!sessionId || !correlationId || !terminal) return false;
  const entry = activeSessions.get(sessionId);
  if (!entry?.session?.costTracker?.recordElevenLabsStreamingTerminal) return false;
  return entry.session.costTracker.recordElevenLabsStreamingTerminal(
    correlationId,
    terminal,
    characterCount
  );
}

/**
 * Stage 2 commit 2.5 — convenience read of the per-session voice-latency
 * snapshot (flags + capabilities). Returns null when session unknown so
 * callers can fall through to the legacy path.
 */
export function getVoiceLatencyForSession(sessionId) {
  if (!sessionId) return null;
  const entry = activeSessions.get(sessionId);
  return entry?.voiceLatency ?? null;
}

/**
 * Loaded Barrel Phase 3 (plan v10 §C + §D) — credit a speculative
 * correlationId as "served by cache HIT" on the per-session
 * CostTracker. Called from keys.js short-circuit AFTER res.end().
 *
 * Returns true on success, false on missing session / missing
 * tracker / unknown correlationId. Idempotent on correlationId via
 * the underlying promoteSpeculativeToCanonical call.
 */
export function promoteSpeculativeToCanonicalForSession(sessionId, correlationId) {
  if (!sessionId || !correlationId) return false;
  const entry = activeSessions.get(sessionId);
  if (!entry?.session?.costTracker?.promoteSpeculativeToCanonical) return false;
  return entry.session.costTracker.promoteSpeculativeToCanonical(correlationId);
}
