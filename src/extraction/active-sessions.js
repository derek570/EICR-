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

/**
 * @type {Map<string, ActiveSessionEntry>}
 *
 * Entry fields owned by sonnet-stream.js (only writer):
 *  - session / questionGate / ws / voiceLatency — long-lived per-session state.
 *  - pendingFastTtsSlots: Map<turnId, Set<slotKey>> — Mode-A fast-TTS
 *    POST acceptances. Written by the fast-TTS route before responding to
 *    iOS so loaded-barrel-speculator._speculate's preflight can skip the
 *    pre-synth. Cleared per-turn by runLiveMode's finally block.
 *  - fastPathCorrelationIdByTurn: Map<turnId, Set<correlationId>> — client-
 *    minted correlation ids the fast-TTS route saw on this turn's transcript
 *    POSTs. startAudioFinalizer drains pre-finalizer decrements stashed by
 *    decrementExpectedAcksByCorrelation. Cleared per-turn alongside
 *    pendingFastTtsSlots.
 *  - broadcastIntentByTurn: Map<turnId, true> — set by runLiveMode when
 *    `detectBroadcastIntent(transcriptText)` returns true. Read by the
 *    speculator's `_speculate` preflight to skip per-circuit synth on
 *    broadcast turns (defence-in-depth with the post-detect broadcastBuckets
 *    suppression that already exists in the speculator). Same per-turn
 *    lifecycle: written before runToolLoop, cleared in runLiveMode's
 *    finally block. Only `true` is ever written (absent === not a broadcast),
 *    so a single get() call is sufficient at the read site.
 *  - consumedAskUtterances / seenTranscriptUtterances / recentAskAnswers /
 *    recentTranscripts — ask_user/transcript dedupe ledgers (see comments
 *    at their respective sonnet-stream.js init sites).
 */
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
export function recordElevenLabsUsageForSession(sessionId, characterCount, modelId) {
  if (!sessionId || typeof characterCount !== 'number' || characterCount <= 0) {
    return false;
  }
  const entry = activeSessions.get(sessionId);
  if (!entry || !entry.session || !entry.session.costTracker) return false;
  // modelId is optional; addElevenLabsUsage defaults it to the live model.
  entry.session.costTracker.addElevenLabsUsage(characterCount, modelId);
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
  correlationId,
  modelId
) {
  if (!sessionId || typeof characterCount !== 'number' || characterCount <= 0 || !correlationId) {
    return false;
  }
  const entry = activeSessions.get(sessionId);
  if (!entry?.session?.costTracker?.recordElevenLabsStreamingStarted) return false;
  // modelId is optional; recordElevenLabsStreamingStarted defaults it to the
  // live model so the streaming attribution callback signature stays back-compat.
  return entry.session.costTracker.recordElevenLabsStreamingStarted(
    characterCount,
    correlationId,
    modelId
  );
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
 * Single-round latency sprint Phase 1 (PLAN_v8 §A Pivot 11.2). Returns the
 * full activeSessions entry for the given sessionId, or null when unknown.
 *
 * Used by callers that need to mutate per-session state outside the
 * sonnet-stream.js handler — specifically the fast-TTS route which writes
 * `entry.pendingFastTtsSlots` so the loaded-barrel-speculator's
 * `_speculate()` preflight can short-circuit a pre-synth that would
 * otherwise charge cost for audio iOS is already going to ignore.
 *
 * Returning the whole entry (not just the session) keeps the API stable
 * regardless of where individual fields live (entry.voiceLatency,
 * entry.pendingFastTtsSlots, entry.session.costTracker, etc.).
 *
 * @param {string} sessionId
 * @returns {Object | null}
 */
export function getActiveSessionEntry(sessionId) {
  if (!sessionId) return null;
  return activeSessions.get(sessionId) ?? null;
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
