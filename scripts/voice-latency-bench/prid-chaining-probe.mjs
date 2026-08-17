#!/usr/bin/env node
// prid-chaining-probe.mjs — sized the previous_response_id candidate from 08C-B (PR #190).
//
// RESULT (2026-08-17, gpt-5.6-luna, n=12/arm): CANDIDATE DISPROVED. A 205x smaller request
// payload (146,383 B -> 713 B) moved p50 first-text by ~13 ms and TTFB by ~0 ms; the chained
// call still runs the full cached prefill server-side (cached_tokens ~29.7k both arms).
// Evidence: .planning/voice-latency-conversational-2026-07-31/evidence-08c-b-prid-probe-2026-08-17.json
// Kept re-runnable in case a future provider transport change reopens the question.
// Usage: OPENAI_API_KEY=... node scripts/voice-latency-bench/prid-chaining-probe.mjs
//        (PROBE_MODEL / PROBE_REPS / PROBE_PACE_MS override; keep pace >= 12000 ms — both
//        arms bill ~30k tokens/req against the org's 200k TPM cap on gpt-5.6-luna.)
// Two interleaved arms against the REAL OpenAI Responses API, terminal-round shape:
//   FULL  — production shape: full input every call (dev prefix + convo + tool result),
//           explicit prompt_cache_key (mirrors openai-responses-adapter.js)
//   CHAIN — previous_response_id = parent, input = [function_call_output] only
// Metrics per rep: ttfb (first body byte), first SSE event, first output item,
// first text delta, total, usage (incl. cached_tokens), request body bytes.
// Caveat recorded in output: absolute values include dev-Mac→OpenAI network, not
// ECS→OpenAI; the ARM DELTA on one connection is the signal.

import { performance } from 'node:perf_hooks';

const API_KEY = process.env.OPENAI_API_KEY;
if (!API_KEY) { console.error('OPENAI_API_KEY missing'); process.exit(2); }
const MODEL = process.env.PROBE_MODEL || 'gpt-5.6-luna';
const REPS = Number(process.env.PROBE_REPS || 12);
const PACE_MS = Number(process.env.PROBE_PACE_MS || 2500);
const BASE = 'https://api.openai.com/v1';

// ---------- prefix: deterministic, ~35.7k tokens (~143k chars) ----------
const PARA =
  'You are the CertMate live extraction engine for BS 7671 electrical inspection dictation. ' +
  'Inspectors dictate circuit test readings: earth fault loop impedance Zs in ohms, insulation ' +
  'resistance in megohms, RCD trip times in milliseconds, continuity R1+R2 in ohms, prospective ' +
  'fault current in kiloamps. Each reading must be scoped to a circuit on the selected board and ' +
  'written exactly once. Structurally complete readings are written regardless of confidence and ' +
  'read back aloud, never silently dropped. Ask only for structural gaps, contradictions, invalid ' +
  'or out-of-range values, or true non-values. ';
const FILLER_TARGET_CHARS = 143_000;
let filler = '';
let i = 0;
while (filler.length < FILLER_TARGET_CHARS) {
  filler += `Section ${i++}. ${PARA}`;
}
const STABLE_PREFIX =
  filler +
  '\nOperational rule for this probe: when you receive a function_call_output (tool result), ' +
  'reply with exactly the word DONE and nothing else. Do not call further tools.';

const TOOLS = [
  {
    type: 'function',
    name: 'record_reading',
    description: 'Record a dictated test reading against a circuit on the selected board.',
    parameters: {
      type: 'object',
      properties: {
        field: { type: 'string', description: 'e.g. measured_zs_ohm' },
        circuit: { type: 'string' },
        value: { type: 'number' },
      },
      required: ['field', 'circuit', 'value'],
      additionalProperties: false,
    },
  },
];

const DEV_MESSAGE = {
  role: 'developer',
  content: [
    {
      type: 'input_text',
      text: STABLE_PREFIX,
      prompt_cache_breakpoint: { mode: 'explicit' },
    },
  ],
};
const USER_MESSAGE = { role: 'user', content: 'Ring final thirty two amp, Zs nought point four two.' };
const CACHE_KEY = 'prid-probe-v1-' + MODEL;

// ---------- SSE streaming request with fine-grained timing ----------
async function streamOnce(body) {
  const payload = JSON.stringify({ ...body, stream: true });
  const t0 = performance.now();
  const res = await fetch(`${BASE}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: payload,
  });
  const tHeaders = performance.now();
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`HTTP ${res.status}: ${errText.slice(0, 800)}`);
  }
  const m = {
    bytes: Buffer.byteLength(payload),
    headers_ms: tHeaders - t0,
    ttfb_ms: null,
    first_event_ms: null,
    first_output_item_ms: null,
    first_text_ms: null,
    total_ms: null,
    usage: null,
    response_id: null,
    output_kinds: [],
    text: '',
  };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (m.ttfb_ms == null) m.ttfb_ms = performance.now() - t0;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) continue;
      const data = dataLine.slice(6);
      if (data === '[DONE]') continue;
      let ev;
      try { ev = JSON.parse(data); } catch { continue; }
      const now = performance.now() - t0;
      if (m.first_event_ms == null) m.first_event_ms = now;
      if (ev.type === 'response.output_item.added') {
        if (m.first_output_item_ms == null) m.first_output_item_ms = now;
        m.output_kinds.push(ev.item?.type);
      }
      if (ev.type === 'response.output_text.delta' && m.first_text_ms == null) m.first_text_ms = now;
      if (ev.type === 'response.output_text.delta') m.text += ev.delta ?? '';
      if (ev.type === 'response.completed') {
        m.total_ms = now;
        m.usage = ev.response?.usage ?? null;
        m.response_id = ev.response?.id ?? null;
      }
      if (ev.type === 'error' || ev.type === 'response.failed') {
        throw new Error('stream error: ' + JSON.stringify(ev).slice(0, 500));
      }
    }
  }
  if (m.total_ms == null) m.total_ms = performance.now() - t0;
  return m;
}

async function createParent() {
  // Non-streaming parent: full prefix + user msg, forced tool call, store default (unset).
  const res = await fetch(`${BASE}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      input: [DEV_MESSAGE, USER_MESSAGE],
      tools: TOOLS,
      tool_choice: { type: 'function', name: 'record_reading' },
      max_output_tokens: 8192,
      reasoning: { effort: 'low' },
      prompt_cache_key: CACHE_KEY,
      prompt_cache_options: { mode: 'explicit' },
    }),
  });
  if (!res.ok) throw new Error(`parent HTTP ${res.status}: ${(await res.text()).slice(0, 800)}`);
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, p50: Math.round(q(0.5)), p90: Math.round(q(0.9)), min: Math.round(s[0]), max: Math.round(s[s.length - 1]) };
};

