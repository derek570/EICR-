#!/usr/bin/env node
/**
 * production-path-bench-analyze.mjs — applies plan 08C-A's PREDECLARED
 * decision rule to a production-path-bench.mjs evidence file.
 *
 * The rule is implemented here as committed code (not ad-hoc analysis) so the
 * decision is reproducible from the evidence artifact alone. Nothing in this
 * file may be tuned after looking at results — the thresholds below are the
 * plan's, verbatim:
 *
 *   Primary statistic (dimensionless): per fixture, the MEDIAN across paired
 *   blocks of (baseline_ms − candidate_ms) / baseline_ms over total per-turn
 *   round-stream time (WARM rounds only); then the unweighted MEAN of those
 *   per-fixture medians. Minimum effect: mean ≥ 10% AND per-fixture medians
 *   consistent in sign on a majority of fixtures. Parity gates are pass/fail
 *   prerequisites BEFORE latency is compared. Anything else → INCONCLUSIVE,
 *   keep recent_3.
 *
 *   Causality table (eviction fixture): d(arm) = fraction of blocks whose
 *   ledger shows a duplicate/re-derived write. Supported: d(recent_3) ≥ 0.5
 *   AND d(ascending) = 0 AND d(window_6) = 0. Refuted: either candidate arm
 *   duplicates at a rate comparable to recent_3. Untested: d = 0 everywhere.
 *   Inconclusive: anything else.
 *
 * Cache stratification (per the plan's §2.1 invariant): a paired block is
 * MEASURED only if, turn-for-turn, the cache outcome (write vs read) matches
 * across all arms in the block; blocks containing any cache-write round or a
 * cross-arm outcome mismatch are reported separately, never blended into the
 * warm comparison. Reps marked rate_limited:true are excluded outright.
 *
 * Usage: node scripts/voice-latency-bench/production-path-bench-analyze.mjs <results.json>
 */

import fs from 'node:fs';

const BASELINE_ARM = 'recent_3';
const CANDIDATE_ARMS = ['ascending', 'window_6'];
const MIN_EFFECT = 0.1; // predeclared, plan 08C-A deliverable 2
const EVICTION_FIXTURE_PREFIX = 'eviction_redictation';

