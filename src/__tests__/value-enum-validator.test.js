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
  validateNumericReadingValue,
  canonicaliseNumericReadingField,
  NUMERIC_READING_FIELDS,
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

// P3 (2026-07-23, feedback id 86) — LIM acceptance + the whole-set validator.
describe('isWithinRange — P3 LIM acceptance on ranged fields', () => {
  test.each([...CIRCUIT_FIELD_NUMERIC_RANGES.keys()])(
    'ranged field %s accepts canonical "LIM"',
    (field) => {
      expect(isWithinRange(field, 'LIM')).toEqual({ ok: true });
      expect(isWithinRange(field, 'lim')).toEqual({ ok: true });
      expect(isWithinRange(field, ' LIM ')).toEqual({ ok: true });
    }
  );

  test.each([...CIRCUIT_FIELD_NUMERIC_RANGES.keys()])(
    'ranged field %s STILL rejects the other sentinels (only LIM is allowed)',
    (field) => {
      for (const s of ['n/a', 'na', '∞', 'inf', 'infinity']) {
        expect(isWithinRange(field, s).ok).toBe(false);
      }
    }
  );

  test('["LIM"] does not stringify through — array hits invalid_type', () => {
    const r = isWithinRange('measured_zs_ohm', ['LIM']);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('invalid_type');
  });

  test('near-match "limited" on a ranged field is rejected (not LIM)', () => {
    expect(isWithinRange('measured_zs_ohm', 'limited').ok).toBe(false);
  });

  test('field-specific numeric boundaries still enforced with LIM added', () => {
    // measured_zs_ohm 0–100
    expect(isWithinRange('measured_zs_ohm', '101').ok).toBe(false);
    expect(isWithinRange('measured_zs_ohm', '500').ok).toBe(false);
    expect(isWithinRange('measured_zs_ohm', '>200').ok).toBe(false);
    expect(isWithinRange('measured_zs_ohm', '50').ok).toBe(true);
    // 500 / >200 are VALID for other ranged fields (not universal rejects)
    expect(isWithinRange('rcd_time_ms', '500').ok).toBe(true);
    expect(isWithinRange('rcd_operating_current_ma', '500').ok).toBe(true);
    expect(isWithinRange('ocpd_rating_a', '500').ok).toBe(true);
    expect(isWithinRange('ir_test_voltage_v', '500').ok).toBe(true);
    // per-field max+1
    expect(isWithinRange('rcd_time_ms', '1001').ok).toBe(false);
    expect(isWithinRange('ocpd_rating_a', '631').ok).toBe(false);
    expect(isWithinRange('ocpd_breaking_capacity_ka', '201').ok).toBe(false);
    expect(isWithinRange('ir_test_voltage_v', '1001').ok).toBe(false);
    // per-field min-1
    expect(isWithinRange('rcd_operating_current_ma', '4').ok).toBe(false);
    expect(isWithinRange('ir_test_voltage_v', '99').ok).toBe(false);
  });
});

