#!/usr/bin/env node
/**
 * PLAN-E1 / E0 — Deepgram uplink-encoding probe matrix.
 *
 * Decides which wire encodings Flux (/v2/listen) and nova-3 (/v1/listen)
 * accept, and whether iOS/web can actually PRODUCE those encodings, before
 * any client code is written. See PLAN-E1-final.md "E0 — probe matrix".
 *
 * Credential contract (PLAN-E1 E0, mandatory): the Deepgram key is fetched
 * from AWS Secrets Manager IN-PROCESS via the same accessor the backend
 * uses (src/services/secrets.js). It is never hardcoded, never placed in a
 * URL, never logged, and never written into a captured artefact. Auth rides
 * the WebSocket subprotocol (['token', key] for a raw master key), matching
 * production's own auth mechanism for browser/Node clients — never a query
 * parameter.
 *
 * Usage:
 *   USE_AWS_SECRETS=true node scripts/deepgram-flux-encoding-probe.mjs
 *   DEEPGRAM_API_KEY=xxx node scripts/deepgram-flux-encoding-probe.mjs   (local fallback)
 *
 * Requires macOS `say` + `ffmpeg` on PATH to synthesize the test utterance.
 * Read-only against Deepgram — no aws ecs/iam mutation, no config change.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDeepgramKey } from '../src/services/secrets.js';

const SAMPLE_RATE = 16000;
const TEST_UTTERANCE =
  'Circuit three, Zs nought point four two ohms, insulation resistance two hundred megohms.';

// ─── credential + URL safety guards ────────────────────────────────────────

function assertNoCredentialInUrl(url, key) {
  if (key && url.includes(key)) {
    throw new Error('BLOCKER: constructed URL contains the raw credential — aborting probe.');
  }
  if (/[?&](token|key|api_key|authorization)=/i.test(url)) {
    throw new Error(`BLOCKER: URL carries a credential-shaped query param — aborting probe. url=${redactUrl(url)}`);
  }
}

function redactUrl(url) {
  // Defence in depth for logging: strip any query value that looks like a token.
  return url.replace(/([?&](?:token|key|api_key|authorization)=)[^&]+/gi, '$1[REDACTED]');
}

// ─── test-audio synthesis (macOS `say` + ffmpeg; no committed binary audio) ─

function synthesizeTestAudio(tmpDir) {
  const aiff = path.join(tmpDir, 'probe.aiff');
  const pcmPath = path.join(tmpDir, 'probe-16k-mono.pcm');
  execFileSync('say', ['-o', aiff, TEST_UTTERANCE], { stdio: 'ignore' });
  execFileSync(
    'ffmpeg',
    ['-y', '-i', aiff, '-ar', String(SAMPLE_RATE), '-ac', '1', '-f', 's16le', pcmPath],
    { stdio: 'ignore' },
  );
  const speech = fs.readFileSync(pcmPath);
  // Flux's EndOfTurn is endpointed on TRAILING SILENCE IN THE AUDIO STREAM
  // (audio_window_end time), not wall-clock time after the last frame sent —
  // confirmed against a live probe: with no trailing silence in the PCM,
  // EndOfTurn never fires no matter how long the socket is held open after
  // the last real frame. Append 2s of silence so every matrix row gets a
  // real EndOfTurn to test against, matching production's post-utterance gap.
  const trailingSilence = Buffer.alloc(SAMPLE_RATE * 2 * 2); // 2s, 16-bit mono
  return Buffer.concat([speech, trailingSilence]);
}

function encodeOggOpus(pcmBuffer, tmpDir) {
  const pcmPath = path.join(tmpDir, 'in.pcm');
  const oggPath = path.join(tmpDir, 'out.opus.ogg');
  fs.writeFileSync(pcmPath, pcmBuffer);
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1',
      '-i', pcmPath,
      '-c:a', 'libopus', '-b:a', '28k', '-vbr', 'on',
      '-f', 'ogg',
      oggPath,
    ],
    { stdio: 'ignore' },
  );
  return fs.readFileSync(oggPath);
}

/**
 * Minimal Ogg page parser — extracts the raw Opus packet payloads carried
 * inside an Ogg-Opus container so the "bare opus" (no container) matrix
 * row can send frame-level Opus packets directly, without a container
 * header Deepgram doesn't expect for encoding=opus.
 *
 * Ogg page layout (RFC 3533): 'OggS' magic, version, header type, granule
 * position (8 bytes), serial (4), page seq (4), checksum (4), segment
 * count (1), segment table (segment count bytes), then payload. A packet
 * may span multiple pages/segments (lacing); this parser reassembles
 * packets from consecutive 255-byte lacing values, terminating on a value
 * < 255 (per spec). The first two logical packets (OpusHead, OpusTags)
 * are Opus's own container framing, not audio — they are dropped from
 * the raw-packet stream we send.
 */
