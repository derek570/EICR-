/**
 * "Work on Board" sprint Phase A — dual-shape circuit-storage routing
 * regression suite. (Renamed from "Phase 5.3 — STAGE6_MULTI_BOARD
 * flag-routing" — the env flag is now dead-code; routing is per-call.)
 *
 * Two responsibilities:
 *
 *   (1) Pin the MAIN-BOARD path as byte-identical to the legacy behaviour.
 *       Every existing dispatcher test exercises main implicitly (the
 *       default `currentBoardId='main'` from `ensureMultiBoardShape`), so
 *       the main-board coverage here is intentionally sparse — it just
 *       verifies the new wrappers route to the legacy mutators when the
 *       resolved board is main.
 *
 *   (2) Pin the SUB-BOARD path so that record_reading / clear_reading /
 *       create_circuit / rename_circuit / delete_circuit / record_reading-
 *       in-set_field_for_all_circuits all write to the composite key shape
 *       AND the validators check existence via the composite key when the
 *       resolved board is non-main.
 *
 * The `STAGE6_MULTI_BOARD` env var and `isMultiBoardFlagOn()` helper
 * have both been retired (slice A.4). No remaining production reader.
 * Tests no longer toggle the env or import the helper.
 */

import { jest } from '@jest/globals';
import { createWriteDispatcher } from '../extraction/stage6-dispatchers.js';
import {
  createPerTurnWrites,
  encodeBoardReadingKey,
} from '../extraction/stage6-per-turn-writes.js';
import {
  applyReadingFlagAware,
  clearReadingFlagAware,
  upsertCircuitMetaFlagAware,
  renameCircuitFlagAware,
  deleteCircuitFlagAware,
  applyBoardReadingFlagAware,
} from '../extraction/stage6-snapshot-mutators.js';
import {
  ensureMultiBoardShape,
  circuitExistsInSnapshot,
  getCircuitBucket,
  listCircuitRefsInBoard,
} from '../extraction/stage6-multi-board-shape.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeMultiBoardSession(circuitSeeds = {}) {
  // Construct a session-shaped object with the multi-board snapshot shape
  // (boards + currentBoardId) AND any pre-seeded circuit buckets keyed by
  // composite key. Mimics the post-Phase-5.1 constructor state.
  const snapshot = {
    circuits: { ...circuitSeeds },
    pending_readings: [],
    observations: [],
    validation_alerts: [],
  };
  ensureMultiBoardShape(snapshot);
  return { sessionId: 's-flag', stateSnapshot: snapshot, extractedObservations: [] };
}

function makeLegacySession(circuitSeeds = {}) {
  const snapshot = {
    circuits: { ...circuitSeeds },
    pending_readings: [],
    observations: [],
    validation_alerts: [],
    boards: [{ id: 'main', designation: 'DB-1', board_type: 'main' }],
    currentBoardId: 'main',
  };
  return { sessionId: 's-legacy', stateSnapshot: snapshot, extractedObservations: [] };
}

// "Work on Board" sprint Phase A — sub-board fixture. Constructs a snapshot
// with two boards (main + sub-1) and pins `currentBoardId='sub-1'` so the
// dual-shape helpers route to the composite-key namespace. Used by every
// test that previously asserted "flag-on routes composite" — under dual-shape
// that route is taken by non-main boards regardless of any env flag.
function makeSubBoardSession(circuitSeeds = {}) {
  const snapshot = {
    circuits: { ...circuitSeeds },
    pending_readings: [],
    observations: [],
    validation_alerts: [],
    boards: [
      { id: 'main', designation: 'DB-1', board_type: 'main' },
      {
        id: 'sub-1',
        designation: 'DB-2',
        board_type: 'sub-distribution',
        parent_board_id: 'main',
        feed_circuit_ref: 4,
      },
    ],
    currentBoardId: 'sub-1',
  };
  return { sessionId: 's-sub', stateSnapshot: snapshot, extractedObservations: [] };
}

