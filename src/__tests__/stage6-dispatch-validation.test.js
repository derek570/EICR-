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
  validateAskUser,
} from '../extraction/stage6-dispatch-validation.js';

describe('validateRecordReading', () => {
  test('valid when circuit exists and confidence is in range', () => {
    expect(
      validateRecordReading({ circuit: 3, confidence: 0.9 }, { circuits: { 3: {} } })
    ).toBeNull();
  });
  test('rejects when circuit is absent from snapshot', () => {
    expect(
      validateRecordReading({ circuit: 99, confidence: 0.9 }, { circuits: { 3: {} } })
    ).toEqual({ code: 'circuit_not_found', field: 'circuit' });
  });
  // Confidence bound enforcement — moved out of input_schema (Anthropic
  // strict-mode rejects `minimum`/`maximum` on number types).
  test('valid at boundary confidence=0', () => {
    expect(
      validateRecordReading({ circuit: 3, confidence: 0 }, { circuits: { 3: {} } })
    ).toBeNull();
  });
  test('valid at boundary confidence=1', () => {
    expect(
      validateRecordReading({ circuit: 3, confidence: 1 }, { circuits: { 3: {} } })
    ).toBeNull();
  });
  test('rejects confidence < 0', () => {
    expect(
      validateRecordReading({ circuit: 3, confidence: -0.01 }, { circuits: { 3: {} } })
    ).toEqual({ code: 'confidence_out_of_range', field: 'confidence' });
  });
  test('rejects confidence > 1', () => {
    expect(
      validateRecordReading({ circuit: 3, confidence: 1.01 }, { circuits: { 3: {} } })
    ).toEqual({ code: 'confidence_out_of_range', field: 'confidence' });
  });
  test('rejects non-finite confidence (NaN, Infinity)', () => {
    expect(
      validateRecordReading({ circuit: 3, confidence: Number.NaN }, { circuits: { 3: {} } })
    ).toEqual({ code: 'confidence_out_of_range', field: 'confidence' });
    expect(
      validateRecordReading(
        { circuit: 3, confidence: Number.POSITIVE_INFINITY },
        { circuits: { 3: {} } }
      )
    ).toEqual({ code: 'confidence_out_of_range', field: 'confidence' });
  });
  test('accepts missing/null confidence (dispatcher defaults to 1.0)', () => {
    // Strict-mode requires confidence in the input_schema, so a real Sonnet
    // call always supplies it. But the dispatcher defaults missing/null to
    // 1.0 (legacy pass-through, see stage6-dispatchers-circuit.js:113), and
    // tests using bare fixtures without confidence have always relied on
    // that default — we keep that contract.
    expect(validateRecordReading({ circuit: 3 }, { circuits: { 3: {} } })).toBeNull();
    expect(
      validateRecordReading({ circuit: 3, confidence: null }, { circuits: { 3: {} } })
    ).toBeNull();
  });
  test('rejects non-numeric confidence', () => {
    expect(
      validateRecordReading({ circuit: 3, confidence: 'high' }, { circuits: { 3: {} } })
    ).toEqual({ code: 'confidence_out_of_range', field: 'confidence' });
  });
});

