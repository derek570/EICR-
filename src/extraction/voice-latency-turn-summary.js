/**
 * Voice-latency turn summary — split-row emitter with delayed finalizer.
 *
 * Single-round latency sprint, Phase 0 (PLAN_v8, Pivots 8 + 8.1 + 8.2 + 8.3 + 8.4).
 *
 * Per turn the backend emits TWO immutable CloudWatch rows:
 *
 *   1. `voice_latency.turn_core_summary`  — Sonnet + dispatch facts. Emitted
 *      synchronously at end of `runLiveMode` after the bundler returns the
 *      result. Carries protocol facts (rounds, stop reasons, predicate result,
 *      timings), dispatch facts (tool counts, error counts), and the
 *      server-side audible-first-byte timestamp.
 *
 *   2. `voice_latency.turn_audio_summary` — cache + iOS playback facts. Emitted
 *      by a delayed finalizer when (a) all expected playback ACKs have arrived
 *      OR (b) an 8s timeout fires. Carries `ios_playback_ack[]` array,
 *      `audio_finalizer_timeout_fired`, and the playback-correlation glue
 *      that connects the core row to which audio actually played.
 *
 * The two rows share `{sessionId, turnId}` keys; CloudWatch Insights
 * dashboards join via conditional aggregation over these scalar keys (NOT
 * SQL join — Logs Insights has no join).
 *
 * A SEPARATE late-ACK row (`voice_latency.late_playback_ack`) is emitted if
 * a playback ACK POST arrives AFTER the finalizer has already fired (i.e. the
 * row is immutable + already emitted). Dashboards correlate late-ACKs to the
 * earlier `turn_audio_summary` post-hoc.
 *
 * Rejected fast-TTS POSTs decrement the expected-ACK count via
 * `decrementExpectedAcksByCorrelation` (keyed by the client-minted
 * regex_fast_correlation_id, since the fast-TTS endpoint cannot know the
 * server-side turnId — minted later inside runLiveMode).
 *
 * All emissions go through `logger.info` with the FIRST argument as the
 * event-name string (which the project's logger serializes as the JSON
 * `message` field; CloudWatch Insights filters with `filter message = "..."`).
 * SERVER_OUTCOMES in `voice-latency-telemetry.js` is INTENTIONALLY left
 * unchanged — these are freestanding observability events, NOT outcome
 * waterfall states. See PLAN_v8 Pivot 11.10.
 */

import logger from '../logger.js';
import { getActiveSessionEntry } from './active-sessions.js';

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} PendingFinalizer
 * @property {string} sessionId
 * @property {string} turnId
 * @property {number} expected_acks   — count of ACKs we wait for
 * @property {Array<Object>} received_acks  — accumulated ACKs
 * @property {ReturnType<typeof setTimeout>} timer
 * @property {bigint} armed_ns   — wall-time finalizer was armed
 */

/** @type {Map<string, PendingFinalizer>} key = `${sessionId}::${turnId}` */
const pendingFinalizers = new Map();

/**
 * Late-arrival decrement stash keyed by `regex_fast_correlation_id`.
 *
 * Fast-TTS endpoint rejection (409/422/etc.) calls
 * `decrementExpectedAcksByCorrelation(sessionId, correlationId)` BEFORE
 * the server-side `runLiveMode` has armed a finalizer for the matching
 * turn. The stash holds the decrement until `startAudioFinalizer` is
 * called for that turn — which then drains matching entries.
 *
 * 60s lazy expiry guards against orphans (socket drop, transcript never
 * arriving). Entries older than 60s are silently dropped on next read.
 *
 * @type {Map<string, {sessionId: string, expires_at_ms: number}>}
 */
const pendingAckDecrements = new Map();

/** Finalizer timeout in ms (PLAN_v8 §A Pivot 8). 8s = conservative buffer
 *  for iOS audio decode + AVAudioPlayer start + ACK POST round-trip. */
const FINALIZER_TIMEOUT_MS = 8000;

/** Stash expiry for pre-finalizer decrements. */
const ACK_DECREMENT_TTL_MS = 60_000;

// ---------------------------------------------------------------------------
// Phase 0 emission functions
// ---------------------------------------------------------------------------

