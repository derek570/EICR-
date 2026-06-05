/**
 * apply-extraction — legacy-wire-field → PWA-column translation tests.
 *
 * The backend's `validateAndCorrectFields`
 * (src/extraction/sonnet-stream.js:882) deliberately rewrites every
 * per-circuit Sonnet reading to iOS-legacy field names because iOS
 * Build 282's `applySonnetReadings` switch consumes those names
 * natively. The PWA's circuit table reads the MODERN
 * config/field_schema.json names, so `apply-extraction.ts` translates
 * at intake.
 *
 * These tests pin every (wire field → PWA column) entry in the
 * LEGACY_TO_PWA_CIRCUIT_FIELD map so a future schema drift on either
 * side fails the suite rather than silently dropping a value into a
 * column the UI never reads.
 *
 * Field session that prompted the fix: `sess_mp2cacfh_xlur`
 * (2026-05-12). 3 successful backend `create_circuit` tool calls; 4
 * extraction frames decoded with `circuit_updates: 0` and zero
 * rendered values on the PWA.
 */
import { describe, expect, it } from 'vitest';
import { applyExtractionToJob } from '@/lib/recording/apply-extraction';
import type { ExtractionResult } from '@/lib/recording/sonnet-session';
import type { CircuitRow, JobDetail } from '@/lib/types';

function makeJob(circuits: CircuitRow[] = []): JobDetail {
  return {
    id: 'job_1',
    job_id: 'job_1',
    user_id: 'u',
    folder_name: 'f',
    certificate_type: 'EICR',
    job_address: 'a',
    created_date: new Date(0).toISOString(),
    last_modified: new Date(0).toISOString(),
    circuits,
  } as unknown as JobDetail;
}

function makeResult(over: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    readings: [],
    field_clears: [],
    circuit_updates: [],
    observations: [],
    validation_alerts: [],
    confirmations: [],
    ...over,
  };
}

/** Each row: a legacy wire field name (what the backend post-validate
 *  emits) and the PWA `CircuitRow` column the UI actually reads. */
const LEGACY_TO_PWA_PAIRS: Array<[wireField: string, pwaColumn: string, value: unknown]> = [
  ['designation', 'circuit_designation', 'Cooker'],
  ['ocpd_rating', 'ocpd_rating_a', '32'],
  ['cable_size', 'live_csa_mm2', '6'],
  ['cable_size_earth', 'cpc_csa_mm2', '2.5'],
  ['zs', 'measured_zs_ohm', '0.42'],
  ['r2', 'r2_ohm', '0.31'],
  ['r1_plus_r2', 'r1_r2_ohm', '0.55'],
  ['ring_continuity_r1', 'ring_r1_ohm', '0.12'],
  ['ring_continuity_rn', 'ring_rn_ohm', '0.13'],
  ['ring_continuity_r2', 'ring_r2_ohm', '0.21'],
  ['insulation_resistance_l_e', 'ir_live_earth_mohm', '999'],
  ['insulation_resistance_l_l', 'ir_live_live_mohm', '850'],
  ['ir_test_voltage', 'ir_test_voltage_v', '500'],
  ['rcd_trip_time', 'rcd_time_ms', '23'],
  ['ocpd_breaking_capacity', 'ocpd_breaking_capacity_ka', '6'],
  ['max_disconnect_time', 'max_disconnect_time_s', '0.4'],
  ['polarity', 'polarity_confirmed', 'Yes'],
];

describe('apply-extraction legacy → PWA circuit-field translation', () => {
  it.each(LEGACY_TO_PWA_PAIRS)(
    'routes wire field "%s" into PWA column "%s"',
    (wireField, pwaColumn, value) => {
      const job = makeJob([{ id: 'c-1', circuit_ref: '1', circuit_designation: '' }]);
      const result = makeResult({
        readings: [{ circuit: 1, field: wireField, value: value as string }],
      });

      const applied = applyExtractionToJob(job, result);

      expect(applied).not.toBeNull();
      expect(applied!.patch.circuits).toHaveLength(1);
      const row = applied!.patch.circuits![0];
      expect(row[pwaColumn]).toBe(value);
      // The original wire field name MUST NOT land on the row — that
      // is the bug the translation fixes. (Skip when the legacy name
      // happens to be a prefix of the PWA column or vice-versa — none
      // of our 17 mappings share a prefix, so a strict not-equal is
      // safe.)
      if (wireField !== pwaColumn) {
        expect(row[wireField]).toBeUndefined();
      }
    }
  );

  it('passes through fields that are already in the modern shape', () => {
    // `ocpd_type` is in backend KNOWN_FIELDS (no rewrite); PWA reads
    // it under the same name. Translation must be identity.
    const job = makeJob([{ id: 'c-1', circuit_ref: '1', circuit_designation: '' }]);
    const result = makeResult({
      readings: [{ circuit: 1, field: 'ocpd_type', value: 'B' }],
    });

    const applied = applyExtractionToJob(job, result);
    expect(applied).not.toBeNull();
    expect(applied!.patch.circuits![0].ocpd_type).toBe('B');
  });

  it('respects the 3-tier write priority on the translated column', () => {
    // If the inspector already typed a value into circuit_designation,
    // a Sonnet `designation` reading must NOT overwrite it — the
    // translation must happen BEFORE the hasValue check, otherwise the
    // priority rule looks at the wrong column. (applyCircuitReadings
    // still produces a cloned circuits array even when every reading
    // is skipped, so we assert on the row contents rather than the
    // null return.)
    const job = makeJob([{ id: 'c-1', circuit_ref: '1', circuit_designation: 'User Typed' }]);
    const result = makeResult({
      readings: [{ circuit: 1, field: 'designation', value: 'Sonnet Suggestion' }],
    });

    const applied = applyExtractionToJob(job, result);
    expect(applied).not.toBeNull();
    const row = applied!.patch.circuits![0];
    expect(row.circuit_designation).toBe('User Typed');
    expect(applied!.changedKeys).toEqual([]);
  });

  it('translates field_clears too so a clear lands on the right column', () => {
    const job = makeJob([
      { id: 'c-1', circuit_ref: '1', circuit_designation: 'Old', measured_zs_ohm: '0.42' },
    ]);
    const result = makeResult({
      field_clears: [{ circuit: 1, field: 'zs' }],
    });

    const applied = applyExtractionToJob(job, result);
    expect(applied).not.toBeNull();
    const row = applied!.patch.circuits![0];
    expect(row.measured_zs_ohm).toBeUndefined();
    // Untouched fields stay.
    expect(row.circuit_designation).toBe('Old');
  });
});
