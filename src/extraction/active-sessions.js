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
