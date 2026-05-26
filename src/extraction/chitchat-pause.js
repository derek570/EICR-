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
 * Wake triggers (server-side, all three are SEMANTIC — the inspector did
 * something that signals real inspection intent):
 *   1. Voice command matched by WAKE_REGEX in any incoming transcript text.
 *   2. Manual `chitchat_resume` WS message (iOS Resume button).
 *   3. iOS regex hit (`msg.regexResults` non-empty on a transcript): the
 *      inspector dictated a value the on-device matcher caught; that's
 *      strong engagement signal, so wake + replay-buffer-prepend the
 *      transcript before forwarding to handleTranscript.
 *
 * Notably NOT a wake trigger: `session_resume`. That envelope fires on
 * Deepgram doze recovery (any time speech resumes after ≥10s silence),
 * which happens repeatedly in pocket / family-chat / phone-call scenarios.
 * Treating it as a wake trigger reset the counter on every doze cycle and
 * effectively defeated the protection (prod session D8E51F51 2026-05-09:
 * pause fired correctly at turn 8, then immediately undone by session_resume
 * 215s later, counter restarted, never re-armed before the inspector noticed
 * and stopped the session). Chitchat wake is now semantic-only.
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

// 8 zero-engagement Sonnet turns ≈ 35-40s of continuous chitchat at the
// observed ~5s-per-turn cadence. Was 10 (50s) — lowered 2026-05-07 after
// session 555FA596 ran for 67s without engaging the pause; the threshold
// landed past the natural session boundary. At ~$0.0067/turn the cost
// difference 10→8 is only ~1.4¢/episode but the ~10s-faster engagement
// is the bigger win on long phone-call / walk-between-rooms episodes.
// Re-evaluate downward if/when Deepgram Flux migration lands — Flux's
// turn-detection produces fewer, more semantically complete utterances,
// so equivalent chitchat would tick the counter more slowly.
export const CHITCHAT_PAUSE_THRESHOLD = 8;

// 2026-05-26 — second, faster trip threshold for the "panic re-ask" pattern.
//
// Distinct from CHITCHAT_PAUSE_THRESHOLD (which counts ALL zero-engagement
// turns), this counts only consecutive ask_user emissions whose `reason` is
// `missing_context` (Sonnet emitting "Sorry, I didn't catch that — what
// circuit are you on?"-style asks). Session 33E6613D-49A7-4B42-A73B-1E2C6A82174D
// burst 6 such asks in 31 s; the existing 8-turn threshold never tripped
// because intervening turns produced "draft" observation_confirmations that
// reset the engagement counter.
//
// 3 is conservative: a single mis-heard reading + one repeat is the natural
// ambient rate; only when the inspector is genuinely off-mic / off-topic do
// we see 3+ in a row. Setting too low (e.g. 2) would pause prematurely on a
// reading that needs a quick clarifying follow-up; setting too high (e.g. 5)
// keeps burning ~$0.027/ask through the burst window. Re-evaluate downward
// only if field tests show the model isn't entering legitimate clarification
// loops without tripping.
//
// Tunable at runtime via CHITCHAT_MISSING_CONTEXT_THRESHOLD env var; the
// CHITCHAT_COUNT_MISSING_CONTEXT flag disables the whole mechanism (kill
// switch for fast rollback).
const _envMissingCtxThreshold = parseInt(process.env.CHITCHAT_MISSING_CONTEXT_THRESHOLD || '', 10);
export const CHITCHAT_MISSING_CONTEXT_THRESHOLD =
  Number.isFinite(_envMissingCtxThreshold) && _envMissingCtxThreshold > 0
    ? _envMissingCtxThreshold
    : 3;
export const CHITCHAT_COUNT_MISSING_CONTEXT =
  process.env.CHITCHAT_COUNT_MISSING_CONTEXT !== 'false';

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
// raw text and the server matches.
//
// Vocabulary:
//   - `resume` / `carry on` / `continue` / `wake up` — direct commands
//   - `go on` / `back to it` — colloquial resume phrases
//   - `certmate.{0,15}?(?:resume|listen|on)` — brand-anchored variants
//     ("CertMate, resume" / "CertMate listen") with a 15-char ceiling
//     so a long sentence mentioning "CertMate" doesn't false-fire.
//
// False-positive guards (slice-3 follow-up cleanup, L5 from the
// post-impl review):
//   - The bare verbs `go on` / `continue` are too generic on their own
//     ("I'll go on the roof", "let me continue with the paperwork"),
//     so each is wrapped in a negative lookahead that excludes the
//     most common chitchat continuations: prepositions (`on`, `with`,
//     `to`, `in`, `for`, `about`, `up`) and articles (`the`, `a`, `an`).
//     `Carry on` is left unguarded because it's almost always a wake
//     phrase in inspector context (the alternative — "carry on a
//     conversation" — is rare enough to accept the false-wake cost).
//   - `wake up`, `back to it`, `resume` aren't guarded because their
//     natural English usage is overwhelmingly a wake intent.
//
// The conservative reading: a false wake is a benign event (Sonnet
// just resumes, costing one extra turn until the counter ticks back
// up). The guards trade a small amount of precision for noticeably
// fewer false wakes during chitchat about the inspection itself.
export const WAKE_REGEX =
  /\b(?:resume|carry\s+on|continue(?!\s+(?:on|with|to|in|for|about|up|the|a|an)\b)|wake\s+up|go\s+on(?!\s+(?:the|a|an|with|to|in|for|about|up)\b)|back\s+to\s+it|certmate.{0,15}?(?:resume|listen|on))\b/i;

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
      // 2026-05-26 — separate counter for consecutive ask_user emissions
      // with reason=missing_context. Increments from the ask dispatcher;
      // resets on any successful extraction turn AND on exitChitchatPause.
      // Trip threshold is CHITCHAT_MISSING_CONTEXT_THRESHOLD; pause reason
      // is 'missing_context_streak' so CloudWatch / iOS can distinguish.
      missingContextAskStreak: 0,
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
    // 2026-05-26 — also reset the missing-context streak on engagement.
    // A successful extraction proves Sonnet caught the inspector's intent,
    // so the prior "Sorry, I didn't catch that" run was either resolved
    // or superseded by a clean reading. Either way the streak shouldn't
    // carry forward across the engagement boundary.
    if (state.missingContextAskStreak > 0) {
      logger?.info?.('chitchat.missing_context_streak_reset', {
        sessionId,
        prev_count: state.missingContextAskStreak,
        reason: 'engagement',
      });
      state.missingContextAskStreak = 0;
    }
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
 *
 * @param {object} args
 * @param {string} [args.reason] — pause trigger; defaults to the legacy
 *                 'turns_without_extraction'. 'missing_context_streak' is
 *                 used when the new ask-dispatcher hook trips.
 * @param {number} [args.threshold] — value reported back to the iOS client
 *                 envelope for the analytics log. Defaults to
 *                 CHITCHAT_PAUSE_THRESHOLD; the missing-context path passes
 *                 CHITCHAT_MISSING_CONTEXT_THRESHOLD instead so the analyzer
 *                 doesn't conflate the two trip mechanisms.
 */
