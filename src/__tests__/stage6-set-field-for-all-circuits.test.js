/**
 * stage6-set-field-for-all-circuits.test.js
 *
 * Tests for the new bulk-set tool (Bug A from session DC946608, 8 Branagh
 * Court, 2026-05-06). Inspector said "set the RCD test button to pass for
 * all circuits"; Sonnet emitted 7 record_reading calls for circuits 1-7
 * of 14 and stopped — the second half stayed at ✗ in the saved snapshot.
 * Replacing the burst pattern with one server-iterated call removes the
 * model-behaviour fragility entirely.
 *
 * Coverage:
 *   - happy path (default scope = non_spare): 14 active circuits → 14 writes
 *   - scope=non_spare drops circuits whose designation contains "spare"
 *   - scope=rcd_protected_only keeps only RCD-bearing circuits
 *   - scope=all is the no-filter passthrough
 *   - validation rejects: missing field/value, malformed confidence,
 *     missing source_turn_id, unknown scope
 *   - per-turn writes Map carries every applied entry with the MAJOR-1
 *     locked {value, confidence, source_turn_id} shape
 *   - applied/skipped breakdown returned in the envelope
 *
 * The test invokes the dispatcher through `createWriteDispatcher` (the
 * factory that owns the round counter), not the inner module function.
 * Same convention as `stage6-dispatchers-reading.test.js`.
 */

import { jest } from '@jest/globals';
import { createWriteDispatcher } from '../extraction/stage6-dispatchers.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function toolCallRows(logger) {
  return logger.info.mock.calls.filter((c) => c[0] === 'stage6_tool_call').map((c) => c[1]);
}

// Build a 14-circuit snapshot mirroring session DC946608's shape: 14 active
// circuits (1-14), no spares. Field bucket starts empty.
function build14CircuitSession({ overrides = {} } = {}) {
  const circuits = { 0: {} }; // supply bucket
  for (let n = 1; n <= 14; n += 1) {
    circuits[n] = { circuit_designation: `Circuit ${n}`, ...(overrides[n] ?? {}) };
  }
  return { sessionId: 's-bulk', stateSnapshot: { circuits }, extractedObservations: [] };
}

// rcd_button_confirmed is a select field with options ["", "OK", "Y", "N"]
// (field_schema.json:151-156). Use the canonical "OK" — the user-spoken
// "pass" that triggered the original bug is not in the enum and would now
// (correctly) be rejected by the value-against-options check that
// dispatchSetFieldForAllCircuits enforces. Sonnet is expected to map
// "pass" → "OK" client-side before emitting the tool call; the schema
// validation is defence in depth against off-enum slips.
const validInput = (overrides = {}) => ({
  field: 'rcd_button_confirmed',
  value: 'OK',
  confidence: 0.95,
  source_turn_id: 't1',
  ...overrides,
});

describe('dispatchSetFieldForAllCircuits — happy path', () => {
  test('14 active circuits, default scope=non_spare → 14 writes, snapshot mutated, log ok', async () => {
    const session = build14CircuitSession();
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      { tool_call_id: 'tu_bulk', name: 'set_field_for_all_circuits', input: validInput() },
      {}
    );

    expect(result.is_error).toBe(false);
    const body = JSON.parse(result.content);
    expect(body.ok).toBe(true);
    expect(body.applied).toHaveLength(14);
    expect(body.skipped).toEqual([]);

    // Every active circuit has rcd_button_confirmed=OK in the snapshot.
    for (let n = 1; n <= 14; n += 1) {
      expect(session.stateSnapshot.circuits[n].rcd_button_confirmed).toBe('OK');
    }

    // perTurnWrites carries 14 entries with MAJOR-1 shape.
    expect(writes.readings.size).toBe(14);
    expect(writes.readings.get('rcd_button_confirmed::5')).toEqual({
      value: 'OK',
      confidence: 0.95,
      source_turn_id: 't1',
    });

    const rows = toolCallRows(logger);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tool: 'set_field_for_all_circuits',
      outcome: 'ok',
      is_error: false,
      input_summary: {
        field: 'rcd_button_confirmed',
        scope: 'non_spare',
        applied_count: 14,
        skipped_count: 0,
      },
    });
  });
});