function extractRawOpusPackets(oggBuffer) {
  const packets = [];
  let offset = 0;
  let pending = null;
  while (offset < oggBuffer.length) {
    if (oggBuffer.toString('ascii', offset, offset + 4) !== 'OggS') {
      break;
    }
    const segCount = oggBuffer.readUInt8(offset + 26);
    const segTableStart = offset + 27;
    const segTable = oggBuffer.subarray(segTableStart, segTableStart + segCount);
    let payloadOffset = segTableStart + segCount;
    for (const segLen of segTable) {
      const chunk = oggBuffer.subarray(payloadOffset, payloadOffset + segLen);
      pending = pending ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
      if (segLen < 255) {
        packets.push(pending);
        pending = null;
      }
      payloadOffset += segLen;
    }
    offset = payloadOffset;
  }
  // Drop OpusHead + OpusTags (the two header packets every Ogg-Opus stream
  // starts with) — the "bare opus" row sends only audio-data packets.
  return packets.slice(2);
}

// ─── Deepgram WS probe ──────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.name - matrix row label
 * @param {string} opts.url - full wss:// URL (NEVER containing the credential)
 * @param {string} opts.key - raw master key OR short-lived JWT
 * @param {'token'|'bearer'} opts.scheme - subprotocol auth scheme
 * @param {() => (Buffer[]|Promise<Buffer[]>)} opts.framesFn - binary frames to send, in order
 * @param {number} [opts.frameDelayMs] - pacing between frames (0 = as fast as possible)
 */
async function probeOnce({ name, url, key, scheme, framesFn, frameDelayMs = 20 }) {
  assertNoCredentialInUrl(url, key);
  const frames = await framesFn();
  const messages = [];
  let turnInfoCount = 0;
  let endOfTurnSeen = false;

  const result = await new Promise((resolve) => {
    let ws;
    try {
      ws = new WebSocket(url, [scheme, key]);
    } catch (e) {
      resolve({ outcome: 'ctor-error', message: String(e).slice(0, 200) });
      return;
    }

    const hardTimeout = setTimeout(() => {
      try { ws.close(); } catch { /* already closed */ }
      resolve({ outcome: 'timeout', messages, turnInfoCount, endOfTurnSeen });
    }, 25000);

    ws.onopen = async () => {
      for (const frame of frames) {
        if (ws.readyState !== WebSocket.OPEN) break;
        ws.send(frame);
        if (frameDelayMs > 0) await new Promise((r) => setTimeout(r, frameDelayMs));
      }
      // Allow Deepgram time to emit finals after the last frame, then close cleanly.
      setTimeout(() => {
        try { ws.close(); } catch { /* already closed */ }
      }, 8000);
    };

    ws.onmessage = (ev) => {
      let parsed;
      try { parsed = JSON.parse(String(ev.data)); } catch { parsed = null; }
      if (parsed) {
        messages.push(parsed);
        if (parsed.type === 'TurnInfo') turnInfoCount += 1;
        if (parsed.type === 'TurnInfo' && parsed.event === 'EndOfTurn') endOfTurnSeen = true;
      }
    };

    ws.onclose = (ev) => {
      clearTimeout(hardTimeout);
      resolve({
        outcome: messages.length > 0 ? 'accepted' : 'closed-no-messages',
        code: ev.code,
        reason: String(ev.reason || '').slice(0, 300),
        messages,
        turnInfoCount,
        endOfTurnSeen,
      });
    };

    ws.onerror = () => { /* onclose follows with code/reason */ };
  });

  return { row: name, ...result };
}

/**
 * Both message shapes are handled: Flux (/v2/listen) carries transcript text
 * on top-level `TurnInfo.transcript`; nova-3 (/v1/listen) uses the legacy
 * `channel.alternatives[0].transcript` shape. Only EndOfTurn/final rows are
 * kept for Flux so interim re-statements of the same words aren't repeated.
 */
function extractTranscript(messages) {
  const fluxFinals = messages
    .filter((m) => m && m.type === 'TurnInfo' && m.event === 'EndOfTurn' && typeof m.transcript === 'string')
    .map((m) => m.transcript)
    .filter(Boolean);
  if (fluxFinals.length > 0) return fluxFinals.join(' ').trim();

  const nova3Texts = messages
    .filter((m) => m && m.channel && m.channel.alternatives && m.channel.alternatives[0] && m.is_final)
    .map((m) => m.channel.alternatives[0].transcript)
    .filter(Boolean);
  return nova3Texts.join(' ').trim();
}

function summarize(probeResult) {
  const transcript = extractTranscript(probeResult.messages || []);
  return {
    row: probeResult.row,
    outcome: probeResult.outcome,
    code: probeResult.code,
    reason: probeResult.reason,
    messageCount: (probeResult.messages || []).length,
    turnInfoCount: probeResult.turnInfoCount,
    endOfTurnSeen: probeResult.endOfTurnSeen,
    transcript: transcript || null,
  };
}

