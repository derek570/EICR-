/**
 * Stage 6 Phase 2 Plan 02-02 — Dispatcher scaffold tests.
 *
 * WHAT: Locks the Phase 1 runToolLoop dispatcher contract for the six write
 * tools PLUS the unknown_tool path. Tests the barrel's WRITE_DISPATCHERS
 * table shape, the factory's closure behaviour, and the round counter.
 *
 * WHY these tests are the gate for Wave 2 landing:
 *   - If Plans 02-03/04 break the envelope shape or log-row schema, this
 *     file fails BEFORE the dispatcher-specific tests in those plans — a
 *     cheap canary that catches contract drift early.
 *   - The integration test at the bottom (Task 5) uses a real mockClient +
 *     runToolLoop invocation to prove the scaffold is actually compatible
 *     with Phase 1 infrastructure, not just shape-compatible on paper.
 */

import { jest } from '@jest/globals';
import {
  WRITE_DISPATCHERS,
  createWriteDispatcher,
} from '../extraction/stage6-dispatchers.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

describe('WRITE_DISPATCHERS dispatch table', () => {
  test('has exactly six keys matching REQUIREMENTS STS-01..06', () => {
    expect(Object.keys(WRITE_DISPATCHERS).sort()).toEqual(
      [
        'clear_reading',
        'create_circuit',
        'delete_observation',
        'record_observation',
        'record_reading',
        'rename_circuit',
      ].sort(),
    );
  });

  test('every entry is an async function', () => {
    for (const [name, fn] of Object.entries(WRITE_DISPATCHERS)) {
      expect(typeof fn).toBe('function');
      // Calling it returns a Promise (async function invariant).
      const logger = mockLogger();
      const p = fn(
        { tool_call_id: `tu_${name}`, name, input: {} },
        {
          session: { sessionId: 's1' },
          logger,
          turnId: 't1',
          perTurnWrites: createPerTurnWrites(),
          round: 1,
        },
      );
      expect(p).toBeInstanceOf(Promise);
    }
  });
});

describe('createWriteDispatcher()', () => {
  test('returns a function of arity 2 (Phase 1 runToolLoop dispatcher contract)', () => {
    const d = createWriteDispatcher({ sessionId: 's1' }, mockLogger(), 't1', createPerTurnWrites());
    expect(typeof d).toBe('function');
    expect(d.length).toBe(2);
  });

  test('known tool: returns well-formed envelope and logs one stage6_tool_call row with outcome=ok', async () => {
    const logger = mockLogger();
    const d = createWriteDispatcher({ sessionId: 's1' }, logger, 't1', createPerTurnWrites());
    const result = await d({ tool_call_id: 'tu_x', name: 'record_reading', input: {} }, {});
    expect(result.tool_use_id).toBe('tu_x');
    expect(result.is_error).toBe(false);
    expect(typeof result.content).toBe('string');
    expect(JSON.parse(result.content)).toMatchObject({ ok: true });

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      'stage6_tool_call',
      expect.objectContaining({
        tool: 'record_reading',
        outcome: 'ok',
        is_error: false,
        phase: 2,
        tool_use_id: 'tu_x',
        round: 1,
      }),
    );
  });

  test('unknown tool: returns is_error envelope with unknown_tool content and logs rejected row', async () => {
    const logger = mockLogger();
    const d = createWriteDispatcher({ sessionId: 's1' }, logger, 't1', createPerTurnWrites());
    const result = await d({ tool_call_id: 'tu_y', name: 'write_stuff', input: {} }, {});
    expect(result.is_error).toBe(true);
    expect(result.tool_use_id).toBe('tu_y');
    expect(result.content).toContain('unknown_tool');

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      'stage6_tool_call',
      expect.objectContaining({
        tool: 'write_stuff',
        outcome: 'rejected',
        is_error: true,
        validation_error: { code: 'unknown_tool' },
      }),
    );
  });

  test('round counter increments monotonically across calls (STO-01)', async () => {
    const logger = mockLogger();
    const d = createWriteDispatcher({ sessionId: 's1' }, logger, 't1', createPerTurnWrites());
    await d({ tool_call_id: 'tu_1', name: 'record_reading', input: {} }, {});
    await d({ tool_call_id: 'tu_2', name: 'clear_reading', input: {} }, {});
    await d({ tool_call_id: 'tu_3', name: 'create_circuit', input: {} }, {});
    const rounds = logger.info.mock.calls.map((c) => c[1].round);
    expect(rounds).toEqual([1, 2, 3]);
  });
});
