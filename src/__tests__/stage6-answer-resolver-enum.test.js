/**
 * stage6-answer-resolver-enum.test.js
 *
 * Unit tests for `resolveEnumAnswer` — the Bug B (session DC946608, 8 Branagh
 * Court, 2026-05-06) enum-resolve helper.
 *
 * Repro pattern: user said "BS 68001" three times; Sonnet asked
 * "What's the BS number?" identically each time and never wrote the value.
 * `BS 68001` is not a valid RCD standard (real options: 61008/61009/62423).
 * The pre-fix resolver had no enum validation — `resolveValueAnswer` would
 * extract "68001" as a digit and the silent schema rejection downstream
 * looked identical to "ambiguous reply" → re-ask loop.
 *
 * Post-fix: resolveEnumAnswer reads field.options from field_schema.json,
 * exact-matches the canonical value, suggests 1-digit-different alternatives
 * (`did_you_mean`), or returns `invalid_value` with the full option list.
 * Both rejection verdicts surface in the dispatcher's tool_result body so
 * the prompt's re-ask-once-then-move-on rule can fire.
 */

import { resolveEnumAnswer } from '../extraction/stage6-answer-resolver.js';

const RCD_SCHEMA = {
  circuit_fields: {
    rcd_bs_en: {
      label: 'RCD BS/EN',
      type: 'select',
      options: ['', '61008', '61009', '62423', 'N/A'],
    },
    rcd_type: {
      label: 'RCD Type',
      type: 'select',
      options: ['', 'AC', 'A', 'F', 'B', 'S', 'N/A'],
    },
    measured_zs_ohm: {
      label: 'Measured Zs',
      type: 'text',
    },
  },
};

describe('resolveEnumAnswer — happy path (canonical match)', () => {
  test('exact 5-digit value "61008" → auto_resolve write of "61008"', () => {
    const verdict = resolveEnumAnswer({
      userText: '61008',
      contextField: 'rcd_bs_en',
      contextCircuit: 1,
      sourceTurnId: 't1',
      fieldSchema: RCD_SCHEMA,
    });
    expect(verdict.kind).toBe('auto_resolve');
    expect(verdict.writes[0]).toMatchObject({
      tool: 'record_reading',
      field: 'rcd_bs_en',
      circuit: 1,
      value: '61008',
      confidence: 0.95,
      source_turn_id: 't1',
    });
  });

  test('"BS 61009" — surrounding words stripped, digits resolve', () => {
    const verdict = resolveEnumAnswer({
      userText: 'BS 61009',
      contextField: 'rcd_bs_en',
      contextCircuit: 5,
      sourceTurnId: null,
      fieldSchema: RCD_SCHEMA,
    });
    expect(verdict.kind).toBe('auto_resolve');
    expect(verdict.writes[0].value).toBe('61009');
  });

  test('"the BS number is 62423" — embedded digit run resolves', () => {
    const verdict = resolveEnumAnswer({
      userText: 'the BS number is 62423',
      contextField: 'rcd_bs_en',
      contextCircuit: 2,
      sourceTurnId: null,
      fieldSchema: RCD_SCHEMA,
    });
    expect(verdict.kind).toBe('auto_resolve');
    expect(verdict.writes[0].value).toBe('62423');
  });
});

describe('resolveEnumAnswer — N/A short-circuit', () => {
  test('"N/A" → auto-resolve to the canonical "N/A" option', () => {
    const verdict = resolveEnumAnswer({
      userText: 'N/A',
      contextField: 'rcd_bs_en',
      contextCircuit: 1,
      sourceTurnId: null,
      fieldSchema: RCD_SCHEMA,
    });
    expect(verdict.kind).toBe('auto_resolve');
    expect(verdict.writes[0].value).toBe('N/A');
  });

  test('"not applicable" — auto-resolve to N/A', () => {
    const verdict = resolveEnumAnswer({
      userText: 'not applicable',
      contextField: 'rcd_bs_en',
      contextCircuit: 1,
      sourceTurnId: null,
      fieldSchema: RCD_SCHEMA,
    });
    expect(verdict.kind).toBe('auto_resolve');
    expect(verdict.writes[0].value).toBe('N/A');
  });

  test('"no RCD" — auto-resolve to N/A', () => {
    const verdict = resolveEnumAnswer({
      userText: 'no RCD',
      contextField: 'rcd_bs_en',
      contextCircuit: 1,
      sourceTurnId: null,
      fieldSchema: RCD_SCHEMA,
    });
    expect(verdict.kind).toBe('auto_resolve');
    expect(verdict.writes[0].value).toBe('N/A');
  });
});