describe('dispatchSetFieldForAllCircuits — scope filtering', () => {
  test('scope=non_spare skips circuits whose designation contains "spare" (case-insensitive)', async () => {
    const session = build14CircuitSession({
      overrides: {
        12: { circuit_designation: 'Spare' },
        13: { circuit_designation: 'spare RCBO' },
        14: { circuit_designation: 'SPARE for upstairs' },
      },
    });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      { tool_call_id: 'tu_bulk', name: 'set_field_for_all_circuits', input: validInput() },
      {}
    );

    const body = JSON.parse(result.content);
    expect(body.applied).toHaveLength(11);
    expect(body.skipped).toEqual(
      expect.arrayContaining([
        { circuit_ref: 12, reason: 'spare_circuit' },
        { circuit_ref: 13, reason: 'spare_circuit' },
        { circuit_ref: 14, reason: 'spare_circuit' },
      ])
    );
    // Snapshot: spares untouched.
    expect(session.stateSnapshot.circuits[12].rcd_button_confirmed).toBeUndefined();
    expect(session.stateSnapshot.circuits[13].rcd_button_confirmed).toBeUndefined();
    expect(session.stateSnapshot.circuits[14].rcd_button_confirmed).toBeUndefined();
  });

  test('scope=all does NOT filter spares — every active circuit gets the write', async () => {
    const session = build14CircuitSession({
      overrides: { 14: { circuit_designation: 'Spare' } },
    });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_bulk',
        name: 'set_field_for_all_circuits',
        input: validInput({ scope: 'all' }),
      },
      {}
    );

    const body = JSON.parse(result.content);
    expect(body.applied).toHaveLength(14);
    expect(body.skipped).toEqual([]);
    expect(session.stateSnapshot.circuits[14].rcd_button_confirmed).toBe('OK');
  });

  test('scope=non_spare also skips circuits with EMPTY designation (real spares often have circuit_designation="")', async () => {
    // Code review bug 2 — production spare slots are typically blank, not
    // literally named "Spare". The pre-fix filter only caught the literal
    // string and would have applied bulk writes to every blank trailing
    // slot in a real-world dual-RCD board.
    const session = build14CircuitSession({
      overrides: {
        12: { circuit_designation: '' },
        13: { circuit_designation: null },
        14: { circuit_designation: '   ' }, // whitespace-only
      },
    });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);
    const result = await d(
      { tool_call_id: 'tu_bulk', name: 'set_field_for_all_circuits', input: validInput() },
      {}
    );
    const body = JSON.parse(result.content);
    expect(body.applied).toHaveLength(11);
    expect(body.skipped.map((s) => s.circuit_ref).sort((a, b) => a - b)).toEqual([12, 13, 14]);
    expect(body.skipped.every((s) => s.reason === 'spare_circuit')).toBe(true);
  });

  test('scope=non_spare does NOT skip "non-spare" — word-boundary match (regression for substring bug)', async () => {
    // Code review bug 3 — the pre-fix `.includes('spare')` falsely matched
    // "non-spare" (substring of "non-spare" is "spare"). Real-world impact
    // low (no inspector names a circuit that) but the cleaner check is a
    // word-boundary regex.
    const session = build14CircuitSession({
      overrides: { 14: { circuit_designation: 'Non-spare backup' } },
    });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);
    const result = await d(
      { tool_call_id: 'tu_bulk', name: 'set_field_for_all_circuits', input: validInput() },
      {}
    );
    const body = JSON.parse(result.content);
    // All 14 applied — "non-spare" does NOT contain the whole word "spare".
    expect(body.applied).toHaveLength(14);
    expect(session.stateSnapshot.circuits[14].rcd_button_confirmed).toBe('OK');
  });

  test('scope=rcd_protected_only keeps only circuits with rcd_bs_en or rcd_type explicitly set', async () => {
    // Code review bug 1 — rcd_operating_current_ma is DELIBERATELY excluded
    // because field_schema.json:166 declares its default as "30". Including
    // it would tag every circuit as RCD-protected (verified against session
    // DC946608's snapshot — every circuit had rcd_operating_current_ma="30"
    // regardless of actual RCD bank membership).
    //
    // Circuits 1-2 + 4-7 have explicit rcd_bs_en or rcd_type → kept.
    // Circuit 3 has ONLY rcd_operating_current_ma="30" (the default-leak
    // shape) → dropped under the corrected check. Pre-fix this circuit
    // would have been falsely tagged as RCD-protected.
    const session = build14CircuitSession({
      overrides: {
        1: { circuit_designation: 'Cooker', rcd_bs_en: '61009' },
        2: { circuit_designation: 'Sockets', rcd_type: 'AC' },
        3: { circuit_designation: 'Smokes', rcd_operating_current_ma: '30' },
        4: { circuit_designation: 'Lights', rcd_bs_en: '61009' },
        5: { circuit_designation: 'Lights 2', rcd_bs_en: '61009' },
        6: { circuit_designation: 'Heater 1', rcd_bs_en: '61009' },
        7: { circuit_designation: 'Heater 2', rcd_bs_en: '61009' },
      },
    });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_bulk',
        name: 'set_field_for_all_circuits',
        input: validInput({ scope: 'rcd_protected_only' }),
      },
      {}
    );

    const body = JSON.parse(result.content);
    // Circuits 1, 2, 4, 5, 6, 7 → applied. Circuit 3 (default-leak shape)
    // and 8-14 (no RCD fields) → skipped.
    expect(body.applied.map((a) => a.circuit).sort((a, b) => a - b)).toEqual([1, 2, 4, 5, 6, 7]);
    expect(body.skipped.map((s) => s.circuit_ref).sort((a, b) => a - b)).toEqual([
      3, 8, 9, 10, 11, 12, 13, 14,
    ]);
    expect(body.skipped.every((s) => s.reason === 'no_rcd')).toBe(true);
  });

  test('scope=rcd_protected_only — production default-leak regression: every circuit having rcd_operating_current_ma="30" must NOT mark them all RCD-protected', async () => {
    // Direct repro of the code-review-flagged bug. In session DC946608's
    // snapshot every circuit (RCD or not) carried rcd_operating_current_ma
    // ="30" because the schema default leaks through. The corrected check
    // ignores rcd_operating_current_ma entirely; with no rcd_bs_en or
    // rcd_type set, every circuit must be skipped as no_rcd.
    const session = build14CircuitSession({
      overrides: Object.fromEntries(
        Array.from({ length: 14 }, (_, i) => [
          i + 1,
          {
            circuit_designation: `Circuit ${i + 1}`,
            rcd_operating_current_ma: '30',
          },
        ])
      ),
    });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);
    const result = await d(
      {
        tool_call_id: 'tu_bulk',
        name: 'set_field_for_all_circuits',
        input: validInput({ scope: 'rcd_protected_only' }),
      },
      {}
    );
    const body = JSON.parse(result.content);
    expect(body.applied).toEqual([]);
    expect(body.skipped).toHaveLength(14);
    expect(body.skipped.every((s) => s.reason === 'no_rcd')).toBe(true);
  });
});

