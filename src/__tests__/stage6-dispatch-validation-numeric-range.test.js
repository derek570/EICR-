/**
 * Audit-2026-06-02 Phase 1 — numeric range gate inside validateRecordReading.
 *
 * Surfaces the dispatcher gap probe `probe_rcd_time_off_spec.yaml`:
 * Sonnet writes `rcd_time_ms="3000"` (heard "three thousand" milliseconds).
 * Pre-Phase-1 the validator only checked circuit + confidence + closed
 * enums; `rcd_time_ms` is a free-text field per field_schema.json so
 * `value_not_in_options` never fired. The reading persisted to the
 * snapshot and shipped to iOS verbatim — BS 7671 caps a 30 mA AC RCD
 * test result at 300 ms, 3000 ms is impossible for a healthy install.
 *
 * After Phase 1 the rangeable-field gate rejects and Sonnet's tool
 * loop sees `value_out_of_range` + min/max — the model retries with
 * the value rescaled (the inspector said "300", not "3000", and the
 * model misread the decimal).
 */

import { validateRecordReading } from '../extraction/stage6-dispatch-validation.js';

const snapshotOneCircuit = { circuits: { 2: {} } };

describe('validateRecordReading — Phase 1 numeric range gate (canonical field names)', () => {
  test('rcd_time_ms="3000" rejected with value_out_of_range (probe_rcd_time_off_spec repro)', () => {
    const result = validateRecordReading(
      { field: 'rcd_time_ms', circuit: 2, value: '3000', confidence: 1 },
      snapshotOneCircuit
    );
    expect(result).toMatchObject({
      code: 'value_out_of_range',
      field: 'value',
      value: '3000',
      min: 0,
      max: 1000,
    });
  });

  test('rcd_time_ms="300" passes (legitimate 30 mA AC RCD test result)', () => {
    expect(
      validateRecordReading(
        { field: 'rcd_time_ms', circuit: 2, value: '300', confidence: 1 },
        snapshotOneCircuit
      )
    ).toBeNull();
  });

  test('rcd_time_ms="0" passes (didn’t-trip edge case acceptable)', () => {
    expect(
      validateRecordReading(
        { field: 'rcd_time_ms', circuit: 2, value: '0', confidence: 1 },
        snapshotOneCircuit
      )
    ).toBeNull();
  });

  test('measured_zs_ohm="500" rejected (orders-of-magnitude transcription)', () => {
    const result = validateRecordReading(
      { field: 'measured_zs_ohm', circuit: 2, value: '500', confidence: 1 },
      snapshotOneCircuit
    );
    expect(result).toMatchObject({
      code: 'value_out_of_range',
      field: 'value',
      min: 0,
      max: 100,
    });
  });

  test('measured_zs_ohm=">200" rejected (sentinel form, tail still out of range)', () => {
    const result = validateRecordReading(
      { field: 'measured_zs_ohm', circuit: 2, value: '>200', confidence: 1 },
      snapshotOneCircuit
    );
    expect(result).toMatchObject({ code: 'value_out_of_range', field: 'value' });
  });

  test('measured_zs_ohm="2.5" passes (in-range BS 7671-compliant value)', () => {
    expect(
      validateRecordReading(
        { field: 'measured_zs_ohm', circuit: 2, value: '2.5', confidence: 1 },
        snapshotOneCircuit
      )
    ).toBeNull();
  });

  test('rcd_time_ms="three thousand" rejected as value_out_of_range (non-numeric on ranged field)', () => {
    const result = validateRecordReading(
      { field: 'rcd_time_ms', circuit: 2, value: 'three thousand', confidence: 1 },
      snapshotOneCircuit
    );
    expect(result).toMatchObject({ code: 'value_out_of_range', field: 'value' });
  });

  test('ocpd_rating_a="1000" rejected; "63" passes', () => {
    expect(
      validateRecordReading(
        { field: 'ocpd_rating_a', circuit: 2, value: '1000', confidence: 1 },
        snapshotOneCircuit
      )
    ).toMatchObject({ code: 'value_out_of_range' });
    expect(
      validateRecordReading(
        { field: 'ocpd_rating_a', circuit: 2, value: '63', confidence: 1 },
        snapshotOneCircuit
      )
    ).toBeNull();
  });

  test('ir_test_voltage_v="500" passes; "2500" rejected', () => {
    expect(
      validateRecordReading(
        { field: 'ir_test_voltage_v', circuit: 2, value: '500', confidence: 1 },
        snapshotOneCircuit
      )
    ).toBeNull();
    expect(
      validateRecordReading(
        { field: 'ir_test_voltage_v', circuit: 2, value: '2500', confidence: 1 },
        snapshotOneCircuit
      )
    ).toMatchObject({ code: 'value_out_of_range' });
  });

  test('rcd_operating_current_ma="30" passes; "5000" rejected', () => {
    expect(
      validateRecordReading(
        { field: 'rcd_operating_current_ma', circuit: 2, value: '30', confidence: 1 },
        snapshotOneCircuit
      )
    ).toBeNull();
    expect(
      validateRecordReading(
        { field: 'rcd_operating_current_ma', circuit: 2, value: '5000', confidence: 1 },
        snapshotOneCircuit
      )
    ).toMatchObject({ code: 'value_out_of_range' });
  });

  test('ocpd_breaking_capacity_ka="10" passes; "500" rejected', () => {
    expect(
      validateRecordReading(
        { field: 'ocpd_breaking_capacity_ka', circuit: 2, value: '10', confidence: 1 },
        snapshotOneCircuit
      )
    ).toBeNull();
    expect(
      validateRecordReading(
        { field: 'ocpd_breaking_capacity_ka', circuit: 2, value: '500', confidence: 1 },
        snapshotOneCircuit
      )
    ).toMatchObject({ code: 'value_out_of_range' });
  });

  test('non-ranged field "ocpd_type" passes (closed-enum gate handles it elsewhere)', () => {
    expect(
      validateRecordReading(
        { field: 'ocpd_type', circuit: 2, value: 'B', confidence: 1 },
        snapshotOneCircuit
      )
    ).toBeNull();
  });
});
