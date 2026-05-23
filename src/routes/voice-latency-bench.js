/**
 * Voice-latency Stage 0 bench routes (THROWAWAY).
 *
 * Lives behind STAGE0_BENCH=1. When the flag is unset (default) every route
 * here returns 404 — the surface does not exist for ordinary clients.
 *
 * Removed at end of Stage 0 along with the env var. See
 * `.planning-stage6-agentic/handoffs/voice-latency-2026-05-23/PLAN_v3.md` §3.A
 * for the measurement protocol this code supports.
 *
 * Endpoints:
 *   POST /api/test/elevenlabs-pcm-stream  — opens an ElevenLabs stream-input
 *                                            WS for pcm_22050 output and pipes
 *                                            audio frames to the client over
 *                                            chunked HTTP. iOS bench harness
 *                                            measures first_chunk_received →
 *                                            dataPlayedBack.
 *   POST /api/test/elevenlabs-mp3-stream  — same shape but mp3_22050_32 output.
 *                                            Stage 0.A contingency path.
 *
 * Auth: requireAuth — bench endpoint still hits the paid vendor.
 */

import { Router } from 'express';
import WebSocket from 'ws';
import * as auth from '../auth.js';
import { getElevenLabsKey } from '../services/secrets.js';
import logger from '../logger.js';

const router = Router();

const VOICE_ID = 'Fahco4VZzobUeiPqni1S'; // Archer Conversational — pinned per PLAN_v2 1.4
const MODEL_ID = 'eleven_flash_v2_5'; // PLAN_v2 1.4

const VOICE_SETTINGS = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0.3,
  use_speaker_boost: true,
  speed: 1.0,
};

const DEFAULT_BENCH_TEXT = 'Circuit one. Number of points five.';

function benchEnabled() {
  return process.env.STAGE0_BENCH === '1';
}

/**
 * Open an ElevenLabs stream-input WebSocket, send BOS + text + EOS, pipe
 * audio frames to the supplied response object using chunked transfer
 * encoding. Resolves on isFinal, rejects on error/timeout.
 */
async function streamElevenLabsToResponse({ text, outputFormat, contentType, apiKey, res }) {
  const url =
    `wss://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream-input` +
    `?model_id=${encodeURIComponent(MODEL_ID)}` +
    `&output_format=${encodeURIComponent(outputFormat)}` +
    `&inactivity_timeout=20` +
    `&apply_text_normalization=on`;

  res.set('Content-Type', contentType);
  res.set('Transfer-Encoding', 'chunked');
  res.set('Cache-Control', 'no-store');

  const timings = {
    wsOpenStart: process.hrtime.bigint(),
    wsOpened: 0n,
    bosSent: 0n,
    textSent: 0n,
    firstAudio: 0n,
    isFinal: 0n,
    byteCount: 0,
  };

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: { 'xi-api-key': apiKey },
    });

    const closeWithError = (err) => {
      try {
        ws.close();
      } catch (_) {
        /* noop */
      }
      reject(err);
    };

    const inactivityTimer = setTimeout(() => closeWithError(new Error('bench_timeout_25s')), 25000);

    ws.on('open', () => {
      timings.wsOpened = process.hrtime.bigint();
      ws.send(
        JSON.stringify({
          text: ' ',
          voice_settings: VOICE_SETTINGS,
        })
      );
      timings.bosSent = process.hrtime.bigint();
      ws.send(JSON.stringify({ text, try_trigger_generation: true }));
      timings.textSent = process.hrtime.bigint();
      ws.send(JSON.stringify({ text: '' })); // EOS
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        return; // ignore non-JSON
      }
      if (msg.audio) {
        if (timings.firstAudio === 0n) timings.firstAudio = process.hrtime.bigint();
        const buf = Buffer.from(msg.audio, 'base64');
        timings.byteCount += buf.length;
        res.write(buf);
      }
      if (msg.isFinal) {
        timings.isFinal = process.hrtime.bigint();
        clearTimeout(inactivityTimer);
        try {
          ws.close();
        } catch (_) {
          /* noop */
        }
        res.end();
        resolve(timings);
      }
      if (msg.error) {
        clearTimeout(inactivityTimer);
        closeWithError(new Error(`elevenlabs_error: ${msg.error}`));
      }
    });

    ws.on('error', (err) => {
      clearTimeout(inactivityTimer);
      closeWithError(err);
    });

    ws.on('close', (code, reason) => {
      clearTimeout(inactivityTimer);
      if (timings.isFinal === 0n) {
        closeWithError(new Error(`ws_closed_before_final code=${code} reason=${reason}`));
      }
    });
  });
}

function nsToMs(start, end) {
  if (start === 0n || end === 0n) return null;
  return Number((end - start) / 1000000n);
}

function logTimings(label, text, outputFormat, timings) {
  logger.info(label, {
    text_preview: text.slice(0, 80),
    text_length: text.length,
    output_format: outputFormat,
    ws_open_ms: nsToMs(timings.wsOpenStart, timings.wsOpened),
    bos_to_first_audio_ms: nsToMs(timings.bosSent, timings.firstAudio),
    text_to_first_audio_ms: nsToMs(timings.textSent, timings.firstAudio),
    first_audio_to_final_ms: nsToMs(timings.firstAudio, timings.isFinal),
    total_ms: nsToMs(timings.wsOpenStart, timings.isFinal),
    bytes: timings.byteCount,
  });
}

router.post('/test/elevenlabs-pcm-stream', auth.requireAuth, async (req, res) => {
  if (!benchEnabled()) return res.status(404).end();

  const text = (req.body?.text || DEFAULT_BENCH_TEXT).toString();
  if (!text.trim()) return res.status(400).json({ error: 'text required' });

  const apiKey = await getElevenLabsKey();
  if (!apiKey) return res.status(500).json({ error: 'ElevenLabs API key not configured' });

  try {
    const timings = await streamElevenLabsToResponse({
      text,
      outputFormat: 'pcm_22050',
      contentType: 'audio/L16; rate=22050; channels=1',
      apiKey,
      res,
    });
    logTimings('stage0_bench_pcm_stream_complete', text, 'pcm_22050', timings);
  } catch (err) {
    logger.error('stage0_bench_pcm_stream_failed', { error: err.message });
    if (!res.headersSent) res.status(502).json({ error: err.message });
    else res.end();
  }
});

router.post('/test/elevenlabs-mp3-stream', auth.requireAuth, async (req, res) => {
  if (!benchEnabled()) return res.status(404).end();

  const text = (req.body?.text || DEFAULT_BENCH_TEXT).toString();
  if (!text.trim()) return res.status(400).json({ error: 'text required' });

  const apiKey = await getElevenLabsKey();
  if (!apiKey) return res.status(500).json({ error: 'ElevenLabs API key not configured' });

  try {
    const timings = await streamElevenLabsToResponse({
      text,
      outputFormat: 'mp3_22050_32',
      contentType: 'audio/mpeg',
      apiKey,
      res,
    });
    logTimings('stage0_bench_mp3_stream_complete', text, 'mp3_22050_32', timings);
  } catch (err) {
    logger.error('stage0_bench_mp3_stream_failed', { error: err.message });
    if (!res.headersSent) res.status(502).json({ error: err.message });
    else res.end();
  }
});

export default router;
