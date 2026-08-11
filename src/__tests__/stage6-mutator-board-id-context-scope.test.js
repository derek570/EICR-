/**
 * Plan 08B — board_id removed from the five current-board-only mutator
 * SCHEMAS; dispatcher behaviour deliberately UNCHANGED.
 *
 * WHAT: the schema edit removes a model-facing affordance, nothing else.
 * Every one of the five dispatchers still reads `input.board_id`, and this
 * suite pins that the three behaviours that matter are byte-for-byte what
 * they were before:
 *
 *   1. An off-schema board_id that MATCHES currentBoardId is still ACCEPTED
 *      and still writes.
 *   2. An off-schema board_id that MISMATCHES currentBoardId is still
 *      REJECTED wrong_board, with nothing mutated.
 *   3. An absent board_id still scopes to currentBoardId.
 *
 * WHY (1) is the load-bearing case, and why the acceptance criterion is NOT
 * "any supplied board_id rejects": the server authors record_reading writes
 * that legitimately carry an explicit board_id. Sub-board clarification
 * answers are resolved server-side and stamped with the ask's board scope —
 * stage6-dispatcher-ask.js threads `contextBoardId: input.context_board_id`,
 * and stage6-answer-resolver.js writes it into every generated write via
 * buildWrite(pendingWrite, ref, contextBoardId). Implementing "reject any
 * supplied board_id" literally would break every sub-board clarification
 * answer in production. That is the regression this file exists to catch.
 *
 * WHY (2): `strict: true` is off (Bug-E, 2026-04-26 — grammar compilation
 * intermittently 503'd and hung the turn ~30s), so removing the property
 * does NOT prevent the model emitting it. validateBoardScope remains the
 * thing that actually stops a wrong write. Plan 08B is a nudge plus an
 * existing backstop, not a fence, and this suite pins the backstop.
 *
 * Sibling: stage6-tool-schemas-board-id-thread.test.js pins the SCHEMA side
 * (the five no longer declare it; the four that legitimately take a board
 * target still do).
 */

import { jest } from '@jest/globals';
import { createWriteDispatcher } from '../extraction/stage6-dispatchers.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';
import { ensureMultiBoardShape } from '../extraction/stage6-multi-board-shape.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

/**
 * Session with a main board plus `sub-1`, sub-1 active, and circuit 1
 * seeded on BOTH namespaces so a mis-scoped write would be visible rather
 * than merely absent.
 */
function makeSubActiveSession() {
  const snapshot = {
    circuits: {},
    pending_readings: [],
    observations: [],
    validation_alerts: [],
  };
  ensureMultiBoardShape(snapshot);
  snapshot.boards.push({
    id: 'sub-1',
    designation: 'Garage CU',
    board_type: 'sub_distribution',
  });
  snapshot.currentBoardId = 'sub-1';
  snapshot.circuits[1] = { circuit: 1, circuit_designation: 'Main lights' };
  snapshot.circuits['sub-1::1'] = {
    circuit: 1,
    board_id: 'sub-1',
    circuit_designation: 'Garage lights',
  };
  return { sessionId: 's-08b', stateSnapshot: snapshot, extractedObservations: [] };
}

function dispatchOn(session, name, input) {
  const writes = createPerTurnWrites();
  const d = createWriteDispatcher(session, mockLogger(), 'turn-1', writes);
  return d({ tool_call_id: `tu_${name}`, name, input }, {}).then((result) => ({ result, writes }));
}

function errorCodeOf(result) {
  return JSON.parse(result.content).error?.code;
}

// ---------------------------------------------------------------------------
// (1) A MATCHING off-schema board_id is still accepted — the server-authored
//     clarification-answer path. This is the production regression risk.
// ---------------------------------------------------------------------------

