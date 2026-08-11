#!/usr/bin/env node
/**
 * production-path-bench.mjs — Plan 08C-A production-path live latency
 * benchmark runner.
 *
 * Drives the REAL production tool-loop call chain — no mocks, no bare
 * `runToolLoop` shortcut — for three "snapshot shape" arms so a 3-arm
 * randomised-block benchmark can measure whether `circuitOrder`/
 * `snapshotRecentCircuits` move per-round token cost or round count:
 *
 *   recent_3  (default) — production default construction. No
 *             `circuitOrder`/`snapshotRecentCircuits` override.
 *   ascending            — `{ circuitOrder: 'ascending' }` (existing,
 *             already-shipped resolver, `eicr-extraction-session.js:1519`).
 *   window_6             — `{ snapshotRecentCircuits: 6 }` (the constructor-
 *             latched benchmark seam added for this plan,
 *             `eicr-extraction-session.js:1195`). `circuitOrder` stays
 *             default (`recent_3`) — this arm widens the WINDOW, not the
 *             ordering mode.
 *
 * Call chain driven (verified in this worktree, see stage6-shadow-harness.js
 * and stage6-tool-loop.js): `runShadowHarness(session, transcriptText,
 * regexResults, options)` -> `runLiveMode` -> real `runToolLoop` -> real
 * dispatcher (`createWriteDispatcher`/`createToolDispatcher`,
 * stage6-dispatchers*.js) -> bundler (stage6-event-bundler.js) -> audibility
 * net -> wire frames via `options.ws.send()`. Loaded Barrel (ElevenLabs
 * speculative TTS) is deliberately DISABLED for this bench — it is orthogonal
 * to the per-round LLM cost/latency levers 08C-A measures, and skipping it
 * removes an ElevenLabs API-key requirement and a source of synthesis-latency
 * noise unrelated to the circuitOrder/snapshotRecentCircuits question.
 *
 * ---------------------------------------------------------------------------
 * Why a NEW file rather than extending transcript-replay-direct-runner.mjs
 * ---------------------------------------------------------------------------
 * transcript-replay-direct-runner.mjs exports only `runLegacyCli` and
 * `runFieldCorpusCli` — both are top-level CLI entry points, not a reusable
 * per-turn "drive one production turn and return captured telemetry" helper.
 * Its `runScenario()`/`makeCapturingLogger()`/`makeStubWs()` are internal
 * (not exported) and built around ONE assertion-evaluating scenario run, not
 * a randomised-block multi-arm sweep with a persistent session across many
 * turns and a JSON evidence-array accumulator. Refactoring that file to
 * export reusable pieces would touch a file two OTHER concurrent agents in
 * this worktree are editing right now (per the task brief) — this file
 * mirrors its CONSTRUCTION PATTERN (stub ws, capturing logger, ask-answer
 * in-turn resolution via pendingAsks, AWS Secrets Manager key fallback)
 * byte-for-byte in spirit, but is a clean, independent module.
 *
 * ---------------------------------------------------------------------------
 * Required environment
 * ---------------------------------------------------------------------------
 *   OPENAI_API_KEY     — required when SONNET_EXTRACT_MODEL names a gpt-*
 *                         model (prod default: gpt-5.6-luna — see
 *                         ecs/task-def-backend.json). This is the common case.
 *   ANTHROPIC_API_KEY   — required when SONNET_EXTRACT_MODEL names a
 *                         claude-* model (only relevant if a caller
 *                         overrides SONNET_EXTRACT_MODEL locally).
 * If NEITHER is set, both are fetched from AWS Secrets Manager
 * (`eicr/api-keys`, eu-west-2) — same fallback pattern as
 * transcript-replay-direct-runner.mjs's getAnthropicKey(). Requires AWS
 * creds on the caller's machine.
 *
 * ---------------------------------------------------------------------------
 * CLI
 * ---------------------------------------------------------------------------
 *   --fixture=<path>      Repeatable. A single YAML fixture file OR a
 *                         directory (non-recursive *.yaml/*.yml glob).
 *   --arm=<name>          Repeatable. One of: recent_3 | ascending | window_6.
 *                         Defaults to all three when omitted.
 *   --reps=<n>            Repetitions per (fixture, arm) pair. Default 10.
 *   --output=<path>        Required. Where to write the JSON evidence array.
 *   --block-seed=<n>      Seed for the reproducible block-order shuffle.
 *                         Default 42 (always echoed to stderr + recorded in
 *                         each evidence row's env block).
 *   --dry-run              Smoke-test mode: clamps to 1 fixture, 1 arm
 *                         (the first requested, or `recent_3`), 1 rep —
 *                         still makes REAL API calls (this is not a mock),
 *                         just the minimum needed to prove the wiring works.
 *   --verbose              Echo captured log-row names to stderr as they land.
 *   --help                 Print this usage block and exit 0.
 *
 * Example:
 *   node scripts/voice-latency-bench/production-path-bench.mjs \
 *     --fixture=tests/fixtures/voice-latency-scenarios/bench-08c-a \
 *     --arm=recent_3 --arm=ascending --arm=window_6 \
 *     --reps=10 --output=/tmp/08c-a-bench.json
 *
 * ---------------------------------------------------------------------------
 * Randomised BLOCK execution
 * ---------------------------------------------------------------------------
 * For EACH fixture independently, for each block index 0..reps-1: all
 * requested arms run ONCE each, in a seeded-random order within the block
 * (never "all of arm A's reps, then all of arm B's" — that would confound
 * arm differences with any time-of-day/vendor-load drift). Every rep in a
 * block shares one `block_id` (`<fixture_id>:block<idx>`) so paired
 * within-block differences are computable downstream.
 *
 * ---------------------------------------------------------------------------
 * Round-index attribution — the one non-obvious mechanism in this file
 * ---------------------------------------------------------------------------
 * `stage6_tool_call` rows carry a `round` field that is a PER-DISPATCHER-
 * CLOSURE call counter (`let round = 0; round += 1` in
 * `createWriteDispatcher`/`createToolDispatcher`, stage6-dispatchers.js) —
 * it counts every dispatched call across the WHOLE turn, not the agentic
 * loop's round_idx, and `ask_user` calls never emit a `stage6_tool_call` row
 * at all (they go through `logAskUser` only, so `tool_call_count_per_round`
 * — which counts ALL streamed tool_use records, asks included — can
 * legitimately exceed the count of `stage6_tool_call` rows for a round).
 * A naive cumulative-count bucket assignment against `tool_call_count_per_round`
 * therefore mis-attributes any round that mixes an ask with a write.
 *
 * This runner instead correlates by WALL-CLOCK WINDOW: every captured
 * `stage6_tool_call` row is timestamped with `process.hrtime.bigint()` at
 * the moment the capturing logger's sink observes it (same process, so
 * directly comparable to the round timings' own hrtime-based
 * `stream_complete_ns`/`dispatch_complete_ns`, unlike Date.now() which
 * cannot be compared to hrtime deltas). `assignRoundIdx()` finds the round
 * whose `[stream_complete_ns, dispatch_complete_ns]` window contains the
 * capture timestamp; failing an exact window match (dispatch is
 * occasionally still in flight when the sink fires) it falls back to the
 * nearest round by absolute distance to `dispatch_complete_ns`. The
 * dispatcher-closure `round` field is still captured verbatim as
 * `dispatcher_round` for reference/chronological-ordering-within-a-turn use,
 * but is NEVER used for round-API attribution.
 *
 * ---------------------------------------------------------------------------
 * `voice_latency.turn_core_summary` — bypasses the passed-through logger
 * ---------------------------------------------------------------------------
 * `emitTurnCoreSummary()` (voice-latency-turn-summary.js) calls the
 * project's central Winston logger (`import logger from '../logger.js'`)
 * directly — NOT the `options.logger` threaded through `runShadowHarness`.
 * (Same discovery transcript-replay-direct-runner.mjs's header comment
 * documents for `voice_latency.outcome` / the loaded-barrel speculator.)
 * This runner attaches a `winston-transport` MemoryTransport to the real
 * project logger for the duration of each repetition to catch these rows —
 * `stage6_tool_call`/`stage6_tool_call_raw_input`/`stage6.ask_user`/
 * `stage6_live_extraction` all DO flow through `options.logger` and are
 * captured by the plain capturing-logger sink instead.
 *
 * ---------------------------------------------------------------------------
 * `emitted_audible_frame` — an honest limitation
 * ---------------------------------------------------------------------------
 * The wire's `extraction.result.confirmations[]` entries are NOT keyed by
 * `tool_call_id` (see certmate-voice-wire-protocol skill §4) — they carry
 * `{field, circuit, circuits?, board_id?}`. This runner matches a write
 * dispatch's `input_summary.{field,circuit}` against confirmations captured
 * on this turn's `extraction` ws frame(s); `ask_user` calls match directly
 * via `tool_call_id` on the `ask_user_started` frame (which IS keyed).
 * Tool calls with neither a field/circuit input_summary shape nor an
 * ask_user tool_call_id (create_circuit, rename_circuit, add_board, ...)
 * are left with `emitted_audible_frame: null` — not because nothing was
 * said, but because this runner cannot cheaply prove it. Documented rather
 * than guessed.
 *
 * ---------------------------------------------------------------------------
 * `cache` — interpretation of an ambiguous spec line
 * ---------------------------------------------------------------------------
 * The evidence-object spec listed `cache: { key_id, outcome, fresh_input_tokens,
 * ... per turn }` at the top level while also saying "per turn" — read here
 * as: `cache` is an ARRAY, one entry per turn, built from that turn's LAST
 * round's `round_usage[].prompt_cache` sub-object (`{mode, key_id,
 * breakpoint_enabled}`) plus that round's token counts. `mode` is whatever
 * the live adapter reports (`explicit` cache write/read/miss variants for
 * OpenAI Luna, or null for Anthropic) — never invented.
 */

