#!/usr/bin/env node
/**
 * generate-evidence.mjs — the deterministic-evidence PROOF MODE producer
 * (plan Item 4). At subject F a fixture is still expected_red, so the
 * ordinary runner reports XPASS and exits non-zero — yet trusted-run
 * retrieval requires a SUCCESSFUL workflow conclusion, so no qualifying
 * GREEN artifact could exist. This command evaluates the IDENTICAL immutable
 * assertions while bypassing ONLY the expected_red XPASS inversion, retains
 * every validation/infrastructure failure, and emits the STRUCTURED
 * runner-result.json (subject/harness/base/tested-tree identities + fixture
 * hash + assertion id + outcome + node version) that accept-evidence fetches
 * and verifies. Structurally unavailable to the blocking package script:
 * `replay:field-corpus:evidence` maps here via the bootstrap's
 * --evidence-mode, and local invocations are diagnostics, never evidence
 * (only the trusted workflow's upload is admissible).
 *
 * It shells the corpus CLI (recorded lane), captures its JSON summary, and
 * wraps it with the git-derived identities.
 */

import { execFileSync } from 'node:child_process';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.length ? rest.join('=') : true];
  }),
);

function git(a) {
  try {
    return execFileSync('git', a, { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

const passThrough = [];
if (args['proof-state']) passThrough.push('--evidence-mode', `--proof-state=${args['proof-state']}`);
if (args.fixture) passThrough.push(`--fixture=${args.fixture}`);

let summary = null;
let cliCode = 0;
try {
  const out = execFileSync(
    process.execPath,
    ['scripts/voice-latency-bench/transcript-replay-direct.mjs', '--model-lane=recorded', ...passThrough],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  summary = JSON.parse(out);
} catch (err) {
  cliCode = err.status ?? 1;
  try {
    summary = JSON.parse(err.stdout ?? '');
  } catch {
    summary = { error: 'non-JSON runner output', stdout: (err.stdout ?? '').slice(0, 500) };
  }
}

const headSha = git(['rev-parse', 'HEAD']);
const treeOid = git(['rev-parse', 'HEAD^{tree}']);

// For a scoped single-fixture proof, surface that fixture's assertion +
// hash; otherwise the summary carries all results.
const first = (summary?.results ?? [])[0] ?? {};

const runnerResult = {
  evidence_schema: 1,
  kind: args['proof-state'] === 'required_green' ? 'green' : 'red',
  proof_state: args['proof-state'] ?? null,
  corpus_id: args.fixture ?? first.corpusId ?? null,
  assertion_id: first.detail?.match?.(/[a-z0-9_.]+/i)?.[0] ?? null,
  subject_code_sha: args['subject-sha'] || null,
  harness_commit_sha: headSha,
  base_sha: args['base-sha'] || null,
  tested_tree_oid: treeOid,
  exact_command: `npm run replay:field-corpus${passThrough.length ? ' -- ' + passThrough.join(' ') : ''}`,
  outcome: first.verdict ?? summary?.exitCode ?? cliCode,
  node_version: process.version,
  summary,
};

process.stdout.write(JSON.stringify(runnerResult, null, 2) + '\n');
// Evidence generation itself succeeds (conclusion: success) so the artifact
// is retrievable; the accept-evidence tool decides admissibility from the
// structured fields, not the CLI exit code.
process.exit(0);
