/**
 * Stage 1a commit 1a.6 — field_corrected wire emission, end-to-end.
 *
 * Asserts the contract Claude v2 NB1 was about:
 *
 *   When dispatchClearReading successfully clears a populated slot, the
 *   bundled per-turn writes carry a `field_corrected` entry, the
 *   bundler exposes it as result.field_corrections, and the orchestrator
 *   emits one WS envelope per entry with the snake_case wire shape that
 *   iOS Stage6Messages.swift already decodes.
 *
 * We exercise the dispatcher + bundler pieces directly (small, fast).
 * The orchestrator's emission step is covered indirectly here by
 * asserting the bundler output shape — see the transcript-replay
 * harness's stage1a protocol/ scenario for the WS-level integration
 * check once Stage 1a verification gate runs.
 */

import { jest } from '@jest/globals';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';
import { dispatchClearReading } from '../extraction/stage6-dispatchers-circuit.js';
import { bundleToolCallsIntoResult } from '../extraction/stage6-event-bundler.js';

function makeCtx(snapshot, overrides = {}) {
  return {
    session: {
      sessionId: 'sess_test',
      stateSnapshot: snapshot,
    },
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    turnId: 'turn_test',
    perTurnWrites: createPerTurnWrites(),
    round: 1,
    ...overrides,
  };
}

describe('1a.6 dispatchClearReading → perTurnWrites.fieldCorrections', () => {
  test('successful clear pushes a wire-shaped field_corrected entry with previous_value', async () => {
    const snapshot = { circuits: { 3: { Ze_ohms: '0.42', Zs_ohms: '0.31' } } };
    const ctx = makeCtx(snapshot);
    const call = {
      tool_call_id: 'tc_1',
      name: 'clear_reading',
      input: { circuit: 3, field: 'Ze_ohms', reason: 'wrong_value' },
    };
    const env = await dispatchClearReading(call, ctx);
    // Envelope shape preserved.
    const parsed = JSON.parse(env.content ?? '{}');
    expect(parsed.ok).toBe(true);
    // Slot actually cleared.
    expect(snapshot.circuits[3]).toEqual({ Zs_ohms: '0.31' });
    // 1a.6: field_correction enqueued with pinned wire shape.
    expect(ctx.perTurnWrites.fieldCorrections).toEqual([
      {
        type: 'field_corrected',
        circuit: 3,
        field: 'Ze_ohms',
        previous_value: '0.42',
        reason: 'clear_reading',
        board_id: null,
      },
    ]);
  });

  test('noop clear (field not set) does NOT push a field_corrected entry', async () => {
    const snapshot = { circuits: { 3: { Zs_ohms: '0.43' } } };
    const ctx = makeCtx(snapshot);
    const call = {
      tool_call_id: 'tc_noop',
      name: 'clear_reading',
      input: { circuit: 3, field: 'Ze_ohms', reason: 'wrong_value' },
    };
    await dispatchClearReading(call, ctx);
    expect(ctx.perTurnWrites.fieldCorrections).toEqual([]);
  });

  test('rejected clear (validation error) does NOT push a field_corrected entry', async () => {
    const snapshot = { circuits: { 3: { Zs_ohms: '0.43' } } };
    const ctx = makeCtx(snapshot);
    const call = {
      tool_call_id: 'tc_rej',
      name: 'clear_reading',
      input: { circuit: 'not-a-number', field: 'Zs_ohms', reason: 'wrong_value' },
    };
    await dispatchClearReading(call, ctx);
    expect(ctx.perTurnWrites.fieldCorrections).toEqual([]);
  });

  test('stringifies non-string previous values (numeric, boolean)', async () => {
    const snapshot = { circuits: { 1: { polarity_confirmed: true, npts: 5 } } };
    const ctx = makeCtx(snapshot);
    await dispatchClearReading(
      {
        tool_call_id: 'tc_a',
        name: 'clear_reading',
        input: { circuit: 1, field: 'polarity_confirmed', reason: 'wrong_value' },
      },
      ctx
    );
    await dispatchClearReading(
      {
        tool_call_id: 'tc_b',
        name: 'clear_reading',
        input: { circuit: 1, field: 'npts', reason: 'wrong_value' },
      },
      ctx
    );
    expect(ctx.perTurnWrites.fieldCorrections.map((e) => e.previous_value)).toEqual(['true', '5']);
  });
});

describe('1a.6 bundleToolCallsIntoResult surfaces field_corrections', () => {
  test('result.field_corrections present when entries exist', () => {
    const perTurnWrites = createPerTurnWrites();
    perTurnWrites.fieldCorrections.push({
      type: 'field_corrected',
      circuit: 3,
      field: 'Ze_ohms',
      previous_value: '0.42',
      reason: 'clear_reading',
      board_id: null,
    });
    const result = bundleToolCallsIntoResult(perTurnWrites, {});
    expect(result.field_corrections).toEqual([
      {
        type: 'field_corrected',
        circuit: 3,
        field: 'Ze_ohms',
        previous_value: '0.42',
        reason: 'clear_reading',
        board_id: null,
      },
    ]);
  });

  test('result.field_corrections OMITTED when accumulator empty (back-compat)', () => {
    const perTurnWrites = createPerTurnWrites();
    const result = bundleToolCallsIntoResult(perTurnWrites, {});
    expect('field_corrections' in result).toBe(false);
  });
});
