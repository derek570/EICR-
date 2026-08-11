/**
 * Plan 08B — `board_id: '*'` is rejected on BOTH calculators, and rejecting
 * it mutates nothing.
 *
 * WHY THIS SUITE EXISTS: commit 2 adds prose to the two calculator schema
 * descriptions asserting that '*' is not accepted, and commit 3 says the same
 * thing in the system prompt. Prose that documents a runtime behaviour has to
 * be pinned to that behaviour, or the two drift — which is the exact defect
 * Plan 08B was written to fix, one layer down (a prompt saying "never" beside
 * a schema saying "optional"). This suite is the runtime anchor those two
 * text edits describe, so the pin and the prose revert as one unit.
 *
 * WHAT IT DOES NOT PROVE: it passes identically before and after the text
 * edits — `validateCalculateBoardTarget` has returned
 * `board_id_star_unsupported` since the F/U-4 wave. A6b (schema) and A6a
 * (prompt) are what prove the wording landed. This row proves only that the
 * wording is TRUE, and stays true.
 *
 * DELIBERATELY NOT ASSERTED — spoken output. The rejection is silent today.
 * That is a real audibility gap, and Plan 08E owns closing it; asserting
 * silence here would pin the gap shut and make 08E's change look like a
 * regression. See the 08B plan, "What this plan is NOT".
 *
 * BOTH calculators, not just the observed one: the field incident involved
 * `calculate_zs`, and pinning only the tool that happened to fail is how the
 * sibling gets missed — the same reasoning A6b applies to the descriptions.
 */

import { jest } from '@jest/globals';
import { createWriteDispatcher } from '../extraction/stage6-dispatchers.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';
import { ensureMultiBoardShape } from '../extraction/stage6-multi-board-shape.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

/**
 * Two boards, each with a circuit that has everything the calc needs. The
 * seeding matters: if '*' were silently accepted (or silently treated as
 * "current board"), these circuits WOULD compute — so "mutates nothing" is
 * a real assertion here rather than a vacuous one over an empty snapshot.
 */
function makeCalcReadySession() {
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
  // Installation-level Ze on the legacy supply bucket, shared across boards.
  snapshot.circuits[0] = { earth_loop_impedance_ze: '0.30' };
  // R1+R2 present → calculate_zs can compute; measured Zs present → the
  // zs_minus_ze method of calculate_r1_plus_r2 can compute.
  snapshot.circuits['main::1'] = { circuit: 1, board_id: 'main', r1_r2_ohm: '0.10' };
  snapshot.circuits['sub-1::1'] = { circuit: 1, board_id: 'sub-1', r1_r2_ohm: '0.20' };
  snapshot.circuits['main::2'] = { circuit: 2, board_id: 'main', measured_zs_ohm: '0.55' };
  snapshot.circuits['sub-1::2'] = { circuit: 2, board_id: 'sub-1', measured_zs_ohm: '0.75' };
  return { sessionId: 's-08b-star', stateSnapshot: snapshot, extractedObservations: [] };
}

function snapshotOfComputedFields(session) {
  const { circuits } = session.stateSnapshot;
  return {
    'main::1.zs': circuits['main::1'].measured_zs_ohm,
    'sub-1::1.zs': circuits['sub-1::1'].measured_zs_ohm,
    'main::2.r1r2': circuits['main::2'].r1_r2_ohm,
    'sub-1::2.r1r2': circuits['sub-1::2'].r1_r2_ohm,
  };
}

const CALC_CALLS = [
  ['calculate_zs', { all: true, board_id: '*' }],
  ['calculate_r1_plus_r2', { all: true, method: 'zs_minus_ze', board_id: '*' }],
];

describe("board_id '*' is rejected on the calculators", () => {
  test.each(CALC_CALLS)('%s rejects board_id_star_unsupported', async (name, input) => {
    const session = makeCalcReadySession();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 'turn-1', writes);

    const res = await d({ tool_call_id: `tu_${name}_star`, name, input }, {});

    expect(res.is_error).toBe(true);
    const body = JSON.parse(res.content);
    expect(body.error.code).toBe('board_id_star_unsupported');
    expect(body.error.field).toBe('board_id');
  });

  test.each(CALC_CALLS)('%s with board_id="*" mutates nothing', async (name, input) => {
    const session = makeCalcReadySession();
    const before = snapshotOfComputedFields(session);
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 'turn-1', writes);

    await d({ tool_call_id: `tu_${name}_star_nomutate`, name, input }, {});

    // Every destination field is exactly as it was — on BOTH boards, so a
    // '*' quietly collapsing to "just the current board" would also fail.
    expect(snapshotOfComputedFields(session)).toEqual(before);
    expect(before['main::1.zs']).toBeUndefined();
    expect(before['sub-1::1.zs']).toBeUndefined();
    expect(before['main::2.r1r2']).toBeUndefined();
    expect(before['sub-1::2.r1r2']).toBeUndefined();
  });

  test.each(CALC_CALLS)(
    '%s: the SAME call with a real board id computes (the rejection is about the wildcard, not the selector)',
    async (name, input) => {
      const session = makeCalcReadySession();
      const writes = createPerTurnWrites();
      const d = createWriteDispatcher(session, mockLogger(), 'turn-1', writes);

      const res = await d(
        {
          tool_call_id: `tu_${name}_real`,
          name,
          input: { ...input, board_id: 'sub-1' },
        },
        {}
      );

      // Control case. Without it, the two assertions above would pass just as
      // happily if the selector were broken and these tools computed nothing
      // for any input at all.
      expect(res.is_error).toBe(false);
      const body = JSON.parse(res.content);
      expect(body.ok).toBe(true);
      expect(body.computed.length).toBeGreaterThan(0);
    }
  );
});
