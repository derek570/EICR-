/**
 * A01P (2026-09-08) — model-initiated `calculate_zs` / `calculate_r1_plus_r2`
 * distinguish a RECORDED-but-unusable Ze (LIM, N/A, non-scalar) from an
 * ABSENT one. Pre-fix `resolveBoardAwareZe` collapsed both into `no_ze`, so
 * the model narrated "Ze is missing" to an inspector who had dictated a
 * limitation minutes earlier (feedback: Ze corrections and client-name
 * answers must stay consistent).
 *
 * Contract pinned here:
 *   - `ze_unreadable` when the HIGHEST OCCUPIED ladder source is non-finite;
 *     precedence-first, parse-once, never fall through to a lower source.
 *   - `no_ze` only when EVERY ladder source is blank.
 *   - `calculate_r1_plus_r2 {method:'zs_minus_ze'}` mirrors both.
 *   - `ring_continuity` never consults Ze — computes with LIM AND with absent.
 *   - A skip never mutates a reading (zero per-turn writes, snapshot unchanged).
 *
 * `[invariant]` = A01P-owned behaviour (red on the original backend);
 * `[current_behaviour]` = pinned so A01 can adjudicate deliberately.
 */

import { jest } from '@jest/globals';
import {
  dispatchCalculateZs,
  dispatchCalculateR1PlusR2,
} from '../extraction/stage6-dispatchers-circuit.js';
import {
  createPerTurnWrites,
  projectReadingWinners,
} from '../extraction/stage6-per-turn-writes.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeCtx(snapshot) {
  const session = { sessionId: 'a01p-calc', toolCallsMode: 'live', stateSnapshot: snapshot };
  return {
    session,
    logger: mockLogger(),
    turnId: 't1',
    perTurnWrites: createPerTurnWrites(),
    round: 0,
  };
}

async function zs(snapshot, input) {
  const ctx = makeCtx(snapshot);
  const before = JSON.stringify(snapshot);
  const res = await dispatchCalculateZs(
    { tool_call_id: 'tu_zs', name: 'calculate_zs', input },
    ctx
  );
  return { body: JSON.parse(res.content), ctx, before };
}

async function r1r2(snapshot, input) {
  const ctx = makeCtx(snapshot);
  const before = JSON.stringify(snapshot);
  const res = await dispatchCalculateR1PlusR2(
    { tool_call_id: 'tu_r1r2', name: 'calculate_r1_plus_r2', input },
    ctx
  );
  return { body: JSON.parse(res.content), ctx, before };
}

function expectNoMutation({ ctx, before }) {
  expect(JSON.stringify(ctx.session.stateSnapshot)).toBe(before);
  expect(projectReadingWinners(ctx.perTurnWrites)).toEqual([]);
}

const MAIN = [{ id: 'main', board_type: 'main' }];

describe('[invariant] calculate_zs — LIM in the highest occupied source is ze_unreadable, never no_ze', () => {
  test('main board-local `ze` LIM with a FINITE supply Ze below it → ze_unreadable, zero mutation', async () => {
    const out = await zs(
      {
        boards: MAIN,
        circuits: {
          0: { ze: 'LIM', earth_loop_impedance_ze: '0.50' },
          1: { r1_r2_ohm: '0.20' },
        },
      },
      { circuit_ref: 1, all: false }
    );
    expect(out.body.computed).toEqual([]);
    expect(out.body.skipped).toEqual([{ circuit_ref: 1, reason: 'ze_unreadable' }]);
    expectNoMutation(out);
  });

  test('main at-DB `ze_at_db` N/A (short and long Ze absent) → ze_unreadable, not no_ze', async () => {
    const out = await zs(
      {
        boards: [{ id: 'main', board_type: 'main', ze_at_db: 'N/A' }],
        circuits: { 0: {}, 1: { r1_r2_ohm: '0.20' } },
      },
      { circuit_ref: 1, all: false }
    );
    expect(out.body.skipped).toEqual([{ circuit_ref: 1, reason: 'ze_unreadable' }]);
    expectNoMutation(out);
  });

  test('supply-tier LIM (no board-local value anywhere) → ze_unreadable', async () => {
    const out = await zs(
      {
        boards: MAIN,
        circuits: { 0: { earth_loop_impedance_ze: 'LIM' }, 1: { r1_r2_ohm: '0.20' } },
      },
      { circuit_ref: 1, all: false }
    );
    expect(out.body.skipped).toEqual([{ circuit_ref: 1, reason: 'ze_unreadable' }]);
    expectNoMutation(out);
  });

  test('sub-board LIM with a finite origin supply Ze → ze_unreadable (no fall-through to origin)', async () => {
    const out = await zs(
      {
        currentBoardId: 'b2',
        boards: [...MAIN, { id: 'b2', board_type: 'sub', ze: 'LIM' }],
        circuits: {
          0: { earth_loop_impedance_ze: '0.30' },
          'b2::4': { circuit: 4, board_id: 'b2', r1_r2_ohm: '0.20' },
        },
      },
      { circuit_ref: 4, all: false, board_id: 'b2' }
    );
    expect(out.body.skipped).toEqual([{ circuit_ref: 4, reason: 'ze_unreadable' }]);
    expectNoMutation(out);
  });

  test('a fully ABSENT ladder is still no_ze (control)', async () => {
    const out = await zs(
      { boards: MAIN, circuits: { 0: {}, 1: { r1_r2_ohm: '0.20' } } },
      { circuit_ref: 1, all: false }
    );
    expect(out.body.skipped).toEqual([{ circuit_ref: 1, reason: 'no_ze' }]);
    expectNoMutation(out);
  });

  test('whitespace-only sources count as absent (no_ze), a LIM further down the ladder still wins as unreadable', async () => {
    const out = await zs(
      {
        boards: [{ id: 'main', board_type: 'main', ze: '   ' }],
        circuits: { 0: { earth_loop_impedance_ze: 'N/A' }, 1: { r1_r2_ohm: '0.20' } },
      },
      { circuit_ref: 1, all: false }
    );
    expect(out.body.skipped).toEqual([{ circuit_ref: 1, reason: 'ze_unreadable' }]);
  });
});

