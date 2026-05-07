/**
 * Stage 6 multi-board sprint Phase 6.5 — board_id schema thread-through
 * for the calc + sweep tools.
 *
 * Pins the new optional board_id property on calculate_zs,
 * calculate_r1_plus_r2, and set_field_for_all_circuits. Behaviour-side
 * tests exercise the explicit-board_id path under STAGE6_MULTI_BOARD=true,
 * including the `'*'` cross-board sweep on set_field_for_all_circuits.
 *
 * Slice 6.5 SCHEMA + DISPATCHER deltas:
 *   - calculate_zs / calculate_r1_plus_r2: thread input.board_id through
 *     selectorRefs (listCircuitRefsInBoard) and getCircuitBucket.
 *   - set_field_for_all_circuits: same thread-through, plus a special-case
 *     handler when board_id === '*' that walks every (board, ref) tuple.
 *     applied[] entries gain a board_id field on cross-board sweeps so
 *     Sonnet can read back which board each write landed on.
 */

import { jest } from '@jest/globals';
import { getToolByName } from '../extraction/stage6-tool-schemas.js';
import { createWriteDispatcher } from '../extraction/stage6-dispatchers.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';
import { ensureMultiBoardShape } from '../extraction/stage6-multi-board-shape.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

beforeEach(() => {
  delete process.env.STAGE6_MULTI_BOARD;
});
afterEach(() => {
  delete process.env.STAGE6_MULTI_BOARD;
});

const SCHEMA_PINS = ['calculate_zs', 'calculate_r1_plus_r2', 'set_field_for_all_circuits'];

describe('board_id schema thread-through (calc + sweep tools)', () => {
  test.each(SCHEMA_PINS)('%s exposes board_id as optional string', (toolName) => {
    const tool = getToolByName(toolName);
    expect(tool).toBeDefined();
    expect(tool.input_schema.properties.board_id).toBeDefined();
    expect(tool.input_schema.properties.board_id.type).toBe('string');
    expect(tool.input_schema.required).not.toContain('board_id');
  });

  test('set_field_for_all_circuits.board_id description mentions the "*" cross-board sweep contract', () => {
    // The description carries the only signal Sonnet has that '*' is
    // accepted; the schema can't enforce membership without an enum.
    const tool = getToolByName('set_field_for_all_circuits');
    expect(tool.input_schema.properties.board_id.description).toMatch(/\*/);
  });
});

// ---------------------------------------------------------------------------
// Behaviour: calc tools scope to board_id when supplied; otherwise default
// to currentBoardId.
// ---------------------------------------------------------------------------

function makeMultiBoardSession() {
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
  return { sessionId: 's-calc-thread', stateSnapshot: snapshot, extractedObservations: [] };
}

describe('calculate_zs: explicit board_id scopes the iteration (flag-on)', () => {
  beforeEach(() => {
    process.env.STAGE6_MULTI_BOARD = 'true';
  });

  test('all=true with board_id="sub-1" computes Zs only on sub-1 circuits', async () => {
    const session = makeMultiBoardSession();
    // Board-level Ze on circuits[0] (legacy supply bucket) — shared across
    // boards because Ze is an installation-level reading.
    session.stateSnapshot.circuits[0] = { earth_loop_impedance_ze: '0.30' };
    // Seed circuits on both boards with R1+R2 set so Zs can be computed.
    session.stateSnapshot.circuits['main::1'] = {
      circuit: 1,
      board_id: 'main',
      r1_r2_ohm: '0.10',
    };
    session.stateSnapshot.circuits['sub-1::1'] = {
      circuit: 1,
      board_id: 'sub-1',
      r1_r2_ohm: '0.20',
    };

    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 't1', writes);
    const res = await d(
      {
        tool_call_id: 'tu_calc_sub',
        name: 'calculate_zs',
        input: { all: true, board_id: 'sub-1' },
      },
      {}
    );
    expect(res.is_error).toBe(false);
    const body = JSON.parse(res.content);
    expect(body.ok).toBe(true);
    // Only sub-1::1 should have been computed; main::1 is invisible to the
    // selector under explicit board_id='sub-1'.
    expect(body.computed).toEqual([{ circuit_ref: 1, field: 'measured_zs_ohm', value: '0.50' }]);
    expect(session.stateSnapshot.circuits['sub-1::1'].measured_zs_ohm).toBe('0.50');
    expect(session.stateSnapshot.circuits['main::1']).not.toHaveProperty('measured_zs_ohm');
  });
});