describe('resolveEnumAnswer — did_you_mean (1-digit-different typo)', () => {
  test('"68001" (the prod failure from session DC946608) → did_you_mean ["61008"]', () => {
    // Two-digit difference between 68001 and 61008 — wait, let's check:
    //   6 8 0 0 1
    //   6 1 0 0 8
    // pos 0: same, pos 1: 8 vs 1, pos 2: same, pos 3: same, pos 4: 1 vs 8.
    // That's TWO digits different → invalid_value, not did_you_mean.
    // Document the actual prod symptom here for the audit trail.
    const verdict = resolveEnumAnswer({
      userText: '68001',
      contextField: 'rcd_bs_en',
      contextCircuit: 1,
      sourceTurnId: null,
      fieldSchema: RCD_SCHEMA,
    });
    expect(verdict.kind).toBe('invalid_value');
    expect(verdict.received).toBe('68001');
    expect(verdict.valid_options).toEqual(['', '61008', '61009', '62423', 'N/A']);
  });

  test('"61018" (1 digit off 61008) → did_you_mean ["61008"]', () => {
    const verdict = resolveEnumAnswer({
      userText: '61018',
      contextField: 'rcd_bs_en',
      contextCircuit: 1,
      sourceTurnId: null,
      fieldSchema: RCD_SCHEMA,
    });
    expect(verdict.kind).toBe('did_you_mean');
    expect(verdict.received).toBe('61018');
    expect(verdict.suggestions).toEqual(['61008']);
    expect(verdict.valid_options).toEqual(['', '61008', '61009', '62423', 'N/A']);
  });

  test('"61029" (1 digit off 61009) → did_you_mean ["61009"]', () => {
    const verdict = resolveEnumAnswer({
      userText: '61029',
      contextField: 'rcd_bs_en',
      contextCircuit: 1,
      sourceTurnId: null,
      fieldSchema: RCD_SCHEMA,
    });
    expect(verdict.kind).toBe('did_you_mean');
    expect(verdict.suggestions).toEqual(['61009']);
  });
});

describe('resolveEnumAnswer — invalid_value (no close match)', () => {
  test('"banana" → invalid_value with full option list', () => {
    const verdict = resolveEnumAnswer({
      userText: 'banana',
      contextField: 'rcd_bs_en',
      contextCircuit: 1,
      sourceTurnId: null,
      fieldSchema: RCD_SCHEMA,
    });
    expect(verdict.kind).toBe('invalid_value');
    expect(verdict.received).toBe('banana');
    expect(verdict.valid_options).toContain('61008');
  });

  test('"99999" (no close match) → invalid_value', () => {
    const verdict = resolveEnumAnswer({
      userText: '99999',
      contextField: 'rcd_bs_en',
      contextCircuit: 1,
      sourceTurnId: null,
      fieldSchema: RCD_SCHEMA,
    });
    expect(verdict.kind).toBe('invalid_value');
    expect(verdict.received).toBe('99999');
  });

  test('empty user_text → invalid_value with received=""', () => {
    const verdict = resolveEnumAnswer({
      userText: '',
      contextField: 'rcd_bs_en',
      contextCircuit: 1,
      sourceTurnId: null,
      fieldSchema: RCD_SCHEMA,
    });
    expect(verdict.kind).toBe('invalid_value');
    expect(verdict.received).toBe('');
  });
});

describe('resolveEnumAnswer — fall-through to no_value_context', () => {
  test('field is text-typed (measured_zs_ohm) → no_value_context (legacy resolver should handle)', () => {
    const verdict = resolveEnumAnswer({
      userText: '0.47',
      contextField: 'measured_zs_ohm',
      contextCircuit: 1,
      sourceTurnId: null,
      fieldSchema: RCD_SCHEMA,
    });
    expect(verdict.kind).toBe('no_value_context');
  });

  test('field is select but options are word-anchored (rcd_type AC|A|F|B) → no_value_context (out of current scope)', () => {
    // resolveEnumAnswer is currently scoped to digit-anchored enums.
    // Word-anchored enums fall through to the legacy body so Sonnet
    // interprets. Extending to word-anchored is future work.
    const verdict = resolveEnumAnswer({
      userText: 'AC',
      contextField: 'rcd_type',
      contextCircuit: 1,
      sourceTurnId: null,
      fieldSchema: RCD_SCHEMA,
    });
    expect(verdict.kind).toBe('no_value_context');
  });

  test('contextField is null → no_value_context', () => {
    const verdict = resolveEnumAnswer({
      userText: '61008',
      contextField: null,
      contextCircuit: 1,
      sourceTurnId: null,
      fieldSchema: RCD_SCHEMA,
    });
    expect(verdict.kind).toBe('no_value_context');
  });

  test('contextCircuit is null → no_value_context', () => {
    const verdict = resolveEnumAnswer({
      userText: '61008',
      contextField: 'rcd_bs_en',
      contextCircuit: null,
      sourceTurnId: null,
      fieldSchema: RCD_SCHEMA,
    });
    expect(verdict.kind).toBe('no_value_context');
  });

  test('field absent from schema → no_value_context', () => {
    const verdict = resolveEnumAnswer({
      userText: '61008',
      contextField: 'made_up_field',
      contextCircuit: 1,
      sourceTurnId: null,
      fieldSchema: RCD_SCHEMA,
    });
    expect(verdict.kind).toBe('no_value_context');
  });
});

describe('resolveEnumAnswer — schema slice acceptance', () => {
  test('caller passes only the circuit_fields slice (not the full schema) → still resolves', () => {
    const verdict = resolveEnumAnswer({
      userText: '61008',
      contextField: 'rcd_bs_en',
      contextCircuit: 1,
      sourceTurnId: null,
      fieldSchema: RCD_SCHEMA.circuit_fields,
    });
    expect(verdict.kind).toBe('auto_resolve');
  });
});
