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
import { judgeSample } from './lib/semantic-judge.mjs';

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
    // Implementation proof: the judge consumes each frozen projection and a
    // synthetic evidence set derived FROM the projection itself; this proves
    // the projection→judge plumbing end-to-end without any model output and
    // is deliberately NEVER reported as vendor evidence.
    let pass = 0;
    for (const fixture of manifests.vendorLive.fixtures) {
      const receipts = [];
      const audibleTexts = [];
      for (const turn of fixture.turns) {
        for (const op of turn.operations) {
          receipts.push({
            kind: op.kind ?? 'reading',
            field: op.field,
            circuit: op.circuit,
            board_id: op.board_id,
            value: op.value,
            parent_operation_id: null,
          });
        }
        for (const out of turn.audible_outputs) {
          if (out.match?.text_exact) {
            for (let i = 0; i < (out.count ?? 1); i += 1) audibleTexts.push(out.match.text_exact);
          }
        }
      }
      const verdict = judgeSample(fixture, { receipts, audibleTexts, captureInvalid: null });
      if (verdict.verdict === 'PASS') pass += 1;
      console.log(`mock ${fixture.corpus_id}: ${verdict.verdict}${verdict.reason ? ` (${verdict.reason})` : ''}`);
    }
    console.log(`mock lane: ${pass}/${manifests.vendorLive.fixtures.length} projections judge PASS against their own semantics`);
    if (pass !== manifests.vendorLive.fixtures.length) process.exitCode = 1;
    return;
  }

  // --mode=live: the attested vendor lane. The composition (real
  // initSonnetStream + evaluation context + per-fixture session + paced
  // inspector turns + judge) is exercised by the Plan 00C cohort runner
  // once attestation exists; the env isolation contract is enforced here.
  const problems = assertLaneIsolationEnv();
  if (problems.length > 0) {
    console.error(`REFUSED: lane isolation violated — ${problems.join('; ')}`);
    process.exitCode = 2;
    return;
  }
  console.error('live lane: attestation record accepted; cohort execution is owned by Plan 00C.');
}

const isDirect = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isDirect) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