describe('validateNumericReadingValue — whole NUMERIC_READING_FIELDS set (P3)', () => {
  const UNGATED = [...NUMERIC_READING_FIELDS].filter(
    (f) => !CIRCUIT_FIELD_NUMERIC_RANGES.has(f)
  );

  test('the ungated set is exactly the eight non-ranged reading fields', () => {
    expect(UNGATED.sort()).toEqual(
      [
        'r1_r2_ohm',
        'r2_ohm',
        'ring_r1_ohm',
        'ring_rn_ohm',
        'ring_r2_ohm',
        'ocpd_max_zs_ohm',
        'ir_live_live_mohm',
        'ir_live_earth_mohm',
      ].sort()
    );
  });

  test.each(UNGATED)('ungated field %s accepts canonical LIM', (field) => {
    expect(validateNumericReadingValue(field, 'LIM').ok).toBe(true);
    expect(validateNumericReadingValue(field, 'lim').ok).toBe(true);
  });

  test.each(UNGATED)('ungated field %s accepts numerics / LIM / blank', (field) => {
    expect(validateNumericReadingValue(field, '0.35').ok).toBe(true);
    expect(validateNumericReadingValue(field, '200').ok).toBe(true);
    expect(validateNumericReadingValue(field, 'LIM').ok).toBe(true);
    expect(validateNumericReadingValue(field, '').ok).toBe(true);
  });

  test.each(UNGATED.filter((f) => f !== 'ocpd_max_zs_ohm'))(
    'measured field %s accepts off-scale >N',
    (field) => {
      expect(validateNumericReadingValue(field, '>999').ok).toBe(true);
    }
  );

  test.each(UNGATED.filter((f) => f !== 'ocpd_max_zs_ohm'))(
    'measured-reading field %s accepts the discontinuous/N/A sentinels',
    (field) => {
      expect(validateNumericReadingValue(field, '∞').ok).toBe(true);
      expect(validateNumericReadingValue(field, 'N/A').ok).toBe(true);
    }
  );

  test('ocpd_max_zs_ohm (a COMPUTED ceiling) rejects ∞/N/A AND off-scale, accepts numeric + LIM', () => {
    expect(validateNumericReadingValue('ocpd_max_zs_ohm', '∞').ok).toBe(false);
    expect(validateNumericReadingValue('ocpd_max_zs_ohm', 'N/A').ok).toBe(false);
    expect(validateNumericReadingValue('ocpd_max_zs_ohm', '>999').ok).toBe(false);
    expect(validateNumericReadingValue('ocpd_max_zs_ohm', '<0.5').ok).toBe(false);
    expect(validateNumericReadingValue('ocpd_max_zs_ohm', '1.44').ok).toBe(true);
    expect(validateNumericReadingValue('ocpd_max_zs_ohm', 'LIM').ok).toBe(true);
  });

  test.each(UNGATED)('ungated field %s REJECTS the four near-matches', (field) => {
    for (const nm of ['limit', 'limited', 'lynn', 'lym', 'garbage']) {
      expect(validateNumericReadingValue(field, nm).ok).toBe(false);
    }
  });

  test.each(UNGATED)('ungated field %s rejects non-string types', (field) => {
    expect(validateNumericReadingValue(field, ['LIM']).ok).toBe(false);
    expect(validateNumericReadingValue(field, {}).ok).toBe(false);
    expect(validateNumericReadingValue(field, null).ok).toBe(false);
    // a finite number is accepted
    expect(validateNumericReadingValue(field, 0.35).ok).toBe(true);
    expect(validateNumericReadingValue(field, NaN).ok).toBe(false);
  });

  test('ranged fields delegate to isWithinRange (bounds + LIM)', () => {
    expect(validateNumericReadingValue('measured_zs_ohm', 'LIM').ok).toBe(true);
    expect(validateNumericReadingValue('measured_zs_ohm', '101').ok).toBe(false);
    expect(validateNumericReadingValue('measured_zs_ohm', '∞').ok).toBe(false);
  });

  test('non-numeric-reading fields pass through untouched', () => {
    expect(validateNumericReadingValue('ocpd_type', 'anything')).toEqual({ ok: true });
    expect(validateNumericReadingValue('designation', 'Upstairs sockets')).toEqual({ ok: true });
  });

  test('dialogue-slot alias rcd_trip_time canonicalises to rcd_time_ms', () => {
    expect(canonicaliseNumericReadingField('rcd_trip_time')).toBe('rcd_time_ms');
    expect(validateNumericReadingValue(canonicaliseNumericReadingField('rcd_trip_time'), 'LIM').ok).toBe(
      true
    );
    // via alias the bounds still apply
    expect(
      validateNumericReadingValue(canonicaliseNumericReadingField('rcd_trip_time'), '5000').ok
    ).toBe(false);
  });
});
