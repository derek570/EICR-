#!/usr/bin/env node
/**
 * nightly-live.mjs — the live advisory lane entrypoint (plan Item 3). Runs
 * the pre-run BUDGET ENVELOPE guard (STOP + file issue if the projected
 * complete-rotation cost × rotations/month exceeds the £10 target — no
 * vendor call is made), pins the three source-controlled routing values to
 * the task-def snapshot (enforced by the drift test in the blocking lane),
 * runs the live corpus for exactly ONE deterministically-selected shard,
 * and emits the structured run summary the Item-3 completion gate reads
 * (discovered/executed/vendor-call counts). Advisory: reports drift, never
 * blocks a merge.
 */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { evaluateBudgetEnvelope, selectShard } from './lib/budget.mjs';
import { discoverFixtures } from './lib/discovery.mjs';
import yaml from 'js-yaml';

const budget = JSON.parse(fs.readFileSync('config/field-replay-budget.json', 'utf8'));

// Live-tagged fixtures for THIS run's shard.
const CORPUS_ROOT = 'tests/fixtures/field-replay-corpus';
const all = discoverFixtures(CORPUS_ROOT).map((f) => ({ ...f, doc: yaml.load(fs.readFileSync(f.fixturePath, 'utf8')) }));
const liveFixtures = all
  .filter((f) => f.doc?.live_lane?.enabled === true)
  .map((f) => ({
    corpus_id: f.doc.corpus_id,
    model: f.doc.live_lane?.model ?? 'claude-haiku-4-5-20251001',
    shard: f.doc.live_lane?.shard ?? 0,
    token_ceilings: f.doc.live_lane?.token_ceilings,
  }));

// Pre-run envelope over a COMPLETE rotation (all live fixtures once).
const envelope = evaluateBudgetEnvelope(budget, liveFixtures);
const summary = {
  live_lane: true,
  discovered_fixture_count: all.length,
  live_tagged_fixture_count: liveFixtures.length,
  budget: envelope,
  executed_live_fixture_count: 0,
  vendor_call_count: 0,
  shard: null,
  results: [],
};

if (!envelope.ok) {
  summary.stopped = `projected monthly cost £${envelope.monthlyProjectionGbp} exceeds the £${envelope.targetGbp} target — STOP, no vendor call`;
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  fileAdvisoryIssue(summary.stopped);
  process.exit(0); // advisory — never block
}

if (liveFixtures.length === 0) {
  summary.note = '0 live-tagged fixtures — nothing to run (Foundation ships ZERO fixtures; this run cannot satisfy the Item-3 completion gate)';
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  process.exit(0);
}

// Deterministic ONE-of-N shard selection (day-of-month drives it; process
// uptime is not deterministic, so use the UTC day number from the fixed
// budget month — the schedule fires once/day so day-of-year modulo shards
// rotates cleanly).
const dayNumber = Math.floor(Date.parse(new Date().toISOString().slice(0, 10)) / 86400000);
const shard = selectShard(dayNumber, budget.shards);
summary.shard = shard;
const shardFixtures = liveFixtures.filter((f) => f.shard === shard);

// The live corpus run (advisory). The runner enforces the fetch-boundary
// vendor-call ceiling; here we scope to the shard's fixtures one at a time.
for (const f of shardFixtures) {
  try {
    const out = execFileSync(
      process.execPath,
      ['scripts/voice-latency-bench/transcript-replay-direct.mjs', '--model-lane=live', `--fixture=${f.corpus_id}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const s = JSON.parse(out);
    summary.executed_live_fixture_count += s.executed ?? 0;
    summary.vendor_call_count += s.vendor_call_count ?? 0;
    summary.results.push(...(s.results ?? []));
  } catch (err) {
    // Advisory: record but do not fail the lane.
    summary.results.push({ corpusId: f.corpus_id, verdict: 'advisory_error', detail: err.message });
  }
}

process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
process.exit(0);

function fileAdvisoryIssue(message) {
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) return;
  try {
    execFileSync('gh', ['issue', 'create', '--title', 'field-replay live lane: budget envelope exceeded', '--body', message], {
      env: { ...process.env, GH_TOKEN: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN },
      stdio: 'inherit',
    });
  } catch {
    /* advisory — issue creation best-effort */
  }
}
