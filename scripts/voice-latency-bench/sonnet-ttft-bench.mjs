#!/usr/bin/env node
/**
 * Stage 0.B — Anthropic Sonnet 4.6 TTFT bench.
 *
 * Pass criterion (PLAN_v3 §3.B): P50 cached TTFT ≤ 900 ms.
 * Also measured (Codex v2 NI1): p99 Sonnet completion (TTFT + finalisation).
 * That p99 sets the suppression TTL in Stage 3 §6.3.
 *
 * Method:
 *   1. Build a representative messages array (~prod-shape: cached system
 *      prompt with a state snapshot, two-three user/assistant turns, a
 *      forced record_extraction tool call).
 *   2. Open `messages.stream` against claude-sonnet-4-6.
 *   3. Record TTFT = wall-clock(first content_block_start event) - request_start.
 *      Record completion = wall-clock(message_stop) - request_start.
 *   4. Repeat N times sequentially (default 20), skip iteration 1's TTFT
 *      from the cached aggregate (warm-up), report P50/P95/p99 for both
 *      hops.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... node scripts/voice-latency-bench/sonnet-ttft-bench.mjs
 *
 * Optional flags:
 *   --iters=N          number of stream calls (default 20)
 *   --output=path.json append JSON result to file (default stdout only)
 *
 * Output: STAGE0_RESULTS_TUNING.md row.
 */

import Anthropic from '@anthropic-ai/sdk';
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

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('Set ANTHROPIC_API_KEY in the environment.');
  process.exit(2);
}

const client = new Anthropic({ apiKey });

// Representative system prompt — small enough to keep the bench cheap,
// large enough to populate the cache. ~1.5k tokens of canned prompt
// matches the agentic-mode header size in the live extractor without
// pulling in the full production prompt (which references many internal
// helpers and would need the runtime state to assemble).
const SYSTEM_HEADER = `You are an EICR data extraction assistant. Output JSON via the
record_extraction tool. Available circuit fields: number_of_points,
measured_zs_ohm, r1_r2_ohm, polarity_confirmed, ir_live_live_mohm,
ir_live_earth_mohm. Apply RULE 1 (explicit value → extract directly)
and RULE 2 (clarify before recording). Never guess.`.repeat(8);

const SNAPSHOT = `STATE SNAPSHOT (compact):
BOARD main: 12 circuits.
  circuit 1: lighting, B6,  zs=0.42, polarity=true,  ir_ll=200, ir_le=200
  circuit 2: lighting, B6,  zs=null, polarity=null,  ir_ll=null, ir_le=null
  circuit 3: ring,     B32, zs=0.31, polarity=true,  ir_ll=200, ir_le=200
  circuit 4: ring,     B32, zs=null, polarity=null,  ir_ll=null, ir_le=null
  circuit 5: shower,   B40, zs=null, polarity=null,  ir_ll=null, ir_le=null
  circuit 6: cooker,   B32, zs=0.27, polarity=true,  ir_ll=200, ir_le=200
  ...`.repeat(2);

const SYSTEM = [
  {
    type: 'text',
    text: SYSTEM_HEADER,
    cache_control: { type: 'ephemeral', ttl: '5m' },
  },
  {
    type: 'text',
    text: SNAPSHOT,
    cache_control: { type: 'ephemeral', ttl: '5m' },
  },
];

const RECORD_EXTRACTION_TOOL = {
  name: 'record_extraction',
  description: 'Record extracted circuit readings or ask the inspector.',
  input_schema: {
    type: 'object',
    properties: {
      circuit_writes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            circuit: { type: 'integer' },
            field: { type: 'string' },
            value: { type: ['string', 'number', 'boolean', 'null'] },
          },
          required: ['circuit', 'field', 'value'],
        },
      },
      ask_user: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          context_field: { type: 'string' },
        },
      },
    },
  },
};

const MESSAGES = [
  {
    role: 'user',
    content: [
      {
        type: 'text',
        text: 'circuit 2 zs nought point three eight ohms.',
      },
    ],
  },
];

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(Math.max(Math.floor(sorted.length * p), 0), sorted.length - 1);
  return sorted[idx];
}

