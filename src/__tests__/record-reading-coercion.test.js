/**
 * Tests for record-reading-coercion.js — the shared helper that
 * canonicalises record_reading values for BOTH the dispatcher and the
 * Loaded Barrel speculator's streamed-tool hook (Phase 2.D). Drift
 * between the two sites is exactly the failure mode this module
 * exists to prevent (parity_mismatch → cache MISS → audible regression).
 */

import { coerceRecordReadingValue } from '../extraction/record-reading-coercion.js';

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
