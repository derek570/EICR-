/**
 * Max-Zs invalidation through `applyExtractionToJob` — originally P3 Fix 6
 * (2026-07-23, feedback id 86), rewritten for PLAN-CC (feedback-2026-09-17).
 *
 * WHAT CHANGED AND WHY THIS FILE WAS REWRITTEN RATHER THAN PATCHED
 * ----------------------------------------------------------------
 * P3 Fix 6 answered "was this max Zs auto-derived?" by comparing the stored
 * value against the PRE-transition lookup. That inference is wrong in exactly
 * the case that matters: a hand-entered value which happens to equal the
 * lookup was indistinguishable from a derived one, and got deleted. PLAN-CC
 * records provenance durably in `ocpd_max_zs_source`, so
 * `recomputeMaxZsForOcpdTuple` READS it instead of guessing, and the
 * `shouldClearAutoDerivedMaxZs` helper this file used to unit-test is gone.
 *
 * The RULE it enforced survives and is strictly wider — an `auto` row whose
 * tuple stops resolving is cleared, whether the rating became LIM (P3's only
 * case) or the standard or the type changed. The cases below drive that rule
 * through the real apply path, plus the two states that now behave
 * differently on purpose: `manual` is never cleared, and a PRE-PLAN row with
 * no key at all is preserved rather than cleared on a guess.
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

/** BS EN 60898 / B / 32 A @ 0.4 s derives 1.44 Ω (Table 41.2). */
const derivedRow = (over: Partial<CircuitRow> = {}): CircuitRow => ({
  id: 'c-1',
  circuit_ref: '1',
  circuit_designation: 'Cooker',
  ocpd_bs_en: 'BS EN 60898',
  ocpd_type: 'B',
  ocpd_rating_a: '32',
  max_disconnect_time_s: '0.4',
  ocpd_max_zs_ohm: '1.44',
  ...over,
});

describe('H3 wiring — a row this code derived is recomputed and cleared', () => {
  it('a complete tuple auto-derives, and records that it did', () => {
    const row: CircuitRow = { id: 'c-1', circuit_ref: '1', circuit_designation: 'Cooker' };
    const applied = applyExtractionToJob(
      makeJob({ circuits: [row] }),
      makeResult({
        readings: [
          { circuit: 1, field: 'ocpd_bs_en', value: 'BS EN 60898' },
          { circuit: 1, field: 'ocpd_type', value: 'B' },
          { circuit: 1, field: 'ocpd_rating_a', value: '32' },
          { circuit: 1, field: 'max_disconnect_time_s', value: '0.4' },
        ],
      })
    );
    const out = applied!.patch.circuits![0];
    expect(out.ocpd_max_zs_ohm).toBe('1.44');
    // Without this the very next tuple change would read the row as pre-plan
    // data and refuse to recompute it for the rest of the job's life.
    expect(out.ocpd_max_zs_source).toBe('auto');
  });

  it('model path: a LIM reading overwrites the rating AND clears the auto value', () => {
    const applied = applyExtractionToJob(
      makeJob({ circuits: [derivedRow({ ocpd_max_zs_source: 'auto' })] }),
      makeResult({ readings: [{ circuit: 1, field: 'ocpd_rating_a', value: 'LIM' }] })
    );
    const out = applied!.patch.circuits![0];
    expect(out.ocpd_rating_a).toBe('LIM');
    expect(out.ocpd_max_zs_ohm ?? '').toBe('');
    // The key goes with the value: a cleared cell that kept a stale source
    // would never derive again.
    expect(out.ocpd_max_zs_source ?? '').toBe('');
  });

  it('a STANDARD change alone invalidates an auto value — wider than P3 Fix 6', () => {
    // The rating and type are untouched and still perfectly numeric, so the
    // old rating→sentinel rule would not have fired at all. BS 3871 has no
    // lookup row, so the 1.44 that was derived for a BS EN 60898 breaker is
    // now a figure for a different device.
    // Driven as a spoken CORRECTION (`replaces_cleared`), because the 3-tier
    // value guard otherwise refuses to overwrite a populated column — which is
    // itself correct and unrelated to this rule.
    const applied = applyExtractionToJob(
      makeJob({ circuits: [derivedRow({ ocpd_max_zs_source: 'auto' })] }),
      makeResult({
        readings: [
          { circuit: 1, field: 'ocpd_bs_en', value: 'BS 3871', replaces_cleared: true } as never,
        ],
      })
    );
    const out = applied!.patch.circuits![0];
    expect(out.ocpd_bs_en).toBe('BS 3871');
    expect(out.ocpd_max_zs_ohm ?? '').toBe('');
  });

  it('a LIM rating on a blank-max-Zs row fabricates nothing', () => {
    const applied = applyExtractionToJob(
      makeJob({
        circuits: [
          { id: 'c-1', circuit_ref: '1', ocpd_bs_en: 'BS EN 60898', ocpd_type: 'B' } as CircuitRow,
        ],
      }),
      makeResult({ readings: [{ circuit: 1, field: 'ocpd_rating_a', value: 'LIM' }] })
    );
    expect(applied?.patch.circuits?.[0]?.ocpd_max_zs_ohm ?? '').toBe('');
  });

  it('a LIM ocpd_breaking_capacity_ka does NOT touch the max Zs', () => {
    // Breaking capacity is not a lookup input, and never was.
    const applied = applyExtractionToJob(
      makeJob({ circuits: [derivedRow({ ocpd_max_zs_source: 'auto' })] }),
      makeResult({ readings: [{ circuit: 1, field: 'ocpd_breaking_capacity_ka', value: 'LIM' }] })
    );
    const out = applied?.patch.circuits?.[0] ?? derivedRow();
    expect(out.ocpd_max_zs_ohm).toBe('1.44');
  });
});

