#!/usr/bin/env node
/**
 * compare.mjs — run the field-replay corpus LIVE through two models (default:
 * Haiku 4.5 vs GPT-5.6 Luna) and diff extraction correctness, latency, and cost.
 *
 * Spawns `run-lane.mjs` once per model in its OWN process (SHADOW_MODEL latches
 * at import, so each model needs a clean process), loads both JSON outputs, and
 * prints a per-fixture + aggregate comparison plus a markdown report.
 *
 * This calls the real Anthropic + OpenAI APIs — run it with real keys:
 *   ANTHROPIC_API_KEY=…  OPENAI_API_KEY=…  node scripts/model-ab/compare.mjs
 *
 * Options:
 *   --baseline=claude-haiku-4-5-20251001   the incumbent model
 *   --candidate=gpt-5.6-luna               the challenger
 *   --filter=<substr>                      only fixtures whose id contains substr
 *   --out=<path.md>                        write the markdown report (default: scripts/model-ab/report.md)
 *   --keep                                 keep the per-lane JSON temp files
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LANE = path.join(__dirname, 'run-lane.mjs');

function parseArgs(argv) {
  const out = {
    baseline: 'claude-haiku-4-5-20251001',
    candidate: 'gpt-5.6-luna',
    filter: null,
    out: path.join(__dirname, 'report.md'),
    keep: false,
  };
  out.from = null; // "baseJson,candJson" — diff two already-produced lane files, no API calls
  for (const a of argv.slice(2)) {
    if (a.startsWith('--baseline=')) out.baseline = a.slice(11);
    else if (a.startsWith('--candidate=')) out.candidate = a.slice(12);
    else if (a.startsWith('--filter=')) out.filter = a.slice(9);
    else if (a.startsWith('--out=')) out.out = a.slice(6);
    else if (a.startsWith('--from=')) out.from = a.slice(7);
    else if (a === '--keep') out.keep = true;
  }
  return out;
}

function runLane(model, filter) {
  const tmp = path.join(os.tmpdir(), `model-ab-${model.replace(/[^a-z0-9]/gi, '')}-${Date.now()}.json`);
  const isGpt = model.toLowerCase().startsWith('gpt-');
  const env = { ...process.env, SONNET_EXTRACT_MODEL: model };
  if (isGpt && !env.OPENAI_API_KEY) {
    throw new Error(`candidate ${model} needs OPENAI_API_KEY in the environment`);
  }
  if (!isGpt && !env.ANTHROPIC_API_KEY) {
    throw new Error(`model ${model} needs ANTHROPIC_API_KEY in the environment`);
  }
  const laneArgs = [LANE, `--out=${tmp}`];
  if (filter) laneArgs.push(`--filter=${filter}`);
  process.stderr.write(`\n▶ running lane: ${model}\n`);
  const res = spawnSync('node', laneArgs, { env, stdio: ['ignore', 'inherit', 'inherit'] });
  if (res.status !== 0) throw new Error(`lane ${model} exited ${res.status}`);
  const parsed = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  return { tmp, parsed };
}

/** Canonical set of readings for a turn: "circuit|field|value" sorted. */
function readingKey(readings) {
  return (readings ?? [])
    .map((r) => `${r.circuit}|${r.field}|${r.value}`)
    .sort()
    .join(' ; ');
}

function indexTurns(parsed) {
  const map = new Map();
  for (const f of parsed.results ?? []) {
    for (const t of f.turns ?? []) {
      map.set(`${f.corpus_id}#${t.turn}`, { ...t, corpus_id: f.corpus_id });
    }
  }
  return map;
}

function fmtPct(n) {
  return `${(n * 100).toFixed(1)}%`;
}

function main() {
  const args = parseArgs(process.argv);

  let base;
  let cand;
  if (args.from) {
    // Diff-only: two already-produced lane JSON files, no API calls.
    const [bp, cp] = args.from.split(',');
    base = { tmp: bp, parsed: JSON.parse(fs.readFileSync(bp, 'utf8')) };
    cand = { tmp: cp, parsed: JSON.parse(fs.readFileSync(cp, 'utf8')) };
    args.keep = true; // never delete files the caller passed in
    return diffAndReport(base, cand, args);
  }
  try {
    base = runLane(args.baseline, args.filter);
    cand = runLane(args.candidate, args.filter);
  } catch (err) {
    process.stderr.write(`\ncompare: ${err.message}\n`);
    process.stderr.write(
      '\nSet the keys and re-run, e.g.:\n' +
        '  ANTHROPIC_API_KEY=sk-ant-… OPENAI_API_KEY=sk-… node scripts/model-ab/compare.mjs\n'
    );
    process.exit(2);
  }
  return diffAndReport(base, cand, args);
}

