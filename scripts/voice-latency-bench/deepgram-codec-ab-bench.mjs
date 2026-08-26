#!/usr/bin/env node
/**
 * PLAN-E1 Test 4 — Deepgram uplink-codec A/B accuracy + latency bench.
 *
 * Committed as a REPEATABLE script (per the plan's Test 4 requirement —
 * "not a one-off"), beside the rest of `scripts/voice-latency-bench/`.
 * Interleaves the SAME certificate-vocabulary utterance through BOTH the
 * linear16 control and the bare-opus arm on live Flux, for every sample,
 * and reports:
 *   - onset→first-interim / onset→final latency per arm
 *   - encoded byte count per arm (the 8.5x payload-cut hypothesis)
 *   - transcript word-level diff against the known ground-truth utterance
 *     (certificate-relevant vocabulary is what actually matters — see
 *     PLAN-E1's accuracy bar)
 *
 * This is the REPEATABLE measurement instrument the plan requires before
 * any default-flip decision — running it once here does not itself
 * constitute the full field A/B (a real field session per arm on genuine
 * poor-signal cellular is a SEPARATE, live-network requirement this
 * synthetic bench cannot substitute for; see PLAN-E1 "Accuracy bar").
 *
 * Credential contract (same as `deepgram-flux-encoding-probe.mjs`,
 * MANDATORY): the key is fetched in-process from AWS Secrets Manager,
 * never hardcoded, never placed in a URL, never logged.
 *
 * Usage:
 *   USE_AWS_SECRETS=true node scripts/voice-latency-bench/deepgram-codec-ab-bench.mjs
 *
 * Note: `getDeepgramKey()`'s shared secrets-loading logger writes a few
 * INFO lines to stdout BEFORE the JSON report (same as
 * `deepgram-flux-encoding-probe.mjs`) — the report is the final `{ ... }`
 * block; pipe through `sed -n '/^{$/,$p'` or similar if scripting against
 * the output.
 *
 * Requires macOS `say` + `ffmpeg` on PATH (same as the E0 probe).
 * Read-only against Deepgram — no aws ecs/iam mutation.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDeepgramKey } from '../../src/services/secrets.js';

const SAMPLE_RATE = 16000;

// Representative certificate-relevant vocabulary — the domain terms an
// accuracy regression would actually be felt on, mirroring
// `voice-ab-samples.mjs`'s sample set (ElevenLabs output A/B) but for
// UPLINK transcription input.
const UTTERANCES = [
  'Circuit three, Zs nought point four two ohms, insulation resistance two hundred megohms.',
  'R1 plus R2 nought point five two ohms on the ring final circuit.',
  'Earth loop impedance at the distribution board nought point one nine ohms.',
  'Prospective fault current one point six kilo amps.',
  'Polarity confirmed on circuit twelve, downstairs sockets.',
  'The RCD is type A, thirty milliamp, BS EN sixty one thousand and nine.',
];

function redactUrl(url) {
  return url.replace(/([?&](?:token|key|api_key|authorization)=)[^&]+/gi, '$1[REDACTED]');
}

function assertNoCredentialInUrl(url, key) {
  if (key && url.includes(key)) {
    throw new Error('BLOCKER: constructed URL contains the raw credential — aborting bench.');
  }
  if (/[?&](token|key|api_key|authorization)=/i.test(url)) {
    throw new Error(`BLOCKER: URL carries a credential-shaped query param. url=${redactUrl(url)}`);
  }
}

function synthesizeUtterance(text, tmpDir, idx) {
  const aiff = path.join(tmpDir, `u${idx}.aiff`);
  const pcmPath = path.join(tmpDir, `u${idx}.pcm`);
  execFileSync('say', ['-o', aiff, text], { stdio: 'ignore' });
  execFileSync(
    'ffmpeg',
    ['-y', '-i', aiff, '-ar', String(SAMPLE_RATE), '-ac', '1', '-f', 's16le', pcmPath],
    { stdio: 'ignore' }
  );
  const speech = fs.readFileSync(pcmPath);
  const trailingSilence = Buffer.alloc(SAMPLE_RATE * 2 * 2); // 2s trailing silence -> EndOfTurn
  return Buffer.concat([speech, trailingSilence]);
}

// Same minimal Ogg-page parser as `deepgram-flux-encoding-probe.mjs` —
// duplicated deliberately (each bench script in this directory is
// self-contained/independently-runnable, matching the existing
// `elevenlabs-ttfb-bench.mjs` / `sonnet-ttft-bench.mjs` convention)
// rather than introducing a shared-module refactor for one small helper.
function encodeOggOpus(pcmBuffer, tmpDir, idx) {
  const pcmPath = path.join(tmpDir, `u${idx}.raw.pcm`);
  const oggPath = path.join(tmpDir, `u${idx}.opus.ogg`);
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
    { stdio: 'ignore' }
  );
  return fs.readFileSync(oggPath);
}

function extractRawOpusPackets(oggBuffer) {
  const packets = [];
  let offset = 0;
  let pending = null;
  while (offset < oggBuffer.length) {
    if (oggBuffer.toString('ascii', offset, offset + 4) !== 'OggS') break;
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
  return packets.slice(2); // drop OpusHead + OpusTags
}

function chunkPcm(buffer, chunkBytes) {
  const chunks = [];
  for (let i = 0; i < buffer.length; i += chunkBytes) {
    chunks.push(buffer.subarray(i, Math.min(i + chunkBytes, buffer.length)));
  }
  return chunks;
}

/** Word-level diff — lowercased, punctuation-stripped token overlap
 *  (a cheap but honest proxy for "did certificate vocabulary survive",
 *  not a full alignment/WER implementation). */