describe('calculate_r1_plus_r2: explicit board_id scopes the iteration (flag-on)', () => {
  beforeEach(() => {
    process.env.STAGE6_MULTI_BOARD = 'true';
  });

  test('all=true + zs_minus_ze + board_id="sub-1" computes R1+R2 only on sub-1 circuits', async () => {
    const session = makeMultiBoardSession();
    session.stateSnapshot.circuits[0] = { earth_loop_impedance_ze: '0.30' };
    session.stateSnapshot.circuits['main::1'] = {
      circuit: 1,
      board_id: 'main',
      measured_zs_ohm: '0.40',
    };
    session.stateSnapshot.circuits['sub-1::1'] = {
      circuit: 1,
      board_id: 'sub-1',
      measured_zs_ohm: '0.50',
    };

    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 't1', writes);
    const res = await d(
      {
        tool_call_id: 'tu_r1r2_sub',
        name: 'calculate_r1_plus_r2',
        input: { method: 'zs_minus_ze', all: true, board_id: 'sub-1' },
      },
      {}
    );
    expect(res.is_error).toBe(false);
    const body = JSON.parse(res.content);
    // calculate_r1_plus_r2's computed entries carry a `method` annotation
    // alongside the standard {circuit_ref, field, value} so Sonnet can
    // disambiguate the two methods in a mixed-method response.
    expect(body.computed).toEqual([
      { circuit_ref: 1, field: 'r1_r2_ohm', value: '0.20', method: 'zs_minus_ze' },
    ]);
    expect(session.stateSnapshot.circuits['sub-1::1'].r1_r2_ohm).toBe('0.20');
    expect(session.stateSnapshot.circuits['main::1']).not.toHaveProperty('r1_r2_ohm');
  });
});

// ---------------------------------------------------------------------------
// Behaviour: set_field_for_all_circuits. Default current-board-only;
// explicit board_id scopes; '*' walks every board.
// ---------------------------------------------------------------------------

