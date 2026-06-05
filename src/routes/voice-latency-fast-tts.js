/**
 * Mode-A fast-path TTS endpoint.
 *
 * POST /api/voice-latency/regex-fast-tts
 *
 * iOS posts here the moment its TranscriptFieldMatcher regex-extracts
 * an eligible numeric reading (measured_zs_ohm, r1_r2_ohm, ir_live_*,
 * number_of_points — see `regex-fast-eligibility.js`). The backend
 * composes the confirmation, streams ElevenLabs MP3 back, and writes
 * the slot into the active-sessions entry's pendingFastTtsSlots map so
 * the Loaded Barrel speculator's preflight skip check kicks in BEFORE
 * any speculation cost is incurred for the same slot in the matching
 * turn.
 *
 * Single-round latency sprint Phase 1 (PLAN_v8 §A Pivots 2, 4, 5, 9, 11,
 * 12.2). The plan converged after 8 rounds of review; the structural
 * guarantees this route enforces are:
 *
 *   - Eligibility: hard whitelist (regex-fast-eligibility.js). 422 on
 *     any other field. Pre-Pivot-2 the route gladly synthesised
 *     whatever you sent; now non-numeric / non-circuit-ref fields
 *     return without spending an ElevenLabs character.
 *
 *   - Capability gate (Pivot 4): hasRegexFastV2 — NOT hasStreamingHttpAudio.
 *     The v2 marker means iOS implements `playFastPathAudio` (bypasses
 *     shouldDeferPlayback) + posts /playback-ack + does NOT fall back
 *     to native TTS on 4xx. Older clients (hasStreamingHttpAudio but
 *     not hasRegexFastV2) get 412.
 *
 *   - No-native-fallback contract (Pivot 5): on 4xx / 503 / 502 the iOS
 *     client MUST silently abandon. Speaking a value the backend just
 *     rejected is unsafe. We document this in the route response body
 *     so a future iOS implementer can't accidentally re-introduce the
 *     fallback.
 *
 *   - Client-minted correlationId (Pivot 6): iOS mints a UUIDv4
 *     client-side and posts it in the body. The backend doesn't mint
 *     here — the same correlationId rides through to the turn_audio_summary
 *     finalizer via session.fastPathCorrelationIdByTurn. If we 4xx
 *     before the turn-id is known, decrementExpectedAcksByCorrelation
 *     stashes the decrement so the finalizer's expected-ACK count
 *     gets corrected when runLiveMode arms it for this turn.
 *
 *   - Speculator preflight integration (Pivot 9 + 11): on accept, write
 *     the slot into entry.pendingFastTtsSlots.get(turnId) AND call
 *     speculator.abortBySlot to cancel any in-flight speculation for
 *     the same slot. Skips a wasted ElevenLabs spend for the
 *     1-2 second window the speculator might otherwise race the
 *     fast-path.
 *
 *   - MP3 output forced (Pivot 7): mp3_22050_32 ONLY. iOS Builds with
 *     regex_fast_v2 use AVAudioPlayer which handles MP3 natively; PCM
 *     would require manual framing on iOS and we don't ship that.
 *
 *   - confirmation-text canonical (Pivot 3): the FRIENDLY-name table
 *     used to be duplicated here. Now we import buildConfirmationText
 *     from confirmation-text.js so the route, the bundler, and the
 *     speculator all produce byte-identical text for the same input.
 */

import { Router } from 'express';
import * as auth from '../auth.js';
import { getElevenLabsKey } from '../services/secrets.js';
import logger from '../logger.js';
import { buildConfirmationText } from '../extraction/confirmation-text.js';
import { isRegexFastEligible } from '../extraction/regex-fast-eligibility.js';
import { getActiveSessionEntry, getVoiceLatencyForSession } from '../extraction/active-sessions.js';
import { isKillSwitchActive } from '../extraction/voice-latency-config.js';
import { decrementExpectedAcksByCorrelation } from '../extraction/voice-latency-turn-summary.js';

const router = Router();
const FORCED_OUTPUT_FORMAT = 'mp3_22050_32';

/**
 * Validate the request body. Returns null on success, an error string
 * on failure. Strict — the iOS client mints these to a defined schema;
 * tolerate-and-coerce would invite drift.
 */
function validateBody(body) {
  if (!body || typeof body !== 'object') return 'body required';
  if (typeof body.sessionId !== 'string' || !body.sessionId) return 'sessionId required';
  if (typeof body.turnId !== 'string' || !body.turnId) return 'turnId required';
  if (typeof body.correlationId !== 'string' || !body.correlationId) {
    return 'correlationId required';
  }
  const c = body.candidate;
  if (!c || typeof c !== 'object') return 'candidate required';
  if (typeof c.field !== 'string' || !c.field) return 'candidate.field required';
  if (
    c.circuit !== null &&
    c.circuit !== undefined &&
    !(typeof c.circuit === 'number' && Number.isInteger(c.circuit))
  ) {
    return 'candidate.circuit must be integer or null';
  }
  if (typeof c.value !== 'string' || !c.value) return 'candidate.value required';
  if (c.boardId !== undefined && c.boardId !== null && typeof c.boardId !== 'string') {
    return 'candidate.boardId must be string or null';
  }
  return null;
}

