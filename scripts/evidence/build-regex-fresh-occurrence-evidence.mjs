#!/usr/bin/env node
/**
 * A02D (2026-09-09) — build `docs/reference/evidence/regex-fresh-occurrence.json`
 * (RegexFreshOccurrenceEvidence).
 *
 * Inputs (paths repo-relative unless absolute; every input is optional and a
 * missing one is recorded as `not_run`, never invented):
 *   --fix-jest=<jest --json output>           fix-branch full backend run
 *   --fix-vitest=<vitest json reporter>       fix-branch A02D web test files
 *   --baseline-vitest=<vitest json reporter>  the A02D mounted harness run
 *                                             against the PRE-A02D web sources
 *   --bench-fix=<json> --bench-baseline=<json> matcher per-final timing runs
 *   --ios-tests=<dir> --ios-root=<dir>        iOS test sources to inventory
 *   --ios-results=<json {name: status}>
 *   --out=<path>  default docs/reference/evidence/regex-fresh-occurrence.json
 *   --verify      read the committed document instead of writing: exit 1 when
 *                 any source/fixture/test digest differs from the checkout
 *                 (the generated_from_commit is informational — the commit
 *                 that adds the document cannot contain its own hash).
 *                 `src/__tests__/evidence-regex-fresh-occurrence-verify.test.js`
 *                 runs this in CI, so editing an inventoried file means
 *                 regenerating the document with fresh run inputs.
 *
 * The document pins sha256 digests of the checked-out SOURCE, TEST and
 * FIXTURE bytes (never of the output file), the two baselines, the baseline
 * red proof with each row classified as behavioural vs harness-incompatible,
 * the bounded-work latency comparison, and per-test result inventories.
 * Deterministic: sorted keys, sorted inventories.
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
const OUT = args.out ?? 'docs/reference/evidence/regex-fresh-occurrence.json';

const SOURCES = [
  'src/extraction/sonnet-stream.js',
  'scripts/check-regex-freshness-fixture-sync.sh',
  'web/src/lib/job-context.tsx',
  'web/src/lib/recording-context.tsx',
  'web/src/lib/recording/apply-extraction.ts',
  'web/src/lib/recording/deepgram-service.ts',
  'web/src/lib/recording/final-window.ts',
  'web/src/lib/recording/held-fragment-clarification.ts',
  'web/src/lib/recording/normalisation-source-map.ts',
  'web/src/lib/recording/regex-destination-routing.ts',
  'web/src/lib/recording/regex-fresh-occurrence.ts',
  'web/src/lib/recording/regex-match-result.ts',
  'web/src/lib/recording/apply-regex-match.ts',
  'web/src/lib/recording/sonnet-session.ts',
  'web/src/lib/recording/field-source-tracker.ts',
  'scripts/evidence/build-regex-fresh-occurrence-evidence.mjs',
  'web/src/lib/recording/test-services.ts',
  'web/src/lib/recording/transcript-field-matcher.ts',
  'web/src/lib/recording/tts.ts',
  'web/src/lib/recording/voiced-activity.ts',
];
const FIXTURES = ['config/regex-freshness-vectors.json', 'config/closed-enum-vectors.json'];
const BACKEND_TESTS = [
  'src/__tests__/stage6-a02d-field-corrected-utterance-id.test.js',
  'src/__tests__/stage6-clear-board-reading-session-seam.test.js',
  'src/__tests__/stage6-honest-refusal.test.js',
];
const WEB_TESTS = [
  'web/tests/harness/a02d-regex-freshness-mounted.test.tsx',
  'web/tests/harness/a02d-regex-freshness-fixture-mounted.test.tsx',
  'web/tests/regex-fresh-occurrence.test.ts',
  'web/tests/regex-freshness-fixture.test.ts',
  'web/tests/held-fragment-clarification.test.ts',
  'web/tests/deepgram-service-final-window.test.ts',
  'web/tests/closed-enum-guard.test.ts',
  'web/tests/voiced-activity.test.ts',
  'web/tests/uplink-loss-recording-context-wiring.test.ts',
  'web/tests/deepgram-service-frozen-surface.test.ts',
  'web/tests/regex-destination-routing.test.ts',
  'web/tests/apply-regex-match.test.ts',
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
function loadJson(p) {
  if (!p) return null;
  const abs = path.isAbsolute(p) ? p : path.join(repoRoot, p);
  return fs.existsSync(abs) ? JSON.parse(fs.readFileSync(abs, 'utf8')) : null;
}
function relTestFile(name) {
  return path.relative(repoRoot, name).replace(/^(\.\.\/)+[^/]+\//, '');
}
/** jest/vitest json → rows {file, name, status, message}. */
function rows(doc, platform) {
  const out = [];
  for (const tr of doc?.testResults ?? []) {
    const file = relTestFile(tr.name);
    for (const a of tr.assertionResults ?? []) {
      out.push({
        platform,
        file,
        name: a.fullName ?? [...(a.ancestorTitles ?? []), a.title].join(' '),
        status: a.status,
        message: (a.failureMessages ?? [])[0]?.split('\n')[0] ?? null,
      });
    }
  }
  return out;
}
const HARNESS_INCOMPATIBLE = /is not a function|Cannot read properties of undefined|must be number or bigint/;
function classifyBaselineFailure(message) {
  if (!message) return null;
  return HARNESS_INCOMPATIBLE.test(message) ? 'harness_incompatible' : 'behavioural';
}

