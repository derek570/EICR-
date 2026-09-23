/**
 * Stage 6 Phase 8 — Plan 08-01 SC #5 — STT-11 fixture-pool CI regression-lock.
 *
 * WHAT: Locks the 12-fixture STT-11 golden-session pool as a structural CI
 * guard so a future commit that deletes (or silently renames) a fixture
 * fails CI loudly. Asserts:
 *   1. Fixture pool size: 5 in stage6-golden-sessions/ + 7 in
 *      stage6-phase5-golden-sessions/ = 12 total.
 *   2. Phase 5 fixtures all carry the `_fixture_shape: "phase5-over-ask"`
 *      marker and a non-empty session.jobId + transcript_summary.
 *   3. Phase 4 fixtures carry the dual-SSE shape they feed into the
 *      divergence-comparison harness.
 *
 * PLAN-B (feedback-2026-09-17, Decision 3) retired the ask budget and
 * restrained mode, and with them `scripts/stage6-over-ask-exit-gate.js`,
 * which replayed the Phase 5 pool through those gates and asserted a
 * median / p95 / restrained_rate digest. The gate it measured no longer
 * exists, so that digest lock is gone; the Phase 5 fixtures stay as archival
 * evidence of the over-ask behaviour the gates were built against, and this
 * test keeps them from disappearing silently.
 *
 * Phase 8 ROADMAP §SC #5: "STT-11 golden-session fixtures added to the CI
 * suite so divergence regressions fail PRs, not only prod rollouts." The
 * 5+7=12 pool was scope-reduced from the original 20 at Phase 5 close — the
 * test re-derives the pool size from disk so any future change fails the
 * count assertion deliberately.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PHASE4_DIR = path.join(here, 'fixtures', 'stage6-golden-sessions');
const PHASE5_DIR = path.join(here, 'fixtures', 'stage6-phase5-golden-sessions');

function listJsonFixtures(dir) {
  return readdirSync(dir).filter((f) => f.endsWith('.json'));
}

describe('Plan 08-01 SC #5 — STT-11 fixture-pool CI regression-lock', () => {
  describe('fixture pool sizes (Phase 5 scope-reduced 12-fixture variant)', () => {
    test('stage6-golden-sessions/ has exactly 5 Phase 4 fixtures', () => {
      const files = listJsonFixtures(PHASE4_DIR);
      // Plan 05-06 baseline: sample-01 through sample-05.
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
      // The retired exit-gate's TIER 1 strict-gate required this marker on
      // every Phase 5 entry; the shape-schema test
      // (stage6-phase5-fixture-schema.test.js) still keys on it.
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
});