import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import Transport from 'winston-transport';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Arm definitions (plan 08C-A)
// ---------------------------------------------------------------------------
const ARMS = {
  recent_3: {},
  ascending: { circuitOrder: 'ascending' },
  window_6: { snapshotRecentCircuits: 6 },
};
const ARM_NAMES = Object.keys(ARMS);

// Write-tool names (WRITE_DISPATCHERS keys, stage6-dispatchers.js) — used
// ONLY to classify `applied_mutation` in the ledger. Kept as a local mirror
// (not imported) because this is bench-evidence classification, not
// production behaviour; if the set drifts, the ledger's applied_mutation
// column is the only thing affected, not any product path.
const WRITE_TOOL_NAMES = new Set([
  'record_reading',
  'clear_reading',
  'create_circuit',
  'rename_circuit',
  'record_observation',
  'delete_observation',
  'record_board_reading',
  'start_dialogue_script',
  'delete_circuit',
  'calculate_zs',
  'calculate_r1_plus_r2',
  'set_field_for_all_circuits',
  'add_board',
  'select_board',
  'mark_distribution_circuit',
  'clear_board_reading',
]);

// ---------------------------------------------------------------------------
// Production env mirror — set BEFORE any extraction module import so the
// constructor-latched flags (Research §Pitfall 4) read the real values.
// Only applied when the caller hasn't already set the var, so a caller can
// still override for a deliberate off-prod experiment. VOICE_LATENCY_LOADED_
// BARREL is force-set to 'false' regardless (see header doc — deliberately
// out of scope for this bench).
// ---------------------------------------------------------------------------
const PROD_ENV_DEFAULTS = {
  SONNET_TOOL_CALLS: 'live',
  SONNET_EXTRACT_MODEL: 'gpt-5.6-luna',
  OPENAI_EXTRACT_API: 'responses',
  OPENAI_EXTRACT_SERVICE_TIER: 'fast',
  OPENAI_EXTRACT_PROMPT_CACHE: 'explicit',
  SNAPSHOT_FORMAT: 'split_blocks',
  CIRCUIT_ORDER: 'recent_3',
  OBSERVATION_EXTRACT_MODEL: 'gpt-5.6-terra',
  OPENAI_OBSERVATION_SERVICE_TIER: 'standard',
  OPENAI_OBSERVATION_REASONING_EFFORT: 'low',
  VOICE_AGENTIC_ANSWERS: 'true',
  OBSERVATION_TIER_ROUTING: 'true',
  LIM_RANGED_WRITE_DISABLED: 'false',
  BOARD_CLEAR_DISABLED: 'false',
};

