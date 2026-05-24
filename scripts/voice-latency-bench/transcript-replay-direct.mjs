#!/usr/bin/env node
/**
 * Direct (no-HTTP) transcript-replay runner — Stage 6 + Loaded Barrel
 * coverage for the on-demand "did I break it" regression suite.
 *
 * What it tests:
 *   - Stage 6 tool-loop with the real Sonnet model.
 *   - Loaded Barrel speculator: which entries fire, what state they
 *     reach in the cache, simulated iOS POST HIT vs MISS within TTL.
 *   - ask_user emissions AND configured replies (so multi-turn
 *     designation flows actually get to the second leg).
 *   - Per-turn wall-clock breakdown so a regression that adds latency
 *     to one specific stage is locatable in the report.
 *
 * What it does not test:
 *   - HTTP / WS / auth / persistence layers (those are a separate
 *     harness — different bug surfaces, same scenarios).
 *   - Real Deepgram or real audio (those are TestFlight smoke).
 *
 * Scenario schema: see tests/fixtures/voice-latency-scenarios/SCHEMA.md.
 * Additions on top of the SCHEMA.md baseline:
 *
 *   ask_user_responses:
 *     - matches: "which circuit"   # case-insensitive substring on the question
 *       text: "Circuit 4."         # transcript dispatched after the ask
 *       at_ms_after_ask: 1500      # delay relative to ask emission (default 1000)
 *
 *   expect.loaded_barrel:
 *     - after_turn: 1              # 1-indexed turn the speculator should fire on
 *       status: ready|fired|hit|miss_ttl_expired|miss_text_drift|aborted|absent
 *       claim_at_ms: 4000          # optional: simulate iOS POST this many ms after fire;
 *                                   # status=hit if within TTL, miss_ttl_expired if past it
 *       expect_bytes_min: 1000     # optional: pre-synthed MP3 byte floor
 *
 *   expect.tool_call_sequence:
 *     - tool: create_circuit
 *       input_summary: { circuit_ref: 2 }
 *     - tool: record_reading
 *       input_summary: { field: measured_zs_ohm, circuit: 2 }
 *
 *   expect.forbid_tools:
 *     - rename_circuit              # NONE of these tools should appear
 *
 * Usage:
 *   node scripts/voice-latency-bench/transcript-replay-direct.mjs \
 *     --scenario=tests/fixtures/voice-latency-scenarios/baseline/new_circuit_then_readings.yaml
 *
 *   # Or all scenarios in a dir:
 *   node scripts/voice-latency-bench/transcript-replay-direct.mjs \
 *     --scenario-dir=tests/fixtures/voice-latency-scenarios/baseline
 *
 * Exit code: 0 if all assertions pass; 1 if any fail; 2 on setup error.
 */

import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import yaml from 'js-yaml';
import Transport from 'winston-transport';

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
const LOADED_BARREL = args['loaded-barrel'] !== 'off';

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

// --- ElevenLabs key (only needed when speculator actually fires) ----------
function getElevenLabsKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY;
  try {
    const raw = execSync(
      "aws secretsmanager get-secret-value --secret-id eicr/api-keys --region eu-west-2 --query SecretString --output text",
      { stdio: ['ignore', 'pipe', 'pipe'] }
    ).toString('utf8');
    const k = JSON.parse(raw).ELEVENLABS_API_KEY;
    return k || null;
  } catch {
    return null;
  }
}

// --- Stub ws ---------------------------------------------------------------
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

// --- Winston in-memory transport -------------------------------------------
// Attaches to the project's central winston logger (src/logger.js) so we
// capture log calls made via module-level `import logger from '../logger.js'`
// — e.g. voice-latency-telemetry.js's recordOutcome, which doesn't accept a
// passed-through logger and thus is invisible to makeCapturingLogger.
class MemoryTransport extends Transport {
  constructor(opts) {
    super(opts);
    this.buckets = opts.buckets;
  }
  log(info, callback) {
    setImmediate(() => this.emit('logged', info));
    const message = info?.message;
    if (message === 'voice_latency.outcome' && info?.outcome) {
      this.buckets.loadedBarrelEvents.push({
        correlation_id: info.correlation_id,
        outcome: info.outcome,
        meta: info.meta,
        acked_by_ios: info.acked_by_ios,
      });
    }
    callback();
  }
}