describe('matching off-schema board_id is still accepted and still writes', () => {
  test('record_reading: board_id === currentBoardId writes to the sub-board bucket', async () => {
    const session = makeSubActiveSession();
    const { result } = await dispatchOn(session, 'record_reading', {
      field: 'measured_zs_ohm',
      circuit: 1,
      value: '0.18',
      confidence: 0.95,
      source_turn_id: 'turn-1',
      board_id: 'sub-1',
    });

    expect(result.is_error).toBe(false);
    expect(session.stateSnapshot.circuits['sub-1::1'].measured_zs_ohm).toBe('0.18');
    // The main-board namespace must not be touched.
    expect(session.stateSnapshot.circuits[1]).not.toHaveProperty('measured_zs_ohm');
  });

  test('clear_reading: board_id === currentBoardId clears on the sub-board', async () => {
    const session = makeSubActiveSession();
    session.stateSnapshot.circuits['sub-1::1'].measured_zs_ohm = '0.18';

    const { result } = await dispatchOn(session, 'clear_reading', {
      field: 'measured_zs_ohm',
      circuit: 1,
      reason: 'misheard',
      board_id: 'sub-1',
    });

    expect(result.is_error).toBe(false);
    expect(session.stateSnapshot.circuits['sub-1::1'].measured_zs_ohm).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (2) A MISMATCHING off-schema board_id still rejects wrong_board, on every
//     one of the five, with the snapshot untouched. Removing the property
//     from the schema does not remove the backstop.
// ---------------------------------------------------------------------------

describe('mismatching off-schema board_id still rejects wrong_board', () => {
  // The main board's id is assigned by ensureMultiBoardShape; each case
  // targets it explicitly while sub-1 is active, which is the cross-board
  // shape validateBoardScope exists to refuse.
  function mainIdOf(session) {
    const main = session.stateSnapshot.boards.find((b) => b.id !== 'sub-1');
    return main.id;
  }

  test('record_reading: cross-board board_id rejects and writes nothing', async () => {
    const session = makeSubActiveSession();
    const { result, writes } = await dispatchOn(session, 'record_reading', {
      field: 'measured_zs_ohm',
      circuit: 1,
      value: '0.18',
      confidence: 0.95,
      source_turn_id: 'turn-1',
      board_id: mainIdOf(session),
    });

    expect(result.is_error).toBe(true);
    expect(errorCodeOf(result)).toBe('wrong_board');
    expect(session.stateSnapshot.circuits[1]).not.toHaveProperty('measured_zs_ohm');
    expect(session.stateSnapshot.circuits['sub-1::1']).not.toHaveProperty('measured_zs_ohm');
    expect(writes.applied?.length ?? 0).toBe(0);
  });

  test('clear_reading: cross-board board_id rejects before mutation', async () => {
    const session = makeSubActiveSession();
    session.stateSnapshot.circuits[1].measured_zs_ohm = '0.44';

    const { result } = await dispatchOn(session, 'clear_reading', {
      field: 'measured_zs_ohm',
      circuit: 1,
      reason: 'misheard',
      board_id: mainIdOf(session),
    });

    expect(result.is_error).toBe(true);
    expect(errorCodeOf(result)).toBe('wrong_board');
    expect(session.stateSnapshot.circuits[1].measured_zs_ohm).toBe('0.44');
  });

  test('create_circuit: cross-board board_id rejects and creates nothing', async () => {
    const session = makeSubActiveSession();
    const before = Object.keys(session.stateSnapshot.circuits).length;

    const { result } = await dispatchOn(session, 'create_circuit', {
      circuit_ref: 9,
      board_id: mainIdOf(session),
    });

    expect(result.is_error).toBe(true);
    expect(errorCodeOf(result)).toBe('wrong_board');
    expect(Object.keys(session.stateSnapshot.circuits).length).toBe(before);
  });

  test('rename_circuit: cross-board board_id rejects and renames nothing', async () => {
    const session = makeSubActiveSession();

    const { result } = await dispatchOn(session, 'rename_circuit', {
      from_ref: 1,
      circuit_ref: 7,
      board_id: mainIdOf(session),
    });

    expect(result.is_error).toBe(true);
    expect(errorCodeOf(result)).toBe('wrong_board');
    expect(session.stateSnapshot.circuits['sub-1::1']).toBeDefined();
    expect(session.stateSnapshot.circuits['sub-1::7']).toBeUndefined();
  });

  test('delete_circuit: cross-board board_id rejects and deletes nothing', async () => {
    const session = makeSubActiveSession();

    const { result } = await dispatchOn(session, 'delete_circuit', {
      circuit_ref: 1,
      board_id: mainIdOf(session),
    });

    expect(result.is_error).toBe(true);
    expect(errorCodeOf(result)).toBe('wrong_board');
    expect(session.stateSnapshot.circuits['sub-1::1']).toBeDefined();
    expect(session.stateSnapshot.circuits[1]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// (3) Absent board_id — the shape the model is now steered to emit — scopes
//     to currentBoardId, which is the whole point of removing the parameter.
// ---------------------------------------------------------------------------

describe('absent board_id scopes to currentBoardId', () => {
  test('record_reading with no board_id writes to the active sub-board', async () => {
    const session = makeSubActiveSession();
    const { result } = await dispatchOn(session, 'record_reading', {
      field: 'measured_zs_ohm',
      circuit: 1,
      value: '0.18',
      confidence: 0.95,
      source_turn_id: 'turn-1',
    });

    expect(result.is_error).toBe(false);
    expect(session.stateSnapshot.circuits['sub-1::1'].measured_zs_ohm).toBe('0.18');
    expect(session.stateSnapshot.circuits[1]).not.toHaveProperty('measured_zs_ohm');
  });
});
