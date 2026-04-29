/**
 * Tests for src/extraction/insulation-resistance-timeout.js — server-side
 * detector for partial IR fills. Mirrors ring-continuity-timeout.test.js.
 */

import {
  IR_FIELDS,
  INSULATION_RESISTANCE_TIMEOUT_MS,
  recordIrWrite,
  clearIrState,
  findExpiredPartial,
  buildAskForMissingIrValue,
} from '../extraction/insulation-resistance-timeout.js';

const SESSION_ID = 'sess-ir';

function buildSession(circuits = {}) {
  return { stateSnapshot: { circuits } };
}

function fillCircuit(session, ref, fills = {}) {
  if (!session.stateSnapshot.circuits) session.stateSnapshot.circuits = {};
  session.stateSnapshot.circuits[ref] = { circuit_ref: ref, ...fills };
}

describe('IR_FIELDS contract', () => {
  test('exports the two canonical IR reading fields, in canonical order', () => {
    expect(IR_FIELDS).toEqual(['ir_live_live_mohm', 'ir_live_earth_mohm']);
  });
});

describe('recordIrWrite + findExpiredPartial', () => {
  test('untracked session → null', () => {
    expect(findExpiredPartial(buildSession())).toBeNull();
  });

  test('tracked but recent (< 60s) → null', () => {
    const s = buildSession();
    fillCircuit(s, 1, { ir_live_live_mohm: '200' });
    recordIrWrite(s, 1, 1000);
    expect(findExpiredPartial(s, 1000 + 30_000)).toBeNull();
  });

  test('tracked and expired with partial fill → returns the missing field', () => {
    const s = buildSession();
    fillCircuit(s, 1, { ir_live_live_mohm: '200' });
    recordIrWrite(s, 1, 1000);
    const result = findExpiredPartial(s, 1000 + INSULATION_RESISTANCE_TIMEOUT_MS + 1);
    expect(result).toEqual({
      circuit_ref: 1,
      missing_field: 'ir_live_earth_mohm',
      last_write_ms: 1000,
    });
  });

  test('expired but bucket FULL (2 of 2) → prunes and returns null', () => {
    const s = buildSession();
    fillCircuit(s, 1, { ir_live_live_mohm: '200', ir_live_earth_mohm: '>999' });
    recordIrWrite(s, 1, 1000);
    expect(findExpiredPartial(s, 1000 + INSULATION_RESISTANCE_TIMEOUT_MS + 1)).toBeNull();
    expect(s.insulationResistanceState.has(1)).toBe(false);
  });

  test('expired but bucket EMPTY (0 of 2) → prunes and returns null', () => {
    const s = buildSession();
    fillCircuit(s, 1, {});
    recordIrWrite(s, 1, 1000);
    expect(findExpiredPartial(s, 1000 + INSULATION_RESISTANCE_TIMEOUT_MS + 1)).toBeNull();
    expect(s.insulationResistanceState.has(1)).toBe(false);
  });

  test('multiple expired circuits → returns oldest first', () => {
    const s = buildSession();
    fillCircuit(s, 3, { ir_live_live_mohm: '200' });
    fillCircuit(s, 5, { ir_live_earth_mohm: '>999' });
    recordIrWrite(s, 3, 1000);
    recordIrWrite(s, 5, 2000);
    const result = findExpiredPartial(s, 2000 + INSULATION_RESISTANCE_TIMEOUT_MS + 1);
    expect(result.circuit_ref).toBe(3);
  });

  test('clearIrState removes the entry', () => {
    const s = buildSession();
    fillCircuit(s, 1, { ir_live_live_mohm: '200' });
    recordIrWrite(s, 1, 1000);
    clearIrState(s, 1);
    expect(s.insulationResistanceState.has(1)).toBe(false);
  });

  test('snapshot circuits as Array (not Object) is also tolerated', () => {
    const s = { stateSnapshot: { circuits: [{ circuit_ref: 2, ir_live_live_mohm: '200' }] } };
    recordIrWrite(s, 2, 1000);
    const result = findExpiredPartial(s, 1000 + INSULATION_RESISTANCE_TIMEOUT_MS + 1);
    expect(result.circuit_ref).toBe(2);
    expect(result.missing_field).toBe('ir_live_earth_mohm');
  });
});

describe('buildAskForMissingIrValue', () => {
  test('builds a server-emitted ask payload with stable shape', () => {
    const ask = buildAskForMissingIrValue(
      { circuit_ref: 3, missing_field: 'ir_live_earth_mohm' },
      SESSION_ID,
      99999
    );
    expect(ask).toEqual({
      tool_call_id: `srv-ir-${SESSION_ID}-3-99999`,
      question: expect.stringContaining('live-to-earth'),
      reason: 'missing_value',
      context_field: 'ir_live_earth_mohm',
      context_circuit: 3,
      expected_answer_shape: 'value',
      server_emitted: true,
    });
    expect(ask.question).toContain('circuit 3');
  });
});
