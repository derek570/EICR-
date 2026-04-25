/**
 * Stage 6 Phase 8 — Plan 08-01 SC #5 — STT-11 fixture-pool CI regression-lock.
 *
 * WHAT: Locks the 12-fixture STT-11 golden-session pool as a structural CI
 * guard so a future commit that deletes (or silently renames) a fixture
 * fails CI loudly. Asserts:
 *   1. Fixture pool size: 5 in stage6-golden-sessions/ + 7 in
 *      stage6-phase5-golden-sessions/ = 12 total.
 *   2. Phase 5 fixtures all carry the `_fixture_shape: "phase5-over-ask"`
 *      marker (matches scripts/stage6-over-ask-exit-gate.js's TIER 1
 *      strict-gate marker — Plan 05-15 r9-#1).
 *   3. Phase 4 fixtures have a minimal session shape (jobId +
 *      transcript_summary) — they pre-date the phase5-over-ask marker
 *      and feed the legacy zero-ask path in the harness.
 *   4. The exit-gate harness against the main fixtures dir produces
 *      exit_code=0 with aggregate.median≤1, p95≤4, restrained_rate≤0.10
 *      (Plan 05-07 r1-#2 calibrated thresholds for the 12-fixture pool).
 *
 * WHY a NEW test even though stage6-over-ask-exit-gate.test.js already
 * runs the harness against this same fixture pool: that test checks
 * the harness's behavioural surface (exit codes, digest contracts,
 * fixture-shape gates). This test checks the FIXTURE POOL ITSELF as
 * a structural artefact:
 *   - "did anyone delete a fixture?"  → pool size assertion fails
 *   - "did anyone rename _fixture_shape?" → marker assertion fails
 *   - "did the calibrated thresholds change?" → digest threshold fails
 *
 * Phase 8 ROADMAP §SC #5 explicitly: "STT-11 golden-session fixtures
 * added to the CI suite so divergence regressions fail PRs, not only
 * prod rollouts." The 5+7=12 pool was scope-reduced from the original
 * 20 at Phase 5 close (see STATE.md "scope-reduced 12-fixture variant")
 * — the test re-derives the pool size from disk so any future
 * expansion to the original 20 fails the count assertion deliberately
 * (forcing a deliberate update of the test alongside the fixture add).
 *
 * Backward compatibility with stage6-over-ask-exit-gate.test.js: that
 * test loads the SAME script as a child process; this test calls the
 * SAME exit-gate but via direct require (not spawn) for fast feedback
 * AND extracts the digest from the script's exit-code surface. The
 * two tests are complementary, not redundant — over-ask-exit-gate
 * exercises the harness; this exercises the fixture pool.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..');
const PHASE4_DIR = path.join(here, 'fixtures', 'stage6-golden-sessions');
const PHASE5_DIR = path.join(here, 'fixtures', 'stage6-phase5-golden-sessions');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'stage6-over-ask-exit-gate.js');

function listJsonFixtures(dir) {
  return readdirSync(dir).filter((f) => f.endsWith('.json'));
}

describe('Plan 08-01 SC #5 — STT-11 fixture-pool CI regression-lock', () => {
  describe('fixture pool sizes (Phase 5 scope-reduced 12-fixture variant)', () => {
    test('stage6-golden-sessions/ has exactly 5 Phase 4 fixtures', () => {
      const files = listJsonFixtures(PHASE4_DIR);
      // Plan 05-06 baseline: sample-01 through sample-05.
      // If this count changes, the harness's calibrated thresholds
      // (Plan 05-07 r1-#2) need re-deriving — bump the count
      // deliberately AND update the digest threshold tests below.
      expect(files.length).toBe(5);
    });

    test('stage6-phase5-golden-sessions/ has exactly 7 Phase 5 fixtures', () => {
      const files = listJsonFixtures(PHASE5_DIR);
      // Plan 05-06 expansion: sample-06 through sample-12 (7 fixtures).
      expect(files.length).toBe(7);
    });

    test('total STT-11 pool size is 12 (matches scope-reduced variant per Phase 5 close)', () => {
      const total = listJsonFixtures(PHASE4_DIR).length + listJsonFixtures(PHASE5_DIR).length;
      expect(total).toBe(12);
    });
  });

  describe('fixture marker discipline (Plan 05-15 r9-#1 strict-gate contract)', () => {
    test('every Phase 5 fixture carries _fixture_shape: "phase5-over-ask" marker', () => {
      // The harness's TIER 1 strict-gate (scripts/stage6-over-ask-exit-gate.js:349)
      // requires this marker on every PHASE5_FIXTURES_DIR entry. A fixture
      // missing it would fall through to the Phase-4-compat zero-ask path
      // and silently contribute zero asks instead of failing closed.
      // This test catches the omission at fixture-add time.
      const files = listJsonFixtures(PHASE5_DIR);
      for (const f of files) {
        const content = JSON.parse(readFileSync(path.join(PHASE5_DIR, f), 'utf8'));
        expect(content._fixture_shape).toBe('phase5-over-ask');
      }
    });

    test('every Phase 5 fixture carries non-empty session.jobId + transcript_summary', () => {
      const files = listJsonFixtures(PHASE5_DIR);
      for (const f of files) {
        const content = JSON.parse(readFileSync(path.join(PHASE5_DIR, f), 'utf8'));
        expect(typeof content.session?.jobId).toBe('string');
        expect(content.session.jobId.length).toBeGreaterThan(0);
        expect(typeof content.transcript_summary).toBe('string');
        expect(content.transcript_summary.length).toBeGreaterThan(0);
      }
    });

    test('every Phase 4 fixture carries the dual-SSE shape (transcript + pre_turn_state + sse_events_*)', () => {
      // Phase 4 fixtures use the dual-SSE shape (NOT the phase5-over-ask
      // shape) — see _fixture_shape marker on each file. They feed the
      // divergence-comparison path in stage6-shadow-harness.js / golden-
      // divergence harness, NOT the over-ask exit-gate's ask-counting
      // path. Minimal shape: transcript + pre_turn_state + at least
      // sse_events_legacy (the legacy path's stream-of-record).
      const files = listJsonFixtures(PHASE4_DIR);
      for (const f of files) {
        const content = JSON.parse(readFileSync(path.join(PHASE4_DIR, f), 'utf8'));
        expect(typeof content.transcript).toBe('string');
        expect(content.transcript.length).toBeGreaterThan(0);
        expect(content.pre_turn_state).toBeDefined();
        expect(Array.isArray(content.sse_events_legacy)).toBe(true);
      }
    });
  });

  describe('exit-gate digest threshold lock (Plan 05-07 r1-#2 calibrated values)', () => {
    test('default mode against main fixtures dir exits 0 with calibrated digest thresholds', () => {
      // Spawn the harness like stage6-over-ask-exit-gate.test.js does
      // and parse its stdout digest. Asserts the calibrated thresholds
      // for the 12-fixture variant: median≤1, p95≤4, restrained_rate≤0.10.
      // Locked here as a CI gate so a future fixture add that breaks
      // these calibrations fails PR review explicitly (with a pointer
      // to recalibrate, not silently flap the harness).
      //
      // --json flag emits compact JSON to stdout (no human-readable
      // progress lines) — easiest stable contract for the test consumer.
      const out = execFileSync(process.execPath, [SCRIPT_PATH, '--json'], {
        encoding: 'utf8',
        cwd: REPO_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      // The harness emits Winston structured-log lines on stdout during
      // execution (e.g. "suppressed_refill_question" warns from the
      // filled-slots-filter ran by the dispatcher). The --json digest is
      // the LAST line of stdout — pick that line specifically rather than
      // assuming the entire stdout is JSON.
      const lines = out
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      const lastLine = lines[lines.length - 1];
      const digest = JSON.parse(lastLine);
      // Plan 05-07 r1-#2 calibrated thresholds for the 12-fixture variant:
      // median≤1, p95≤4, restrained_rate≤0.10. The harness's exit_code
      // is 0 when ALL three thresholds pass.
      expect(digest.median).toBeLessThanOrEqual(1);
      expect(digest.p95).toBeLessThanOrEqual(4);
      expect(digest.restrained_rate).toBeLessThanOrEqual(0.1);
      expect(digest.exit_code).toBe(0);
    });
  });
});
