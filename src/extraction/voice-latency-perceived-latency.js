/**
 * Voice-latency perceived-latency store.
 *
 * Plan reference: voice-latency-correlation-fix-2026-06-05 Phase 2.3.
 *
 * Pairs `voice_latency.utterance_end` (iOS POST timestamping when the user
 * stopped talking) with the matching turn's `voice_latency.turn_audio_summary`
 * (when audio first played at the iOS speaker) into a single authoritative
 * per-turn perceived-latency row:
 *
 *   logger.info('voice_latency.turn_perceived_latency_ms', { … })
 *
 * The new event name is DISTINCT from the two source events so the
 * CloudWatch Insights dashboard query targets only the canonical per-turn
 * row and is immune to bundler / per-utterance noise.
 *
 * Required for the dashboard query
 *   stats avg(perceived_latency_ms), pct(perceived_latency_ms, 90) by bin(1h)
 * to return real numbers for ≥ 90 % of ACK-eligible turns. Today: 0 %
 * (every utterance_end POST orphans at iOS TTL because the server didn't
 * thread utterance_id back through the extraction envelope — see Phase 2.1
 * commit `fix(voice-latency): thread iOS utterance_id through extraction
 * envelope` for the upstream fix).
 *
 * --- Lifecycle ---
 *
 * Entries are keyed by `${sessionId}::${turnId}`. The two intake hooks
 * (`recordUtteranceEnd`, `recordTurnAudioSummary`) build up the entry over
 * time. Once BOTH halves are present AND the iOS monotonic clock is
 * comparable (matching `process_uptime_id`), the store emits exactly one
 * `voice_latency.turn_perceived_latency_ms` row and removes the entry.
 *
 * Edge cases:
 *
 *   - `process_uptime_id` mismatch: monotonic clock is process-relative,
 *     so a mid-turn iOS process restart invalidates the subtraction. Emit
 *     `voice_latency.turn_perceived_latency_skipped` with
 *     `reason: 'process_uptime_id_mismatch'` so the dashboard can track
 *     restarts separately from binding failures. NEVER emit
 *     `turn_perceived_latency_ms` for these.
 *
 *   - Eligible-but-no-ack (audio summary arrived with zero acks AND
 *     `expected_acks_eligible === 1`): NON-TERMINAL — store until 60 s
 *     TTL. If a late ack arrives via `recordLatePlaybackAck`, merge and
 *     emit. If TTL expires, emit `turn_perceived_latency_skipped` with
 *     `reason: 'no_audio_ack_at_ttl'` so Apple-native-fallback /
 *     missing-ACK failures surface in the dashboard (Phase 2.2 follow-up
 *     work closes those at the iOS emit layer).
 *
 *   - Ineligible (expected_acks_eligible === 0, no ack): silent drop at
 *     TTL. The dashboard correctly does not measure these (chitchat-pause,
 *     no-context turns).
 *
 *   - Ineligible-with-ack (expected_acks_eligible === 0, ack present):
 *     STILL emit `turn_perceived_latency_ms` with `expected_acks_eligible: 0`.
 *     The store passes the flag through; the dashboard makes the cut
 *     explicit via `filter expected_acks_eligible = 1`.
 *
 *   - Late-ack without prior summary (`recordLatePlaybackAck` fires for
 *     a turn that never received a `recordTurnAudioSummary`): emit
 *     `turn_perceived_latency_skipped` with
 *     `reason: 'late_ack_without_summary'`. Vanishingly rare by
 *     construction — `voice-latency-turn-summary.js` always emits the
 *     on-time summary before any late-ack branch can fire.
 *
 *   - TTL cleanup: per-entry 60 s TTL bounds memory. Lazy sweep on
 *     intake when the Map crosses LAZY_SWEEP_THRESHOLD; in steady state
 *     each entry's setTimeout fires its own cleanup.
 *
 * --- Safety properties ---
 *
 * ALL three hooks (`recordUtteranceEnd`, `recordTurnAudioSummary`,
 * `recordLatePlaybackAck`) are no-throw telemetry wrappers. The
 * canonical `voice_latency.utterance_end` / `voice_latency.turn_audio_summary`
 * / `voice_latency.late_playback_ack` rows MUST land in CloudWatch even
 * if this store throws — call sites are required to invoke the hook
 * AFTER their existing canonical `logger.info(...)` so a store bug
 * cannot suppress observability. Internal failures degrade to
 * `logger.warn('voice_latency.perceived_latency_emit_error', …)` and
 * are otherwise silent.
 *
 * --- Why a separate module ---
 *
 * Could be inlined into `voice-latency-turn-summary.js` but kept separate
 * to avoid the ESM circular dependency that would result if this module
 * needed to import the canonical summary emitter. All field derivation
 * (ack source flattening, earliest-monotonic pick) already happens in
 * `voice-latency-turn-summary.js`'s `emitTurnAudioSummary`; the
 * `recordTurnAudioSummary` hook accepts the derived fields as direct
 * arguments rather than recomputing them. The hook is invoked at the
 * END of `emitTurnAudioSummary` (after the canonical row lands) AND at
 * the END of the late-ack branch in `recordPlaybackAck`.
 */

