#!/usr/bin/env node
/**
 * A01P (2026-09-08) — build `docs/reference/evidence/accepted-field-consistency.json`
 * (AcceptedFieldConsistencyEvidence).
 *
 * Inputs (all paths repo-relative unless absolute):
 *   --fix-jest=<jest --json output>          fix-branch backend results (required)
 *   --baseline-orig-jest=<jest --json>      backend tests replayed on original_baseline
 *   --baseline-pred-jest=<jest --json>      backend tests replayed on predecessor_baseline
 *   --fix-vitest=<vitest json reporter>     fix-branch web results (optional)
 *   --ios-tests=<dir>                       iOS test sources to inventory (optional)
 *   --ios-results=<json {name: 'passed'|'failed'|'skipped'}> (optional)
 *   --out=<path>                            default docs/reference/evidence/accepted-field-consistency.json
 *
 * The document records: source/test/fixture digests (sha256 of the checked-out
 * bytes — NEVER of the output file itself), the two baselines, per-test
 * {file, name, classification} inventories with baseline/fix results, and the
 * destination surfaces. Deterministic: sorted keys, sorted inventories.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const repoRoot = process.cwd();
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  })
);
const OUT = args.out ?? 'docs/reference/evidence/accepted-field-consistency.json';

const SOURCES = [
  'src/extraction/stage6-dispatchers-circuit.js',
  'src/extraction/stage6-dispatchers-board.js',
  'src/extraction/stage6-dispatchers-answer.js',
  'src/extraction/stage6-snapshot-mutators.js',
  'src/extraction/stage6-inspect-projector.js',
  'src/extraction/stage6-tool-schemas.js',
  'src/extraction/pre-llm-gate.js',
  'src/extraction/sonnet-stream.js',
  'src/extraction/eicr-extraction-session.js',
  'config/prompts/sonnet_agentic_system.md',
  'config/dictated-readback-policy-v1.json',
  'config/conversation-admission-vectors.json',
  'scripts/field-replay/lib/fixture-schema.mjs',
  'scripts/field-replay/lib/replay-assertions.mjs',
  'scripts/check-job-state-fixture-sync.sh',
  'packages/shared-utils/src/voice-commands.ts',
  'packages/shared-utils/src/circuit-derivations.ts',
  'web/src/lib/recording/board-clear.ts',
  'web/src/lib/recording/apply-extraction.ts',
  'web/src/lib/recording/conversation-admission.ts',
  'web/src/lib/recording/transcript-gate.ts',
  'web/src/lib/recording/sonnet-session.ts',
  'web/src/lib/recording-context.tsx',
];
const FIXTURES = [
  'tests/fixtures/test-contracts/board-clear-scope-keys.json',
  'src/__tests__/fixtures/job-state/input-job.json',
  'src/__tests__/fixtures/job-state/single-board-boards-null.json',
  'src/__tests__/fixtures/job-state/single-board-boards-empty.json',
  'src/__tests__/fixtures/job-state/web-build-job-state-for-wire.json',
  'src/__tests__/fixtures/job-state/ios-build-job-state-for-server.json',
  'src/__tests__/fixtures/job-state/manifest.json',
  'tests/fixtures/field-replay-corpus/frc_cb24ba8b8edae9677281a9f8f6a1af2d/fixture.yaml',
];
const BACKEND_TESTS = [
  'src/__tests__/stage6-a01p-calculate-ze-unreadable.test.js',
  'src/__tests__/stage6-a01p-global-identity.test.js',
  'src/__tests__/stage6-a01p-accepted-alias.test.js',
  'src/__tests__/stage6-a01p-client-command-wire.test.js',
  'src/__tests__/stage6-a01p-job-state-fixture-seed.test.js',
  'src/__tests__/pre-llm-gate.test.js',
  'src/__tests__/eicr-extraction-session.plan-e-installation-ingest.test.js',
  'src/__tests__/eicr-extraction-session.fu4-supply-ze-canonical.test.js',
  'src/__tests__/field-replay/replay-assertions.test.js',
];

function sha256File(rel) {
  const p = path.isAbsolute(rel) ? rel : path.join(repoRoot, rel);
  if (!fs.existsSync(p)) return null;
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}
function digests(list) {
  const out = {};
  for (const f of [...list].sort()) out[f] = sha256File(f);
  return out;
}
function git(argsList, cwd = repoRoot) {
  try {
    return execFileSync('git', argsList, { cwd, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}
function classify(name) {
  if (/\[current_behaviour\]|test_currentBehaviour_/.test(name)) return 'current_behaviour';
  if (/\[invariant\]|test_invariant_/.test(name)) return 'invariant';
  return 'unclassified';
}
function loadJson(p) {
  if (!p) return null;
  const abs = path.isAbsolute(p) ? p : path.join(repoRoot, p);
  return fs.existsSync(abs) ? JSON.parse(fs.readFileSync(abs, 'utf8')) : null;
}
/** jest --json → Map<"file::fullName", status> (file repo-relative). */
function jestIndex(doc) {
  const m = new Map();
  if (!doc) return m;
  for (const tr of doc.testResults ?? []) {
    const file = path.relative(repoRoot, tr.name).replace(/^.*?src\/__tests__\//, 'src/__tests__/');
    for (const a of tr.assertionResults ?? []) m.set(`${file}::${a.fullName}`, a.status);
  }
  return m;
}
/** vitest json reporter → Map<"file::fullName", status>. */
function vitestIndex(doc) {
  const m = new Map();
  if (!doc) return m;
  for (const tf of doc.testResults ?? []) {
    const file = path.relative(repoRoot, tf.name);
    for (const a of tf.assertionResults ?? []) m.set(`${file}::${a.fullName}`, a.status);
  }
  return m;
}

const fixJest = loadJson(args['fix-jest']);
const origJest = jestIndex(loadJson(args['baseline-orig-jest']));
const predJest = jestIndex(loadJson(args['baseline-pred-jest']));
const fixVitest = loadJson(args['fix-vitest']);

const inventory = [];
// Backend: every A01P-relevant assertion from the fix run.
for (const [key, status] of jestIndex(fixJest)) {
  const [file, name] = key.split('::');
  if (!BACKEND_TESTS.includes(file)) continue;
  // Only classified rows are A01P-owned evidence; unprefixed tests in the
  // shared files (F/U-4, Plan E, the gate) are pre-existing coverage.
  const classification = classify(name);
  if (classification === 'unclassified') continue;
  inventory.push({
    platform: 'backend',
    file,
    name,
    classification,
    fix: status,
    original_baseline: origJest.get(key) ?? 'not_run',
    predecessor_baseline: predJest.get(key) ?? 'not_run',
  });
}
// Web: every classified vitest assertion.
for (const [key, status] of vitestIndex(fixVitest)) {
  const [file, name] = key.split('::');
  const c = classify(name);
  if (c === 'unclassified') continue;
  inventory.push({ platform: 'web', file, name, classification: c, fix: status });
}
// iOS: inventory from sources (+ optional results map).
if (args['ios-tests']) {
  const iosResults = loadJson(args['ios-results']) ?? {};
  const walk = (d) =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.swift') ? [path.join(d, e.name)] : []
    );
  for (const f of walk(args['ios-tests'])) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/func\s+(test_(?:invariant|currentBehaviour)_[A-Za-z0-9_]+)/g)) {
      const name = m[1];
      inventory.push({
        platform: 'ios',
        file: path.relative(args['ios-root'] ?? path.dirname(args['ios-tests']), f),
        name,
        classification: classify(name),
        fix: iosResults[name] ?? 'see_ios_suite_log',
      });
    }
  }
}
inventory.sort((a, b) => `${a.platform}|${a.file}|${a.name}`.localeCompare(`${b.platform}|${b.file}|${b.name}`));

