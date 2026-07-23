/**
 * P3 Fix 6 (2026-07-23, feedback id 86) — OCPD-rating → max-Zs invalidation.
 *
 * When ocpd_rating_a transitions numeric → non-lookup-able sentinel (LIM), an
 * AUTO-DERIVED numeric ocpd_max_zs_ohm would persist stale on web (iOS nils it →
 * divergence, and a stale max-Zs feeds a false circuit result). The before/after
 * transition helper `shouldClearAutoDerivedMaxZs` clears it ONLY when it equals
 * the pre-LIM tuple's lookup (auto-derived), preserving a manual override.
 * ocpd_breaking_capacity_ka is NOT a lookup input → must never trigger.
 *
 * NOTE (reachability): web's 3-tier value guard (apply-extraction.ts) blocks a
 * readings-based numeric→LIM OVERWRITE of a populated ocpd_rating_a, so the
 * transition primarily reaches this helper via the UI/manual-edit + projected
 * row path. The helper is therefore unit-tested directly with before/after row
 * state — exactly the "transition helper that receives BEFORE and AFTER circuit
 * state" the plan specifies — and the apply-extraction wiring is covered for the
 * reachable no-op cases.
 */
import { describe, expect, it } from 'vitest';
import { shouldClearAutoDerivedMaxZs, applyExtractionToJob } from '@/lib/recording/apply-extraction';
import type { ExtractionResult } from '@/lib/recording/sonnet-session';
import type { CircuitRow, JobDetail } from '@/lib/types';

// B 32A @ 0.4s auto-derives 1.44 Ω (Table 41.3).
const priorNumeric: CircuitRow = {
  id: 'c1',
  circuit_ref: '1',
  ocpd_type: 'B',
  ocpd_rating_a: '32',
  max_disconnect_time_s: '0.4',
  ocpd_max_zs_ohm: '1.44',
};

describe('shouldClearAutoDerivedMaxZs — before/after transition helper (P3 Fix 6)', () => {
  it('clears an AUTO-DERIVED max-Zs when the rating becomes LIM', () => {
    const next: CircuitRow = { ...priorNumeric, ocpd_rating_a: 'LIM' };
    expect(shouldClearAutoDerivedMaxZs(priorNumeric, next)).toBe(true);
  });

  it('PRESERVES a differing manual max-Zs override', () => {
    const priorOverride: CircuitRow = { ...priorNumeric, ocpd_max_zs_ohm: '9.99' };
    const next: CircuitRow = { ...priorOverride, ocpd_rating_a: 'LIM' };
    expect(shouldClearAutoDerivedMaxZs(priorOverride, next)).toBe(false);
  });

  it('other non-numeric values (N/A, arbitrary text) also clear an auto-derived value', () => {
    for (const v of ['N/A', 'limitation', 'xyz']) {
      const next: CircuitRow = { ...priorNumeric, ocpd_rating_a: v };
      expect(shouldClearAutoDerivedMaxZs(priorNumeric, next)).toBe(true);
    }
  });

  it('no-ops when the max-Zs field is blank (nothing to clear)', () => {
    const priorBlank: CircuitRow = { ...priorNumeric, ocpd_max_zs_ohm: '' };
    const next: CircuitRow = { ...priorBlank, ocpd_rating_a: 'LIM' };
    expect(shouldClearAutoDerivedMaxZs(priorBlank, next)).toBe(false);
  });

  it('no-ops when the rating is still numeric (normal recompute owns it)', () => {
    const next: CircuitRow = { ...priorNumeric, ocpd_rating_a: '40' };
    expect(shouldClearAutoDerivedMaxZs(priorNumeric, next)).toBe(false);
  });

  it('no-ops when there is no prior (new circuit — no auto-derived history)', () => {
    const next: CircuitRow = { ...priorNumeric, ocpd_rating_a: 'LIM' };
    expect(shouldClearAutoDerivedMaxZs(undefined, next)).toBe(false);
  });

  it('no-ops when the prior rating was already non-numeric (cannot prove auto-derivation)', () => {
    const priorLim: CircuitRow = { ...priorNumeric, ocpd_rating_a: 'LIM' };
    const next: CircuitRow = { ...priorLim };
    expect(shouldClearAutoDerivedMaxZs(priorLim, next)).toBe(false);
  });

  it('a LIM ocpd_breaking_capacity_ka does NOT clear max-Zs (rating still numeric)', () => {
    // breaking_capacity is not a lookup input; the rating is unchanged numeric,
    // so the current-rating lookup still succeeds → helper returns false.
    const next: CircuitRow = { ...priorNumeric, ocpd_breaking_capacity_ka: 'LIM' };
    expect(shouldClearAutoDerivedMaxZs(priorNumeric, next)).toBe(false);
  });
});

// ── apply-extraction wiring: reachable no-op cases ──────────────────────
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

describe('apply-extraction H3 wiring — Fix 6 does not spuriously clear', () => {
  it('a valid numeric rating still auto-derives max-Zs (no regression)', () => {
    const row: CircuitRow = { id: 'c-1', circuit_ref: '1', circuit_designation: 'Cooker' };
    const applied = applyExtractionToJob(
      makeJob({ circuits: [row] }),
      makeResult({
        readings: [
          { circuit: 1, field: 'ocpd_type', value: 'B' },
          { circuit: 1, field: 'ocpd_rating_a', value: '32' },
          { circuit: 1, field: 'max_disconnect_time_s', value: '0.4' },
        ],
      })
    );
    expect(applied!.patch.circuits![0].ocpd_max_zs_ohm).toBe('1.44');
  });

  it('a LIM rating on a blank-max-Zs row does not fabricate or clear anything', () => {
    const row: CircuitRow = {
      id: 'c-1',
      circuit_ref: '1',
      ocpd_type: 'B',
      max_disconnect_time_s: '0.4',
    };
    const applied = applyExtractionToJob(
      makeJob({ circuits: [row] }),
      makeResult({ readings: [{ circuit: 1, field: 'ocpd_rating_a', value: 'LIM' }] })
    );
    expect(applied?.patch.circuits?.[0]?.ocpd_max_zs_ohm ?? '').toBe('');
  });
});
