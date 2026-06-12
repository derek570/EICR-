/**
 * Tests for record-reading-coercion.js — the shared helper that
 * canonicalises record_reading values for BOTH the dispatcher and the
 * Loaded Barrel speculator's streamed-tool hook (Phase 2.D). Drift
 * between the two sites is exactly the failure mode this module
 * exists to prevent (parity_mismatch → cache MISS → audible regression).
 */

import {
  coerceRecordReadingValue,
  coerceRecordBoardReadingValue,
} from '../extraction/record-reading-coercion.js';

describe('coerceRecordReadingValue — BS-EN canonicalisation', () => {
  test('canonical form passes through unchanged', () => {
    expect(coerceRecordReadingValue('ocpd_bs_en', 'BS EN 60898')).toBe('BS EN 60898');
    expect(coerceRecordReadingValue('rcd_bs_en', 'BS EN 61009')).toBe('BS EN 61009');
  });

  test('"BS NNNN" (missing EN prefix) coerced to canonical "BS EN NNNN"', () => {
    expect(coerceRecordReadingValue('ocpd_bs_en', 'BS 60898')).toBe('BS EN 60898');
    expect(coerceRecordReadingValue('rcd_bs_en', 'BS 61008')).toBe('BS EN 61008');
  });

  test('bare digits ("60898") coerced to canonical', () => {
    expect(coerceRecordReadingValue('ocpd_bs_en', '60898')).toBe('BS EN 60898');
    expect(coerceRecordReadingValue('ocpd_bs_en', '61009')).toBe('BS EN 61009');
  });

  test('Deepgram dropped-leading-zero ("6898" / "1008" / "1009") fuzzy-resolves to canonical', () => {
    expect(coerceRecordReadingValue('ocpd_bs_en', '6898')).toBe('BS EN 60898');
    expect(coerceRecordReadingValue('rcd_bs_en', '1008')).toBe('BS EN 61008');
    expect(coerceRecordReadingValue('ocpd_bs_en', '1009')).toBe('BS EN 61009');
  });

  test('rewireable (3036) and cartridge (1361) preserve the BS-no-EN form', () => {
    expect(coerceRecordReadingValue('ocpd_bs_en', '3036')).toBe('BS 3036');
    expect(coerceRecordReadingValue('ocpd_bs_en', '1361')).toBe('BS 1361');
  });

  test('unrecognised BS-EN string passes through (legitimate new form surfaces as visible divergence)', () => {
    expect(coerceRecordReadingValue('ocpd_bs_en', 'BS NEW 99999')).toBe('BS NEW 99999');
    expect(coerceRecordReadingValue('ocpd_bs_en', 'N/A')).toBe('N/A');
  });
});

describe('coerceRecordReadingValue — polarity_confirmed enum', () => {
  test('canonical enum values pass through', () => {
    expect(coerceRecordReadingValue('polarity_confirmed', 'Y')).toBe('Y');
    expect(coerceRecordReadingValue('polarity_confirmed', 'N')).toBe('N');
    expect(coerceRecordReadingValue('polarity_confirmed', 'OK')).toBe('OK');
  });

  test('truthy aliases coerced to "Y"', () => {
    for (const v of [
      'true',
      'TRUE',
      'yes',
      'y',
      'correct',
      'pass',
      'passed',
      'good',
      'confirmed',
    ]) {
      expect(coerceRecordReadingValue('polarity_confirmed', v)).toBe('Y');
    }
  });

  test('falsy aliases coerced to "N"', () => {
    for (const v of [
      'false',
      'FALSE',
      'no',
      'n',
      'reversed',
      'fail',
      'failed',
      'incorrect',
      'wrong',
    ]) {
      expect(coerceRecordReadingValue('polarity_confirmed', v)).toBe('N');
    }
  });

  test('"ok" (lowercase) coerced to canonical "OK"', () => {
    expect(coerceRecordReadingValue('polarity_confirmed', 'ok')).toBe('OK');
    expect(coerceRecordReadingValue('polarity_confirmed', 'Ok')).toBe('OK');
  });

  test('unrecognised polarity value passes through (surfaces as visible divergence)', () => {
    expect(coerceRecordReadingValue('polarity_confirmed', 'maybe')).toBe('maybe');
  });

  test('supply_polarity_confirmed gets the same coercion', () => {
    expect(coerceRecordReadingValue('supply_polarity_confirmed', 'true')).toBe('Y');
    expect(coerceRecordReadingValue('supply_polarity_confirmed', 'reversed')).toBe('N');
  });
});

