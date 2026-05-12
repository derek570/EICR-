/**
 * apply-extraction — H7 regression. Sonnet-created circuits pick up
 * user defaults + global cable defaults via the iOS-parity
 * `applyDefaultsToCircuit` pipeline.
 *
 * Pre-fix the `ensureRow` helper created `{id, circuit_ref,
 * circuit_designation: ''}` and stopped — Sonnet writes that
 * followed had to fill EVERY column individually, even ones with
 * obvious defaults (max disconnect time 0.4s, IR test voltage 500V,
 * OCPD type B). iOS canon
 * (`DefaultsService.applyDefaults` + `CertificateDefaultsService.
 * applyCableDefaults`) runs on every newly-created circuit so the
 * inspector doesn't have to dictate boilerplate.
 */
import { describe, expect, it } from 'vitest';
import { applyExtractionToJob } from '@/lib/recording/apply-extraction';
import type { ExtractionResult } from '@/lib/recording/sonnet-session';
import type { JobDetail } from '@/lib/types';

function makeJob(over: Partial<JobDetail> = {}): JobDetail {
  return {
    id: 'job_1',
    job_id: 'job_1',
    user_id: 'u',
    folder_name: 'f',
    certificate_type: 'EICR',
    job_address: 'a',
    created_date: new Date(0).toISOString(),
    last_modified: new Date(0).toISOString(),
    ...over,
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

describe('apply-extraction H7 — defaults on Sonnet-created circuits', () => {
  it('applies GLOBAL_DEFAULTS to a freshly-created row when options.userDefaults is set', () => {
    // Sonnet emits create_circuit; the row gets GLOBAL_DEFAULTS
    // (max_disconnect_time_s=0.4, ocpd_type=B, ocpd_breaking_capacity_ka=6,
    // rcd_operating_current_ma=30, ir_test_voltage_v=500) regardless of
    // whether the user has any explicit defaults set.
    const result = makeResult({
      readings: [{ circuit: 1, field: 'designation', value: 'Cooker' }],
      circuit_updates: [{ circuit: 1, designation: 'Cooker', action: 'create' }],
    });
    const applied = applyExtractionToJob(makeJob(), result, { userDefaults: {} });
    expect(applied).not.toBeNull();
    const row = applied!.patch.circuits![0] as Record<string, unknown>;
    expect(row.max_disconnect_time_s).toBe('0.4');
    expect(row.ocpd_type).toBe('B');
    expect(row.ir_test_voltage_v).toBe('500');
    expect(row.circuit_designation).toBe('Cooker');
  });

  it('applies user-selected defaults on top of global ones', () => {
    const result = makeResult({
      circuit_updates: [{ circuit: 1, designation: 'Lights', action: 'create' }],
    });
    const applied = applyExtractionToJob(makeJob(), result, {
      userDefaults: { wiring_type: 'A', ref_method: '101' },
    });
    const row = applied!.patch.circuits![0] as Record<string, unknown>;
    expect(row.wiring_type).toBe('A');
    expect(row.ref_method).toBe('101');
    expect(row.ocpd_type).toBe('B'); // global default still applies
  });

  it('does NOT overwrite a value Sonnet sets in the same turn', () => {
    // Sonnet dictates ocpd_type='C' for the same circuit. Defaults
    // pipeline runs at row construction, then the per-circuit
    // readings loop writes the Sonnet value. Result: Sonnet wins.
    const result = makeResult({
      readings: [{ circuit: 1, field: 'ocpd_type', value: 'C' }],
      circuit_updates: [{ circuit: 1, designation: 'Special', action: 'create' }],
    });
    const applied = applyExtractionToJob(makeJob(), result, { userDefaults: {} });
    const row = applied!.patch.circuits![0] as Record<string, unknown>;
    expect(row.ocpd_type).toBe('C');
  });

  it('does NOT re-apply defaults to a pre-existing user row', () => {
    // Inspector typed circuit 1 manually (no ocpd_type yet). Sonnet
    // dictates a reading on circuit 1. `ensureRow` finds the row by
    // ref and returns the existing index — no defaults re-run, no
    // surprise overwrites.
    const existing = {
      id: 'c-existing',
      circuit_ref: '1',
      circuit_designation: 'User Typed',
      ocpd_type: 'B', // user's chosen value
    };
    const job = makeJob({ circuits: [existing] });
    const result = makeResult({
      readings: [{ circuit: 1, field: 'zs', value: '0.42' }],
    });
    const applied = applyExtractionToJob(job, result, {
      userDefaults: { ocpd_type: 'D' }, // would-be conflict
    });
    const row = applied!.patch.circuits![0] as Record<string, unknown>;
    // Pre-existing row id preserved.
    expect(row.id).toBe('c-existing');
    // User's ocpd_type kept.
    expect(row.ocpd_type).toBe('B');
    // Sonnet reading applied (Zs landed on the translated column).
    expect(row.measured_zs_ohm).toBe('0.42');
  });

  it('skips defaults entirely when options.userDefaults is omitted', () => {
    // Legacy/test call sites that don't pass options must not get
    // surprise defaults — the apply path stays byte-identical to its
    // pre-H7 shape.
    const result = makeResult({
      circuit_updates: [{ circuit: 1, designation: 'Cooker', action: 'create' }],
    });
    const applied = applyExtractionToJob(makeJob(), result);
    const row = applied!.patch.circuits![0] as Record<string, unknown>;
    expect(row.circuit_designation).toBe('Cooker');
    expect(row.max_disconnect_time_s).toBeUndefined();
    expect(row.ocpd_type).toBeUndefined();
  });
});
