/**
 * Stage 6 multi-board sprint Phase 6.4 — board_id schema thread-through
 * for the circuit-mutator tools.
 *
 * WHAT: Pins the new optional `board_id` property on the five circuit-
 * mutator tool schemas (record_reading, clear_reading, create_circuit,
 * rename_circuit, delete_circuit) so a future schema-rebase can't drop
 * the field silently. Slice 6.5 adds the same field to the calc / sweep
 * schemas (calculate_zs, calculate_r1_plus_r2, set_field_for_all_circuits)
 * with its own pins.
 *
 * Behaviour-side: also exercises the explicit-board_id end-to-end path
 * under STAGE6_MULTI_BOARD=true. Slice 5.2/5.3 already wired board_id
 * through validators + dispatchers; slice 6.4/6.5 just exposes the field
 * on the schema. The flag-on tests prove the schema field reaches the
 * mutator and the right composite-key bucket gets touched.
 *
 * NOTE: shape pins are flag-agnostic — they just check input_schema. The
 * end-to-end tests gate on STAGE6_MULTI_BOARD=true (default off) so the
 * legacy-numeric-key path stays the un-altered baseline for sessions
 * that pre-date Phase 6.
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

// ---------------------------------------------------------------------------
// Schema pin: every named tool exposes an optional board_id string property,
// and board_id is NEVER in the required list.
// ---------------------------------------------------------------------------

const SCHEMA_PINS = [
  'record_reading',
  'clear_reading',
  'create_circuit',
  'rename_circuit',
  'delete_circuit',
];

describe('board_id schema thread-through', () => {
  test.each(SCHEMA_PINS)('%s exposes board_id as optional string', (toolName) => {
    const tool = getToolByName(toolName);
    expect(tool).toBeDefined();
    expect(tool.input_schema.properties.board_id).toBeDefined();
    expect(tool.input_schema.properties.board_id.type).toBe('string');
    expect(tool.input_schema.required).not.toContain('board_id');
  });
});

// ---------------------------------------------------------------------------
// End-to-end behaviour: explicit board_id under flag-on routes to the
// composite-key bucket on the named board.
// ---------------------------------------------------------------------------

function makeMultiBoardSession() {
  const snapshot = {
    circuits: {},
    pending_readings: [],
    observations: [],
    validation_alerts: [],
  };
  ensureMultiBoardShape(snapshot);
  // Add a sub-board.
  snapshot.boards.push({
    id: 'sub-1',
    designation: 'Garage CU',
    board_type: 'sub_distribution',
  });
  return { sessionId: 's-thread', stateSnapshot: snapshot, extractedObservations: [] };
}

describe('explicit board_id routes to the named board bucket (flag-on)', () => {
  beforeEach(() => {
    process.env.STAGE6_MULTI_BOARD = 'true';
  });

  test('record_reading: explicit board_id="sub-1" writes to sub-1::3, not main::3', async () => {
    const session = makeMultiBoardSession();
    // Seed both composite-key buckets so both pass validator.
    session.stateSnapshot.circuits['main::3'] = { circuit: 3, board_id: 'main' };
    session.stateSnapshot.circuits['sub-1::3'] = { circuit: 3, board_id: 'sub-1' };

    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 't1', writes);
    const res = await d(
      {
        tool_call_id: 'tu_subscope',
        name: 'record_reading',
        input: {
          field: 'measured_zs_ohm',
          circuit: 3,
          value: '0.18',
          confidence: 0.95,
          source_turn_id: 't1',
          board_id: 'sub-1',
        },
      },
      {}
    );
    expect(res.is_error).toBe(false);
    expect(session.stateSnapshot.circuits['sub-1::3']).toMatchObject({
      circuit: 3,
      board_id: 'sub-1',
      measured_zs_ohm: '0.18',
    });
    // Main bucket untouched.
    expect(session.stateSnapshot.circuits['main::3']).not.toHaveProperty('measured_zs_ohm');
  });

  test('record_reading: missing board_id falls back to currentBoardId (back-compat)', async () => {
    const session = makeMultiBoardSession();
    session.stateSnapshot.currentBoardId = 'sub-1';
    session.stateSnapshot.circuits['sub-1::3'] = { circuit: 3, board_id: 'sub-1' };
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 't1', writes);
    const res = await d(
      {
        tool_call_id: 'tu_default',
        name: 'record_reading',
        input: {
          field: 'measured_zs_ohm',
          circuit: 3,
          value: '0.18',
          confidence: 0.95,
          source_turn_id: 't1',
        },
      },
      {}
    );
    expect(res.is_error).toBe(false);
    expect(session.stateSnapshot.circuits['sub-1::3'].measured_zs_ohm).toBe('0.18');
  });

  test('create_circuit + delete_circuit: explicit board_id scopes both write paths to the named board', async () => {
    const session = makeMultiBoardSession();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 't1', writes);

    // Create circuit 7 on sub-1 explicitly.
    const create = await d(
      {
        tool_call_id: 'tu_create',
        name: 'create_circuit',
        input: { circuit_ref: 7, designation: 'Sub-1 lights', board_id: 'sub-1' },
      },
      {}
    );
    expect(create.is_error).toBe(false);
    expect(session.stateSnapshot.circuits['sub-1::7']).toBeDefined();
    expect(session.stateSnapshot.circuits['main::7']).toBeUndefined();

    // Delete that bucket explicitly via board_id.
    const del = await d(
      {
        tool_call_id: 'tu_delete',
        name: 'delete_circuit',
        input: { circuit_ref: 7, board_id: 'sub-1' },
      },
      {}
    );
    expect(del.is_error).toBe(false);
    expect(session.stateSnapshot.circuits['sub-1::7']).toBeUndefined();
  });

  test('clear_reading: explicit board_id targets the right bucket', async () => {
    const session = makeMultiBoardSession();
    session.stateSnapshot.circuits['main::3'] = {
      circuit: 3,
      board_id: 'main',
      measured_zs_ohm: '0.42',
    };
    session.stateSnapshot.circuits['sub-1::3'] = {
      circuit: 3,
      board_id: 'sub-1',
      measured_zs_ohm: '0.18',
    };
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 't1', writes);
    const res = await d(
      {
        tool_call_id: 'tu_clear_sub',
        name: 'clear_reading',
        input: {
          field: 'measured_zs_ohm',
          circuit: 3,
          reason: 'user_correction',
          board_id: 'sub-1',
        },
      },
      {}
    );
    expect(res.is_error).toBe(false);
    expect(session.stateSnapshot.circuits['sub-1::3']).not.toHaveProperty('measured_zs_ohm');
    // Main bucket survives.
    expect(session.stateSnapshot.circuits['main::3'].measured_zs_ohm).toBe('0.42');
  });
});