describe('coerceRecordReadingValue — fields with no coercion', () => {
  test('measured_zs_ohm, r1_r2_ohm, etc. pass through verbatim', () => {
    expect(coerceRecordReadingValue('measured_zs_ohm', '0.43')).toBe('0.43');
    expect(coerceRecordReadingValue('r1_r2_ohm', '0.64')).toBe('0.64');
    expect(coerceRecordReadingValue('ir_live_earth_mohm', '>200')).toBe('>200');
    expect(coerceRecordReadingValue('ocpd_rating_a', '32')).toBe('32');
  });

  test('non-string values pass through unchanged (defensive — dispatcher schema requires string)', () => {
    expect(coerceRecordReadingValue('polarity_confirmed', null)).toBe(null);
    expect(coerceRecordReadingValue('polarity_confirmed', undefined)).toBe(undefined);
    expect(coerceRecordReadingValue('ocpd_bs_en', 42)).toBe(42);
  });

  test('unknown field passes through (closed-set contract)', () => {
    expect(coerceRecordReadingValue('not_a_field', 'true')).toBe('true');
  });
});

// Fix B 2026-06-02 (handoff §B) — extended Y/N coercion to the
// button-confirmed fields. afdd_button_confirmed has FAIL in its enum;
// rcd_button_confirmed does not (its enum is ["", "OK", "Y", "N"]).
describe('coerceRecordReadingValue — afdd_button_confirmed (with FAIL)', () => {
  test('canonical enum values pass through', () => {
    expect(coerceRecordReadingValue('afdd_button_confirmed', 'Y')).toBe('Y');
    expect(coerceRecordReadingValue('afdd_button_confirmed', 'N')).toBe('N');
    expect(coerceRecordReadingValue('afdd_button_confirmed', 'OK')).toBe('OK');
    expect(coerceRecordReadingValue('afdd_button_confirmed', 'FAIL')).toBe('FAIL');
  });

  test('boolean-string "true"/"false" coerced (the 2026-06-02 prod bug — verbatim "true" used to persist)', () => {
    expect(coerceRecordReadingValue('afdd_button_confirmed', 'true')).toBe('Y');
    expect(coerceRecordReadingValue('afdd_button_confirmed', 'false')).toBe('N');
    expect(coerceRecordReadingValue('afdd_button_confirmed', 'TRUE')).toBe('Y');
  });

  test('raw JS boolean coerced (Sonnet occasionally emits real bool instead of string)', () => {
    expect(coerceRecordReadingValue('afdd_button_confirmed', true)).toBe('Y');
    expect(coerceRecordReadingValue('afdd_button_confirmed', false)).toBe('N');
  });

  test('"fail"/"failed" coerced to FAIL (a tested-but-failed device button — distinct from "no")', () => {
    expect(coerceRecordReadingValue('afdd_button_confirmed', 'fail')).toBe('FAIL');
    expect(coerceRecordReadingValue('afdd_button_confirmed', 'failed')).toBe('FAIL');
    expect(coerceRecordReadingValue('afdd_button_confirmed', 'FAILED')).toBe('FAIL');
  });

  test('inspector volunteered phrases coerced ("confirmed", "works")', () => {
    expect(coerceRecordReadingValue('afdd_button_confirmed', 'confirmed')).toBe('Y');
    expect(coerceRecordReadingValue('afdd_button_confirmed', 'works')).toBe('Y');
    expect(coerceRecordReadingValue('afdd_button_confirmed', 'working')).toBe('Y');
    expect(coerceRecordReadingValue('afdd_button_confirmed', 'broken')).toBe('N');
  });
});

describe('coerceRecordReadingValue — rcd_button_confirmed (no FAIL in enum)', () => {
  test('boolean-string coerced to Y/N', () => {
    expect(coerceRecordReadingValue('rcd_button_confirmed', 'true')).toBe('Y');
    expect(coerceRecordReadingValue('rcd_button_confirmed', 'false')).toBe('N');
  });

  test('"fail" stays coerced to "N" on rcd_button_confirmed (FAIL not in enum)', () => {
    // Symmetric with polarity_confirmed: legacy semantic "RCD button fail"
    // = "no, the button didn't work" = N. Without this branch the value
    // would coerce to FAIL and the dispatcher's enum gate would reject.
    expect(coerceRecordReadingValue('rcd_button_confirmed', 'fail')).toBe('N');
    expect(coerceRecordReadingValue('rcd_button_confirmed', 'failed')).toBe('N');
  });

  test('"works" / "confirmed" coerced to "Y" (inspector volunteered phrasing)', () => {
    expect(coerceRecordReadingValue('rcd_button_confirmed', 'works')).toBe('Y');
    expect(coerceRecordReadingValue('rcd_button_confirmed', 'confirmed')).toBe('Y');
  });
});

