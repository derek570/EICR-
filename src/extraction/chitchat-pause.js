/**
 * Chitchat pause state machine — slice 1.
 *
 * Counts consecutive Sonnet turns that produced no extraction (no readings,
 * no observations, no question emitted, no active ask_user). When the
 * counter hits CHITCHAT_PAUSE_THRESHOLD, the WS sends a `chitchat_paused`
 * envelope and stops forwarding incoming transcript messages to Sonnet
 * until a wake trigger fires. Deepgram + iOS-side regex remain active
 * throughout — only the Sonnet API leg is suppressed.
 *
 * Wake triggers (server-side):
 *   1. Voice command matched by WAKE_REGEX in any incoming transcript text.
 *   2. Manual `chitchat_resume` WS message (iOS Resume button).
 *   3. Existing `session_resume` WS message — fires when Deepgram reconnects
 *      from doze, so audio coming back also wakes Sonnet (the fourth
 *      trigger Derek asked for).
 *   4. (slice 2) iOS regex hint sent inside a transcript msg — not yet
 *      implemented in this slice. Wired in slice 2 alongside the replay
 *      buffer.
 *
 * This module is intentionally framework-agnostic: it operates on a plain
 * `chitchatState` object stamped onto the active-session entry. The host
 * (sonnet-stream.js) owns WS plumbing + session lookup.
 *
 * Production motivator: 60-min jobs frequently include 10-15 min of
 * chitchat (site banter, phone calls, walking between rooms). Forwarding
 * those turns to Sonnet at full conversation context bills the dominant
 * cost driver (input-token spend scales with conversation length, not
 * just the new turn) for zero extraction value.
 */

export const CHITCHAT_PAUSE_THRESHOLD = 10;

// How many seconds of recent paused-transcript text to replay back to
// Sonnet on wake. Caps at the configured horizon so a session that sits
// in chitchat for an hour doesn't accumulate megabytes of dead text and
// flood the next Sonnet turn.
export const CHITCHAT_REPLAY_HORIZON_MS = 30_000;

// Resume words an inspector might naturally say. Server-side only — iOS
// doesn't need to know the vocabulary because the transcript carries the
// raw text and the server matches. Bounded forms ("certmate" + verb
// within 15 chars) catch "CertMate, resume" / "CertMate listen" without
// false-firing on unrelated speech mentioning the brand.
export const WAKE_REGEX =
  /\b(?:resume|carry\s+on|continue|wake\s+up|go\s+on|back\s+to\s+it|certmate.{0,15}?(?:resume|listen|on))\b/i;

/**
 * Initialise the chitchat state on a session entry. Idempotent — safe
 * to call on reconnect; preserves prior counter / paused state if the
 * session was already tracked.
 */
export function ensureChitchatState(entry) {
  if (!entry) return null;
  if (!entry.chitchatState) {
    entry.chitchatState = {
      turnsSinceExtraction: 0,
      paused: false,
      pausedAt: null,
      // Slice 2: rolling buffer of transcript text dropped while
      // paused. Drained on wake and prepended to the wake utterance
      // so a value spoken right at the wake boundary isn't lost.
      // Cap by time, not size — `CHITCHAT_REPLAY_HORIZON_MS`.
      replayBuffer: [],
    };
  }
  return entry.chitchatState;
}

/**
 * Did this Sonnet turn produce ANY engagement signal that should reset
 * the counter? Used by both the sync (handleTranscript) and async
 * (onBatchResult) extraction-result paths.
 *
 * Engagement = at least one of:
 *   - Sonnet extracted a reading (record_reading / update_field tool call)
 *   - Sonnet captured an observation
 *   - Sonnet emitted a question (legacy-mode JSON OR tool-call ask_user)
 *   - The session has a pending ask_user round-trip (engine working
 *     through a question — must not count as chitchat even if the
 *     turn itself was a quiet "let me re-ask" pass)
 *   - iOS regex (TranscriptFieldMatcher) caught a value on this turn,
 *     even when Sonnet itself extracted nothing. Slice 2: this is
 *     Derek's "if regex extracts everything well, Sonnet would go
 *     offline" risk mitigation — regex-only sessions keep Sonnet warm.
 */
export function turnHadEngagement(result, sessionPendingAskUser, regexHintCount = 0) {
  if (sessionPendingAskUser) return true;
  if (regexHintCount > 0) return true;
  if (Array.isArray(result?.extracted_readings) && result.extracted_readings.length > 0) {
    return true;
  }
  if (Array.isArray(result?.observations) && result.observations.length > 0) {
    return true;
  }
  if (Array.isArray(result?.questions_for_user) && result.questions_for_user.length > 0) {
    return true;
  }
  // Tool-call mode emits questions via ask_user tool calls — those land
  // on the session's pendingAskUser flag, already handled above.
  return false;
}

