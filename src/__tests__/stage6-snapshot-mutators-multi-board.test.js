/**
 * Phase 5.2 — composite-key multi-board mutator unit tests.
 *
 * Pins the multi-board variants added alongside the legacy flat-key
 * mutators in `stage6-snapshot-mutators.js`. The legacy variants stay
 * tested via `eicr-extraction-session.snapshot-refactor.test.js` and
 * the dispatcher tests; this file covers the multi-board surface
 * exclusively.
 *
 * The most important invariant — and the one that lets slice 5.3 wire
 * the flag-on path alongside the flag-off path safely — is that
 * legacy keys (`'1'`, `'2'`) and composite keys (`'main::1'`,
 * `'sub-1::1'`) share the same `snapshot.circuits` map without
 * collision. The "coexistence" suite below pins this.
 */

import {
  findCircuitBucket,
  applyReadingMultiBoard,
  clearReadingMultiBoard,
  upsertCircuitMetaMultiBoard,
  renameCircuitMultiBoard,
  deleteCircuitMultiBoard,
  applyBoardReadingMultiBoard,
} from '../extraction/stage6-snapshot-mutators.js';

function makeSnapshot(overrides = {}) {
  return {
    circuits: {},
    pending_readings: [],
    observations: [],
    validation_alerts: [],
    boards: [{ id: 'main', designation: 'DB-1', board_type: 'main' }],
    currentBoardId: 'main',
    ...overrides,
  };
}

describe('findCircuitBucket — composite key resolution', () => {
  test('resolves explicit boardId argument', () => {
    const snapshot = makeSnapshot({
      circuits: { 'sub-1::3': { circuit: 3, board_id: 'sub-1', ze: '0.42' } },
    });
    const r = findCircuitBucket(snapshot, 3, 'sub-1');
    expect(r.key).toBe('sub-1::3');
    expect(r.bucket).toEqual({ circuit: 3, board_id: 'sub-1', ze: '0.42' });
  });

  test('falls back to snapshot.currentBoardId when boardId omitted', () => {
    const snapshot = makeSnapshot({
      currentBoardId: 'sub-1',
      circuits: { 'sub-1::3': { circuit: 3, board_id: 'sub-1' } },
    });
    const r = findCircuitBucket(snapshot, 3);
    expect(r.key).toBe('sub-1::3');
    expect(r.bucket).toBeDefined();
  });

  test("falls back to 'main' when both boardId and currentBoardId absent", () => {
    const snapshot = { circuits: { 'main::5': { circuit: 5, board_id: 'main' } } };
    const r = findCircuitBucket(snapshot, 5);
    expect(r.key).toBe('main::5');
    expect(r.bucket).toBeDefined();
  });

  test('returns key + undefined bucket when the key is absent', () => {
    const snapshot = makeSnapshot();
    const r = findCircuitBucket(snapshot, 99);
    expect(r.key).toBe('main::99');
    expect(r.bucket).toBeUndefined();
  });
});