describe('coerceRecordBoardReadingValue — nominal voltage 240 → 230', () => {
  test('nominal_voltage_u "240" coerced to UK harmonised "230"', () => {
    expect(coerceRecordBoardReadingValue('nominal_voltage_u', '240')).toBe('230');
  });

  test('nominal_voltage_uo "240" coerced to "230" (the 2026-06-02 prod bug)', () => {
    expect(coerceRecordBoardReadingValue('nominal_voltage_uo', '240')).toBe('230');
  });

  test('whitespace around "240" trimmed before match', () => {
    expect(coerceRecordBoardReadingValue('nominal_voltage_uo', ' 240 ')).toBe('230');
  });

  test('other nominal voltage values pass through unchanged', () => {
    expect(coerceRecordBoardReadingValue('nominal_voltage_uo', '230')).toBe('230');
    expect(coerceRecordBoardReadingValue('nominal_voltage_uo', '400')).toBe('400');
    expect(coerceRecordBoardReadingValue('nominal_voltage_uo', 'N/A')).toBe('N/A');
    // Out-of-enum value passes through so the dispatcher's enum validator
    // can reject it explicitly (rather than silently coercing garbage).
    expect(coerceRecordBoardReadingValue('nominal_voltage_uo', '999')).toBe('999');
  });

  test('non-voltage board fields pass through unchanged', () => {
    expect(coerceRecordBoardReadingValue('earthing_arrangement', 'TN-S')).toBe('TN-S');
    expect(coerceRecordBoardReadingValue('main_switch_bs_en', '60947-3')).toBe('60947-3');
    // main_switch_voltage has its own enum that DOES include "240"; we
    // deliberately do NOT coerce that field (it's a physical rated voltage,
    // not a UK-nominal value).
    expect(coerceRecordBoardReadingValue('main_switch_voltage', '240')).toBe('240');
  });

  test('non-string passes through', () => {
    expect(coerceRecordBoardReadingValue('nominal_voltage_uo', null)).toBe(null);
    expect(coerceRecordBoardReadingValue('nominal_voltage_uo', 240)).toBe(240);
  });
});

// ---------------------------------------------------------------------------
// 2026-06-12 (session 15B88D6B, voiceFeedbackId 21) — PASS-check coercion for
// the bonding check fields. "Bonding is 10 millimeters to both the water and
// to the gas" produced bonding_water / bonding_gas writes with off-enum
// values that were rejected value_not_in_options with no retry; the cert
// silently lost both checks. Truthy synonyms now coerce to PASS, explicit
// not-applicable phrasing to N/A, fail/failed to FAIL. Bare "no" and numeric
// values stay un-coerced so the enum validator forces the model to
// disambiguate.
// ---------------------------------------------------------------------------
describe('coerceRecordBoardReadingValue — PASS-check fields (bonding family)', () => {
  const FIELDS = [
    'bonding_conductor_continuity',
    'bonding_water',
    'bonding_gas',
    'bonding_oil',
    'bonding_structural_steel',
    'bonding_lightning',
  ];

  test.each(FIELDS)('%s: truthy synonyms coerce to PASS', (field) => {
    for (const v of [
      'yes',
      'Yes',
      'true',
      'present',
      'confirmed',
      'bonded',
      'ok',
      'pass',
      'Passed',
    ]) {
      expect(coerceRecordBoardReadingValue(field, v)).toBe('PASS');
    }
  });

  test('boolean true coerces to PASS; boolean false passes through for explicit rejection', () => {
    expect(coerceRecordBoardReadingValue('bonding_water', true)).toBe('PASS');
    expect(coerceRecordBoardReadingValue('bonding_water', false)).toBe(false);
  });

  test('not-applicable phrasing coerces to N/A', () => {
    expect(coerceRecordBoardReadingValue('bonding_gas', 'na')).toBe('N/A');
    expect(coerceRecordBoardReadingValue('bonding_gas', 'not applicable')).toBe('N/A');
    expect(coerceRecordBoardReadingValue('bonding_oil', 'no supply')).toBe('N/A');
  });

  test('fail/failed coerce to FAIL; lim/limitation to LIM', () => {
    expect(coerceRecordBoardReadingValue('bonding_water', 'failed')).toBe('FAIL');
    expect(coerceRecordBoardReadingValue('bonding_water', 'lim')).toBe('LIM');
    expect(coerceRecordBoardReadingValue('bonding_water', 'limitation')).toBe('LIM');
  });

  test('ambiguous "no" and numeric/size values pass through for enum rejection', () => {
    // "no" is ambiguous between N/A (no gas supply) and FAIL (not bonded).
    expect(coerceRecordBoardReadingValue('bonding_gas', 'no')).toBe('no');
    // The 10 mm² CSA misrouted into a check field must NOT fake a PASS.
    expect(coerceRecordBoardReadingValue('bonding_water', '10')).toBe('10');
    expect(coerceRecordBoardReadingValue('bonding_water', '10mm')).toBe('10mm');
  });

  test('canonical enum members pass through unchanged', () => {
    for (const v of ['PASS', 'FAIL', 'LIM', 'N/A']) {
      expect(coerceRecordBoardReadingValue('bonding_water', v)).toBe(v);
    }
  });

  test('non-check fields are untouched by the PASS aliases', () => {
    expect(coerceRecordBoardReadingValue('bonding_conductor_csa', 'yes')).toBe('yes');
    expect(coerceRecordBoardReadingValue('earthing_arrangement', 'confirmed')).toBe('confirmed');
    // bonding_other is free TEXT (the bonded item's name) — its dictated
    // content must never be rewritten by the PASS/N-A aliases.
    expect(coerceRecordBoardReadingValue('bonding_other', 'none')).toBe('none');
    expect(coerceRecordBoardReadingValue('bonding_other', 'confirmed')).toBe('confirmed');
  });
});