import logger from '../logger.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} PerceivedLatencyEntry
 * @property {string} sessionId
 * @property {string} turnId
 * @property {Object|null} utteranceEnd
 *   { utterance_id, monotonic_at_ms, at_ms, process_uptime_id, source }
 * @property {Object|null} audioSummary
 *   { expected_acks, expected_acks_eligible, audio_finalizer_timeout_fired,
 *     ack_source, ios_playback_ack_at_ms, ios_playback_ack_monotonic_at_ms,
 *     ios_playback_ack_process_uptime_id, ios_playback_ack_correlation_id }
 * @property {ReturnType<typeof setTimeout>|null} ttlTimer
 * @property {number} expires_at_ms
 */

/** @type {Map<string, PerceivedLatencyEntry>} */
const entries = new Map();

/** Per-entry TTL in ms. Well above the 8 s finalizer timeout + the
 *  realistic late-ack grace so eligible-no-ack turns stay queryable. */
const ENTRY_TTL_MS = 60_000;

/** Lazy expiry sweep threshold — sweep expired entries when the Map gets
 *  this big. Avoids per-set scan in the steady state. */
const LAZY_SWEEP_THRESHOLD = 10_000;

function lazyExpirySweep() {
  if (entries.size < LAZY_SWEEP_THRESHOLD) return;
  const now = Date.now();
  for (const [key, entry] of entries) {
    if (entry.expires_at_ms <= now) {
      if (entry.ttlTimer) clearTimeout(entry.ttlTimer);
      entries.delete(key);
    }
  }
}

function entryKey(sessionId, turnId) {
  return `${sessionId}::${turnId}`;
}

function getOrCreateEntry(sessionId, turnId) {
  const key = entryKey(sessionId, turnId);
  let entry = entries.get(key);
  if (entry) return entry;
  entry = {
    sessionId,
    turnId,
    utteranceEnd: null,
    audioSummary: null,
    ttlTimer: null,
    expires_at_ms: Date.now() + ENTRY_TTL_MS,
  };
  entry.ttlTimer = setTimeout(() => {
    const live = entries.get(key);
    if (!live) return;
    entries.delete(key);
    handleTtlExpiry(live);
  }, ENTRY_TTL_MS);
  if (typeof entry.ttlTimer.unref === 'function') entry.ttlTimer.unref();
  entries.set(key, entry);
  lazyExpirySweep();
  return entry;
}

function deleteEntry(sessionId, turnId) {
  const key = entryKey(sessionId, turnId);
  const entry = entries.get(key);
  if (!entry) return;
  if (entry.ttlTimer) clearTimeout(entry.ttlTimer);
  entries.delete(key);
}

// ---------------------------------------------------------------------------
// Emit helpers
// ---------------------------------------------------------------------------

/**
 * Internal: emit the canonical `voice_latency.turn_perceived_latency_ms`
 * row when both halves resolve cleanly.
 */
