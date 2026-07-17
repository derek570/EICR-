#!/usr/bin/env node
/**
 * prepush-gate.mjs — `replay:field-corpus:prepush` (plan Item 5). A LOCAL
 * backstop, NOT the ordinary blocking command (deadlock otherwise: at the
 * fix commit F, fixed expected_red fixtures intentionally XPASS, the
 * ordinary gate exits non-zero, and an `npm test &&`-structured hook would
 * reject the very push that triggers the GREEN evidence workflow — while
 * `--no-verify` stays prohibited).
 *
 * On NON-MAIN pushed refs ONLY, the prepush variant may accept an
 * ordinary-gate failure iff EVERY failure is an unexpired expected_red
 * XPASS, then reruns the identical assertions locally in
 * --proof-state=required_green for exactly those fixture ids and requires
 * zero assertion/infrastructure failures — this local result is PERMISSION
 * TO PUSH only, never trusted evidence. Main pushes and expired fixtures
 * keep the strict gate.
 *
 * It ALSO permits the phase-1 state 'new expected_red fixture, evidence not
 * yet fetched' (the push that triggers the evidence workflow) — which the
 * MERGE gate never accepts.
 *
 * NOTE: local diagnostics only. Node 20 is not installed on the dev box;
 * the authoritative gate is the Node-20 CI job. A local run failing here is
 * a signal, not a verdict.
 */

import { execFileSync } from 'node:child_process';

const CLI = 'scripts/voice-latency-bench/transcript-replay-direct.mjs';

function currentBranch() {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'HEAD';
  }
}

function runCorpus(extraArgs = []) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, '--model-lane=recorded', ...extraArgs], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    return { code: 0, summary: JSON.parse(stdout) };
  } catch (err) {
    let summary = null;
    try {
      summary = JSON.parse(err.stdout ?? '');
    } catch {
      /* non-JSON failure */
    }
    return { code: err.status ?? 1, summary };
  }
}

const branch = currentBranch();
const onMain = branch === 'main';

const strict = runCorpus();
if (strict.code === 0) {
  process.stderr.write('field-replay prepush: strict gate green.\n');
  process.exit(0);
}

if (onMain) {
  process.stderr.write('field-replay prepush: strict gate FAILED on main — not bypassable.\n');
  process.exit(strict.code || 1);
}

// Fail CLOSED if we cannot even parse the strict runner's summary. A crash,
// an OOM, or non-JSON stdout leaves `strict.summary === null`; without a
// parsed result set we cannot prove the failure is a benign expected_red
// XPASS, so an infrastructure failure must NEVER be silently downgraded to
// permission-to-push. (Previously `results` defaulted to [], every filter
// was empty, and the hook exited 0 — a silent local bypass on any crash.)
if (!strict.summary || !Array.isArray(strict.summary.results)) {
  process.stderr.write(
    'field-replay prepush: strict gate failed and produced no parseable summary ' +
      '(crash / non-JSON output) — failing closed, cannot bypass.\n',
  );
  process.exit(strict.code || 1);
}

// Non-main: the ONLY acceptable failure is an unexpired expected_red whose
// SOLE outcome is the XPASS (or the not-yet-evidenced expected_red at F).
const results = strict.summary.results;
const nonXpass = results.filter(
  (r) => r.verdict !== 'pass' && r.verdict !== 'reported' && r.verdict !== 'xpass',
);
if (nonXpass.length > 0) {
  process.stderr.write(
    `field-replay prepush: ${nonXpass.length} genuine failure(s) — cannot bypass:\n` +
      nonXpass.map((r) => `  ✗ ${r.corpusId}: ${r.verdict} — ${r.detail ?? ''}`).join('\n') +
      '\n',
  );
  process.exit(1);
}

// Every failure is an XPASS: rerun those fixtures in proof mode and require
// zero assertion/infrastructure failures (permission to push, not evidence).
const xpassIds = results.filter((r) => r.verdict === 'xpass').map((r) => r.corpusId);
if (xpassIds.length === 0) {
  // The strict gate exited non-zero but no fixture is an expected_red XPASS —
  // there is nothing to justify a bypass (e.g. empty result set on a runner
  // fault). Fail closed rather than exit 0 on an unexplained non-zero gate.
  process.stderr.write(
    'field-replay prepush: strict gate failed with no expected_red XPASS to bypass — failing closed.\n',
  );
  process.exit(strict.code || 1);
}
process.stderr.write(
  `field-replay prepush (non-main '${branch}'): ${xpassIds.length} expected_red XPASS — verifying in proof mode…\n`,
);
let ok = true;
for (const id of xpassIds) {
  const proof = runCorpus(['--evidence-mode', '--proof-state=required_green', `--fixture=${id}`]);
  const r = proof.summary?.results?.find((x) => x.corpusId === id);
  if (proof.code !== 0 || !r || r.verdict !== 'pass') {
    ok = false;
    process.stderr.write(`  ✗ ${id}: proof-mode FAILED — the fix does not make this fixture green.\n`);
  } else {
    process.stderr.write(`  ✓ ${id}: proof-mode green (permission to push).\n`);
  }
}
process.exit(ok ? 0 : 1);
