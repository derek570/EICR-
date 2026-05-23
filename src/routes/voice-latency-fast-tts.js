/**
 * Stage 4 minimum-viable fast-path TTS endpoint.
 *
 * POST /api/voice-latency/regex-fast-tts
 *
 * Accepts a simulated-Deepgram transcript + a regex-recognised
 * candidate (field/circuit/value), composes a short confirmation
 * sentence, and streams TTS via the existing Stage 2.4
 * ElevenLabsStreamClient. Bypasses Sonnet entirely.
 *
 * Gated by:
 *   - VOICE_LATENCY_REGEX_FAST_TTS=true (per-session snapshot)
 *   - iOS capability `streaming_http_audio`
 *   - kill switch off
 *
 * Body:
 *   {
 *     sessionId: "...",
 *     transcript: "Circuit one number of points 5",
 *     candidate: { field: "number_of_points", circuit: 1, value: "5" }
 *   }
 *
 * Response: chunked HTTP, audio/L16 PCM (or audio/mpeg if format flips).
 *
 * Per PLAN_v3 §7 (the conditional Stage 4). This minimum-viable build
 * intentionally OMITS the suppression machinery, race catalogue, and
 * eligibility whitelist — it exists to measure end-to-end latency, not
 * to ship to production iOS clients. Production rollout per PLAN_v5
 * locks all of §7's safeguards behind the assessment gate.
 */

import { Router } from 'express';
import * as auth from '../auth.js';
import { getElevenLabsKey } from '../services/secrets.js';
import logger from '../logger.js';

const router = Router();

const FRIENDLY = {
  number_of_points: 'number of points',
  measured_zs_ohm: 'Zs',
  zs: 'Zs',
  r1_r2_ohm: 'R1 plus R2',
  polarity_confirmed: 'polarity confirmed',
  polarity: 'polarity confirmed',
  ir_live_earth_mohm: 'IR L to E',
  ir_live_live_mohm: 'IR L to L',
  earth_loop_impedance_ze: 'Ze',
  prospective_fault_current: 'PFC',
};

function buildFastConfirmation(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const { field, circuit, value } = candidate;
  const friendly = FRIENDLY[field] ?? field;
  if (field === 'polarity_confirmed' || field === 'polarity') {
    return circuit ? `Circuit ${circuit}, polarity confirmed` : 'polarity confirmed';
  }
  if (circuit == null || circuit === 0) return `${friendly} ${value}`;
  return `Circuit ${circuit}, ${friendly} ${value}`;
}

router.post('/voice-latency/regex-fast-tts', auth.requireAuth, async (req, res) => {
  const t0 = process.hrtime.bigint();

  const { sessionId, transcript, candidate } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  if (!candidate) return res.status(400).json({ error: 'candidate required' });

  const text = buildFastConfirmation(candidate);
  if (!text) return res.status(400).json({ error: 'unable to build confirmation' });

  // Per-session voice-latency snapshot + kill switch check.
  const { getVoiceLatencyForSession } = await import('../extraction/active-sessions.js');
  const { isKillSwitchActive } = await import('../extraction/voice-latency-config.js');
  const vl = getVoiceLatencyForSession(sessionId);
  if (!vl) return res.status(404).json({ error: 'session not found' });
  if (isKillSwitchActive()) return res.status(503).json({ error: 'kill switch active' });
  if (vl.flags?.regexFastTts !== true) return res.status(404).end();
  if (vl.capabilities?.hasStreamingHttpAudio !== true) {
    return res.status(412).json({ error: 'iOS client did not advertise streaming_http_audio' });
  }

  const apiKey = await getElevenLabsKey();
  if (!apiKey) return res.status(500).json({ error: 'ElevenLabs API key not configured' });

  const { ElevenLabsStreamClient, contentTypeForFormat } =
    await import('../extraction/elevenlabs-stream-client.js');
  const { mintCorrelationId, recordSpan, recordOutcome } =
    await import('../extraction/voice-latency-telemetry.js');

  const correlationId = mintCorrelationId(sessionId, 'fast_path');
  const useMultiContext = vl.flags?.useMultiContext === true;
  const client = new ElevenLabsStreamClient({ apiKey, multiContext: useMultiContext });

  recordSpan(correlationId, 'backend_recv', t0, process.hrtime.bigint(), {
    transcript: typeof transcript === 'string' ? transcript.slice(0, 80) : null,
    field: candidate.field,
    circuit: candidate.circuit,
  });
  const eligibilityNs = process.hrtime.bigint();
  recordSpan(correlationId, 'eligibility_decision', t0, eligibilityNs);

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
    if (useMultiContext) opts.contextId = `fp_${correlationId}`;
    const timings = await client.synth(text, opts);
    terminal = 'completed';
    if (!res.writableEnded) res.end();
    ElevenLabsStreamClient.logSynthSpans(correlationId, timings, recordSpan);
    recordOutcome(correlationId, 'sent_to_client', { meta: { sessionId, source: 'fast_path' } });
    logger.info('voice_latency.fast_path_complete', {
      correlationId,
      sessionId,
      text_preview: text.slice(0, 80),
      transcript_preview: typeof transcript === 'string' ? transcript.slice(0, 80) : null,
      backend_to_first_audio_ms:
        timings.firstAudioNs > 0n ? Number((timings.firstAudioNs - t0) / 1000000n) : null,
      total_ms: Number((process.hrtime.bigint() - t0) / 1000000n),
    });
  } catch (err) {
    terminal = String(err?.message || '').includes('aborted') ? 'cancelled' : 'failed';
    recordOutcome(correlationId, terminal === 'cancelled' ? 'cancelled' : 'synth_failed', {
      meta: { sessionId, error: err?.message },
    });
    if (!res.headersSent) res.status(502).json({ error: err?.message || 'fast_path_failed' });
    else if (!res.writableEnded) res.end();
    logger.warn('voice_latency.fast_path_failed', {
      correlationId,
      sessionId,
      error: err?.message,
    });
  }
});

export default router;
