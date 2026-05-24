#!/usr/bin/env node
/**
 * Direct (no-HTTP) transcript-replay runner.
 *
 * Drives the same Stage 6 session machinery the production WS handler
 * uses (runShadowHarness with toolCallsMode='live'), but bypasses HTTP,
 * WebSocket, auth, and DB. Pulls ANTHROPIC_API_KEY from AWS Secrets
 * Manager and replays YAML scenarios against the real Sonnet model.
 *
 * Why this exists vs scripts/voice-latency-bench/transcript-replay.mjs:
 * the HTTP harness needs a running backend with a reachable Postgres,
 * which is locked to the VPC for the prod RDS. Local Postgres setup
 * would dwarf the test cost. The HTTP layer is not what we're testing
 * — what we care about is "given transcript X, what tool calls does
 * Sonnet emit?" — so we skip it.
 *
 * Scenario schema: same YAML format as tests/fixtures/voice-latency-
 * scenarios/SCHEMA.md (subset — we don't fetch TTS).
 *
 * Usage:
 *   node scripts/voice-latency-bench/transcript-replay-direct.mjs \
 *     --scenario=tests/fixtures/voice-latency-scenarios/baseline/new_circuit_then_readings.yaml
 *
 *   # Or a glob/directory:
 *   node scripts/voice-latency-bench/transcript-replay-direct.mjs \
 *     --scenario-dir=tests/fixtures/voice-latency-scenarios/baseline \
 *     --filter=designation
 *
 * Exit code: 0 if all assertions pass; 1 if any fail; 2 on setup error.
 */

import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

const SCENARIO_PATH = args.scenario ?? null;
const SCENARIO_DIR = args['scenario-dir'] ?? null;
const FILTER = args.filter ?? null;
const VERBOSE = !!args.verbose;

if (!SCENARIO_PATH && !SCENARIO_DIR) {
  console.error('Usage: --scenario=<path> OR --scenario-dir=<dir> [--filter=<substr>]');
  process.exit(2);
}

// --- Anthropic key ---------------------------------------------------------
function getAnthropicKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const raw = execSync(
    "aws secretsmanager get-secret-value --secret-id eicr/api-keys --region eu-west-2 --query SecretString --output text",
    { stdio: ['ignore', 'pipe', 'pipe'] }
  ).toString('utf8');
  const k = JSON.parse(raw).ANTHROPIC_API_KEY;
  if (!k) throw new Error('ANTHROPIC_API_KEY not found in eicr/api-keys');
  return k;
}

// --- Stub ws + capture buffer ---------------------------------------------
function makeStubWs(events) {
  return {
    readyState: 1, // OPEN
    send(payload) {
      try {
        const msg = JSON.parse(payload);
        events.push({ at: Date.now(), msg });
      } catch {
        events.push({ at: Date.now(), raw: String(payload).slice(0, 200) });
      }
    },
    on() {},
    off() {},
    removeListener() {},
  };
}

// --- Tool-call sniffing logger --------------------------------------------
function makeCapturingLogger(toolCalls, askUsers, divergences) {
  function sink(level) {
    return (msgOrObj, maybeMeta) => {
      // logger.info('stage6_tool_call', {...})
      if (typeof msgOrObj === 'string') {
        if (msgOrObj === 'stage6_tool_call' && maybeMeta) toolCalls.push(maybeMeta);
        if (msgOrObj === 'stage6.ask_user' && maybeMeta) askUsers.push(maybeMeta);
        if (VERBOSE) console.error(`[${level}] ${msgOrObj}`, maybeMeta ?? '');
      } else if (msgOrObj && typeof msgOrObj === 'object') {
        if (msgOrObj.message === 'stage6_tool_call') toolCalls.push(msgOrObj);
        if (msgOrObj.message === 'stage6.ask_user') askUsers.push(msgOrObj);
        if (VERBOSE) console.error(`[${level}]`, msgOrObj);
      }
    };
  }
  return {
    info: sink('info'),
    warn: sink('warn'),
    error: sink('error'),
    debug: sink('debug'),
  };
}

// --- Scenario discovery ---------------------------------------------------
function discoverScenarios() {
  if (SCENARIO_PATH) return [SCENARIO_PATH];
  const files = fs
    .readdirSync(SCENARIO_DIR)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .filter((f) => !FILTER || f.includes(FILTER))
    .map((f) => path.join(SCENARIO_DIR, f));
  return files;
}

// --- Assertion runner -----------------------------------------------------
function evaluateExpectations(expect, ctx) {
  const failures = [];
  const { toolCalls, askUsers, readings } = ctx;

  if (expect.extraction_count) {
    const got = ctx.transcriptCount;
    if (expect.extraction_count.min != null && got < expect.extraction_count.min) {
      failures.push(`extraction_count.min=${expect.extraction_count.min}, got ${got}`);
    }
    if (expect.extraction_count.max != null && got > expect.extraction_count.max) {
      failures.push(`extraction_count.max=${expect.extraction_count.max}, got ${got}`);
    }
  }

  if (Array.isArray(expect.has_reading)) {
    for (const want of expect.has_reading) {
      const hit = readings.find(
        (r) =>
          Number(r.circuit) === Number(want.circuit) &&
          r.field === want.field &&
          (want.value == null ||
            String(r.value).trim() === String(want.value).trim() ||
            Number(r.value) === Number(want.value)),
      );
      if (!hit) {
        const actual = readings
          .map((r) => `c${r.circuit}.${r.field}=${r.value}`)
          .join(', ') || 'none';
        failures.push(
          `has_reading missing: c${want.circuit}.${want.field}=${want.value ?? '*'} | actual: [${actual}]`,
        );
      }
    }
  }

  if (expect.ask_user_count) {
    const got = askUsers.length;
    if (expect.ask_user_count.min != null && got < expect.ask_user_count.min) {
      failures.push(`ask_user_count.min=${expect.ask_user_count.min}, got ${got}`);
    }
    if (expect.ask_user_count.max != null && got > expect.ask_user_count.max) {
      failures.push(
        `ask_user_count.max=${expect.ask_user_count.max}, got ${got} (questions: ${askUsers
          .map((a) => `"${a.question?.slice(0, 60) ?? '?'}"`)
          .join(', ')})`,
      );
    }
  }

  return failures;
}

