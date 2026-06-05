#!/usr/bin/env node
/**
 * Stage 0.C — ElevenLabs stream-input TTFB bench (from eu-west-2).
 *
 * Pass criterion (PLAN_v3 §3.C): P50 BOS-to-first-audio ≤ 250 ms.
 *
 * Method:
 *   1. Open one stream-input WS per iteration (single-shot, no pool —
 *      matches Stage 2's default).
 *   2. Send BOS = {text: " ", voice_settings}, then short synth text +
 *      EOS in a single batch.
 *   3. Time BOS_sent → first audio frame.
 *   4. Repeat N times sequentially. Report P50 / P95 / p99.
 *
 * Runs from the developer Mac (London). Production backend is also in
 * eu-west-2; bench numbers are representative within ~10ms.
 *
 * Usage:
 *   AWS-fetched key (preferred):
 *     ELEVENLABS_API_KEY=$(aws secretsmanager get-secret-value ... ) \
 *       node scripts/voice-latency-bench/elevenlabs-ttfb-bench.mjs --iters=20
 *
 *   Or directly: ELEVENLABS_API_KEY=... node scripts/voice-latency-bench/elevenlabs-ttfb-bench.mjs
 */

import WebSocket from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const ITERS = Number(args.iters ?? 20);
const OUTPUT_PATH = args.output ?? null;
const OUTPUT_FORMAT = args.format ?? 'pcm_22050';
const MODEL_ID = 'eleven_flash_v2_5';
const VOICE_ID = 'Fahco4VZzobUeiPqni1S';
const BENCH_TEXT = 'Circuit one. Number of points five.';

const VOICE_SETTINGS = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0.3,
  use_speaker_boost: true,
  speed: 1.0,
};

const apiKey = process.env.ELEVENLABS_API_KEY;
if (!apiKey) {
  console.error('Set ELEVENLABS_API_KEY in the environment.');
  process.exit(2);
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(Math.max(Math.floor(sorted.length * p), 0), sorted.length - 1);
  return sorted[idx];
}

function runOne(iter) {
  return new Promise((resolve, reject) => {
    const url =
      `wss://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream-input` +
      `?model_id=${MODEL_ID}` +
      `&output_format=${OUTPUT_FORMAT}` +
      `&inactivity_timeout=20` +
      `&apply_text_normalization=on`;

    const t = {
      wsOpenStart: process.hrtime.bigint(),
      wsOpened: 0n,
      bosSent: 0n,
      textSent: 0n,
      firstAudio: 0n,
      isFinal: 0n,
      bytes: 0,
      audioChunks: 0,
    };

    const ws = new WebSocket(url, { headers: { 'xi-api-key': apiKey } });

    const timeout = setTimeout(() => {
      try {
        ws.close();
      } catch (_) {
        /* noop */
      }
      reject(new Error(`iter ${iter} timeout`));
    }, 25000);

    ws.on('open', () => {
      t.wsOpened = process.hrtime.bigint();
      ws.send(JSON.stringify({ text: ' ', voice_settings: VOICE_SETTINGS }));
      t.bosSent = process.hrtime.bigint();
      ws.send(JSON.stringify({ text: BENCH_TEXT, try_trigger_generation: true }));
      t.textSent = process.hrtime.bigint();
      ws.send(JSON.stringify({ text: '' })); // EOS
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.audio) {
        if (t.firstAudio === 0n) t.firstAudio = process.hrtime.bigint();
        const buf = Buffer.from(msg.audio, 'base64');
        t.bytes += buf.length;
        t.audioChunks += 1;
      }
      if (msg.isFinal) {
        t.isFinal = process.hrtime.bigint();
        clearTimeout(timeout);
        try {
          ws.close();
        } catch (_) {
          /* noop */
        }
        const ns2ms = (a, b) => (a === 0n || b === 0n ? null : Number((b - a) / 1000000n));
        resolve({
          iter,
          wsOpenMs: ns2ms(t.wsOpenStart, t.wsOpened),
          bosToFirstAudioMs: ns2ms(t.bosSent, t.firstAudio),
          textToFirstAudioMs: ns2ms(t.textSent, t.firstAudio),
          firstAudioToFinalMs: ns2ms(t.firstAudio, t.isFinal),
          totalMs: ns2ms(t.wsOpenStart, t.isFinal),
          bytes: t.bytes,
          audioChunks: t.audioChunks,
        });
      }
      if (msg.error) {
        clearTimeout(timeout);
        reject(new Error(`elevenlabs error iter ${iter}: ${msg.error}`));
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    ws.on('close', (code) => {
      clearTimeout(timeout);
      if (t.isFinal === 0n) reject(new Error(`iter ${iter} closed early code=${code}`));
    });
  });
}

async function main() {
  console.log(
    `ElevenLabs stream-input TTFB bench: ${ITERS} iterations, model=${MODEL_ID}, format=${OUTPUT_FORMAT}`,
  );
  const results = [];
  for (let i = 1; i <= ITERS; i++) {
    try {
      const r = await runOne(i);
      results.push(r);
      console.log(
        `  iter ${String(i).padStart(2, '0')}: ws_open=${String(r.wsOpenMs).padStart(4)}ms ` +
          `BOS→1st_audio=${String(r.bosToFirstAudioMs).padStart(4)}ms ` +
          `1st_audio→final=${String(r.firstAudioToFinalMs).padStart(4)}ms ` +
          `total=${String(r.totalMs).padStart(4)}ms ` +
          `bytes=${r.bytes} chunks=${r.audioChunks}`,
      );
    } catch (err) {
      console.error(`  iter ${i}: FAILED — ${err.message}`);
      results.push({ iter: i, error: err.message });
    }
    await delay(300);
  }

  const ok = results.filter((r) => r.bosToFirstAudioMs != null);
  const bosTtfb = ok.map((r) => r.bosToFirstAudioMs);
  const summary = {
    iterations: ITERS,
    successes: ok.length,
    failures: results.filter((r) => r.error).length,
    output_format: OUTPUT_FORMAT,
    model_id: MODEL_ID,
    bos_to_first_audio_p50_ms: percentile(bosTtfb, 0.5),
    bos_to_first_audio_p95_ms: percentile(bosTtfb, 0.95),
    bos_to_first_audio_p99_ms: percentile(bosTtfb, 0.99),
    bos_to_first_audio_min_ms: Math.min(...bosTtfb),
    bos_to_first_audio_max_ms: Math.max(...bosTtfb),
    ws_open_p50_ms: percentile(
      ok.map((r) => r.wsOpenMs),
      0.5,
    ),
    total_p50_ms: percentile(
      ok.map((r) => r.totalMs),
      0.5,
    ),
    pass_bos_to_first_audio_p50_le_250ms: percentile(bosTtfb, 0.5) <= 250,
  };

  console.log('\n=== Summary ===');
  console.log(JSON.stringify(summary, null, 2));

  if (OUTPUT_PATH) {
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ summary, results }, null, 2));
    console.log(`\nWrote ${OUTPUT_PATH}`);
  }
}

main().catch((err) => {
  console.error('Bench failed:', err);
  process.exit(1);
});