describe('applyReadingMultiBoard — write semantics', () => {
  test('creates a new bucket with the self-describing skeleton', () => {
    const snapshot = makeSnapshot();
    applyReadingMultiBoard(snapshot, { circuit: 3, field: 'ze', value: '0.42' });
    expect(snapshot.circuits['main::3']).toEqual({ circuit: 3, board_id: 'main', ze: '0.42' });
  });

  test('merges into an existing bucket without losing prior fields', () => {
    const snapshot = makeSnapshot({
      circuits: { 'main::3': { circuit: 3, board_id: 'main', ze: '0.42' } },
    });
    applyReadingMultiBoard(snapshot, { circuit: 3, field: 'pfc', value: '1.5' });
    expect(snapshot.circuits['main::3']).toEqual({
      circuit: 3,
      board_id: 'main',
      ze: '0.42',
      pfc: '1.5',
    });
  });

  test('explicit boardId wins over currentBoardId', () => {
    const snapshot = makeSnapshot({ currentBoardId: 'sub-1' });
    applyReadingMultiBoard(snapshot, { circuit: 1, field: 'ze', value: '0.3', boardId: 'main' });
    expect(snapshot.circuits['main::1']).toBeDefined();
    expect(snapshot.circuits['sub-1::1']).toBeUndefined();
  });

  test('uses currentBoardId when boardId is undefined', () => {
    const snapshot = makeSnapshot({ currentBoardId: 'sub-1' });
    applyReadingMultiBoard(snapshot, { circuit: 1, field: 'ze', value: '0.3' });
    expect(snapshot.circuits['sub-1::1']).toEqual({ circuit: 1, board_id: 'sub-1', ze: '0.3' });
  });

  test('overwrites a prior value for the same field (last-write-wins)', () => {
    const snapshot = makeSnapshot();
    applyReadingMultiBoard(snapshot, { circuit: 1, field: 'ze', value: '0.42' });
    applyReadingMultiBoard(snapshot, { circuit: 1, field: 'ze', value: '0.50' });
    expect(snapshot.circuits['main::1'].ze).toBe('0.50');
  });
});

describe('clearReadingMultiBoard', () => {
  test('removes the field and reports cleared:true', () => {
    const snapshot = makeSnapshot({
      circuits: { 'main::3': { circuit: 3, board_id: 'main', ze: '0.42', pfc: '1.5' } },
    });
    const r = clearReadingMultiBoard(snapshot, { circuit: 3, field: 'ze' });
    expect(r).toEqual({ cleared: true });
    expect(snapshot.circuits['main::3']).toEqual({ circuit: 3, board_id: 'main', pfc: '1.5' });
  });

  test('reports cleared:false when the bucket is missing', () => {
    const snapshot = makeSnapshot();
    const r = clearReadingMultiBoard(snapshot, { circuit: 99, field: 'ze' });
    expect(r).toEqual({ cleared: false });
  });

  test('reports cleared:false when the field is absent on the bucket', () => {
    const snapshot = makeSnapshot({
      circuits: { 'main::3': { circuit: 3, board_id: 'main', ze: '0.42' } },
    });
    const r = clearReadingMultiBoard(snapshot, { circuit: 3, field: 'pfc' });
    expect(r).toEqual({ cleared: false });
    expect(snapshot.circuits['main::3'].ze).toBe('0.42');
  });
});

describe('upsertCircuitMetaMultiBoard', () => {
  test('creates new bucket with skeleton + meta on first write', () => {
    const snapshot = makeSnapshot();
    upsertCircuitMetaMultiBoard(snapshot, {
      circuit_ref: 3,
      designation: 'Cooker',
      phase: 'L1',
      rating_amps: 32,
      cable_csa_mm2: 6,
    });
    expect(snapshot.circuits['main::3']).toEqual({
      circuit: 3,
      board_id: 'main',
      designation: 'Cooker',
      phase: 'L1',
      rating_amps: 32,
      cable_csa_mm2: 6,
    });
  });

  test('merges into an existing bucket', () => {
    const snapshot = makeSnapshot({
      circuits: { 'main::3': { circuit: 3, board_id: 'main', ze: '0.42' } },
    });
    upsertCircuitMetaMultiBoard(snapshot, { circuit_ref: 3, designation: 'Cooker' });
    expect(snapshot.circuits['main::3']).toEqual({
      circuit: 3,
      board_id: 'main',
      ze: '0.42',
      designation: 'Cooker',
    });
  });

  test('null meta fields leave existing values untouched', () => {
    const snapshot = makeSnapshot({
      circuits: { 'main::3': { circuit: 3, board_id: 'main', designation: 'Cooker', phase: 'L1' } },
    });
    upsertCircuitMetaMultiBoard(snapshot, {
      circuit_ref: 3,
      designation: null,
      phase: null,
      rating_amps: 32,
    });
    expect(snapshot.circuits['main::3']).toEqual({
      circuit: 3,
      board_id: 'main',
      designation: 'Cooker',
      phase: 'L1',
      rating_amps: 32,
    });
  });
});

