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
 *     audio_source?: 'loaded_barrel_hit' | 'loaded_barrel_hit_pending' |
 *                    'loaded_barrel_hit_late' | 'confirmation' |
 *                    'legacy_confirmation',                  // origin of bytes
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
import { recordPlaybackAck as productionRecordPlaybackAck } from '../extraction/voice-latency-turn-summary.js';
import { isKillSwitchActive } from '../extraction/voice-latency-config.js';
import { recordOutcome as productionRecordOutcome } from '../extraction/voice-latency-telemetry.js';
// Plan 00B-2 C2.6 — active-entry resolution for the proven-owner-mismatch
// check + the evaluation-only ledger forwarding hook.
import { getActiveSessionEntry as productionGetActiveSessionEntry } from '../extraction/active-sessions.js';
import { EVALUATION_CONTEXT } from '../extraction/plan00-lifecycle-hooks.js';
// Plan B (feedback ids 118/119) B3.1 — additive fast-attempt ledger mark.
// This is a SECOND, independent no-throw side effect beside the existing
// `recordOutcome` telemetry call below (same defensive shape: a ledger-mark
// failure must never affect the 204 response or the telemetry row).
import { markFastAttemptPlaybackStarted } from '../extraction/fast-path-accepted-identity.js';

const SOURCE_ENUM = new Set(['fast_tts', 'bundler', 'local_fallback']);
const AUDIO_SOURCE_ENUM = new Set([
  'loaded_barrel_hit',
  'loaded_barrel_hit_pending',
  'loaded_barrel_hit_late',
  'confirmation',
  'legacy_confirmation',
]);