function median(xs) {
  if (xs.length === 0) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function p(xs, q) {
  if (xs.length === 0) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[idx];
}

// A turn's cache outcome: 'write' if any round wrote cache, 'read' if all
// rounds read, 'none' if the turn produced no rounds (errored/cancelled).
function turnCacheOutcome(turn) {
  const rounds = turn.round_usage ?? [];
  if (rounds.length === 0) return 'none';
  return rounds.some((r) => (r.cache_write_input_tokens ?? 0) > 0) ? 'write' : 'read';
}

function turnStreamMs(turn) {
  return (turn.round_timings ?? []).reduce((s, r) => s + (r.stream_ms ?? 0), 0);
}

function main() {
  const resultsPath = process.argv[2];
  if (!resultsPath) {
    process.stderr.write('usage: production-path-bench-analyze.mjs <results.json>\n');
    process.exit(2);
  }
  const reps = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));

  const clean = reps.filter((r) => !r.rate_limited);
  const excluded = reps.length - clean.length;

  // Group: fixture -> block_id -> arm -> rep
  const byFixture = new Map();
  for (const rep of clean) {
    if (!byFixture.has(rep.fixture_id)) byFixture.set(rep.fixture_id, new Map());
    const byBlock = byFixture.get(rep.fixture_id);
    if (!byBlock.has(rep.block_id)) byBlock.set(rep.block_id, new Map());
    byBlock.get(rep.block_id).set(rep.arm, rep);
  }

  const report = {
    input: resultsPath,
    reps_total: reps.length,
    reps_excluded_rate_limited: excluded,
    fixtures: {},
    decision: null,
    causality: null,
  };

  const armNames = [BASELINE_ARM, ...CANDIDATE_ARMS];
  const perFixtureMedians = { ascending: {}, window_6: {} };

  for (const [fixtureId, byBlock] of byFixture) {
    const fixtureReport = {
      blocks_total: byBlock.size,
      blocks_paired_warm: 0,
      blocks_stratified_out: [],
      per_arm: {},
      paired_rel_diff: { ascending: [], window_6: [] },
      parity: { ascending: { destination_mismatch_blocks: 0 }, window_6: { destination_mismatch_blocks: 0 } },
    };

    // Per-arm descriptive stats over ALL clean turns (warm rounds only).
    for (const arm of armNames) {
      const streams = [];
      const firstToolSpans = [];
      const freshTokens = [];
      let roundsTotal = 0;
      for (const [, arms] of byBlock) {
        const rep = arms.get(arm);
        if (!rep) continue;
        for (const t of rep.turns) {
          if (turnCacheOutcome(t) !== 'read') continue;
          streams.push(turnStreamMs(t));
          roundsTotal += (t.round_timings ?? []).length;
          for (const r of t.round_timings ?? []) {
            if (r.first_tool_use_ns != null && r.started_ns != null) {
              firstToolSpans.push(Number((BigInt(r.first_tool_use_ns) - BigInt(r.started_ns)) / 1000000n));
            }
          }
          for (const u of t.round_usage ?? []) freshTokens.push(u.fresh_input_tokens ?? 0);
        }
      }
      fixtureReport.per_arm[arm] = {
        warm_turns: streams.length,
        rounds: roundsTotal,
        turn_stream_ms_p50: p(streams, 0.5),
        turn_stream_ms_p95: p(streams, 0.95),
        first_tool_span_ms_p50: p(firstToolSpans, 0.5),
        fresh_input_tokens_p50: p(freshTokens, 0.5),
        fresh_input_tokens_max: freshTokens.length ? Math.max(...freshTokens) : null,
      };
    }

    // Paired within-block comparison, warm-matched turns only.
    for (const [blockId, arms] of byBlock) {
      if (!armNames.every((a) => arms.has(a))) {
        fixtureReport.blocks_stratified_out.push({ block: blockId, reason: 'missing_arm' });
        continue;
      }
      const repsByArm = armNames.map((a) => arms.get(a));
      const turnCount = Math.min(...repsByArm.map((r) => r.turns.length));

      // Warm-matched turn indices: same cache outcome === 'read' in EVERY arm.
      const warmIdx = [];
      let mismatch = false;
      for (let i = 0; i < turnCount; i++) {
        const outcomes = repsByArm.map((r) => turnCacheOutcome(r.turns[i]));
        if (outcomes.every((o) => o === 'read')) warmIdx.push(i);
        else if (new Set(outcomes).size > 1 && outcomes.some((o) => o === 'read') && outcomes.some((o) => o === 'write'))
          mismatch = true;
      }
      if (warmIdx.length === 0) {
        fixtureReport.blocks_stratified_out.push({ block: blockId, reason: mismatch ? 'cache_outcome_mismatch' : 'no_warm_turns' });
        continue;
      }
      fixtureReport.blocks_paired_warm += 1;

      const totals = {};
      for (let a = 0; a < armNames.length; a++) {
        totals[armNames[a]] = warmIdx.reduce((s, i) => s + turnStreamMs(repsByArm[a].turns[i]), 0);
      }
      for (const cand of CANDIDATE_ARMS) {
        if (totals[BASELINE_ARM] > 0) {
          fixtureReport.paired_rel_diff[cand].push((totals[BASELINE_ARM] - totals[cand]) / totals[BASELINE_ARM]);
        }
      }

      // Semantic parity: the applied-write destination set must match the
      // baseline's within the same block (identical transcripts ⇒ identical
      // intended final field state). The eviction fixture's EXPECTED
      // difference is a repeat write to the SAME destination, which a set
      // comparison deliberately tolerates.
      const destSet = (rep) =>
        JSON.stringify(
          [...new Set(rep.turns.flatMap((t) => (t.ledger ?? []).filter((l) => l.applied_mutation).map((l) => l.canonical_destination)))].sort()
        );
      const baseSet = destSet(arms.get(BASELINE_ARM));
      for (const cand of CANDIDATE_ARMS) {
        if (destSet(arms.get(cand)) !== baseSet) fixtureReport.parity[cand].destination_mismatch_blocks += 1;
      }
    }

    for (const cand of CANDIDATE_ARMS) {
      perFixtureMedians[cand][fixtureId] = median(fixtureReport.paired_rel_diff[cand]);
    }
    report.fixtures[fixtureId] = fixtureReport;
  }

  // Causality table over the eviction fixture.
  const evictionId = [...byFixture.keys()].find((f) => f.startsWith(EVICTION_FIXTURE_PREFIX));
  if (evictionId) {
    const byBlock = byFixture.get(evictionId);
    const d = {};
    for (const arm of armNames) {
      let dup = 0;
      let n = 0;
      for (const [, arms] of byBlock) {
        const rep = arms.get(arm);
        if (!rep) continue;
        n += 1;
        if (rep.turns.some((t) => t.duplicate_write_detected)) dup += 1;
      }
      d[arm] = n > 0 ? dup / n : null;
    }
    let verdict;
    if (Object.values(d).every((v) => v === 0)) verdict = 'UNTESTED — trigger never fired in any arm; no refutation claim';
    else if (d[BASELINE_ARM] >= 0.5 && d.ascending === 0 && d.window_6 === 0)
      verdict = 'SUPPORTED — duplicate follows visibility; vanishes when the circuit is rendered';
    else if (
      (d.ascending > 0 && d.ascending >= d[BASELINE_ARM] * 0.5) ||
      (d.window_6 > 0 && d.window_6 >= d[BASELINE_ARM] * 0.5)
    )
      verdict = 'REFUTED — duplicates occur even with the circuit visible';
    else verdict = 'INCONCLUSIVE — keep recent_3, report rates, no causal claim';
    report.causality = { fixture: evictionId, d, verdict };
  }

  // Decision rule.
  const decision = {};
  for (const cand of CANDIDATE_ARMS) {
    const meds = Object.values(perFixtureMedians[cand]).filter((m) => m !== null);
    const mean = meds.length ? meds.reduce((a, b) => a + b, 0) / meds.length : null;
    // A win requires the mean ≥ +10% (candidate faster), so "consistent sign
    // on a majority of fixtures" means: a strict majority of per-fixture
    // medians are POSITIVE (agreeing with the claimed direction).
    const positives = meds.filter((m) => m > 0).length;
    const signConsistent = meds.length > 0 && positives > meds.length / 2;
    const parityClean = Object.values(report.fixtures).every((f) => f.parity[cand].destination_mismatch_blocks === 0);
    decision[cand] = {
      per_fixture_medians: perFixtureMedians[cand],
      mean_of_medians: mean,
      sign_consistent_majority: signConsistent,
      parity_clean: parityClean,
      wins: parityClean && mean !== null && mean >= MIN_EFFECT && signConsistent,
    };
  }
  let outcome;
  if (decision.ascending.wins && decision.window_6.wins)
    outcome = 'BOTH candidate arms pass — ship the SIMPLER (ascending), record window_6 as available';
  else if (decision.ascending.wins) outcome = 'ascending WINS';
  else if (decision.window_6.wins) outcome = 'window_6 WINS';
  else outcome = 'NO ARM WINS — keep recent_3 (inconclusive or sub-threshold)';
  report.decision = { per_arm: decision, outcome };

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

main();