function emitUnified(entry) {
  try {
    const ue = entry.utteranceEnd;
    const as = entry.audioSummary;
    const perceived_latency_ms =
      typeof as?.ios_playback_ack_monotonic_at_ms === 'number' &&
      typeof ue?.monotonic_at_ms === 'number'
        ? Math.max(0, as.ios_playback_ack_monotonic_at_ms - ue.monotonic_at_ms)
        : null;
    logger.info('voice_latency.turn_perceived_latency_ms', {
      sessionId: entry.sessionId,
      turnId: entry.turnId,
      utterance_id: ue?.utterance_id ?? null,
      perceived_latency_ms,
      utterance_end_at_ms: ue?.at_ms ?? null,
      ios_playback_ack_at_ms: as?.ios_playback_ack_at_ms ?? null,
      ack_source: as?.ack_source ?? null,
      expected_acks_eligible: as?.expected_acks_eligible ?? 0,
    });
  } catch (err) {
    logger.warn('voice_latency.perceived_latency_emit_error', {
      stage: 'unified',
      sessionId: entry?.sessionId,
      turnId: entry?.turnId,
      error: err?.message || String(err),
    });
  }
}

/**
 * Internal: emit the `voice_latency.turn_perceived_latency_skipped` row
 * with a structured `reason` so the dashboard can split
 * pairing-failures from process-restart-clock-resets and from
 * eligible-but-missing-ACK turns (which Phase 2.2 follow-up work needs
 * to surface for triage).
 */
function emitSkipped(entry, reason, extra = {}) {
  try {
    logger.info('voice_latency.turn_perceived_latency_skipped', {
      sessionId: entry.sessionId,
      turnId: entry.turnId,
      utterance_id: entry.utteranceEnd?.utterance_id ?? null,
      reason,
      ...extra,
    });
  } catch (err) {
    logger.warn('voice_latency.perceived_latency_emit_error', {
      stage: 'skipped',
      reason,
      sessionId: entry?.sessionId,
      turnId: entry?.turnId,
      error: err?.message || String(err),
    });
  }
}

/**
 * Internal: TTL-expiry decision tree. Three buckets per plan §2.3
 * lifecycle rules:
 *   - Eligible (expected_acks_eligible === 1) + no ack-side data →
 *     emit `turn_perceived_latency_skipped` with
 *     `reason: 'no_audio_ack_at_ttl'`. Surfaces Apple-native-fallback
 *     turns + any future missing-ACK failure.
 *   - Ineligible (expected_acks_eligible === 0) → silent drop (no
 *     event). The dashboard correctly doesn't measure no-context turns.
 *   - Only one half present → utterance_end-only or audio_summary-only
 *     entry aged out before pairing. Treat audio_summary-only the same
 *     as the eligible-but-no-ack path when eligible=1; treat
 *     utterance_end-only as a binding failure (paired turn never
 *     produced an audio summary at all — Apple-native or extraction-
 *     less question turn).
 */