function diffAndReport(base, cand, args) {
  const B = base.parsed;
  const C = cand.parsed;
  const bTurns = indexTurns(B);
  const cTurns = indexTurns(C);

  const rows = [];
  let agree = 0;
  let total = 0;
  for (const key of bTurns.keys()) {
    const bt = bTurns.get(key);
    const ct = cTurns.get(key);
    if (!ct) continue;
    total += 1;
    const bk = readingKey(bt.readings);
    const ck = readingKey(ct.readings);
    const same = bk === ck;
    if (same) agree += 1;
    rows.push({
      key,
      transcript: bt.transcript,
      same,
      baseReadings: bk || '(none)',
      candReadings: ck || '(none)',
      baseMs: bt.latency_ms,
      candMs: ct.latency_ms,
      baseSpoke: (bt.confirmations ?? []).join(' | ') || bt.spoken_response || '(silent)',
      candSpoke: (ct.confirmations ?? []).join(' | ') || ct.spoken_response || '(silent)',
      baseErr: bt.errored,
      candErr: ct.errored,
    });
  }

  const costRatio = B.est_cost_usd ? C.est_cost_usd / B.est_cost_usd : null;
  const latRatio = B.latency_ms_mean ? C.latency_ms_mean / B.latency_ms_mean : null;

  // --- terminal summary ---
  const line = (s) => process.stdout.write(s + '\n');
  line('');
  line('════════════════════════════════════════════════════════════════');
  line(`  MODEL A/B — field-replay corpus (LIVE)`);
  line(`  baseline : ${B.model}  (${B.provider})`);
  line(`  candidate: ${C.model}  (${C.provider})`);
  line('════════════════════════════════════════════════════════════════');
  line(`  fixtures / turns : ${B.fixtures} / ${total}`);
  line(`  readings agree   : ${agree}/${total}  (${fmtPct(total ? agree / total : 0)})`);
  line(`  latency (mean/turn): base ${B.latency_ms_mean}ms  |  cand ${C.latency_ms_mean}ms  ${latRatio ? `(${latRatio.toFixed(2)}×)` : ''}`);
  line(`  est cost (corpus): base $${B.est_cost_usd}  |  cand $${C.est_cost_usd}  ${costRatio ? `(${costRatio.toFixed(2)}×)` : ''}`);
  line(`  tokens base : in ${B.usage.input_tokens} / out ${B.usage.output_tokens} / cacheRead ${B.usage.cache_read_tokens} / cacheWrite ${B.usage.cache_write_tokens ?? 0}`);
  line(`  tokens cand : in ${C.usage.input_tokens} / out ${C.usage.output_tokens} / cacheRead ${C.usage.cache_read_tokens} / cacheWrite ${C.usage.cache_write_tokens ?? 0}`);
  line('────────────────────────────────────────────────────────────────');
  for (const r of rows) {
    const flag = r.same ? '✓' : '✗ DIFF';
    line(`  ${flag}  [${r.key}] "${r.transcript.slice(0, 54)}"`);
    if (!r.same) {
      line(`         base readings: ${r.baseReadings}`);
      line(`         cand readings: ${r.candReadings}`);
    }
    if (r.baseErr || r.candErr) {
      line(`         ERR base=${r.baseErr ?? '-'} cand=${r.candErr ?? '-'}`);
    }
  }
  line('════════════════════════════════════════════════════════════════');

  // --- markdown report ---
  const md = [];
  md.push(`# Model A/B — field-replay corpus (LIVE)\n`);
  md.push(`- **baseline**: \`${B.model}\` (${B.provider})`);
  md.push(`- **candidate**: \`${C.model}\` (${C.provider})`);
  md.push(`- **fixtures / turns**: ${B.fixtures} / ${total}`);
  md.push(`- **readings agreement**: ${agree}/${total} (${fmtPct(total ? agree / total : 0)})`);
  md.push(`- **latency mean/turn**: base ${B.latency_ms_mean}ms · cand ${C.latency_ms_mean}ms ${latRatio ? `(**${latRatio.toFixed(2)}×**)` : ''}`);
  md.push(`- **est corpus cost**: base $${B.est_cost_usd} · cand $${C.est_cost_usd} ${costRatio ? `(**${costRatio.toFixed(2)}×**)` : ''}`);
  md.push(`- **tokens**: base in/out ${B.usage.input_tokens}/${B.usage.output_tokens} · cand ${C.usage.input_tokens}/${C.usage.output_tokens}`);
  md.push('');
  md.push('> Correctness here = did the candidate write the SAME readings as the baseline on the same real utterance. A DIFF is a data point to ear-verify, not automatically "wrong" — the candidate may be right where the baseline was wrong. Latency excludes Loaded Barrel (disabled for a clean single-model probe) and includes the cross-provider network hop for the candidate.');
  md.push('');
  md.push('| | turn | transcript | readings match | base ms | cand ms |');
  md.push('|---|---|---|---|---|---|');
  for (const r of rows) {
    md.push(
      `| ${r.same ? '✓' : '✗' } | ${r.key} | ${r.transcript.replace(/\|/g, '\\|').slice(0, 60)} | ${r.same ? 'same' : 'DIFF'} | ${r.baseMs} | ${r.candMs} |`
    );
  }
  md.push('');
  const diffs = rows.filter((r) => !r.same);
  if (diffs.length) {
    md.push('## Differences (ear-verify these)\n');
    for (const r of diffs) {
      md.push(`### ${r.key} — "${r.transcript}"`);
      md.push(`- **baseline readings**: \`${r.baseReadings}\``);
      md.push(`- **candidate readings**: \`${r.candReadings}\``);
      md.push(`- **baseline spoke**: ${r.baseSpoke}`);
      md.push(`- **candidate spoke**: ${r.candSpoke}`);
      if (r.baseErr || r.candErr) md.push(`- **errors**: base=${r.baseErr ?? '-'} cand=${r.candErr ?? '-'}`);
      md.push('');
    }
  }
  fs.writeFileSync(args.out, md.join('\n') + '\n');
  line(`\nreport → ${args.out}`);

  if (!args.keep) {
    for (const p of [base.tmp, cand.tmp]) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* best-effort */
      }
    }
  } else {
    line(`lane JSON kept: ${base.tmp}  ${cand.tmp}`);
  }
}

main();
