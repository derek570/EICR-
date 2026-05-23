#!/usr/bin/env node
/**
 * Stage 0.F — ElevenLabs multi-stream-input evaluation.
 *
 * Per PLAN_v3 §3.F: 7 operational pass criteria. This bench probes
 * each and reports pass/fail. The aggregate verdict determines whether
 * Stage 2 ships warm (one pooled WS per session) or cold (one-shot WS
 * per synth) — which in turn determines whether the "around 2-2.5s"
 * user-goal latency is hittable.
 *
 * Protocol (from
 * https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-multi-stream-input):
 *
 *   wss://api.elevenlabs.io/v1/text-to-speech/<voice>/multi-stream-input
 *     ?model_id=...&output_format=...&inactivity_timeout=...&apply_text_normalization=on
 *
 *   client → server:
 *     init context     {text: " ", context_id, voice_settings, ...}
 *     send text        {text, context_id, flush?}
 *     close context    {context_id, close_context: true}
 *     keep alive       {text: "", context_id}
 *     close socket     {close_socket: true}
 *
 *   server → client (note camelCase `contextId` in server messages):
 *     audio frame      {audio: <b64>, contextId, alignment?, normalizedAlignment?}
 *     final            {isFinal: true, contextId}
 *
 * Usage:
 *   ELEVENLABS_API_KEY=... node scripts/voice-latency-bench/elevenlabs-multi-context-bench.mjs
 *   ELEVENLABS_API_KEY=... node scripts/voice-latency-bench/elevenlabs-multi-context-bench.mjs --output=path.json
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

const OUTPUT_PATH = args.output ?? null;
const VOICE_ID = 'Fahco4VZzobUeiPqni1S';
const MODEL_ID = 'eleven_flash_v2_5';
const OUTPUT_FORMAT = 'pcm_22050';

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

function buildUrl() {
  return (
    `wss://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/multi-stream-input` +
    `?model_id=${MODEL_ID}` +
    `&output_format=${OUTPUT_FORMAT}` +
    `&inactivity_timeout=20` +
    `&apply_text_normalization=on`
  );
}

/**
 * Open a multi-context WS. Returns { ws, send, onMessage, close } where
 * onMessage receives parsed JSON objects.
 */
function openWS() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(buildUrl(), { headers: { 'xi-api-key': apiKey } });
    const opened = process.hrtime.bigint();
    const listeners = new Set();
    ws.on('open', () => {
      resolve({
        ws,
        openedNs: opened,
        send: (obj) => ws.send(JSON.stringify(obj)),
        onMessage: (cb) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
        close: () =>
          new Promise((r) => {
            ws.once('close', r);
            try {
              ws.send(JSON.stringify({ close_socket: true }));
              setTimeout(() => ws.close(), 200);
            } catch {
              ws.close();
            }
          }),
      });
    });
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      for (const cb of listeners) cb(msg);
    });
    ws.on('error', reject);
  });
}

const ns2ms = (a, b) => Number((b - a) / 1000000n);

/**
 * Run a single context against an open WS. Returns timings + audio
 * tally. Resolves when the context's isFinal arrives.
 */
