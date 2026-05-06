/**
 * stage6-answer-resolver-enum.test.js
 *
 * Unit tests for `resolveEnumAnswer` — the Bug B (session DC946608, 8 Branagh
 * Court, 2026-05-06) enum-resolve helper.
 *
 * Repro pattern: user said "BS 68001" three times; Sonnet asked
 * "What's the BS number?" identically each time and never wrote the value.
 * `BS 68001` is not a valid RCD standard (real options: BS EN 61008/61009/62423).
 * The pre-fix resolver had no enum validation — `resolveValueAnswer` would
 * extract "68001" as a digit and the silent schema rejection downstream
 * looked identical to "ambiguous reply" → re-ask loop.
 *
 * Post-fix: resolveEnumAnswer reads field.options from field_schema.json,
 * exact-matches the canonical value, suggests 1-digit-different alternatives
 * (`did_you_mean`), or returns `invalid_value` with the full option list.
 * Both rejection verdicts surface in the dispatcher's tool_result body so
 * the prompt's re-ask-once-then-move-on rule can fire.
 *
 * Schema canonicals updated 2026-05-06 (BS-EN alignment sprint, Option B):
 * options now use the prefixed form ('BS EN 60898' etc.) matching iOS
 * `Constants.swift` ocpdBsEnOptions / rcdBsEnOptions and what `parseBsCode`
 * writes from dictation. The digit-comparison resolver is form-agnostic
 * (compares on the digit-only normalised form) so the matching logic is
 * unchanged — only the WRITTEN canonical changes.
 */

import { resolveEnumAnswer } from '../extraction/stage6-answer-resolver.js';

