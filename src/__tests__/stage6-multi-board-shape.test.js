/**
 * Phase 5.1 — `ensureMultiBoardShape` unit tests.
 *
 * Pins the multi-board migration helper used by every snapshot-creating
 * path in the Stage 6 pipeline. The four invariants below must all hold
 * across the strangler migration in slices 5.4 / 5.5 / 5.6 — if any of
 * them regresses, every downstream reader of `snapshot.boards` /
 * `snapshot.currentBoardId` / `snapshot.circuits[0]` is at risk.
 */

import {
  ensureMultiBoardShape,
  buildDefaultMainBoard,
  DEFAULT_MAIN_BOARD_ID,
  DEFAULT_MAIN_BOARD_DESIGNATION,
  DEFAULT_MAIN_BOARD_TYPE,
} from '../extraction/stage6-multi-board-shape.js';

describe('ensureMultiBoardShape — empty snapshot → fully populated default', () => {
  test('synthesises boards array with default main board', () => {
    const snapshot = {
      circuits: {},
      pending_readings: [],
      observations: [],
      validation_alerts: [],
    };
    ensureMultiBoardShape(snapshot);
    expect(snapshot.boards).toEqual([
      {
        id: DEFAULT_MAIN_BOARD_ID,
        designation: DEFAULT_MAIN_BOARD_DESIGNATION,
        board_type: DEFAULT_MAIN_BOARD_TYPE,
      },
    ]);
  });

  test('sets currentBoardId to the synthesised main board id', () => {
    const snapshot = { circuits: {} };
    ensureMultiBoardShape(snapshot);
    expect(snapshot.currentBoardId).toBe(DEFAULT_MAIN_BOARD_ID);
  });

  test('returns the same snapshot reference (chainable)', () => {
    const snapshot = { circuits: {} };
    const returned = ensureMultiBoardShape(snapshot);
    expect(returned).toBe(snapshot);
  });
});

describe('ensureMultiBoardShape — legacy numeric circuit keys preserved', () => {
  test('circuits[0] supply bucket survives untouched', () => {
    // The Phase 5 handoff calls this out as load-bearing: 8+ files
    // read `snapshot.circuits[0]` directly. Slice 5.5 retires it
    // explicitly; slice 5.1 must not pre-empt that.
    const snapshot = {
      circuits: {
        0: { ze: '0.42', pfc: '1.5' },
        1: { circuit_designation: 'Lighting' },
        2: { circuit_designation: 'Sockets' },
      },
    };
    ensureMultiBoardShape(snapshot);
    expect(snapshot.circuits[0]).toEqual({ ze: '0.42', pfc: '1.5' });
    expect(snapshot.circuits[1]).toEqual({ circuit_designation: 'Lighting' });
    expect(snapshot.circuits[2]).toEqual({ circuit_designation: 'Sockets' });
  });

  test('does not introduce composite-key duplicates of legacy buckets', () => {
    const snapshot = { circuits: { 0: { ze: '0.42' }, 1: { foo: 'bar' } } };
    ensureMultiBoardShape(snapshot);
    expect(snapshot.circuits['main::0']).toBeUndefined();
    expect(snapshot.circuits['main::1']).toBeUndefined();
    expect(Object.keys(snapshot.circuits).sort()).toEqual(['0', '1']);
  });
});

describe('ensureMultiBoardShape — already-multi-board snapshot is a no-op', () => {
  test('does not replace existing boards array', () => {
    const existing = [
      { id: 'main', designation: 'DB-1', board_type: 'main' },
      { id: 'sub-1', designation: 'DB-2', board_type: 'sub-distribution', parent_board_id: 'main' },
    ];
    const snapshot = { circuits: {}, boards: existing, currentBoardId: 'sub-1' };
    ensureMultiBoardShape(snapshot);
    expect(snapshot.boards).toBe(existing);
    expect(snapshot.boards).toHaveLength(2);
  });

  test('does not overwrite an explicit currentBoardId', () => {
    const snapshot = {
      circuits: {},
      boards: [
        { id: 'main', designation: 'DB-1', board_type: 'main' },
        { id: 'sub-1', designation: 'DB-2', board_type: 'sub-distribution' },
      ],
      currentBoardId: 'sub-1',
    };
    ensureMultiBoardShape(snapshot);
    expect(snapshot.currentBoardId).toBe('sub-1');
  });

  test('idempotent — running twice yields identical state', () => {
    const snapshot = { circuits: { 0: { ze: '0.5' } } };
    ensureMultiBoardShape(snapshot);
    const firstBoards = snapshot.boards;
    const firstCurrent = snapshot.currentBoardId;
    ensureMultiBoardShape(snapshot);
    expect(snapshot.boards).toBe(firstBoards); // same reference, no rebuild
    expect(snapshot.boards).toHaveLength(1);
    expect(snapshot.currentBoardId).toBe(firstCurrent);
  });
});

describe('ensureMultiBoardShape — partial state recovery', () => {
  test('boards present but empty → main is synthesised', () => {
    const snapshot = { circuits: {}, boards: [] };
    ensureMultiBoardShape(snapshot);
    expect(snapshot.boards).toHaveLength(1);
    expect(snapshot.boards[0].id).toBe(DEFAULT_MAIN_BOARD_ID);
    expect(snapshot.currentBoardId).toBe(DEFAULT_MAIN_BOARD_ID);
  });

  test('boards populated but currentBoardId missing → default to first board', () => {
    const snapshot = {
      circuits: {},
      boards: [{ id: 'custom-id', designation: 'Custom', board_type: 'main' }],
    };
    ensureMultiBoardShape(snapshot);
    expect(snapshot.currentBoardId).toBe('custom-id');
  });

  test('boards is non-array (corrupt input) → replaced with synthesised array', () => {
    // Defensive: if a future hydration path restores corrupt state,
    // we replace rather than crash. The explicit type check is what
    // guards every downstream reader from `boards.find(...)` blowing
    // up on an object.
    const snapshot = { circuits: {}, boards: { not: 'an array' } };
    ensureMultiBoardShape(snapshot);
    expect(Array.isArray(snapshot.boards)).toBe(true);
    expect(snapshot.boards).toHaveLength(1);
  });
});

describe('ensureMultiBoardShape — defensive on bad input', () => {
  test.each([null, undefined, 'string', 42])('returns %p unchanged', (input) => {
    expect(ensureMultiBoardShape(input)).toBe(input);
  });

  test('snapshot without circuits property still gets boards', () => {
    // Constructor-time call: stateSnapshot always has `circuits: {}`,
    // but a future caller might pass a partial shape.
    const snapshot = {};
    ensureMultiBoardShape(snapshot);
    expect(snapshot.boards).toHaveLength(1);
    expect(snapshot.currentBoardId).toBe(DEFAULT_MAIN_BOARD_ID);
  });
});

describe('buildDefaultMainBoard', () => {
  test('returns a fresh object every call', () => {
    const a = buildDefaultMainBoard();
    const b = buildDefaultMainBoard();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  test('matches the locked Phase 0.3 default shape', () => {
    expect(buildDefaultMainBoard()).toEqual({
      id: 'main',
      designation: 'DB-1',
      board_type: 'main',
    });
  });
});
