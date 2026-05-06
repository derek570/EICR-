/**
 * Chitchat pause state machine — slices 1-3.
 *
 * Counts consecutive Sonnet turns that produced no extraction (no readings,
 * no observations, no question emitted, no active ask_user, no iOS regex
 * hits). When the counter hits CHITCHAT_PAUSE_THRESHOLD, the WS sends a
 * `chitchat_paused` envelope and stops forwarding incoming transcript
 * messages to Sonnet until a wake trigger fires. Deepgram + iOS-side
 * regex remain active throughout — only the Sonnet API leg is suppressed.
 *
 * Wake triggers (server-side, all four):
 *   1. Voice command matched by WAKE_REGEX in any incoming transcript text.
 *   2. Manual `chitchat_resume` WS message (iOS Resume button).
 *   3. Existing `session_resume` WS message — fires when Deepgram reconnects
 *      from doze, so audio coming back also wakes Sonnet.
 *   4. iOS regex hit (`msg.regexResults` non-empty on a transcript): the
 *      inspector dictated a value the on-device matcher caught; that's
 *      strong engagement signal, so wake + replay-buffer-prepend the
 *      transcript before forwarding to handleTranscript.
 *
 * On wake, the replay buffer (paused-session transcripts within the last
 * 30 s) is drained and prepended to the wake utterance so a value spoken
 * right at the pause/wake boundary isn't lost.
 *
 * Cache keep-alive (slice 3 — DELIVERED BY EXISTING INFRASTRUCTURE):
 *   The `EICRExtractionSession` already runs a 4-minute prompt-cache
 *   keepalive (`_sendCacheKeepalive` in eicr-extraction-session.js,
 *   CACHE_KEEPALIVE_MS = 4 * 60 * 1000). Each tick fires a tiny
 *   `messages.create` with `cache_control: ephemeral 5m` on the system
 *   blocks + `max_tokens: 1`, refreshing Anthropic's 5-min cache TTL.
 *   The keepalive runs for the lifetime of `session.isActive`, which is
 *   set in startSession() and cleared only in stop(). Critically, the
 *   chitchat-pause helpers below DO NOT call `session.pause()` (that's
 *   the Deepgram-doze path, which has its own PAUSE_KEEPALIVE_BUDGET_MS
 *   cap), so the cache continues to refresh through chitchat pauses with
 *   no further wiring required. If the chitchat pause logic ever needs
 *   to interact with the session lifecycle it MUST avoid `pause()` /
 *   `resume()` — those names are reserved for the Deepgram doze cycle.
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

// Throttle for the per-transcript suppression log. Logging every
// dropped transcript during a long pause produces hundreds of nearly-
// identical CloudWatch lines. The first suppression always logs (so a
// debug session sees that the pause started taking effect) and after
// that we only emit once per `CHITCHAT_SUPPRESS_LOG_INTERVAL_MS`.
export const CHITCHAT_SUPPRESS_LOG_INTERVAL_MS = 60_000;

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
      // Suppression-log throttle (slice-3 follow-up cleanup): timestamp
      // of the most-recent `chitchat.transcript_suppressed` log line.
      // 0 means "never logged this pause cycle". Reset to 0 on
      // exitChitchatPause so a future pause starts with a fresh log.
      lastSuppressLogAt: 0,
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
 *   - Sonnet emitted a question (legacy-mode JSON OR tool-call ask_user
 *     — both surfaces emit `questions_for_user`; tool-call mode is
 *     already covered by that array, so no separate "pending ask"
 *     parameter is needed here)
 *
 * iOS regex hits are handled at TRANSCRIPT-RECEIPT time in the host
 * (sonnet-stream.js `case 'transcript'` block) by direct counter
 * manipulation, not via this function — the engagement check only sees
 * Sonnet's own output. Keeping that path separate avoids feeding the
 * `regexHintCount` parameter through the extraction-result callbacks
 * which run aggregated over multiple transcripts and can't always
 * attribute a hint to the right turn.
 */
export function turnHadEngagement(result) {
  if (Array.isArray(result?.extracted_readings) && result.extracted_readings.length > 0) {
    return true;
  }
  if (Array.isArray(result?.observations) && result.observations.length > 0) {
    return true;
  }
  if (Array.isArray(result?.questions_for_user) && result.questions_for_user.length > 0) {
    return true;
  }
  return false;
}

/**
 * Update the counter after a Sonnet turn completes. Fires
 * `enterChitchatPause` once the threshold is crossed. Pure with respect
 * to the WS — the caller passes a `sendEnvelope` callback so this module
 * doesn't need to know how to write to the socket.
 *
 * @param {object}   args
 * @param {object}   args.state          chitchatState from ensureChitchatState
 * @param {object}   args.result         Sonnet extraction result
 * @param {function} args.sendEnvelope   (envelope) => void — JSON.stringified by caller
 * @param {function} [args.logger]       optional structured logger
 * @param {string}   [args.sessionId]
 */
export function recordTurn({ state, result, sendEnvelope, logger, sessionId }) {
  if (!state || state.paused) return;
  if (turnHadEngagement(result)) {
    if (state.turnsSinceExtraction !== 0) {
      logger?.info?.('chitchat.counter_reset', {
        sessionId,
        prev_count: state.turnsSinceExtraction,
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
  // Reset the suppression-log throttle so the next pause cycle gets
  // its first-suppression log line, not a silent skip.
  state.lastSuppressLogAt = 0;
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
 * (oldest first), period-joined. Sonnet sees turn boundaries rather
 * than one run-on pseudo-utterance: entries that already end with
 * `.`/`!`/`?` are preserved, others get a period appended by the
 * joiner so the concatenated result reads as a sequence of sentences.
 * Clears the buffer. Returns `''` when empty so the caller can
 * prepend without conditionals.
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
    .map((e) => {
      const t = e.text.trim();
      return /[.!?]$/.test(t) ? t : `${t}.`;
    })
    .join(' ')
    .trim();
}

/**
 * Throttled accessor for the per-transcript suppression log. Returns
 * true when the caller should emit the `chitchat.transcript_suppressed`
 * log line, false when it should skip. First suppression of each
 * pause cycle always logs (so debugging sees pause took effect);
 * subsequent suppressions are gated by `CHITCHAT_SUPPRESS_LOG_INTERVAL_MS`
 * to keep CloudWatch noise bounded for long pauses (no
 * 360-line dumps for a 30-min phone call).
 */
export function shouldLogSuppression(state, now = Date.now()) {
  if (!state) return false;
  const last = state.lastSuppressLogAt || 0;
  if (last === 0 || now - last >= CHITCHAT_SUPPRESS_LOG_INTERVAL_MS) {
    state.lastSuppressLogAt = now;
    return true;
  }
  return false;
}
