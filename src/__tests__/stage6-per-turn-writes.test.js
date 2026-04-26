/**
 * Stage 6 Phase 2 Plan 02-02 — createPerTurnWrites() unit tests.
 *
 * WHAT: Locks the shape of the per-turn writes accumulator that all six write
 * dispatchers (record_reading, clear_reading, create_circuit, rename_circuit,
 * record_observation, delete_observation) share. Same-turn correction
 * semantics (STT-09) depend on the readings Map's last-write-wins behaviour;
 * the Phase 2 event bundler (Plan 02-05) depends on the exact field names
 * (readings / cleared / observations / deletedObservations / circuitOps).
 *
 * WHY this shape is locked here (MAJOR-1 from Phase 2 planning review):
 *   - `readings` is a Map<"${field}::${circuit}", {value, confidence, source_turn_id}>.
 *     The value object MUST NOT carry field/circuit — they're in the key. The
 *     bundler in Plan 02-05 reconstructs field+circuit by splitting on '::'.
 *     Duplicating them in the value creates drift risk (which truth wins?).
 *   - Reset-per-turn contract: every `runShadowHarness` invocation creates a
 *     fresh accumulator. Tests enforce that two calls return DIFFERENT objects
 *     so a bug that accidentally memoises the factory shows up in CI.
 */

import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';

describe('createPerTurnWrites()', () => {
  test('returns an object with the six expected fields all initially empty', () => {
    const w = createPerTurnWrites();
    expect(w.readings).toBeInstanceOf(Map);
    expect(w.readings.size).toBe(0);
    // boardReadings is the Phase 2 carryover slot for record_board_reading
    // (Bug C — 2026-04-26 production analysis). Same Map shape as readings,
    // keyed by field-only because every entry implicitly lives at circuits[0].
    expect(w.boardReadings).toBeInstanceOf(Map);
    expect(w.boardReadings.size).toBe(0);
    expect(Array.isArray(w.cleared)).toBe(true);
    expect(w.cleared).toHaveLength(0);
    expect(Array.isArray(w.observations)).toBe(true);
    expect(w.observations).toHaveLength(0);
    expect(Array.isArray(w.deletedObservations)).toBe(true);
    expect(w.deletedObservations).toHaveLength(0);
    expect(Array.isArray(w.circuitOps)).toBe(true);
    expect(w.circuitOps).toHaveLength(0);
  });

  test('each call returns a NEW object — no shared references across invocations (reset-per-turn contract)', () => {
    const a = createPerTurnWrites();
    const b = createPerTurnWrites();
    expect(a).not.toBe(b);
    expect(a.readings).not.toBe(b.readings);
    expect(a.boardReadings).not.toBe(b.boardReadings);
    expect(a.cleared).not.toBe(b.cleared);
    expect(a.observations).not.toBe(b.observations);
    expect(a.deletedObservations).not.toBe(b.deletedObservations);
    expect(a.circuitOps).not.toBe(b.circuitOps);

    // Mutating one must not affect the other.
    a.readings.set('Ze_ohms::1', { value: '0.35', confidence: 1.0, source_turn_id: 't1' });
    a.boardReadings.set('earth_loop_impedance_ze', {
      value: '0.86',
      confidence: 0.95,
      source_turn_id: 't1',
    });
    a.cleared.push({ field: 'Zs_ohms', circuit: 1, reason: 'user_correction' });
    expect(b.readings.size).toBe(0);
    expect(b.boardReadings.size).toBe(0);
    expect(b.cleared).toHaveLength(0);
  });

  test('readings Map has last-write-wins semantics on the same `${field}::${circuit}` key (same-turn correction pathway)', () => {
    const w = createPerTurnWrites();
    w.readings.set('Ze_ohms::3', { value: '0.35', confidence: 1.0, source_turn_id: 't1' });
    w.readings.set('Ze_ohms::3', { value: '0.40', confidence: 1.0, source_turn_id: 't1' });
    expect(w.readings.size).toBe(1);
    expect(w.readings.get('Ze_ohms::3')).toEqual({
      value: '0.40',
      confidence: 1.0,
      source_turn_id: 't1',
    });
  });

  test('readings value shape lock (MAJOR-1): entries carry {value, confidence, source_turn_id} — NOT field/circuit', () => {
    const w = createPerTurnWrites();
    w.readings.set('R1_ohms::2', { value: '1.23', confidence: 0.95, source_turn_id: 't42' });
    const entry = w.readings.get('R1_ohms::2');
    expect(entry).toHaveProperty('value');
    expect(entry).toHaveProperty('confidence');
    expect(entry).toHaveProperty('source_turn_id');
    // Shape lock: value must NOT include field/circuit. The bundler in Plan 02-05
    // reconstructs those by splitting the key on '::'.
    expect(entry).not.toHaveProperty('field');
    expect(entry).not.toHaveProperty('circuit');
  });
});