describe('dispatchSetFieldForAllCircuits — validation rejection', () => {
  async function runWith(input) {
    const session = build14CircuitSession();
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);
    const result = await d(
      { tool_call_id: 'tu_bulk', name: 'set_field_for_all_circuits', input },
      {}
    );
    return { result, body: JSON.parse(result.content), writes };
  }

  test('missing field → invalid_field, no writes, is_error:true', async () => {
    const { result, body, writes } = await runWith({
      value: 'pass',
      confidence: 0.95,
      source_turn_id: 't1',
    });
    expect(result.is_error).toBe(true);
    expect(body.error.code).toBe('invalid_field');
    expect(writes.readings.size).toBe(0);
  });

  test('non-string value → invalid_value, no writes', async () => {
    const { body, writes } = await runWith(validInput({ value: 42 }));
    expect(body.error.code).toBe('invalid_value');
    expect(writes.readings.size).toBe(0);
  });

  test('confidence > 1 → invalid_confidence', async () => {
    const { body } = await runWith(validInput({ confidence: 1.5 }));
    expect(body.error.code).toBe('invalid_confidence');
  });

  test('missing source_turn_id → invalid_source_turn_id', async () => {
    // Use a CANONICAL value ("OK") so the value-against-options check
    // passes and validation continues to source_turn_id. With "pass"
    // the validator would reject earlier with value_not_in_options.
    const { body } = await runWith({
      field: 'rcd_button_confirmed',
      value: 'OK',
      confidence: 0.9,
    });
    expect(body.error.code).toBe('invalid_source_turn_id');
  });

  test('unknown scope → invalid_scope', async () => {
    const { body } = await runWith(validInput({ scope: 'kitchen_only' }));
    expect(body.error.code).toBe('invalid_scope');
  });

  test('unknown field (not in circuit_fields schema) → unknown_field, NO writes (defence in depth: Bug-E removed strict:true)', async () => {
    const { result, body, writes } = await runWith(validInput({ field: 'made_up_field_name' }));
    expect(result.is_error).toBe(true);
    expect(body.error.code).toBe('unknown_field');
    expect(writes.readings.size).toBe(0);
  });

  test('select-typed field with off-enum value → value_not_in_options, NO writes — option list returned in error envelope', async () => {
    // Code review bug 4 — bulk write previously bypassed
    // validateRecordReading's enum check, so an invalid value would have
    // been written to every circuit at once. The corrected validator
    // rejects with the option list so Sonnet can self-correct in one
    // round-trip.
    const { result, body, writes } = await runWith(
      // rcd_button_confirmed options are ["", "OK", "Y", "N"] — "pass" is
      // exactly the spoken token that triggered session DC946608's bug.
      validInput({ value: 'pass' })
    );
    expect(result.is_error).toBe(true);
    expect(body.error.code).toBe('value_not_in_options');
    expect(body.error.valid_options).toEqual(['', 'OK', 'Y', 'N']);
    expect(writes.readings.size).toBe(0);
  });

  test('text-typed field accepts any string (no enum to validate against)', async () => {
    // measured_zs_ohm is type:text. Any string value flows through.
    const { result, body, writes } = await runWith(
      validInput({ field: 'measured_zs_ohm', value: '0.47' })
    );
    expect(result.is_error).toBe(false);
    expect(body.ok).toBe(true);
    expect(body.applied).toHaveLength(14);
    expect(writes.readings.get('measured_zs_ohm::5').value).toBe('0.47');
  });

  test('select-typed field with empty-string value (canonical "clear") is accepted — "" is a valid option', async () => {
    // Bulk-clear semantics: an empty value across all circuits is the
    // intended way to wipe a field. "" is in rcd_button_confirmed's option
    // list, so the validator must accept it.
    const { result, body } = await runWith(validInput({ value: '' }));
    expect(result.is_error).toBe(false);
    expect(body.applied).toHaveLength(14);
  });
});

describe('dispatchSetFieldForAllCircuits — empty schedule + supply-only safety', () => {
  test('empty circuits map → ok with applied=[], skipped=[], outcome=noop', async () => {
    const session = { sessionId: 's-empty', stateSnapshot: { circuits: { 0: {} } } };
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);
    const result = await d(
      { tool_call_id: 'tu_bulk', name: 'set_field_for_all_circuits', input: validInput() },
      {}
    );
    const body = JSON.parse(result.content);
    expect(body.ok).toBe(true);
    expect(body.applied).toEqual([]);
    expect(body.skipped).toEqual([]);
    expect(toolCallRows(logger)[0].outcome).toBe('noop');
  });

  test('supply bucket (circuit 0) is NEVER written even when present', async () => {
    const session = build14CircuitSession();
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);
    await d(
      { tool_call_id: 'tu_bulk', name: 'set_field_for_all_circuits', input: validInput() },
      {}
    );
    expect(session.stateSnapshot.circuits[0].rcd_button_confirmed).toBeUndefined();
  });
});
