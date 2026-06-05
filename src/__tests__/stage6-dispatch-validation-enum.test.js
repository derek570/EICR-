/**
 * Fix B 2026-06-02 (handoff-2026-06-02-fixes.md §B) — per-field value-enum
 * validation in validateRecordReading + the parallel BOARD enum map.
 *
 * Surfaces three bug classes from the 2026-06-02 field test (session
 * E87F58C1 turn 3) + the audit's broader probe pass:
 *
 *   1. rcd_type schema enum grew to include B+/A-S/B-S to match the
 *      prompt's BS 7671 RCD designators (field_schema.json:164). Pre-Fix-B
 *      the prompt taught these but the validator never checked, and the
 *      original 2026-06-02 "AND" off-enum write persisted to iOS state.
 *
 *   2. afdd_button_confirmed accepts "true" verbatim (audit prod probe);
 *      coerceRecordReadingValue maps it to "Y" so the dispatcher-side
 *      ordering test below pins that coercion runs BEFORE validation.
 *
 *   3. nominal_voltage_uo "240" coerced to "230" (UK pre-harmonisation);
 *      pinned by the board enum map below + the dispatcher integration
 *      test in stage6-dispatchers-board-enum-validator.test.js.
 *
 * Tests focus on the pure validator surface — dispatcher-level
 * integration (coercion ordering, rejection envelope shape) lives in
 * the dispatcher tests proper.
 */

import {
  validateRecordReading,
  BOARD_FIELD_VALUE_ENUMS,
  CIRCUIT_FIELD_VALUE_ENUMS,
} from '../extraction/stage6-dispatch-validation.js';

const snapshotOneCircuit = { circuits: { 3: {} } };

describe('validateRecordReading — value_not_in_options gate (circuit fields)', () => {
  test('canonical rcd_type value "A" passes', () => {
    expect(
      validateRecordReading(
        { field: 'rcd_type', circuit: 3, value: 'A', confidence: 1 },
        snapshotOneCircuit
      )
    ).toBeNull();
  });

  test('newly-allowed selective forms "A-S" / "B-S" / "B+" pass after the 2026-06-02 schema reconcile', () => {
    for (const v of ['A-S', 'B-S', 'B+']) {
      expect(
        validateRecordReading(
          { field: 'rcd_type', circuit: 3, value: v, confidence: 1 },
          snapshotOneCircuit
        )
      ).toBeNull();
    }
  });

  test('off-enum "AND" (the original 2026-06-02 session E87F58C1 bug) rejected with value_not_in_options', () => {
    const result = validateRecordReading(
      { field: 'rcd_type', circuit: 3, value: 'AND', confidence: 1 },
      snapshotOneCircuit
    );
    expect(result).toMatchObject({ code: 'value_not_in_options', field: 'value' });
    expect(result.valid_options).toEqual(
      expect.arrayContaining(['AC', 'A', 'B', 'F', 'S', 'A-S', 'B-S', 'B+', 'N/A'])
    );
  });

  test('lowercase off-enum "and" / "a" rejected (no case-insensitive match)', () => {
    expect(
      validateRecordReading(
        { field: 'rcd_type', circuit: 3, value: 'and', confidence: 1 },
        snapshotOneCircuit
      )
    ).toMatchObject({ code: 'value_not_in_options' });
    expect(
      validateRecordReading(
        { field: 'rcd_type', circuit: 3, value: 'a', confidence: 1 },
        snapshotOneCircuit
      )
    ).toMatchObject({ code: 'value_not_in_options' });
  });

  test('empty string "" rejected on wiring_type (no "" in its enum)', () => {
    // wiring_type options = ["A", ..., "O"] — no "". Empty-string-as-clear
    // belongs to the clear_reading tool, not record_reading.
    expect(
      validateRecordReading(
        { field: 'wiring_type', circuit: 3, value: '', confidence: 1 },
        snapshotOneCircuit
      )
    ).toMatchObject({ code: 'value_not_in_options' });
  });

  test('empty string "" accepted on rcd_type (its enum explicitly lists "")', () => {
    // rcd_type options DO include "" (the "unwritten" representation).
    // Strict membership wins per-field — no universal empty-string escape.
    expect(
      validateRecordReading(
        { field: 'rcd_type', circuit: 3, value: '', confidence: 1 },
        snapshotOneCircuit
      )
    ).toBeNull();
  });

  test('off-enum "twin and earth" on wiring_type rejected (audit-observed overwrite bug)', () => {
    expect(
      validateRecordReading(
        { field: 'wiring_type', circuit: 3, value: 'twin and earth', confidence: 1 },
        snapshotOneCircuit
      )
    ).toMatchObject({ code: 'value_not_in_options' });
  });

  test('canonical "A" on wiring_type accepted (PVC/PVC T&E)', () => {
    expect(
      validateRecordReading(
        { field: 'wiring_type', circuit: 3, value: 'A', confidence: 1 },
        snapshotOneCircuit
      )
    ).toBeNull();
  });

  test('off-enum "C curve" on ocpd_type rejected', () => {
    expect(
      validateRecordReading(
        { field: 'ocpd_type', circuit: 3, value: 'C curve', confidence: 1 },
        snapshotOneCircuit
      )
    ).toMatchObject({ code: 'value_not_in_options' });
  });

  test('canonical "C" on ocpd_type accepted', () => {
    expect(
      validateRecordReading(
        { field: 'ocpd_type', circuit: 3, value: 'C', confidence: 1 },
        snapshotOneCircuit
      )
    ).toBeNull();
  });

  test('non-string value with enum field rejected with invalid_type', () => {
    // Defensive — strict:true on input_schema rejects most non-strings
    // at the API boundary, but if one slips through (e.g. via a bypass
    // path or future tool variant), the validator catches it cleanly.
    expect(
      validateRecordReading(
        { field: 'rcd_type', circuit: 3, value: 42, confidence: 1 },
        snapshotOneCircuit
      )
    ).toMatchObject({ code: 'invalid_type', field: 'value' });
  });

  test('text-type field (no enum) passes any string value', () => {
    // measured_zs_ohm / ocpd_rating_a / rcd_operating_current_ma etc.
    // are type:"text" in field_schema.json — no enum to check. The
    // validator falls through to null for these.
    expect(
      validateRecordReading(
        { field: 'measured_zs_ohm', circuit: 3, value: '0.43', confidence: 1 },
        snapshotOneCircuit
      )
    ).toBeNull();
    expect(
      validateRecordReading(
        { field: 'ocpd_rating_a', circuit: 3, value: '32', confidence: 1 },
        snapshotOneCircuit
      )
    ).toBeNull();
  });

  test('rejection order: circuit_not_found beats value_not_in_options (existing precedence preserved)', () => {
    expect(
      validateRecordReading(
        { field: 'rcd_type', circuit: 999, value: 'AND', confidence: 1 },
        snapshotOneCircuit
      )
    ).toMatchObject({ code: 'circuit_not_found', field: 'circuit' });
  });

  test('rejection order: confidence_out_of_range beats value_not_in_options', () => {
    expect(
      validateRecordReading(
        { field: 'rcd_type', circuit: 3, value: 'AND', confidence: 1.5 },
        snapshotOneCircuit
      )
    ).toMatchObject({ code: 'confidence_out_of_range' });
  });
});