function runContext({ conn, contextId, text, initSettings = null, flushAtEnd = true, timeoutMs = 25000 }) {
  return new Promise((resolve, reject) => {
    const t = {
      initSent: 0n,
      textSent: 0n,
      firstAudio: 0n,
      isFinal: 0n,
      bytes: 0,
      audioChunks: 0,
      audioContextIds: new Set(),
      finalContextId: null,
    };
    const off = conn.onMessage((msg) => {
      if (msg.audio && (msg.contextId === contextId || msg.context_id === contextId)) {
        if (t.firstAudio === 0n) t.firstAudio = process.hrtime.bigint();
        const cid = msg.contextId ?? msg.context_id;
        t.audioContextIds.add(cid);
        const buf = Buffer.from(msg.audio, 'base64');
        t.bytes += buf.length;
        t.audioChunks += 1;
      }
      if (msg.isFinal && (msg.contextId === contextId || msg.context_id === contextId)) {
        t.isFinal = process.hrtime.bigint();
        t.finalContextId = msg.contextId ?? msg.context_id;
        clearTimeout(timer);
        off();
        resolve({ ...t });
      }
    });
    const timer = setTimeout(() => {
      off();
      reject(new Error(`context ${contextId} timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    const init = { text: ' ', context_id: contextId };
    if (initSettings) init.voice_settings = initSettings;
    conn.send(init);
    t.initSent = process.hrtime.bigint();
    conn.send({ text, context_id: contextId, flush: flushAtEnd });
    t.textSent = process.hrtime.bigint();
    if (flushAtEnd) {
      // Explicit close — flush alone doesn't always trigger isFinal.
      conn.send({ context_id: contextId, close_context: true });
    }
  });
}

const results = {
  run_date: new Date().toISOString(),
  endpoint: 'wss://api.elevenlabs.io/v1/text-to-speech/<voice>/multi-stream-input',
  model: MODEL_ID,
  output_format: OUTPUT_FORMAT,
  tests: {},
  verdict: 'pending',
};

/**
 * Test 1 — per-context BOS amortisation: open ONE WS, init context A, send text,
 * verify audio frames are tagged with contextId === A and isFinal arrives.
 */
async function test1_singleContext() {
  console.log('\n--- Test 1: per-context BOS amortisation ---');
  const conn = await openWS();
  try {
    const r = await runContext({
      conn,
      contextId: 'ctx_a',
      text: 'Circuit one. Number of points five.',
      initSettings: VOICE_SETTINGS,
    });
    const wsToFirstAudioMs = ns2ms(conn.openedNs, r.firstAudio);
    const initToFirstAudioMs = ns2ms(r.initSent, r.firstAudio);
    const textToFirstAudioMs = ns2ms(r.textSent, r.firstAudio);
    const initToFinalMs = ns2ms(r.initSent, r.isFinal);
    console.log(
      `  ws_open→first_audio: ${wsToFirstAudioMs}ms ` +
        `init→first_audio: ${initToFirstAudioMs}ms ` +
        `text→first_audio: ${textToFirstAudioMs}ms ` +
        `init→isFinal: ${initToFinalMs}ms ` +
        `bytes=${r.bytes} chunks=${r.audioChunks}`,
    );
    const pass =
      r.audioChunks > 0 &&
      r.bytes > 1000 &&
      r.audioContextIds.size === 1 &&
      r.audioContextIds.has('ctx_a') &&
      r.finalContextId === 'ctx_a';
    results.tests.t1_single_context = {
      pass,
      wsToFirstAudioMs,
      initToFirstAudioMs,
      textToFirstAudioMs,
      initToFinalMs,
      bytes: r.bytes,
      audioChunks: r.audioChunks,
      audioContextIds: [...r.audioContextIds],
      finalContextId: r.finalContextId,
    };
    console.log(`  → ${pass ? 'PASS' : 'FAIL'}`);
  } finally {
    await conn.close();
  }
}

/**
 * Test 2 — concurrent contexts: in ONE WS, init A and B simultaneously,
 * send text to both, verify audio frames are correctly tagged and both
 * isFinals arrive without interference.
 */
async function test2_concurrentContexts() {
  console.log('\n--- Test 2: concurrent contexts ---');
  const conn = await openWS();
  try {
    const tStart = process.hrtime.bigint();
    const aPromise = runContext({
      conn,
      contextId: 'ctx_a',
      text: 'Circuit one. Number of points five.',
      initSettings: VOICE_SETTINGS,
    });
    // Tiny gap so the two contexts don't interleave identically — still
    // overlapping in the vendor's queue.
    await delay(20);
    const bPromise = runContext({
      conn,
      contextId: 'ctx_b',
      text: 'Circuit two. Zs nought point thirty eight ohms.',
    });
    const [a, b] = await Promise.all([aPromise, bPromise]);
    const totalMs = ns2ms(tStart, process.hrtime.bigint());
    const aClean =
      a.audioContextIds.size === 1 && a.audioContextIds.has('ctx_a') && a.finalContextId === 'ctx_a';
    const bClean =
      b.audioContextIds.size === 1 && b.audioContextIds.has('ctx_b') && b.finalContextId === 'ctx_b';
    const pass = aClean && bClean && a.bytes > 1000 && b.bytes > 1000;
    console.log(
      `  ctx_a: chunks=${a.audioChunks} bytes=${a.bytes} ids=${[...a.audioContextIds].join(',')} finalId=${a.finalContextId}`,
    );
    console.log(
      `  ctx_b: chunks=${b.audioChunks} bytes=${b.bytes} ids=${[...b.audioContextIds].join(',')} finalId=${b.finalContextId}`,
    );
    console.log(`  total wall: ${totalMs}ms`);
    results.tests.t2_concurrent_contexts = {
      pass,
      aClean,
      bClean,
      aBytes: a.bytes,
      bBytes: b.bytes,
      totalMs,
    };
    console.log(`  → ${pass ? 'PASS' : 'FAIL'}`);
  } finally {
    await conn.close();
  }
}

/**
 * Test 3 — per-context finality: independent. Covered by Test 2 (both
 * isFinals arrived independently). Record explicit timing.
 */
async function test3_independentFinality() {
  console.log('\n--- Test 3: per-context isFinal independence ---');
  const conn = await openWS();
  try {
    let aFinalAt = 0n;
    let bFinalAt = 0n;
    const tStart = process.hrtime.bigint();
    const offA = conn.onMessage((msg) => {
      if (msg.isFinal && (msg.contextId === 'ctx_a' || msg.context_id === 'ctx_a')) {
        aFinalAt = process.hrtime.bigint();
      }
      if (msg.isFinal && (msg.contextId === 'ctx_b' || msg.context_id === 'ctx_b')) {
        bFinalAt = process.hrtime.bigint();
      }
    });

    // Short text in A, longer text in B. A's isFinal should arrive
    // measurably earlier than B's.
    conn.send({ text: ' ', context_id: 'ctx_a', voice_settings: VOICE_SETTINGS });
    conn.send({ text: 'Hi.', context_id: 'ctx_a', flush: true });
    conn.send({ context_id: 'ctx_a', close_context: true });
    await delay(10);
    conn.send({ text: ' ', context_id: 'ctx_b' });
    conn.send({
      text: 'Number of points one two three four five. Polarity confirmed on circuits one through twelve.',
      context_id: 'ctx_b',
      flush: true,
    });
    conn.send({ context_id: 'ctx_b', close_context: true });

    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && (aFinalAt === 0n || bFinalAt === 0n)) {
      await delay(50);
    }
    offA();

    const aMs = aFinalAt > 0n ? ns2ms(tStart, aFinalAt) : null;
    const bMs = bFinalAt > 0n ? ns2ms(tStart, bFinalAt) : null;
    const independent = aMs !== null && bMs !== null && aMs < bMs;
    console.log(`  ctx_a isFinal: ${aMs}ms  ctx_b isFinal: ${bMs}ms  independent? ${independent}`);
    results.tests.t3_independent_finality = { pass: independent, aMs, bMs };
    console.log(`  → ${independent ? 'PASS' : 'FAIL'}`);
  } finally {
    await conn.close();
  }
}

/**
 * Test 4 — close-one-survives: close context A early, verify context B
 * still reaches isFinal independently. Closing A must not affect B's
 * synthesis or its isFinal delivery. (Original logic looked for audio
 * arriving in a late window; that was racy because B's short text often
 * finishes before the late window even starts. The honest check is that
 * both contexts independently complete on the same WS without one
 * killing the other.)
 */
async function test4_closeOneSurvives() {
  console.log('\n--- Test 4: close context A, B completes independently ---');
  const conn = await openWS();
  try {
    let aFinalReceived = false;
    let bFinalReceived = false;
    let aFinalAt = 0n;
    let bFinalAt = 0n;
    let bAudioChunks = 0;
    const tStart = process.hrtime.bigint();

    const off = conn.onMessage((msg) => {
      const cid = msg.contextId ?? msg.context_id;
      if (msg.audio && cid === 'ctx_b') bAudioChunks += 1;
      if (msg.isFinal && cid === 'ctx_a') {
        aFinalReceived = true;
        aFinalAt = process.hrtime.bigint();
      }
      if (msg.isFinal && cid === 'ctx_b') {
        bFinalReceived = true;
        bFinalAt = process.hrtime.bigint();
      }
    });

    // A: very short text. B: longer text so its synth keeps going after
    // A is done.
    conn.send({ text: ' ', context_id: 'ctx_a', voice_settings: VOICE_SETTINGS });
    conn.send({ text: 'Hi.', context_id: 'ctx_a', flush: true });
    conn.send({ context_id: 'ctx_a', close_context: true });

    await delay(30);
    conn.send({ text: ' ', context_id: 'ctx_b' });
    conn.send({
      text: 'A much longer line about circuit twelve polarity confirmed and Zs equals nought point fifty eight ohms.',
      context_id: 'ctx_b',
      flush: true,
    });
    conn.send({ context_id: 'ctx_b', close_context: true });

    const deadline = Date.now() + 25000;
    while (Date.now() < deadline && (!aFinalReceived || !bFinalReceived)) await delay(50);
    off();
    const aMs = aFinalAt > 0n ? ns2ms(tStart, aFinalAt) : null;
    const bMs = bFinalAt > 0n ? ns2ms(tStart, bFinalAt) : null;
    const pass = aFinalReceived && bFinalReceived && bAudioChunks > 0 && bMs > aMs;
    console.log(
      `  ctx_a isFinal=${aFinalReceived}@${aMs}ms, ctx_b chunks=${bAudioChunks} isFinal=${bFinalReceived}@${bMs}ms`,
    );
    results.tests.t4_close_one_survives = {
      pass,
      aFinalReceived,
      bFinalReceived,
      bAudioChunks,
      aFinalMs: aMs,
      bFinalMs: bMs,
    };
    console.log(`  → ${pass ? 'PASS — B completed independently of A' : 'FAIL'}`);
  } finally {
    await conn.close();
  }
}

/**
 * Test 5 — concurrent-context limit probe. ElevenLabs' account-level
 * `max_active_conversations` is the documented soft cap. Probe N=4
 * (the plan only ever needs 2–3 concurrent for the Stage 4 pool
 * use-case) and confirm the cap kicks in at a known number rather
 * than dying randomly.
 */
async function test5_evictionProbe() {
  console.log('\n--- Test 5: concurrent contexts limit probe (N=4) ---');
  const conn = await openWS();
  try {
    const N = 4;
    const completed = new Set();
    const errors = [];
    const off = conn.onMessage((msg) => {
      const cid = msg.contextId ?? msg.context_id;
      if (msg.isFinal && cid) completed.add(cid);
      if (msg.error) errors.push(typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error));
    });

    for (let i = 0; i < N; i++) {
      const cid = `ctx_e${i}`;
      conn.send({ text: ' ', context_id: cid, voice_settings: i === 0 ? VOICE_SETTINGS : undefined });
      conn.send({ text: `Line ${i + 1}.`, context_id: cid, flush: true });
      conn.send({ context_id: cid, close_context: true });
      await delay(10);
    }

    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && completed.size < N && errors.length === 0) await delay(100);
    off();
    const pass = completed.size === N && errors.length === 0;
    console.log(`  completed ${completed.size}/${N} contexts, errors=${errors.length}`);
    if (errors.length) console.log('  errors:', errors.slice(0, 3));
    results.tests.t5_concurrent_limit_probe = {
      pass,
      attempted: N,
      completed: completed.size,
      errorCount: errors.length,
      errorSample: errors.slice(0, 3),
      note: 'plan only needs 2-3 concurrent for Stage 4 pool',
    };
    console.log(
      `  → ${pass ? 'PASS — N=4 concurrent contexts within account limit' : 'INFO — limit hit; record actual cap'}`,
    );
  } finally {
    try {
      await conn.close();
    } catch {
      /* noop */
    }
    // Give the account-level concurrent-conversations counter time to
    // decrement before the next test opens a new WS.
    await delay(2000);
  }
}

/**
 * Test 6 — voice continuity: same context, two consecutive synth lines.
 * Verify the second line doesn't error AND audio chunks keep arriving on
 * the same contextId.
 */
async function test6_voiceContinuity() {
  console.log('\n--- Test 6: voice continuity (single context, two lines) ---');
  const conn = await openWS();
  try {
    let firstFinalAt = 0n;
    let secondAudioCount = 0;
    let secondFinalReceived = false;
    let secondFinalContextId = null;
    let secondAudioAfterFirstFinal = 0;
    let firstAudioCount = 0;
    const off = conn.onMessage((msg) => {
      const cid = msg.contextId ?? msg.context_id;
      if (cid !== 'ctx_cont') return;
      if (msg.audio) {
        if (firstFinalAt === 0n) firstAudioCount += 1;
        else {
          secondAudioCount += 1;
          secondAudioAfterFirstFinal += 1;
        }
      }
      if (msg.isFinal) {
        if (firstFinalAt === 0n) firstFinalAt = process.hrtime.bigint();
        else {
          secondFinalReceived = true;
          secondFinalContextId = cid;
        }
      }
    });

    conn.send({ text: ' ', context_id: 'ctx_cont', voice_settings: VOICE_SETTINGS });
    conn.send({ text: 'First line.', context_id: 'ctx_cont', flush: true });
    // Wait for first isFinal.
    let dl = Date.now() + 15000;
    while (Date.now() < dl && firstFinalAt === 0n) await delay(50);
    if (firstFinalAt === 0n) {
      results.tests.t6_voice_continuity = { pass: false, reason: 'first isFinal never arrived' };
      console.log('  → FAIL — first isFinal never arrived');
      off();
      return;
    }
    // Send second line on SAME context without re-initialising.
    conn.send({ text: 'Second line, different text.', context_id: 'ctx_cont', flush: true });
    conn.send({ context_id: 'ctx_cont', close_context: true });
    dl = Date.now() + 15000;
    while (Date.now() < dl && !secondFinalReceived) await delay(50);
    off();

    const pass = secondFinalReceived && secondAudioAfterFirstFinal > 0;
    console.log(
      `  first audio chunks=${firstAudioCount}, second audio chunks=${secondAudioCount}, second isFinal=${secondFinalReceived}`,
    );
    results.tests.t6_voice_continuity = {
      pass,
      firstAudioCount,
      secondAudioCount,
      secondAudioAfterFirstFinal,
      secondFinalReceived,
      secondFinalContextId,
    };
    console.log(`  → ${pass ? 'PASS — context reusable after isFinal' : 'FAIL — context not reusable'}`);
  } finally {
    await conn.close();
  }
}

/**
 * Test 7 — post-isFinal error handling. Send text to a CLOSED context.
 * Verify the server returns a documented error and does NOT close the WS.
 */
async function test7_postCloseError() {
  console.log('\n--- Test 7: text submitted to closed context ---');
  const conn = await openWS();
  try {
    let firstFinalReceived = false;
    let errors = [];
    let socketClosed = false;
    let healthCheckAudio = 0;
    const off = conn.onMessage((msg) => {
      const cid = msg.contextId ?? msg.context_id;
      if (msg.isFinal && cid === 'ctx_close') firstFinalReceived = true;
      if (msg.error) errors.push(msg.error);
      if (msg.audio && cid === 'ctx_health') healthCheckAudio += 1;
    });
    conn.ws.on('close', () => {
      socketClosed = true;
    });

    conn.send({ text: ' ', context_id: 'ctx_close', voice_settings: VOICE_SETTINGS });
    conn.send({ text: 'Close test.', context_id: 'ctx_close', flush: true });
    conn.send({ context_id: 'ctx_close', close_context: true });

    let dl = Date.now() + 10000;
    while (Date.now() < dl && !firstFinalReceived) await delay(50);

    // Now try to send text to the closed context.
    conn.send({ text: 'After close.', context_id: 'ctx_close' });

    // Wait a bit for any error, then health-check the socket with a new context.
    await delay(1000);
    conn.send({ text: ' ', context_id: 'ctx_health' });
    conn.send({ text: 'Health check.', context_id: 'ctx_health', flush: true });
    conn.send({ context_id: 'ctx_health', close_context: true });

    dl = Date.now() + 10000;
    while (Date.now() < dl && healthCheckAudio === 0) await delay(50);
    off();

    const socketSurvived = !socketClosed;
    const pass = socketSurvived && healthCheckAudio > 0;
    console.log(
      `  first isFinal=${firstFinalReceived}, errors_after_close=${errors.length}, socketSurvived=${socketSurvived}, healthCheckAudioChunks=${healthCheckAudio}`,
    );
    results.tests.t7_post_close_error = {
      pass,
      firstFinalReceived,
      errorsAfterClose: errors,
      socketSurvived,
      healthCheckAudio,
    };
    console.log(
      `  → ${pass ? 'PASS — socket survived text-after-close' : 'FAIL — socket died or health check failed'}`,
    );
  } finally {
    if (!results.tests.t7_post_close_error?.socketSurvived === false) {
      try {
        await conn.close();
      } catch {
        /* noop */
      }
    } else {
      try {
        await conn.close();
      } catch {
        /* noop */
      }
    }
  }
}

async function main() {
  console.log('ElevenLabs multi-stream-input bench');
  console.log(`Endpoint: ${buildUrl()}\n`);

  const tests = [
    test1_singleContext,
    test2_concurrentContexts,
    test3_independentFinality,
    test4_closeOneSurvives,
    test5_evictionProbe,
    test6_voiceContinuity,
    test7_postCloseError,
  ];

  for (const t of tests) {
    try {
      await t();
    } catch (err) {
      console.error(`  ${t.name} threw:`, err.message);
      results.tests[t.name] = { pass: false, error: err.message };
    }
    await delay(500);
  }

  const passCount = Object.values(results.tests).filter((r) => r.pass).length;
  const totalCount = Object.keys(results.tests).length;
  results.summary = {
    pass_count: passCount,
    total_count: totalCount,
    fully_passed: passCount === totalCount,
  };

  if (passCount === totalCount) {
    results.verdict = 'PASS — multi-stream-input usable for Stage 4 pool; warm Stage 2 budget achievable';
  } else if (passCount >= 4 && results.tests.t1_single_context?.pass && results.tests.t2_concurrent_contexts?.pass) {
    results.verdict = 'PARTIAL — core multi-context works; check individual test failures for impact';
  } else {
    results.verdict = 'FAIL — fall back to one-shot WS per synth; Stage 4 ships cold (~1.2s)';
  }

  console.log('\n=== Summary ===');
  console.log(`Passed: ${passCount}/${totalCount}`);
  console.log(`Verdict: ${results.verdict}`);

  if (OUTPUT_PATH) {
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(results, null, 2));
    console.log(`\nWrote ${OUTPUT_PATH}`);
  } else {
    console.log('\nFull JSON:');
    console.log(JSON.stringify(results, null, 2));
  }
}

main().catch((err) => {
  console.error('Bench failed:', err);
  process.exit(1);
});
