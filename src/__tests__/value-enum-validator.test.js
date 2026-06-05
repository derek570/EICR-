/**
 * Audit-2026-06-02 Phase 1 — value-enum-validator.js predicate tests.
 *
 * Smoke-covers the `isWithinRange` helper for the four key paths:
 *   - field not in the range map → ok
 *   - non-numeric value on a ranged field → invalid_type
 *   - numeric out of bounds → value_out_of_range with min/max echoed back
 *   - sentinel form `">N"` accepted when the tail is in range
 *
 * Dispatcher-level integration (Sonnet's tool-loop sees the rejection
 * envelope and retries) is covered separately in
 * `stage6-dispatch-validation-numeric-range.test.js`. This file pins
 * the pure-function contract.
 */

import {
  isWithinRange,
  CIRCUIT_FIELD_NUMERIC_RANGES,
  BOARD_FIELD_NUMERIC_RANGES,
} from '../extraction/value-enum-validator.js';

describe('CIRCUIT_FIELD_NUMERIC_RANGES — map shape', () => {
  test('every entry has finite min/max with min < max', () => {
    for (const [field, range] of CIRCUIT_FIELD_NUMERIC_RANGES) {
      expect(typeof range.min).toBe('number');
      expect(typeof range.max).toBe('number');
      expect(Number.isFinite(range.min)).toBe(true);
      expect(Number.isFinite(range.max)).toBe(true);
      expect(range.min).toBeLessThan(range.max);
      expect(typeof field).toBe('string');
      expect(field.length).toBeGreaterThan(0);
    }
  });

  test('contains the six audit-driven entries', () => {
    for (const f of [
      'rcd_time_ms',
      'rcd_operating_current_ma',
      'ocpd_rating_a',
      'ocpd_breaking_capacity_ka',
      'measured_zs_ohm',
      'ir_test_voltage_v',
    ]) {
      expect(CIRCUIT_FIELD_NUMERIC_RANGES.has(f)).toBe(true);
    }
  });
});

describe('BOARD_FIELD_NUMERIC_RANGES', () => {
  test('empty today (no board-side numeric-text fields without a closed enum)', () => {
    expect(BOARD_FIELD_NUMERIC_RANGES.size).toBe(0);
  });
});

describe('isWithinRange — non-ranged fields pass through', () => {
  test('ocpd_type (closed-enum, no range entry) returns ok', () => {
    expect(isWithinRange('ocpd_type', 'B')).toEqual({ ok: true });
  });

  test('arbitrary unknown field returns ok', () => {
    expect(isWithinRange('definitely_not_a_field', '42')).toEqual({ ok: true });
  });
});

describe('isWithinRange — blank and sentinel forms', () => {
  test('empty string passes (clear semantics belong to clear_reading)', () => {
    expect(isWithinRange('rcd_time_ms', '')).toEqual({ ok: true });
  });

  test('sentinel ">50" passes for measured_zs_ohm (tail 50 is in range 0-100)', () => {
    expect(isWithinRange('measured_zs_ohm', '>50')).toEqual({ ok: true });
  });

  test('sentinel ">  500" with whitespace passes for ir_test_voltage_v (range 100-1000)', () => {
    expect(isWithinRange('ir_test_voltage_v', '>  500')).toEqual({ ok: true });
  });

  test('sentinel ">200" rejected for measured_zs_ohm (tail 200 above 100 ceiling)', () => {
    const result = isWithinRange('measured_zs_ohm', '>200');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('value_out_of_range');
  });
});

describe('isWithinRange — numeric out-of-range rejections', () => {
  test('rcd_time_ms="3000" rejected (audit probe_rcd_time_off_spec.yaml repro)', () => {
    const result = isWithinRange('rcd_time_ms', '3000');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('value_out_of_range');
    expect(result.field).toBe('rcd_time_ms');
    expect(result.value).toBe('3000');
    expect(result.min).toBe(0);
    expect(result.max).toBe(1000);
  });

  test('measured_zs_ohm="500" rejected (orders-of-magnitude transcription error)', () => {
    const result = isWithinRange('measured_zs_ohm', '500');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('value_out_of_range');
    expect(result.min).toBe(0);
    expect(result.max).toBe(100);
  });

  test('ocpd_rating_a="1000" rejected (beyond 630 A LV cap)', () => {
    const result = isWithinRange('ocpd_rating_a', '1000');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('value_out_of_range');
  });

  test('rcd_time_ms="0" passes (didn’t-trip edge case)', () => {
    expect(isWithinRange('rcd_time_ms', '0')).toEqual({ ok: true });
  });

  test('rcd_time_ms="1000" passes (top of range, inclusive)', () => {
    expect(isWithinRange('rcd_time_ms', '1000')).toEqual({ ok: true });
  });

  test('rcd_time_ms="-1" rejected (below 0)', () => {
    const result = isWithinRange('rcd_time_ms', '-1');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('value_out_of_range');
  });
});

describe('isWithinRange — non-string and non-numeric inputs', () => {
  test('non-string value on a ranged field rejected with invalid_type', () => {
    const result = isWithinRange('rcd_time_ms', 3000);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('invalid_type');
    expect(result.field).toBe('rcd_time_ms');
    expect(result.value).toBe(3000);
  });

  test('non-numeric string on a ranged field rejected as value_out_of_range', () => {
    const result = isWithinRange('rcd_time_ms', 'three thousand');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('value_out_of_range');
  });

  test('non-string value on a non-ranged field passes (out of scope for this gate)', () => {
    expect(isWithinRange('ocpd_type', null)).toEqual({ ok: true });
  });
});

describe('isWithinRange — explicit rangeMap argument', () => {
  test('passing BOARD_FIELD_NUMERIC_RANGES treats every circuit field as unranged', () => {
    // BOARD map is empty today; the rcd_time_ms gate should fall through.
    expect(isWithinRange('rcd_time_ms', '3000', BOARD_FIELD_NUMERIC_RANGES)).toEqual({ ok: true });
  });
});