describe('BOARD_FIELD_VALUE_ENUMS — exposed for stage6-dispatchers-board.js', () => {
  test('map includes every type:"select" board field with its options[] verbatim', () => {
    // Spot-check the highest-traffic supply / board / installation enums.
    expect(BOARD_FIELD_VALUE_ENUMS.get('earthing_arrangement')).toEqual(
      new Set(['TN-S', 'TN-C-S', 'TT', 'IT', 'TN-C'])
    );
    expect(BOARD_FIELD_VALUE_ENUMS.get('nominal_voltage_uo')).toEqual(
      new Set(['230', '400', '110', 'N/A', 'Other'])
    );
    expect(BOARD_FIELD_VALUE_ENUMS.get('main_switch_voltage')).toEqual(
      new Set(['230', '240', '400', '415', 'N/A'])
    );
    // board_fields section's enums also picked up
    expect(BOARD_FIELD_VALUE_ENUMS.get('board_type')).toEqual(
      new Set(['', 'main', 'sub_distribution', 'sub_main'])
    );
    expect(BOARD_FIELD_VALUE_ENUMS.get('phases')).toEqual(new Set(['1', '3']));
  });

  test('"240" is OFF-enum on nominal_voltage_uo (the prod-observed bug) but IN-enum on main_switch_voltage', () => {
    // The dispatcher's coerceRecordBoardReadingValue maps nominal "240"
    // → "230" so a real inspector write doesn't reach this gate. But
    // the map itself must reflect the schema verbatim — main_switch_voltage
    // is a physical rated voltage that legitimately accepts 240V devices.
    expect(BOARD_FIELD_VALUE_ENUMS.get('nominal_voltage_uo').has('240')).toBe(false);
    expect(BOARD_FIELD_VALUE_ENUMS.get('main_switch_voltage').has('240')).toBe(true);
  });

  test('non-enum board fields (sub_main_cable_csa_mm2, ze, pfc, etc.) are absent from the map', () => {
    // These are type:"text" in field_schema.json — no enum check applies.
    expect(BOARD_FIELD_VALUE_ENUMS.has('earth_loop_impedance_ze')).toBe(false);
    expect(BOARD_FIELD_VALUE_ENUMS.has('prospective_fault_current')).toBe(false);
    expect(BOARD_FIELD_VALUE_ENUMS.has('sub_main_cable_csa_mm2')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Schema-lock for the Loaded Barrel speculator's 2026-06-03b Fix C gate.
//
// The speculator reads BOARD_FIELD_VALUE_ENUMS + CIRCUIT_FIELD_VALUE_ENUMS
// to decide whether to skip pre-synth on a streamed tool-use event
// whose coerced value would be rejected as `value_not_in_options`. If
// the BS-EN families silently drop out of those maps (schema rename,
// section move, type-flip from select→text), the gate stops firing on
// the F03B590C-class repro and the bug returns.
//
// `spd_bs_en` is intentionally type:"text" in field_schema.json — it's
// the only `*_bs_en` field whose canonical home is the open-text supply
// section. Pin the absence so a future engineer doesn't "fix" the gap
// by adding it to BOARD_FIELD_VALUE_ENUMS and re-introducing the
// round-1/round-2 TTS split for spd_bs_en writes.
// ─────────────────────────────────────────────────────────────────────
describe('voice-correctness-2026-06-03b Fix C — speculator gate value-enum schema-lock', () => {
  test('CIRCUIT_FIELD_VALUE_ENUMS is exported and includes ocpd_bs_en + rcd_bs_en', () => {
    // The two circuit-side BS-EN families. Both are type:"select"
    // (verified via field_schema.json circuit_fields). Without these
    // entries, the speculator gate never fires on a streamed
    // `record_reading` with an off-enum BS-EN value, and the
    // pre-validation TTS leak re-opens for the circuit-side path.
    expect(CIRCUIT_FIELD_VALUE_ENUMS).toBeInstanceOf(Map);
    expect(CIRCUIT_FIELD_VALUE_ENUMS.has('ocpd_bs_en')).toBe(true);
    expect(CIRCUIT_FIELD_VALUE_ENUMS.has('rcd_bs_en')).toBe(true);
    // Spot-check one canonical option per field so a schema rename
    // (e.g. dropping the "BS EN " prefix) fails this assertion before
    // the speculator gate stops matching.
    expect(CIRCUIT_FIELD_VALUE_ENUMS.get('ocpd_bs_en').has('BS EN 60898')).toBe(true);
    expect(CIRCUIT_FIELD_VALUE_ENUMS.get('rcd_bs_en').has('BS EN 61008')).toBe(true);
  });

  test('BOARD_FIELD_VALUE_ENUMS includes main_switch_bs_en (the F03B590C field)', () => {
    // The exact field the speculator gate must guard. Canonical option
    // is "1361 type 1"; the off-enum value "BS 1361" reaches the gate
    // verbatim because coerceRecordBoardReadingValue does NOT run
    // parseBsCode on board-side BS fields (see Fix C plan §"Coercion
    // asymmetry"). If main_switch_bs_en drops out of the map, the
    // speculator skips its skip — and the pre-validation TTS leak
    // returns on the precise F03B590C repro.
    expect(BOARD_FIELD_VALUE_ENUMS.has('main_switch_bs_en')).toBe(true);
    expect(BOARD_FIELD_VALUE_ENUMS.get('main_switch_bs_en').has('1361 type 1')).toBe(true);
    expect(BOARD_FIELD_VALUE_ENUMS.get('main_switch_bs_en').has('BS 1361')).toBe(false);
  });

  test('spd_bs_en is INTENTIONALLY absent from BOARD_FIELD_VALUE_ENUMS (type:"text")', () => {
    // spd_bs_en is the canonical home for the DNO cutout BS number
    // (Fix B routing). It's type:"text" in field_schema.json so the
    // dispatcher does NOT produce a value_not_in_options reject for
    // spd_bs_en writes — meaning there is no round-1/round-2 TTS
    // split to skip. The speculator must continue firing pre-synth on
    // spd_bs_en for the latency win. Document the absence so a future
    // "fix" doesn't promote spd_bs_en to type:"select" without
    // coordinating with the speculator gate.
    expect(BOARD_FIELD_VALUE_ENUMS.has('spd_bs_en')).toBe(false);
  });
});