function applyProdEnvDefaults() {
  for (const [k, v] of Object.entries(PROD_ENV_DEFAULTS)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  // Deliberately out of scope for this bench (see header doc) — force off
  // regardless of caller env so a stray VOICE_LATENCY_LOADED_BARREL=true in
  // the calling shell can't inject ElevenLabs synthesis noise/cost.
  process.env.VOICE_LATENCY_LOADED_BARREL = 'false';
}

// ---------------------------------------------------------------------------
// API keys — OPENAI_API_KEY primary (prod default model is gpt-5.6-luna),
// ANTHROPIC_API_KEY fallback (only exercised if SONNET_EXTRACT_MODEL is
// overridden to a claude-* model). AWS Secrets Manager fallback mirrors
// transcript-replay-direct-runner.mjs's getAnthropicKey() pattern.
// ---------------------------------------------------------------------------
function loadApiKeysIntoEnv() {
  if (process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY) return;
  process.stderr.write(
    '→ neither OPENAI_API_KEY nor ANTHROPIC_API_KEY set; fetching eicr/api-keys from AWS Secrets Manager (eu-west-2)...\n'
  );
  const raw = execSync(
    'aws secretsmanager get-secret-value --secret-id eicr/api-keys --region eu-west-2 --query SecretString --output text',
    { stdio: ['ignore', 'pipe', 'pipe'] }
  ).toString('utf8');
  const parsed = JSON.parse(raw);
  if (parsed.OPENAI_API_KEY) process.env.OPENAI_API_KEY = parsed.OPENAI_API_KEY;
  if (parsed.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = parsed.ANTHROPIC_API_KEY;
  if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    throw new Error('Neither OPENAI_API_KEY nor ANTHROPIC_API_KEY found in eicr/api-keys secret');
  }
}

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) + Fisher-Yates shuffle — reproducible-but-
// documented block-order randomisation (--block-seed).
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle(items, rng) {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Deterministic per-(fixture,block) seed derived from the CLI block-seed so
// different fixtures/blocks don't all reshuffle identically.
function seedFor(blockSeed, fixtureId, blockIdx) {
  let h = blockSeed >>> 0;
  const s = `${fixtureId}:${blockIdx}`;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------
function printHelp() {
  process.stdout.write(`production-path-bench.mjs — plan 08C-A production-path live latency bench

Usage:
  node scripts/voice-latency-bench/production-path-bench.mjs \\
    --fixture=<path> [--fixture=<path> ...] \\
    [--arm=recent_3|ascending|window_6 ...] \\
    [--reps=10] --output=<path.json> [--block-seed=42] [--dry-run] [--verbose]

  --fixture=<path>   Repeatable. YAML file or directory (non-recursive glob).
  --arm=<name>       Repeatable. Defaults to all three arms.
  --reps=<n>         Repetitions per (fixture, arm) pair. Default 10.
  --output=<path>    Required. JSON evidence array destination.
  --block-seed=<n>   Seed for reproducible block-order shuffle. Default 42.
  --dry-run          Clamp to 1 fixture / 1 arm / 1 rep. Still real API calls.
  --verbose          Echo captured log-row names to stderr.
  --help             This text.

Required env: OPENAI_API_KEY (prod model is gpt-5.6-luna) or ANTHROPIC_API_KEY,
else both are fetched from AWS Secrets Manager eicr/api-keys (needs AWS creds).
`);
}

function parseArgs(argv) {
  const out = { fixtures: [], arms: [], reps: 10, output: null, blockSeed: 42, dryRun: false, verbose: false, help: false };
  for (const raw of argv) {
    if (raw === '--help' || raw === '-h') {
      out.help = true;
      continue;
    }
    if (raw === '--dry-run') {
      out.dryRun = true;
      continue;
    }
    if (raw === '--verbose') {
      out.verbose = true;
      continue;
    }
    const m = raw.match(/^--([^=]+)=(.*)$/);
    if (!m) {
      throw new Error(`unrecognised argument: ${raw}`);
    }
    const [, key, value] = m;
    if (key === 'fixture') out.fixtures.push(value);
    else if (key === 'arm') out.arms.push(value);
    else if (key === 'reps') out.reps = parseInt(value, 10);
    else if (key === 'output') out.output = value;
    else if (key === 'block-seed') out.blockSeed = parseInt(value, 10);
    else throw new Error(`unrecognised flag: --${key}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fixture discovery + loading
// ---------------------------------------------------------------------------
function discoverFixturePaths(fixtureArgs) {
  const paths = [];
  for (const p of fixtureArgs) {
    const abs = path.isAbsolute(p) ? p : path.join(REPO_ROOT, p);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      const files = fs
        .readdirSync(abs)
        .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
        .sort()
        .map((f) => path.join(abs, f));
      paths.push(...files);
    } else {
      paths.push(abs);
    }
  }
  return paths;
}

function loadFixture(absPath) {
  const doc = yaml.load(fs.readFileSync(absPath, 'utf8'));
  const fixtureId = doc.name || path.basename(absPath).replace(/\.ya?ml$/, '');
  return { ...doc, fixture_id: fixtureId, _path: absPath };
}

// ---------------------------------------------------------------------------
// Stub ws — captures every frame the backend sends, and answers ask_user
// prompts IN-TURN via the fixture's `ask_user_responses` (same convention as
// transcript-replay-direct-runner.mjs / the live_advisory fixtures).
// `OPEN: 1` is load-bearing (see that file's comment) — the ask dispatcher
// guards its ask_user_started emit on `ws.readyState === ws.OPEN`.
// ---------------------------------------------------------------------------
function makeCapturingWs(events, opts = {}) {
  return {
    readyState: 1,
    OPEN: 1,
    send(payload) {
      let msg = null;
      try {
        msg = JSON.parse(payload);
      } catch {
        events.push({ at_hrtime_ns: process.hrtime.bigint(), raw: String(payload).slice(0, 200) });
        return;
      }
      events.push({ at_hrtime_ns: process.hrtime.bigint(), msg });
      if (typeof opts.onFrame === 'function') {
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

function findAskUserResponse(scenario, askUserPayload) {
  const responses = scenario.ask_user_responses ?? [];
  const question = (askUserPayload?.question ?? '').toLowerCase();
  return responses.find((r) => {
    if (!r.matches) return false;
    return question.includes(String(r.matches).toLowerCase());
  });
}

// ---------------------------------------------------------------------------
// Capturing logger — captures everything reachable via options.logger
// (stage6_tool_call, stage6_tool_call_raw_input, stage6.ask_user,
// stage6_live_extraction). voice_latency.turn_core_summary is NOT reachable
// here — see the MemoryTransport below.
// ---------------------------------------------------------------------------
function makeCapturingLogger(buckets, verbose) {
  function sink(level) {
    return (msgOrObj, maybeMeta) => {
      const meta = maybeMeta ?? null;
      let messageName = null;
      if (typeof msgOrObj === 'string') messageName = msgOrObj;
      else if (msgOrObj && typeof msgOrObj === 'object') messageName = msgOrObj.message;
      const row = meta ?? msgOrObj;
      const at_hrtime_ns = process.hrtime.bigint();
      if (messageName === 'stage6_tool_call') buckets.toolCalls.push({ ...row, _at_hrtime_ns: at_hrtime_ns });
      if (messageName === 'stage6_tool_call_raw_input')
        buckets.toolCallsRawInput.push({ ...row, _at_hrtime_ns: at_hrtime_ns });
      if (messageName === 'stage6.ask_user') buckets.askUsers.push({ ...row, _at_hrtime_ns: at_hrtime_ns });
      if (messageName === 'stage6_live_extraction') buckets.liveExtractions.push(row);
      // These two rows are the ONLY signal that a turn's empty round_timings
      // means "the live call errored (rate limit / transport / SDK) and
      // runLiveMode's F7 finalisation apologised" rather than "the model
      // genuinely had nothing to write" — emitTurnCoreSummary is skipped
      // whenever `cancelled` is true (see stage6-shadow-harness.js's
      // `if (!cancelled) try { emitTurnCoreSummary(...) }`), and BOTH the
      // fatal-control-flow path (stage6_live_cancelled) and the generic
      // live-error path (stage6_live_error) set `cancelled = true`.
      // Discovered live during this runner's own smoke test (a genuine
      // OpenAI TPM rate-limit hit partway through a 12-turn fixture) —
      // without this, an evidence consumer cannot tell the two apart.
      if (messageName === 'stage6_live_error') buckets.liveErrors.push(row);
      if (messageName === 'stage6_live_cancelled') buckets.liveCancellations.push(row);
      if (verbose) process.stderr.write(`  [${level}] ${messageName ?? ''}${level === 'error' ? ' ' + JSON.stringify(row) : ''}\n`);
    };
  }
  return { info: sink('info'), warn: sink('warn'), error: sink('error'), debug: sink('debug') };
}

// Winston transport attached to the REAL project logger (src/logger.js) so
// voice_latency.turn_core_summary — emitted via the module-level `import
// logger from '../logger.js'` inside voice-latency-turn-summary.js, NOT
// options.logger — is still captured. See header doc.
class TurnCoreSummaryTransport extends Transport {
  constructor(opts) {
    super(opts);
    this.buckets = opts.buckets;
  }
  log(info, callback) {
    setImmediate(() => this.emit('logged', info));
    if (info?.message === 'voice_latency.turn_core_summary') {
      this.buckets.turnCoreSummaries.push({ ...info });
    }
    if (info?.message === 'voice_latency.turn_summary_emit_error') {
      this.buckets.turnSummaryEmitErrors.push({ ...info });
    }
    callback();
  }
}

// ---------------------------------------------------------------------------
// Ledger helpers
// ---------------------------------------------------------------------------
function buildCanonicalDestination(tool, inputSummary) {
  if (!inputSummary || typeof inputSummary !== 'object') return `${tool}|`;
  const parts = Object.keys(inputSummary)
    .filter((k) => inputSummary[k] !== undefined)
    .sort()
    .map((k) => `${k}=${JSON.stringify(inputSummary[k])}`);
  return `${tool}|${parts.join('|')}`;
}

// Correlates a stage6_tool_call capture to the agentic-loop round it was
// actually dispatched in, by wall-clock window against round_timings
// (hrtime-based, same process — see header doc). Falls back to the nearest
// round by distance-to-dispatch_complete_ns; returns null if roundTimings
// is empty (e.g. a cancelled turn with no turn_core_summary row at all).
function assignRoundIdx(capturedNs, roundTimings) {
  if (!Array.isArray(roundTimings) || roundTimings.length === 0) return null;
  const parsed = roundTimings.map((t) => ({
    round_idx: t.round_idx,
    stream_complete_ns: BigInt(t.stream_complete_ns),
    dispatch_complete_ns: BigInt(t.dispatch_complete_ns),
  }));
  for (const t of parsed) {
    if (capturedNs >= t.stream_complete_ns && capturedNs <= t.dispatch_complete_ns) {
      return t.round_idx;
    }
  }
  // Fallback: nearest round by absolute distance to dispatch_complete_ns.
  let best = parsed[0];
  let bestDist = capturedNs > best.dispatch_complete_ns ? capturedNs - best.dispatch_complete_ns : best.dispatch_complete_ns - capturedNs;
  for (const t of parsed.slice(1)) {
    const dist = capturedNs > t.dispatch_complete_ns ? capturedNs - t.dispatch_complete_ns : t.dispatch_complete_ns - capturedNs;
    if (dist < bestDist) {
      best = t;
      bestDist = dist;
    }
  }
  return best.round_idx;
}

// Finds the confirmations[]/ask_user_started evidence for one dispatched
// call, from the ws frames captured during this turn. See header doc's
// "an honest limitation" section.
function findEmittedAudibleFrame(toolCallRow, wsFramesThisTurn) {
  const tool = toolCallRow.tool;
  const inputSummary = toolCallRow.input_summary ?? {};
  if (tool === 'ask_user') {
    for (const ev of wsFramesThisTurn) {
      if (ev.msg?.type === 'ask_user_started' && ev.msg.tool_call_id === toolCallRow.tool_use_id) {
        return { type: 'ask_user_started', question: ev.msg.question ?? null };
      }
    }
    return null;
  }
  if (inputSummary.field === undefined) return null;
  for (const ev of wsFramesThisTurn) {
    if (ev.msg?.type !== 'extraction') continue;
    const confirmations = Array.isArray(ev.msg.result?.confirmations) ? ev.msg.result.confirmations : [];
    for (const c of confirmations) {
      if (c.field !== inputSummary.field) continue;
      const circuitMatch =
        c.circuit === inputSummary.circuit ||
        (Array.isArray(c.circuits) && inputSummary.circuit != null && c.circuits.includes(inputSummary.circuit));
      if (!circuitMatch) continue;
      return { type: 'extraction.confirmation', text: c.text ?? null, board_id: c.board_id ?? null };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// One (fixture, arm) repetition
// ---------------------------------------------------------------------------
async function runRepetition({ fixture, armName, blockId, repIndexInBlock, modules, envMeta, verbose }) {
  const { EICRExtractionSession, runShadowHarness, createPendingAsksRegistry, activeSessions, projectLogger } =
    modules;

  const sessionId = `bench08ca_${fixture.fixture_id}_${armName}_${blockId.replace(/[^a-zA-Z0-9_-]/g, '')}_${repIndexInBlock}_${randomUUID().slice(0, 8)}`;

  const buckets = {
    toolCalls: [],
    toolCallsRawInput: [],
    askUsers: [],
    liveExtractions: [],
    turnCoreSummaries: [],
    turnSummaryEmitErrors: [],
    liveErrors: [],
    liveCancellations: [],
  };
  const transport = new TurnCoreSummaryTransport({ buckets });
  projectLogger.add(transport);

  const armOptions = ARMS[armName] ?? {};
  const session = new EICRExtractionSession(process.env.ANTHROPIC_API_KEY ?? null, sessionId, 'eicr', {
    toolCallsMode: 'live',
    ...armOptions,
  });

  // Full modern-client capability set — this bench exercises the FULL
  // production write surface (board_clear_v1, lim_ranged_write_v1,
  // low_conf_readback_v1 pre-apply gate off), not capability-negotiation
  // itself.
  const capabilities = modules.parseVoiceLatencyCapabilities({
    voice_latency: {
      version: 1,
      supports: [
        'streaming_http_audio',
        'source_field_in_tts_post',
        'regex_fast_tts',
        'voice_latency_ack',
        'kill_switch_drop_queue',
        'regex_fast_v2',
        'client_playback_telemetry',
        'low_conf_readback_v1',
        'lim_ranged_write_v1',
        'board_clear_v1',
        'address_mirror_delivery_ack_v1',
      ],
    },
  });
  activeSessions.set(sessionId, {
    session,
    voiceLatency: {
      flags: { ...modules.snapshotFlagsForSession(), loadedBarrel: false },
      capabilities,
    },
    fastPathCorrelationIdByTurn: new Map(),
  });

  const jobState = {
    boards: (fixture.job_state?.boards ?? []).map((b) => ({ ...b })),
    circuits: (fixture.job_state?.circuits ?? []).map((c) => ({ ...c })),
    certificateType: 'eicr',
  };
  session.start(jobState);

  const pendingAsks = createPendingAsksRegistry();
  const wsEvents = [];
  const answeredInTurn = new Set();
  const ws = makeCapturingWs(wsEvents, {
    onFrame(msg) {
      if (msg?.type !== 'ask_user_started' || !msg.tool_call_id) return;
      const resp = findAskUserResponse(fixture, msg);
      if (!resp) return;
      const delay = Math.min(resp.at_ms_after_ask ?? 1000, 250);
      setTimeout(() => {
        const resolved = pendingAsks.resolve(msg.tool_call_id, { answered: true, user_text: resp.text });
        if (resolved) {
          answeredInTurn.add(msg.tool_call_id);
          if (verbose) process.stderr.write(`    in-turn ask reply: "${resp.text}"\n`);
        }
      }, delay);
    },
  });

  const logger = makeCapturingLogger(buckets, verbose);
  const turns = [];
  const seenDestinations = new Set(); // canonical_destination -> written by an EARLIER turn

  const initialTranscripts = (fixture.transcript ?? [])
    .slice()
    .sort((a, b) => (a.at_ms ?? 0) - (b.at_ms ?? 0));

  let turnIndex = 0;

  async function runOneTurn(transcriptText, regexResults = []) {
    turnIndex += 1;
    const toolCallsStart = buckets.toolCalls.length;
    const toolCallsRawInputStart = buckets.toolCallsRawInput.length;
    const askUsersStart = buckets.askUsers.length;
    const liveExtractionsStart = buckets.liveExtractions.length;
    const turnCoreSummariesStart = buckets.turnCoreSummaries.length;
    const liveErrorsStart = buckets.liveErrors.length;
    const liveCancellationsStart = buckets.liveCancellations.length;
    const wsEventsStart = wsEvents.length;

    if (verbose) process.stderr.write(`  turn ${turnIndex}: "${transcriptText.slice(0, 80)}"\n`);

    // Cancellation/cap fixture support (fixture-level `cancellation: {
    // turn_index, abort_after_ms }`). Mirrors the real `signal` (AbortSignal)
    // option threaded through runLiveMode -> runToolLoop -> the Anthropic/
    // OpenAI SDK stream call (see stage6-tool-loop.js's
    // `client.messages.stream(streamArgs, signal ? {signal} : undefined)`
    // and the F7 Item 3 cancellation-finalisation contract exercised by
    // stage6-live-cancellation.test.js — runLiveMode does NOT rethrow a
    // silent abort, it finalises whatever was already applied).
    let signal;
    let controller = null;
    if (fixture.cancellation?.turn_index === turnIndex) {
      controller = new AbortController();
      signal = controller.signal;
      setTimeout(() => controller.abort(), fixture.cancellation.abort_after_ms ?? 300);
    }

    const wallStart = performance.now();
    let result = null;
    let threw = null;
    try {
      result = await runShadowHarness(session, transcriptText, regexResults, {
        confirmationsEnabled: true,
        pendingAsks,
        ws,
        rawInspectorTranscript: transcriptText,
        logger,
        generationId: randomUUID(),
        extractionTurnId: randomUUID(),
        signal,
      });
    } catch (err) {
      threw = err;
      if (verbose) process.stderr.write(`    turn ${turnIndex} threw: ${err.message}\n`);
    }
    const wallMs = Math.round(performance.now() - wallStart);

    // Legacy post-turn ask reply path: only for asks NOT answered in-turn
    // (mirrors transcript-replay-direct-runner.mjs's fallback).
    const newAskUsers = buckets.askUsers.slice(askUsersStart);
    for (const ask of newAskUsers) {
      if (ask.tool_call_id && answeredInTurn.has(ask.tool_call_id)) continue;
      const resp = findAskUserResponse(fixture, ask);
      if (resp) {
        const delay = Math.min(resp.at_ms_after_ask ?? 1000, 250);
        await new Promise((res) => setTimeout(res, delay));
        if (verbose) process.stderr.write(`    ask_user reply (post-turn transcript): "${resp.text}"\n`);
        await runOneTurn(resp.text, []);
      }
    }

    const toolCallsThisTurn = buckets.toolCalls.slice(toolCallsStart);
    const rawInputThisTurn = buckets.toolCallsRawInput.slice(toolCallsRawInputStart);
    const wsFramesThisTurn = wsEvents.slice(wsEventsStart);
    const turnCoreSummariesThisTurn = buckets.turnCoreSummaries.slice(turnCoreSummariesStart);
    const coreSummary = turnCoreSummariesThisTurn[0] ?? null;
    const roundTimings = coreSummary?.round_timings ?? [];
    const roundUsage = coreSummary?.round_usage ?? [];

    const rawByToolUseId = new Map();
    for (const r of rawInputThisTurn) {
      if (r.tool_use_id) rawByToolUseId.set(r.tool_use_id, r);
    }

    const ledger = toolCallsThisTurn.map((row) => {
      const raw = rawByToolUseId.get(row.tool_use_id) ?? null;
      const roundIdx = assignRoundIdx(row._at_hrtime_ns, roundTimings);
      const destination = buildCanonicalDestination(row.tool, row.input_summary);
      const applied_mutation = row.outcome === 'ok' && WRITE_TOOL_NAMES.has(row.tool);
      return {
        round_idx: roundIdx,
        dispatcher_round: row.round ?? null, // per-dispatcher-closure counter — chronological reference ONLY, never round attribution
        tool: row.tool,
        tool_call_id: row.tool_use_id,
        canonical_destination: destination,
        normalised_value: raw?.raw_input?.value ?? null,
        raw_input: raw?.raw_input ?? null,
        dispatch_outcome: row.outcome,
        is_error: row.is_error === true,
        validation_error: row.validation_error ?? null,
        applied_mutation,
        emitted_audible_frame: findEmittedAudibleFrame(row, wsFramesThisTurn),
      };
    });

    // Duplicate-write detection: did this turn re-write a slot a STRICTLY
    // EARLIER turn already wrote (ok outcome), per the ledger — never
    // derived from final session state, which hides repeats.
    let duplicateWriteDetected = false;
    for (const entry of ledger) {
      if (entry.dispatch_outcome !== 'ok' || !entry.applied_mutation) continue;
      if (seenDestinations.has(entry.canonical_destination)) duplicateWriteDetected = true;
    }
    for (const entry of ledger) {
      if (entry.dispatch_outcome === 'ok' && entry.applied_mutation) {
        seenDestinations.add(entry.canonical_destination);
      }
    }

    // Cache summary for this turn: last round's prompt_cache sub-object +
    // token counts (see header doc's "cache" interpretation note).
    const lastRoundUsage = roundUsage.at(-1) ?? null;
    const cacheForTurn = lastRoundUsage
      ? {
          key_id: lastRoundUsage.prompt_cache?.key_id ?? null,
          mode: lastRoundUsage.prompt_cache?.mode ?? null,
          breakpoint_enabled: lastRoundUsage.prompt_cache?.breakpoint_enabled ?? false,
          fresh_input_tokens: lastRoundUsage.fresh_input_tokens ?? 0,
          cache_read_input_tokens: lastRoundUsage.cache_read_input_tokens ?? 0,
          cache_write_input_tokens: lastRoundUsage.cache_write_input_tokens ?? 0,
        }
      : null;

    // Distinguishes an EMPTY round_timings/ledger that means "the model
    // genuinely had nothing to write" from one that means "the live call
    // errored (rate limit / transport / SDK) or hit a fatal control-flow
    // cancellation and runLiveMode's F7 finalisation apologised instead" —
    // both look identical on round_timings alone (see the capturing-logger
    // comment above `liveErrors`/`liveCancellations`). `internal_cancelled`
    // is the harness's OWN internal `cancelled` flag (any error path OR the
    // F7 fatal-control-flow path); `cancelled` (our own field, above) is
    // ONLY true when THIS runner fired the fixture's `cancellation`
    // AbortSignal — the two are deliberately distinct fields.
    const liveErrorThisTurn = buckets.liveErrors[liveErrorsStart] ?? null;
    const liveCancellationThisTurn = buckets.liveCancellations[liveCancellationsStart] ?? null;

    turns.push({
      turn_index: turnIndex,
      transcript_text: transcriptText,
      wall_clock_ms: wallMs,
      threw: threw ? { message: threw.message, name: threw.name } : null,
      cancelled: controller !== null,
      internal_cancelled: Boolean(liveErrorThisTurn || liveCancellationThisTurn),
      live_error: liveErrorThisTurn ? { error: liveErrorThisTurn.error ?? null } : null,
      live_cancellation_reason: liveCancellationThisTurn?.reason ?? null,
      round_timings: roundTimings,
      round_usage: roundUsage,
      provider_call_ids: roundUsage.map((r) => r.provider_call_id).filter(Boolean),
      ledger,
      duplicate_write_detected: duplicateWriteDetected,
      readings_count: result?.extracted_readings?.length ?? 0,
      observations_count: result?.observations?.length ?? 0,
      ask_users_count: newAskUsers.length,
      live_extraction: buckets.liveExtractions[liveExtractionsStart] ?? null,
      cache: cacheForTurn,
    });
  }

  for (const t of initialTranscripts) {
    await runOneTurn(t.text, t.regexResults ?? []);
  }

  // Settle: give async telemetry (turn_summary_emit_error paths etc.) a
  // moment to flush before tearing down. Loaded Barrel is disabled so there
  // is no speculative-synth settle window to poll for (contrast
  // transcript-replay-direct-runner.mjs's 10s barrel-settle loop).
  await new Promise((res) => setTimeout(res, 50));
  projectLogger.remove(transport);
  activeSessions.delete(sessionId);

  const totalRounds = turns.reduce((sum, t) => sum + t.round_timings.length, 0);
  const totalStreamMs = turns.reduce(
    (sum, t) => sum + t.round_timings.reduce((s, r) => s + (r.stream_ms ?? 0), 0),
    0
  );

  return {
    fixture_id: fixture.fixture_id,
    arm: armName,
    block_id: blockId,
    rep_index_in_block: repIndexInBlock,
    session_id: sessionId,
    env: envMeta,
    turns,
    total_stream_ms: totalStreamMs,
    total_rounds: totalRounds,
    turn_summary_emit_errors: buckets.turnSummaryEmitErrors,
  };
}

// ---------------------------------------------------------------------------
// Environment metadata (computed once, reused across every repetition)
// ---------------------------------------------------------------------------
function buildEnvMeta() {
  let gitSha = null;
  try {
    gitSha = execSync('git rev-parse HEAD', { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString('utf8')
      .trim();
  } catch {
    gitSha = null;
  }
  let taskDefRevision = null;
  try {
    taskDefRevision = execSync(
      'aws ecs describe-task-definition --task-definition eicr-backend --region eu-west-2 --query taskDefinition.revision --output text',
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }
    )
      .toString('utf8')
      .trim();
    if (!taskDefRevision || taskDefRevision === 'None') taskDefRevision = null;
  } catch {
    taskDefRevision = null;
  }
  return {
    git_sha: gitSha,
    node_version: process.version,
    model: process.env.SONNET_EXTRACT_MODEL ?? null,
    task_def_revision: taskDefRevision,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (args.fixtures.length === 0) throw new Error('at least one --fixture=<path> is required');
  if (!args.output) throw new Error('--output=<path.json> is required');
  if (!Number.isInteger(args.reps) || args.reps < 1) throw new Error('--reps must be a positive integer');
  if (!Number.isInteger(args.blockSeed)) throw new Error('--block-seed must be an integer');

  let armNames = args.arms.length > 0 ? args.arms : ARM_NAMES.slice();
  for (const a of armNames) {
    if (!ARM_NAMES.includes(a)) throw new Error(`unknown arm "${a}" — must be one of ${ARM_NAMES.join(', ')}`);
  }

  let fixturePaths = discoverFixturePaths(args.fixtures);
  let reps = args.reps;

  if (args.dryRun) {
    fixturePaths = fixturePaths.slice(0, 1);
    armNames = armNames.slice(0, 1);
    reps = 1;
    process.stderr.write('→ --dry-run: clamped to 1 fixture, 1 arm, 1 rep\n');
  }

  applyProdEnvDefaults();
  loadApiKeysIntoEnv();

  process.stderr.write(
    `→ fixtures: ${fixturePaths.map((p) => path.basename(p)).join(', ')}\n→ arms: ${armNames.join(', ')}\n→ reps/block-count: ${reps}\n→ block-seed: ${args.blockSeed}\n→ model: ${process.env.SONNET_EXTRACT_MODEL}\n`
  );

  // Dynamic import AFTER env vars are set — constructor-latched flags
  // (toolCallsMode, snapshotFormat, circuitOrder, agenticAnswersEnabled)
  // read process.env exactly once, at module-level constant resolution for
  // some (SNAPSHOT_RECENT_CIRCUITS) and at construction time for others;
  // both need the env set first.
  const [
    { EICRExtractionSession },
    { runShadowHarness },
    { createPendingAsksRegistry },
    { activeSessions },
    { snapshotFlagsForSession, parseVoiceLatencyCapabilities },
    projectLoggerModule,
  ] = await Promise.all([
    import('../../src/extraction/eicr-extraction-session.js'),
    import('../../src/extraction/stage6-shadow-harness.js'),
    import('../../src/extraction/stage6-pending-asks-registry.js'),
    import('../../src/extraction/active-sessions.js'),
    import('../../src/extraction/voice-latency-config.js'),
    import('../../src/logger.js'),
  ]);
  const projectLogger = projectLoggerModule.default;

  const modules = {
    EICRExtractionSession,
    runShadowHarness,
    createPendingAsksRegistry,
    activeSessions,
    snapshotFlagsForSession,
    parseVoiceLatencyCapabilities,
    projectLogger,
  };

  const envMeta = buildEnvMeta();
  process.stderr.write(`→ env: git_sha=${envMeta.git_sha} node=${envMeta.node_version} task_def_revision=${envMeta.task_def_revision}\n`);

  const fixtures = fixturePaths.map(loadFixture);
  const results = [];
  const outputAbs = path.isAbsolute(args.output) ? args.output : path.join(process.cwd(), args.output);

  function flush() {
    fs.writeFileSync(outputAbs, JSON.stringify(results, null, 2) + '\n');
  }

  for (const fixture of fixtures) {
    process.stderr.write(`\n=== fixture: ${fixture.fixture_id} ===\n`);
    for (let blockIdx = 0; blockIdx < reps; blockIdx++) {
      const blockId = `${fixture.fixture_id}:block${blockIdx}`;
      const rng = mulberry32(seedFor(args.blockSeed, fixture.fixture_id, blockIdx));
      const order = seededShuffle(armNames, rng);
      process.stderr.write(`  block ${blockIdx} order: ${order.join(', ')}\n`);
      for (const armName of order) {
        process.stderr.write(`    running arm=${armName} rep_index_in_block=${blockIdx}...\n`);
        const rep = await runRepetition({
          fixture,
          armName,
          blockId,
          repIndexInBlock: blockIdx,
          modules,
          envMeta,
          verbose: args.verbose,
        });
        results.push(rep);
        flush();
        process.stderr.write(
          `    ✓ arm=${armName} total_rounds=${rep.total_rounds} total_stream_ms=${rep.total_stream_ms} turns=${rep.turns.length}\n`
        );
      }
    }
  }

  process.stderr.write(`\n=== done: ${results.length} repetitions written to ${outputAbs} ===\n`);
}

main()
  .then(() => {
    // The OpenAI/Anthropic SDK HTTP clients (and possibly AWS SDK credential
    // providers exercised by the AWS Secrets Manager / ECS describe-task-
    // definition calls) leave keep-alive sockets/handles open that the
    // event loop waits on indefinitely — observed hanging ~90s+ past the
    // final "done" log line in this worktree's smoke test even though all
    // work (including the synchronous fs.writeFileSync flush) had already
    // completed. Every output this script produces is already on disk
    // (--output) or flushed to stderr (synchronous on POSIX) by this point,
    // so an explicit exit is safe and is the only way this CLI reliably
    // terminates.
    process.exit(0);
  })
  .catch((err) => {
    process.stderr.write(`FATAL: ${err.stack || err.message}\n`);
    process.exit(1);
  });