function validateBody(body) {
  if (!body || typeof body !== 'object') return 'body required';
  if (typeof body.sessionId !== 'string' || !body.sessionId) return 'sessionId required';
  if (typeof body.source !== 'string' || !SOURCE_ENUM.has(body.source)) return 'source invalid';

  // Correlation rule: turnId is REQUIRED unless a non-empty correlation_id
  // is present, in which case it may be empty/absent for ANY source.
  //
  // Originally (voice-latency plan 2026-06-03 Tier 1.3) this exemption was
  // additionally gated on `source === 'fast_tts'`, because the regex fast
  // path was then the only known producer of a turnId-less ACK — its POST
  // can fire BEFORE runLiveMode has minted the turn.
  //
  // ASK-PATH TTS is a second such producer, and the narrow gate made it
  // invisible. Questions synthesised through the /api/keys ElevenLabs proxy
  // play via AlertManager's direct AVAudioPlayer branch, which has no
  // `loadedBarrelContext` and therefore no turnId — but the response DOES
  // carry X-Voice-Latency-Correlation-Id. Under the old predicate those
  // clips could only ever 400, so every question the inspector actually
  // heard was absent from the audibility ledger: a clip that plays and a
  // clip that never synthesises looked identical server-side. That is the
  // exact ambiguity the audio-first invariants are measured against, so the
  // blind spot mattered more than the missing turn attribution.
  //
  // Widening is safe because correlation_id — not turnId — is the key the
  // handler below actually resolves on: `recordOutcome(correlation_id,
  // 'playback_started', …)` needs no turn at all, and `recordPlaybackAck`
  // already normalises a missing turnId to '' on every path. The validator
  // was strictly stricter than the code behind it.
  //
  // Deliberate consequence, NOT an oversight: these ACKs reach the
  // correlation ledger only, not turn_audio_summary. `recordPlaybackAck`
  // early-returns on an unresolvable turnId, and no index can resolve one
  // here — correlationToTurn is populated solely from the regex fast path's
  // `fastPathCorrelationIdByTurn`, which never contains a keys.js-minted
  // `vl_confirmation_*` id. Do not "fix" that by widening
  // isFastPathWithCorrelation; the lookup would simply miss.
  const hasCorrelationId =
    typeof body.correlation_id === 'string' && body.correlation_id.length > 0;
  if (!hasCorrelationId) {
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
  if (
    body.audio_source !== undefined &&
    (typeof body.audio_source !== 'string' || !AUDIO_SOURCE_ENUM.has(body.audio_source))
  ) {
    return 'audio_source invalid';
  }

  return null;
}

/**
 * Plan 00B-2 C4 — the router is an EXPORTED FACTORY whose dependencies
 * default to the production implementations (the default export below is
 * created from those defaults — production byte-identical). The mock lane
 * mounts this factory in a minimal express app with a strict offline auth
 * middleware so the route's validation and owner check run UNMODIFIED with
 * ZERO database access.
 */
export function createPlaybackAckRouter({
  requireAuth = auth.requireAuth,
  getActiveSessionEntry = productionGetActiveSessionEntry,
  recordPlaybackAck = productionRecordPlaybackAck,
  recordOutcome = productionRecordOutcome,
} = {}) {
  const router = Router();

  router.post('/voice-latency/playback-ack', requireAuth, async (req, res) => {
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
      audio_source,
    } = req.body;
    // Plan 00B-2 C2.6 — owner check scoped to PROVEN mismatch only: entry
    // present + a DIFFERENT authenticated user → the indistinguishable 404
    // (reveals nothing about session existence). Entry-absent keeps today's
    // production behaviour — the ACK stays telemetry-only.
    const ownerEntry = getActiveSessionEntry(sessionId);
    if (ownerEntry && req.user?.id !== undefined && ownerEntry.userId !== req.user.id) {
      return res.status(404).end();
    }
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
        // Additive byte-origin label. `source` remains the established
        // playback delivery path (`bundler` for queued confirmations), so
        // existing dashboards keep their buckets while Loaded Barrel can
        // be split from canonical fallback audio.
        audio_source: audio_source ?? null,
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
    // Direct PII-safe correlation ledger: the same correlation id used by
    // speculative/canonical synthesis now gains an iOS-confirmed audible
    // start. This is deliberately a second no-throw telemetry branch so a
    // turn-summary failure cannot erase the evidence that playback began.
    try {
      if (correlation_id) {
        recordOutcome(correlation_id, 'playback_started', {
          acked_by_ios: true,
          meta: {
            sessionId,
            turnId: turnId || null,
            source,
            audio_source: audio_source ?? null,
            field: slot?.field ?? null,
            circuit: slot?.circuit ?? null,
            boardId: slot?.boardId ?? null,
          },
        });
      }
    } catch (outcomeErr) {
      logger.warn('voice_latency.playback_ack_outcome_error', {
        sessionId,
        turnId,
        error: outcomeErr?.message || String(outcomeErr),
      });
    }
    // Plan B B3.1 — mark the fast-attempt ledger 'playback_started'. Gated on
    // `source === 'fast_tts'` (mirrors `recordPlaybackAck`'s own
    // `isFastPathWithCorrelation` check) so an ask-path TTS ack carrying an
    // unrelated correlation_id can never mutate a fast-attempt record it
    // doesn't own — `markFastAttemptPlaybackStarted` is a no-op for a
    // correlation id this module never saw `markFastAttemptPending` for, but
    // the source gate keeps the call itself semantically scoped.
    try {
      if (source === 'fast_tts' && correlation_id) {
        markFastAttemptPlaybackStarted(sessionId, correlation_id);
      }
    } catch (ledgerErr) {
      logger.warn('voice_latency.fast_attempt_ledger_error', {
        sessionId,
        turnId,
        stage: 'playback_started',
        error: ledgerErr?.message || String(ledgerErr),
      });
    }
    // Plan 00B-2 C2.6 — evaluation-only ledger forwarding (dormant Symbol
    // lookup). A `fast_tts` ACK stages beside its correlation reservation; an
    // ordinary ACK becomes a playback_start ONLY when its slot resolves to
    // EXACTLY ONE delivered audibility unit — everything else stays
    // telemetry (zero/ambiguous matches are the judge's missing-playback
    // negatives, never guessed here).
    try {
      const evalCtx = ownerEntry?.[EVALUATION_CONTEXT] ?? null;
      if (evalCtx) {
        if (source === 'fast_tts' && correlation_id) {
          evalCtx.stageFastPlaybackAck?.({ correlationId: correlation_id, ackBody: req.body });
        } else {
          evalCtx.resolvePlaybackFromSlot?.({
            slot: slot ?? null,
            ackBody: req.body,
            source,
            // Codex r2 finding 7 — the validated wire turn id binds the ACK
            // to its own turn's delivery row (turn-agnostic when absent).
            turnId: typeof req.body?.turnId === 'string' ? req.body.turnId : null,
          });
        }
      }
    } catch (_evalErr) {
      // Evaluation capture is behaviour-isolated — never surfaces to iOS.
    }
    return res.status(204).end();
  });

  return router;
}

const router = createPlaybackAckRouter();

export default router;
