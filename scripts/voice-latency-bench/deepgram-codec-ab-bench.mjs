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
 * Methodology caveat (Codex diff-review r1): this bench encodes its opus
 * arm via ffmpeg's libopus, NOT the production sender (web WebCodecs
 * `AudioEncoder` / iOS `AVAudioConverter`). ffmpeg's default bitrate and
 * framing may not match either shipped encoder's actual output, so the
 * payload-reduction ratio this script reports is a DIRECTIONAL estimate
 * of the codec swap, not a measurement of what the shipped encoders
 * produce on real mic audio. Treat it as corroborating evidence for the
 * E0 probe's decode-correctness finding, not as a verified production
 * bandwidth number.
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

/** Tokenize: lowercase, strip punctuation, split on whitespace. Shared by
 *  `wordErrorRate` so both call sites agree on what counts as a "word". */
function tokenize(s) {
  return s
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * PLAN-E1B2 item 4 — a real, aligned word-error-rate (substitutions +
 * insertions + deletions over the Levenshtein-aligned word sequence),
 * replacing the prior set-membership `wordDiff` (Codex diff-review r2
 * IMPORTANT finding): set membership ignores word order, duplicates, and
 * insertions, so a transcript that's scrambled but lexically complete
 * scored as a perfect match. Standard dynamic-programming edit distance
 * over token arrays (rows = expected, cols = actual).
 */
export function wordErrorRate(expected, actual) {
  const ref = tokenize(expected);
  const hyp = tokenize(actual);
  const n = ref.length;
  const m = hyp.length;
  // dp[i][j] = edit distance between ref[0..i) and hyp[0..j)
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (ref[i - 1] === hyp[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  const edits = dp[n][m];
  return {
    expectedWordCount: n,
    editDistance: edits,
    // Empty reference: WER is 1 only if the hypothesis has real tokens
    // (pure insertions); a punctuation-only hypothesis normalizes to
    // nothing and is a perfect match.
    wer: n > 0 ? edits / n : m > 0 ? 1 : 0,
  };
}

async function runArm({ name, url, key, framesFn, frameDelayMs }) {
  assertNoCredentialInUrl(url, key);
  const frames = await framesFn();
  const encodedBytes = frames.reduce((sum, f) => sum + f.length, 0);
  // PLAN-E1B2 item 4 (Codex diff-review r2 IMPORTANT finding) — moved from
  // the top of this function to immediately before the first send: the
  // prior placement included WS construction/handshake time in the onset
  // clock, not just audio-send time, which is not what "onset->first-
  // interim latency" is supposed to measure.
  let startedAtMs = null;
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
      startedAtMs = Date.now();
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
      // PLAN-E1B2 item 4 (Codex diff-review r2 IMPORTANT finding) — 640
      // bytes is 20ms of 16kHz mono 16-bit PCM, matching the opus arm's
      // real ~20ms packet pacing. The prior 3,200-byte/100ms chunking
      // delivered 100ms of audio every 20ms (~5x realtime) while the opus
      // arm delivered real-time, making the two arms' onset/latency
      // numbers incomparable.
      framesFn: () => chunkPcm(pcm, 640),
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
      linear16: { ...linear16, wer: wordErrorRate(text, linear16.transcript) },
      opus: { ...opus, wer: wordErrorRate(text, opus.transcript) },
      payloadReductionRatio:
        linear16.encodedBytes > 0 ? linear16.encodedBytes / Math.max(1, opus.encodedBytes) : null,
    });
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });

  const summary = {
    sampleCount: results.length,
    meanPayloadReductionRatio:
      results.reduce((sum, r) => sum + (r.payloadReductionRatio ?? 0), 0) / results.length,
    meanOpusWer: results.reduce((sum, r) => sum + r.opus.wer.wer, 0) / results.length,
    meanLinear16Wer: results.reduce((sum, r) => sum + r.linear16.wer.wer, 0) / results.length,
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
