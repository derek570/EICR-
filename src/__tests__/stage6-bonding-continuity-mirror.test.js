/**
 * 2026-06-12 — bonding-continuity mirror derivation in
 * dispatchRecordBoardReading (field report session 15B88D6B,
 * voiceFeedbackId 21: "I'd like this [main protective bonding continuity]
 * to pass when bonding of a service is given").
 *
 * When a bonding service check (bonding_water / bonding_gas / bonding_oil /
 * bonding_structural_steel / bonding_lightning / bonding_other) lands as
 * PASS and bonding_conductor_continuity is still empty, the dispatcher
 * derives bonding_conductor_continuity = PASS — mirroring the iOS regex
 * path's autoContinuityIfBonded. The derived perTurnWrites entry carries
 * auto_resolved:true (RCBO-pivot-mirror convention) so the shadow
 * comparator filters it while the bundler still ships it to iOS.
 */

import { jest } from '@jest/globals';
import { createWriteDispatcher } from '../extraction/stage6-dispatchers.js';
import {
  createPerTurnWrites,
  encodeBoardReadingKey,
} from '../extraction/stage6-per-turn-writes.js';
import { ensureMultiBoardShape } from '../extraction/stage6-multi-board-shape.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeSession(seedSupply = {}) {
  const snapshot = {
    circuits: Object.keys(seedSupply).length > 0 ? { 0: { ...seedSupply } } : {},
    pending_readings: [],
    observations: [],
    validation_alerts: [],
  };
  ensureMultiBoardShape(snapshot);
  return { sessionId: 's-bond', stateSnapshot: snapshot, extractedObservations: [] };
}

async function dispatchBoardReading(session, writes, input, id = 'tu_b1') {
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

describe('bonding-continuity mirror derivation', () => {
  test('bonding_water = PASS derives bonding_conductor_continuity = PASS', async () => {
    const session = makeSession();
    const writes = createPerTurnWrites();
    const result = await dispatchBoardReading(session, writes, {
      field: 'bonding_water',
      value: 'PASS',
    });
    expect(result.is_error).toBe(false);
    expect(session.stateSnapshot.circuits[0].bonding_water).toBe('PASS');
    expect(session.stateSnapshot.circuits[0].bonding_conductor_continuity).toBe('PASS');
    const derived = writes.boardReadings.get(encodeBoardReadingKey('bonding_conductor_continuity'));
    expect(derived).toMatchObject({ value: 'PASS', auto_resolved: true });
  });

  test('coerced truthy value ("yes" → PASS) also triggers the derivation', async () => {
    const session = makeSession();
    const writes = createPerTurnWrites();
    const result = await dispatchBoardReading(session, writes, {
      field: 'bonding_gas',
      value: 'yes',
    });
    expect(result.is_error).toBe(false);
    expect(session.stateSnapshot.circuits[0].bonding_gas).toBe('PASS');
    expect(session.stateSnapshot.circuits[0].bonding_conductor_continuity).toBe('PASS');
  });

  test('existing continuity value is never overridden (FAIL stays FAIL)', async () => {
    const session = makeSession({ bonding_conductor_continuity: 'FAIL' });
    const writes = createPerTurnWrites();
    await dispatchBoardReading(session, writes, { field: 'bonding_water', value: 'PASS' });
    expect(session.stateSnapshot.circuits[0].bonding_conductor_continuity).toBe('FAIL');
    expect(writes.boardReadings.has(encodeBoardReadingKey('bonding_conductor_continuity'))).toBe(
      false
    );
  });

  test('model-written continuity in the same turn suppresses the derivation', async () => {
    const session = makeSession();
    const writes = createPerTurnWrites();
    await dispatchBoardReading(
      session,
      writes,
      { field: 'bonding_conductor_continuity', value: 'LIM' },
      'tu_c1'
    );
    await dispatchBoardReading(session, writes, { field: 'bonding_water', value: 'PASS' }, 'tu_c2');
    // The model's own LIM write must survive — the mirror never replaces it.
    expect(session.stateSnapshot.circuits[0].bonding_conductor_continuity).toBe('LIM');
    expect(
      writes.boardReadings.get(encodeBoardReadingKey('bonding_conductor_continuity'))
    ).toMatchObject({ value: 'LIM' });
  });

  test('N/A service check does NOT derive continuity', async () => {
    const session = makeSession();
    const writes = createPerTurnWrites();
    await dispatchBoardReading(session, writes, { field: 'bonding_oil', value: 'N/A' });
    expect(session.stateSnapshot.circuits[0].bonding_conductor_continuity).toBeUndefined();
    expect(writes.boardReadings.has(encodeBoardReadingKey('bonding_conductor_continuity'))).toBe(
      false
    );
  });

  test('non-bonding board fields do NOT derive continuity', async () => {
    const session = makeSession();
    const writes = createPerTurnWrites();
    await dispatchBoardReading(session, writes, {
      field: 'earth_loop_impedance_ze',
      value: '0.35',
    });
    expect(session.stateSnapshot.circuits[0].bonding_conductor_continuity).toBeUndefined();
  });
});
