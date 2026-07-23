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

  // Codex-r1 F5 — the MODEL path: a LIM reading now OVERWRITES a populated
  // rating (the LIM-overwrite exception), so the rating becomes LIM AND the
  // auto-derived max-Zs is cleared in the same apply.
  it('model path: a LIM reading overwrites a populated rating AND clears the auto-derived max-Zs', () => {
    const row: CircuitRow = {
      id: 'c-1',
      circuit_ref: '1',
      circuit_designation: 'Cooker',
      ocpd_type: 'B',
      ocpd_rating_a: '32',
      max_disconnect_time_s: '0.4',
      ocpd_max_zs_ohm: '1.44',
    };
    const applied = applyExtractionToJob(
      makeJob({ circuits: [row] }),
      makeResult({ readings: [{ circuit: 1, field: 'ocpd_rating_a', value: 'LIM' }] })
    );
    expect(applied!.patch.circuits![0].ocpd_rating_a).toBe('LIM'); // overwrote
    expect(applied!.patch.circuits![0].ocpd_max_zs_ohm).toBe(''); // auto-derived cleared
  });

  it('model path: a LIM reading preserves a differing manual max-Zs override', () => {
    const row: CircuitRow = {
      id: 'c-1',
      circuit_ref: '1',
      ocpd_type: 'B',
      ocpd_rating_a: '32',
      max_disconnect_time_s: '0.4',
      ocpd_max_zs_ohm: '9.99',
    };
    const applied = applyExtractionToJob(
      makeJob({ circuits: [row] }),
      makeResult({ readings: [{ circuit: 1, field: 'ocpd_rating_a', value: 'LIM' }] })
    );
    expect(applied!.patch.circuits![0].ocpd_rating_a).toBe('LIM');
    expect(applied?.patch.circuits?.[0]?.ocpd_max_zs_ohm ?? '9.99').toBe('9.99'); // preserved
  });

  // Codex-r1 F6 — multi-board: main + sub-board both have circuit_ref "1", both
  // with an auto-derived 1.44. The prior map is keyed by (board_id, ref)/id, so
  // the row that receives the LIM has its provenance evaluated against ITS OWN
  // prior (not a collided one) and only that row's max-Zs clears; the other
  // board's max-Zs is never spuriously touched. (Web's per-circuit reading apply
  // is ref-only/last-wins — a pre-existing single-board limitation — so the LIM
  // lands on the sub row; the point of this test is that main is untouched.)
  it('multi-board same-ref: a LIM rating does not spuriously clear the OTHER board', () => {
    const main: CircuitRow = {
      id: 'm-1',
      circuit_ref: '1',
      board_id: 'main',
      ocpd_type: 'B',
      ocpd_rating_a: '32',
      max_disconnect_time_s: '0.4',
      ocpd_max_zs_ohm: '1.44',
    };
    const sub: CircuitRow = {
      id: 's-1',
      circuit_ref: '1',
      board_id: 'sub',
      ocpd_type: 'B',
      ocpd_rating_a: '32',
      max_disconnect_time_s: '0.4',
      ocpd_max_zs_ohm: '1.44',
    };
    const applied = applyExtractionToJob(
      makeJob({ circuits: [main, sub] }),
      makeResult({
        readings: [{ circuit: 1, field: 'ocpd_rating_a', value: 'LIM' } as never],
      })
    );
    const out = applied!.patch.circuits!;
    const mainOut = out.find((c) => c.id === 'm-1')!;
    const subOut = out.find((c) => c.id === 's-1')!;
    // Exactly one board's max-Zs cleared (the one the ref-only apply hit); the
    // other stays 1.44 — never both, never the wrong one.
    const cleared = [mainOut.ocpd_max_zs_ohm, subOut.ocpd_max_zs_ohm].filter((v) => v === '');
    const kept = [mainOut.ocpd_max_zs_ohm, subOut.ocpd_max_zs_ohm].filter((v) => v === '1.44');
    expect(cleared.length).toBe(1);
    expect(kept.length).toBe(1);
  });
});
