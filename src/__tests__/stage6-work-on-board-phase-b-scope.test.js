/**
 * "Work on Board" sprint — Phase B regression suite.
 *
 * Phase B locks Q0.4 of the multi-board sprint at the dispatcher contract:
 * mutator tools (record_reading / clear_reading / create_circuit /
 * rename_circuit / delete_circuit / record_board_reading) reject explicit
 * `board_id` arguments that disagree with the session's `currentBoardId`.
 * The model must call `select_board` first.
 *
 * Why a dedicated file rather than appending to the Phase A flag-routing
 * suite: Phase A pinned dual-shape STORAGE; Phase B pins WRITE SCOPING.
 * The two concerns share fixtures but have orthogonal failure modes — a
 * regression in storage shape is a different bug class from a regression
 * in scope enforcement, and isolating the suite keeps the diagnostic
 * surface clean when CI fires red.
 *
 * Tools INTENTIONALLY exempt from the scope rule (covered as negative-space
 * tests below): calculate_zs, calculate_r1_plus_r2, set_field_for_all_circuits
 * (Phase 6.5 cross-board contract); add_board, select_board (board-system
 * tools); mark_distribution_circuit (`board_id` names the source board for
 * a relationship, not a write target).
 */

import { jest } from '@jest/globals';
import { createWriteDispatcher } from '../extraction/stage6-dispatchers.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';
import { validateBoardScope } from '../extraction/stage6-dispatch-validation.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

// Two-board snapshot. main = currentBoardId; sub-1 exists but inactive.
// Used for the "active=main, explicit sub-1 rejected" half of every test.
function makeMainActiveSession(circuitSeeds = {}) {
  return {
    sessionId: 's-main-active',
    stateSnapshot: {
      circuits: {
        // circuits[0] = legacy main supply bucket (every reader expects it).
        0: {},
        // Pre-seeded main circuit so create_circuit can target a fresh ref
        // without colliding, and rename_circuit has a from_ref to use.
        3: { circuit_designation: 'Lighting' },
        // Pre-seeded sub-1 composite-key bucket so cross-board attempts
        // target an actually-existing sub-board ref (otherwise the
        // dispatcher might reject on 'circuit_not_found' before it ever
        // reaches the scope check, masking the contract under test).
        'sub-1::1': { circuit: 1, board_id: 'sub-1', circuit_designation: 'Lights' },
        ...circuitSeeds,
      },
      pending_readings: [],
      observations: [],
      validation_alerts: [],
      boards: [
        { id: 'main', designation: 'DB-1', board_type: 'main' },
        {
          id: 'sub-1',
          designation: 'DB-2',
          board_type: 'sub_main',
          parent_board_id: 'main',
          feed_circuit_ref: 4,
        },
      ],
      currentBoardId: 'main',
    },
    extractedObservations: [],
  };
}

// Mirror with currentBoardId='sub-1' so we can verify the same contract
// fires when active board is a sub-board (asymmetric breakage = bug).
function makeSubActiveSession(circuitSeeds = {}) {
  return {
    sessionId: 's-sub-active',
    stateSnapshot: {
      circuits: {
        0: {},
        3: { circuit_designation: 'Main lighting' },
        'sub-1::1': { circuit: 1, board_id: 'sub-1', circuit_designation: 'Sub lights' },
        ...circuitSeeds,
      },
      pending_readings: [],
      observations: [],
      validation_alerts: [],
      boards: [
        { id: 'main', designation: 'DB-1', board_type: 'main' },
        {
          id: 'sub-1',
          designation: 'DB-2',
          board_type: 'sub_main',
          parent_board_id: 'main',
          feed_circuit_ref: 4,
        },
      ],
      currentBoardId: 'sub-1',
    },
    extractedObservations: [],
  };
}