// --- Single scenario run --------------------------------------------------
async function runScenario(scenarioPath, apiKey) {
  const scenario = yaml.load(fs.readFileSync(scenarioPath, 'utf8'));
  const start = Date.now();
  process.stderr.write(`\n→ ${scenario.name}\n`);

  // Lazy-import after env is set (Anthropic client is constructed at session
  // construction; we already have the key).
  process.env.ANTHROPIC_API_KEY = apiKey;
  process.env.SONNET_TOOL_CALLS = 'live'; // see eicr-extraction-session.js:_resolveToolCallsMode
  const { EICRExtractionSession } = await import(
    new URL('../../src/extraction/eicr-extraction-session.js', import.meta.url).href
  );
  const { runShadowHarness } = await import(
    new URL('../../src/extraction/stage6-shadow-harness.js', import.meta.url).href
  );
  const { createPendingAsksRegistry } = await import(
    new URL('../../src/extraction/stage6-pending-asks-registry.js', import.meta.url).href
  );

  const sessionId = `harness_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const session = new EICRExtractionSession(apiKey, sessionId, 'eicr', {
    toolCallsMode: 'live',
  });

  // Convert YAML job_state → iOS-style jobState shape that
  // _seedStateFromJobState expects.
  const jobState = {
    boards: (scenario.job_state?.boards ?? []).map((b) => ({ ...b })),
    circuits: (scenario.job_state?.circuits ?? []).map((c) => ({ ...c })),
    certificateType: 'eicr',
  };
  session.start(jobState);

  // Capture buffers
  const wsEvents = [];
  const ws = makeStubWs(wsEvents);
  const toolCalls = [];
  const askUsers = [];
  const divergences = [];
  const readings = [];
  const pendingAsks = createPendingAsksRegistry();

  // Replay each transcript, awaiting in order. The session uses internal
  // batching but BATCH_SIZE=1 case + immediate await still produces one
  // extraction per call. We sort by at_ms then send sequentially.
  const sorted = (scenario.transcript ?? []).slice().sort((a, b) => (a.at_ms ?? 0) - (b.at_ms ?? 0));

  for (const t of sorted) {
    process.stderr.write(`  · t=${t.at_ms ?? 0}ms "${t.text}"\n`);
    let result;
    try {
      result = await runShadowHarness(session, t.text, t.regexResults ?? [], {
        confirmationsEnabled: false,
        pendingAsks,
        ws,
        logger: makeCapturingLogger(toolCalls, askUsers, divergences),
      });
    } catch (err) {
      process.stderr.write(`    ERR: ${err.message}\n`);
      throw err;
    }
    // Flush batched buffer — extractFromUtterance batches by default, but
    // runShadowHarness routes directly into runLiveMode in 'live' mode
    // (skips the legacy batch path). Result.extracted_readings is the
    // per-turn merged output.
    for (const r of result?.extracted_readings ?? []) {
      readings.push({ circuit: r.circuit, field: r.field, value: r.value });
    }
  }

  // Drain — the BATCH_TIMEOUT_MS path won't fire here because live mode
  // doesn't batch, but we await any pending microtasks just in case.
  await new Promise((res) => setTimeout(res, 50));

  const failures = evaluateExpectations(scenario.expect ?? {}, {
    toolCalls,
    askUsers,
    readings,
    transcriptCount: sorted.length,
  });

  const pass = failures.length === 0;
  const elapsed_ms = Date.now() - start;
  const finalCircuits = session.stateSnapshot?.circuits ?? {};
  process.stderr.write(`  ${pass ? '✓' : '✗'} ${pass ? 'pass' : 'FAIL'} in ${elapsed_ms}ms\n`);
  if (!pass) for (const f of failures) process.stderr.write(`    - ${f}\n`);
  return {
    name: scenario.name,
    pass,
    failures,
    elapsed_ms,
    tool_calls: toolCalls.map((t) => ({
      tool: t.tool,
      outcome: t.outcome,
      input_summary: t.input_summary,
      validation_error: t.validation_error,
    })),
    ask_users: askUsers.map((a) => ({
      question: a.question,
      reason: a.reason,
      context_field: a.context_field,
      context_circuit: a.context_circuit,
    })),
    final_circuits: finalCircuits,
    readings,
  };
}

// --- Main -----------------------------------------------------------------
const apiKey = getAnthropicKey();
const scenarios = discoverScenarios();
if (scenarios.length === 0) {
  console.error('No scenarios found.');
  process.exit(2);
}

const results = [];
for (const s of scenarios) {
  try {
    results.push(await runScenario(s, apiKey));
  } catch (err) {
    results.push({ name: path.basename(s), pass: false, failures: [`runtime: ${err.message}`] });
  }
}

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass).length;
process.stderr.write(`\n=== ${results.length - failed}/${results.length} pass ===\n`);
process.exit(failed === 0 ? 0 : 1);
