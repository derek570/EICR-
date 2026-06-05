/**
 * Voice-latency utterance-end endpoint.
 *
 * POST /api/voice-latency/utterance-end
 *
 * iOS POSTs this when the Deepgram speech-final / utterance-end event
 * fires on a transcript, paired with the matching extraction's turnId via
 * a two-stage utterance↔turn correlation (utterance_id minted on iOS,
 * echoed by sonnet-stream.js back through the extraction result).
 *
 * Used by the §CloudWatch perceived-latency dashboard as the "user
 * stopped talking" timestamp — paired against the playback-ack
 * `monotonic_at_ms` ("audio first frame at speaker") to compute
 * end-of-utterance → first-audible-byte on a single iOS monotonic clock.
 *
 * Body schema (voice-latency plan 2026-06-03 Tier 1.3):
 *   {
 *     sessionId: string,                              // always required
 *     turnId: string | null,                          // required when orphaned !== true
 *     utterance_id: string,                           // join key; always required
 *     source:                                         // always required
 *       'deepgram_speech_final' | 'deepgram_utterance_end' | 'silero_vad',
 *     at_ms: number,                                  // iOS wall-clock (NSDate)
 *     monotonic_at_ms: number | null,                 // iOS CACurrentMediaTime() * 1000 — see plan
 *                                                     // for Option-A Deepgram stream-anchor; null
 *                                                     // when anchor unavailable (skip sentinel)
 *     process_uptime_id: string,                      // required — ties monotonic stamps to
 *                                                     // one iOS process lifetime
 *     orphaned: boolean | null,                       // optional; true when iOS pending TTL fired
 *   }
 *
 * Returns:
 *   204 No Content   — for valid posts (both real + orphaned)
 *   400              — malformed body
 *   401              — auth.requireAuth failure
 *   503              — kill switch active
 *
 * Emits `voice_latency.utterance_end` log row with the body, plus
 * namespaced `utterance_end_monotonic_at_ms` and `utterance_end_process_uptime_id`
 * fields so the §CloudWatch dashboard query can `latest(...)` them
 * unambiguously when the multi-message filter also touches playback-ack
 * rows that carry a bare `monotonic_at_ms` field.
 */

import { Router } from 'express';
import * as auth from '../auth.js';
import logger from '../logger.js';
import { isKillSwitchActive } from '../extraction/voice-latency-config.js';
import { recordUtteranceEnd } from '../extraction/voice-latency-perceived-latency.js';

const router = Router();

const SOURCE_ENUM = new Set(['deepgram_speech_final', 'deepgram_utterance_end', 'silero_vad']);

function validateBody(body) {
  if (!body || typeof body !== 'object') return 'body required';
  if (typeof body.sessionId !== 'string' || !body.sessionId) return 'sessionId required';

  // turnId conditional: required when orphaned !== true; null/absent allowed
  // when orphaned === true (the iOS TTL-sweep path posts before an extraction
  // has bound utterance_id to turnId).
  const isOrphaned = body.orphaned === true;
  if (!isOrphaned) {
    if (typeof body.turnId !== 'string' || !body.turnId) return 'turnId required';
  } else if (body.turnId !== undefined && body.turnId !== null && typeof body.turnId !== 'string') {
    return 'turnId invalid';
  }

  if (typeof body.utterance_id !== 'string' || !body.utterance_id) return 'utterance_id required';
  if (typeof body.source !== 'string' || !SOURCE_ENUM.has(body.source)) return 'source invalid';
  if (typeof body.at_ms !== 'number' || !Number.isFinite(body.at_ms) || body.at_ms <= 0) {
    return 'at_ms invalid';
  }
  // Mirror voice-latency-playback-ack.js:53 — defense against bogus wall-clock values.
  if (body.at_ms > Date.now() + 1000) return 'at_ms in future';

  // monotonic_at_ms: optional; null is the skip-sentinel iOS sends when the
  // Deepgram stream-anchor wasn't available (e.g. across a doze reset).
  // No future-clock check — monotonic values aren't comparable to Date.now().
  if (body.monotonic_at_ms !== undefined && body.monotonic_at_ms !== null) {
    if (
      typeof body.monotonic_at_ms !== 'number' ||
      !Number.isFinite(body.monotonic_at_ms) ||
      body.monotonic_at_ms <= 0
    ) {
      return 'monotonic_at_ms invalid';
    }
  }

  if (typeof body.process_uptime_id !== 'string' || !body.process_uptime_id) {
    return 'process_uptime_id required';
  }

  if (body.orphaned !== undefined && body.orphaned !== null && typeof body.orphaned !== 'boolean') {
    return 'orphaned invalid';
  }

  return null;
}

router.post('/voice-latency/utterance-end', auth.requireAuth, async (req, res) => {
  if (isKillSwitchActive()) {
    return res.status(503).json({ error: 'kill switch active' });
  }

  const err = validateBody(req.body);
  if (err) {
    return res.status(400).json({ error: err });
  }

  try {
    // Namespace the monotonic fields on the LOG row (not the wire body) so
    // the §CloudWatch dashboard's `latest(utterance_end_monotonic_at_ms)`
    // aggregation is unambiguous even when the multi-message filter touches
    // playback-ack rows that have a bare `monotonic_at_ms` field. The
    // §CloudWatch dashboard query consumes the field by this exact name.
    logger.info('voice_latency.utterance_end', {
      ...req.body,
      utterance_end_monotonic_at_ms: req.body.monotonic_at_ms ?? null,
      utterance_end_process_uptime_id: req.body.process_uptime_id,
    });
    // Voice-latency plan 2026-06-05 Phase 2.3 — feed the
    // perceived-latency store. Wrapped in its own try/catch internally;
    // ordered AFTER the canonical logger.info so a store throw cannot
    // suppress the CloudWatch row. Skips orphans + missing turnId
    // internally.
    try {
      recordUtteranceEnd(req.body);
    } catch (storeErr) {
      logger.warn('voice_latency.perceived_latency_emit_error', {
        stage: 'utterance_end_route',
        sessionId: req.body?.sessionId,
        turnId: req.body?.turnId,
        error: storeErr?.message || String(storeErr),
      });
    }
  } catch (errInner) {
    logger.warn('voice_latency.utterance_end_emit_error', {
      sessionId: req.body?.sessionId,
      turnId: req.body?.turnId,
      utterance_id: req.body?.utterance_id,
      error: errInner?.message || String(errInner),
    });
    // Still 204 — telemetry failure must not surface to the client. The
    // POST is fire-and-forget from iOS's perspective (mirrors playback-ack).
  }

  return res.status(204).end();
});

export default router;
