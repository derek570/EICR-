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
      // Aligned with production config/field_schema.json:164 — includes
      // the fuller A-S / B-S / B+ set. The word-anchored matcher's "B+"
      // adjacency tests below verify the '+' is preserved by
      // normaliseEnumToken so "B+" cannot collide with "B".
      options: ['', 'AC', 'A', 'F', 'B', 'S', 'A-S', 'B-S', 'B+', 'N/A'],
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

  test('field is select but options are word-anchored (rcd_type AC|A|F|B|B+) → auto_resolve via word-anchored matcher', () => {
    const verdict = resolveEnumAnswer({
      userText: 'AC',
      contextField: 'rcd_type',
      contextCircuit: 1,
      sourceTurnId: null,
      fieldSchema: RCD_SCHEMA,
    });
    expect(verdict.kind).toBe('auto_resolve');
    expect(verdict.writes).toEqual([
      {
        tool: 'record_reading',
        field: 'rcd_type',
        circuit: 1,
        value: 'AC',
        confidence: 0.9,
        source_turn_id: null,
      },
    ]);
  });

  test('rcd_type "A." → auto_resolve as "A" (trailing punctuation stripped)', () => {
    const verdict = resolveEnumAnswer({
      userText: 'A.',
      contextField: 'rcd_type',
      contextCircuit: 1,
      sourceTurnId: null,
      fieldSchema: RCD_SCHEMA,
    });
    expect(verdict.kind).toBe('auto_resolve');
    expect(verdict.writes[0]).toMatchObject({ value: 'A', confidence: 0.9 });
  });

  test('rcd_type "a" → auto_resolve as "A" (case-insensitive match)', () => {
    const verdict = resolveEnumAnswer({
      userText: 'a',
      contextField: 'rcd_type',
      contextCircuit: 1,
      sourceTurnId: null,
      fieldSchema: RCD_SCHEMA,
    });
    expect(verdict.kind).toBe('auto_resolve');
    expect(verdict.writes[0]).toMatchObject({ value: 'A', confidence: 0.9 });
  });

  test('rcd_type "B+" → auto_resolve as "B+" (+ preserved, no collision with "B")', () => {
    const verdict = resolveEnumAnswer({
      userText: 'B+',
      contextField: 'rcd_type',
      contextCircuit: 1,
      sourceTurnId: null,
      fieldSchema: RCD_SCHEMA,
    });
    expect(verdict.kind).toBe('auto_resolve');
    expect(verdict.writes[0]).toMatchObject({ value: 'B+', confidence: 0.9 });
  });

  test('rcd_type "Z" → invalid_value with full options', () => {
    const verdict = resolveEnumAnswer({
      userText: 'Z',
      contextField: 'rcd_type',
      contextCircuit: 1,
      sourceTurnId: null,
      fieldSchema: RCD_SCHEMA,
    });
    expect(verdict.kind).toBe('invalid_value');
    expect(verdict.received).toBe('Z');
    expect(verdict.valid_options).toEqual(RCD_SCHEMA.circuit_fields.rcd_type.options);
  });

  describe('wiring_type word-anchored matcher', () => {
    const WIRING_SCHEMA = {
      circuit_fields: {
        wiring_type: {
          label: 'Wiring Type',
          type: 'select',
          // Aligned with production config/field_schema.json:24-32 — no N/A.
          options: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'O'],
        },
      },
    };

    test('"A." → auto_resolve as "A"', () => {
      const verdict = resolveEnumAnswer({
        userText: 'A.',
        contextField: 'wiring_type',
        contextCircuit: 1,
        sourceTurnId: null,
        fieldSchema: WIRING_SCHEMA,
      });
      expect(verdict.kind).toBe('auto_resolve');
      expect(verdict.writes[0]).toMatchObject({ value: 'A', confidence: 0.9 });
    });

    test('"a" → auto_resolve as "A"', () => {
      const verdict = resolveEnumAnswer({
        userText: 'a',
        contextField: 'wiring_type',
        contextCircuit: 1,
        sourceTurnId: null,
        fieldSchema: WIRING_SCHEMA,
      });
      expect(verdict.kind).toBe('auto_resolve');
      expect(verdict.writes[0]).toMatchObject({ value: 'A' });
    });

    test('"Z" → invalid_value with full wiring_type options', () => {
      const verdict = resolveEnumAnswer({
        userText: 'Z',
        contextField: 'wiring_type',
        contextCircuit: 1,
        sourceTurnId: null,
        fieldSchema: WIRING_SCHEMA,
      });
      expect(verdict.kind).toBe('invalid_value');
      expect(verdict.valid_options).toEqual(WIRING_SCHEMA.circuit_fields.wiring_type.options);
    });

    test('"na" on wiring_type (no N/A in options) → invalid_value (NOT auto_resolve)', () => {
      // wiring_type does NOT include N/A in its option set; the N/A
      // short-circuit's `field.options.includes('N/A')` gate is false, so
      // "na" falls through to the word-anchored block and gets rejected.
      const verdict = resolveEnumAnswer({
        userText: 'na',
        contextField: 'wiring_type',
        contextCircuit: 1,
        sourceTurnId: null,
        fieldSchema: WIRING_SCHEMA,
      });
      expect(verdict.kind).toBe('invalid_value');
    });
  });

  describe('mixed digit + letter options regression guard', () => {
    // A hypothetical option set with BOTH digit-bearing AND letter-only
    // values. The word-anchored block's predicate is `every(o => !/\d/)`
    // (NOT `some`) so a digit-bearing option set falls THROUGH to the
    // existing digit-anchored path. Locking this guards against a future
    // refactor accidentally inverting the predicate.
    const MIXED_SCHEMA = {
      circuit_fields: {
        // Field name reuses ocpd_type from the WORD_ANCHORED_ENUM_FIELDS
        // allowlist so the allowlist gate is satisfied — we're only
        // testing the `every` predicate.
        ocpd_type: {
          label: 'Mixed Test',
          type: 'select',
          options: ['230', '400', 'Other'],
        },
      },
    };

    test('digit-bearing options route through digit-anchored path, NOT word-anchored', () => {
      const verdict = resolveEnumAnswer({
        userText: '230',
        contextField: 'ocpd_type',
        contextCircuit: 1,
        sourceTurnId: 't1',
        fieldSchema: MIXED_SCHEMA,
      });
      expect(verdict.kind).toBe('auto_resolve');
      expect(verdict.writes[0]).toMatchObject({ value: '230', confidence: 0.95 });
    });
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

describe('multi-circuit enum resolve (session C0C21546 2026-06-04)', () => {
  const WIRING_SCHEMA = {
    circuit_fields: {
      wiring_type: {
        label: 'Wiring Type',
        type: 'select',
        options: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'O'],
      },
    },
  };

  test('"A." answer with contextCircuits [2,3] fans out two writes', () => {
    const verdict = resolveEnumAnswer({
      userText: 'A.',
      contextField: 'wiring_type',
      contextCircuit: null,
      contextCircuits: [2, 3],
      sourceTurnId: 'turn-12',
      fieldSchema: WIRING_SCHEMA,
    });
    expect(verdict.kind).toBe('auto_resolve');
    expect(verdict.writes).toHaveLength(2);
    expect(verdict.writes.map((w) => w.circuit).sort()).toEqual([2, 3]);
    expect(verdict.writes.every((w) => w.field === 'wiring_type')).toBe(true);
    expect(verdict.writes.every((w) => w.value === 'A')).toBe(true);
  });

  test('falls through to single-circuit when only contextCircuit is set', () => {
    const verdict = resolveEnumAnswer({
      userText: 'B',
      contextField: 'wiring_type',
      contextCircuit: 5,
      contextCircuits: null,
      sourceTurnId: 'turn-x',
      fieldSchema: WIRING_SCHEMA,
    });
    expect(verdict.kind).toBe('auto_resolve');
    expect(verdict.writes).toHaveLength(1);
    expect(verdict.writes[0].circuit).toBe(5);
    expect(verdict.writes[0].value).toBe('B');
  });

  test('contextCircuits empty array falls back to no_value_context if no contextCircuit', () => {
    const verdict = resolveEnumAnswer({
      userText: 'A',
      contextField: 'wiring_type',
      contextCircuit: null,
      contextCircuits: [],
      sourceTurnId: 't',
      fieldSchema: WIRING_SCHEMA,
    });
    expect(verdict.kind).toBe('no_value_context');
  });

  test('invalid value with contextCircuits escalates with did_you_mean or invalid_value', () => {
    const verdict = resolveEnumAnswer({
      userText: 'Z',
      contextField: 'wiring_type',
      contextCircuit: null,
      contextCircuits: [2, 3],
      sourceTurnId: 't',
      fieldSchema: WIRING_SCHEMA,
    });
    expect(['did_you_mean', 'invalid_value']).toContain(verdict.kind);
  });

  test('contextCircuits length-1 with no contextCircuit → no_value_context (validator normally blocks, resolver defends)', () => {
    const verdict = resolveEnumAnswer({
      userText: 'A',
      contextField: 'wiring_type',
      contextCircuit: null,
      contextCircuits: [2],
      sourceTurnId: 't',
      fieldSchema: WIRING_SCHEMA,
    });
    expect(verdict.kind).toBe('no_value_context');
  });

  test('contextCircuits length-1 with contextCircuit set → falls back to single-circuit [contextCircuit]', () => {
    const verdict = resolveEnumAnswer({
      userText: 'A',
      contextField: 'wiring_type',
      contextCircuit: 5,
      contextCircuits: [2],
      sourceTurnId: 't',
      fieldSchema: WIRING_SCHEMA,
    });
    expect(verdict.kind).toBe('auto_resolve');
    expect(verdict.writes).toHaveLength(1);
    expect(verdict.writes[0].circuit).toBe(5);
  });
});

describe('non-circuit context-field guard (multi-circuit fan-out only)', () => {
  // For board/supply/installation fields, multi-circuit fan-out is
  // meaningless. Guard fires only when circuitList.length > 1 so single-
  // circuit asks on those fields still flow through (the resolver bails
  // for unrelated reasons later, but the guard itself doesn't block).
  test('ze_at_db (board field) + contextCircuits:[2,3] → no_value_context', () => {
    const verdict = resolveEnumAnswer({
      userText: 'A',
      contextField: 'ze_at_db',
      contextCircuit: null,
      contextCircuits: [2, 3],
      sourceTurnId: 't',
      fieldSchema: RCD_SCHEMA, // schema doesn't matter — guard fires before schema lookup
    });
    expect(verdict.kind).toBe('no_value_context');
  });

  test('earth_loop_impedance_ze (supply field) + contextCircuits:[2,3] → no_value_context', () => {
    const verdict = resolveEnumAnswer({
      userText: 'A',
      contextField: 'earth_loop_impedance_ze',
      contextCircuit: null,
      contextCircuits: [2, 3],
      sourceTurnId: 't',
      fieldSchema: RCD_SCHEMA,
    });
    expect(verdict.kind).toBe('no_value_context');
  });

  test('client_name (installation field) + contextCircuits:[2,3] → no_value_context', () => {
    const verdict = resolveEnumAnswer({
      userText: 'A',
      contextField: 'client_name',
      contextCircuit: null,
      contextCircuits: [2, 3],
      sourceTurnId: 't',
      fieldSchema: RCD_SCHEMA,
    });
    expect(verdict.kind).toBe('no_value_context');
  });
});