function wordDiff(expected, actual) {
  const norm = (s) =>
    s
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(Boolean);
  const expWords = norm(expected);
  const actWords = new Set(norm(actual));
  const matched = expWords.filter((w) => actWords.has(w));
  return {
    expectedWordCount: expWords.length,
    matchedWordCount: matched.length,
    missingWords: expWords.filter((w) => !actWords.has(w)),
  };
}

async function runArm({ name, url, key, framesFn, frameDelayMs }) {
  assertNoCredentialInUrl(url, key);
  const frames = await framesFn();
  const encodedBytes = frames.reduce((sum, f) => sum + f.length, 0);
  const startedAtMs = Date.now();
  let firstInterimMs = null;
  let finalMs = null;
  let transcript = '';

  const result = await new Promise((resolve) => {
    let ws;
    try {
      ws = new WebSocket(url, ['token', key]);
    } catch (e) {
      resolve({ outcome: 'ctor-error', message: String(e).slice(0, 200) });
      return;
    }
    const hardTimeout = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      resolve({ outcome: 'timeout' });
    }, 20000);

    ws.onopen = async () => {
      for (const frame of frames) {
        if (ws.readyState !== WebSocket.OPEN) break;
        ws.send(frame);
        if (frameDelayMs > 0) await new Promise((r) => setTimeout(r, frameDelayMs));
      }
      setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* already closed */
        }
      }, 6000);
    };

    ws.onmessage = (ev) => {
      let parsed;
      try {
        parsed = JSON.parse(String(ev.data));
      } catch {
        parsed = null;
      }
      if (!parsed) return;
      if (parsed.type === 'TurnInfo' && parsed.event === 'Update' && firstInterimMs === null) {
        firstInterimMs = Date.now() - startedAtMs;
      }
      if (parsed.type === 'TurnInfo' && parsed.event === 'EndOfTurn' && parsed.transcript) {
        transcript = parsed.transcript;
        if (finalMs === null) finalMs = Date.now() - startedAtMs;
      }
    };

    ws.onclose = (ev) => {
      clearTimeout(hardTimeout);
      resolve({ outcome: 'closed', code: ev.code });
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  });

  return {
    arm: name,
    outcome: result.outcome,
    encodedBytes,
    firstInterimMs,
    finalMs,
    transcript,
  };
}

async function main() {
  const key = await getDeepgramKey();
  if (!key) {
    console.error('No Deepgram key available (set USE_AWS_SECRETS=true or DEEPGRAM_API_KEY).');
    process.exit(1);
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-codec-ab-'));
  const results = [];

  for (let i = 0; i < UTTERANCES.length; i++) {
    const text = UTTERANCES[i];
    const pcm = synthesizeUtterance(text, tmpDir, i);
    const ogg = encodeOggOpus(pcm, tmpDir, i);
    const rawOpusPackets = extractRawOpusPackets(ogg);

    const linear16 = await runArm({
      name: 'linear16',
      url: `wss://api.deepgram.com/v2/listen?model=flux-general-en&encoding=linear16&sample_rate=${SAMPLE_RATE}&mip_opt_out=true`,
      key,
      framesFn: () => chunkPcm(pcm, 3200),
      frameDelayMs: 20,
    });
    const opus = await runArm({
      name: 'opus',
      url: `wss://api.deepgram.com/v2/listen?model=flux-general-en&encoding=opus&sample_rate=${SAMPLE_RATE}&mip_opt_out=true`,
      key,
      framesFn: () => rawOpusPackets,
      frameDelayMs: 20,
    });

    results.push({
      utterance: text,
      linear16: { ...linear16, wordDiff: wordDiff(text, linear16.transcript) },
      opus: { ...opus, wordDiff: wordDiff(text, opus.transcript) },
      payloadReductionRatio:
        linear16.encodedBytes > 0 ? linear16.encodedBytes / Math.max(1, opus.encodedBytes) : null,
    });
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });

  const summary = {
    sampleCount: results.length,
    meanPayloadReductionRatio:
      results.reduce((sum, r) => sum + (r.payloadReductionRatio ?? 0), 0) / results.length,
    opusMissingWordsTotal: results.reduce((sum, r) => sum + r.opus.wordDiff.missingWords.length, 0),
    linear16MissingWordsTotal: results.reduce(
      (sum, r) => sum + r.linear16.wordDiff.missingWords.length,
      0
    ),
  };

  process.stdout.write(JSON.stringify({ summary, results }, null, 2) + '\n');
}

// Only run when invoked directly (not when imported, e.g. by a future
// test harness that wants the helper functions).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Bench failed:', err.message);
    process.exit(1);
  });
}