// ---------- main ----------
const parent = await createParent();
const fnCall = parent.output.find((o) => o.type === 'function_call');
if (!fnCall) { console.error('parent produced no function_call:', JSON.stringify(parent.output).slice(0, 500)); process.exit(2); }
console.log(`parent ${parent.id} | usage ${JSON.stringify(parent.usage)} | output kinds ${parent.output.map((o) => o.type).join(',')}`);

// Empirical store-default check: is the parent retrievable?
const getRes = await fetch(`${BASE}/responses/${parent.id}`, { headers: { authorization: `Bearer ${API_KEY}` } });
console.log(`store-default check: GET /responses/{id} -> HTTP ${getRes.status} (200 = stored, org retains by default)`);

// Echoable history for FULL arm: parent's reasoning/function_call items verbatim.
const echoItems = parent.output.filter((o) => o.type === 'reasoning' || o.type === 'function_call');
const FN_OUTPUT = { type: 'function_call_output', call_id: fnCall.call_id, output: JSON.stringify({ ok: true, written: 'measured_zs_ohm=0.42' }) };

const fullBody = () => ({
  model: MODEL,
  input: [DEV_MESSAGE, USER_MESSAGE, ...echoItems, FN_OUTPUT],
  tools: TOOLS,
  tool_choice: 'auto',
  max_output_tokens: 8192,
  reasoning: { effort: 'low' },
  prompt_cache_key: CACHE_KEY,
  prompt_cache_options: { mode: 'explicit' },
});
const chainBody = () => ({
  model: MODEL,
  previous_response_id: parent.id,
  input: [FN_OUTPUT],
  tools: TOOLS,
  tool_choice: 'auto',
  max_output_tokens: 8192,
  reasoning: { effort: 'low' },
});

// Warmup (1 each, discarded — writes the prompt cache for FULL, primes CHAIN path).
for (const [name, mk] of [['FULL', fullBody], ['CHAIN', chainBody]]) {
  try {
    const w = await streamOnce(mk());
    console.log(`warmup ${name}: total ${Math.round(w.total_ms)}ms, cached ${w.usage?.input_tokens_details?.cached_tokens}, text="${w.text.trim()}"`);
  } catch (e) {
    console.error(`warmup ${name} FAILED: ${e.message}`);
    process.exit(2);
  }
  await sleep(PACE_MS);
}

const results = { FULL: [], CHAIN: [] };
for (let rep = 0; rep < REPS; rep++) {
  const pair = [['FULL', fullBody], ['CHAIN', chainBody]];
  if (rep % 2 === 1) pair.reverse(); // alternate order to cancel time-of-run drift
  for (const [name, mk] of pair) {
    try {
      const r = await streamOnce(mk());
      results[name].push(r);
      console.log(
        `rep ${rep + 1} ${name.padEnd(5)} ttfb ${Math.round(r.ttfb_ms)} firstItem ${Math.round(r.first_output_item_ms ?? -1)} firstText ${Math.round(r.first_text_ms ?? -1)} total ${Math.round(r.total_ms)} cached ${r.usage?.input_tokens_details?.cached_tokens ?? '?'} in ${r.usage?.input_tokens ?? '?'} out ${r.usage?.output_tokens ?? '?'} bytes ${r.bytes} text="${r.text.trim().slice(0, 20)}"`
      );
    } catch (e) {
      console.error(`rep ${rep + 1} ${name} FAILED: ${e.message}`);
    }
    await sleep(PACE_MS);
  }
}

console.log('\n===== SUMMARY =====');
for (const name of ['FULL', 'CHAIN']) {
  const rs = results[name];
  if (!rs.length) { console.log(`${name}: no successful reps`); continue; }
  console.log(`${name}: reqBytes ${rs[0].bytes}`);
  for (const k of ['ttfb_ms', 'first_output_item_ms', 'first_text_ms', 'total_ms']) {
    const xs = rs.map((r) => r[k]).filter((v) => v != null);
    if (xs.length) console.log(`  ${k}: ${JSON.stringify(stats(xs))}`);
  }
  const cached = rs.map((r) => r.usage?.input_tokens_details?.cached_tokens ?? 0);
  const input = rs.map((r) => r.usage?.input_tokens ?? 0);
  console.log(`  cached_tokens: min ${Math.min(...cached)} max ${Math.max(...cached)} | input_tokens: min ${Math.min(...input)} max ${Math.max(...input)}`);
}
console.log('\nfull JSON written to results file');
const fs = await import('node:fs');
fs.writeFileSync(new URL('./prid-probe-results.json', import.meta.url), JSON.stringify({ model: MODEL, parent_usage: parent.usage, results }, null, 2));