function handleTtlExpiry(entry) {
  const hasUE = entry.utteranceEnd !== null;
  const hasAS = entry.audioSummary !== null;
  const asAckPresent =
    hasAS &&
    typeof entry.audioSummary?.ack_source === 'string' &&
    entry.audioSummary.ack_source.length > 0;

  if (hasUE && hasAS) {
    // Both halves present but pairing held until TTL. Two reasons it
    // could reach here:
    //   (1) Eligible audio-summary with NO ack (timeout fired, no late
    //       ack arrived) — emit `no_audio_ack_at_ttl` so the dashboard
    //       surfaces the missing-ACK failure. This is the common case
    //       (Apple-native fallback path until Phase 2.2 follow-up
    //       lands).
    //   (2) Ack present BUT process_uptime_id mismatch slipped past
    //       the synchronous maybeFire guard. Vanishingly rare — only
    //       when one side reports `process_uptime_id: null` and the
    //       other reports a string (maybeFire's mismatch check
    //       requires both to be non-empty strings). Emit the
    //       mismatch skip so the dashboard has a row regardless.
    if (!asAckPresent) {
      if (entry.audioSummary?.expected_acks_eligible === 1) {
        emitSkipped(entry, 'no_audio_ack_at_ttl');
      }
      // Ineligible + no ack → silent drop.
      return;
    }
    emitSkipped(entry, 'process_uptime_id_mismatch', {
      utterance_end_process_uptime_id: entry.utteranceEnd?.process_uptime_id ?? null,
      audio_summary_process_uptime_id:
        entry.audioSummary?.ios_playback_ack_process_uptime_id ?? null,
    });
    return;
  }

  if (hasAS && !hasUE) {
    // Audio summary landed but no utterance_end ever paired. If eligible,
    // this is a pairing failure (most likely: question-only turn or
    // extraction-envelope path that did not carry utterance_id — both
    // plan-known limitations). Surface so the dashboard can quantify.
    if (entry.audioSummary?.expected_acks_eligible === 1) {
      emitSkipped(entry, 'no_utterance_end_at_ttl');
    }
    // Ineligible → silent drop.
    return;
  }

  if (hasUE && !hasAS) {
    // utterance_end with no matching audio summary by TTL. The turn
    // either produced no audio (Apple-native fallback that never emits
    // a playback_ack, OR a question-only turn that doesn't have a
    // turn_audio_summary). Treat as the "missing audio ACK" path so
    // the dashboard surfaces it.
    emitSkipped(entry, 'no_audio_ack_at_ttl');
    return;
  }
}

// ---------------------------------------------------------------------------
// Pairing decision — called on every intake to fire the emit ASAP
// ---------------------------------------------------------------------------

/**
 * Internal: invoked at the end of every intake hook. If both halves are
 * present, check process_uptime_id and either emit the unified row or
 * the mismatch skip. Either outcome removes the entry.
 *
 * If the audio summary side is present with eligible=1 AND has a real
 * ack (`ack_source` non-null), but utterance_end is missing, do nothing
 * yet — let the TTL handler decide if it's truly orphaned or if
 * utterance_end is just slightly behind.
 *
 * If audio summary present with eligible=1 AND no ack
 * (`ack_source === null` AND `audio_finalizer_timeout_fired === true`),
 * also wait — late ack may arrive via `recordLatePlaybackAck`.
 */
function maybeFire(entry) {
  const ue = entry.utteranceEnd;
  const as = entry.audioSummary;
  if (!ue || !as) return;

  // Both halves present. The audio summary side may or may not actually
  // carry an ack. If it does NOT and the finalizer timed out, hold and
  // wait for a late ack to arrive (recordLatePlaybackAck will merge it).
  // Eligibility doesn't matter here — the dashboard query filters; the
  // store passes through.
  const ackPresent = typeof as.ack_source === 'string' && as.ack_source.length > 0;
  if (!ackPresent) {
    // eligible-but-no-ack: keep entry alive for late-ack merge.
    return;
  }

  // Process-uptime guard. Both stamps must be from the SAME iOS process
  // for the monotonic subtraction to mean anything.
  const ueUid = ue.process_uptime_id ?? null;
  const asUid = as.ios_playback_ack_process_uptime_id ?? null;
  if (
    typeof ueUid === 'string' &&
    typeof asUid === 'string' &&
    ueUid.length > 0 &&
    asUid.length > 0 &&
    ueUid !== asUid
  ) {
    emitSkipped(entry, 'process_uptime_id_mismatch', {
      utterance_end_process_uptime_id: ueUid,
      audio_summary_process_uptime_id: asUid,
    });
    deleteEntry(entry.sessionId, entry.turnId);
    return;
  }

  emitUnified(entry);
  deleteEntry(entry.sessionId, entry.turnId);
}

// ---------------------------------------------------------------------------
// Public intake hooks
// ---------------------------------------------------------------------------

/**
 * Intake hook invoked from `src/routes/voice-latency-utterance-end.js`
 * AFTER the canonical `logger.info('voice_latency.utterance_end', …)`
 * row has landed. Skips when the iOS POST is `orphaned: true` (no
 * turnId binding yet) — those rows never become part of a
 * perceived-latency measurement.
 *
 * Telemetry-only, no-throw — any internal failure logs
 * `voice_latency.perceived_latency_emit_error` and returns without
 * disturbing the route's 204 response.
 */