describe('renameCircuitMultiBoard', () => {
  test('rekeys bucket and updates self-describing circuit field', () => {
    const snapshot = makeSnapshot({
      circuits: { 'main::3': { circuit: 3, board_id: 'main', ze: '0.42' } },
    });
    const r = renameCircuitMultiBoard(snapshot, { from_ref: 3, circuit_ref: 5 });
    expect(r).toEqual({ ok: true });
    expect(snapshot.circuits['main::3']).toBeUndefined();
    expect(snapshot.circuits['main::5']).toEqual({ circuit: 5, board_id: 'main', ze: '0.42' });
  });

  test('idempotent on identical from_ref and circuit_ref', () => {
    const snapshot = makeSnapshot();
    const r = renameCircuitMultiBoard(snapshot, { from_ref: 3, circuit_ref: 3 });
    expect(r).toEqual({ ok: true });
  });

  test('returns source_not_found when the from-key is empty', () => {
    const snapshot = makeSnapshot();
    const r = renameCircuitMultiBoard(snapshot, { from_ref: 3, circuit_ref: 5 });
    expect(r).toEqual({ ok: false, error: { code: 'source_not_found' } });
  });

  test('returns target_exists without destructive merge', () => {
    const snapshot = makeSnapshot({
      circuits: {
        'main::3': { circuit: 3, board_id: 'main', ze: '0.42' },
        'main::5': { circuit: 5, board_id: 'main', pfc: '1.5' },
      },
    });
    const r = renameCircuitMultiBoard(snapshot, { from_ref: 3, circuit_ref: 5 });
    expect(r).toEqual({ ok: false, error: { code: 'target_exists' } });
    expect(snapshot.circuits['main::3'].ze).toBe('0.42');
    expect(snapshot.circuits['main::5'].pfc).toBe('1.5');
  });

  test('rename is scoped to the same board (does not move circuits across boards)', () => {
    const snapshot = makeSnapshot({
      circuits: {
        'main::3': { circuit: 3, board_id: 'main' },
        'sub-1::5': { circuit: 5, board_id: 'sub-1' },
      },
    });
    const r = renameCircuitMultiBoard(snapshot, { from_ref: 3, circuit_ref: 5, boardId: 'sub-1' });
    // sub-1::3 doesn't exist → source_not_found, even though main::3 does.
    expect(r).toEqual({ ok: false, error: { code: 'source_not_found' } });
  });
});

describe('deleteCircuitMultiBoard', () => {
  test('deletes the bucket and reports deleted:true', () => {
    const snapshot = makeSnapshot({
      circuits: { 'main::3': { circuit: 3, board_id: 'main' } },
    });
    const r = deleteCircuitMultiBoard(snapshot, { circuit_ref: 3 });
    expect(r).toEqual({ ok: true, deleted: true });
    expect(snapshot.circuits['main::3']).toBeUndefined();
  });

  test('reports deleted:false when the bucket is absent', () => {
    const snapshot = makeSnapshot();
    const r = deleteCircuitMultiBoard(snapshot, { circuit_ref: 99 });
    expect(r).toEqual({ ok: true, deleted: false });
  });

  test('only deletes the matching board scope', () => {
    const snapshot = makeSnapshot({
      circuits: {
        'main::3': { circuit: 3, board_id: 'main' },
        'sub-1::3': { circuit: 3, board_id: 'sub-1' },
      },
    });
    deleteCircuitMultiBoard(snapshot, { circuit_ref: 3, boardId: 'main' });
    expect(snapshot.circuits['main::3']).toBeUndefined();
    expect(snapshot.circuits['sub-1::3']).toBeDefined();
  });
});