/**
 * Emit the `voice_latency.turn_core_summary` row at end of runLiveMode.
 *
 * Called synchronously after the bundler returns. The companion
 * `turn_audio_summary` is emitted later by the finalizer (or its timeout)
 * and shares `{sessionId, turnId}` for downstream dashboard correlation.
 *
 * @param {Object} fields  All facets that are knowable at end-of-runLiveMode:
 *   sessionId, turnId, correlation_id_pre_synth, correlation_id_fast_path,
 *   rounds, stop_reasons (array), actual_stop_reasons (array),
 *   terminal_reason ('end_turn' | 'tool_use_cap_hit' | 'early_terminated'
 *   | 'aborted'), tool_call_count_per_round (array),
 *   tool_error_count_per_round (array), tool_names_per_round (array of
 *   arrays), early_terminate_predicate (`{fired, reject_reason}`),
 *   sonnet_round1_ms, sonnet_round2_ms, dispatch_total_ms, bundler_ms,
 *   audible_first_byte_ms (server-side, may be null), audible_first_byte_source
 *   ('server_res_write' | 'ios_playback_ack' | null), path_classification.
 *
 *   Wrapped in try/catch — any throw logs `voice_latency.turn_summary_emit_error`
 *   and continues. Telemetry must never break the main extraction flow.
 */
export function emitTurnCoreSummary(fields) {
  try {
    if (!fields || !fields.sessionId || !fields.turnId) {
      logger.warn('voice_latency.turn_summary_emit_error', {
        reason: 'missing_required_keys',
        has_fields: !!fields,
      });
      return;
    }
    logger.info('voice_latency.turn_core_summary', fields);
  } catch (err) {
    logger.warn('voice_latency.turn_summary_emit_error', {
      stage: 'core',
      error: err?.message || String(err),
    });
  }
}

/**
 * Arm the delayed audio finalizer for this turn.
 *
 * Called from runLiveMode AFTER `emitTurnCoreSummary` runs (so the core
 * row is in CloudWatch before any iOS ACK can correlate). The finalizer
 * waits for `expected_acks` ACK POSTs to arrive at `/api/voice-latency/playback-ack`
 * OR for an 8s timeout — whichever fires first triggers the audio-summary row.
 *
 * Pre-finalizer decrements (stashed by `decrementExpectedAcksByCorrelation`
 * when fast-TTS POSTs were rejected before runLiveMode reached this point)
 * are drained at arm time. The set of correlation ids associated with this
 * turn is read off the activeSessions entry's
 * `fastPathCorrelationIdByTurn` map — populated when the WS transcript
 * carrying `regex_fast_correlation_id` was parsed at runLiveMode entry
 * (PLAN_v8 Pivot 8.4).
 *
 * @param {string} sessionId
 * @param {string} turnId
 * @param {Object} options
 * @param {number} options.bundlerEmittedCount   How many bundler confirmations were emitted.
 *                                                **Voice-latency plan 2026-06-03 Tier 1.1 sub-step 5:**
 *                                                callers (i.e. `stage6-shadow-harness.js` and any
 *                                                other `startAudioFinalizer` site) MUST pre-filter
 *                                                this count by `expects_ios_ack !== false` so the
 *                                                finalizer only arms for bundler confirmations whose
 *                                                iOS speak site can actually fire a playback-ack.
 *                                                State-change / observation / cleared confirmations
 *                                                from the bundler set `expects_ios_ack: false` and
 *                                                must be excluded from this count.
 * @param {number} options.attemptedFastTtsCount How many fast-TTS POSTs iOS attempted this turn.
 *                                                Typically the size of
 *                                                `entry.fastPathCorrelationIdByTurn.get(turnId)`.
 *                                                The Set itself is read from the activeSessions
 *                                                entry via `getActiveSessionEntry(sessionId)`
 *                                                rather than being passed by the caller — keeps
 *                                                lifetime ownership inside this module.
 */