// ---------------------------------------------------------------------------
// circuitExistsInSnapshot — dual-shape existence check
// ---------------------------------------------------------------------------
describe('circuitExistsInSnapshot', () => {
  test('main board: checks legacy flat key', () => {
    const snapshot = makeLegacySession({ 3: { ze: '0.42' } }).stateSnapshot;
    expect(circuitExistsInSnapshot(snapshot, 3)).toBe(true);
    expect(circuitExistsInSnapshot(snapshot, 99)).toBe(false);
  });

  test('main board: ignores composite buckets', () => {
    // Composite-only bucket on the main namespace. Main always routes legacy,
    // so a `'main::3'` key is invisible — main's circuit-3 lookup walks
    // `circuits[3]`, which is absent.
    const snapshot = makeLegacySession({
      'main::3': { circuit: 3, board_id: 'main' },
    }).stateSnapshot;
    expect(circuitExistsInSnapshot(snapshot, 3, 'main')).toBe(false);
  });

  test('sub-board: checks composite key with currentBoardId fallback', () => {
    const snapshot = makeSubBoardSession({
      'sub-1::3': { circuit: 3, board_id: 'sub-1' },
    }).stateSnapshot;
    expect(circuitExistsInSnapshot(snapshot, 3)).toBe(true);
    expect(circuitExistsInSnapshot(snapshot, 99)).toBe(false);
  });

  test('explicit boardId scopes the lookup across both namespaces', () => {
    const snapshot = makeSubBoardSession({
      3: { ze: '0.42' }, // legacy bare-numeric key (main namespace)
      'sub-1::3': { circuit: 3, board_id: 'sub-1' }, // composite (sub-1 namespace)
    }).stateSnapshot;
    expect(circuitExistsInSnapshot(snapshot, 3, 'main')).toBe(true);
    expect(circuitExistsInSnapshot(snapshot, 3, 'sub-1')).toBe(true);
    expect(circuitExistsInSnapshot(snapshot, 3, 'sub-2')).toBe(false);
  });

  test('sub-board: ignores legacy bare-numeric keys (sub-board namespace is composite-only)', () => {
    // Snapshot has legacy bare-numeric bucket only, sub-board scope queries
    // composite namespace → "doesn't exist" for sub-1 even though main has it.
    const snapshot = makeSubBoardSession({ 3: { ze: '0.42' } }).stateSnapshot;
    expect(circuitExistsInSnapshot(snapshot, 3)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getCircuitBucket / listCircuitRefsInBoard — flag-aware reader helpers (Slice 5.4)
// ---------------------------------------------------------------------------
describe('getCircuitBucket', () => {
  test('main board: returns bucket via legacy flat key', () => {
    const snapshot = makeLegacySession({ 3: { ze: '0.42' } }).stateSnapshot;
    expect(getCircuitBucket(snapshot, 3)).toEqual({ ze: '0.42' });
    expect(getCircuitBucket(snapshot, 99)).toBeUndefined();
  });

  test('sub-board: returns bucket via composite key with currentBoardId', () => {
    const snapshot = makeSubBoardSession({
      'sub-1::3': { circuit: 3, board_id: 'sub-1', ze: '0.18' },
    }).stateSnapshot;
    expect(getCircuitBucket(snapshot, 3)).toEqual({ circuit: 3, board_id: 'sub-1', ze: '0.18' });
  });

  test('explicit boardId scopes the lookup across both namespaces', () => {
    const snapshot = makeSubBoardSession({
      3: { ze: '0.42' }, // legacy main namespace
      'sub-1::3': { circuit: 3, board_id: 'sub-1', ze: '0.18' },
    }).stateSnapshot;
    expect(getCircuitBucket(snapshot, 3, 'main').ze).toBe('0.42');
    expect(getCircuitBucket(snapshot, 3, 'sub-1').ze).toBe('0.18');
    expect(getCircuitBucket(snapshot, 3, 'sub-2')).toBeUndefined();
  });

  test('defensive on null snapshot / null circuits', () => {
    expect(getCircuitBucket(null, 3)).toBeUndefined();
    expect(getCircuitBucket({}, 3)).toBeUndefined();
    expect(getCircuitBucket({ circuits: null }, 3)).toBeUndefined();
  });
});

describe('listCircuitRefsInBoard', () => {
  test('main board: returns numeric keys >= 1, sorted ascending', () => {
    const snapshot = makeLegacySession({ 0: {}, 1: {}, 5: {}, 3: {} }).stateSnapshot;
    expect(listCircuitRefsInBoard(snapshot)).toEqual([1, 3, 5]);
  });

  test('main board: rejects non-numeric keys (composite keys live in another namespace)', () => {
    const snapshot = makeLegacySession({
      1: {},
      'sub-1::3': { circuit: 3, board_id: 'sub-1' },
    }).stateSnapshot;
    // Number('sub-1::3') === NaN, filtered out; 1 stays.
    expect(listCircuitRefsInBoard(snapshot)).toEqual([1]);
  });

  test('sub-board: returns refs from composite-key buckets in current board scope, sorted ascending', () => {
    const snapshot = makeSubBoardSession({
      'sub-1::1': { circuit: 1, board_id: 'sub-1' },
      'sub-1::5': { circuit: 5, board_id: 'sub-1' },
      'sub-1::3': { circuit: 3, board_id: 'sub-1' },
    }).stateSnapshot;
    expect(listCircuitRefsInBoard(snapshot)).toEqual([1, 3, 5]);
  });

  test('explicit boardId scopes to that namespace (cross-board iteration not supported)', () => {
    const snapshot = makeSubBoardSession({
      1: { ze: '0.42' }, // legacy main namespace
      3: { ze: '0.10' }, // legacy main namespace
      'sub-1::1': { circuit: 1, board_id: 'sub-1' },
      'sub-1::7': { circuit: 7, board_id: 'sub-1' },
    }).stateSnapshot;
    expect(listCircuitRefsInBoard(snapshot, 'main')).toEqual([1, 3]);
    expect(listCircuitRefsInBoard(snapshot, 'sub-1')).toEqual([1, 7]);
  });

  test('sub-board: ignores legacy bare-numeric buckets (those belong to main)', () => {
    const snapshot = makeSubBoardSession({
      1: { ze: '0.42' }, // legacy main bucket; invisible to sub-1 scope
      'sub-1::3': { circuit: 3, board_id: 'sub-1' },
    }).stateSnapshot;
    expect(listCircuitRefsInBoard(snapshot)).toEqual([3]);
  });

  test('sub-board: defaults boardId from currentBoardId when explicit arg omitted', () => {
    const snapshot = makeSubBoardSession({
      1: { ze: '0.42' }, // legacy main bucket
      'sub-1::1': { circuit: 1, board_id: 'sub-1' },
    }).stateSnapshot;
    expect(listCircuitRefsInBoard(snapshot)).toEqual([1]);
    // The single ref returned belongs to sub-1's bucket (currentBoardId='sub-1').
  });

  test('defensive on null snapshot / null circuits', () => {
    expect(listCircuitRefsInBoard(null)).toEqual([]);
    expect(listCircuitRefsInBoard({})).toEqual([]);
    expect(listCircuitRefsInBoard({ circuits: null })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Mutator wrappers — flag-aware routing
// ---------------------------------------------------------------------------
describe('dual-shape mutator wrappers', () => {
  test('main board: applyReadingFlagAware writes to legacy flat key', () => {
    const snapshot = makeLegacySession().stateSnapshot;
    applyReadingFlagAware(snapshot, { circuit: 3, field: 'ze', value: '0.42' });
    expect(snapshot.circuits[3]).toEqual({ ze: '0.42' });
    expect(snapshot.circuits['main::3']).toBeUndefined();
  });

  test('sub-board: applyReadingFlagAware writes to composite key with currentBoardId', () => {
    const snapshot = makeSubBoardSession().stateSnapshot;
    applyReadingFlagAware(snapshot, { circuit: 3, field: 'ze', value: '0.42' });
    expect(snapshot.circuits['sub-1::3']).toEqual({ circuit: 3, board_id: 'sub-1', ze: '0.42' });
    expect(snapshot.circuits[3]).toBeUndefined();
  });

  test('explicit boardId from input overrides currentBoardId (sub-1 from main session)', () => {
    const snapshot = makeLegacySession().stateSnapshot;
    snapshot.boards.push({ id: 'sub-1', designation: 'DB-2', board_type: 'sub-distribution' });
    applyReadingFlagAware(snapshot, { circuit: 3, field: 'ze', value: '0.18', boardId: 'sub-1' });
    expect(snapshot.circuits['sub-1::3']).toEqual({ circuit: 3, board_id: 'sub-1', ze: '0.18' });
  });

  test('sub-board: clearReadingFlagAware removes composite-key field', () => {
    const snapshot = makeSubBoardSession({
      'sub-1::3': { circuit: 3, board_id: 'sub-1', ze: '0.42', pfc: '1.5' },
    }).stateSnapshot;
    const r = clearReadingFlagAware(snapshot, { circuit: 3, field: 'ze' });
    // 1a.6 — clearReading{InSnapshot,MultiBoard} now also return previousValue
    // so dispatchClearReading can emit field_corrected with the pre-clear value.
    expect(r).toEqual({ cleared: true, previousValue: '0.42' });
    expect(snapshot.circuits['sub-1::3'].ze).toBeUndefined();
    expect(snapshot.circuits['sub-1::3'].pfc).toBe('1.5');
  });

  test('sub-board: upsertCircuitMetaFlagAware creates composite-key bucket', () => {
    const snapshot = makeSubBoardSession().stateSnapshot;
    upsertCircuitMetaFlagAware(snapshot, { circuit_ref: 7, designation: 'Cooker' });
    expect(snapshot.circuits['sub-1::7']).toEqual({
      circuit: 7,
      board_id: 'sub-1',
      designation: 'Cooker',
    });
  });

  test('sub-board: renameCircuitFlagAware rekeys composite key only', () => {
    const snapshot = makeSubBoardSession({
      'sub-1::3': { circuit: 3, board_id: 'sub-1', ze: '0.42' },
    }).stateSnapshot;
    const r = renameCircuitFlagAware(snapshot, { from_ref: 3, circuit_ref: 5 });
    expect(r).toEqual({ ok: true });
    expect(snapshot.circuits['sub-1::3']).toBeUndefined();
    expect(snapshot.circuits['sub-1::5']).toEqual({ circuit: 5, board_id: 'sub-1', ze: '0.42' });
  });

  test('sub-board: deleteCircuitFlagAware removes composite-key bucket', () => {
    const snapshot = makeSubBoardSession({
      'sub-1::3': { circuit: 3, board_id: 'sub-1' },
    }).stateSnapshot;
    const r = deleteCircuitFlagAware(snapshot, { circuit_ref: 3 });
    expect(r).toEqual({ ok: true, deleted: true });
    expect(snapshot.circuits['sub-1::3']).toBeUndefined();
  });

  // applyBoardReadingFlagAware — main writes legacy circuits[0]; sub-board writes BoardInfo.
  test('main board: applyBoardReadingFlagAware writes to legacy circuits[0]', () => {
    const snapshot = makeLegacySession().stateSnapshot;
    applyBoardReadingFlagAware(snapshot, { field: 'earth_loop_impedance_ze', value: '0.35' });
    expect(snapshot.circuits[0]).toEqual({ earth_loop_impedance_ze: '0.35' });
    // Boards array stays as it was — main path doesn't touch BoardInfo.
    expect(snapshot.boards[0].earth_loop_impedance_ze).toBeUndefined();
  });

  test('sub-board: applyBoardReadingFlagAware writes to BoardInfo on the active board', () => {
    const snapshot = makeSubBoardSession().stateSnapshot;
    applyBoardReadingFlagAware(snapshot, { field: 'earth_loop_impedance_ze', value: '0.35' });
    // boards[1] is sub-1 in makeSubBoardSession (boards[0]=main, boards[1]=sub-1).
    expect(snapshot.boards[1].earth_loop_impedance_ze).toBe('0.35');
    expect(snapshot.circuits[0]).toBeUndefined();
  });

  test('explicit boardId overrides currentBoardId (sub-1 from main session)', () => {
    const snapshot = makeLegacySession().stateSnapshot;
    snapshot.boards.push({ id: 'sub-1', designation: 'DB-2', board_type: 'sub-distribution' });
    applyBoardReadingFlagAware(snapshot, {
      field: 'earth_loop_impedance_ze',
      value: '0.18',
      boardId: 'sub-1',
    });
    expect(snapshot.boards[0].earth_loop_impedance_ze).toBeUndefined();
    expect(snapshot.boards[1].earth_loop_impedance_ze).toBe('0.18');
  });
});

// ---------------------------------------------------------------------------
// End-to-end dispatcher invocation against a sub-board target. Exercises the
// full pipeline (validator → mutator → perTurnWrites → log) so a regression
// in any of validation, mutation, or wrapping surfaces here. Sub-board scope
// is the only path that exercises composite-key writes — main is legacy.
// ---------------------------------------------------------------------------
describe('dispatchers against a sub-board target', () => {
  test('record_reading writes via composite-key + validator accepts composite-key existence', async () => {
    const session = makeSubBoardSession({
      'sub-1::3': { circuit: 3, board_id: 'sub-1' }, // pre-existing bucket so validator accepts
    });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_1',
        name: 'record_reading',
        input: {
          field: 'earth_loop_impedance_ze',
          circuit: 3,
          value: '0.42',
          confidence: 0.9,
          source_turn_id: 't1',
        },
      },
      {}
    );

    expect(result.is_error).toBe(false);
    expect(session.stateSnapshot.circuits['sub-1::3']).toMatchObject({
      circuit: 3,
      board_id: 'sub-1',
      earth_loop_impedance_ze: '0.42',
    });
  });

  test('record_reading is rejected when circuit absent from composite namespace', async () => {
    // Snapshot has a bare-numeric (main-namespace) bucket but no composite
    // bucket for sub-1. Sub-board validator looks at composite, says
    // "doesn't exist", dispatcher rejects — strict-mode behaviour preserved.
    const session = makeSubBoardSession({ 3: { ze: '0.42' } });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_2',
        name: 'record_reading',
        input: {
          field: 'earth_loop_impedance_ze',
          circuit: 3,
          value: '0.42',
          confidence: 0.9,
          source_turn_id: 't1',
        },
      },
      {}
    );

    expect(result.is_error).toBe(true);
    const body = JSON.parse(result.content);
    expect(body.error.code).toBe('circuit_not_found');
  });

  test('create_circuit writes composite-key bucket', async () => {
    const session = makeSubBoardSession();
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_3',
        name: 'create_circuit',
        input: {
          circuit_ref: 7,
          designation: 'Cooker',
          phase: 'L1',
          rating_amps: 32,
          cable_csa_mm2: 6,
        },
      },
      {}
    );

    expect(result.is_error).toBe(false);
    expect(session.stateSnapshot.circuits['sub-1::7']).toEqual({
      circuit: 7,
      board_id: 'sub-1',
      designation: 'Cooker',
      phase: 'L1',
      rating_amps: 32,
      cable_csa_mm2: 6,
    });
  });

  test('create_circuit refuses duplicate composite-key bucket', async () => {
    const session = makeSubBoardSession({
      'sub-1::7': { circuit: 7, board_id: 'sub-1' },
    });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_4',
        name: 'create_circuit',
        input: { circuit_ref: 7 },
      },
      {}
    );

    expect(result.is_error).toBe(true);
    const body = JSON.parse(result.content);
    expect(body.error.code).toBe('circuit_already_exists');
  });

  test('clear_reading clears composite-key field', async () => {
    const session = makeSubBoardSession({
      'sub-1::3': { circuit: 3, board_id: 'sub-1', earth_loop_impedance_ze: '0.42' },
    });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_5',
        name: 'clear_reading',
        input: { field: 'earth_loop_impedance_ze', circuit: 3, reason: 'cleared by inspector' },
      },
      {}
    );

    expect(result.is_error).toBe(false);
    expect(session.stateSnapshot.circuits['sub-1::3'].earth_loop_impedance_ze).toBeUndefined();
  });

  test('rename_circuit rekeys within the composite namespace', async () => {
    const session = makeSubBoardSession({
      'sub-1::3': { circuit: 3, board_id: 'sub-1', designation: 'Cooker' },
    });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_6',
        name: 'rename_circuit',
        input: { from_ref: 3, circuit_ref: 5 },
      },
      {}
    );

    expect(result.is_error).toBe(false);
    expect(session.stateSnapshot.circuits['sub-1::3']).toBeUndefined();
    expect(session.stateSnapshot.circuits['sub-1::5']).toMatchObject({
      circuit: 5,
      board_id: 'sub-1',
      designation: 'Cooker',
    });
  });

  test('calculate_zs round-trips: composite-key R1+R2 input → composite-key Zs output', async () => {
    // End-to-end pin for the dual-shape reader path on a sub-board: calc_zs
    // must (a) iterate composite-key buckets via listCircuitRefsInBoard,
    // (b) read input r1_r2_ohm via getCircuitBucket, (c) write Zs via the
    // dual-shape mutator wrapper. Ze still lives at circuits[0] (calc_zs
    // pulls from the legacy supply bucket; slice A.4 may migrate that).
    const session = makeSubBoardSession({
      0: { earth_loop_impedance_ze: '0.35' }, // legacy supply bucket — installation-level
      'sub-1::3': { circuit: 3, board_id: 'sub-1', r1_r2_ohm: '0.25' },
    });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_calc_zs',
        name: 'calculate_zs',
        input: { circuit_ref: 3 },
      },
      {}
    );

    expect(result.is_error).toBe(false);
    const body = JSON.parse(result.content);
    expect(body.computed).toEqual([
      { circuit_ref: 3, field: 'measured_zs_ohm', value: '0.60' }, // 0.35 + 0.25 to 2dp
    ]);
    expect(body.skipped).toEqual([]);
    expect(session.stateSnapshot.circuits['sub-1::3'].measured_zs_ohm).toBe('0.60');
  });

  test('set_field_for_all_circuits walks composite-key buckets in current board only', async () => {
    // listCircuitRefsInBoard scopes the iteration to currentBoardId, so a
    // write to 'all' from a sub-board does NOT spill onto the main board's
    // legacy circuits. Cross-board sweep is opt-in via `board_id: '*'`.
    const session = makeSubBoardSession({
      // Main board (legacy bare-numeric keys):
      1: { circuit_designation: 'Lighting' },
      2: { circuit_designation: 'Sockets' },
      // Sub-1 (composite keys):
      'sub-1::1': { circuit: 1, board_id: 'sub-1', circuit_designation: 'Cooker' },
      'sub-1::2': { circuit: 2, board_id: 'sub-1', circuit_designation: 'Garage sockets' },
    });

    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_setall',
        name: 'set_field_for_all_circuits',
        input: {
          field: 'rcd_button_confirmed',
          value: 'OK',
          confidence: 0.95,
          source_turn_id: 't1',
          scope: 'all',
        },
      },
      {}
    );

    expect(result.is_error).toBe(false);
    expect(session.stateSnapshot.circuits['sub-1::1'].rcd_button_confirmed).toBe('OK');
    expect(session.stateSnapshot.circuits['sub-1::2'].rcd_button_confirmed).toBe('OK');
    // Main's legacy circuits MUST not be touched by a sub-board sweep.
    expect(session.stateSnapshot.circuits[1].rcd_button_confirmed).toBeUndefined();
    expect(session.stateSnapshot.circuits[2].rcd_button_confirmed).toBeUndefined();
  });

  test('delete_circuit removes composite-key bucket', async () => {
    const session = makeSubBoardSession({
      'sub-1::3': { circuit: 3, board_id: 'sub-1' },
    });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_7',
        name: 'delete_circuit',
        input: { circuit_ref: 3 },
      },
      {}
    );

    expect(result.is_error).toBe(false);
    const body = JSON.parse(result.content);
    expect(body.deleted).toBe(true);
    expect(session.stateSnapshot.circuits['sub-1::3']).toBeUndefined();
  });

  // record_board_reading end-to-end against a sub-board target.
  test('record_board_reading writes to BoardInfo on the active sub-board (not circuits[0])', async () => {
    const session = makeSubBoardSession();
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_brr_1',
        name: 'record_board_reading',
        input: {
          field: 'earth_loop_impedance_ze',
          value: '0.35',
          confidence: 0.9,
          source_turn_id: 't1',
        },
      },
      {}
    );

    expect(result.is_error).toBe(false);
    // boards[1] is sub-1 in makeSubBoardSession (boards[0]=main, boards[1]=sub-1).
    expect(session.stateSnapshot.boards[1]).toMatchObject({
      id: 'sub-1',
      designation: 'DB-2',
      earth_loop_impedance_ze: '0.35',
    });
    // circuits[0] (legacy supply bucket) MUST stay empty for sub-board writes —
    // sub-boards land on BoardInfo, not on the main supply slot.
    expect(session.stateSnapshot.circuits[0]).toBeUndefined();
    // perTurnWrites still tracks board readings keyed by field so the
    // bundler/comparator surface is unchanged.
    // Hotfix slice 1.1c — boardReadings Map key is encodeBoardReadingKey
    // output. This test omits explicit input.board_id, so the dispatcher
    // passes undefined to encoder → empty boardId tag (legacy-equivalent
    // key shape). The mutator still resolves currentBoardId for the
    // snapshot write — it's the perTurnWrites tracking that's omitted-
    // boardId; the bundler then drops board_id on the wire and iOS uses
    // currentBoardId fallback in slice 1.3.
    expect(
      writes.boardReadings.get(encodeBoardReadingKey('earth_loop_impedance_ze'))
    ).toMatchObject({
      value: '0.35',
      confidence: 0.9,
    });
  });

  test('record_board_reading rejects explicit cross-board board_id with wrong_board (Phase B)', async () => {
    // 2026-05-08 "Work on Board" Phase B locked Q0.4: NO auto-routing of
    // cross-board readings. An explicit board_id that disagrees with
    // currentBoardId is rejected so Sonnet must call select_board first.
    // Pre-Phase-B, this dispatcher silently honoured the override (the
    // forward-compat test that previously lived here).
    const session = makeSubBoardSession();
    session.stateSnapshot.currentBoardId = 'main';
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_brr_2',
        name: 'record_board_reading',
        input: {
          field: 'earth_loop_impedance_ze',
          value: '0.18',
          confidence: 0.9,
          source_turn_id: 't1',
          board_id: 'sub-1',
        },
      },
      {}
    );

    expect(result.is_error).toBe(true);
    const body = JSON.parse(result.content);
    expect(body.error).toMatchObject({
      code: 'wrong_board',
      field: 'board_id',
      expected: 'main',
      got: 'sub-1',
    });
    // Snapshot UNTOUCHED on rejection — neither board carries the value.
    expect(session.stateSnapshot.boards[0].earth_loop_impedance_ze).toBeUndefined();
    expect(session.stateSnapshot.boards[1].earth_loop_impedance_ze).toBeUndefined();
    // perTurnWrites also UNTOUCHED — the bundler should not see this turn
    // as having produced a board reading.
    expect(writes.boardReadings.size).toBe(0);
  });

  test('record_board_reading auto-resolve write hook lands on BoardInfo (path-2 invariant)', async () => {
    // The path-2 resolver dispatches a SYNTHETIC record_board_reading call
    // with a tool_call_id containing '::auto::' when an ask_user reply
    // resolves a pending_write. Against a sub-board target, the synthetic
    // write must land on BoardInfo — NOT on circuits[0]. Pins the contract
    // documented in memory/handoff_2026-04-27_path2_review_fixes.md (the
    // resolver's invariants must survive the dual-shape transition).
    const session = makeSubBoardSession();
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_pending_42::auto::42',
        name: 'record_board_reading',
        input: {
          field: 'earth_loop_impedance_ze',
          value: '0.42',
          confidence: 1.0,
          source_turn_id: 't_resolve',
        },
      },
      {}
    );

    expect(result.is_error).toBe(false);
    // boards[1] is sub-1 (active board).
    expect(session.stateSnapshot.boards[1].earth_loop_impedance_ze).toBe('0.42');
    // perTurnWrites flags the write as auto-resolved so the slot comparator
    // can filter it (P3-B from the path-2 review).
    expect(
      writes.boardReadings.get(encodeBoardReadingKey('earth_loop_impedance_ze')).auto_resolved
    ).toBe(true);
  });
});
