/**
 * Cluster C3 IR-triplet aggregator — voice-feedback-cleanup-2026-06-09.
 *
 * Marker 3: "IR values run into each other". The canonical IR triplet
 * in the current schema is THREE distinct fields written in one
 * turn — ir_test_voltage_v (voltage), ir_live_live_mohm (L-to-L
 * resistance), ir_live_earth_mohm (L-to-E resistance). Without
 * aggregation the bundler emitted three independent confirmation
 * entries; iOS TTS played them back-to-back without an inter-item
 * gap and the inspector heard them as one run-on blob.
 *
 * The aggregator detects when the same turn writes ≥ 2 of the IR
 * fields on the SAME circuit and merges them into ONE composite
 * confirmation entry. The composite carries field: "ir_aggregate" so
 * iOS recognises it as a multi-source row (no single-field highlight).
 *
 * IMPORTANT — schema invariant: there is NO `ir_neutral_earth_mohm`
 * field in the current schema. This aggregator must NEVER emit an
 * "N to E" label. If a future schema adds an N-to-E reading, the
 * aggregator extends here; until then, the label is forbidden.
 */

import { bundleToolCallsIntoResult } from '../extraction/stage6-event-bundler.js';
import { encodeReadingKey } from '../extraction/stage6-per-turn-writes.js';

function makePerTurnWrites(overrides = {}) {
  return {
    readings: overrides.readings ?? new Map(),
    cleared: overrides.cleared ?? [],
    observations: overrides.observations ?? [],
    deletedObservations: overrides.deletedObservations ?? [],
    circuitOps: overrides.circuitOps ?? [],
    boardOps: overrides.boardOps ?? [],
  };
}

