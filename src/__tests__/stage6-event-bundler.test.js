/**
 * Stage 6 Phase 2 Plan 02-05 — Event bundler unit tests.
 *
 * REQUIREMENTS: STD-09 + STI-02.
 *
 * Locks three invariants the bundler cannot drift from:
 *   1. Empty perTurnWrites → legacy-only keys (iOS regression guard).
 *   2. Reading entries carry exactly 5 keys (field/circuit/value/confidence/source).
 *   3. Confidence is passed VERBATIM from perTurnWrites (dispatcher owns the
 *      default; bundler must never overwrite).
 */

import { bundleToolCallsIntoResult, BUNDLER_PHASE } from '../extraction/stage6-event-bundler.js';

function makePerTurnWrites(overrides = {}) {
  return {
    readings: overrides.readings ?? new Map(),
    cleared: overrides.cleared ?? [],
    observations: overrides.observations ?? [],
    deletedObservations: overrides.deletedObservations ?? [],
    circuitOps: overrides.circuitOps ?? [],
  };
}

describe('bundleToolCallsIntoResult — iOS parity (empty input)', () => {
  test('empty input produces legacy-only keys (iOS regression guard)', () => {
    const r = bundleToolCallsIntoResult(makePerTurnWrites(), { questions: [] });
    expect(Object.keys(r).sort()).toEqual(['extracted_readings', 'observations', 'questions']);
    expect('cleared_readings' in r).toBe(false);
    expect('circuit_updates' in r).toBe(false);
    expect('observation_deletions' in r).toBe(false);
    expect(r.extracted_readings).toEqual([]);
    expect(r.observations).toEqual([]);
    expect(r.questions).toEqual([]);
  });

  test('pre-populated questions on legacyResultShape are preserved verbatim (deep-equal)', () => {
    const legacyQuestions = [
      { id: 'q1', text: 'What circuit?', priority: 'high' },
      { id: 'q2', text: 'Which board?', priority: 'low' },
    ];
    const r = bundleToolCallsIntoResult(makePerTurnWrites(), { questions: legacyQuestions });
    expect(r.questions).toEqual(legacyQuestions);
  });
});

describe('bundleToolCallsIntoResult — Reading Map projection', () => {
  test('single reading produces one extracted_readings entry with exactly 5 keys', () => {
    const readings = new Map([
      ['volts::C1', { value: 230, confidence: 0.95, source_turn_id: 't1' }],
    ]);
    const r = bundleToolCallsIntoResult(makePerTurnWrites({ readings }), { questions: [] });
    expect(r.extracted_readings).toHaveLength(1);
    expect(Object.keys(r.extracted_readings[0]).sort()).toEqual([
      'circuit',
      'confidence',
      'field',
      'source',
      'value',
    ]);
    expect(r.extracted_readings[0]).toEqual({
      field: 'volts',
      circuit: 'C1',
      value: 230,
      confidence: 0.95,
      source: 'tool_call',
    });
  });

  test('multiple readings preserve Map insertion order', () => {
    const readings = new Map();
    readings.set('ze::main', { value: 0.25, confidence: 1.0 });
    readings.set('pfc::main', { value: 1.5, confidence: 1.0 });
    readings.set('volts::C3', { value: 232, confidence: 0.9 });
    const r = bundleToolCallsIntoResult(makePerTurnWrites({ readings }), { questions: [] });
    expect(r.extracted_readings.map((e) => `${e.field}::${e.circuit}`)).toEqual([
      'ze::main',
      'pfc::main',
      'volts::C3',
    ]);
  });

  test('numeric circuit (integer from tool schema) round-trips as integer, not string', () => {
    // Codex Phase-2 review MAJOR #2 fix: the Map key is `${field}::${input.circuit}`
    // so integer circuit_refs get coerced to numeric strings at write time.
    // The bundler must parse the suffix back to an integer when it round-trips
    // cleanly so the wire shape matches legacy (`extracted_readings[].circuit`
    // is typed as integer at eicr-extraction-session.js:992).
    const readings = new Map([
      ['measured_zs_ohm::1', { value: 0.32, confidence: 0.98 }],
      ['measured_zs_ohm::0', { value: 0.28, confidence: 1.0 }], // supply
      ['measured_zs_ohm::-1', { value: 0.41, confidence: 0.9 }], // unassigned
    ]);
    const r = bundleToolCallsIntoResult(makePerTurnWrites({ readings }), { questions: [] });
    expect(r.extracted_readings).toHaveLength(3);
    expect(r.extracted_readings[0].circuit).toBe(1);
    expect(typeof r.extracted_readings[0].circuit).toBe('number');
    expect(r.extracted_readings[1].circuit).toBe(0);
    expect(r.extracted_readings[2].circuit).toBe(-1);
  });

  test('non-integer circuit string (future-proof) stays as string', () => {
    // Today the tool schema declares circuit as `integer`, but a future schema
    // that allows lettered refs (e.g. "C1", "MCB-A") must still round-trip
    // losslessly. The parse-guard requires a clean integer round-trip, so
    // non-numeric tails stay string.
    const readings = new Map([
      ['volts::C1', { value: 230, confidence: 1.0 }],
      ['volts::MCB-A', { value: 232, confidence: 1.0 }],
    ]);
    const r = bundleToolCallsIntoResult(makePerTurnWrites({ readings }), { questions: [] });
    expect(r.extracted_readings[0].circuit).toBe('C1');
    expect(r.extracted_readings[1].circuit).toBe('MCB-A');
  });

  test('same-turn correction: dispatcher-overwritten Map entry yields verbatim confidence (NOT overwritten to 1.0)', () => {
    // Dispatcher collapsed two writes for volts::C1 into one entry with the LATEST value + confidence.
    const readings = new Map([
      ['volts::C1', { value: 240, confidence: 0.9, source_turn_id: 't2' }],
    ]);
    const r = bundleToolCallsIntoResult(makePerTurnWrites({ readings }), { questions: [] });
    expect(r.extracted_readings).toHaveLength(1);
    expect(r.extracted_readings[0].value).toBe(240);
    expect(r.extracted_readings[0].confidence).toBe(0.9); // VERBATIM, not 1.0
  });
});