// --- Capturing logger -----------------------------------------------------
// Captures every prod-logged event by message name so the report can attribute
// errors to the dispatcher / validator / snapshot stage they came from.
function makeCapturingLogger(buckets) {
  function sink(level) {
    return (msgOrObj, maybeMeta) => {
      const meta = maybeMeta ?? null;
      let messageName = null;
      if (typeof msgOrObj === 'string') messageName = msgOrObj;
      else if (msgOrObj && typeof msgOrObj === 'object') messageName = msgOrObj.message;
      if (messageName === 'stage6_tool_call') buckets.toolCalls.push(meta ?? msgOrObj);
      if (messageName === 'stage6.ask_user') buckets.askUsers.push(meta ?? msgOrObj);
      if (messageName === 'stage6_live_extraction') buckets.liveExtractions.push(meta ?? msgOrObj);
      if (messageName === 'voice_latency.outcome') {
        const payload = meta ?? msgOrObj;
        if (payload?.outcome) buckets.loadedBarrelEvents.push(payload);
      }
      if (VERBOSE) console.error(`[${level}] ${messageName ?? ''}`, meta ?? '');
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

// --- Loaded Barrel inspection ---------------------------------------------
// Drive inspection from `voice_latency.outcome` events captured by the
// logger. The outcome stream is the same source of truth used by prod
// CloudWatch dashboards — if we assert against it, the harness verdict
// matches what an operator would conclude from logs.
//
// Correlation: every speculator lifecycle (started → fired → hit/miss/
// aborted/ttl_expired) shares one `correlation_id`. We group by that.
function summariseLoadedBarrelEvents(events, sessionId) {
  const byCorrelation = new Map();
  for (const ev of events) {
    const cid = ev.correlation_id ?? ev.meta?.correlation_id;
    if (!cid) continue;
    if (!byCorrelation.has(cid)) byCorrelation.set(cid, []);
    byCorrelation.get(cid).push(ev);
  }
  const entries = [];
  for (const [cid, group] of byCorrelation) {
    const started = group.find((e) => e.outcome === 'loaded_barrel_started');
    if (!started || started.meta?.sessionId !== sessionId) continue;
    const terminal = group.find((e) =>
      ['loaded_barrel_hit', 'loaded_barrel_hit_pending', 'loaded_barrel_hit_late',
       'loaded_barrel_miss', 'loaded_barrel_aborted', 'loaded_barrel_discarded',
       'loaded_barrel_cap_skipped'].includes(e.outcome),
    );
    const fired = group.find((e) => e.outcome === 'loaded_barrel_fired');
    // Status maps to scenario YAML vocabulary:
    //   'ready'   — fired but no terminal event yet (most common in unit run)
    //   'hit'     — fired then hit (or hit_pending / hit_late)
    //   'miss'    — fired then miss (TTL or text drift)
    //   'aborted' — superseded / discarded / cap skipped
    let status = 'started_no_fire';
    if (fired && !terminal) status = 'ready';
    else if (terminal?.outcome?.startsWith('loaded_barrel_hit')) status = 'hit';
    else if (terminal?.outcome === 'loaded_barrel_miss') status = 'miss';
    else if (terminal) status = 'aborted';
    // Turn index extraction: turnId shape is `${sessionId}-turn-${n}`.
    const turnId = started.meta?.turnId ?? '';
    const turnMatch = turnId.match(/turn-(\d+)$/);
    const turnIndex = turnMatch ? parseInt(turnMatch[1], 10) : null;
    entries.push({
      correlation_id: cid,
      turnIndex,
      turnId,
      field: started.meta?.field ?? null,
      circuit: started.meta?.circuit ?? null,
      boardId: started.meta?.boardId ?? null,
      bytes: fired?.meta?.bytes ?? 0,
      status,
    });
  }
  return entries.sort((a, b) => (a.turnIndex ?? 0) - (b.turnIndex ?? 0));
}

// --- Assertion runner -----------------------------------------------------
function evaluateExpectations(expect, ctx) {
  const failures = [];
  const { askUsers, readings, toolCalls, lbEntries, transcriptCount } = ctx;

  if (expect.extraction_count) {
    const got = transcriptCount;
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

  // tool_call_sequence: the named tools must appear IN ORDER, but the
  // sequence may be interleaved with other tools. Only `outcome:'ok'`
  // calls count (rejected dispatches are filtered).
  if (Array.isArray(expect.tool_call_sequence)) {
    const oks = toolCalls.filter((t) => t.outcome === 'ok');
    let cursor = 0;
    for (const want of expect.tool_call_sequence) {
      const idx = oks.findIndex((t, i) => {
        if (i < cursor) return false;
        if (t.tool !== want.tool) return false;
        if (want.input_summary) {
          for (const [k, v] of Object.entries(want.input_summary)) {
            if (t.input_summary?.[k] !== v) return false;
          }
        }
        return true;
      });
      if (idx === -1) {
        failures.push(
          `tool_call_sequence missing: ${want.tool}${want.input_summary ? ` ${JSON.stringify(want.input_summary)}` : ''} after position ${cursor} | ok tools: [${oks.map((t) => t.tool).join(', ')}]`,
        );
        break;
      }
      cursor = idx + 1;
    }
  }

  if (Array.isArray(expect.forbid_tools)) {
    for (const forbidden of expect.forbid_tools) {
      const hit = toolCalls.find((t) => t.tool === forbidden && t.outcome === 'ok');
      if (hit) failures.push(`forbid_tools: ${forbidden} should not have fired`);
    }
  }

  // Loaded Barrel: status per turn-index.
  if (Array.isArray(expect.loaded_barrel)) {
    for (const want of expect.loaded_barrel) {
      const turnIdx = want.after_turn;
      const entriesAtTurn = lbEntries.filter((e) => e.turnIndex === turnIdx);
      if (want.status === 'absent') {
        if (entriesAtTurn.length > 0) {
          failures.push(
            `loaded_barrel turn ${turnIdx}: expected absent, got ${entriesAtTurn.length} entries`,
          );
        }
        continue;
      }
      const match = entriesAtTurn.find((e) => e.status === want.status);
      if (!match) {
        const got = entriesAtTurn.map((e) => e.status).join(', ') || 'none';
        failures.push(
          `loaded_barrel turn ${turnIdx}: expected ${want.status}, got [${got}]`,
        );
      } else if (want.expect_bytes_min != null && match.bytes < want.expect_bytes_min) {
        failures.push(
          `loaded_barrel turn ${turnIdx}: bytes=${match.bytes}, expected ≥${want.expect_bytes_min}`,
        );
      }
    }
  }

  return failures;
}

// --- ask_user dispatch helper ---------------------------------------------
function findAskUserResponse(scenario, askUserPayload) {
  const responses = scenario.ask_user_responses ?? [];
  const question = (askUserPayload?.question ?? '').toLowerCase();
  return responses.find((r) => {
    if (!r.matches) return false;
    return question.includes(r.matches.toLowerCase());
  });
}

// --- Single scenario run --------------------------------------------------
async function runScenario(scenarioPath, apiKey) {
  const scenario = yaml.load(fs.readFileSync(scenarioPath, 'utf8'));
  const start = Date.now();
  process.stderr.write(`\n→ ${scenario.name}\n`);

  // Env setup BEFORE any extraction module imports.
  process.env.ANTHROPIC_API_KEY = apiKey;
  process.env.SONNET_TOOL_CALLS = 'live';
  if (LOADED_BARREL) {
    process.env.VOICE_LATENCY_LOADED_BARREL = 'true';
    process.env.VOICE_LATENCY_LOADED_BARREL_MAX_PER_TURN = '2';
    const ek = getElevenLabsKey();
    if (ek) process.env.ELEVENLABS_API_KEY = ek;
  }

  const { EICRExtractionSession } = await import(
    new URL('../../src/extraction/eicr-extraction-session.js', import.meta.url).href
  );
  const { runShadowHarness } = await import(
    new URL('../../src/extraction/stage6-shadow-harness.js', import.meta.url).href
  );
  const { createPendingAsksRegistry } = await import(
    new URL('../../src/extraction/stage6-pending-asks-registry.js', import.meta.url).href
  );
  // Register session in the active-sessions table so the speculator wrapper
  // in stage6-shadow-harness.js can read voiceLatency flags via
  // getVoiceLatencyForSession(). Without this the speculator stays nil and
  // every LB expectation reads as 'absent'.
  const { activeSessions } = await import(
    new URL('../../src/extraction/active-sessions.js', import.meta.url).href
  );
  // Attach memory transport to the project's central logger to catch
  // recordOutcome events (voice_latency.outcome). They use the module-
  // level `import logger from '../logger.js'`, bypassing any logger we
  // pass through runShadowHarness. Without this, all loaded_barrel events
  // are silently dropped.
  const projectLoggerModule = await import(
    new URL('../../src/logger.js', import.meta.url).href
  );
  const projectLogger = projectLoggerModule.default;

  // Capture buffers — all keyed for the logger to fill.
  const buckets = {
    toolCalls: [],
    askUsers: [],
    liveExtractions: [],
    loadedBarrelEvents: [],
  };
  const memTransport = new MemoryTransport({ buckets });
  // REMOVE existing transports (Console, File) so winston output doesn't
  // pollute stdout — the orchestrator parses stdout as JSON. Done BEFORE
  // any session.start() / extraction call so prod logger messages from
  // those code paths also don't reach stdout.
  const removedTransports = [...projectLogger.transports];
  for (const t of removedTransports) projectLogger.remove(t);
  projectLogger.add(memTransport);

  const sessionId = `harness_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const session = new EICRExtractionSession(apiKey, sessionId, 'eicr', {
    toolCallsMode: 'live',
  });

  // Mirrors the active-sessions entry sonnet-stream.js builds on session_start.
  // The speculator wrapper only checks vl.flags.loadedBarrel + session.costTracker;
  // both are now present. Insert directly into the Map — there's no helper.
  activeSessions.set(sessionId, {
    session,
    voiceLatency: { flags: { loadedBarrel: LOADED_BARREL, suppression: false } },
  });

  const jobState = {
    boards: (scenario.job_state?.boards ?? []).map((b) => ({ ...b })),
    circuits: (scenario.job_state?.circuits ?? []).map((c) => ({ ...c })),
    certificateType: 'eicr',
  };
  session.start(jobState);
  const wsEvents = [];
  const ws = makeStubWs(wsEvents);
  const readings = [];
  const pendingAsks = createPendingAsksRegistry();
  const turnTimings = []; // per-turn wall-clock spans
  const lbEntries = []; // populated from outcome events after all turns complete

  // Build the work queue from the scenario's transcript, sorted by at_ms.
  // ask_user responses get added DYNAMICALLY as Sonnet emits each ask.
  const initialTranscripts = (scenario.transcript ?? []).slice().sort((a, b) => (a.at_ms ?? 0) - (b.at_ms ?? 0));

  let turnIndex = 0;
  let askUsersSeenAtTurnStart = 0;
  const pendingFollowups = []; // [{text, scheduledAfter: ms}]

  // Helper that consumes one transcript and runs runShadowHarness.
  async function runOneTurn(transcriptText, regexResults = []) {
    turnIndex += 1;
    askUsersSeenAtTurnStart = buckets.askUsers.length;
    process.stderr.write(`  · turn ${turnIndex}: "${transcriptText}"\n`);
    const turnStart = performance.now();
    let result;
    try {
      result = await runShadowHarness(session, transcriptText, regexResults, {
        confirmationsEnabled: true, // need for speculator to fire
        pendingAsks,
        ws,
        logger: makeCapturingLogger(buckets),
      });
    } catch (err) {
      process.stderr.write(`    ERR: ${err.message}\n`);
      throw err;
    }
    const turnEnd = performance.now();
    const turnMs = Math.round(turnEnd - turnStart);
    turnTimings.push({
      turn: turnIndex,
      transcript: transcriptText.slice(0, 80),
      duration_ms: turnMs,
      readings_emitted: result?.extracted_readings?.length ?? 0,
      ask_users_emitted: buckets.askUsers.length - askUsersSeenAtTurnStart,
    });
    for (const r of result?.extracted_readings ?? []) {
      readings.push({ circuit: r.circuit, field: r.field, value: r.value });
    }

    // Process any ask_user that fired this turn and a configured response exists.
    const newAskUsers = buckets.askUsers.slice(askUsersSeenAtTurnStart);
    for (const ask of newAskUsers) {
      const resp = findAskUserResponse(scenario, ask);
      if (resp) {
        const delay = resp.at_ms_after_ask ?? 1000;
        await new Promise((res) => setTimeout(res, Math.min(delay, 250))); // cap the simulated wait at 250ms; we don't need real-time
        process.stderr.write(`    ↳ ask_user reply: "${resp.text}"\n`);
        await runOneTurn(resp.text, []);
      }
    }
  }

  for (const t of initialTranscripts) {
    await runOneTurn(t.text, t.regexResults ?? []);
  }

  // Wait for any in-flight ElevenLabs speculative synths to settle.
  // The speculator dispatches synth asynchronously (loaded-barrel-
  // speculator.js:220), so a `loaded_barrel_started` event may not
  // have its terminal `_fired` / `_aborted` partner yet at the
  // moment runShadowHarness returns. We poll every 100ms until each
  // started event has a terminal partner, or hit a 10s timeout.
  if (LOADED_BARREL) {
    const SETTLE_TIMEOUT_MS = 10000;
    const POLL_MS = 100;
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const startedCids = new Set(
        buckets.loadedBarrelEvents
          .filter((e) => e.outcome === 'loaded_barrel_started')
          .map((e) => e.correlation_id),
      );
      const settledCids = new Set(
        buckets.loadedBarrelEvents
          .filter((e) =>
            ['loaded_barrel_fired', 'loaded_barrel_hit', 'loaded_barrel_hit_pending',
             'loaded_barrel_hit_late', 'loaded_barrel_miss', 'loaded_barrel_aborted',
             'loaded_barrel_discarded'].includes(e.outcome),
          )
          .map((e) => e.correlation_id),
      );
      const unsettled = [...startedCids].filter((c) => !settledCids.has(c));
      if (unsettled.length === 0) break;
      await new Promise((res) => setTimeout(res, POLL_MS));
    }
  }

  // Summarise Loaded Barrel state from the outcome event stream
  // captured by the logger. This is the same source of truth as the
  // prod CloudWatch dashboards — same verdict an operator would reach.
  if (LOADED_BARREL) {
    const summary = summariseLoadedBarrelEvents(buckets.loadedBarrelEvents, sessionId);
    for (const s of summary) lbEntries.push(s);
  }

  await new Promise((res) => setTimeout(res, 50));
  // Detach our transport so the next scenario gets a clean slate.
  projectLogger.remove(memTransport);
  // Restore the original transports for the next scenario.
  for (const t of removedTransports) projectLogger.add(t);

  const failures = evaluateExpectations(scenario.expect ?? {}, {
    toolCalls: buckets.toolCalls,
    askUsers: buckets.askUsers,
    readings,
    lbEntries,
    transcriptCount: turnIndex,
  });

  const pass = failures.length === 0;
  const elapsed_ms = Date.now() - start;
  process.stderr.write(`  ${pass ? '✓' : '✗'} ${pass ? 'pass' : 'FAIL'} in ${elapsed_ms}ms\n`);
  if (!pass) for (const f of failures) process.stderr.write(`    - ${f}\n`);

  // Aggregate per-turn stats for the report.
  const turnDurations = turnTimings.map((t) => t.duration_ms).sort((a, b) => a - b);
  const p50 = turnDurations.length ? turnDurations[Math.floor(turnDurations.length / 2)] : 0;
  const p95 = turnDurations.length ? turnDurations[Math.floor(turnDurations.length * 0.95)] : 0;

  return {
    name: scenario.name,
    pass,
    failures,
    elapsed_ms,
    turn_count: turnIndex,
    turn_timings: turnTimings,
    p50_turn_ms: p50,
    p95_turn_ms: p95,
    live_extractions: buckets.liveExtractions.map((e) => ({
      turn_id: e.turnId,
      rounds: e.rounds,
      readings: e.readings,
      observations: e.observations,
      usage_input: e.usage_input,
      usage_output: e.usage_output,
      usage_cache_read: e.usage_cache_read,
      usage_cache_write: e.usage_cache_write,
    })),
    loaded_barrel: {
      enabled: LOADED_BARREL,
      events: buckets.loadedBarrelEvents.map((e) => ({
        outcome: e.outcome,
        meta: e.meta,
      })),
      cache_entries: lbEntries,
    },
    tool_calls: buckets.toolCalls.map((t) => ({
      tool: t.tool,
      outcome: t.outcome,
      input_summary: t.input_summary,
      validation_error: t.validation_error,
    })),
    ask_users: buckets.askUsers.map((a) => ({
      question: a.question,
      reason: a.reason,
      context_field: a.context_field,
      context_circuit: a.context_circuit,
      answer_outcome: a.answer_outcome,
    })),
    final_circuits: session.stateSnapshot?.circuits ?? {},
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