if (args.verify) {
  const committed = loadJson(OUT);
  if (!committed) {
    console.error(`verify: ${OUT} missing`);
    process.exit(1);
  }
  const expected = {
    sources: digests(SOURCES),
    fixtures: digests(FIXTURES),
    tests: digests([...BACKEND_TESTS, ...WEB_TESTS]),
  };
  const drift = [];
  for (const group of Object.keys(expected)) {
    for (const [file, digest] of Object.entries(expected[group])) {
      if ((committed.digests?.[group] ?? {})[file] !== digest) drift.push(`${group}: ${file}`);
    }
    for (const file of Object.keys(committed.digests?.[group] ?? {})) {
      if (!(file in expected[group])) drift.push(`${group}: ${file} (no longer inventoried)`);
    }
  }
  if (drift.length) {
    console.error(`verify: ${drift.length} digest(s) differ from the checkout:\n  ${drift.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`verify: ${OUT} digests match the checkout (generated from ${committed.generated_from_commit})`);
  process.exit(0);
}

const fixJest = loadJson(args['fix-jest']);
const fixVitest = loadJson(args['fix-vitest']);
const baselineVitest = loadJson(args['baseline-vitest']);

const inventory = [
  ...rows(fixJest, 'backend').filter((r) => BACKEND_TESTS.includes(r.file)),
  ...rows(fixVitest, 'web').filter((r) => WEB_TESTS.includes(r.file)),
].map(({ message, ...r }) => r);

if (args['ios-tests']) {
  const iosResults = loadJson(args['ios-results']) ?? {};
  const walk = (d) =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.swift') ? [path.join(d, e.name)] : []
    );
  for (const f of walk(args['ios-tests'])) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/func\s+(test[A-Za-z0-9_]*(?:[Ff]resh|[Ff]inalWindow|[Cc]larification|[Aa]dmission|[Cc]utoff|[Rr]eplay|[Gg]raceLifecycle|[Oo]ccurrence)[A-Za-z0-9_]*)\s*\(/g)) {
      inventory.push({
        platform: 'ios',
        file: path.relative(args['ios-root'] ?? path.dirname(args['ios-tests']), f),
        name: m[1],
        status: iosResults[m[1]] ?? 'see_ios_suite_log',
      });
    }
  }
}
inventory.sort((a, b) => `${a.platform}|${a.file}|${a.name}`.localeCompare(`${b.platform}|${b.file}|${b.name}`));

const baselineRows = rows(baselineVitest, 'web').map((r) => ({
  file: 'web/tests/harness/a02d-regex-freshness-mounted.test.tsx',
  name: r.name,
  status: r.status,
  failure_class: r.status === 'failed' ? classifyBaselineFailure(r.message) : null,
  first_line: r.message,
}));

const benchFix = loadJson(args['bench-fix']);
const benchBaseline = loadJson(args['bench-baseline']);

const doc = {
  schema_version: 1,
  name: 'RegexFreshOccurrenceEvidence',
  plan: 'A02D — Keep regex writes fresh after corrections and clears',
  generated_from_commit: git(['rev-parse', 'HEAD']),
  generated_at_commit_subject: git(['log', '-1', '--format=%s']),
  original_baseline: {
    backend_web: '2d7b9874',
    backend_web_subject: git(['log', '-1', '--format=%s', '2d7b9874']),
    ios: 'ed58177',
    note: 'A01P merged on both repos; the regex matcher compared transcript LENGTH, replayed audio after sleep, and re-applied a cleared occurrence.',
  },
  fixture_digests_pinned_by_clients: {
    regex_freshness_vectors: sha256File('config/regex-freshness-vectors.json'),
    closed_enum_vectors: sha256File('config/closed-enum-vectors.json'),
    sync_preflight: 'scripts/check-regex-freshness-fixture-sync.sh',
  },
  red_proof_rule:
    'The baseline lane runs the fix-branch mounted harness test against the PRE-A02D web sources with only the held-fragment clarification hooks and the fake service forwarders made optional (their targets do not exist there) and the session harness switched from real-decoder to the fake session (the real decoder\'s createSocket/getToken seams do not exist there). A failure whose first line is a missing-hook TypeError is harness_incompatible and is NOT red proof; an assertion on sends, writes, spoken counts or re-sent audio is behavioural red proof.',
  digests: {
    sources: digests(SOURCES),
    fixtures: digests(FIXTURES),
    tests: digests([...BACKEND_TESTS, ...WEB_TESTS]),
  },
  bounded_work_latency: {
    method:
      'TranscriptFieldMatcher.match() over ONE growing cumulative transcript of N finals (the provider call), median of REPS runs; on the fix the same call also builds the normalisation source map and the occurrence trace. A last-quartile mean that does not grow past the first-quartile mean shows per-final work is bounded by the sliding window, not the session length.',
    fix: benchFix,
    baseline: benchBaseline,
    delta_p50_ms:
      benchFix && benchBaseline ? +(benchFix.per_call_ms.p50 - benchBaseline.per_call_ms.p50).toFixed(4) : null,
  },
  summary: {
    backend_fix: fixJest
      ? { total: fixJest.numTotalTests, passed: fixJest.numPassedTests, failed: fixJest.numFailedTests }
      : null,
    web_fix: fixVitest
      ? { total: fixVitest.numTotalTests, passed: fixVitest.numPassedTests, failed: fixVitest.numFailedTests }
      : null,
    baseline_lane: baselineVitest
      ? {
          total: baselineVitest.numTotalTests,
          passed: baselineVitest.numPassedTests,
          failed: baselineVitest.numFailedTests,
          behavioural_red: baselineRows.filter((r) => r.failure_class === 'behavioural').length,
          harness_incompatible: baselineRows.filter((r) => r.failure_class === 'harness_incompatible').length,
        }
      : null,
    inventory_counts: inventory.reduce((acc, r) => {
      const k = `${r.platform}:${r.status}`;
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {}),
  },
  baseline_lane: baselineRows,
  tests: inventory,
};

fs.mkdirSync(path.dirname(path.join(repoRoot, OUT)), { recursive: true });
fs.writeFileSync(path.join(repoRoot, OUT), JSON.stringify(doc, null, 2) + '\n');
console.log(`wrote ${OUT}: ${inventory.length} inventory rows, ${baselineRows.length} baseline rows`);
