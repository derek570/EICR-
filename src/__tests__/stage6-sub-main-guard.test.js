/**
 * F1AC26FB #2.2 — sub_main_cable_csa dispatcher guard.
 *
 * "tails are 25mm" (the supply meter tails INTO the main board) belongs in
 * main_switch_conductor_csa. With no tails steering, Sonnet picked the key
 * whose label contains "cable" and wrote sub_main_cable_csa on a single-board
 * job (session F1AC26FB, single board 17D15991), where that field is
 * meaningless — it only describes the cable FEEDING a separate sub-main.
 *
 * The dispatcher now rejects sub_main_cable_csa when no sub-board exists,
 * redirecting the model to main_switch_conductor_csa. A real multi-board job
 * (a sub-board present) is left untouched.
 */
import { jest } from '@jest/globals';
import { createWriteDispatcher } from '../extraction/stage6-dispatchers.js';
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
  ensureMultiBoardShape(snapshot); // seeds a single 'main' board
  return { sessionId: 's-submain', stateSnapshot: snapshot, extractedObservations: [] };
}

async function dispatchBoardReading(session, writes, input, id = 'tu_sm') {
  const d = createWriteDispatcher(session, mockLogger(), 'turn-1', writes);
  return d(
    {
      tool_call_id: id,
      name: 'record_board_reading',
      input: { confidence: 0.95, source_turn_id: 't1', ...input },
    },
    {}
  );
}

describe('sub_main_cable_csa guard (no sub-board)', () => {
  test('rejected on a single-main-board job with a redirect hint', async () => {
    const session = makeSession();
    const writes = createPerTurnWrites();
    const result = await dispatchBoardReading(session, writes, {
      field: 'sub_main_cable_csa',
      value: '25',
    });
    expect(result.is_error).toBe(true);
    const body = JSON.parse(result.content);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('no_sub_board_for_sub_main');
    expect(body.error.hint).toMatch(/main_switch_conductor_csa/);
    // The bogus value never reached the snapshot.
    expect(session.stateSnapshot.circuits[0]?.sub_main_cable_csa).toBeUndefined();
  });

  test('the correct field (main_switch_conductor_csa) still writes fine', async () => {
    const session = makeSession();
    const writes = createPerTurnWrites();
    const result = await dispatchBoardReading(session, writes, {
      field: 'main_switch_conductor_csa',
      value: '25',
    });
    expect(result.is_error).toBe(false);
    expect(session.stateSnapshot.circuits[0].main_switch_conductor_csa).toBe('25');
  });

  test('allowed once a sub-board exists (real multi-board job untouched)', async () => {
    const session = makeSession();
    session.stateSnapshot.boards.push({ id: 'sub-1', board_type: 'sub', board_designation: 'DB-2' });
    const writes = createPerTurnWrites();
    const result = await dispatchBoardReading(session, writes, {
      field: 'sub_main_cable_csa',
      value: '16',
    });
    // Not rejected by the #2.2 guard (any downstream outcome is fine — the
    // guard specifically must NOT fire when a sub-board is present).
    if (result.is_error) {
      const body = JSON.parse(result.content);
      expect(body.error.code).not.toBe('no_sub_board_for_sub_main');
    } else {
      expect(result.is_error).toBe(false);
    }
  });
});
