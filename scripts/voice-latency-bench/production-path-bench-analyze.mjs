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
 * MEASURED only if, turn-for-turn, the cache outcome matches EXACTLY across
 * all arms in the block; any cross-arm outcome divergence, any cache-MISS
 * turn (rounds that neither wrote nor read cache), any errored/empty turn
 * anywhere in the block stratifies the WHOLE block out, reported separately,
 * never blended into the warm comparison. Warm latency sums run over the
 * all-arms-read turns of surviving blocks only (turn 1's matched cold write
 * is expected and excluded from the sum, not a disqualifier). Reps marked
 * rate_limited:true are excluded outright.
 *
 * 2026-08-16 pre-data tightening (dual adversarial review — Codex sol-high +
 * Sonnet-max — of the restart branch; NO benchmark data existed when these
 * landed, so the predeclared-rule discipline holds):
 *   - cache outcomes gained 'miss' and 'error' classes (previously a
 *     zero-cache miss or a non-429 failed turn silently counted as 'read');
 *   - block admission is all-or-nothing as stated above (previously a block
 *     with divergent turns could still contribute its matching subset);
 *   - parity compares the FINAL per-destination applied value (identical
 *     transcripts ⇒ identical final field state), not just the destination
 *     set, and additionally requires every applied write to have emitted an
 *     audible frame (Audio-First #1 — a silently-writing arm must not win);
 *   - a candidate wins only with usable paired data from EVERY fixture in
 *     the results file (previously one surviving fixture could decide).
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

// A turn's cache outcome. Round-level: 'write' if it wrote cache, 'read' if
// it read cache, 'miss' if it did neither (a genuine cache miss — full price,
// warm-comparison poison). Turn-level: 'error' if the turn recorded a live
// error (any failure, not just 429s — those already excluded the whole rep),
// 'none' if it produced no rounds, 'write' if any round wrote, 'read' only
// if EVERY round read, 'miss' otherwise. The old classifier labelled any
// no-write turn 'read' — a zero-cache miss or a failed turn slid into the
// warm stratum unnoticed (2026-08-16 review finding).
function turnCacheOutcome(turn) {
  if (turn.live_error) return 'error';
  const rounds = turn.round_usage ?? [];
  if (rounds.length === 0) return 'none';
  if (rounds.some((r) => (r.cache_write_input_tokens ?? 0) > 0)) return 'write';
  return rounds.every((r) => (r.cache_read_input_tokens ?? 0) > 0) ? 'read' : 'miss';
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
      const turnCounts = repsByArm.map((r) => r.turns.length);
      // Arms replay the SAME fixture transcript — divergent turn counts mean
      // an arm lost turns (error/cancellation) and the block is not a fair
      // pairing. The old Math.min silently truncated to the shortest arm.
      if (new Set(turnCounts).size > 1) {
        fixtureReport.blocks_stratified_out.push({ block: blockId, reason: 'turn_count_mismatch' });
        continue;
      }
      const turnCount = turnCounts[0];

      // All-or-nothing admission (2026-08-16 tightening — see header): every
      // turn index must have an IDENTICAL cache outcome across arms, and that
      // outcome must be 'read' or 'write' (matched cold turns are expected —
      // excluded from the warm sum, not disqualifying). Any divergence, miss,
      // error or empty turn anywhere stratifies the whole block out.
      const warmIdx = [];
      let strataReason = null;
      for (let i = 0; i < turnCount && !strataReason; i++) {
        const outcomes = repsByArm.map((r) => turnCacheOutcome(r.turns[i]));
        const uniform = new Set(outcomes).size === 1;
        if (!uniform) strataReason = 'cache_outcome_mismatch';
        else if (outcomes[0] === 'read') warmIdx.push(i);
        else if (outcomes[0] === 'write') continue; // matched cold turn — fine, just not warm
        else strataReason = `turn_${outcomes[0]}`; // miss / error / none anywhere poisons the block
      }
      if (!strataReason && warmIdx.length === 0) strataReason = 'no_warm_turns';
      if (strataReason) {
        fixtureReport.blocks_stratified_out.push({ block: blockId, reason: strataReason });
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

      // Semantic parity (2026-08-16 tightening — see header): identical
      // transcripts ⇒ identical FINAL field state, so compare the final
      // applied value per destination, not just the destination set. The
      // eviction fixture's EXPECTED difference is a REPEAT write of the same
      // value to the SAME destination, which last-write-per-destination
      // deliberately tolerates — a VALUE divergence (arm writes 0.70 where
      // baseline wrote 0.80) now fails parity where the set comparison
      // passed it. Additionally: every applied write must have emitted an
      // audible frame (Audio-First #1) — an arm that writes silently must
      // not be eligible to win on latency.
      const finalState = (rep) => {
        const state = new Map();
        let unspoken = 0;
        for (const t of rep.turns) {
          for (const l of t.ledger ?? []) {
            if (!l.applied_mutation || l.dispatch_outcome !== 'ok') continue;
            state.set(l.canonical_destination, l.normalised_value ?? null);
            if (!l.emitted_audible_frame) unspoken += 1;
          }
        }
        return { state: JSON.stringify([...state.entries()].sort()), unspoken };
      };
      const base = finalState(arms.get(BASELINE_ARM));
      if (base.unspoken > 0) {
        for (const cand of CANDIDATE_ARMS) fixtureReport.parity[cand].destination_mismatch_blocks += 1;
      } else {
        for (const cand of CANDIDATE_ARMS) {
          const c = finalState(arms.get(cand));
          if (c.state !== base.state || c.unspoken > 0) fixtureReport.parity[cand].destination_mismatch_blocks += 1;
        }
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
  const fixturesTotal = byFixture.size;
  const decision = {};
  for (const cand of CANDIDATE_ARMS) {
    const meds = Object.values(perFixtureMedians[cand]).filter((m) => m !== null);
    const mean = meds.length ? meds.reduce((a, b) => a + b, 0) / meds.length : null;
    // "Consistent sign on a majority of fixtures" is judged against ALL
    // fixtures in the run, not just the ones that survived stratification —
    // a fixture with no usable paired data cannot silently shrink the
    // denominator (2026-08-16 tightening).
    const positives = meds.filter((m) => m > 0).length;
    const signConsistent = fixturesTotal > 0 && positives > fixturesTotal / 2;
    const parityClean = Object.values(report.fixtures).every((f) => f.parity[cand].destination_mismatch_blocks === 0);
    // Full coverage: a win needs usable paired-warm evidence from EVERY
    // fixture. Provider failures wiping out five of six fixtures must not
    // let the survivor decide alone — the run is INCONCLUSIVE instead, with
    // the missing fixtures named.
    const fixturesWithoutPairedData = [...byFixture.keys()].filter((f) => perFixtureMedians[cand][f] === null || perFixtureMedians[cand][f] === undefined);
    decision[cand] = {
      per_fixture_medians: perFixtureMedians[cand],
      mean_of_medians: mean,
      sign_consistent_majority: signConsistent,
      parity_clean: parityClean,
      fixtures_without_paired_data: fixturesWithoutPairedData,
      wins:
        parityClean &&
        fixturesWithoutPairedData.length === 0 &&
        mean !== null &&
        mean >= MIN_EFFECT &&
        signConsistent,
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