/**
 * Update the counter after a Sonnet turn completes. Fires
 * `enterChitchatPause` once the threshold is crossed. Pure with respect
 * to the WS — the caller passes a `sendEnvelope` callback so this module
 * doesn't need to know how to write to the socket.
 *
 * @param {object}   args
 * @param {object}   args.state              chitchatState from ensureChitchatState
 * @param {object}   args.result             Sonnet extraction result
 * @param {boolean}  args.pendingAskUser     truthy if engine has an ask in flight
 * @param {function} args.sendEnvelope       (envelope) => void — JSON.stringified by caller
 * @param {function} [args.logger]           optional structured logger
 * @param {string}   [args.sessionId]
 */
export function recordTurn({
  state,
  result,
  pendingAskUser,
  regexHintCount = 0,
  sendEnvelope,
  logger,
  sessionId,
}) {
  if (!state || state.paused) return;
  if (turnHadEngagement(result, pendingAskUser, regexHintCount)) {
    if (state.turnsSinceExtraction !== 0) {
      logger?.info?.('chitchat.counter_reset', {
        sessionId,
        prev_count: state.turnsSinceExtraction,
        regex_hint_count: regexHintCount,
      });
    }
    state.turnsSinceExtraction = 0;
    return;
  }
  state.turnsSinceExtraction += 1;
  logger?.info?.('chitchat.counter_increment', {
    sessionId,
    count: state.turnsSinceExtraction,
    threshold: CHITCHAT_PAUSE_THRESHOLD,
  });
  if (state.turnsSinceExtraction >= CHITCHAT_PAUSE_THRESHOLD) {
    enterChitchatPause({ state, sendEnvelope, logger, sessionId });
  }
}

/**
 * Enter the paused state. Stops forwarding transcripts to Sonnet until
 * `exitChitchatPause` is called. Idempotent.
 */
export function enterChitchatPause({ state, sendEnvelope, logger, sessionId }) {
  if (!state || state.paused) return;
  state.paused = true;
  state.pausedAt = Date.now();
  logger?.info?.('chitchat.paused', {
    sessionId,
    threshold: CHITCHAT_PAUSE_THRESHOLD,
    reason: 'turns_without_extraction',
  });
  try {
    sendEnvelope?.({ type: 'chitchat_paused', threshold: CHITCHAT_PAUSE_THRESHOLD });
  } catch (err) {
    logger?.warn?.('chitchat.send_paused_failed', { sessionId, error: err?.message });
  }
}

/**
 * Exit the paused state. Resets the counter. Idempotent.
 *
 * @param {string} reason — wake_word | manual | session_resume | regex_hint
 */
export function exitChitchatPause({ state, sendEnvelope, logger, sessionId, reason }) {
  if (!state || !state.paused) return;
  const pausedDurationMs = state.pausedAt ? Date.now() - state.pausedAt : null;
  state.paused = false;
  state.pausedAt = null;
  state.turnsSinceExtraction = 0;
  logger?.info?.('chitchat.resumed', {
    sessionId,
    reason: reason || 'unspecified',
    paused_duration_ms: pausedDurationMs,
  });
  try {
    sendEnvelope?.({ type: 'chitchat_resumed', reason: reason || 'unspecified' });
  } catch (err) {
    logger?.warn?.('chitchat.send_resumed_failed', { sessionId, error: err?.message });
  }
}

/**
 * Check whether an incoming transcript text contains a wake word. Used
 * by the host's `case 'transcript'` handler BEFORE forwarding to
 * handleTranscript when the session is paused.
 */
export function isWakeWordTranscript(text) {
  if (typeof text !== 'string' || !text) return false;
  return WAKE_REGEX.test(text);
}

/**
 * Append a paused-session transcript to the replay buffer. Drops
 * entries older than `CHITCHAT_REPLAY_HORIZON_MS` so the buffer stays
 * bounded regardless of pause length. Caller invokes this only when
 * the transcript is being suppressed (no wake word, no regex hit).
 */
export function bufferTranscript(state, text, now = Date.now()) {
  if (!state || typeof text !== 'string' || !text.trim()) return;
  state.replayBuffer.push({ ts: now, text });
  // Evict expired in-place — cheap because the buffer is short and
  // strictly monotonic in `ts`.
  const horizon = now - CHITCHAT_REPLAY_HORIZON_MS;
  while (state.replayBuffer.length > 0 && state.replayBuffer[0].ts < horizon) {
    state.replayBuffer.shift();
  }
}

/**
 * Drain the replay buffer to a single string in chronological order
 * (oldest first), space-joined. Clears the buffer. Returns `''` when
 * empty so the caller can prepend without conditionals.
 *
 * Drops entries older than the horizon BEFORE concatenating — a slow
 * wake (e.g. iOS sat on the WS message for several seconds) shouldn't
 * resurrect already-stale text.
 */
export function drainReplayBuffer(state, now = Date.now()) {
  if (!state || !Array.isArray(state.replayBuffer) || state.replayBuffer.length === 0) {
    return '';
  }
  const horizon = now - CHITCHAT_REPLAY_HORIZON_MS;
  const fresh = state.replayBuffer.filter((e) => e.ts >= horizon);
  state.replayBuffer = [];
  return fresh
    .map((e) => e.text)
    .join(' ')
    .trim();
}