describe('legacy + composite key coexistence (slice 5.3 prerequisite)', () => {
  test("legacy '1' key and composite 'main::1' key live side by side", () => {
    // This is the load-bearing invariant for slice 5.3's flag-gated dispatcher
    // wiring: while STAGE6_MULTI_BOARD is off in production, every dispatcher
    // still writes via the legacy mutators (numeric keys). When the flag flips
    // on for one session, the SAME snapshot object will start receiving
    // composite-key writes. They must not stomp on each other.
    const snapshot = makeSnapshot({
      circuits: {
        0: { ze: '0.42' }, // legacy supply bucket
        1: { circuit_designation: 'Lighting' }, // legacy circuit 1
      },
    });
    applyReadingMultiBoard(snapshot, { circuit: 1, field: 'ze', value: '0.50' });
    // The legacy buckets are untouched; the composite bucket lives at a
    // different key.
    expect(snapshot.circuits[0]).toEqual({ ze: '0.42' });
    expect(snapshot.circuits[1]).toEqual({ circuit_designation: 'Lighting' });
    expect(snapshot.circuits['main::1']).toEqual({ circuit: 1, board_id: 'main', ze: '0.50' });
    // Four distinct keys — no collision, no overwrite.
    expect(Object.keys(snapshot.circuits).sort()).toEqual(['0', '1', 'main::1']);
  });

  test('clearing on the composite key does not touch the legacy bucket', () => {
    const snapshot = makeSnapshot({
      circuits: {
        1: { circuit_designation: 'Lighting', ze: '0.42' },
        'main::1': { circuit: 1, board_id: 'main', ze: '0.50' },
      },
    });
    clearReadingMultiBoard(snapshot, { circuit: 1, field: 'ze' });
    expect(snapshot.circuits[1].ze).toBe('0.42'); // legacy untouched
    expect(snapshot.circuits['main::1'].ze).toBeUndefined(); // composite cleared
  });
});

describe('per-board namespace isolation', () => {
  test("circuit '1' on main and circuit '1' on sub-1 do not collide", () => {
    const snapshot = makeSnapshot();
    applyReadingMultiBoard(snapshot, { circuit: 1, field: 'ze', value: '0.42', boardId: 'main' });
    applyReadingMultiBoard(snapshot, { circuit: 1, field: 'ze', value: '0.18', boardId: 'sub-1' });
    expect(snapshot.circuits['main::1'].ze).toBe('0.42');
    expect(snapshot.circuits['sub-1::1'].ze).toBe('0.18');
  });

  test('findCircuitBucket scopes lookup to the requested board', () => {
    const snapshot = makeSnapshot({
      circuits: {
        'main::1': { circuit: 1, board_id: 'main', ze: '0.42' },
        'sub-1::1': { circuit: 1, board_id: 'sub-1', ze: '0.18' },
      },
    });
    expect(findCircuitBucket(snapshot, 1, 'main').bucket.ze).toBe('0.42');
    expect(findCircuitBucket(snapshot, 1, 'sub-1').bucket.ze).toBe('0.18');
  });
});

