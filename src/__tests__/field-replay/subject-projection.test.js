/**
 * subject-projection.test.js — the machine check behind "CI-verified
 * test-infra-only diff scope" (plan Item 4). Proves all required Foundation
 * files are ALLOWED while any runtime-source or runtime-loaded-config
 * change invalidates baseline equivalence, and that production dependencies
 * compare as the PRODUCTION-REACHABLE resolved graph (dev-only churn
 * passes; a production TRANSITIVE version change fails with the direct
 * dependency list unchanged).
 */

import {
  isSubjectPath,
  FOUNDATION_CONFIG_EXCLUSIONS,
  diffProjections,
  productionReachableGraph,
  diffProductionGraphs,
  compareSubjectProjection,
} from '../../../scripts/field-replay/subject-projection.mjs';

describe('subject-path classification', () => {
  test('runtime source, runtime config, prompts, ECS task defs, and Docker inputs are SUBJECT paths', () => {
    expect(isSubjectPath('src/extraction/stage6-shadow-harness.js')).toBe(true);
    expect(isSubjectPath('src/sonnet-stream.js')).toBe(true);
    expect(isSubjectPath('config/field_schema.json')).toBe(true);
    expect(isSubjectPath('config/prompts/sonnet_agentic_system.md')).toBe(true);
    expect(isSubjectPath('ecs/task-def-backend.json')).toBe(true);
    expect(isSubjectPath('docker/backend.Dockerfile')).toBe(true);
  });
  test('Foundation files are ALLOWED (non-subject): test helpers, scripts, workflows, enumerated config manifests', () => {
    expect(isSubjectPath('src/__tests__/helpers/f7-audibility-core.js')).toBe(false);
    expect(isSubjectPath('src/__tests__/field-replay/budget.test.js')).toBe(false);
    expect(isSubjectPath('scripts/field-replay/lib/canonical-crypto.mjs')).toBe(false);
    expect(isSubjectPath('.github/workflows/field-replay-evidence.yml')).toBe(false);
    expect(isSubjectPath('package.json')).toBe(false); // harness/dependency input (graph-compared)
    expect(isSubjectPath('package-lock.json')).toBe(false);
    for (const excluded of FOUNDATION_CONFIG_EXCLUSIONS) {
      expect(isSubjectPath(excluded)).toBe(false);
    }
  });
  test('every Foundation config exclusion is enumerated (adding a manifest without listing it makes the projection fail)', () => {
    expect(FOUNDATION_CONFIG_EXCLUSIONS).toEqual([
      'config/field-replay-maintainers.json',
      'config/field-replay-budget.json',
      'config/field-replay-ruleset-activated.json',
      'config/field-replay-runtime.json',
      'config/field-replay-harness-manifest.json',
    ]);
  });
});

describe('projection diffing', () => {
  test('identical projections pass; add/modify/delete are each reported', () => {
    const subject = new Map([
      ['src/a.js', 'aaa'],
      ['src/b.js', 'bbb'],
    ]);
    expect(diffProjections(subject, new Map(subject))).toEqual([]);
    const head = new Map([
      ['src/a.js', 'aaa2'], // modified
      ['src/c.js', 'ccc'], // added
    ]); // b deleted
    const diffs = diffProjections(subject, head);
    expect(diffs).toEqual(
      expect.arrayContaining([
        { path: 'src/a.js', kind: 'modified' },
        { path: 'src/b.js', kind: 'deleted' },
        { path: 'src/c.js', kind: 'added' },
      ]),
    );
  });
});

describe('production-reachable dependency graph', () => {
  function lock({ prodTransitiveVersion = '1.0.0', devExtra = false } = {}) {
    return {
      packages: {
        '': {
          dependencies: { express: '^4.0.0' },
          devDependencies: { jest: '^29.0.0', ...(devExtra ? { ajv: '^8.0.0' } : {}) },
        },
        'node_modules/express': {
          version: '4.18.2',
          integrity: 'sha512-express',
          dependencies: { 'body-parser': '^1.0.0' },
        },
        'node_modules/body-parser': {
          version: prodTransitiveVersion,
          integrity: `sha512-bp-${prodTransitiveVersion}`,
        },
        'node_modules/jest': { version: '29.7.0', integrity: 'sha512-jest', dev: true },
        ...(devExtra
          ? { 'node_modules/ajv': { version: '8.17.1', integrity: 'sha512-ajv', dev: true } }
          : {}),
      },
    };
  }

  test('dev-only additions and dev-side churn PASS', () => {
    const a = productionReachableGraph(lock());
    const b = productionReachableGraph(lock({ devExtra: true }));
    expect(diffProductionGraphs(a, b)).toEqual([]);
    expect(a.has('node_modules/jest')).toBe(false);
    expect(b.has('node_modules/ajv')).toBe(false);
  });

  test('a production TRANSITIVE version change fails with the direct dependency list unchanged', () => {
    const a = productionReachableGraph(lock());
    const b = productionReachableGraph(lock({ prodTransitiveVersion: '1.2.0' }));
    const diffs = diffProductionGraphs(a, b);
    expect(diffs).toEqual([
      { key: 'node_modules/body-parser', kind: 'version_changed', detail: '1.0.0 → 1.2.0' },
    ]);
  });

  test('nested node resolution over lockfile keys', () => {
    const graph = productionReachableGraph({
      packages: {
        '': { dependencies: { a: '^1' } },
        'node_modules/a': { version: '1.0.0', integrity: 'i-a', dependencies: { b: '^2' } },
        'node_modules/a/node_modules/b': { version: '2.0.0', integrity: 'i-b-nested' },
        'node_modules/b': { version: '1.0.0', integrity: 'i-b-top', dev: true },
      },
    });
    expect(graph.get('node_modules/a/node_modules/b')).toEqual({ version: '2.0.0', integrity: 'i-b-nested' });
    expect(graph.has('node_modules/b')).toBe(false);
  });
});

describe('the REAL worktree against a pinned subject', () => {
  // NOT a permanent unconditional assertion: once the ①–⑤ fix wave (or any
  // legitimate backend change) lands, production != 8fb95b7b by design. The
  // evidence workflow sets FIELD_REPLAY_ASSERT_SUBJECT_SHA when generating
  // baseline-equivalence evidence; the ordinary suite skips.
  const subject = process.env.FIELD_REPLAY_ASSERT_SUBJECT_SHA;
  const maybe = subject ? test : test.skip;
  maybe(`the production tree equals subject ${subject ?? '<unset>'} (baseline-equivalence evidence)`, () => {
    const { ok, pathDiffs, depDiffs } = compareSubjectProjection(subject, 'HEAD');
    expect(pathDiffs).toEqual([]);
    expect(depDiffs).toEqual([]);
    expect(ok).toBe(true);
  });
});
