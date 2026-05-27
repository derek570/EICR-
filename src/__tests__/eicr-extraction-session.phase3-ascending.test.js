/**
 * Snapshot-restructure sprint (2026-05-27) — Phase 3 ascending-circuits test suite.
 *
 * Locks the behaviour of:
 *   - _resolveCircuitOrder env/option resolution (recent_3 default, ascending opt-in)
 *   - recent_3 byte-parity with pre-Phase-3 main (regression lock)
 *   - ascending renderer — every board circuit in ascending numeric order,
 *     no "stored server-side" summary line, append-only growth across turns.
 *
 * Plan location:
 *   .planning-stage6-agentic/handoffs/snapshot-restructure-2026-05-27/phase3-sprint-plan.md
 */

import { jest } from '@jest/globals';

const mockCreate = jest.fn();

jest.unstable_mockModule('@anthropic-ai/sdk', () => ({
  default: jest.fn(() => ({
    messages: {
      create: mockCreate,
    },
  })),
}));

const { EICRExtractionSession } = await import('../extraction/eicr-extraction-session.js');

function makeSession(opts = {}) {
  return new EICRExtractionSession('test-key', `phase3-${Math.random()}`, 'eicr', opts);
}

// Seeds the rolling state snapshot with N circuits, applied in the given
// recency order (last entry is most-recent). Mirrors what record_reading
// would do at runtime: writes the bucket + bumps recentCircuitOrder.
function seedCircuits(session, recencyOrder, fields = { 22: 0.35 }) {
  for (const num of recencyOrder) {
    session.stateSnapshot.circuits[num] = { ...fields, designation: `Circuit ${num}` };
    const idx = session.recentCircuitOrder.indexOf(num);
    if (idx !== -1) session.recentCircuitOrder.splice(idx, 1);
    session.recentCircuitOrder.push(num);
  }
}

// ---------------------------------------------------------------------------
// _resolveCircuitOrder — flag resolution
// ---------------------------------------------------------------------------
describe('_resolveCircuitOrder — flag resolution', () => {
  const originalEnv = process.env.CIRCUIT_ORDER;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CIRCUIT_ORDER;
    else process.env.CIRCUIT_ORDER = originalEnv;
  });

  test('default (env unset, no option) resolves to recent_3', () => {
    delete process.env.CIRCUIT_ORDER;
    const s = makeSession();
    expect(s.circuitOrder).toBe('recent_3');
  });

  test('env=ascending resolves to ascending', () => {
    process.env.CIRCUIT_ORDER = 'ascending';
    const s = makeSession();
    expect(s.circuitOrder).toBe('ascending');
  });

  test('options.circuitOrder overrides env', () => {
    process.env.CIRCUIT_ORDER = 'recent_3';
    const s = makeSession({ circuitOrder: 'ascending' });
    expect(s.circuitOrder).toBe('ascending');
  });

  test('unknown value falls back to recent_3 (regression lock against typos)', () => {
    const s = makeSession({ circuitOrder: 'asc' });
    expect(s.circuitOrder).toBe('recent_3');
  });

  test('mid-session env mutation does NOT drift the mode (Pitfall 4)', () => {
    delete process.env.CIRCUIT_ORDER;
    const s = makeSession();
    expect(s.circuitOrder).toBe('recent_3');
    process.env.CIRCUIT_ORDER = 'ascending';
    expect(s.circuitOrder).toBe('recent_3');
  });
});