export function recordUtteranceEnd(payload) {
  try {
    if (!payload || typeof payload !== 'object') return;
    if (payload.orphaned === true) return;
    if (typeof payload.sessionId !== 'string' || !payload.sessionId) return;
    if (typeof payload.turnId !== 'string' || !payload.turnId) return;

    const entry = getOrCreateEntry(payload.sessionId, payload.turnId);
    entry.utteranceEnd = {
      utterance_id: typeof payload.utterance_id === 'string' ? payload.utterance_id : null,
      monotonic_at_ms: typeof payload.monotonic_at_ms === 'number' ? payload.monotonic_at_ms : null,
      at_ms: typeof payload.at_ms === 'number' ? payload.at_ms : null,
      process_uptime_id:
        typeof payload.process_uptime_id === 'string' ? payload.process_uptime_id : null,
      source: typeof payload.source === 'string' ? payload.source : null,
    };
    maybeFire(entry);
  } catch (err) {
    logger.warn('voice_latency.perceived_latency_emit_error', {
      stage: 'record_utterance_end',
      sessionId: payload?.sessionId,
      turnId: payload?.turnId,
      error: err?.message || String(err),
    });
  }
}

/**
 * Intake hook invoked from
 * `voice-latency-turn-summary.js:emitTurnAudioSummary` AFTER the
 * canonical `logger.info('voice_latency.turn_audio_summary', enriched)`
 * row has landed. The caller passes already-derived fields off the
 * `enriched` object — this module never recomputes `earliestAck` or
 * imports from `voice-latency-turn-summary.js` (avoids ESM circular
 * dependency).
 *
 * Telemetry-only, no-throw.
 */
export function recordTurnAudioSummary(payload) {
  try {
    if (!payload || typeof payload !== 'object') return;
    if (typeof payload.sessionId !== 'string' || !payload.sessionId) return;
    if (typeof payload.turnId !== 'string' || !payload.turnId) return;

    const entry = getOrCreateEntry(payload.sessionId, payload.turnId);
    entry.audioSummary = {
      expected_acks: typeof payload.expected_acks === 'number' ? payload.expected_acks : 0,
      expected_acks_eligible:
        payload.expected_acks_eligible === 1 || payload.expected_acks_eligible === true ? 1 : 0,
      audio_finalizer_timeout_fired: payload.audio_finalizer_timeout_fired === true,
      ack_source: typeof payload.ack_source === 'string' ? payload.ack_source : null,
      ios_playback_ack_at_ms:
        typeof payload.ios_playback_ack_at_ms === 'number' ? payload.ios_playback_ack_at_ms : null,
      ios_playback_ack_monotonic_at_ms:
        typeof payload.ios_playback_ack_monotonic_at_ms === 'number'
          ? payload.ios_playback_ack_monotonic_at_ms
          : null,
      ios_playback_ack_process_uptime_id:
        typeof payload.ios_playback_ack_process_uptime_id === 'string'
          ? payload.ios_playback_ack_process_uptime_id
          : null,
      ios_playback_ack_correlation_id:
        typeof payload.ios_playback_ack_correlation_id === 'string'
          ? payload.ios_playback_ack_correlation_id
          : null,
    };
    maybeFire(entry);
  } catch (err) {
    logger.warn('voice_latency.perceived_latency_emit_error', {
      stage: 'record_turn_audio_summary',
      sessionId: payload?.sessionId,
      turnId: payload?.turnId,
      error: err?.message || String(err),
    });
  }
}

/**
 * Intake hook invoked from the LATE-ACK branch of
 * `voice-latency-turn-summary.js:recordPlaybackAck` AFTER the canonical
 * `logger.info('voice_latency.late_playback_ack', …)` row has landed.
 *
 * Semantics:
 *   - When a prior `recordTurnAudioSummary` entry exists for this
 *     `{sessionId, turnId}`, merge the late ack onto its audio side
 *     (preserving the original `expected_acks` / `expected_acks_eligible`
 *     — the late ack ONLY contributes the ack-source fields) and call
 *     `maybeFire` to emit `voice_latency.turn_perceived_latency_ms`.
 *   - When no prior entry exists, emit
 *     `voice_latency.turn_perceived_latency_skipped` with
 *     `reason: 'late_ack_without_summary'`. This should be vanishingly
 *     rare (the on-time `emitTurnAudioSummary` always runs first by
 *     construction in `voice-latency-turn-summary.js`'s finalizer
 *     code) and is logged as a diagnostic.
 *
 * Telemetry-only, no-throw.
 */