describe('[invariant] calculate_r1_plus_r2 — zs_minus_ze mirrors the Ze states; ring_continuity ignores Ze', () => {
  test('zs_minus_ze with LIM in the highest occupied source → ze_unreadable, zero mutation', async () => {
    const out = await r1r2(
      {
        boards: MAIN,
        circuits: {
          0: { ze: 'LIM', earth_loop_impedance_ze: '0.50' },
          1: { measured_zs_ohm: '0.70' },
        },
      },
      { method: 'zs_minus_ze', circuit_ref: 1, all: false }
    );
    expect(out.body.computed).toEqual([]);
    expect(out.body.skipped).toEqual([{ circuit_ref: 1, reason: 'ze_unreadable' }]);
    expectNoMutation(out);
  });

  test('zs_minus_ze with a fully absent ladder → no_ze (control)', async () => {
    const out = await r1r2(
      { boards: MAIN, circuits: { 0: {}, 1: { measured_zs_ohm: '0.70' } } },
      { method: 'zs_minus_ze', circuit_ref: 1, all: false }
    );
    expect(out.body.skipped).toEqual([{ circuit_ref: 1, reason: 'no_ze' }]);
    expectNoMutation(out);
  });

  test('[current_behaviour] ring_continuity still computes with a LIM Ze', async () => {
    const out = await r1r2(
      {
        boards: MAIN,
        circuits: { 0: { ze: 'LIM' }, 1: { ring_r1_ohm: '0.40', ring_r2_ohm: '0.40' } },
      },
      { method: 'ring_continuity', circuit_ref: 1, all: false }
    );
    expect(out.body.skipped).toEqual([]);
    expect(out.body.computed).toEqual([
      { circuit_ref: 1, field: 'r1_r2_ohm', method: 'ring_continuity', value: '0.20' },
    ]);
  });

  test('[current_behaviour] ring_continuity still computes with an absent Ze', async () => {
    const out = await r1r2(
      { boards: MAIN, circuits: { 0: {}, 1: { ring_r1_ohm: '0.40', ring_r2_ohm: '0.40' } } },
      { method: 'ring_continuity', circuit_ref: 1, all: false }
    );
    expect(out.body.skipped).toEqual([]);
    expect(out.body.computed).toEqual([
      { circuit_ref: 1, field: 'r1_r2_ohm', method: 'ring_continuity', value: '0.20' },
    ]);
  });
});

describe('[current_behaviour] hydrated alias conflict precedence (A01-adjudicable)', () => {
  test('main circuits[0] {ze:0.35, earth_loop_impedance_ze:0.50}, no board override, R1+R2 0.20 → 0.55 (short board-local key wins over origin)', async () => {
    const out = await zs(
      {
        boards: MAIN,
        circuits: {
          0: { ze: '0.35', earth_loop_impedance_ze: '0.50' },
          1: { r1_r2_ohm: '0.20' },
        },
      },
      { circuit_ref: 1, all: false }
    );
    expect(out.body.computed).toEqual([
      { circuit_ref: 1, field: 'measured_zs_ohm', value: '0.55' },
    ]);
  });

  test('first LONG-form main Ze leaves the short alias absent: at-DB 0.60 + R1+R2 0.20 stays 0.80', async () => {
    const out = await zs(
      {
        boards: [{ id: 'main', board_type: 'main', ze_at_db: '0.60' }],
        circuits: { 0: { earth_loop_impedance_ze: '0.50' }, 1: { r1_r2_ohm: '0.20' } },
      },
      { circuit_ref: 1, all: false }
    );
    expect(out.body.computed).toEqual([
      { circuit_ref: 1, field: 'measured_zs_ohm', value: '0.80' },
    ]);
  });
});
