/**
 * Stage 6 multi-board sprint Phase 6.4 — board_id schema thread-through
 * for the circuit-mutator tools. POLARITY INVERTED 2026-08-11 (Plan 08B).
 *
 * WHAT (original, 2026-05-07): pinned the new optional `board_id` property
 * on the five circuit-mutator tool schemas (record_reading, clear_reading,
 * create_circuit, rename_circuit, delete_circuit) so a future schema-rebase
 * couldn't drop the field silently.
 *
 * WHAT NOW: pins that the same five schemas do NOT declare `board_id`. The
 * guard's PURPOSE is unchanged — stop a schema edit changing this field
 * without anyone noticing — only its polarity flipped, so it now guards
 * against an accidental RE-ADD. The file is deliberately not deleted: this
 * pin is what caught Plan 08B's own schema edit, and it is the only thing
 * standing between a future rebase and a silent restoration of the defect.
 *
 * WHY the polarity flipped: the Phase 6.4 capability was superseded by
 * `select_board`. The system prompt forbids passing `board_id` on these
 * five tools outright (sonnet_agentic_system.md), while the schema went on
 * offering the parameter — so the model was told "never" by the prompt and
 * "here you go, optional" by the schema. It filled it, twice in one turn,
 * and both calls were rejected `wrong_board`, costing two extraction rounds
 * in a live field session. Removing the affordance makes prompt and schema
 * agree. See `.planning/voice-latency-conversational-2026-07-31/`.
 *
 * NOT an enforcement boundary: `strict: true` is off (Bug-E, 2026-04-26 —
 * grammar compilation intermittently 503'd and hung the turn ~30s), so the
 * model CAN still emit an off-schema `board_id`. `validateBoardScope` is
 * what actually stops a wrong write, and it is untouched. This change lowers
 * the probability the model reaches for the parameter; it does not fence it.
 *
 * Behaviour-side: the second describe block below still exercises the
 * explicit-board_id end-to-end path via dual-shape routing (Phase A), and is
 * UNCHANGED. Dispatchers still read `input.board_id` — the server's own
 * answer-resolver authors `record_reading` writes carrying an explicit
 * board_id for sub-board clarification answers, and those must keep working.
 * If that block ever needs changing to accommodate a schema edit, the schema
 * edit is removing more than the model-facing affordance.
 */

import { jest } from '@jest/globals';
import { getToolByName } from '../extraction/stage6-tool-schemas.js';
import { createWriteDispatcher } from '../extraction/stage6-dispatchers.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';
import { ensureMultiBoardShape } from '../extraction/stage6-multi-board-shape.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

// ---------------------------------------------------------------------------
// Schema pin (INVERTED 2026-08-11, Plan 08B): none of the five current-board-
// only mutators declares board_id. They scope to currentBoardId; a genuine
// cross-board write goes through select_board first.
// ---------------------------------------------------------------------------

const SCHEMA_PINS = [
  'record_reading',
  'clear_reading',
  'create_circuit',
  'rename_circuit',
  'delete_circuit',
];

// Board scope stays declared on the tools that legitimately need it. Pinned
// alongside the removals so a future "tidy-up" can't over-apply Plan 08B and
// strip scope from the tools that genuinely take a board target.
const BOARD_SCOPE_RETAINED = [
  'calculate_zs',
  'calculate_r1_plus_r2',
  'set_field_for_all_circuits',
  'mark_distribution_circuit',
];

describe('board_id is absent from the current-board-only mutators', () => {
  test.each(SCHEMA_PINS)('%s does not declare board_id', (toolName) => {
    const tool = getToolByName(toolName);
    expect(tool).toBeDefined();
    expect(tool.input_schema.properties.board_id).toBeUndefined();
    expect(tool.input_schema.required).not.toContain('board_id');
  });

  test.each(BOARD_SCOPE_RETAINED)('%s still declares board_id', (toolName) => {
    const tool = getToolByName(toolName);
    expect(tool).toBeDefined();
    expect(tool.input_schema.properties.board_id).toBeDefined();
    expect(tool.input_schema.properties.board_id.type).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// End-to-end behaviour: explicit board_id under dual-shape routing routes
// to the composite-key bucket on the named board (any non-main target).
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

describe('explicit board_id routes to the named board bucket', () => {
  // 2026-05-08 "Work on Board" Phase B: explicit `board_id` is now ONLY
  // accepted when it matches `currentBoardId`. The schema thread-through
  // contract still applies (the field must reach the mutator and route to
  // the composite-key bucket), so each test below sets `currentBoardId` to
  // match the explicit `board_id` first. A separate Phase B suite
  // (`stage6-work-on-board-phase-b-scope.test.js`) pins the cross-board
  // rejection case.
  test('record_reading: explicit board_id="sub-1" while active writes to sub-1::3, not main::3', async () => {
    const session = makeMultiBoardSession();
    session.stateSnapshot.currentBoardId = 'sub-1';
    // Seed main at the legacy bare-numeric key (dual-shape main namespace)
    // and sub-1 at the composite key. Validator must accept circuit 3 on
    // sub-1 explicitly via the composite path.
    session.stateSnapshot.circuits[3] = {};
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
    // Main bucket (legacy namespace) untouched.
    expect(session.stateSnapshot.circuits[3]).not.toHaveProperty('measured_zs_ohm');
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
    // Phase B: currentBoardId must match the explicit board_id arg.
    session.stateSnapshot.currentBoardId = 'sub-1';
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
    // Phase B: currentBoardId must match the explicit board_id arg.
    session.stateSnapshot.currentBoardId = 'sub-1';
    // Main lives at the legacy bare-numeric key; sub-1 at the composite key.
    session.stateSnapshot.circuits[3] = { measured_zs_ohm: '0.42' };
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
    // Main bucket (legacy namespace) survives.
    expect(session.stateSnapshot.circuits[3].measured_zs_ohm).toBe('0.42');
  });
});
