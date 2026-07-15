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

import fssync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateRecordReading,
  validateClearReading,
  validateCreateCircuit,
  validateRenameCircuit,
  validateRecordObservation,
  validateDeleteObservation,
  validateAskUser,
  ASK_USER_REASONS,
} from '../extraction/stage6-dispatch-validation.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  // Codex r6-#1 — fixtures must use a REAL clearable circuit_fields key:
  // the old 'Ze_ohms' fixture was itself off-schema (a supply field), which
  // only passed because the validator never checked field membership.
  test('valid when circuit exists (field_not_set is a dispatcher-level noop, NOT a validator rejection)', () => {
    expect(
      validateClearReading({ circuit: 3, field: 'measured_zs_ohm' }, { circuits: { 3: {} } })
    ).toBeNull();
  });
  test('rejects when circuit is absent', () => {
    expect(
      validateClearReading({ circuit: 99, field: 'measured_zs_ohm' }, { circuits: { 3: {} } })
    ).toEqual({
      code: 'circuit_not_found',
      field: 'circuit',
    });
  });
  test.each(['circuit_ref', 'is_distribution_circuit', 'feeds_board_id'])(
    'Codex r6-#1 — excluded field %s is rejected at RUNTIME (schema enum alone is not enforced)',
    (field) => {
      expect(validateClearReading({ circuit: 3, field }, { circuits: { 3: {} } })).toEqual({
        code: 'field_not_clearable',
        field: 'field',
        value: field,
      });
    }
  );
  test('Codex r6-#1 — unknown off-schema field is rejected, and BEFORE circuit existence', () => {
    expect(validateClearReading({ circuit: 99, field: 'Ze_ohms' }, { circuits: {} })).toEqual({
      code: 'field_not_clearable',
      field: 'field',
      value: 'Ze_ohms',
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

  // F1AC26FB #5.2 — implausible scratch/temp ref guard (the junk circuit
  // 999 "(temp)" Sonnet invented as swap scratch space).
  test('rejects implausible ref 999 (>= 100 absolute cap)', () => {
    expect(validateCreateCircuit({ circuit_ref: 999 }, { circuits: { 1: {}, 2: {} } })).toEqual({
      code: 'implausible_circuit_ref',
      field: 'circuit_ref',
      max_existing_ref: 2,
      hint: 'Do not create scratch/temp circuits for swaps; update existing circuit designations with rename_circuit.',
    });
  });

  test('rejects a ref far above the current max (> maxExistingRef + 20)', () => {
    expect(
      validateCreateCircuit({ circuit_ref: 30 }, { circuits: { 1: {}, 2: {}, 3: {} } })
    ).toEqual({
      code: 'implausible_circuit_ref',
      field: 'circuit_ref',
      max_existing_ref: 3,
      hint: 'Do not create scratch/temp circuits for swaps; update existing circuit designations with rename_circuit.',
    });
  });

  test('accepts the next normal ref just above the current max', () => {
    expect(
      validateCreateCircuit({ circuit_ref: 4 }, { circuits: { 1: {}, 2: {}, 3: {} } })
    ).toBeNull();
  });

  test('accepts a sensible first circuit on an empty board', () => {
    expect(validateCreateCircuit({ circuit_ref: 1 }, { circuits: {} })).toBeNull();
  });

  test('implausible ref that already exists is reported as already-exists, not implausible', () => {
    // The existing-circuit check runs first, so re-creating circuit 999 (if
    // it somehow already exists) surfaces the existing-circuit code.
    expect(validateCreateCircuit({ circuit_ref: 999 }, { circuits: { 999: {} } })).toEqual({
      code: 'circuit_already_exists',
      field: 'circuit_ref',
    });
  });
});

describe('validateRenameCircuit', () => {
  test('valid when from_ref exists and target circuit_ref is free', () => {
    expect(
      validateRenameCircuit({ from_ref: 3, circuit_ref: 7 }, { circuits: { 3: {} } })
    ).toBeNull();
  });
  test('rejects source_not_found when from_ref is absent (with recovery hint + existing refs)', () => {
    // 2026-06-12 (session 15B88D6B, voiceFeedbackId 22): bare {code, field}
    // gave Sonnet nothing to recover with after a merged-stutter utterance
    // produced rename_circuit(1→2) on an empty board — the dictated
    // designation was silently lost. The error now carries the existing
    // circuit refs and a create_circuit/ask_user recovery hint.
    const err = validateRenameCircuit({ from_ref: 99, circuit_ref: 7 }, { circuits: { 3: {} } });
    expect(err.code).toBe('source_not_found');
    expect(err.field).toBe('from_ref');
    expect(err.existing_refs).toEqual([3]);
    expect(err.hint).toMatch(/create_circuit/);
    expect(err.hint).toMatch(/ask_user/);
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
  // 2026-06-03 — validator now requires `suggested_regulation` to be a
  // non-empty string when `code` is C1/C2/C3/FI. Field-test session
  // C112923C ("outside light not RCD protected" → C2 with null
  // regulation → blank reg on the iOS UI) was the trigger. NC and
  // installation-wide observations can legitimately have null reg.
  test('coded observation with non-empty regulation → null (accept)', () => {
    expect(
      validateRecordObservation(
        { code: 'C2', text: 'loose terminal', suggested_regulation: '526.1' },
        { extractedObservations: [] }
      )
    ).toBeNull();
  });

  test('coded observation with null regulation → REJECT (regulation_required_for_coded_observation)', () => {
    const err = validateRecordObservation(
      { code: 'C2', text: 'loose terminal', suggested_regulation: null },
      { extractedObservations: [] }
    );
    expect(err).toMatchObject({
      code: 'regulation_required_for_coded_observation',
      field: 'suggested_regulation',
    });
    expect(err.reason).toMatch(/C2.*regulation/);
  });

  test('coded observation with whitespace-only regulation → REJECT (empty-string guard)', () => {
    const err = validateRecordObservation(
      { code: 'C3', text: 'minor non-compliance', suggested_regulation: '   ' },
      { extractedObservations: [] }
    );
    expect(err).toMatchObject({ code: 'regulation_required_for_coded_observation' });
  });

  test('coded observation with regulation field absent entirely → REJECT', () => {
    const err = validateRecordObservation(
      { code: 'FI', text: 'requires investigation' },
      { extractedObservations: [] }
    );
    expect(err).toMatchObject({ code: 'regulation_required_for_coded_observation' });
  });

  test('NC observation with null regulation → accept (NC may not have a specific reg)', () => {
    expect(
      validateRecordObservation(
        { code: 'NC', text: 'historic non-conformity', suggested_regulation: null },
        { extractedObservations: [] }
      )
    ).toBeNull();
  });

  test('lower-case code "c2" still triggers the check (case-insensitive)', () => {
    const err = validateRecordObservation(
      { code: 'c2', text: 'loose terminal', suggested_regulation: null },
      { extractedObservations: [] }
    );
    expect(err).toMatchObject({ code: 'regulation_required_for_coded_observation' });
  });

  test('non-object input → null (validator never throws)', () => {
    expect(validateRecordObservation(null, {})).toBeNull();
    expect(validateRecordObservation(undefined, {})).toBeNull();
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
 *   invalid_context_circuits     — present but not a unique-int array of length >= 2 with all >= 1
 *   context_circuit_conflict     — BOTH context_circuit and context_circuits set (XOR violation)
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

    // Regression — field session CBC1C763 (2026-05-09). Sonnet emitted a
    // focused follow-up `ask_user` with `context_field: "feed_circuit_ref"`
    // mid-add_board. Pre-fix the validator pre-rejected the ask as
    // `invalid_context_field`, the focused question never reached the
    // inspector, and Sonnet fell back to a missing-field add_board that
    // the dispatcher rightly rejected. Inspector got stuck in the loop and
    // could never create a sub-board. The widened CONTEXT_FIELD_ENUM covers
    // these board-hierarchy + sub-main + supply + installation keys.
    test.each([
      'feed_circuit_ref',
      'parent_board_id',
      'board_type',
      'sub_main_cable_material',
      'sub_main_cable_csa',
      'sub_main_cpc_csa',
      'earth_loop_impedance_ze',
      'address',
      'postcode',
      'prospective_fault_current',
    ])('context_field=%p → null (board/supply/install fields are now legal scopes)', (key) => {
      const input = { ...validInput(), context_field: key };
      expect(validateAskUser(input)).toBeNull();
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

  // 2026-05-26 — session 1B496E8A turn-2 repro. Sonnet emitted a recovery
  // ask ("Sorry, I didn't catch that…") in response to chitchat WITHOUT
  // either context_field or context_circuit on the input (both nullable
  // per the tool schema). Pre-fix, the validator's `!== null` guard let
  // `undefined` through to enum/integer checks, which both returned false,
  // and the ask was rejected with `invalid_context_circuit` →
  // tool_error_count_per_round[0]=1 → SonnetStream disconnected ~2s later.
  // Coercing undefined → null pre-check matches the dispatcher's own
  // logging path (`input.context_circuit ?? null`) and the schema's
  // nullable contract (absent key === null).
  describe('missing-key tolerance (undefined === null per schema)', () => {
    test('context_field absent → null → passes', () => {
      const input = validInput();
      delete input.context_field;
      expect(validateAskUser(input)).toBeNull();
    });
    test('context_circuit absent → null → passes', () => {
      const input = validInput();
      delete input.context_circuit;
      expect(validateAskUser(input)).toBeNull();
    });
    test('both context fields absent → passes (the session 1B496E8A recovery-ask shape)', () => {
      const input = validInput();
      delete input.context_field;
      delete input.context_circuit;
      expect(validateAskUser(input)).toBeNull();
    });
    test('context_circuit absent AND context_field="none" → passes (chitchat recovery)', () => {
      const input = validInput();
      delete input.context_circuit;
      input.context_field = 'none';
      expect(validateAskUser(input)).toBeNull();
    });
    test('explicit context_circuit:undefined → passes', () => {
      const input = { ...validInput(), context_circuit: undefined };
      expect(validateAskUser(input)).toBeNull();
    });
    test('explicit context_field:undefined → passes', () => {
      const input = { ...validInput(), context_field: undefined };
      expect(validateAskUser(input)).toBeNull();
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

  describe('context_circuits (multi-circuit ask — session C0C21546 2026-06-04)', () => {
    const pluralBase = () => ({
      ...validInput(),
      context_field: 'wiring_type',
      context_circuit: null,
      context_circuits: [2, 3],
    });

    test('happy path: well-formed [2, 3] → null', () => {
      expect(validateAskUser(pluralBase())).toBeNull();
    });

    test('happy path: [2, 3, 7] (3+ entries) → null', () => {
      expect(validateAskUser({ ...pluralBase(), context_circuits: [2, 3, 7] })).toBeNull();
    });

    test('happy path: explicitly null → null', () => {
      expect(validateAskUser({ ...validInput(), context_circuits: null })).toBeNull();
    });

    test('happy path: explicitly undefined → null', () => {
      expect(validateAskUser({ ...validInput(), context_circuits: undefined })).toBeNull();
    });

    test('invalid: string instead of array → invalid_context_circuits', () => {
      const input = { ...pluralBase(), context_circuits: '2,3' };
      expect(validateAskUser(input)).toEqual({
        code: 'invalid_context_circuits',
        field: 'context_circuits',
      });
    });

    test('invalid: single-element array [2] → invalid_context_circuits', () => {
      const input = { ...pluralBase(), context_circuits: [2] };
      expect(validateAskUser(input)).toEqual({
        code: 'invalid_context_circuits',
        field: 'context_circuits',
      });
    });

    test('invalid: empty array → invalid_context_circuits', () => {
      const input = { ...pluralBase(), context_circuits: [] };
      expect(validateAskUser(input)).toEqual({
        code: 'invalid_context_circuits',
        field: 'context_circuits',
      });
    });

    test('invalid: duplicate values [2, 2] → invalid_context_circuits', () => {
      const input = { ...pluralBase(), context_circuits: [2, 2] };
      expect(validateAskUser(input)).toEqual({
        code: 'invalid_context_circuits',
        field: 'context_circuits',
      });
    });

    test('invalid: non-integer entry ["a", 2] → invalid_context_circuits', () => {
      const input = { ...pluralBase(), context_circuits: ['a', 2] };
      expect(validateAskUser(input)).toEqual({
        code: 'invalid_context_circuits',
        field: 'context_circuits',
      });
    });

    test('invalid: zero entry [0, 2] → invalid_context_circuits (board-level sentinel excluded)', () => {
      const input = { ...pluralBase(), context_circuits: [0, 2] };
      expect(validateAskUser(input)).toEqual({
        code: 'invalid_context_circuits',
        field: 'context_circuits',
      });
    });

    test('invalid: negative entry [-1, 2] → invalid_context_circuits', () => {
      const input = { ...pluralBase(), context_circuits: [-1, 2] };
      expect(validateAskUser(input)).toEqual({
        code: 'invalid_context_circuits',
        field: 'context_circuits',
      });
    });

    test('XOR violation: BOTH context_circuit:5 AND context_circuits:[2,3] set → context_circuit_conflict', () => {
      const input = {
        ...validInput(),
        context_field: 'wiring_type',
        context_circuit: 5,
        context_circuits: [2, 3],
      };
      expect(validateAskUser(input)).toEqual({
        code: 'context_circuit_conflict',
        field: 'context_circuits',
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

// 2026-06-03 (Bug 1c sprint) — lockstep guard. The hand-rolled
// ASK_USER_REASONS array in stage6-dispatch-validation.js is the runtime
// guard; the JSON enum in config/stage6-enumerations.json drives the
// tool schema. There is no codegen — they are aligned by convention.
// Pre-fix, Sonnet 4.6 emitted `missing_field_and_context` (a value
// already implied by the prompt's "missing_field" / "missing_value"
// wording on lines 78-79 of sonnet_agentic_system.md), the schema
// rejected it before dispatch, and the validator's copy never got a
// chance to weigh in. This test fails loudly if the pair ever drifts
// again.
describe('ASK_USER_REASONS ⇔ stage6-enumerations.json lockstep', () => {
  test('validator constant deep-equals the JSON enum (order-independent)', () => {
    const enumsPath = path.join(__dirname, '..', '..', 'config', 'stage6-enumerations.json');
    const raw = fssync.readFileSync(enumsPath, 'utf8');
    const enums = JSON.parse(raw);
    const fromJson = [...enums.ask_user_reason].sort();
    const fromValidator = [...ASK_USER_REASONS].sort();
    expect(fromValidator).toEqual(fromJson);
  });
});