// ---------------------------------------------------------------------------
// Slice 5.5 — applyBoardReadingMultiBoard. Board / supply / installation
// readings stop sharing the legacy circuits[0] namespace and land on the
// resolved board's BoardInfo entry on snapshot.boards.
// ---------------------------------------------------------------------------
describe('applyBoardReadingMultiBoard — board-level writes', () => {
  test('writes to the active board on snapshot.boards (no circuits[0] touch)', () => {
    const snapshot = makeSnapshot();
    applyBoardReadingMultiBoard(snapshot, { field: 'earth_loop_impedance_ze', value: '0.35' });
    expect(snapshot.boards[0]).toEqual({
      id: 'main',
      designation: 'DB-1',
      board_type: 'main',
      earth_loop_impedance_ze: '0.35',
    });
    // Slice 5.6 retires circuits[0]; under flag-on with the new mutator, it
    // is never written to.
    expect(snapshot.circuits[0]).toBeUndefined();
  });

  test('explicit boardId scopes the write to the named sub-board', () => {
    const snapshot = makeSnapshot();
    snapshot.boards.push({ id: 'sub-1', designation: 'DB-2', board_type: 'sub-distribution' });
    applyBoardReadingMultiBoard(snapshot, {
      field: 'earth_loop_impedance_ze',
      value: '0.18',
      boardId: 'sub-1',
    });
    expect(snapshot.boards[0].earth_loop_impedance_ze).toBeUndefined();
    expect(snapshot.boards[1].earth_loop_impedance_ze).toBe('0.18');
  });

  test('falls back to snapshot.currentBoardId when boardId omitted', () => {
    const snapshot = makeSnapshot({
      boards: [
        { id: 'main', designation: 'DB-1', board_type: 'main' },
        { id: 'sub-1', designation: 'DB-2', board_type: 'sub-distribution' },
      ],
      currentBoardId: 'sub-1',
    });
    applyBoardReadingMultiBoard(snapshot, { field: 'earth_loop_impedance_ze', value: '0.18' });
    expect(snapshot.boards[1].earth_loop_impedance_ze).toBe('0.18');
    expect(snapshot.boards[0].earth_loop_impedance_ze).toBeUndefined();
  });

  test('synthesises a sub-distribution BoardInfo on first write to a previously-unseen id', () => {
    const snapshot = makeSnapshot();
    applyBoardReadingMultiBoard(snapshot, {
      field: 'earth_loop_impedance_ze',
      value: '0.18',
      boardId: 'sub-2',
    });
    const sub = snapshot.boards.find((b) => b.id === 'sub-2');
    expect(sub).toEqual({
      id: 'sub-2',
      designation: 'sub-2',
      board_type: 'sub-distribution',
      earth_loop_impedance_ze: '0.18',
    });
  });

  test('synthesises a main BoardInfo when the resolved id is the default fallback', () => {
    // Snapshot has no boards array at all (legacy snapshot before slice 5.1
    // wire-in completes hydration). The mutator must seed boards[] and
    // synthesise the default 'main' board record.
    const snapshot = { circuits: {} };
    applyBoardReadingMultiBoard(snapshot, { field: 'earth_loop_impedance_ze', value: '0.35' });
    expect(snapshot.boards).toHaveLength(1);
    expect(snapshot.boards[0]).toEqual({
      id: 'main',
      designation: 'main',
      board_type: 'main',
      earth_loop_impedance_ze: '0.35',
    });
  });

  test('subsequent writes accrete fields on the same BoardInfo entry', () => {
    const snapshot = makeSnapshot();
    applyBoardReadingMultiBoard(snapshot, { field: 'earth_loop_impedance_ze', value: '0.35' });
    applyBoardReadingMultiBoard(snapshot, { field: 'prospective_fault_current', value: '1.5' });
    expect(snapshot.boards[0]).toEqual({
      id: 'main',
      designation: 'DB-1',
      board_type: 'main',
      earth_loop_impedance_ze: '0.35',
      prospective_fault_current: '1.5',
    });
  });

  test('last-write-wins on the same field', () => {
    const snapshot = makeSnapshot();
    applyBoardReadingMultiBoard(snapshot, { field: 'earth_loop_impedance_ze', value: '0.35' });
    applyBoardReadingMultiBoard(snapshot, { field: 'earth_loop_impedance_ze', value: '0.42' });
    expect(snapshot.boards[0].earth_loop_impedance_ze).toBe('0.42');
  });

  test('does not collide with circuits[0] legacy bucket — flag-off readers see neither', () => {
    // Coexistence pin: flag-off serialiser reads circuits[0]; flag-on writer
    // populates boards[0]. Slice 5.5 / 5.6 retires circuits[0] entirely;
    // until then, the two surfaces are independent.
    const snapshot = makeSnapshot({
      circuits: { 0: { earth_loop_impedance_ze: '0.99' } },
    });
    applyBoardReadingMultiBoard(snapshot, { field: 'earth_loop_impedance_ze', value: '0.35' });
    expect(snapshot.circuits[0].earth_loop_impedance_ze).toBe('0.99'); // legacy untouched
    expect(snapshot.boards[0].earth_loop_impedance_ze).toBe('0.35'); // new surface
  });
});