export function enterChitchatPause({ state, sendEnvelope, logger, sessionId, reason, threshold }) {
  if (!state || state.paused) return;
  state.paused = true;
  state.pausedAt = Date.now();
  const resolvedReason = reason || 'turns_without_extraction';
  const resolvedThreshold = Number.isFinite(threshold) ? threshold : CHITCHAT_PAUSE_THRESHOLD;
  logger?.info?.('chitchat.paused', {
    sessionId,
    threshold: resolvedThreshold,
    reason: resolvedReason,
  });
  try {
    sendEnvelope?.({
      type: 'chitchat_paused',
      threshold: resolvedThreshold,
      reason: resolvedReason,
    });
  } catch (err) {
    logger?.warn?.('chitchat.send_paused_failed', { sessionId, error: err?.message });
  }
}

/**
 * 2026-05-26 — second pause-trip channel for the "panic re-ask" pattern.
 *
 * Called by stage6-dispatcher-ask.js when Sonnet emits an `ask_user` whose
 * `reason` is `missing_context`. Counts consecutive such asks and trips the
 * pause once the count reaches CHITCHAT_MISSING_CONTEXT_THRESHOLD. Resets
 * on engagement (handled in recordTurn above) and on any non-missing_context
 * ask (a real clarifying question doesn't carry the same panic signal).
 *
 * The mechanism is gated by CHITCHAT_COUNT_MISSING_CONTEXT (default true);
 * setting the env var to `false` is the kill switch.
 *
 * @param {object} args
 * @param {object} args.state          chitchatState
 * @param {string} args.askReason      ask_user.input.reason (free-text)
 * @param {function} args.sendEnvelope (envelope) => void
 * @param {function} [args.logger]
 * @param {string}   [args.sessionId]
 */
export function noteMissingContextAsk({ state, askReason, sendEnvelope, logger, sessionId }) {
  if (!CHITCHAT_COUNT_MISSING_CONTEXT) return;
  if (!state || state.paused) return;
  // Only the literal 'missing_context' reason increments the streak. Real
  // clarifying asks ('orphaned_reading', 'observation_confirmation',
  // 'missing_value') reflect a productive disambiguation conversation —
  // not a panic loop — and reset the streak.
  if (askReason !== 'missing_context') {
    if (state.missingContextAskStreak > 0) {
      logger?.info?.('chitchat.missing_context_streak_reset', {
        sessionId,
        prev_count: state.missingContextAskStreak,
        reason: 'non_missing_context_ask',
        ask_reason: askReason || null,
      });
      state.missingContextAskStreak = 0;
    }
    return;
  }
  state.missingContextAskStreak += 1;
  logger?.info?.('chitchat.missing_context_streak_increment', {
    sessionId,
    count: state.missingContextAskStreak,
    threshold: CHITCHAT_MISSING_CONTEXT_THRESHOLD,
  });
  if (state.missingContextAskStreak >= CHITCHAT_MISSING_CONTEXT_THRESHOLD) {
    enterChitchatPause({
      state,
      sendEnvelope,
      logger,
      sessionId,
      reason: 'missing_context_streak',
      threshold: CHITCHAT_MISSING_CONTEXT_THRESHOLD,
    });
  }
}

/**
 * Exit the paused state. Resets the counter. Idempotent.
 *
 * @param {string} reason — wake_word | manual | regex_hint
 */
export function exitChitchatPause({ state, sendEnvelope, logger, sessionId, reason }) {
  if (!state || !state.paused) return;
  const pausedDurationMs = state.pausedAt ? Date.now() - state.pausedAt : null;
  state.paused = false;
  state.pausedAt = null;
  state.turnsSinceExtraction = 0;
  // 2026-05-26 — clear the missing-context streak on resume. The pre-pause
  // streak shouldn't survive the wake — the inspector intentionally
  // re-engaged, signalling that the prior panic loop is over.
  state.missingContextAskStreak = 0;
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
