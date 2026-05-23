/**
 * Voice-latency telemetry module.
 *
 * Stage 1a commit 1a.1 per PLAN_v3 §4.1. Captures per-correlation
 * span + outcome events for the streaming-TTS path that ships in
 * Stages 2-5. Until a flag enables one of those stages, this module
 * is dormant — nothing reads `recordSpan` / `recordOutcome` outputs.
 *
 * Design contract:
 *
 * - Correlation IDs are minted server-side at the boundary where a
 *   request enters the voice-latency surface (TTS POST handler, future
 *   /api/voice-latency/regex-fast-tts handler, ask_user stream-start).
 *   iOS receives the id in the response header (or WS event) and
 *   echoes it back via `voice_latency_ack` over the existing session
 *   WS.
 * - Spans use monotonic `process.hrtime.bigint()`; never wall-clock.
 *   Cross-host correlation only happens post-hoc in the analyser.
 * - Outcomes split into SERVER (what the server knows it did) and
 *   IOS (what iOS confirmed via ack). The analyser computes aggregate
 *   `fast_heard = server.sent_to_client + iOS.playback_completed`.
 *
 * - `audioSeq` per session: iOS-owned counter that survives WS
 *   reconnect. Server stores it on the suppression reservation record
 *   (Stage 3) and echoes back in response headers.
 *
 * Wire shape (logger.info line): JSON-serialisable so CloudWatch can
 * scrape via the existing JSON layout. One line per recordSpan or
 * recordOutcome call. Analyser stitches by correlation_id.
 *
 * Public API:
 *   mintCorrelationId(sessionId, source) → string
 *   recordSpan(correlationId, hopName, startNs, endNs, meta?)
 *   recordOutcome(correlationId, outcome, opts?)
 *
 * `source` ∈ {'confirmation', 'correction', 'question', 'notification',
 *             'fast_path', 'ask_user_stream'}
 *
 * `hopName` ∈ HOPS (frozen list — additions require an explicit code
 *   review since the analyser hardcodes ordering for waterfall display).
 *
 * `outcome` ∈ SERVER_OUTCOMES ∪ IOS_OUTCOMES.
 */

import logger from '../logger.js';
import crypto from 'node:crypto';

export const HOPS = Object.freeze([
  'utterance_final',
  'regex_match',
  'ios_ws_send',
  'ios_http_post_send',
  'backend_recv',
  'eligibility_decision',
  'suppression_decision',
  'reservation_acquired',
  'vendor_ws_open',
  'vendor_first_audio',
  'vendor_isFinal',
  'ios_first_chunk_recv',
  'ios_first_pcm_frame_scheduled',
  'ios_dataPlayedBack',
  'ios_playback_complete',
]);

export const SERVER_OUTCOMES = Object.freeze([
  'synth_started',
  'synth_first_byte',
  'synth_complete',
  'synth_failed',
  'sent_to_client',
  'cancelled',
  'suppressed_before_synth',
  'suppressed_after_synth',
]);

export const IOS_OUTCOMES = Object.freeze([
  'playback_completed',
  'dropped_stale',
  'dropped_by_correlation_id',
  'dropped_by_kill_switch',
  'playback_failed',
]);

const ALL_OUTCOMES = new Set([...SERVER_OUTCOMES, ...IOS_OUTCOMES]);
const HOP_SET = new Set(HOPS);
const KNOWN_SOURCES = new Set([
  'confirmation',
  'correction',
  'question',
  'notification',
  'fast_path',
  'ask_user_stream',
]);

/**
 * Mint a correlation ID. Format: `vl_<source>_<rand10>` — `vl_` prefix
 * lets CloudWatch filter on a single substring. Random suffix is 80
 * bits of entropy which is plenty for the per-session collision
 * domain.
 */
export function mintCorrelationId(sessionId, source) {
  if (!sessionId) throw new Error('mintCorrelationId: sessionId required');
  if (!KNOWN_SOURCES.has(source)) {
    // Don't throw — accept unknown sources but log a once-per-process
    // warning. The plan can grow new sources; tightening to an enum
    // would force every new source to ship in lockstep here.
    if (!mintCorrelationId._warnedSources) mintCorrelationId._warnedSources = new Set();
    if (!mintCorrelationId._warnedSources.has(source)) {
      mintCorrelationId._warnedSources.add(source);
      logger.warn('voice_latency.unknown_source', { source });
    }
  }
  const rand = crypto.randomBytes(5).toString('hex');
  return `vl_${source}_${rand}`;
}

/**
 * Record a hop. Caller passes pre/post monotonic timestamps from
 * `process.hrtime.bigint()` — the module computes the delta.
 *
 * `meta` is optional free-form context (e.g. `{boardId, circuit, field}`)
 * captured for downstream waterfall correlation. Must be JSON-safe.
 */
export function recordSpan(correlationId, hopName, startNs, endNs, meta = null) {
  if (!correlationId) return;
  if (!HOP_SET.has(hopName)) {
    logger.warn('voice_latency.unknown_hop', { correlationId, hopName });
    return;
  }
  if (typeof startNs !== 'bigint' || typeof endNs !== 'bigint') {
    logger.warn('voice_latency.span_non_bigint', { correlationId, hopName });
    return;
  }
  const durationMs = Number((endNs - startNs) / 1000000n);
  logger.info('voice_latency.span', {
    correlation_id: correlationId,
    hop: hopName,
    duration_ms: durationMs,
    start_ns: startNs.toString(),
    end_ns: endNs.toString(),
    ...(meta ? { meta } : {}),
  });
}

/**
 * Record a terminal outcome.
 *
 * `opts` may include:
 *   audio_seq      — UInt64 iOS-owned counter (Codex v3 NI1).
 *   meta           — JSON-safe context.
 *   acked_by_ios   — server-side outcomes set this when reconciled
 *                    against a `voice_latency_ack` from iOS.
 */
export function recordOutcome(correlationId, outcome, opts = {}) {
  if (!correlationId) return;
  if (!ALL_OUTCOMES.has(outcome)) {
    logger.warn('voice_latency.unknown_outcome', { correlationId, outcome });
    return;
  }
  const { audio_seq = null, meta = null, acked_by_ios = false } = opts;
  logger.info('voice_latency.outcome', {
    correlation_id: correlationId,
    outcome,
    acked_by_ios,
    ...(audio_seq != null ? { audio_seq: String(audio_seq) } : {}),
    ...(meta ? { meta } : {}),
  });
}

/**
 * Convenience: time a function with a named hop. The function is
 * awaited; its return value is returned through. Any throw is
 * re-thrown after recording the span.
 */
export async function withSpan(correlationId, hopName, meta, fn) {
  const start = process.hrtime.bigint();
  try {
    const result = await fn();
    recordSpan(correlationId, hopName, start, process.hrtime.bigint(), meta);
    return result;
  } catch (err) {
    recordSpan(correlationId, hopName, start, process.hrtime.bigint(), {
      ...(meta || {}),
      threw: err?.message || String(err),
    });
    throw err;
  }
}