describe('H3 wiring — the two states the helper must NOT touch', () => {
  it('a MANUAL value survives a LIM rating, even when it equals the lookup', () => {
    // The case P3 Fix 6 got wrong. `1.44` is exactly what the pre-LIM tuple
    // computes, so the old equality inference deleted it.
    for (const value of ['1.44', '9.99']) {
      const applied = applyExtractionToJob(
        makeJob({
          circuits: [derivedRow({ ocpd_max_zs_ohm: value, ocpd_max_zs_source: 'manual' })],
        }),
        makeResult({ readings: [{ circuit: 1, field: 'ocpd_rating_a', value: 'LIM' }] })
      );
      const out = applied?.patch.circuits?.[0];
      expect(out?.ocpd_max_zs_ohm).toBe(value);
      expect(out?.ocpd_max_zs_source).toBe('manual');
    }
  });

  it('a PRE-PLAN row with a value and NO key is preserved, not cleared', () => {
    // Deliberate change of behaviour. The row's origin is unknown, so the
    // honest answer is to keep it and mark it "unverified" on the grid and the
    // PDF preflight rather than delete a reading that may have been measured.
    const applied = applyExtractionToJob(
      makeJob({ circuits: [derivedRow()] }),
      makeResult({ readings: [{ circuit: 1, field: 'ocpd_rating_a', value: 'LIM' }] })
    );
    const out = applied?.patch.circuits?.[0] ?? derivedRow();
    expect(out.ocpd_max_zs_ohm).toBe('1.44');
    expect(out.ocpd_max_zs_source ?? '').toBe('');
  });
});

describe('H3 wiring — multi-board and free-text safety', () => {
  // Codex-r1 F6 — main + sub-board both have circuit_ref "1". Web's
  // per-circuit reading apply is ref-only, so an ambiguous target suppresses
  // the LIM-overwrite exception entirely: neither rating becomes LIM and
  // neither max Zs is touched. This is the pre-existing multi-board reading
  // limitation, NOT a wrong-board corruption — which is what the assertion
  // below is actually guarding.
  it('an AMBIGUOUS same-ref LIM rating corrupts neither board', () => {
    const main = derivedRow({ id: 'm-1', board_id: 'main', ocpd_max_zs_source: 'auto' });
    const sub = derivedRow({
      id: 's-1',
      board_id: 'sub',
      ocpd_rating_a: '16',
      ocpd_max_zs_ohm: '2.87',
      ocpd_max_zs_source: 'auto',
    });
    const applied = applyExtractionToJob(
      makeJob({ circuits: [main, sub] }),
      makeResult({ readings: [{ circuit: 1, field: 'ocpd_rating_a', value: 'LIM' } as never] })
    );
    const out = applied?.patch.circuits ?? [main, sub];
    const mainOut = out.find((c) => c.id === 'm-1')!;
    const subOut = out.find((c) => c.id === 's-1')!;
    expect(mainOut.ocpd_rating_a).toBe('32');
    expect(subOut.ocpd_rating_a).toBe('16');
    expect(mainOut.ocpd_max_zs_ohm).toBe('1.44');
    expect(subOut.ocpd_max_zs_ohm).toBe('2.87');
  });

  it('F4: a LIM reading does NOT overwrite a populated free-text designation', () => {
    const row: CircuitRow = {
      id: 'c-1',
      circuit_ref: '1',
      circuit_designation: 'Cooker',
    };
    const applied = applyExtractionToJob(
      makeJob({ circuits: [row] }),
      makeResult({
        readings: [{ circuit: 1, field: 'circuit_designation', value: 'LIM' } as never],
      })
    );
    expect(applied?.patch.circuits?.[0]?.circuit_designation ?? 'Cooker').toBe('Cooker');
  });
});