const RCD_SCHEMA = {
  circuit_fields: {
    rcd_bs_en: {
      label: 'RCD BS/EN',
      type: 'select',
      options: ['', 'BS EN 61008', 'BS EN 61009', 'BS EN 62423', 'N/A'],
    },
    // ocpd_bs_en exercises the mixed-format option list (BS-EN-prefixed,
    // hyphenated suffix, bare-BS prefix). Options aligned with what the
    // CCU pipeline writes via BS_EN_LOOKUP at src/routes/extraction.js:257
    // and the iOS picker.
    ocpd_bs_en: {
      label: 'OCPD BS/EN',
      type: 'select',
      options: [
        '',
        'BS EN 60898',
        'BS EN 61009',
        'BS EN 60947-2',
        'BS EN 60947-3',
        'BS EN 60269-2',
        'BS 3036',
        'BS 1361',
        'N/A',
      ],
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

const RCD_OPTIONS = ['', 'BS EN 61008', 'BS EN 61009', 'BS EN 62423', 'N/A'];

describe('resolveEnumAnswer — happy path (canonical match)', () => {
  test('exact 5-digit value "61008" → auto_resolve write of "BS EN 61008"', () => {
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
      value: 'BS EN 61008',
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
    expect(verdict.writes[0].value).toBe('BS EN 61009');
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
    expect(verdict.writes[0].value).toBe('BS EN 62423');
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

describe('resolveEnumAnswer — did_you_mean (Levenshtein-1: substitution / insertion / deletion)', () => {
  test('"68001" (the prod failure from session DC946608) → invalid_value (two substitutions, beyond Lev-1)', () => {
    // 68001 vs 61008: positions 1 + 4 differ → distance 2.
    // Documents the exact prod symptom for the audit trail.
    const verdict = resolveEnumAnswer({
      userText: '68001',
      contextField: 'rcd_bs_en',
      contextCircuit: 1,
      sourceTurnId: null,
      fieldSchema: RCD_SCHEMA,
    });
    expect(verdict.kind).toBe('invalid_value');
    expect(verdict.received).toBe('68001');
    expect(verdict.valid_options).toEqual(RCD_OPTIONS);
  });

  test('substitution: "61018" (1 digit off 61008) → did_you_mean ["BS EN 61008"]', () => {
    const verdict = resolveEnumAnswer({
      userText: '61018',
      contextField: 'rcd_bs_en',
      contextCircuit: 1,
      sourceTurnId: null,
      fieldSchema: RCD_SCHEMA,
    });
    expect(verdict.kind).toBe('did_you_mean');
    expect(verdict.received).toBe('61018');
    expect(verdict.suggestions).toEqual(['BS EN 61008']);
    expect(verdict.valid_options).toEqual(RCD_OPTIONS);
  });

  test('substitution: "61029" (1 digit off 61009) → did_you_mean ["BS EN 61009"]', () => {
    const verdict = resolveEnumAnswer({
      userText: '61029',
      contextField: 'rcd_bs_en',
      contextCircuit: 1,
      sourceTurnId: null,
      fieldSchema: RCD_SCHEMA,
    });
    expect(verdict.kind).toBe('did_you_mean');
    expect(verdict.suggestions).toEqual(['BS EN 61009']);
  });

  test('deletion: "6100" (1 deletion from 61008) → did_you_mean contains "BS EN 61008" — Deepgram drift pattern the equal-length helper missed', () => {
    const verdict = resolveEnumAnswer({
      userText: '6100',
      contextField: 'rcd_bs_en',
      contextCircuit: 1,
      sourceTurnId: null,
      fieldSchema: RCD_SCHEMA,
    });
    expect(verdict.kind).toBe('did_you_mean');
    expect(verdict.suggestions).toContain('BS EN 61008');
  });

  test('insertion: "610008" (1 insertion in 61008) → did_you_mean contains "BS EN 61008"', () => {
    const verdict = resolveEnumAnswer({
      userText: '610008',
      contextField: 'rcd_bs_en',
      contextCircuit: 1,
      sourceTurnId: null,
      fieldSchema: RCD_SCHEMA,
    });
    expect(verdict.kind).toBe('did_you_mean');
    expect(verdict.suggestions).toContain('BS EN 61008');
  });
});

describe('resolveEnumAnswer — ocpd_bs_en (mixed-format options matching BS_EN_LOOKUP + iOS picker)', () => {
  test('"60898" exactly matches the MCB option (matches BS_EN_LOOKUP.MCB after 2026-05-06 alignment)', () => {
    const verdict = resolveEnumAnswer({
      userText: '60898',
      contextField: 'ocpd_bs_en',
      contextCircuit: 1,
      sourceTurnId: 't',
      fieldSchema: RCD_SCHEMA,
    });
    expect(verdict.kind).toBe('auto_resolve');
    expect(verdict.writes[0].value).toBe('BS EN 60898');
  });

  test('"BS EN 60898" — surrounding "BS EN " stripped on the digit form, matches MCB exactly', () => {
    const verdict = resolveEnumAnswer({
      userText: 'BS EN 60898',
      contextField: 'ocpd_bs_en',
      contextCircuit: 1,
      sourceTurnId: 't',
      fieldSchema: RCD_SCHEMA,
    });
    expect(verdict.kind).toBe('auto_resolve');
    expect(verdict.writes[0].value).toBe('BS EN 60898');
  });

  test('"60898-1" (legacy MCB sub-clause form) → did_you_mean ["BS EN 60898"] — Lev-1 deletion of "1"', () => {
    // Pre-2026-05-06 the schema canonical had the "-1" suffix; post-
    // alignment "BS EN 60898" without the suffix is the only MCB
    // option, so dictation of the -1 form surfaces did_you_mean.
    const verdict = resolveEnumAnswer({
      userText: '60898-1',
      contextField: 'ocpd_bs_en',
      contextCircuit: 1,
      sourceTurnId: 't',
      fieldSchema: RCD_SCHEMA,
    });
    expect(verdict.kind).toBe('did_you_mean');
    expect(verdict.suggestions).toContain('BS EN 60898');
  });

  test('"BS 1361" exactly matches the cartridge-fuse option (canonical form keeps the BS prefix)', () => {
    const verdict = resolveEnumAnswer({
      userText: 'BS 1361',
      contextField: 'ocpd_bs_en',
      contextCircuit: 1,
      sourceTurnId: 't',
      fieldSchema: RCD_SCHEMA,
    });
    expect(verdict.kind).toBe('auto_resolve');
    expect(verdict.writes[0].value).toBe('BS 1361');
  });

  test('"BS 3036" matches the rewireable-fuse option', () => {
    const verdict = resolveEnumAnswer({
      userText: 'BS 3036',
      contextField: 'ocpd_bs_en',
      contextCircuit: 1,
      sourceTurnId: 't',
      fieldSchema: RCD_SCHEMA,
    });
    expect(verdict.kind).toBe('auto_resolve');
    expect(verdict.writes[0].value).toBe('BS 3036');
  });

  test('"60947-2" matches the hyphenated MCCB option exactly', () => {
    const verdict = resolveEnumAnswer({
      userText: '60947-2',
      contextField: 'ocpd_bs_en',
      contextCircuit: 1,
      sourceTurnId: 't',
      fieldSchema: RCD_SCHEMA,
    });
    expect(verdict.kind).toBe('auto_resolve');
    expect(verdict.writes[0].value).toBe('BS EN 60947-2');
  });

  test('"60269-2" matches the HRC-fuse option', () => {
    const verdict = resolveEnumAnswer({
      userText: '60269-2',
      contextField: 'ocpd_bs_en',
      contextCircuit: 1,
      sourceTurnId: 't',
      fieldSchema: RCD_SCHEMA,
    });
    expect(verdict.kind).toBe('auto_resolve');
    expect(verdict.writes[0].value).toBe('BS EN 60269-2');
  });

  test('"banana" against ocpd_bs_en → invalid_value with the OCPD option list', () => {
    const verdict = resolveEnumAnswer({
      userText: 'banana',
      contextField: 'ocpd_bs_en',
      contextCircuit: 1,
      sourceTurnId: 't',
      fieldSchema: RCD_SCHEMA,
    });
    expect(verdict.kind).toBe('invalid_value');
    expect(verdict.valid_options).toContain('BS EN 60898');
    expect(verdict.valid_options).toContain('BS 1361');
  });

  test('"no OCPD" → auto-resolve to N/A', () => {
    const verdict = resolveEnumAnswer({
      userText: 'no OCPD',
      contextField: 'ocpd_bs_en',
      contextCircuit: 1,
      sourceTurnId: 't',
      fieldSchema: RCD_SCHEMA,
    });
    expect(verdict.kind).toBe('auto_resolve');
    expect(verdict.writes[0].value).toBe('N/A');
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
    expect(verdict.valid_options).toContain('BS EN 61008');
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