// ─── matrix ──────────────────────────────────────────────────────────────

async function main() {
  const key = await getDeepgramKey();
  if (!key) {
    console.error('No Deepgram key available (set USE_AWS_SECRETS=true or DEEPGRAM_API_KEY).');
    process.exit(1);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-probe-'));
  const pcm = synthesizeTestAudio(tmpDir);
  const ogg = encodeOggOpus(pcm, tmpDir);
  const rawOpusPackets = extractRawOpusPackets(ogg);

  const results = [];

  // 1. linear16 control (re-run for the record).
  results.push(
    await probeOnce({
      name: 'flux-linear16-control',
      url: `wss://api.deepgram.com/v2/listen?model=flux-general-en&encoding=linear16&sample_rate=${SAMPLE_RATE}&mip_opt_out=true`,
      key,
      scheme: 'token',
      framesFn: () => chunkPcm(pcm, 3200), // 100ms @ 16kHz mono s16le
    }),
  );

  // 1b. ogg-opus E2E (re-run committed version).
  results.push(
    await probeOnce({
      name: 'flux-ogg-opus',
      url: `wss://api.deepgram.com/v2/listen?model=flux-general-en&encoding=ogg-opus&sample_rate=${SAMPLE_RATE}&mip_opt_out=true`,
      key,
      scheme: 'token',
      framesFn: () => [ogg], // whole container as one binary frame; Deepgram demuxes
      frameDelayMs: 0,
    }),
  );

  // 2. bare opus E2E — raw Opus packets extracted from the Ogg container, no container framing.
  results.push(
    await probeOnce({
      name: 'flux-bare-opus',
      url: `wss://api.deepgram.com/v2/listen?model=flux-general-en&encoding=opus&sample_rate=${SAMPLE_RATE}&mip_opt_out=true`,
      key,
      scheme: 'token',
      framesFn: () => rawOpusPackets,
      frameDelayMs: 20, // Opus frames are ~20ms; pace sends to mimic real streaming
    }),
  );

  // 3. webm-opus — NOT probed here. MediaRecorder encodes its own MediaStream and
  //    cannot encode an arbitrary PCM replay buffer at send time (see PLAN-E1 E0
  //    item 3's feasibility constraint), so this row requires a live-microphone
  //    Chrome/Safari harness this headless script cannot run. Recorded as a gap,
  //    not narrowed here — the plan's fallback (WebCodecs AudioEncoder, or stay
  //    linear16 on web) is adopted without this row's live result.
  results.push({
    row: 'web-webm-opus-mediarecorder',
    outcome: 'not-probed-requires-browser-harness',
    note:
      'MediaRecorder cannot encode arbitrary PCM replay buffers at send time; ' +
      'ruled out per E0 item 3 unless a live-mic browser harness proves PCM injection. ' +
      'Web route adopted: WebCodecs AudioEncoder(\'opus\'), not MediaRecorder.',
  });

  // 4. EoT-behaviour sanity on compressed streams — reuses the ogg-opus result above.
  const oggRow = results.find((r) => r.row === 'flux-ogg-opus');
  results.push({
    row: 'eot-cadence-sanity',
    outcome: oggRow?.turnInfoCount > 0 ? 'turninfo-cadence-present' : 'no-turninfo-seen',
    turnInfoCount: oggRow?.turnInfoCount ?? 0,
    endOfTurnSeen: oggRow?.endOfTurnSeen ?? false,
  });

  // 5. nova-3 /v1/listen + opus — PINNED OUTCOME (see PLAN-E1 E0 item 5): both
  //    clients ship Flux-gated codec latching regardless of this result. Probed
  //    anyway to record whether the gate could later be relaxed.
  results.push(
    await probeOnce({
      name: 'nova3-opus',
      url: `wss://api.deepgram.com/v1/listen?model=nova-3&encoding=opus&sample_rate=${SAMPLE_RATE}&mip_opt_out=true`,
      key,
      scheme: 'token',
      framesFn: () => rawOpusPackets,
      frameDelayMs: 20,
    }),
  );

  const summary = results.map((r) => (r.messages ? summarize(r) : r));
  process.stdout.write(
    JSON.stringify({ utterance: TEST_UTTERANCE, sampleRate: SAMPLE_RATE, results: summary }, null, 2) + '\n',
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function chunkPcm(buffer, chunkBytes) {
  const chunks = [];
  for (let i = 0; i < buffer.length; i += chunkBytes) {
    chunks.push(buffer.subarray(i, Math.min(i + chunkBytes, buffer.length)));
  }
  return chunks;
}

main().catch((err) => {
  console.error('Probe failed:', err.message);
  process.exit(1);
});
