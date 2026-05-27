/**
 * Snapshot-restructure sprint (2026-05-27) — Phase 1 dedup test suite.
 *
 * Locks the behaviour of:
 *   - Phase 0 schedule_block_rebuild identity counter (this commit).
 *   - §2.2A updateJobState merge precondition (Commit 1).
 *   - §2.5 schedule strip + block split + prompt note (Commit 2).
 *
 * Test numbering follows the plan's §2.6 catalogue. Cases that depend on
 * a not-yet-landed commit are marked `test.skip` and labelled with the
 * commit they unblock — they go live the moment that commit lands.
 *
 * Plan location:
 *   .planning-stage6-agentic/handoffs/snapshot-restructure-2026-05-27/
 */

import { jest } from '@jest/globals';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mockCreate = jest.fn();

jest.unstable_mockModule('@anthropic-ai/sdk', () => ({
  default: jest.fn(() => ({
    messages: {
      create: mockCreate,
    },
  })),
}));

const { EICRExtractionSession } = await import('../extraction/eicr-extraction-session.js');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Helper — newly-constructed session in non-off mode so split_blocks tests
// can flip the flag without the off-mode legacy code path getting in the
// way. Off-mode parity is asserted explicitly in its own test (case 15).
function makeSession(opts = {}) {
  return new EICRExtractionSession('test-key', `phase1-${Math.random()}`, 'eicr', opts);
}

// ---------------------------------------------------------------------------
// Phase 0 — schedule_block_rebuild identity counter
// ---------------------------------------------------------------------------
describe('Phase 0 — schedule_block_rebuild identity counter', () => {
  test('first updateJobState counts as a CHANGE, not identical', () => {
    const s = makeSession();
    s.updateJobState({ circuits: [{ ref: 1, designation: 'Lighting' }] });
    expect(s._scheduleRebuildStats.total).toBe(1);
    expect(s._scheduleRebuildStats.identical).toBe(0);
  });

  test('two identical jobStates → second call counts as identical', () => {
    const s = makeSession();
    const jobState = { circuits: [{ ref: 1, designation: 'Lighting' }] };
    s.updateJobState(jobState);
    s.updateJobState(jobState);
    expect(s._scheduleRebuildStats.total).toBe(2);
    expect(s._scheduleRebuildStats.identical).toBe(1);
  });

  test('changing designation → second call is NOT identical', () => {
    const s = makeSession();
    s.updateJobState({ circuits: [{ ref: 1, designation: 'Lighting' }] });
    s.updateJobState({ circuits: [{ ref: 1, designation: 'Sockets' }] });
    expect(s._scheduleRebuildStats.total).toBe(2);
    expect(s._scheduleRebuildStats.identical).toBe(0);
  });

  test('empty job → empty job still counts as identical after the first', () => {
    const s = makeSession();
    s.updateJobState({});
    s.updateJobState({});
    expect(s._scheduleRebuildStats.total).toBe(2);
    expect(s._scheduleRebuildStats.identical).toBe(1);
  });

  test('stop() emits identityRate based on per-session counts', () => {
    const s = makeSession();
    s.start();
    s.updateJobState({ circuits: [{ ref: 1, designation: 'A' }] }); // change
    s.updateJobState({ circuits: [{ ref: 1, designation: 'A' }] }); // identical
    s.updateJobState({ circuits: [{ ref: 1, designation: 'A' }] }); // identical
    const summary = s.stop();
    // Counter is internal state, not on summary — assert via the
    // internal fields so the gate logic stays test-visible.
    expect(s._scheduleRebuildStats.total).toBe(3);
    expect(s._scheduleRebuildStats.identical).toBe(2);
    // identity_rate = 2/3 ≈ 0.667 — below the >0.7 Day-3 gate, which
    // is what we want here because this synthetic three-tick session
    // does not match the real-world steady-state pattern (1 change at
    // job-load + many idempotent re-pushes).
    const rate = s._scheduleRebuildStats.identical / s._scheduleRebuildStats.total;
    expect(rate).toBeCloseTo(2 / 3, 3);
    expect(summary).toBeDefined(); // sanity — stop returns the cost summary
  });
});

// ---------------------------------------------------------------------------
// Test 25 — audit-env-var-source.sh regression
// ---------------------------------------------------------------------------
describe('Phase 0 — audit-env-var-source.sh', () => {
  test('exits 0 on the current src/ tree (every env var is either in task-def or on the allowlist)', () => {
    // execSync throws if the script exits non-zero. The success line is
    // emitted to stdout; capture it so a failing assert produces a
    // readable error rather than a raw spawn-failure.
    const out = execSync('./scripts/audit-env-var-source.sh', {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(out).toContain('every process.env.X reference');
  });
});

// ---------------------------------------------------------------------------
// Commit 1 — §2.2A updateJobState merge precondition
//   Tests 18, 19, 20, 24 from §2.6.
// ---------------------------------------------------------------------------
describe('Commit 1 — updateJobState merges iOS state into stateSnapshot', () => {
  test('case 18 — merge empty cell: iOS-supplied reading lands in stateSnapshot', () => {
    const s = makeSession();
    expect(s.stateSnapshot.circuits[3]).toBeUndefined();
    s.updateJobState({ circuits: [{ ref: 3, zs: 0.13 }] });
    expect(s.stateSnapshot.circuits[3].zs).toBe(0.13);
  });

  test('case 19 — Sonnet-canonical wins: existing snapshot reading is NOT overwritten by iOS', () => {
    const s = makeSession();
    s.stateSnapshot.circuits[3] = { zs: 0.18 };
    s.updateJobState({ circuits: [{ ref: 3, zs: 0.13 }] });
    expect(s.stateSnapshot.circuits[3].zs).toBe(0.18);
  });

  test('case 20 — facts: iOS overwrites existing snapshot designation', () => {
    const s = makeSession();
    s.stateSnapshot.circuits[3] = { designation: 'X' };
    s.updateJobState({ circuits: [{ ref: 3, designation: 'Y' }] });
    expect(s.stateSnapshot.circuits[3].designation).toBe('Y');
  });

  test('case 24 — board merge matches by id, not index', () => {
    const s = makeSession();
    s.stateSnapshot.boards = [{ id: 'main', designation: 'A' }];
    s.updateJobState({
      boards: [
        { id: 'main', designation: 'B' },
        { id: 'sub-1', designation: 'C' },
      ],
    });
    const main = s.stateSnapshot.boards.find((b) => b.id === 'main');
    const sub = s.stateSnapshot.boards.find((b) => b.id === 'sub-1');
    expect(main.designation).toBe('B');
    expect(sub.designation).toBe('C');
  });
});

// ---------------------------------------------------------------------------
// Commit 2 — §2.5 schedule strip + block split + prompt note
//   Tests 15, 21, 22, 23 from §2.6.
// ---------------------------------------------------------------------------
describe.skip('Commit 2 — schedule facts-only + buildSystemBlocks split', () => {
  test('case 15 — SNAPSHOT_FORMAT unset: buildSystemBlocks output byte-identical to single_block', () => {
    // pending Commit 2
  });

  test('case 21 — circuit E2E EXTRACTED visibility under split_blocks', () => {
    // pending Commit 2
  });

  test('case 22 — supply E2E EXTRACTED visibility under split_blocks', () => {
    // pending Commit 2
  });

  test('case 23 — board E2E EXTRACTED visibility on sub-board', () => {
    // pending Commit 2
  });
});