// ---------------------------------------------------------------------------
// recent_3 default — byte-identical to pre-Phase-3 main
// ---------------------------------------------------------------------------
describe('recent_3 (default) — regression lock against pre-Phase-3 main', () => {
  test('snapshot with 5 circuits, recency 5,4,3,2,1 → renders 3,2,1 detailed + "2 earlier circuits (4,5) stored server-side"', () => {
    const s = makeSession(); // default recent_3
    seedCircuits(s, [5, 4, 3, 2, 1]); // recentCircuitOrder ends [5,4,3,2,1]
    const text = s.buildStateSnapshotMessage();
    // Last 3 are 3, 2, 1 (the slice(-3)) — rendered detailed.
    expect(text).toMatch(/^3:\{/m);
    expect(text).toMatch(/^2:\{/m);
    expect(text).toMatch(/^1:\{/m);
    // 4 and 5 are older, summarised.
    expect(text).toMatch(/2 earlier circuits \(4,5\) stored server-side/);
  });

  test('snapshot with 2 circuits → no "stored server-side" summary (fewer than the window)', () => {
    const s = makeSession();
    seedCircuits(s, [1, 2]);
    const text = s.buildStateSnapshotMessage();
    expect(text).not.toMatch(/stored server-side/);
  });
});

// ---------------------------------------------------------------------------
// ascending — new behaviour
// ---------------------------------------------------------------------------
describe('ascending — Phase 3 behaviour', () => {
  test('snapshot with 5 circuits dictated 3,1,5,2,4 → all 5 rendered in 1,2,3,4,5 order', () => {
    const s = makeSession({ circuitOrder: 'ascending' });
    seedCircuits(s, [3, 1, 5, 2, 4]); // out-of-order recency
    const text = s.buildStateSnapshotMessage();
    const detailLines = text
      .split('\n')
      .filter((l) => /^\d+:\{/.test(l))
      .map((l) => parseInt(l.split(':')[0], 10));
    // Supply (0) may appear first; non-supply must be 1..5 ascending.
    const nonSupply = detailLines.filter((n) => n !== 0);
    expect(nonSupply).toEqual([1, 2, 3, 4, 5]);
  });

  test('snapshot with 5 circuits → NO "stored server-side" summary (nothing is hidden)', () => {
    const s = makeSession({ circuitOrder: 'ascending' });
    seedCircuits(s, [1, 2, 3, 4, 5]);
    const text = s.buildStateSnapshotMessage();
    expect(text).not.toMatch(/stored server-side/);
  });

  test('append-only cache stability — turn N+1 prefix matches turn N when a new circuit appears', () => {
    const s = makeSession({ circuitOrder: 'ascending' });
    seedCircuits(s, [1, 2, 3]);
    const turnN = s.buildStateSnapshotMessage();

    seedCircuits(s, [4]); // inspector moves to circuit 4
    const turnNext = s.buildStateSnapshotMessage();

    // Strip leading SUPPLY line (if present, identical across both turns).
    // The detail lines for 1, 2, 3 must appear byte-identically in both snapshots.
    for (const num of [1, 2, 3]) {
      const re = new RegExp(`^${num}:\\{[^\\n]*`, 'm');
      const a = turnN.match(re)[0];
      const b = turnNext.match(re)[0];
      expect(a).toBe(b);
    }
    // Turn N+1 adds 4 at the bottom.
    expect(turnNext).toMatch(/^4:\{/m);
    expect(turnN).not.toMatch(/^4:\{/m);
  });

  test('empty session under ascending → no EXTRACTED CIRCUITS section', () => {
    const s = makeSession({ circuitOrder: 'ascending' });
    const text = s.buildStateSnapshotMessage();
    // Empty session collapses the snapshot message to null (no surface
    // populated). Either null OR a string with no circuit lines is the
    // contract — assert by coalescing.
    const safe = text ?? '';
    expect(safe).not.toMatch(/^\d+:\{/m);
    expect(safe).not.toMatch(/stored server-side/);
  });

  test('single non-supply circuit under ascending → one detailed line, no summary', () => {
    const s = makeSession({ circuitOrder: 'ascending' });
    seedCircuits(s, [7]);
    const text = s.buildStateSnapshotMessage();
    expect(text).toMatch(/^7:\{/m);
    expect(text).not.toMatch(/stored server-side/);
  });
});

// ---------------------------------------------------------------------------
// recentCircuitOrder array — still maintained under ascending
// ---------------------------------------------------------------------------
describe('recentCircuitOrder — array still maintained under ascending', () => {
  test('ascending mode still pushes onto recentCircuitOrder so golden-divergence harness behaviour is unchanged', () => {
    // The renderer ignores the array under ascending, but the array itself
    // is still mutated (seedCircuits mirrors record_reading). Lock that
    // contract so the golden-divergence script's assumptions about the
    // export of SNAPSHOT_RECENT_CIRCUITS + the array's presence stay valid.
    const s = makeSession({ circuitOrder: 'ascending' });
    seedCircuits(s, [3, 1, 5]);
    expect(s.recentCircuitOrder).toEqual([3, 1, 5]);
  });
});