async function runOne(iter) {
  const t0 = process.hrtime.bigint();
  let firstEventAt = null;
  let firstContentAt = null;
  let messageStopAt = null;
  let cacheRead = 0;
  let cacheCreated = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  const stream = await client.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 256,
    system: SYSTEM,
    messages: MESSAGES,
    tools: [RECORD_EXTRACTION_TOOL],
    tool_choice: { type: 'tool', name: 'record_extraction' },
  });

  for await (const event of stream) {
    if (firstEventAt === null) firstEventAt = process.hrtime.bigint();
    if (event.type === 'content_block_start' && firstContentAt === null) {
      firstContentAt = process.hrtime.bigint();
    }
    if (event.type === 'message_delta' && event.usage) {
      outputTokens = event.usage.output_tokens ?? outputTokens;
    }
    if (event.type === 'message_start' && event.message?.usage) {
      const u = event.message.usage;
      inputTokens = u.input_tokens ?? 0;
      cacheRead = u.cache_read_input_tokens ?? 0;
      cacheCreated = u.cache_creation_input_tokens ?? 0;
    }
    if (event.type === 'message_stop') {
      messageStopAt = process.hrtime.bigint();
    }
  }

  const ns2ms = (a) => (a === null ? null : Number((a - t0) / 1000000n));

  return {
    iter,
    firstEventMs: ns2ms(firstEventAt),
    firstContentMs: ns2ms(firstContentAt), // TTFT proper
    completionMs: ns2ms(messageStopAt),
    cacheReadTokens: cacheRead,
    cacheCreatedTokens: cacheCreated,
    inputTokens,
    outputTokens,
  };
}

async function main() {
  console.log(`Sonnet TTFT bench: ${ITERS} iterations, model=claude-sonnet-4-6`);
  const results = [];
  for (let i = 1; i <= ITERS; i++) {
    try {
      const r = await runOne(i);
      results.push(r);
      console.log(
        `  iter ${String(i).padStart(2, '0')}: TTFT=${String(r.firstContentMs).padStart(4, ' ')}ms ` +
          `completion=${String(r.completionMs).padStart(4, ' ')}ms ` +
          `cache_read=${r.cacheReadTokens} cache_created=${r.cacheCreatedTokens} ` +
          `in=${r.inputTokens} out=${r.outputTokens}`,
      );
    } catch (err) {
      console.error(`  iter ${i}: FAILED — ${err.message}`);
      results.push({ iter: i, error: err.message });
    }
    // 200ms gap between calls. Keeps the bench cheap and lets the
    // server-side cache settle without thrashing.
    await delay(200);
  }

  // Iteration 1 is the cold/warm-up TTFT (cache miss likely). Exclude
  // it from the "cached" aggregate.
  const cachedRuns = results.slice(1).filter((r) => r.firstContentMs !== null);
  const allRuns = results.filter((r) => r.firstContentMs !== null);

  const ttft = cachedRuns.map((r) => r.firstContentMs);
  const completion = cachedRuns.map((r) => r.completionMs).filter((v) => v != null);
  const cold = results[0] ?? {};

  const summary = {
    iterations: ITERS,
    successes: allRuns.length,
    failures: results.filter((r) => r.error).length,
    cold_ttft_ms: cold.firstContentMs ?? null,
    cold_completion_ms: cold.completionMs ?? null,
    cold_cache_read_tokens: cold.cacheReadTokens ?? null,
    cached_ttft_p50_ms: percentile(ttft, 0.5),
    cached_ttft_p95_ms: percentile(ttft, 0.95),
    cached_ttft_p99_ms: percentile(ttft, 0.99),
    cached_completion_p50_ms: percentile(completion, 0.5),
    cached_completion_p95_ms: percentile(completion, 0.95),
    cached_completion_p99_ms: percentile(completion, 0.99),
    pass_ttft_p50_le_900ms: percentile(ttft, 0.5) !== null && percentile(ttft, 0.5) <= 900,
    suggested_suppression_ttl_ms: Math.max(
      12000,
      Math.ceil((percentile(completion, 0.99) ?? 0) + 2000),
    ),
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