describe('set_field_for_all_circuits: board_id thread-through + cross-board sweep (flag-on)', () => {
  beforeEach(() => {
    process.env.STAGE6_MULTI_BOARD = 'true';
  });

  test('default (no board_id): writes to currentBoardId circuits only', async () => {
    const session = makeMultiBoardSession();
    session.stateSnapshot.currentBoardId = 'main';
    session.stateSnapshot.circuits['main::1'] = {
      circuit: 1,
      board_id: 'main',
      circuit_designation: 'Lights',
    };
    session.stateSnapshot.circuits['sub-1::1'] = {
      circuit: 1,
      board_id: 'sub-1',
      circuit_designation: 'Garage lights',
    };

    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 't1', writes);
    const res = await d(
      {
        tool_call_id: 'tu_default_scope',
        name: 'set_field_for_all_circuits',
        input: {
          field: 'measured_zs_ohm',
          value: '0.99',
          confidence: 1.0,
          source_turn_id: 't1',
        },
      },
      {}
    );
    expect(res.is_error).toBe(false);
    const body = JSON.parse(res.content);
    expect(body.applied).toEqual([{ circuit: 1, field: 'measured_zs_ohm', value: '0.99' }]);
    expect(session.stateSnapshot.circuits['main::1'].measured_zs_ohm).toBe('0.99');
    expect(session.stateSnapshot.circuits['sub-1::1']).not.toHaveProperty('measured_zs_ohm');
  });

  test('explicit board_id="sub-1": writes to sub-1 circuits only (NOT current main)', async () => {
    const session = makeMultiBoardSession();
    session.stateSnapshot.currentBoardId = 'main';
    session.stateSnapshot.circuits['main::1'] = {
      circuit: 1,
      board_id: 'main',
      circuit_designation: 'A',
    };
    session.stateSnapshot.circuits['sub-1::1'] = {
      circuit: 1,
      board_id: 'sub-1',
      circuit_designation: 'B',
    };

    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 't1', writes);
    const res = await d(
      {
        tool_call_id: 'tu_sub_scope',
        name: 'set_field_for_all_circuits',
        input: {
          field: 'measured_zs_ohm',
          value: '0.99',
          confidence: 1.0,
          source_turn_id: 't1',
          board_id: 'sub-1',
        },
      },
      {}
    );
    expect(res.is_error).toBe(false);
    expect(session.stateSnapshot.circuits['sub-1::1'].measured_zs_ohm).toBe('0.99');
    expect(session.stateSnapshot.circuits['main::1']).not.toHaveProperty('measured_zs_ohm');
  });

  test('board_id="*": writes to every board\'s circuits; applied[] carries board_id annotations', async () => {
    const session = makeMultiBoardSession();
    session.stateSnapshot.currentBoardId = 'main';
    session.stateSnapshot.circuits['main::1'] = {
      circuit: 1,
      board_id: 'main',
      circuit_designation: 'Lights',
    };
    session.stateSnapshot.circuits['main::2'] = {
      circuit: 2,
      board_id: 'main',
      circuit_designation: 'Sockets',
    };
    session.stateSnapshot.circuits['sub-1::1'] = {
      circuit: 1,
      board_id: 'sub-1',
      circuit_designation: 'Garage lights',
    };

    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 't1', writes);
    const res = await d(
      {
        tool_call_id: 'tu_cross',
        name: 'set_field_for_all_circuits',
        input: {
          field: 'measured_zs_ohm',
          value: '0.77',
          confidence: 1.0,
          source_turn_id: 't1',
          board_id: '*',
        },
      },
      {}
    );
    expect(res.is_error).toBe(false);
    const body = JSON.parse(res.content);
    // Three writes total — main::1, main::2, sub-1::1.
    expect(body.applied).toHaveLength(3);
    // applied[] carries board_id under cross-board sweep so Sonnet can
    // read back which board each write landed on.
    const sortedApplied = [...body.applied].sort((a, b) => {
      if (a.board_id !== b.board_id) return a.board_id < b.board_id ? -1 : 1;
      return a.circuit - b.circuit;
    });
    expect(sortedApplied).toEqual([
      { circuit: 1, board_id: 'main', field: 'measured_zs_ohm', value: '0.77' },
      { circuit: 2, board_id: 'main', field: 'measured_zs_ohm', value: '0.77' },
      { circuit: 1, board_id: 'sub-1', field: 'measured_zs_ohm', value: '0.77' },
    ]);
    // Snapshot reflects the cross-board mutation.
    expect(session.stateSnapshot.circuits['main::1'].measured_zs_ohm).toBe('0.77');
    expect(session.stateSnapshot.circuits['main::2'].measured_zs_ohm).toBe('0.77');
    expect(session.stateSnapshot.circuits['sub-1::1'].measured_zs_ohm).toBe('0.77');
  });

  test('single-board response shape stays byte-identical (no board_id key) for non-cross-board calls', async () => {
    // Pre-Phase-6.5 callers + iOS decoders must not see a new field on
    // applied[]. Only the explicit '*' sweep tags board_id.
    const session = makeMultiBoardSession();
    session.stateSnapshot.circuits['main::1'] = {
      circuit: 1,
      board_id: 'main',
      circuit_designation: 'Lights',
    };
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 't1', writes);
    const res = await d(
      {
        tool_call_id: 'tu_no_starscope',
        name: 'set_field_for_all_circuits',
        input: {
          field: 'measured_zs_ohm',
          value: '0.55',
          confidence: 1.0,
          source_turn_id: 't1',
        },
      },
      {}
    );
    const body = JSON.parse(res.content);
    expect(body.applied).toEqual([{ circuit: 1, field: 'measured_zs_ohm', value: '0.55' }]);
    // Explicitly assert no board_id property leaked.
    expect(body.applied[0]).not.toHaveProperty('board_id');
  });
});
