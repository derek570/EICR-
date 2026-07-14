#!/usr/bin/env node
/**
 * Voice-pipeline regression orchestrator.
 *
 * Runs the direct-replay harness over every scenario in
 * tests/fixtures/voice-latency-scenarios/baseline/ (or a configured
 * subset), parses the per-scenario JSON, emits a single
 * voice-regression-report.md with:
 *   - pass/fail status per scenario
 *   - per-turn wall-clock + cumulative session wall-clock
 *   - Loaded Barrel hit/miss/absent rate
 *   - estimated Sonnet token cost
 *   - failure details surfaced inline
 *
 * Usage:
 *   npm run voice-regression                     # all baseline
 *   npm run voice-regression -- --filter=designation
 *   npm run voice-regression -- --output=/tmp/report.md
 *
 * Exit: 0 if every scenario passed, 1 otherwise (so CI can gate on
 * the return code).
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);

const SCENARIO_DIR = args['scenario-dir']
  ? path.resolve(args['scenario-dir'])
  : path.join(REPO_ROOT, 'tests/fixtures/voice-latency-scenarios/baseline');
const FILTER = args.filter ?? null;
const OUTPUT = args.output ?? path.join(REPO_ROOT, 'voice-regression-report.md');

// Anthropic Sonnet 4.5 pricing — used for cost estimation in the report.
// Keep aligned with plan PLAN.md if pricing changes.
const PRICE_INPUT_PER_M = 3.0;
const PRICE_OUTPUT_PER_M = 15.0;
const PRICE_CACHE_READ_PER_M = 0.3;
const PRICE_CACHE_WRITE_PER_M = 3.75;

function estimateCost(liveExtractions) {
  let cost = 0;
  for (const e of liveExtractions ?? []) {
    cost += (e.usage_input ?? 0) * (PRICE_INPUT_PER_M / 1_000_000);
    cost += (e.usage_output ?? 0) * (PRICE_OUTPUT_PER_M / 1_000_000);
    cost += (e.usage_cache_read ?? 0) * (PRICE_CACHE_READ_PER_M / 1_000_000);
    cost += (e.usage_cache_write ?? 0) * (PRICE_CACHE_WRITE_PER_M / 1_000_000);
  }
  return cost;
}

function ms(n) {
  return `${Math.round(n)}ms`;
}

function statusEmoji(ok) {
  return ok ? '✅' : '❌';
}

function formatTurn(t) {
  const ext = t.readings_emitted ? `${t.readings_emitted} reading${t.readings_emitted > 1 ? 's' : ''}` : '';
  const ask = t.ask_users_emitted ? `${t.ask_users_emitted} ask` : '';
  const tail = [ext, ask].filter(Boolean).join(', ');
  return `  - turn ${t.turn}: ${ms(t.duration_ms)} — "${t.transcript}" ${tail ? `→ ${tail}` : ''}`;
}

function formatLoadedBarrel(lb) {
  if (!lb?.enabled) return '_disabled_';
  if (!lb.cache_entries || lb.cache_entries.length === 0) return '_no speculator fires_';
  const byStatus = {};
  for (const e of lb.cache_entries) byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
  const parts = Object.entries(byStatus).map(([s, c]) => `${c}× ${s}`);
  const bytes = lb.cache_entries.reduce((s, e) => s + (e.bytes ?? 0), 0);
  return `${parts.join(', ')} (${Math.round(bytes / 1024)}kB pre-synth)`;
}

// --- run harness once --------------------------------------------------------
console.error(`▶ Running direct-replay harness against ${SCENARIO_DIR}${FILTER ? ` (filter: ${FILTER})` : ''}…\n`);
const start = Date.now();
let jsonOut = '';
let exitCode = 0;
try {
  const cmd = [
    'node',
    path.join(REPO_ROOT, 'scripts/voice-latency-bench/transcript-replay-direct.mjs'),
    `--scenario-dir=${SCENARIO_DIR}`,
    ...(FILTER ? [`--filter=${FILTER}`] : []),
    // Lane passthrough (2026-07-14): lane-tagged scenarios (live-advisory
    // D1/D2 probes) are skipped by dir discovery unless the lane is named.
    ...(args.lane ? [`--lane=${args.lane}`] : []),
  ].join(' ');
  jsonOut = execSync(cmd, {
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  }).toString('utf8');
} catch (err) {
  exitCode = err.status ?? 1;
  jsonOut = err.stdout?.toString('utf8') ?? '';
  if (!jsonOut) {
    console.error('Harness produced no output. Aborting report.');
    process.exit(2);
  }
}
const elapsed = Date.now() - start;

// The harness writes its JSON result with console.log at the very end,
// but winston (via the project logger) ALSO writes timestamped lines to
// stdout. Extract the JSON array by finding the largest balanced
// [ ... ] block in the captured output.
function extractJsonArray(text) {
  const firstBracket = text.indexOf('[');
  if (firstBracket < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = firstBracket; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true; continue; }
    if (c === '"' && !esc) inStr = !inStr;
    if (inStr) continue;
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return text.slice(firstBracket, i + 1);
    }
  }
  return null;
}

let results;
try {
  const jsonBlob = extractJsonArray(jsonOut);
  if (!jsonBlob) throw new Error('no JSON array found in harness stdout');
  results = JSON.parse(jsonBlob);
} catch (err) {
  console.error('Failed to parse harness output as JSON:', err.message);
  console.error('---last 2000 chars of harness stdout:');
  console.error(jsonOut.slice(-2000));
  process.exit(2);
}

// --- aggregate metrics -------------------------------------------------------
const totalCost = results.reduce((s, r) => s + estimateCost(r.live_extractions), 0);
const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
const totalTurns = results.reduce((s, r) => s + (r.turn_count ?? 0), 0);
const totalAskUsers = results.reduce((s, r) => s + (r.ask_users?.length ?? 0), 0);

const allTurnDurations = results.flatMap((r) => (r.turn_timings ?? []).map((t) => t.duration_ms)).sort((a, b) => a - b);
const p50 = allTurnDurations.length ? allTurnDurations[Math.floor(allTurnDurations.length / 2)] : 0;
const p95 = allTurnDurations.length ? allTurnDurations[Math.floor(allTurnDurations.length * 0.95)] : 0;

const lbStats = { ready: 0, hit: 0, miss: 0, aborted: 0, started_no_fire: 0 };
let lbTotalBytes = 0;
for (const r of results) {
  for (const e of r.loaded_barrel?.cache_entries ?? []) {
    lbStats[e.status] = (lbStats[e.status] ?? 0) + 1;
    lbTotalBytes += e.bytes ?? 0;
  }
}

// --- build report ------------------------------------------------------------
const lines = [];
lines.push(`# Voice-pipeline regression report`);
lines.push(``);
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push(`Scenario directory: \`${path.relative(REPO_ROOT, SCENARIO_DIR)}\``);
if (FILTER) lines.push(`Filter: \`${FILTER}\``);
lines.push(``);
lines.push(`## Summary`);
lines.push(``);
lines.push(`| Metric | Value |`);
lines.push(`|---|---|`);
lines.push(`| Status | ${failed === 0 ? '✅ all green' : `❌ ${failed} fail / ${results.length} total`} |`);
lines.push(`| Scenarios | ${results.length} (${passed} pass, ${failed} fail) |`);
lines.push(`| Total turns | ${totalTurns} |`);
lines.push(`| Ask-user emissions | ${totalAskUsers} |`);
lines.push(`| Wall-clock p50 / p95 (per turn) | ${ms(p50)} / ${ms(p95)} |`);
lines.push(`| Suite wall-clock | ${ms(elapsed)} |`);
lines.push(`| Estimated Sonnet cost | $${totalCost.toFixed(3)} |`);
lines.push(`| Loaded Barrel pre-synth bytes | ${(lbTotalBytes / 1024).toFixed(1)}kB across ${Object.values(lbStats).reduce((a, b) => a + b, 0)} entries |`);
lines.push(`| LB ready / hit / miss / aborted / started_no_fire | ${lbStats.ready} / ${lbStats.hit} / ${lbStats.miss} / ${lbStats.aborted} / ${lbStats.started_no_fire} |`);
lines.push(``);

lines.push(`## Per-scenario results`);
lines.push(``);
lines.push(`| | Scenario | Wall | p95 | Turns | Asks | LB | Cost | Notes |`);
lines.push(`|---|---|---|---|---|---|---|---|---|`);
for (const r of results) {
  const cost = estimateCost(r.live_extractions);
  const lb = r.loaded_barrel?.cache_entries?.length
    ? r.loaded_barrel.cache_entries.map((e) => e.status[0]).join('')
    : '—';
  const notes = r.failures?.length
    ? `**FAIL** — ${r.failures.map((f) => f.slice(0, 120)).join('; ')}`
    : '';
  lines.push(
    `| ${statusEmoji(r.pass)} | \`${r.name}\` | ${ms(r.elapsed_ms ?? 0)} | ${ms(r.p95_turn_ms ?? 0)} | ${r.turn_count ?? 0} | ${r.ask_users?.length ?? 0} | ${lb} | $${cost.toFixed(3)} | ${notes} |`,
  );
}
lines.push(``);
lines.push(`Legend for LB column: each char is one cache entry's status — \`r\` ready, \`h\` hit, \`m\` miss, \`a\` aborted, \`s\` started_no_fire. Dash = no speculator fires.`);
lines.push(``);

// Per-turn timing breakdown for each scenario (only verbose for failed
// scenarios + slow scenarios to keep the report scannable).
const SLOW_THRESHOLD_MS = 5000;
const interesting = results.filter((r) => !r.pass || (r.p95_turn_ms ?? 0) > SLOW_THRESHOLD_MS);
if (interesting.length > 0) {
  lines.push(`## Turn-level wall-clock — failed or slow scenarios`);
  lines.push(``);
  for (const r of interesting) {
    lines.push(`### ${statusEmoji(r.pass)} \`${r.name}\``);
    lines.push(``);
    if (r.failures?.length) {
      lines.push(`**Failures:**`);
      for (const f of r.failures) lines.push(`- ${f}`);
      lines.push(``);
    }
    if (r.turn_timings?.length) {
      lines.push(`**Per turn:**`);
      for (const t of r.turn_timings) lines.push(formatTurn(t));
      lines.push(``);
    }
    if (r.tool_calls?.length) {
      const ok = r.tool_calls.filter((t) => t.outcome === 'ok');
      const rej = r.tool_calls.filter((t) => t.outcome !== 'ok');
      lines.push(`**Tool calls:** ${ok.length} ok, ${rej.length} rejected`);
      if (rej.length) {
        for (const t of rej) {
          lines.push(`- \`${t.tool}\` ${t.outcome} — \`${JSON.stringify(t.validation_error ?? {})}\``);
        }
      }
      lines.push(``);
    }
    if (r.ask_users?.length) {
      lines.push(`**Ask-user emissions:**`);
      for (const a of r.ask_users) lines.push(`- "${a.question}" (reason: \`${a.reason}\`)`);
      lines.push(``);
    }
  }
}

lines.push(`## Cost & rate-card`);
lines.push(``);
lines.push(`Pricing snapshot at report-time:`);
lines.push(``);
lines.push(`- Sonnet 4.5 input: $${PRICE_INPUT_PER_M}/M tokens`);
lines.push(`- Sonnet 4.5 output: $${PRICE_OUTPUT_PER_M}/M tokens`);
lines.push(`- Cache read (5min): $${PRICE_CACHE_READ_PER_M}/M tokens`);
lines.push(`- Cache write (5min): $${PRICE_CACHE_WRITE_PER_M}/M tokens`);
lines.push(``);
lines.push(`See \`.planning/voice-pipeline-test-plan-2026-05-24/PLAN.md\` for the full cost model + the rationale behind the on-demand (vs cron) execution stance.`);
lines.push(``);

const report = lines.join('\n') + '\n';
fs.writeFileSync(OUTPUT, report);

console.error(`\n${failed === 0 ? '✅' : '❌'} ${passed}/${results.length} pass in ${ms(elapsed)} — $${totalCost.toFixed(3)} — report at ${OUTPUT}`);
process.exit(failed === 0 ? 0 : 1);
