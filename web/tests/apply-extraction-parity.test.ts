/**
 * apply-extraction — pinned-parity regression tests.
 *
 * Covers parity gaps the audit confirmed are correctly handled today
 * but lack explicit test coverage. Future refactors that drift the
 * wire ↔ PWA contract should fail these immediately rather than
 * showing up as silent inspector-facing regressions.
 *
 * Sections:
 *   1. Observation field-key mapping (Bug-H wire shape).
 *   2. Circuit field_clear translation (per-circuit legacy → PWA
 *      column name on clear, mirrors the readings path).
 *   3. Stage6CircuitCreated → ocpd_rating reading translation
 *      (Phase-C of the parity push — rating_amps no longer dropped).
 */
import { describe, expect, it } from 'vitest';
import { applyExtractionToJob } from '@/lib/recording/apply-extraction';
import type { ExtractionResult } from '@/lib/recording/sonnet-session';
import type { CircuitRow, JobDetail } from '@/lib/types';

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

// ────────────────────────────────────────────────────────────────────────────
// 1. Observations
// ────────────────────────────────────────────────────────────────────────────
describe('apply-extraction observations parity (Bug-H wire shape)', () => {
  it('maps observation_text → ObservationRow.description', () => {
    const result = makeResult({
      observations: [{ observation_text: 'Damaged socket outlet in kitchen', code: 'C2' }],
    });
    const applied = applyExtractionToJob(makeJob(), result);
    expect(applied).not.toBeNull();
    const obs = applied!.patch.observations![0];
    expect(obs.description).toBe('Damaged socket outlet in kitchen');
    expect(obs.code).toBe('C2');
  });

  it('maps item_location → ObservationRow.location', () => {
    const result = makeResult({
      observations: [
        {
          observation_text: 'Loose connection',
          code: 'C1',
          item_location: 'Hall consumer unit',
        },
      ],
    });
    const applied = applyExtractionToJob(makeJob(), result);
    const obs = applied!.patch.observations![0];
    expect(obs.location).toBe('Hall consumer unit');
  });

  it('maps observation_id → ObservationRow.server_id (BPG4 patch key)', () => {
    const result = makeResult({
      observations: [
        {
          observation_text: 'Missing main switch label',
          code: 'C3',
          observation_id: 'obs-uuid-123',
        },
      ],
    });
    const applied = applyExtractionToJob(makeJob(), result);
    const obs = applied!.patch.observations![0];
    expect(obs.server_id).toBe('obs-uuid-123');
  });

  it('captures regulation when present (refiner output)', () => {
    const result = makeResult({
      observations: [
        {
          observation_text: 'No SPD fitted',
          code: 'C3',
          regulation: '443.4',
        },
      ],
    });
    const applied = applyExtractionToJob(makeJob(), result);
    const obs = applied!.patch.observations![0];
    expect(obs.regulation).toBe('443.4');
  });

  it('dedupes by case-insensitive observation_text', () => {
    const job = makeJob({
      observations: [{ id: 'existing-1', description: 'damaged socket outlet', code: 'C2' }],
    });
    const result = makeResult({
      observations: [{ observation_text: 'DAMAGED SOCKET OUTLET', code: 'C1' }],
    });
    const applied = applyExtractionToJob(job, result);
    // Dedup hit — no observation patch returned.
    expect(applied?.patch.observations).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. Per-circuit field_clears — translation must mirror the readings path
// ────────────────────────────────────────────────────────────────────────────
describe('apply-extraction per-circuit field_clears translation', () => {
  it('clears the PWA column when the wire field is legacy-named', () => {
    // Inspector dictated `zs: 0.42` earlier (landed in measured_zs_ohm).
    // Sonnet now fires `clear_reading(field: 'zs', circuit: 1)`. The
    // clear must remove `measured_zs_ohm` (PWA column), not `zs`.
    const row: CircuitRow = {
      id: 'c-1',
      circuit_ref: '1',
      circuit_designation: 'Cooker',
      measured_zs_ohm: '0.42',
    };
    const job = makeJob({ circuits: [row] });
    const result = makeResult({
      field_clears: [{ circuit: 1, field: 'zs' }],
    });
    const applied = applyExtractionToJob(job, result);
    expect(applied).not.toBeNull();
    const cleared = applied!.patch.circuits![0];
    expect(cleared.measured_zs_ohm).toBeUndefined();
    // Untouched cells stay.
    expect(cleared.circuit_designation).toBe('Cooker');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. Stage6CircuitCreated rating_amps → ocpd_rating reading
// ────────────────────────────────────────────────────────────────────────────
describe('apply-extraction Stage6CircuitCreated rating_amps forwarding', () => {
  it('lands rating_amps on ocpd_rating_a via the per-circuit translation', () => {
    // Synthetic ExtractionResult shape built by recording-context's
    // onCircuitCreated handler: a `readings` entry for `ocpd_rating`
    // plus a `circuit_updates` entry for the designation. Verifies
    // that the per-circuit LEGACY_TO_PWA_CIRCUIT_FIELD translation
    // routes the rating into `ocpd_rating_a` (the PWA column the
    // circuit table renders).
    const result = makeResult({
      readings: [{ circuit: 1, field: 'ocpd_rating', value: 32 }],
      circuit_updates: [{ circuit: 1, designation: 'Cooker', action: 'create' }],
    });
    const job = makeJob({
      circuits: [{ id: 'c-1', circuit_ref: '1', circuit_designation: '' }],
    });
    const applied = applyExtractionToJob(job, result);
    expect(applied).not.toBeNull();
    const row = applied!.patch.circuits![0];
    expect(row.circuit_designation).toBe('Cooker');
    expect(row.ocpd_rating_a).toBe(32);
    expect(row.ocpd_rating).toBeUndefined();
  });
});
