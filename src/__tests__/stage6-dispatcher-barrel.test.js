/**
 * Stage 6 Phase 2 Plan 02-02 Task 4 — Barrel re-export integrity tests.
 *
 * WHAT: Verifies the barrel (stage6-dispatchers.js) re-exports from the two
 * sibling files without copy-on-import, the table has all six keys, and each
 * dispatcher still satisfies the envelope contract when invoked with a
 * minimal ctx.
 *
 * WHY reference equality (not structural equality) matters: if the barrel
 * ever starts wrapping sibling exports (e.g. `record_reading: (c,x) =>
 * dispatchRecordReading(c,x)`), the reference-identity assertion below
 * fails. That is deliberate — such wrapping adds invisible indirection that
 * makes Phase 7 stack traces confusing and breaks the structural sharing
 * Plans 02-03/04 rely on when they replace the NOOPs in-place.
 */

import { jest } from '@jest/globals';
import {
  WRITE_DISPATCHERS,
  createWriteDispatcher,
} from '../extraction/stage6-dispatchers.js';
import * as circuitSibling from '../extraction/stage6-dispatchers-circuit.js';
import * as observationSibling from '../extraction/stage6-dispatchers-observation.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

describe('barrel re-exports', () => {
  test('WRITE_DISPATCHERS has all six keys, all async functions', () => {
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
    for (const fn of Object.values(WRITE_DISPATCHERS)) {
      expect(typeof fn).toBe('function');
    }
  });

  test('barrel re-exports are REFERENCE-IDENTICAL to sibling exports (no copy-on-import wrapper)', () => {
    expect(WRITE_DISPATCHERS.record_reading).toBe(circuitSibling.dispatchRecordReading);
    expect(WRITE_DISPATCHERS.clear_reading).toBe(circuitSibling.dispatchClearReading);
    expect(WRITE_DISPATCHERS.create_circuit).toBe(circuitSibling.dispatchCreateCircuit);
    expect(WRITE_DISPATCHERS.rename_circuit).toBe(circuitSibling.dispatchRenameCircuit);
    expect(WRITE_DISPATCHERS.record_observation).toBe(observationSibling.dispatchRecordObservation);
    expect(WRITE_DISPATCHERS.delete_observation).toBe(observationSibling.dispatchDeleteObservation);
  });

  test('every dispatcher returns a well-formed envelope when invoked with a minimal ctx', async () => {
    const session = { sessionId: 's1' };
    const logger = mockLogger();
    const ctx = { session, logger, turnId: 't1', perTurnWrites: createPerTurnWrites(), round: 1 };
    for (const [name, fn] of Object.entries(WRITE_DISPATCHERS)) {
      const res = await fn({ tool_call_id: `tu_${name}`, name, input: {} }, ctx);
      expect(res.tool_use_id).toBe(`tu_${name}`);
      expect(res.is_error).toBe(false);
      expect(typeof res.content).toBe('string');
      expect(JSON.parse(res.content).ok).toBe(true);
    }
  });

  test('createWriteDispatcher still works via the barrel (factory + unknown_tool path intact)', async () => {
    const logger = mockLogger();
    const d = createWriteDispatcher({ sessionId: 's1' }, logger, 't1', createPerTurnWrites());
    const res = await d({ tool_call_id: 'tu_unknown', name: 'no_such_tool', input: {} }, {});
    expect(res.is_error).toBe(true);
    expect(res.content).toContain('unknown_tool');
  });
});