// ---------------------------------------------------------------------------
// validateBoardScope — pure-function unit tests
// ---------------------------------------------------------------------------
describe('validateBoardScope (pure)', () => {
  const snap = (cur) => ({
    currentBoardId: cur,
    boards: [
      { id: 'main', board_type: 'main' },
      { id: 'sub-1', board_type: 'sub_main' },
    ],
  });

  test('omitted board_id is always allowed (defaults to currentBoardId via mutator)', () => {
    expect(validateBoardScope({}, snap('main'))).toBeNull();
    expect(validateBoardScope({}, snap('sub-1'))).toBeNull();
    expect(validateBoardScope({ board_id: null }, snap('main'))).toBeNull();
    expect(validateBoardScope({ board_id: undefined }, snap('main'))).toBeNull();
  });

  test('matching board_id is allowed', () => {
    expect(validateBoardScope({ board_id: 'main' }, snap('main'))).toBeNull();
    expect(validateBoardScope({ board_id: 'sub-1' }, snap('sub-1'))).toBeNull();
  });

  test('mismatched board_id rejects with structured wrong_board', () => {
    const err = validateBoardScope({ board_id: 'sub-1' }, snap('main'));
    expect(err).toMatchObject({
      code: 'wrong_board',
      field: 'board_id',
      expected: 'main',
      got: 'sub-1',
    });
    expect(typeof err.hint).toBe('string');
    expect(err.hint.length).toBeGreaterThan(0);
  });

  test('mirror direction: explicit main while on sub also rejects', () => {
    const err = validateBoardScope({ board_id: 'main' }, snap('sub-1'));
    expect(err).toMatchObject({
      code: 'wrong_board',
      field: 'board_id',
      expected: 'sub-1',
      got: 'main',
    });
  });

  test('falls back to getMainBoardId when currentBoardId missing', () => {
    // Edge case: snapshot constructed without currentBoardId. Most session
    // flows ensure it via ensureMultiBoardShape, but a future caller may
    // skip that step. Without the fallback, an undefined `expected` would
    // accept any non-null board_id silently — the worst possible failure
    // mode (corruption + no reject signal).
    const noCur = { boards: [{ id: 'main', board_type: 'main' }] };
    expect(validateBoardScope({ board_id: 'main' }, noCur)).toBeNull();
    expect(validateBoardScope({ board_id: 'sub-1' }, noCur)).toMatchObject({
      code: 'wrong_board',
      expected: 'main',
      got: 'sub-1',
    });
  });
});

// ---------------------------------------------------------------------------
// Per-dispatcher rejection contract.
//
// Each circuit-shaped mutator gets the same coverage shape:
//   1) omitted board_id with currentBoardId='main' → ok (legacy main path)
//   2) omitted board_id with currentBoardId='sub-1' → ok (sub path)
//   3) explicit board_id='main' on main-active → ok
//   4) explicit board_id='sub-1' on main-active → REJECT wrong_board
//   5) snapshot + perTurnWrites untouched on reject (no leak)
// ---------------------------------------------------------------------------
describe('record_reading — Phase B scope', () => {
  test('omitted board_id, main active: writes to main legacy bucket', async () => {
    const session = makeMainActiveSession();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 'turn-1', writes);
    const result = await d(
      {
        tool_call_id: 'tu_1',
        name: 'record_reading',
        input: {
          field: 'measured_zs_ohm',
          circuit: 3,
          value: '0.42',
          confidence: 1,
          source_turn_id: 't1',
        },
      },
      {}
    );
    expect(result.is_error).toBe(false);
    expect(session.stateSnapshot.circuits[3].measured_zs_ohm).toBe('0.42');
    expect(session.stateSnapshot.circuits['sub-1::1'].measured_zs_ohm).toBeUndefined();
  });

  test('omitted board_id, sub active: writes to composite bucket', async () => {
    const session = makeSubActiveSession();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 'turn-1', writes);
    const result = await d(
      {
        tool_call_id: 'tu_1',
        name: 'record_reading',
        input: {
          field: 'measured_zs_ohm',
          circuit: 1,
          value: '0.18',
          confidence: 1,
          source_turn_id: 't1',
        },
      },
      {}
    );
    expect(result.is_error).toBe(false);
    expect(session.stateSnapshot.circuits['sub-1::1'].measured_zs_ohm).toBe('0.18');
    // Main's circuit 3 untouched (it's a different ref AND a different board).
    expect(session.stateSnapshot.circuits[3].measured_zs_ohm).toBeUndefined();
  });

  test('explicit board_id matches currentBoardId → ok', async () => {
    const session = makeMainActiveSession();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 'turn-1', writes);
    const result = await d(
      {
        tool_call_id: 'tu_1',
        name: 'record_reading',
        input: {
          field: 'measured_zs_ohm',
          circuit: 3,
          value: '0.42',
          confidence: 1,
          source_turn_id: 't1',
          board_id: 'main',
        },
      },
      {}
    );
    expect(result.is_error).toBe(false);
    expect(session.stateSnapshot.circuits[3].measured_zs_ohm).toBe('0.42');
  });

  test('explicit cross-board board_id is rejected wrong_board (snapshot UNTOUCHED)', async () => {
    const session = makeMainActiveSession();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 'turn-1', writes);
    const result = await d(
      {
        tool_call_id: 'tu_1',
        name: 'record_reading',
        input: {
          field: 'measured_zs_ohm',
          circuit: 1,
          value: '0.18',
          confidence: 1,
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
      expected: 'main',
      got: 'sub-1',
    });
    // Both buckets untouched — sub-1::1 keeps its seeded designation, main's
    // circuit 3 keeps its (a record_reading on circuit 1 wouldn't have
    // touched 3, but a half-applied write would still leak through
    // perTurnWrites; assert both surfaces).
    expect(session.stateSnapshot.circuits['sub-1::1'].measured_zs_ohm).toBeUndefined();
    expect(writes.readings.size).toBe(0);
  });
});