export function startAudioFinalizer(sessionId, turnId, options = {}) {
  if (!sessionId || !turnId) {
    logger.warn('voice_latency.turn_summary_emit_error', {
      reason: 'start_finalizer_missing_keys',
      has_sessionId: !!sessionId,
      has_turnId: !!turnId,
    });
    return;
  }
  const bundlerEmittedCount = Number.isFinite(options.bundlerEmittedCount)
    ? options.bundlerEmittedCount
    : 0;
  const attemptedFastTtsCount = Number.isFinite(options.attemptedFastTtsCount)
    ? options.attemptedFastTtsCount
    : 0;

  // Drain pending decrements for the correlation ids attached to this turn.
  // Read the per-turn correlation Set off the activeSessions entry (the
  // Map lives on the entry, populated by runLiveMode when the WS transcript
  // carried `regex_fast_correlation_id`).
  const entry = getActiveSessionEntry(sessionId);
  const correlationIds = entry?.fastPathCorrelationIdByTurn?.get(turnId) ?? new Set();
  const decrementCount = consumePendingDecrements(sessionId, correlationIds);

  const expected_acks = Math.max(0, bundlerEmittedCount + attemptedFastTtsCount - decrementCount);

  // Voice-latency plan 2026-06-03 Tier 1.1 sub-step 5: a turn is
  // ACK-eligible if at least one bundler emit was expects_ios_ack-true OR
  // at least one fast-TTS POST was attempted. The §CloudWatch validation
  // query filters on this to distinguish "Tier 1.1 fix actually works" from
  // "Apple-native fallback / no-context turns legitimately don't ACK".
  // Emitted as integer 0|1 (NOT boolean) because Logs Insights `max()`
  // over a boolean field is undefined in some configurations.
  const eligible_for_validation = bundlerEmittedCount > 0 || attemptedFastTtsCount > 0;

  const key = `${sessionId}::${turnId}`;
  // If we're somehow re-arming for the same turn, clear the prior timer.
  const existing = pendingFinalizers.get(key);
  if (existing) {
    clearTimeout(existing.timer);
    pendingFinalizers.delete(key);
  }

  if (expected_acks === 0) {
    // Nothing to wait for. Emit the audio summary immediately so the
    // row exists in CloudWatch with the same join key.
    emitTurnAudioSummary({
      sessionId,
      turnId,
      ios_playback_ack: [],
      audio_finalizer_timeout_fired: false,
      expected_acks: 0,
      decrements_applied: decrementCount,
      eligible_for_validation,
    });
    return;
  }

  const timer = setTimeout(() => {
    const pending = pendingFinalizers.get(key);
    if (!pending) return;
    pendingFinalizers.delete(key);
    emitTurnAudioSummary({
      sessionId,
      turnId,
      ios_playback_ack: pending.received_acks,
      audio_finalizer_timeout_fired: true,
      expected_acks: pending.expected_acks,
      decrements_applied: decrementCount,
      eligible_for_validation: pending.eligible_for_validation,
    });
  }, FINALIZER_TIMEOUT_MS);
  if (typeof timer.unref === 'function') timer.unref();

  pendingFinalizers.set(key, {
    sessionId,
    turnId,
    expected_acks,
    received_acks: [],
    timer,
    armed_ns: process.hrtime.bigint(),
    // Persist the decrement count so on-time ACK completion can also
    // carry it on the emit (the timeout path captures it via closure;
    // the ACK-completion path reads it off the pending entry).
    decrements_applied: decrementCount,
    // Voice-latency Tier 1.1 sub-step 5: persist eligibility so the on-time
    // ACK completion path (recordPlaybackAck) carries it onto the emit too.
    eligible_for_validation,
  });
}

/**
 * Internal: emit the `voice_latency.turn_audio_summary` row.
 *
 * Voice-latency plan 2026-06-03 Tier 1.1 sub-step 5: project
 * `expected_acks_eligible` as the integer 0|1 (NOT boolean) so CloudWatch
 * Logs Insights `max()` / `filter expected_acks_eligible = 1` works.
 */
function emitTurnAudioSummary(fields) {
  try {
    const enriched = {
      ...fields,
      expected_acks_eligible: fields.eligible_for_validation ? 1 : 0,
    };
    delete enriched.eligible_for_validation; // internal-only; only top-level field ships
    logger.info('voice_latency.turn_audio_summary', enriched);
  } catch (err) {
    logger.warn('voice_latency.turn_summary_emit_error', {
      stage: 'audio',
      error: err?.message || String(err),
    });
  }
}

/**
 * Record an iOS playback ACK. Called by the `/api/voice-latency/playback-ack`
 * endpoint when iOS POSTs that an AVAudioPlayer started or finished playing.
 *
 * On-time path: ACK arrives while the finalizer is armed. Append to
 * `received_acks`; if count reaches `expected_acks`, clear the timer and
 * emit `turn_audio_summary` immediately.
 *
 * Late path: ACK arrives after the finalizer has already fired (its row
 * is immutable, can't be updated). Emit a separate
 * `voice_latency.late_playback_ack` row so dashboards can correlate post-hoc.
 *
 * @param {string} sessionId
 * @param {string} turnId
 * @param {Object} ack — `{slot, source, at_ms}` per /playback-ack body schema.
 */
