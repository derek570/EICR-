/**
 * Voice-latency playback-ack endpoint.
 *
 * POST /api/voice-latency/playback-ack
 *
 * iOS POSTs this when an AVAudioPlayer for a confirmation slot has started
 * playing — used by Phase 0's turn_audio_summary delayed finalizer to know
 * when all expected audio has actually reached the user, vs. a server-side
 * synth-completion ACK that says nothing about iOS playback success.
 *
 * Body schema (voice-latency plan 2026-06-03 Tier 1.3 consolidated):
 *   {
 *     sessionId: string,                            // must match an active session
 *     turnId: string,                               // required EXCEPT when source==fast_tts
 *                                                   // AND correlation_id present (the
 *                                                   // fast-path correlation contract
 *                                                   // decouples ACK arrival from server-
 *                                                   // minted turnId timing)
 *     slot: {                                       // optional, but recommended for log correlation
 *       field: string,
 *       circuit: integer >= 0 && <= 99,
 *       boardId: string | null,
 *     },
 *     source: 'fast_tts' | 'bundler' | 'local_fallback',
 *     at_ms: number > 0,                            // iOS-side wall-clock of playback start
 *
 *     // Voice-latency plan 2026-06-03 Tier 1.3 additions — all OPTIONAL for
 *     // back-compat with pre-Tier-1.3 iOS builds during partial TestFlight
 *     // rollout. Turns without these fields fall through to the legacy
 *     // wall-clock dashboard math (less accurate but not broken).
 *     monotonic_at_ms?: number > 0,                 // iOS CACurrentMediaTime() * 1000
 *     process_uptime_id?: string,                   // ties monotonic to one iOS process
 *     correlation_id?: string,                      // fast-path correlation key — resolves
 *                                                   // ACK to a turn via correlationToTurn
 *                                                   // when turnId is unknown at ACK time
 *   }
 *
 * Returns:
 *   204 No Content   — for both on-time and late ACKs (iOS does not distinguish)
 *   400              — malformed body
 *   401              — auth.requireAuth failure
 *   503              — kill switch active
 *
 * Per PLAN_v8 §A, also closes Codex round-3 B1 + Claude round-4 I4.
 */

import { Router } from 'express';
import * as auth from '../auth.js';
import logger from '../logger.js';
import { recordPlaybackAck } from '../extraction/voice-latency-turn-summary.js';
import { isKillSwitchActive } from '../extraction/voice-latency-config.js';

const router = Router();

const SOURCE_ENUM = new Set(['fast_tts', 'bundler', 'local_fallback']);

function validateBody(body) {
  if (!body || typeof body !== 'object') return 'body required';
  if (typeof body.sessionId !== 'string' || !body.sessionId) return 'sessionId required';
  if (typeof body.source !== 'string' || !SOURCE_ENUM.has(body.source)) return 'source invalid';

  // Voice-latency plan 2026-06-03 Tier 1.3 fast-path correlation rule:
  // turnId is REQUIRED for bundler / local_fallback; allowed empty when
  // source === 'fast_tts' AND a non-empty correlation_id is present
  // (the backend resolves to a turn via voice-latency-turn-summary's
  // correlationToTurn index). This decouples ACK arrival from server-minted
  // turnId timing — fast-path ACKs can fire BEFORE runLiveMode has minted
  // the turn.
  const hasFastPathCorrelation =
    body.source === 'fast_tts' &&
    typeof body.correlation_id === 'string' &&
    body.correlation_id.length > 0;
  if (!hasFastPathCorrelation) {
    if (typeof body.turnId !== 'string' || !body.turnId) return 'turnId required';
  } else if (body.turnId !== undefined && typeof body.turnId !== 'string') {
    return 'turnId invalid';
  }

  if (typeof body.at_ms !== 'number' || !Number.isFinite(body.at_ms) || body.at_ms <= 0) {
    return 'at_ms invalid';
  }
  // at_ms must be within ~1s of NOW (defense against bogus values; iOS NSDate may
  // skew slightly from server clock but ~1s slack is generous).
  if (body.at_ms > Date.now() + 1000) return 'at_ms in future';

  if (body.slot !== undefined && body.slot !== null) {
    if (typeof body.slot !== 'object') return 'slot must be object';
    if (typeof body.slot.field !== 'string' || !body.slot.field) return 'slot.field required';
    if (
      typeof body.slot.circuit !== 'number' ||
      !Number.isInteger(body.slot.circuit) ||
      body.slot.circuit < 0 ||
      body.slot.circuit > 99
    ) {
      return 'slot.circuit invalid';
    }
    if (
      body.slot.boardId !== null &&
      body.slot.boardId !== undefined &&
      typeof body.slot.boardId !== 'string'
    ) {
      return 'slot.boardId invalid';
    }
  }

  // Voice-latency plan 2026-06-03 Tier 1.3 optional fields. All optional
  // for partial-rollout back-compat.
  if (body.monotonic_at_ms !== undefined && body.monotonic_at_ms !== null) {
    if (
      typeof body.monotonic_at_ms !== 'number' ||
      !Number.isFinite(body.monotonic_at_ms) ||
      body.monotonic_at_ms <= 0
    ) {
      return 'monotonic_at_ms invalid';
    }
    // NO future-clock check — monotonic is not comparable to Date.now().
  }
  if (body.process_uptime_id !== undefined && typeof body.process_uptime_id !== 'string') {
    return 'process_uptime_id invalid';
  }
  if (body.correlation_id !== undefined && typeof body.correlation_id !== 'string') {
    return 'correlation_id invalid';
  }

  return null;
}

router.post('/voice-latency/playback-ack', auth.requireAuth, async (req, res) => {
  if (isKillSwitchActive()) {
    return res.status(503).json({ error: 'kill switch active' });
  }

  const err = validateBody(req.body);
  if (err) {
    return res.status(400).json({ error: err });
  }

  const {
    sessionId,
    turnId,
    slot,
    source,
    at_ms,
    monotonic_at_ms,
    process_uptime_id,
    correlation_id,
  } = req.body;
  try {
    recordPlaybackAck(sessionId, turnId ?? '', {
      slot: slot ?? null,
      source,
      at_ms,
      // Voice-latency plan 2026-06-03 Tier 1.3: forward optional fields
      // through; recordPlaybackAck spreads them onto received_acks so the
      // eventual turn_audio_summary row carries them (and the on-time emit
      // / late-ACK row variants below flatten the earliest-monotonic ACK
      // onto top-level row fields per the §CloudWatch query contract).
      monotonic_at_ms: monotonic_at_ms ?? null,
      process_uptime_id: process_uptime_id ?? null,
      correlation_id: correlation_id ?? null,
    });
  } catch (errInner) {
    logger.warn('voice_latency.playback_ack_emit_error', {
      sessionId,
      turnId,
      error: errInner?.message || String(errInner),
    });
    // Still 204 — telemetry failure must not surface to the client. The
    // ACK is fire-and-forget from iOS's perspective.
  }
  return res.status(204).end();
});

export default router;
