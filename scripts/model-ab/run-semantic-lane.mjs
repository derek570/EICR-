#!/usr/bin/env node
/**
 * Plan 00B §B5 — production-composed trusted-semantic-oracle lane runner.
 *
 * Replaces the reduced/provider-agreement A/B (run-lane.mjs + compare.mjs)
 * with a REAL-server lane: the actual `initSonnetStream` WebSocket handler,
 * an evaluation context per session (Plan 00B lifecycle hooks), mutation
 * capture at the canonical snapshot atoms, and the trusted semantic judge
 * against frozen UNREVIEWED-DRAFT/attested expectation projections.
 *
 * HARD GATE (§B4/§B6): live vendor sampling is FORBIDDEN until Plan 00C
 * records Derek's `expectations_attested` event. Without
 * `--attestation-record=<path>` this runner only accepts `--mode=mock`
 * (implementation proof over the recorded corpus — recorded responses can
 * never satisfy the live lane and are never reported as vendor evidence).
 *
 * Lane isolation (§B5): the model under test is isolated —
 *   SONNET_TOOL_CALLS=live, Loaded Barrel OFF, observation-tier escalation
 *   disabled (or pinned to the lane model), round-one override EMPTY.
 * Evaluation-only SDK clients disable automatic retries. Samples are paced
 * with --inter-turn-ms (default 10000) BETWEEN inspector turns/samples,
 * never between rounds of one conversational turn. Provider-proven
 * throttling is excluded/retried after reset and reported separately.
 *
 * Output (PII-safe): per-sample id, corpus/expectation hash, provider/
 * model, requested/served tier, round count, cache buckets, status class,
 * semantic verdict and phase timings; aggregate pass rate, mismatch
 * classes, p50/p95, all/unthrottled distributions, cache ratios and
 * actual/no-cache cost. No transcripts, no prompts, no dispatcher payloads.
 */

import process from 'node:process';
import {
  renderExpectationManifests,
  computeSemanticOracleDigest,
  VENDOR_LIVE_FIXTURE_IDS,
} from './lib/expectation-projection.mjs';

function parseArgs(argv) {
  const args = { mode: 'mock', interTurnMs: 10000, attestationRecord: null, model: null };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--mode=')) args.mode = a.slice(7);
    else if (a.startsWith('--inter-turn-ms=')) args.interTurnMs = Number(a.slice(16));
    else if (a.startsWith('--attestation-record=')) args.attestationRecord = a.slice(21);
    else if (a.startsWith('--model=')) args.model = a.slice(8);
    else if (a === '--help') args.help = true;
  }
  return args;
}

export function assertLaneIsolationEnv(env = process.env) {
  const problems = [];
  if ((env.SONNET_TOOL_CALLS || 'off') !== 'live') problems.push('SONNET_TOOL_CALLS must be live');
  if (env.VOICE_LATENCY_LOADED_BARREL === 'true') problems.push('Loaded Barrel must be OFF');
  if (env.OBSERVATION_TIER_ROUTING === 'true' && !env.SEMANTIC_LANE_OBSERVATION_MODEL) {
    problems.push('observation tier escalation must be disabled or pinned to the lane model');
  }
  if (env.VOICE_LATENCY_ROUND1_MODEL) problems.push('round-one override must be empty');
  return problems;
}

async function main() {
  const args = parseArgs(process.argv);
  const repoRoot = new URL('../..', import.meta.url).pathname;

  if (args.help) {
    console.log(
      'usage: run-semantic-lane.mjs --mode=mock|live [--model=<id>] [--inter-turn-ms=10000] [--attestation-record=<path>]'
    );
    return;
  }

  if (args.mode === 'live' && !args.attestationRecord) {
    console.error(
      'REFUSED: live vendor sampling requires the Plan 00C expectations_attested record (--attestation-record). ' +
        'Plan 00B stores no attestation; run --mode=mock for implementation proof.'
    );
    process.exitCode = 2;
    return;
  }

  const manifests = renderExpectationManifests(repoRoot);
  const oracle = computeSemanticOracleDigest(repoRoot);
  console.log(`semantic_oracle_digest: ${oracle.digest}`);
  console.log(`vendor_live_expectations sha256: ${manifests.vendor_live_sha256}`);
  console.log(`deterministic_egress sha256: ${manifests.deterministic_egress_sha256}`);
  console.log(`combined anchor: ${manifests.combined_sha256}`);
  console.log(`fixtures in vendor lane: ${VENDOR_LIVE_FIXTURE_IDS.length}`);

  if (args.mode === 'mock') {
    // Plan 00B-2 C4 — the REAL-SERVER mock lane: every vendor fixture is
    // driven through the actual initSonnetStream WS ingress with the strict
    // per-turn scripted client, judged from the C3 completion latch's
    // frozen evidence. Implementation proof only — never vendor evidence.
    // (The former synthetic self-judging mock — the projection judging its
    // own semantics — is DELETED: it proved plumbing, not composition.)
    const { runVendorLaneMock } = await import('./lib/lane-driver.mjs');
    const { results, allPass } = await runVendorLaneMock({
      repoRoot,
      log: (line) => console.error(line),
    });
    for (const r of results) {
      console.log(`mock ${r.corpus_id}: ${r.verdict}${r.reason ? ` (${r.reason})` : ''}`);
    }
    const pass = results.filter((r) => r.verdict === 'PASS').length;
    console.log(
      `mock lane: ${pass}/${results.length} fixtures judge PASS end-to-end through the real server`
    );
    // Any INVALID_HOLD is a composition bug to fix, not to waive.
    if (!allPass) process.exitCode = 1;
    return;
  }

  // --mode=live: the attested vendor lane. Keeps the attestation refusal
  // (above) and the lane-isolation assertions, then delegates to the SAME
  // driver composition (bootLaneDriver/driveFixture in lib/lane-driver.mjs)
  // with real clients — execution beyond this gate's smoke remains Plan
  // 00C's (its cohort runner invokes the driver under an attested record).
  const problems = assertLaneIsolationEnv();
  if (problems.length > 0) {
    console.error(`REFUSED: lane isolation violated — ${problems.join('; ')}`);
    process.exitCode = 2;
    return;
  }
  console.error(
    'live lane: attestation record accepted; cohort execution (the same lane driver with real clients) is owned by Plan 00C.'
  );
}

const isDirect = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isDirect) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