export function recordPlaybackAck(sessionId, turnId, ack) {
  const key = `${sessionId}::${turnId}`;
  const pending = pendingFinalizers.get(key);
  const received_at_ms = Date.now();

  if (pending) {
    pending.received_acks.push({ ...ack, received_at_ms });
    if (pending.received_acks.length >= pending.expected_acks) {
      clearTimeout(pending.timer);
      pendingFinalizers.delete(key);
      emitTurnAudioSummary({
        sessionId,
        turnId,
        ios_playback_ack: pending.received_acks,
        audio_finalizer_timeout_fired: false,
        expected_acks: pending.expected_acks,
        decrements_applied: pending.decrements_applied,
        eligible_for_validation: pending.eligible_for_validation,
      });
    }
    return;
  }

  // Late-ACK path — separate immutable row.
  try {
    logger.info('voice_latency.late_playback_ack', {
      sessionId,
      turnId,
      slot_key: ack?.slot
        ? `${ack.slot.field}::${ack.slot.circuit}::${ack.slot.boardId ?? ''}`
        : null,
      source: ack?.source ?? null,
      at_ms: ack?.at_ms ?? null,
      received_at_ms,
      lag_ms: typeof ack?.at_ms === 'number' ? Math.max(0, received_at_ms - ack.at_ms) : null,
    });
  } catch (err) {
    logger.warn('voice_latency.turn_summary_emit_error', {
      stage: 'late_ack',
      error: err?.message || String(err),
    });
  }
}

/**
 * Decrement the expected-ACK count for the turn whose finalizer matches
 * the correlation id. If no finalizer exists yet (typical — fast-TTS
 * endpoint rejects BEFORE runLiveMode has minted a turnId), stash the
 * decrement keyed by correlation id.
 *
 * `startAudioFinalizer` drains stashed decrements at arm time.
 *
 * @param {string} sessionId
 * @param {string} correlationId  the regex_fast_correlation_id from the
 *                                rejected fast-TTS request.
 */
export function decrementExpectedAcksByCorrelation(sessionId, correlationId) {
  if (!sessionId || !correlationId) return;
  // Try the live-finalizer path first.
  for (const [, finalizer] of pendingFinalizers) {
    if (finalizer.sessionId !== sessionId) continue;
    // We don't carry correlation -> turnId index server-side at the
    // finalizer level (correlation -> turnId is in
    // session.fastPathCorrelationIdByTurn). Simpler: every fast-TTS
    // rejection stashes; startAudioFinalizer drains on arm. This keeps
    // the API surface predictable and avoids a per-correlation reverse
    // index here.
    // Falls through to stash path.
    break;
  }
  pendingAckDecrements.set(correlationId, {
    sessionId,
    expires_at_ms: Date.now() + ACK_DECREMENT_TTL_MS,
  });
}

/**
 * Drain pending decrements for the given correlation ids, scoped to one
 * sessionId. Stale entries (>60s) silently dropped. Returns the count
 * applied.
 *
 * Called by `startAudioFinalizer`. Not exported for general use — keep
 * the lifecycle contained.
 */
function consumePendingDecrements(sessionId, correlationIds) {
  if (!correlationIds || correlationIds.size === 0) return 0;
  const now = Date.now();
  let count = 0;
  for (const cid of correlationIds) {
    const entry = pendingAckDecrements.get(cid);
    if (!entry) continue;
    if (entry.sessionId !== sessionId) continue;
    if (entry.expires_at_ms < now) {
      pendingAckDecrements.delete(cid);
      continue;
    }
    count += 1;
    pendingAckDecrements.delete(cid);
  }
  return count;
}

/**
 * Test-only: reset module state. Used by Jest `afterEach`.
 */
export function _resetForTests() {
  for (const [, p] of pendingFinalizers) clearTimeout(p.timer);
  pendingFinalizers.clear();
  pendingAckDecrements.clear();
}

/**
 * Test-only: introspect module state.
 */
export function _peekStateForTests() {
  return {
    pendingFinalizers: pendingFinalizers.size,
    pendingAckDecrements: pendingAckDecrements.size,
  };
}