describe('validateClearReading', () => {
  test('valid when circuit exists (field_not_set is a dispatcher-level noop, NOT a validator rejection)', () => {
    expect(
      validateClearReading({ circuit: 3, field: 'Ze_ohms' }, { circuits: { 3: {} } })
    ).toBeNull();
  });
  test('rejects when circuit is absent', () => {
    expect(
      validateClearReading({ circuit: 99, field: 'Ze_ohms' }, { circuits: { 3: {} } })
    ).toEqual({
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
    expect(
      validateCreateCircuit({ circuit_ref: 5, rating_amps: 'thirty' }, { circuits: {} })
    ).toEqual({
      code: 'invalid_type',
      field: 'rating_amps',
    });
  });
  test('rejects invalid_type on string cable_csa_mm2', () => {
    expect(
      validateCreateCircuit({ circuit_ref: 5, cable_csa_mm2: 'big' }, { circuits: {} })
    ).toEqual({
      code: 'invalid_type',
      field: 'cable_csa_mm2',
    });
  });
});

describe('validateRenameCircuit', () => {
  test('valid when from_ref exists and target circuit_ref is free', () => {
    expect(
      validateRenameCircuit({ from_ref: 3, circuit_ref: 7 }, { circuits: { 3: {} } })
    ).toBeNull();
  });
  test('rejects source_not_found when from_ref is absent', () => {
    expect(
      validateRenameCircuit({ from_ref: 99, circuit_ref: 7 }, { circuits: { 3: {} } })
    ).toEqual({
      code: 'source_not_found',
      field: 'from_ref',
    });
  });
  test('rejects target_exists when circuit_ref already present and differs from from_ref', () => {
    expect(
      validateRenameCircuit({ from_ref: 3, circuit_ref: 5 }, { circuits: { 3: {}, 5: {} } })
    ).toEqual({ code: 'target_exists', field: 'circuit_ref' });
  });
  test('valid when from_ref === circuit_ref (noop rename — allowed per Research §Q8)', () => {
    expect(
      validateRenameCircuit({ from_ref: 3, circuit_ref: 3 }, { circuits: { 3: {} } })
    ).toBeNull();
  });
  test('rejects invalid_type on string rating_amps', () => {
    expect(
      validateRenameCircuit(
        { from_ref: 3, circuit_ref: 3, rating_amps: 'thirty-two' },
        { circuits: { 3: {} } }
      )
    ).toEqual({ code: 'invalid_type', field: 'rating_amps' });
  });
  // from_ref lower-bound enforcement — moved out of input_schema (Anthropic
  // strict-mode rejects `minimum` on integer/number types).
  test('rejects invalid_from_ref when from_ref < 1', () => {
    expect(validateRenameCircuit({ from_ref: 0, circuit_ref: 7 }, { circuits: { 0: {} } })).toEqual(
      { code: 'invalid_from_ref', field: 'from_ref' }
    );
    expect(validateRenameCircuit({ from_ref: -3, circuit_ref: 7 }, { circuits: {} })).toEqual({
      code: 'invalid_from_ref',
      field: 'from_ref',
    });
  });
  test('rejects invalid_from_ref when from_ref is non-integer', () => {
    expect(validateRenameCircuit({ from_ref: 1.5, circuit_ref: 7 }, { circuits: {} })).toEqual({
      code: 'invalid_from_ref',
      field: 'from_ref',
    });
  });
});

describe('validateRecordObservation', () => {
  test('always returns null (no preconditions — strict:true handles enums at the API layer)', () => {
    expect(
      validateRecordObservation(
        { code: 'C2', text: 'loose terminal' },
        { extractedObservations: [] }
      )
    ).toBeNull();
  });
});

describe('validateDeleteObservation (BLOCK-2 contract: always-valid)', () => {
  test('observation_id present in session → null', () => {
    const session = { extractedObservations: [{ id: 'obs_1', text: 'x', code: 'C2' }] };
    expect(
      validateDeleteObservation({ observation_id: 'obs_1', reason: 'user_correction' }, session)
    ).toBeNull();
  });
  test('observation_id absent → still null (dispatcher handles noop outcome per Plan 02-04)', () => {
    const session = { extractedObservations: [{ id: 'obs_1', text: 'x', code: 'C2' }] };
    expect(
      validateDeleteObservation({ observation_id: 'missing', reason: 'user_correction' }, session)
    ).toBeNull();
  });
  test('session.extractedObservations missing entirely → still null (validator never throws)', () => {
    expect(
      validateDeleteObservation({ observation_id: 'whatever', reason: 'duplicate' }, {})
    ).toBeNull();
  });
});

/**
 * Stage 6 Phase 3 Plan 03-02 — validateAskUser (STS-07 runtime defence).
 *
 * The schema (strict:true) is the primary guard; this validator is belt-and-
 * braces for payload shape drift between the SDK, the dispatcher entry, and
 * the pending-asks registry. Mirrors the Phase 2 validator shape:
 *   (input) → null | { code, field? }
 *
 * First-failure-wins: validator short-circuits on the first problem it finds,
 * in the order question → reason → context_field → context_circuit →
 * expected_answer_shape. Plan 03-05's dispatcher logs the resulting
 * {code, field?} as answer_outcome='validation_error' and short-circuits with
 * a validation_error tool_result (no mutation, no prompt to the user).
 *
 * Failure-code namespace (must stay bounded — Phase 8 analyzer groups by
 * code; keep the set closed):
 *   invalid_question             — missing / empty / >500 chars / non-string
 *   invalid_reason               — not in ASK_USER_REASONS
 *   invalid_context_field        — non-null and not in CONTEXT_FIELD_ENUM
 *   invalid_context_circuit      — non-null and not an integer
 *   invalid_expected_answer_shape — not in ASK_USER_ANSWER_SHAPES
 */
describe('validateAskUser', () => {
  const validInput = () => ({
    question: 'Which circuit do you mean — 3 or 4?',
    reason: 'ambiguous_circuit',
    context_field: 'observation_clarify',
    context_circuit: 3,
    expected_answer_shape: 'circuit_ref',
  });

  describe('happy path', () => {
    test('fully populated valid input → null', () => {
      expect(validateAskUser(validInput())).toBeNull();
    });
    test('context_field=null AND context_circuit=null → null (schema allows)', () => {
      const input = { ...validInput(), context_field: null, context_circuit: null };
      expect(validateAskUser(input)).toBeNull();
    });
    test('question length exactly 500 chars → null (boundary)', () => {
      const input = { ...validInput(), question: 'a'.repeat(500) };
      expect(validateAskUser(input)).toBeNull();
    });
  });

  describe('invalid_question', () => {
    test('missing question field → {code:invalid_question, field:question}', () => {
      const input = { ...validInput() };
      delete input.question;
      expect(validateAskUser(input)).toEqual({ code: 'invalid_question', field: 'question' });
    });
    test('empty string question → {code:invalid_question, field:question}', () => {
      const input = { ...validInput(), question: '' };
      expect(validateAskUser(input)).toEqual({ code: 'invalid_question', field: 'question' });
    });
    test('question 501 chars → {code:invalid_question, field:question} (boundary)', () => {
      const input = { ...validInput(), question: 'a'.repeat(501) };
      expect(validateAskUser(input)).toEqual({ code: 'invalid_question', field: 'question' });
    });
    // Plan 03-12 r11 MAJOR remediation — whitespace-only question rejected.
    test('whitespace-only question (spaces) → invalid_question (r11 MAJOR fix)', () => {
      const input = { ...validInput(), question: '   ' };
      expect(validateAskUser(input)).toEqual({ code: 'invalid_question', field: 'question' });
    });
    test('whitespace-only question (tab + newline) → invalid_question', () => {
      const input = { ...validInput(), question: '\t\n\r  ' };
      expect(validateAskUser(input)).toEqual({ code: 'invalid_question', field: 'question' });
    });
    test('question with leading/trailing whitespace but real content → ACCEPTED (trim-only-for-empty-check)', () => {
      const input = { ...validInput(), question: '  Is the circuit energised?  ' };
      expect(validateAskUser(input)).toBeNull();
    });
  });

  describe('invalid_reason', () => {
    test('unknown reason value → {code:invalid_reason, field:reason}', () => {
      const input = { ...validInput(), reason: 'because_i_said_so' };
      expect(validateAskUser(input)).toEqual({ code: 'invalid_reason', field: 'reason' });
    });
    test('missing reason field → {code:invalid_reason, field:reason}', () => {
      const input = { ...validInput() };
      delete input.reason;
      expect(validateAskUser(input)).toEqual({ code: 'invalid_reason', field: 'reason' });
    });
  });

  describe('invalid_context_field', () => {
    test('non-null context_field not in CONTEXT_FIELD_ENUM → {code:invalid_context_field, field:context_field}', () => {
      const input = { ...validInput(), context_field: 'not_a_real_field_key' };
      expect(validateAskUser(input)).toEqual({
        code: 'invalid_context_field',
        field: 'context_field',
      });
    });
    test('context_field = 123 (non-string, non-null) → {code:invalid_context_field}', () => {
      const input = { ...validInput(), context_field: 123 };
      expect(validateAskUser(input)).toEqual({
        code: 'invalid_context_field',
        field: 'context_field',
      });
    });
  });

  describe('invalid_context_circuit', () => {
    test('context_circuit = 1.5 (non-integer) → {code:invalid_context_circuit, field:context_circuit}', () => {
      const input = { ...validInput(), context_circuit: 1.5 };
      expect(validateAskUser(input)).toEqual({
        code: 'invalid_context_circuit',
        field: 'context_circuit',
      });
    });
  });

  describe('invalid_expected_answer_shape', () => {
    test('unknown shape → {code:invalid_expected_answer_shape, field:expected_answer_shape}', () => {
      const input = { ...validInput(), expected_answer_shape: 'essay' };
      expect(validateAskUser(input)).toEqual({
        code: 'invalid_expected_answer_shape',
        field: 'expected_answer_shape',
      });
    });
  });

  describe('first-failure-wins short-circuit', () => {
    test('invalid question AND invalid reason → returns question failure first', () => {
      const input = { ...validInput(), question: '', reason: 'because_i_said_so' };
      expect(validateAskUser(input)).toEqual({ code: 'invalid_question', field: 'question' });
    });
  });
});
