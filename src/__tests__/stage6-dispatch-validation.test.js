/**
 * Stage 6 Phase 2 Plan 02-02 — Pure validator unit tests.
 *
 * WHAT: Six pure functions validating dispatcher input against the session
 * stateSnapshot. Each returns either null (valid) or {code, field?} (rejection
 * envelope). No mutation, no logging, no async. Tests enforce this purity.
 *
 * WHY tests are deep here (not cursory): the validators are the only layer
 * that stands between a badly-formed tool_use and a state mutation. Missing a
 * branch means state can drift silently. Codex's Phase 1 round-3 review
 * flagged "belt-and-braces numeric-type guards" as a non-negotiable — the
 * invalid_type tests lock that in.
 *
 * Validation-code namespace (must stay bounded):
 *   circuit_not_found       — reading/clear references missing circuit
 *   circuit_already_exists  — create_circuit on an existing circuit_ref
 *   source_not_found        — rename_circuit.from_ref missing
 *   target_exists           — rename_circuit.circuit_ref collides
 *   invalid_type            — numeric meta arrived as string (Pitfall #5)
 *   // 'observation_not_found' is NOT a validator code (BLOCK-2).
 *   // It is handled at the dispatcher level in Plan 02-04 as a noop
 *   // outcome because the post-state already satisfies the request.
 */

import {
  validateRecordReading,
  validateClearReading,
  validateCreateCircuit,
  validateRenameCircuit,
  validateRecordObservation,
  validateDeleteObservation,
} from '../extraction/stage6-dispatch-validation.js';

describe('validateRecordReading', () => {
  test('valid when circuit exists', () => {
    expect(validateRecordReading({ circuit: 3 }, { circuits: { 3: {} } })).toBeNull();
  });
  test('rejects when circuit is absent from snapshot', () => {
    expect(validateRecordReading({ circuit: 99 }, { circuits: { 3: {} } })).toEqual({
      code: 'circuit_not_found',
      field: 'circuit',
    });
  });
});

describe('validateClearReading', () => {
  test('valid when circuit exists (field_not_set is a dispatcher-level noop, NOT a validator rejection)', () => {
    expect(validateClearReading({ circuit: 3, field: 'Ze_ohms' }, { circuits: { 3: {} } })).toBeNull();
  });
  test('rejects when circuit is absent', () => {
    expect(validateClearReading({ circuit: 99, field: 'Ze_ohms' }, { circuits: { 3: {} } })).toEqual({
      code: 'circuit_not_found',
      field: 'circuit',
    });
  });
});

describe('validateCreateCircuit', () => {
  test('valid when circuit_ref is new', () => {
    expect(validateCreateCircuit({ circuit_ref: 5 }, { circuits: {} })).toBeNull();
  });
  test('rejects when circuit_ref already exists', () => {
    expect(validateCreateCircuit({ circuit_ref: 5 }, { circuits: { 5: {} } })).toEqual({
      code: 'circuit_already_exists',
      field: 'circuit_ref',
    });
  });
  test('rejects invalid_type on string rating_amps (Pitfall #5 belt-and-braces)', () => {
    expect(validateCreateCircuit({ circuit_ref: 5, rating_amps: 'thirty' }, { circuits: {} })).toEqual({
      code: 'invalid_type',
      field: 'rating_amps',
    });
  });
  test('rejects invalid_type on string cable_csa_mm2', () => {
    expect(validateCreateCircuit({ circuit_ref: 5, cable_csa_mm2: 'big' }, { circuits: {} })).toEqual({
      code: 'invalid_type',
      field: 'cable_csa_mm2',
    });
  });
});

describe('validateRenameCircuit', () => {
  test('valid when from_ref exists and target circuit_ref is free', () => {
    expect(validateRenameCircuit({ from_ref: 3, circuit_ref: 7 }, { circuits: { 3: {} } })).toBeNull();
  });
  test('rejects source_not_found when from_ref is absent', () => {
    expect(validateRenameCircuit({ from_ref: 99, circuit_ref: 7 }, { circuits: { 3: {} } })).toEqual({
      code: 'source_not_found',
      field: 'from_ref',
    });
  });
  test('rejects target_exists when circuit_ref already present and differs from from_ref', () => {
    expect(
      validateRenameCircuit({ from_ref: 3, circuit_ref: 5 }, { circuits: { 3: {}, 5: {} } }),
    ).toEqual({ code: 'target_exists', field: 'circuit_ref' });
  });
  test('valid when from_ref === circuit_ref (noop rename — allowed per Research §Q8)', () => {
    expect(validateRenameCircuit({ from_ref: 3, circuit_ref: 3 }, { circuits: { 3: {} } })).toBeNull();
  });
  test('rejects invalid_type on string rating_amps', () => {
    expect(
      validateRenameCircuit(
        { from_ref: 3, circuit_ref: 3, rating_amps: 'thirty-two' },
        { circuits: { 3: {} } },
      ),
    ).toEqual({ code: 'invalid_type', field: 'rating_amps' });
  });
});

describe('validateRecordObservation', () => {
  test('always returns null (no preconditions — strict:true handles enums at the API layer)', () => {
    expect(validateRecordObservation({ code: 'C2', text: 'loose terminal' }, { extractedObservations: [] })).toBeNull();
  });
});

describe('validateDeleteObservation (BLOCK-2 contract: always-valid)', () => {
  test('observation_id present in session → null', () => {
    const session = { extractedObservations: [{ id: 'obs_1', text: 'x', code: 'C2' }] };
    expect(validateDeleteObservation({ observation_id: 'obs_1', reason: 'user_correction' }, session)).toBeNull();
  });
  test('observation_id absent → still null (dispatcher handles noop outcome per Plan 02-04)', () => {
    const session = { extractedObservations: [{ id: 'obs_1', text: 'x', code: 'C2' }] };
    expect(validateDeleteObservation({ observation_id: 'missing', reason: 'user_correction' }, session)).toBeNull();
  });
  test('session.extractedObservations missing entirely → still null (validator never throws)', () => {
    expect(validateDeleteObservation({ observation_id: 'whatever', reason: 'duplicate' }, {})).toBeNull();
  });
});
