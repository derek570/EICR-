/**
 * F1AC26FB #2.2 — sub_main_cable_csa dispatcher guard.
 *
 * "tails are 25mm" (the supply meter tails INTO the main board) belongs in
 * main_switch_conductor_csa. With no tails steering, Sonnet picked the key
 * whose label contains "cable" and wrote sub_main_cable_csa on a single-board
 * job (session F1AC26FB, single board 17D15991), where that field is
 * meaningless — it only describes the cable FEEDING a separate sub-main.
 *
 * PLAN-2D supersedes the board-count redirect: neither client has a safe live
 * route for any `sub_main_*` reading yet, even on a genuine multi-board job.
 * The dispatcher therefore fails closed under `client_route_unavailable` for
 * every board shape and the honest-refusal channel tells the inspector to use
 * the Board tab.
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

describe('sub_main_cable_csa client-route guard', () => {
  test('rejected on a single-main-board job before snapshot mutation', async () => {
    const session = makeSession();
    const writes = createPerTurnWrites();
    const result = await dispatchBoardReading(session, writes, {
      field: 'sub_main_cable_csa',
      value: '25',
    });
    expect(result.is_error).toBe(true);
    const body = JSON.parse(result.content);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('client_route_unavailable');
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

  test('remains rejected once a sub-board exists until both clients gain a safe route', async () => {
    const session = makeSession();
    session.stateSnapshot.boards.push({ id: 'sub-1', board_type: 'sub', board_designation: 'DB-2' });
    const writes = createPerTurnWrites();
    const result = await dispatchBoardReading(session, writes, {
      field: 'sub_main_cable_csa',
      value: '16',
    });
    expect(result.is_error).toBe(true);
    expect(JSON.parse(result.content).error.code).toBe('client_route_unavailable');
    expect(session.stateSnapshot.circuits[0]?.sub_main_cable_csa).toBeUndefined();
  });
});