function buildSlotKey({ field, circuit, boardId }) {
  const normBoardId = typeof boardId === 'string' && boardId.length > 0 ? boardId : '';
  return `${field}::${circuit ?? 'null'}::${normBoardId}`;
}

/**
 * Reject with the given status + error AFTER decrementing the
 * expected-ACK stash. The iOS client treats every non-2xx as "abandon
 * silently — do NOT speak native TTS"; this helper also takes care of
 * the turn_audio_summary accounting so the finalizer doesn't time out
 * waiting for an ACK that's never coming.
 */
function rejectWithDecrement(res, sessionId, correlationId, status, errorBody) {
  if (correlationId && sessionId) {
    try {
      decrementExpectedAcksByCorrelation(sessionId, correlationId);
    } catch (err) {
      logger.warn('voice_latency.fast_tts_decrement_error', {
        sessionId,
        correlationId,
        error: err?.message || String(err),
      });
    }
  }
  return res.status(status).json(errorBody);
}

router.post('/voice-latency/regex-fast-tts', auth.requireAuth, async (req, res) => {
  const t0 = process.hrtime.bigint();

  // Order matters: kill switch FIRST so a panicked ops flip drops every
  // in-flight POST regardless of body shape.
  if (isKillSwitchActive()) {
    // No correlationId may exist yet — caller-minted but we never read
    // it on this path. Skip decrement (we never opened a finalizer
    // entry to decrement).
    return res.status(503).json({
      error: 'kill switch active',
      hint: 'iOS MUST silently abandon — do NOT fall back to native TTS',
    });
  }

  const validationErr = validateBody(req.body);
  if (validationErr) {
    // Body malformed — correlationId might be missing or bogus. Pull
    // it defensively for the decrement attempt.
    const cid = typeof req.body?.correlationId === 'string' ? req.body.correlationId : null;
    const sid = typeof req.body?.sessionId === 'string' ? req.body.sessionId : null;
    return rejectWithDecrement(res, sid, cid, 400, {
      error: validationErr,
      hint: 'iOS MUST silently abandon — do NOT fall back to native TTS',
    });
  }

  const { sessionId, turnId, correlationId, transcript, candidate } = req.body;
  const { field, circuit, value, boardId = null } = candidate;

  // Eligibility whitelist (Pivot 2). Non-whitelisted fields can drift
  // (booleans like polarity_confirmed) or have no iOS regex pattern
  // (rcd_time_ms) — see regex-fast-eligibility.js header.
  if (!isRegexFastEligible(field)) {
    return rejectWithDecrement(res, sessionId, correlationId, 422, {
      error: 'field not eligible for fast path',
      field,
      hint: 'iOS MUST silently abandon — do NOT fall back to native TTS',
    });
  }

  // Per-session voice-latency snapshot lookup.
  const vl = getVoiceLatencyForSession(sessionId);
  if (!vl) {
    return rejectWithDecrement(res, sessionId, correlationId, 404, {
      error: 'session not found',
      hint: 'iOS MUST silently abandon — do NOT fall back to native TTS',
    });
  }
  if (vl.flags?.regexFastTts !== true) {
    // Flag-off: route exists but is gated. Return 404 to match the
    // legacy "endpoint inactive" semantics rather than 503.
    return rejectWithDecrement(res, sessionId, correlationId, 404, {
      error: 'fast path disabled',
      hint: 'iOS MUST silently abandon — do NOT fall back to native TTS',
    });
  }

  // Capability gate (Pivot 4): regex_fast_v2 — NOT hasStreamingHttpAudio.
  // Older clients (regex_fast_tts only) get 412 with a hint.
  if (vl.capabilities?.hasRegexFastV2 !== true) {
    return rejectWithDecrement(res, sessionId, correlationId, 412, {
      error: 'iOS client did not advertise regex_fast_v2',
      hint: 'iOS MUST silently abandon — do NOT fall back to native TTS',
    });
  }

  // boardId validation: when present must be a board the session knows
  // about (mainly defensive — iOS shouldn't post for an invented board
  // but Sonnet sometimes generates ids that drift).
  const entry = getActiveSessionEntry(sessionId);
  if (boardId && entry?.session?.stateSnapshot?.boards) {
    const known = entry.session.stateSnapshot.boards.some((b) => b.id === boardId);
    if (!known) {
      return rejectWithDecrement(res, sessionId, correlationId, 422, {
        error: 'boardId not known to session',
        boardId,
        hint: 'iOS MUST silently abandon — do NOT fall back to native TTS',
      });
    }
  }

  // Build the confirmation. buildConfirmationText handles the canonical
  // friendly-name lookup, value coercion, and Circuit-N prefix. Returns
  // null when the field isn't in the friendly-name table — but the
  // eligibility whitelist above already filtered those, so this is
  // belt-and-braces.
  const text = buildConfirmationText(field, value, circuit);
  if (!text) {
    return rejectWithDecrement(res, sessionId, correlationId, 422, {
      error: 'unable to build confirmation for candidate',
      field,
      hint: 'iOS MUST silently abandon — do NOT fall back to native TTS',
    });
  }

  // Speculator preflight integration (Pivot 9 + 11). Two writes BEFORE
  // we start streaming audio: (a) seed pendingFastTtsSlots so any
  // subsequent speculator dispatch for this slot skips synthesis;
  // (b) abortBySlot any in-flight speculation already running for the
  // slot — iOS is going to play our MP3 within ~500ms so finishing
  // the speculator's audio wastes ElevenLabs chars + ledger.
  const slotKey = buildSlotKey({ field, circuit, boardId });
  if (entry?.pendingFastTtsSlots instanceof Map) {
    if (!entry.pendingFastTtsSlots.has(turnId)) {
      entry.pendingFastTtsSlots.set(turnId, new Set());
    }
    entry.pendingFastTtsSlots.get(turnId).add(slotKey);
  }
  if (entry?.session?.loadedBarrelSpeculator?.abortBySlot) {
    try {
      entry.session.loadedBarrelSpeculator.abortBySlot({
        sessionId,
        turnId,
        field,
        circuit,
        boardId,
      });
    } catch (err) {
      logger.warn('voice_latency.fast_tts_abort_by_slot_error', {
        sessionId,
        correlationId,
        slotKey,
        error: err?.message || String(err),
      });
    }
  }

  const apiKey = await getElevenLabsKey();
  if (!apiKey) {
    return rejectWithDecrement(res, sessionId, correlationId, 500, {
      error: 'ElevenLabs API key not configured',
    });
  }

  const { ElevenLabsStreamClient, contentTypeForFormat } =
    await import('../extraction/elevenlabs-stream-client.js');
  const { recordSpan, recordOutcome } = await import('../extraction/voice-latency-telemetry.js');

  // Force MP3 output (Pivot 7). iOS's playFastPathAudio uses AVAudioPlayer
  // which handles MP3 natively. PCM would require iOS-side framing
  // which we don't ship.
  const client = new ElevenLabsStreamClient({
    apiKey,
    outputFormat: FORCED_OUTPUT_FORMAT,
  });

  recordSpan(correlationId, 'backend_recv', t0, process.hrtime.bigint(), {
    transcript: typeof transcript === 'string' ? transcript.slice(0, 80) : null,
    field,
    circuit,
    boardId,
  });

  res.set('Content-Type', contentTypeForFormat(client.outputFormat));
  res.set('Transfer-Encoding', 'chunked');
  res.set('Cache-Control', 'no-store');
  res.set('X-Voice-Latency-Correlation-Id', correlationId);
  res.set('X-Voice-Latency-Source', 'fast_path');

  let terminal = 'failed';
  try {
    const opts = {
      onAudio: (buf) => {
        if (!res.writableEnded) res.write(buf);
      },
    };
    const timings = await client.synth(text, opts);
    terminal = 'completed';
    if (!res.writableEnded) res.end();
    ElevenLabsStreamClient.logSynthSpans(correlationId, timings, recordSpan);
    recordOutcome(correlationId, 'sent_to_client', { meta: { sessionId, source: 'fast_path' } });
    logger.info('voice_latency.fast_path_complete', {
      correlationId,
      sessionId,
      turnId,
      slotKey,
      text_preview: text.slice(0, 80),
      backend_to_first_audio_ms:
        timings.firstAudioNs > 0n ? Number((timings.firstAudioNs - t0) / 1000000n) : null,
      total_ms: Number((process.hrtime.bigint() - t0) / 1000000n),
    });
  } catch (err) {
    terminal = String(err?.message || '').includes('aborted') ? 'cancelled' : 'failed';
    recordOutcome(correlationId, terminal === 'cancelled' ? 'cancelled' : 'synth_failed', {
      meta: { sessionId, error: err?.message },
    });
    if (!res.headersSent) {
      // Decrement here too — the synth failed BEFORE any audio reached
      // the wire, so iOS will treat this as a hard reject and not call
      // playback-ack.
      return rejectWithDecrement(res, sessionId, correlationId, 502, {
        error: err?.message || 'fast_path_failed',
        hint: 'iOS MUST silently abandon — do NOT fall back to native TTS',
      });
    } else if (!res.writableEnded) {
      res.end();
    }
    logger.warn('voice_latency.fast_path_failed', {
      correlationId,
      sessionId,
      turnId,
      slotKey,
      error: err?.message,
    });
  }
});

export default router;
