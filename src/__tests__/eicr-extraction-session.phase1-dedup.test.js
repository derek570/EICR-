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

  test('a circuits-less job never rebuilds (F/U-4 r5 contract); explicit circuits:[] does', () => {
    const s = makeSession();
    // Circuits-less updates (empty {} / supply-only) must never touch the
    // schedule OR the rebuild counters — pre-fix an empty mid-session update
    // CLEARED the schedule.
    s.updateJobState({});
    s.updateJobState({});
    expect(s._scheduleRebuildStats.total).toBe(0);
    // An explicit circuits: [] remains the counted, valid way to clear.
    s.updateJobState({ circuits: [] });
    s.updateJobState({ circuits: [] });
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

  test('case 20 — facts: iOS overwrites existing snapshot designation (canonical key, #3.4.4)', () => {
    const s = makeSession();
    s.stateSnapshot.circuits[3] = { designation: 'X' };
    s.updateJobState({ circuits: [{ ref: 3, designation: 'Y' }] });
    // designation-wire-sync #3.4.4: an incoming CIRCUIT `designation` is now
    // normalised to the canonical `circuit_designation` (and the stale legacy
    // alias is dropped) so it can't be shadowed by `circuit_designation ||
    // designation` in the resolver. Fact-overwrite precedence is unchanged —
    // only the storage key moved to canonical.
    expect(s.stateSnapshot.circuits[3].circuit_designation).toBe('Y');
    expect(s.stateSnapshot.circuits[3].designation).toBeUndefined();
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
describe('Commit 2 — schedule facts-only + buildSystemBlocks split', () => {
  test('schedule strip — facts kept, readings removed', () => {
    const s = makeSession();
    const sched = s.buildCircuitSchedule({
      circuits: [
        {
          ref: 1,
          designation: 'Ring Final',
          ocpd_type: 'B',
          ocpd_rating: 32,
          cable_size: '2.5',
          cable_size_earth: '1.5',
          wiring_type: 'B',
          ref_method: '100',
          zs: '0.35',
          r1_plus_r2: '0.47',
          polarity: 'OK',
          rcd_trip_time: '20',
          rcdRatingA: 30,
        },
      ],
    });
    // Facts retained
    expect(sched).toContain('Ring Final');
    expect(sched).toContain('ocpd=B/32A');
    expect(sched).toContain('cable=2.5/1.5mm');
    expect(sched).toContain('wiring=B');
    expect(sched).toContain('ref=100');
    expect(sched).toContain('rcd=30mA'); // rating is a fact
    // Readings stripped
    expect(sched).not.toContain('zs=');
    expect(sched).not.toContain('r1r2=');
    expect(sched).not.toContain('polarity=');
    expect(sched).not.toContain('20ms'); // RCD trip time was a reading
  });

  test('case 15 — SNAPSHOT_FORMAT unset (single_block default): buildSystemBlocks returns the legacy 2-block layout', () => {
    // Default constructor → snapshotFormat='single_block'.
    const s = makeSession();
    // Populate enough state to ensure a non-null snapshot
    s.updateJobState({
      circuits: [{ ref: 1, designation: 'Lighting', ocpd_type: 'B', ocpd_rating: 6 }],
    });
    s.stateSnapshot.circuits[1] = { ...s.stateSnapshot.circuits[1], measured_zs_ohm: '0.35' };
    s.recentCircuitOrder.push(1);

    const blocks = s.buildSystemBlocks();
    expect(s.snapshotFormat).toBe('single_block');
    expect(blocks).toHaveLength(2);
    // base prompt + single combined snapshot
    expect(blocks[0].text).toBe(s.systemPrompt);
    // The single block's text equals buildStateSnapshotMessage exactly
    // (byte-identical to pre-Phase-1 single-block emission).
    expect(blocks[1].text).toBe(s.buildStateSnapshotMessage());
  });

  test('case 15 corollary — buildStateSnapshotMessage byte-identical to prefix + tail concat', () => {
    const s = makeSession();
    s.updateJobState({
      circuits: [{ ref: 1, designation: 'Lighting', ocpd_type: 'B', ocpd_rating: 6 }],
    });
    s.stateSnapshot.circuits[1] = { ...s.stateSnapshot.circuits[1], measured_zs_ohm: '0.35' };
    s.recentCircuitOrder.push(1);

    const prefix = s.buildStableSnapshotPrefix();
    const tail = s.buildVolatileSnapshotTail();
    const combined = [prefix, tail].filter((x) => x !== '').join('\n\n');
    expect(s.buildStateSnapshotMessage()).toBe(combined);
  });

  test('split_blocks: buildSystemBlocks returns up to 3 blocks; each half has its own cache_control', () => {
    const s = makeSession({ snapshotFormat: 'split_blocks' });
    s.updateJobState({
      circuits: [{ ref: 1, designation: 'Lighting', ocpd_type: 'B', ocpd_rating: 6 }],
    });
    s.stateSnapshot.circuits[1] = { ...s.stateSnapshot.circuits[1], measured_zs_ohm: '0.35' };
    s.recentCircuitOrder.push(1);

    const blocks = s.buildSystemBlocks();
    expect(s.snapshotFormat).toBe('split_blocks');
    expect(blocks).toHaveLength(3);
    expect(blocks[0].text).toBe(s.systemPrompt);
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
    // [1] is the stable prefix; should contain the CIRCUIT SCHEDULE block
    expect(blocks[1].text).toContain('CIRCUIT SCHEDULE');
    expect(blocks[1].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
    // [2] is the volatile tail; should contain the EXTRACTED block
    expect(blocks[2].text).toContain('EXTRACTED');
    expect(blocks[2].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
    // Volatile tail must NOT carry the schedule (cache stability)
    expect(blocks[2].text).not.toContain('CIRCUIT SCHEDULE');
    // Stable prefix must NOT carry the volatile EXTRACTED block
    expect(blocks[1].text).not.toContain('EXTRACTED');
  });

  test('split_blocks: empty session collapses to single base block', () => {
    const s = makeSession({ snapshotFormat: 'split_blocks' });
    const blocks = s.buildSystemBlocks();
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe(s.systemPrompt);
  });

  test('case 21 — circuit E2E EXTRACTED visibility under split_blocks', () => {
    const s = makeSession({ snapshotFormat: 'split_blocks' });
    // iOS pushes a circuit with a Zs reading
    s.updateJobState({
      circuits: [{ ref: 3, designation: 'Sockets', ocpd_type: 'B', ocpd_rating: 32, zs: 0.13 }],
    });
    // The merge step stores zs under the canonical reading-name `zs`
    // (not canonicalised to measured_zs_ohm by the merge — the merge
    // writes the field name verbatim). Either way the EXTRACTED block
    // must surface the value.
    s.recentCircuitOrder.push(3);
    const tail = s.buildVolatileSnapshotTail();
    expect(tail).toContain('EXTRACTED');
    expect(tail).toContain('0.13');
  });

  test('case 22 — supply E2E EXTRACTED visibility under split_blocks', () => {
    const s = makeSession({ snapshotFormat: 'split_blocks' });
    s.updateJobState({ supply: { ze: 0.4 } });
    // F/U-4 (2026-07-18): the supply merge canonicalises the short `ze`
    // alias to earth_loop_impedance_ze (the key the calculators read).
    expect(s.stateSnapshot.circuits[0].earth_loop_impedance_ze).toBe(0.4);
    const tail = s.buildVolatileSnapshotTail();
    // Supply lives on the line prefixed `0:` in the EXTRACTED block
    expect(tail).toContain('EXTRACTED');
    expect(tail).toContain('0:');
    expect(tail).toContain('0.4');
  });

  test('case 23 — board E2E EXTRACTED visibility on a sub-board', () => {
    const s = makeSession({ snapshotFormat: 'split_blocks' });
    // Seed a sub-board and switch the current pointer.
    s.updateJobState({
      boards: [
        { id: 'main', designation: 'DB-1', board_type: 'main' },
        { id: 'sub-1', designation: 'Garage', board_type: 'sub_main', ze_at_db: 0.55 },
      ],
    });
    s.stateSnapshot.currentBoardId = 'sub-1';
    const tail = s.buildVolatileSnapshotTail();
    // The sub-board's BoardInfo is projected as the supply-shaped
    // `0:{ze_at_db:...}` entry when the active board is non-main.
    expect(tail).toContain('EXTRACTED');
    expect(tail).toContain('0.55');
  });
});

// ---------------------------------------------------------------------------
// addMidConversationBreakpoints — cap at 1 under split_blocks
// ---------------------------------------------------------------------------
describe('split_blocks cap: addMidConversationBreakpoints honours snapshotFormat', () => {
  function makeManyMessages(n) {
    // Each user message gets a content array so the eligibility test
    // (`msg.role === 'user' && Array.isArray(msg.content)`) passes.
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: [{ type: 'text', text: `m-${i}` }],
      });
    }
    return out;
  }

  test('single_block default: up to 2 mid-conv breakpoints', () => {
    const s = makeSession(); // default single_block
    const msgs = makeManyMessages(50);
    s.addMidConversationBreakpoints(msgs);
    const cacheBreakpoints = msgs.filter(
      (m) =>
        m.role === 'user' && m.content.some((b) => b.cache_control && b.cache_control.ttl === '1h')
    );
    expect(cacheBreakpoints.length).toBeLessThanOrEqual(2);
    expect(cacheBreakpoints.length).toBeGreaterThan(0);
  });

  test('split_blocks: capped at 1 mid-conv breakpoint', () => {
    const s = makeSession({ snapshotFormat: 'split_blocks' });
    const msgs = makeManyMessages(50);
    s.addMidConversationBreakpoints(msgs);
    const cacheBreakpoints = msgs.filter(
      (m) =>
        m.role === 'user' && m.content.some((b) => b.cache_control && b.cache_control.ttl === '1h')
    );
    expect(cacheBreakpoints.length).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// _resolveSnapshotFormat — env-var validation + locking
// ---------------------------------------------------------------------------
describe('_resolveSnapshotFormat', () => {
  let originalEnv;
  beforeEach(() => {
    originalEnv = process.env.SNAPSHOT_FORMAT;
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.SNAPSHOT_FORMAT;
    else process.env.SNAPSHOT_FORMAT = originalEnv;
  });

  test('default (env unset) → single_block', () => {
    delete process.env.SNAPSHOT_FORMAT;
    expect(makeSession().snapshotFormat).toBe('single_block');
  });

  test("env='split_blocks' → split_blocks", () => {
    process.env.SNAPSHOT_FORMAT = 'split_blocks';
    expect(makeSession().snapshotFormat).toBe('split_blocks');
  });

  test('constructor override beats env', () => {
    process.env.SNAPSHOT_FORMAT = 'single_block';
    expect(makeSession({ snapshotFormat: 'split_blocks' }).snapshotFormat).toBe('split_blocks');
  });

  test('invalid value falls back to single_block', () => {
    process.env.SNAPSHOT_FORMAT = 'banana';
    expect(makeSession().snapshotFormat).toBe('single_block');
  });

  test('format is constructor-locked — mid-session env mutation does NOT drift', () => {
    const s = makeSession({ snapshotFormat: 'single_block' });
    process.env.SNAPSHOT_FORMAT = 'split_blocks';
    expect(s.snapshotFormat).toBe('single_block'); // locked at construction
  });
});