describe('Cluster C3 — IR triplet aggregator (synthesiseConfirmations)', () => {
  test('full triplet on one circuit → ONE composite entry, three indices consumed', () => {
    const readings = new Map([
      [encodeReadingKey('ir_test_voltage_v', 4), { value: '500', confidence: 1.0 }],
      [encodeReadingKey('ir_live_live_mohm', 4), { value: '199', confidence: 1.0 }],
      [encodeReadingKey('ir_live_earth_mohm', 4), { value: '200', confidence: 1.0 }],
    ]);
    const r = bundleToolCallsIntoResult(
      makePerTurnWrites({ readings }),
      { questions: [] },
      { confirmationsEnabled: true }
    );
    expect(r.confirmations).toHaveLength(1);
    const entry = r.confirmations[0];
    expect(entry.field).toBe('ir_aggregate');
    expect(entry.circuit).toBe(4);
    // Composite carries the voltage head + both measurements, in order.
    expect(entry.text).toContain('Circuit 4');
    expect(entry.text).toContain('500 volt IR');
    expect(entry.text).toContain('L to L 199');
    expect(entry.text).toContain('L to E 200');
    // Hard schema guard: NEVER emit "N to E" — there is no
    // ir_neutral_earth_mohm field in the current schema.
    expect(entry.text).not.toMatch(/N to E/i);
  });

  test('two-of-three (voltage + L-to-L only) → ONE composite, no L-to-E', () => {
    const readings = new Map([
      [encodeReadingKey('ir_test_voltage_v', 2), { value: '500', confidence: 1.0 }],
      [encodeReadingKey('ir_live_live_mohm', 2), { value: '199', confidence: 1.0 }],
    ]);
    const r = bundleToolCallsIntoResult(
      makePerTurnWrites({ readings }),
      { questions: [] },
      { confirmationsEnabled: true }
    );
    expect(r.confirmations).toHaveLength(1);
    const entry = r.confirmations[0];
    expect(entry.field).toBe('ir_aggregate');
    expect(entry.text).toContain('500 volt IR');
    expect(entry.text).toContain('L to L 199');
    expect(entry.text).not.toContain('L to E');
  });

  test('two-of-three (L-to-L + L-to-E only, no voltage) → ONE composite with bare "IR" head', () => {
    const readings = new Map([
      [encodeReadingKey('ir_live_live_mohm', 3), { value: '199', confidence: 1.0 }],
      [encodeReadingKey('ir_live_earth_mohm', 3), { value: '200', confidence: 1.0 }],
    ]);
    const r = bundleToolCallsIntoResult(
      makePerTurnWrites({ readings }),
      { questions: [] },
      { confirmationsEnabled: true }
    );
    expect(r.confirmations).toHaveLength(1);
    const entry = r.confirmations[0];
    expect(entry.field).toBe('ir_aggregate');
    expect(entry.text).toContain('Circuit 3');
    // No voltage → head is bare "IR" (no "volt" word).
    expect(entry.text).not.toContain('volt');
    expect(entry.text).toContain('IR L to L 199');
    expect(entry.text).toContain('L to E 200');
  });

  test('single IR field on a circuit → falls through to per-reading path (no aggregator fire)', () => {
    const readings = new Map([
      [encodeReadingKey('ir_live_live_mohm', 5), { value: '199', confidence: 1.0 }],
    ]);
    const r = bundleToolCallsIntoResult(
      makePerTurnWrites({ readings }),
      { questions: [] },
      { confirmationsEnabled: true }
    );
    expect(r.confirmations).toHaveLength(1);
    const entry = r.confirmations[0];
    // Per-reading path produces the existing buildConfirmationText shape
    // — NOT the synthetic 'ir_aggregate' field.
    expect(entry.field).toBe('ir_live_live_mohm');
    expect(entry.circuit).toBe(5);
    expect(entry.text).toBe('Circuit 5, IR L to L 199');
  });

  test('IR triplet on circuit A AND single IR field on circuit B → ONE aggregate + ONE per-reading', () => {
    const readings = new Map([
      [encodeReadingKey('ir_test_voltage_v', 4), { value: '500', confidence: 1.0 }],
      [encodeReadingKey('ir_live_live_mohm', 4), { value: '199', confidence: 1.0 }],
      [encodeReadingKey('ir_live_earth_mohm', 4), { value: '200', confidence: 1.0 }],
      [encodeReadingKey('ir_test_voltage_v', 7), { value: '500', confidence: 1.0 }],
    ]);
    const r = bundleToolCallsIntoResult(
      makePerTurnWrites({ readings }),
      { questions: [] },
      { confirmationsEnabled: true }
    );
    // Two confirmations: aggregate for circuit 4 + per-reading for circuit 7.
    expect(r.confirmations).toHaveLength(2);
    const fields = r.confirmations.map((e) => e.field).sort();
    expect(fields).toEqual(['ir_aggregate', 'ir_test_voltage_v']);
    const aggregate = r.confirmations.find((e) => e.field === 'ir_aggregate');
    expect(aggregate.circuit).toBe(4);
    const single = r.confirmations.find((e) => e.field === 'ir_test_voltage_v');
    expect(single.circuit).toBe(7);
  });

  test('per-circuit aggregation does not bleed across circuits (4 and 5 each get their own aggregate)', () => {
    const readings = new Map([
      [encodeReadingKey('ir_test_voltage_v', 4), { value: '500', confidence: 1.0 }],
      [encodeReadingKey('ir_live_live_mohm', 4), { value: '199', confidence: 1.0 }],
      [encodeReadingKey('ir_test_voltage_v', 5), { value: '500', confidence: 1.0 }],
      [encodeReadingKey('ir_live_live_mohm', 5), { value: '215', confidence: 1.0 }],
    ]);
    const r = bundleToolCallsIntoResult(
      makePerTurnWrites({ readings }),
      { questions: [] },
      { confirmationsEnabled: true }
    );
    expect(r.confirmations).toHaveLength(2);
    expect(r.confirmations.every((e) => e.field === 'ir_aggregate')).toBe(true);
    const c4 = r.confirmations.find((e) => e.circuit === 4);
    const c5 = r.confirmations.find((e) => e.circuit === 5);
    expect(c4.text).toContain('L to L 199');
    expect(c5.text).toContain('L to L 215');
  });

  test('aggregator never asserts on an N-to-E label (schema-locked: no ir_neutral_earth_mohm)', () => {
    // Forward-guard: if a future test asserts on "N to E" it would mean
    // someone added an ir_neutral_earth_mohm field without auditing the
    // aggregator. Lock the prohibition by asserting BOTH directions:
    // the field set is exactly 3 names, and the aggregator's output
    // never contains the N-to-E label even with all three real fields.
    const readings = new Map([
      [encodeReadingKey('ir_test_voltage_v', 4), { value: '500', confidence: 1.0 }],
      [encodeReadingKey('ir_live_live_mohm', 4), { value: '199', confidence: 1.0 }],
      [encodeReadingKey('ir_live_earth_mohm', 4), { value: '200', confidence: 1.0 }],
    ]);
    const r = bundleToolCallsIntoResult(
      makePerTurnWrites({ readings }),
      { questions: [] },
      { confirmationsEnabled: true }
    );
    expect(r.confirmations[0].text).not.toMatch(/N to E/i);
    expect(r.confirmations[0].text).not.toMatch(/neutral.*earth/i);
  });

  test('low-confidence IR field on a circuit is skipped from aggregator (per-reading path also skips)', () => {
    const readings = new Map([
      [encodeReadingKey('ir_test_voltage_v', 4), { value: '500', confidence: 1.0 }],
      [encodeReadingKey('ir_live_live_mohm', 4), { value: '199', confidence: 0.6 }], // below CONFIRMATION_MIN_CONFIDENCE
      [encodeReadingKey('ir_live_earth_mohm', 4), { value: '200', confidence: 1.0 }],
    ]);
    const r = bundleToolCallsIntoResult(
      makePerTurnWrites({ readings }),
      { questions: [] },
      { confirmationsEnabled: true }
    );
    // Aggregator only sees voltage + L-to-E (≥2), so it fires.
    // The low-confidence L-to-L is filtered upstream of the aggregator
    // and also upstream of the per-reading path — neither emits it.
    expect(r.confirmations).toHaveLength(1);
    const entry = r.confirmations[0];
    expect(entry.field).toBe('ir_aggregate');
    expect(entry.text).toContain('500 volt IR');
    expect(entry.text).toContain('L to E 200');
    expect(entry.text).not.toContain('L to L');
  });
});