describe('bundleToolCallsIntoResult — Slot inclusion (per-new-slot tests)', () => {
  test('non-empty cleared → cleared_readings present; other new slots absent', () => {
    const cleared = [{ field: 'volts', circuit: 'C1', reason: 'user_retracted' }];
    const r = bundleToolCallsIntoResult(makePerTurnWrites({ cleared }), { questions: [] });
    expect(r.cleared_readings).toEqual(cleared);
    expect('circuit_updates' in r).toBe(false);
    expect('observation_deletions' in r).toBe(false);
  });

  test('non-empty circuitOps → circuit_updates present; cleared_readings absent', () => {
    const circuitOps = [{ op: 'rename', circuit_ref: 'C2', from_ref: 'C1' }];
    const r = bundleToolCallsIntoResult(makePerTurnWrites({ circuitOps }), { questions: [] });
    expect(r.circuit_updates).toEqual(circuitOps);
    expect('cleared_readings' in r).toBe(false);
    expect('observation_deletions' in r).toBe(false);
  });

  test('non-empty deletedObservations → observation_deletions present; cleared_readings absent', () => {
    const deletedObservations = [{ id: 'obs-1', reason: 'duplicate' }];
    const r = bundleToolCallsIntoResult(
      makePerTurnWrites({ deletedObservations }),
      { questions: [] },
    );
    expect(r.observation_deletions).toEqual(deletedObservations);
    expect('cleared_readings' in r).toBe(false);
    expect('circuit_updates' in r).toBe(false);
  });
});

describe('bundleToolCallsIntoResult — iOS compatibility JSON shape regression', () => {
  test('empty perTurnWrites produces key-set equal to legacy (three keys, sorted)', () => {
    const legacy = { extracted_readings: [{ field: 'x', circuit: 'C1', value: 1, confidence: 1 }], observations: [], questions: [] };
    const r = bundleToolCallsIntoResult(makePerTurnWrites(), legacy);
    expect(Object.keys(r).sort()).toEqual(['extracted_readings', 'observations', 'questions']);
  });
});

describe('bundleToolCallsIntoResult — Defensive guards', () => {
  test('readings as array (not Map) throws TypeError; missing legacyResultShape defaults questions', () => {
    expect(() =>
      bundleToolCallsIntoResult(
        { readings: [], cleared: [], observations: [], deletedObservations: [], circuitOps: [] },
        { questions: [] },
      ),
    ).toThrow(/must be a Map/);

    const r = bundleToolCallsIntoResult(makePerTurnWrites(), undefined);
    expect(r.questions).toEqual([]);

    const r2 = bundleToolCallsIntoResult(makePerTurnWrites(), null);
    expect(r2.questions).toEqual([]);
  });
});

describe('bundleToolCallsIntoResult — sanity', () => {
  test('BUNDLER_PHASE is 2', () => {
    expect(BUNDLER_PHASE).toBe(2);
  });
});
