/**
 * Stage 6 multi-board sprint Phase 6.6 — BOARD_OP_NAMES surface lock.
 *
 * Pins:
 *   1. The exported constant is exactly the 3 names shipped in slices 6.1
 *      / 6.2 / 6.3.
 *   2. The constant is frozen (Object.freeze) so it can't be mutated in
 *      place by a downstream caller.
 *   3. Every name in BOARD_OP_NAMES resolves to a dispatcher in the barrel
 *      WRITE_DISPATCHERS table — wires don't drift from the schema lock.
 *   4. Every dispatcher pointed at by BOARD_OP_NAMES emits the matching
 *      `op` discriminator on the boardOps wire channel — exercises the
 *      contract that the iOS receiver decodes against.
 *
 * Why this file (not extending an existing slice 6.x test): the
 * `BOARD_OP_NAMES` constant is the cross-slice surface; binding the
 * regression to a single dispatcher's test would obscure the cross-cut.
 * Adding a future board-shape tool then becomes a one-stop edit: append
 * to BOARD_OP_NAMES + emit on perTurnWrites.boardOps + the existing
 * dispatcher tests pin the new dispatcher's specifics. This file's
 * sweep then catches a missing barrel wire.
 */

import { jest } from '@jest/globals';
import { BOARD_OP_NAMES } from '../extraction/stage6-tool-schemas.js';
import { WRITE_DISPATCHERS, createWriteDispatcher } from '../extraction/stage6-dispatchers.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';
import { ensureMultiBoardShape } from '../extraction/stage6-multi-board-shape.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeSession() {
  const snapshot = {
    circuits: {},
    pending_readings: [],
    observations: [],
    validation_alerts: [],
  };
  ensureMultiBoardShape(snapshot);
  // Add a sub-board so select_board has somewhere to flip TO and
  // mark_distribution_circuit has a target. Seed circuit 4 on main so
  // mark_distribution_circuit's bucket lookup succeeds.
  snapshot.boards.push({
    id: 'sub-1',
    designation: 'Garage CU',
    board_type: 'sub_distribution',
  });
  snapshot.circuits[4] = { designation: 'Sub feed' };
  return { sessionId: 's-board-op-names', stateSnapshot: snapshot, extractedObservations: [] };
}

describe('BOARD_OP_NAMES surface lock', () => {
  test('exports exactly the 3 expected board-op names in stable order', () => {
    expect([...BOARD_OP_NAMES]).toEqual(['add_board', 'select_board', 'mark_distribution_circuit']);
  });

  test('is frozen — Object.freeze prevents .push()/.pop() mutation', () => {
    expect(Object.isFrozen(BOARD_OP_NAMES)).toBe(true);
    // Defensive: in strict mode, attempting to push throws TypeError.
    expect(() => BOARD_OP_NAMES.push('rogue_op')).toThrow();
  });

  test('every name resolves to a dispatcher via the barrel WRITE_DISPATCHERS table', () => {
    for (const name of BOARD_OP_NAMES) {
      expect(WRITE_DISPATCHERS[name]).toBeDefined();
      expect(typeof WRITE_DISPATCHERS[name]).toBe('function');
    }
  });

  // The minimum-valid input shape for each board-op tool. Used by the
  // wire-emit sweep below. Each input is sufficient to reach the success
  // path against a session shape from makeSession().
  const VALID_INPUTS_BY_NAME = {
    add_board: { designation: 'Garage CU 2', board_type: 'sub_distribution' },
    select_board: { board_id: 'sub-1' },
    mark_distribution_circuit: { circuit: 4, feeds_board_id: 'sub-1' },
  };

  test('every dispatcher in BOARD_OP_NAMES emits the matching `op` on perTurnWrites.boardOps', async () => {
    for (const name of BOARD_OP_NAMES) {
      const session = makeSession();
      const writes = createPerTurnWrites();
      const d = createWriteDispatcher(session, mockLogger(), 't1', writes);
      const res = await d(
        {
          tool_call_id: `tu_${name}`,
          name,
          input: VALID_INPUTS_BY_NAME[name],
        },
        {}
      );
      expect(res.is_error).toBe(false);
      expect(writes.boardOps).toHaveLength(1);
      expect(writes.boardOps[0].op).toBe(name);
    }
  });
});
