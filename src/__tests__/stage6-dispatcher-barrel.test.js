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
import { WRITE_DISPATCHERS, createWriteDispatcher } from '../extraction/stage6-dispatchers.js';
import * as circuitSibling from '../extraction/stage6-dispatchers-circuit.js';
import * as observationSibling from '../extraction/stage6-dispatchers-observation.js';
import * as boardSibling from '../extraction/stage6-dispatchers-board.js';
import * as scriptSibling from '../extraction/stage6-dispatchers-script.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

describe('barrel re-exports', () => {
  test('WRITE_DISPATCHERS has all eight keys, all async functions', () => {
    expect(Object.keys(WRITE_DISPATCHERS).sort()).toEqual(
      [
        'clear_reading',
        'create_circuit',
        'delete_observation',
        'record_board_reading',
        'record_observation',
        'record_reading',
        'rename_circuit',
        'start_dialogue_script',
      ].sort()
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
    expect(WRITE_DISPATCHERS.record_board_reading).toBe(boardSibling.dispatchRecordBoardReading);
    expect(WRITE_DISPATCHERS.start_dialogue_script).toBe(scriptSibling.dispatchStartDialogueScript);
  });

  test('every dispatcher returns a well-formed envelope when invoked with valid inputs', async () => {
    // WAVE-2 UPDATE (Plans 02-03 + 02-04 landed real impls): empty-input
    // dispatch now hits validators and rejects. Previously NOOPs accepted
    // `input: {}`. We preserve the intent (envelope shape is well-formed
    // for all six tools) by supplying minimal valid inputs per tool. Under
    // real impls, `ok:true` is produced by each dispatcher on a happy-path
    // valid input — except delete_observation which emits the noop envelope
    // when the observation id is unknown, which is ALSO shape-valid
    // (is_error:false, JSON content with ok:true + noop:true).
    const session = {
      sessionId: 's1',
      stateSnapshot: { circuits: { 3: { Ze_ohms: '0.35' } } },
      extractedObservations: [],
    };
    const logger = mockLogger();
    const ctx = { session, logger, turnId: 't1', perTurnWrites: createPerTurnWrites(), round: 1 };
    const validInputs = {
      record_reading: {
        field: 'Zs_ohms',
        circuit: 3,
        value: '0.5',
        confidence: 1.0,
        source_turn_id: 't1',
      },
      clear_reading: { field: 'Ze_ohms', circuit: 3, reason: 'user_correction' },
      create_circuit: { circuit_ref: 99 },
      rename_circuit: { from_ref: 3, circuit_ref: 3 }, // rename-to-self = noop-ok
      record_observation: { code: 'C2', text: 'x', location: 'y' },
      delete_observation: {
        observation_id: '00000000-0000-4000-8000-000000000000',
        reason: 'user_correction',
      },
      // record_board_reading writes to circuits[0]; no preconditions on session
      // state. earth_loop_impedance_ze is a real BOARD_FIELD_ENUM member and
      // makes the happy-path assertion meaningful.
      record_board_reading: {
        field: 'earth_loop_impedance_ze',
        value: '0.86',
        confidence: 0.95,
        source_turn_id: 't1',
      },
      // start_dialogue_script (2026-04-30 Silvertown follow-up): minimal valid
      // input — schema=ring_continuity is in ALL_DIALOGUE_SCHEMA_NAMES, circuit
      // is null so no snapshot lookup is needed, source_turn_id+reason satisfy
      // the required list.
      start_dialogue_script: {
        schema: 'ring_continuity',
        circuit: null,
        source_turn_id: 't1',
        reason: 'barrel-test happy-path',
      },
    };
    for (const [name, fn] of Object.entries(WRITE_DISPATCHERS)) {
      // Fresh session per call so create_circuit(99) etc don't collide.
      const localSession = {
        sessionId: 's1',
        stateSnapshot: { circuits: { 3: { Ze_ohms: '0.35' } } },
        extractedObservations: [],
      };
      const localCtx = { ...ctx, session: localSession };
      const res = await fn(
        { tool_call_id: `tu_${name}`, name, input: validInputs[name] },
        localCtx
      );
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