const doc = {
  schema_version: 1,
  name: 'AcceptedFieldConsistencyEvidence',
  plan: 'A01P — Keep Ze corrections and client-name answers consistent',
  generated_from_commit: git(['rev-parse', 'HEAD']),
  generated_at_commit_subject: git(['log', '-1', '--format=%s']),
  original_baseline: {
    backend_web: '37dfde39e73e505301a812b1901d6a9f944c8259',
    ios: '02dca8926105e72bc4c148939756e93c8ab0bea8',
    note: 'Original alias/name/CONV defects (backend/web); green numeric routing/builders (iOS).',
  },
  predecessor_baseline: {
    backend_web: '298e5ae0',
    backend_web_subject: 'Merge pull request #207 from derek570/codex/a04p-dictated-readback-20260907',
    ios: '2d1056b7',
    ios_subject: 'Merge pull request #83 from derek570/codex/a04p-testflight-448',
    policy_digest: sha256File('config/dictated-readback-policy-v1.json'),
    admission_vectors_digest: sha256File('config/conversation-admission-vectors.json'),
  },
  classification_rule:
    'Jest/Vitest names carry [invariant] or [current_behaviour]; XCTest names carry test_invariant_ / test_currentBehaviour_. Invariants are A01P-owned behaviour (red on the baselines where the defect reproduces); current_behaviour rows are pinned for A01 to adjudicate. Control cases inside an [invariant] group are green on the baselines by design (already-correct cases).',
  red_proof_rule:
    'Missing imports or compile failures are never behavioural red proof; the baseline runs load the test files against the baseline sources (a static-import variant of the gate suite was used because the named export did not exist there).',
  digests: {
    sources: digests(SOURCES),
    fixtures: digests(FIXTURES),
    tests: digests(BACKEND_TESTS),
  },
  destinations: {
    backend: ['src/extraction/*', 'config/prompts/sonnet_agentic_system.md', 'tests/fixtures/*', 'scripts/*'],
    web: ['web/src/lib/recording/*', 'web/src/app/job/[id]/board/page.tsx', 'packages/shared-utils/src/*', 'web/docs/parity-ledger.md'],
    ios: ['Sources/Recording/*', 'Sources/Models/Job.swift', 'Sources/Services/ServerWebSocketService.swift', 'Tests/CertMateUnifiedTests/Fixtures/job-state/*', 'deploy-testflight.sh'],
  },
  summary: {
    backend_fix: fixJest
      ? { total: fixJest.numTotalTests, passed: fixJest.numPassedTests, failed: fixJest.numFailedTests }
      : null,
    inventory_counts: inventory.reduce((acc, r) => {
      const k = `${r.platform}:${r.classification}`;
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {}),
    baseline_red: {
      original: inventory.filter((r) => r.original_baseline === 'failed').length,
      predecessor: inventory.filter((r) => r.predecessor_baseline === 'failed').length,
    },
  },
  tests: inventory,
};

fs.mkdirSync(path.dirname(path.join(repoRoot, OUT)), { recursive: true });
fs.writeFileSync(path.join(repoRoot, OUT), JSON.stringify(doc, null, 2) + '\n');
console.log(`wrote ${OUT}: ${inventory.length} inventory rows`);