export function recordLatePlaybackAck(payload) {
  try {
    if (!payload || typeof payload !== 'object') return;
    if (typeof payload.sessionId !== 'string' || !payload.sessionId) return;
    if (typeof payload.turnId !== 'string' || !payload.turnId) return;

    const key = entryKey(payload.sessionId, payload.turnId);
    const existing = entries.get(key);
    if (!existing || !existing.audioSummary) {
      // No prior audio summary → emit the diagnostic skip and bail.
      // Construct an ephemeral entry just for the emit metadata; do NOT
      // store it (nothing to merge into).
      emitSkipped(
        { sessionId: payload.sessionId, turnId: payload.turnId, utteranceEnd: null },
        'late_ack_without_summary'
      );
      return;
    }

    // Merge — replace ONLY the ack-source fields, preserving the original
    // expected_acks / expected_acks_eligible / audio_finalizer_timeout_fired
    // from the on-time emit. This is correct semantically: the late ack
    // tells us "the ack did eventually arrive, here's its real source
    // and timestamps", but doesn't change what the bundler/finalizer
    // expected.
    existing.audioSummary.ack_source =
      typeof payload.ack_source === 'string'
        ? payload.ack_source
        : existing.audioSummary.ack_source;
    existing.audioSummary.ios_playback_ack_at_ms =
      typeof payload.ios_playback_ack_at_ms === 'number'
        ? payload.ios_playback_ack_at_ms
        : existing.audioSummary.ios_playback_ack_at_ms;
    existing.audioSummary.ios_playback_ack_monotonic_at_ms =
      typeof payload.ios_playback_ack_monotonic_at_ms === 'number'
        ? payload.ios_playback_ack_monotonic_at_ms
        : existing.audioSummary.ios_playback_ack_monotonic_at_ms;
    existing.audioSummary.ios_playback_ack_process_uptime_id =
      typeof payload.ios_playback_ack_process_uptime_id === 'string'
        ? payload.ios_playback_ack_process_uptime_id
        : existing.audioSummary.ios_playback_ack_process_uptime_id;
    existing.audioSummary.ios_playback_ack_correlation_id =
      typeof payload.ios_playback_ack_correlation_id === 'string'
        ? payload.ios_playback_ack_correlation_id
        : existing.audioSummary.ios_playback_ack_correlation_id;

    maybeFire(existing);
  } catch (err) {
    logger.warn('voice_latency.perceived_latency_emit_error', {
      stage: 'record_late_playback_ack',
      sessionId: payload?.sessionId,
      turnId: payload?.turnId,
      error: err?.message || String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Test-only helpers
// ---------------------------------------------------------------------------

/**
 * Test helper: clear all in-memory state. Production code never calls
 * this. Exposed so the test suite can isolate cases without bleed-over.
 */
export function _resetPerceivedLatencyStoreForTests() {
  for (const entry of entries.values()) {
    if (entry.ttlTimer) clearTimeout(entry.ttlTimer);
  }
  entries.clear();
}

/**
 * Test helper: force a TTL expiry for a specific `{sessionId, turnId}`
 * synchronously, instead of waiting 60 s. Production code never calls
 * this.
 */
export function _forceTtlExpiryForTests(sessionId, turnId) {
  const key = entryKey(sessionId, turnId);
  const entry = entries.get(key);
  if (!entry) return;
  if (entry.ttlTimer) clearTimeout(entry.ttlTimer);
  entries.delete(key);
  handleTtlExpiry(entry);
}

/**
 * Test helper: peek at the current in-memory entry count. Production
 * code never calls this.
 */
export function _peekEntryCountForTests() {
  return entries.size;
}