describe('clear_reading — Phase B scope', () => {
  test('omitted board_id, sub active: clears composite bucket field', async () => {
    const session = makeSubActiveSession({
      'sub-1::1': {
        circuit: 1,
        board_id: 'sub-1',
        circuit_designation: 'Sub lights',
        measured_zs_ohm: '0.18',
      },
    });
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 'turn-1', writes);
    const result = await d(
      {
        tool_call_id: 'tu_1',
        name: 'clear_reading',
        input: { field: 'measured_zs_ohm', circuit: 1, reason: 'misheard' },
      },
      {}
    );
    expect(result.is_error).toBe(false);
    expect(session.stateSnapshot.circuits['sub-1::1'].measured_zs_ohm).toBeUndefined();
  });

  test('explicit cross-board board_id rejects wrong_board', async () => {
    const session = makeMainActiveSession({
      'sub-1::1': {
        circuit: 1,
        board_id: 'sub-1',
        circuit_designation: 'Sub lights',
        measured_zs_ohm: '0.18',
      },
    });
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 'turn-1', writes);
    const result = await d(
      {
        tool_call_id: 'tu_1',
        name: 'clear_reading',
        input: { field: 'measured_zs_ohm', circuit: 1, reason: 'misheard', board_id: 'sub-1' },
      },
      {}
    );
    expect(result.is_error).toBe(true);
    const body = JSON.parse(result.content);
    expect(body.error.code).toBe('wrong_board');
    // Field still set on sub-1 — the clear was rejected before mutation.
    expect(session.stateSnapshot.circuits['sub-1::1'].measured_zs_ohm).toBe('0.18');
    expect(writes.cleared.length).toBe(0);
  });
});

describe('create_circuit — Phase B scope', () => {
  test('omitted board_id, sub active: creates composite-key bucket', async () => {
    const session = makeSubActiveSession();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 'turn-1', writes);
    const result = await d(
      {
        tool_call_id: 'tu_1',
        name: 'create_circuit',
        input: { circuit_ref: 7, designation: 'Sockets' },
      },
      {}
    );
    expect(result.is_error).toBe(false);
    expect(session.stateSnapshot.circuits['sub-1::7']).toBeDefined();
    // Main bucket of the same ref MUST NOT be created.
    expect(session.stateSnapshot.circuits[7]).toBeUndefined();
  });

  test('explicit cross-board board_id rejects (no composite bucket created)', async () => {
    const session = makeMainActiveSession();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 'turn-1', writes);
    const result = await d(
      {
        tool_call_id: 'tu_1',
        name: 'create_circuit',
        input: { circuit_ref: 7, designation: 'Sockets', board_id: 'sub-1' },
      },
      {}
    );
    expect(result.is_error).toBe(true);
    const body = JSON.parse(result.content);
    expect(body.error.code).toBe('wrong_board');
    expect(session.stateSnapshot.circuits['sub-1::7']).toBeUndefined();
    expect(session.stateSnapshot.circuits[7]).toBeUndefined();
    expect(writes.circuitOps.length).toBe(0);
  });
});

describe('rename_circuit — Phase B scope', () => {
  test('explicit cross-board board_id rejects (no rename happens)', async () => {
    const session = makeMainActiveSession();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 'turn-1', writes);
    const result = await d(
      {
        tool_call_id: 'tu_1',
        name: 'rename_circuit',
        input: { from_ref: 1, circuit_ref: 9, board_id: 'sub-1' },
      },
      {}
    );
    expect(result.is_error).toBe(true);
    const body = JSON.parse(result.content);
    expect(body.error.code).toBe('wrong_board');
    // sub-1::1 still exists; sub-1::9 was never created.
    expect(session.stateSnapshot.circuits['sub-1::1']).toBeDefined();
    expect(session.stateSnapshot.circuits['sub-1::9']).toBeUndefined();
    expect(writes.circuitOps.length).toBe(0);
  });
});

describe('delete_circuit — Phase B scope', () => {
  test('explicit cross-board board_id rejects (no delete)', async () => {
    const session = makeMainActiveSession();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 'turn-1', writes);
    const result = await d(
      {
        tool_call_id: 'tu_1',
        name: 'delete_circuit',
        input: { circuit_ref: 1, board_id: 'sub-1' },
      },
      {}
    );
    expect(result.is_error).toBe(true);
    const body = JSON.parse(result.content);
    expect(body.error.code).toBe('wrong_board');
    expect(session.stateSnapshot.circuits['sub-1::1']).toBeDefined();
    expect(writes.circuitOps.length).toBe(0);
  });
});

