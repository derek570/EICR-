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
 *   Answer channel (2026-07-14, D1/D2 harness extension): configured
 *   responses are now answered IN-TURN. The stub ws reacts to the
 *   dispatcher's `ask_user_started` frame and resolves the registered
 *   tool-call id through the SAME pendingAsks.resolve(toolCallId,
 *   {answered:true, user_text}) channel production's ask_user_answered
 *   path uses (sonnet-stream.js) — while runShadowHarness is still
 *   awaiting. The tool loop therefore continues in the same turn, so
 *   "code follows the answer" probes actually exercise the post-answer
 *   path. (Pre-extension, replies were only dispatched as NEW transcript
 *   turns after the ask had already timed out at 45 s.) An ask with no
 *   matching configured response still blocks to the production timeout;
 *   a response that never matched an in-turn ask falls back to the legacy
 *   post-turn transcript dispatch.
 *
 *   lane: live-advisory            # optional. Scenarios tagged with a `lane`
 *                                  # are SKIPPED by --scenario-dir discovery
 *                                  # unless --lane=<value> is passed.
 *                                  # --scenario=<file> always runs the file.
 *
 *   expect.observations:           # each matcher must be satisfied by ≥1
 *     - code: C2                   #   recorded observation (all constraints
 *       final: true                #   on the SAME observation). `final: true`
 *       text_contains: [socket]    #   matches against last-write-wins state
 *       text_contains_any:         #   per observation_id (post updates /
 *         - thermal                #   post ask replies); default matches the
 *       text_not_contains:         #   full per-turn timeline.
 *         - looks overheated       # text_contains: ALL must appear.
 *       text_not_equals: "..."     # text_contains_any: ≥1 must appear.
 *                                  # text_not_contains: NONE may appear.
 *                                  # text_not_equals: case-insensitive
 *                                  #   trimmed byte-inequality (professional-
 *                                  #   rewording probe: output must differ
 *                                  #   from the dictated remainder).
 *
 *   expect.ask_user:               # per-ask matchers; each entry must match
 *     - question_contains: []      #   ≥1 emitted ask (all fragments on the
 *       question_contains_any:     #   same ask). Same semantics as the
 *         - live parts             #   observation text fields, applied to
 *         - cosmetic               #   the ask's question text.
 *       question_not_contains:
 *         - C2 or C3
 *       reason: observation_confirmation      # optional equality
 *       context_field: observation_clarify    # optional equality
 *
 *   expect.forbid_ask_question_fragments:     # global: NO emitted ask may
 *     - "C2 or C3"                            #   contain any of these.
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
const LANE = args.lane ?? null;
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
// `OPEN: 1` is load-bearing (2026-07-14): the ask dispatcher guards its
// `ask_user_started` emit on `ws.readyState === ws.OPEN`. The pre-extension
// stub had readyState but no OPEN constant, so `1 === undefined` suppressed
// the frame and the in-turn answer channel had nothing to react to.
// `opts.onFrame(msg)` fires for every JSON frame the backend sends — the
// scenario runner uses it to answer asks while the tool loop is blocked.
function makeStubWs(events, opts = {}) {
  return {
    readyState: 1, // OPEN
    OPEN: 1,
    send(payload) {
      let msg = null;
      try {
        msg = JSON.parse(payload);
        events.push({ at: Date.now(), msg });
      } catch {
        events.push({ at: Date.now(), raw: String(payload).slice(0, 200) });
      }
      if (msg && typeof opts.onFrame === 'function') {
        try {
          opts.onFrame(msg);
        } catch {
          // A responder bug must not masquerade as a backend ws failure.
        }
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
// Lane gate (2026-07-14): scenarios tagged `lane: <value>` (e.g. the
// live-advisory D1/D2 behavioural probes) are excluded from --scenario-dir
// discovery unless --lane=<value> is passed. They need a real model and are
// ADVISORY — they must never ride along on a default corpus sweep or any
// deterministic CI lane. A direct --scenario=<file> always runs the file.
function discoverScenarios() {
  if (SCENARIO_PATH) return [SCENARIO_PATH];
  const files = fs
    .readdirSync(SCENARIO_DIR)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .filter((f) => !FILTER || f.includes(FILTER))
    .map((f) => path.join(SCENARIO_DIR, f));
  return files.filter((f) => {
    let lane = null;
    try {
      lane = yaml.load(fs.readFileSync(f, 'utf8'))?.lane ?? null;
    } catch {
      return true; // unparseable file: let runScenario surface the real error
    }
    if (lane == null) return LANE == null; // untagged scenarios only run on the default lane
    if (lane === LANE) return true;
    process.stderr.write(`↷ skipping ${path.basename(f)} (lane: ${lane}; pass --lane=${lane} to run)\n`);
    return false;
  });
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
// Shared fragment semantics for observation-text and ask-question matchers
// (D1/D2 harness extension, 2026-07-14). All matching is case-insensitive.
function matchTextConstraints(text, want) {
  const t = (text ?? '').toLowerCase();
  if (Array.isArray(want.contains)) {
    for (const frag of want.contains) {
      if (!t.includes(String(frag).toLowerCase())) return false;
    }
  }
  if (Array.isArray(want.contains_any) && want.contains_any.length > 0) {
    const hit = want.contains_any.some((frag) => t.includes(String(frag).toLowerCase()));
    if (!hit) return false;
  }
  if (Array.isArray(want.not_contains)) {
    for (const frag of want.not_contains) {
      if (t.includes(String(frag).toLowerCase())) return false;
    }
  }
  if (want.not_equals != null) {
    if (t.trim() === String(want.not_equals).toLowerCase().trim()) return false;
  }
  return true;
}

function evaluateExpectations(expect, ctx) {
  const failures = [];
  const {
    askUsers,
    readings,
    toolCalls,
    lbEntries,
    transcriptCount,
    observations = [],
    finalObservations = [],
  } = ctx;

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

  // Observation matchers (D1/D2 harness extension). Each matcher must be
  // satisfied by at least ONE observation — every constraint on the SAME
  // observation. `final: true` matches against last-write-wins state per
  // observation_id (post updates / post ask replies); default matches every
  // per-turn emission.
  if (Array.isArray(expect.observations)) {
    for (const want of expect.observations) {
      const pool = want.final === true ? finalObservations : observations;
      const hit = pool.find((obs) => {
        if (want.code != null && String(obs.code ?? '').toUpperCase() !== String(want.code).toUpperCase()) {
          return false;
        }
        return matchTextConstraints(obs.text, {
          contains: want.text_contains,
          contains_any: want.text_contains_any,
          not_contains: want.text_not_contains,
          not_equals: want.text_not_equals,
        });
      });
      if (!hit) {
        const actual =
          pool.map((o) => `[${o.code ?? '?'}] "${(o.text ?? '').slice(0, 80)}"`).join('; ') || 'none';
        failures.push(
          `observations${want.final ? ' (final)' : ''} unmatched: ${JSON.stringify(want)} | actual: ${actual}`,
        );
      }
    }
  }

  // Per-ask question matchers. Each entry must match ≥1 emitted ask (all
  // constraints on the same ask).
  if (Array.isArray(expect.ask_user)) {
    for (const want of expect.ask_user) {
      const hit = askUsers.find((a) => {
        if (want.reason != null && a.reason !== want.reason) return false;
        if (want.context_field != null && a.context_field !== want.context_field) return false;
        return matchTextConstraints(a.question, {
          contains: want.question_contains,
          contains_any: want.question_contains_any,
          not_contains: want.question_not_contains,
        });
      });
      if (!hit) {
        const actual = askUsers.map((a) => `"${(a.question ?? '').slice(0, 80)}"`).join('; ') || 'none';
        failures.push(`ask_user unmatched: ${JSON.stringify(want)} | actual: ${actual}`);
      }
    }
  }

  // Global forbidden question fragments — NO emitted ask may contain any.
  // (A matcher-level question_not_contains only constrains the matched ask;
  // this constrains every ask — e.g. the banned bare "C2 or C3?" wording.)
  if (Array.isArray(expect.forbid_ask_question_fragments)) {
    for (const frag of expect.forbid_ask_question_fragments) {
      const hit = askUsers.find((a) =>
        (a.question ?? '').toLowerCase().includes(String(frag).toLowerCase()),
      );
      if (hit) {
        failures.push(
          `forbid_ask_question_fragments: "${frag}" appeared in ask "${(hit.question ?? '').slice(0, 100)}"`,
        );
      }
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
  const readings = [];
  const observations = []; // per-turn timeline: record_observation emissions + observation updates
  const pendingAsks = createPendingAsksRegistry();
  const answeredInTurn = new Set(); // tool_call_ids resolved via the in-turn channel
  const inTurnAnswers = []; // audit trail for the JSON report

  // In-turn ask answering (D1/D2 harness extension, 2026-07-14). The ask
  // dispatcher registers the pendingAsks entry BEFORE it emits
  // `ask_user_started` (stage6-dispatcher-ask.js step 3b → 3c), so by the
  // time this frame reaches the stub the registry entry is live and the
  // dispatcher is (about to be) awaiting it. Resolving through
  // pendingAsks.resolve(toolCallId, {answered:true, user_text}) is EXACTLY
  // production's ask_user_answered path (sonnet-stream.js), so the tool
  // loop resumes in the same turn and Sonnet sees the answer in the
  // tool_result — a "code follows the answer" probe now tests the real
  // post-answer path instead of a post-timeout transcript re-dispatch.
  // setTimeout (never synchronous resolve) keeps us out of the dispatcher's
  // emit path; the wait is capped like the legacy reply path — we don't
  // need real-time.
  const ws = makeStubWs(wsEvents, {
    onFrame(msg) {
      if (msg?.type !== 'ask_user_started' || !msg.tool_call_id) return;
      const resp = findAskUserResponse(scenario, msg);
      if (!resp) return;
      const delay = Math.min(resp.at_ms_after_ask ?? 1000, 250);
      setTimeout(() => {
        const resolved = pendingAsks.resolve(msg.tool_call_id, {
          answered: true,
          user_text: resp.text,
        });
        if (resolved) {
          answeredInTurn.add(msg.tool_call_id);
          inTurnAnswers.push({
            tool_call_id: msg.tool_call_id,
            question: msg.question ?? null,
            reply_text: resp.text,
          });
          process.stderr.write(`    ↳ in-turn ask reply: "${resp.text}"\n`);
        }
      }, delay);
    },
  });
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
    // Observation capture (D1/D2 harness extension). `observations` is the
    // legacy-wire-renamed shape ({observation_id, code, observation_text, …});
    // `observationUpdates` (RULE-6 edit path) re-uses the original
    // observation_id with the corrected code/text. Both land on one timeline
    // so the evaluator can compute last-write-wins final state per id.
    for (const o of result?.observations ?? []) {
      observations.push({
        turn: turnIndex,
        observation_id: o.observation_id ?? null,
        code: o.code ?? null,
        text: o.observation_text ?? '',
        location: o.item_location ?? null,
      });
    }
    for (const o of result?.observationUpdates ?? []) {
      observations.push({
        turn: turnIndex,
        observation_id: o.observation_id ?? null,
        code: o.code ?? null,
        text: o.observation_text ?? '',
        location: o.item_location ?? null,
        update: true,
      });
    }

    // Legacy post-turn reply path: only for asks the in-turn channel did NOT
    // answer (e.g. an ask emitted without an ask_user_started frame — the
    // fallbackToLegacy suppression path). In-turn-answered asks are skipped
    // here or the same reply would double-dispatch as a fresh transcript.
    const newAskUsers = buckets.askUsers.slice(askUsersSeenAtTurnStart);
    for (const ask of newAskUsers) {
      if (ask.tool_call_id && answeredInTurn.has(ask.tool_call_id)) continue;
      const resp = findAskUserResponse(scenario, ask);
      if (resp) {
        const delay = resp.at_ms_after_ask ?? 1000;
        await new Promise((res) => setTimeout(res, Math.min(delay, 250))); // cap the simulated wait at 250ms; we don't need real-time
        process.stderr.write(`    ↳ ask_user reply (post-turn transcript): "${resp.text}"\n`);
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
  // INTENTIONALLY DO NOT restore the Console transport between
  // scenarios. ElevenLabs synth callbacks resolve asynchronously and
  // can emit Winston log lines well after the scenario returns; with
  // the Console transport reattached those lines hit stdout and break
  // the orchestrator's `extractJsonArray` heuristic (which expects the
  // first `[` to be the JSON results array). File transports stay
  // omitted too — the orchestrator's parser is the only consumer of
  // stdout, and the memory transport on the NEXT scenario will pick
  // up its own events fresh. (Pre-fix this restore/remove cycle
  // produced the `Failed to parse harness output as JSON` error
  // intermittently — see voice-regression-report.md commits 2026-05-24
  // onward.) `removedTransports` is still captured so a future fix
  // can restore globally at process-exit if a CI consumer ever
  // needs the post-run logs.
  void removedTransports;

  // Last-write-wins final observation state per observation_id. Entries
  // without an id (defensive — the dispatcher always assigns one) key by
  // timeline position so they still surface individually.
  const finalById = new Map();
  observations.forEach((o, i) => finalById.set(o.observation_id ?? `__anon_${i}`, o));
  const finalObservations = [...finalById.values()];

  const failures = evaluateExpectations(scenario.expect ?? {}, {
    toolCalls: buckets.toolCalls,
    askUsers: buckets.askUsers,
    readings,
    observations,
    finalObservations,
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
    in_turn_answers: inTurnAnswers,
    observations,
    final_observations: finalObservations,
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

// Write the JSON to stdout, then SET exitCode rather than calling
// process.exit(). process.exit() terminates synchronously even when
// stdout is a pipe with pending async writes — under
// `execSync(..., {stdio:['ignore','pipe','inherit']})` the orchestrator
// receives an empty/truncated stdout buffer and falls into the
// "no JSON array found in harness stdout" branch despite the harness
// having produced clean JSON. Setting exitCode lets Node exit
// naturally after the event loop drains, including the stdout pipe.
process.stdout.write(JSON.stringify(results, null, 2) + '\n');
const failed = results.filter((r) => !r.pass).length;
process.stderr.write(`\n=== ${results.length - failed}/${results.length} pass ===\n`);
process.exitCode = failed === 0 ? 0 : 1;