describe('record_board_reading — Phase B scope', () => {
  test('omitted board_id, sub active: writes to BoardInfo on sub-1', async () => {
    const session = makeSubActiveSession();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 'turn-1', writes);
    const result = await d(
      {
        tool_call_id: 'tu_1',
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
    // sub-1's BoardInfo carries the field; circuits[0] (main supply) does NOT.
    expect(session.stateSnapshot.boards[1].earth_loop_impedance_ze).toBe('0.35');
    expect(session.stateSnapshot.circuits[0].earth_loop_impedance_ze).toBeUndefined();
  });

  test('explicit cross-board board_id rejects', async () => {
    const session = makeMainActiveSession();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 'turn-1', writes);
    const result = await d(
      {
        tool_call_id: 'tu_1',
        name: 'record_board_reading',
        input: {
          field: 'earth_loop_impedance_ze',
          value: '0.35',
          confidence: 0.9,
          source_turn_id: 't1',
          board_id: 'sub-1',
        },
      },
      {}
    );
    expect(result.is_error).toBe(true);
    const body = JSON.parse(result.content);
    expect(body.error.code).toBe('wrong_board');
    // Neither board carries the value.
    expect(session.stateSnapshot.boards[0].earth_loop_impedance_ze).toBeUndefined();
    expect(session.stateSnapshot.boards[1].earth_loop_impedance_ze).toBeUndefined();
    expect(writes.boardReadings.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// select_board flips the scope: a write that was rejected before now lands.
//
// The integration shape this pins: caller's typical recovery path on receipt
// of a `wrong_board` envelope is `select_board(target)` then retry. The
// retry must succeed because currentBoardId now matches.
// ---------------------------------------------------------------------------
describe('select_board flips currentBoardId so the next write lands', () => {
  test('rejected write retries cleanly after select_board', async () => {
    const session = makeMainActiveSession();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 'turn-1', writes);

    // Pre-flip: explicit sub-1 write rejects.
    const rejected = await d(
      {
        tool_call_id: 'tu_pre',
        name: 'record_reading',
        input: {
          field: 'measured_zs_ohm',
          circuit: 1,
          value: '0.18',
          confidence: 1,
          source_turn_id: 't1',
          board_id: 'sub-1',
        },
      },
      {}
    );
    expect(rejected.is_error).toBe(true);

    // Flip via select_board.
    const select = await d(
      {
        tool_call_id: 'tu_sel',
        name: 'select_board',
        input: { board_id: 'sub-1' },
      },
      {}
    );
    expect(select.is_error).toBe(false);
    expect(session.stateSnapshot.currentBoardId).toBe('sub-1');

    // Retry without board_id (the canonical Phase B pattern).
    const retried = await d(
      {
        tool_call_id: 'tu_post',
        name: 'record_reading',
        input: {
          field: 'measured_zs_ohm',
          circuit: 1,
          value: '0.18',
          confidence: 1,
          source_turn_id: 't1',
        },
      },
      {}
    );
    expect(retried.is_error).toBe(false);
    expect(session.stateSnapshot.circuits['sub-1::1'].measured_zs_ohm).toBe('0.18');
  });
});

// ---------------------------------------------------------------------------
// Negative-space: tools that DO accept cross-board board_id keep working.
//
// The rejection rule MUST NOT bleed into the calc / bulk tools. Phase 6.5
// deliberately threads board_id for cross-board calcs; locking it would
// break legitimate inspector flows like "calculate Zs for every circuit on
// the garage sub-board from main".
// ---------------------------------------------------------------------------
describe('exempt tools: calc + bulk + board-system tools', () => {
  test('calculate_zs accepts explicit cross-board board_id (Phase 6.5 contract)', async () => {
    const session = makeMainActiveSession({
      0: { earth_loop_impedance_ze: '0.20' },
      'sub-1::1': {
        circuit: 1,
        board_id: 'sub-1',
        circuit_designation: 'Sub lights',
        r1_r2_ohm: '0.30',
      },
    });
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 'turn-1', writes);
    const result = await d(
      {
        tool_call_id: 'tu_calc',
        name: 'calculate_zs',
        input: { all: true, board_id: 'sub-1', source_turn_id: 't1' },
      },
      {}
    );
    expect(result.is_error).toBe(false);
    const body = JSON.parse(result.content);
    expect(body.ok).toBe(true);
    // The scope check must NOT have fired here.
  });

  test('select_board accepts cross-board board_id (it IS the switch tool)', async () => {
    const session = makeMainActiveSession();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 'turn-1', writes);
    const result = await d(
      {
        tool_call_id: 'tu_sel',
        name: 'select_board',
        input: { board_id: 'sub-1' },
      },
      {}
    );
    expect(result.is_error).toBe(false);
    expect(session.stateSnapshot.currentBoardId).toBe('sub-1');
  });
});
