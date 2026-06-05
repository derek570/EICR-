/**
 * apply-extraction — M1+M2+M3 Supply-tab side-effect parity.
 *
 * iOS fires three side effects on Supply-tab edits which previously
 * fired ONLY on tab-edits, not on Sonnet writes:
 *   M1 — earthing_arrangement=TT mirrors to means_earthing_*
 *        and inspection_schedule.is_tt_earthing
 *   M2 — bonding-row PASS (with synonym normalisation) auto-ticks
 *        main_bonding_continuity = PASS
 *   M3 — numeric Ze auto-confirms supply_polarity_confirmed +
 *        earthing_conductor_continuity = PASS
 *
 * These tests pin the parity. iOS refs: `SupplyTab.swift`
 * setEarthingArrangement, autoContinuityIfBonded, handleZeChange.
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

describe('apply-extraction M1 — TT earthing mirror', () => {
  it('flips means_earthing_* + inspection_schedule.is_tt_earthing on TT', () => {
    const result = makeResult({
      readings: [{ circuit: 0, field: 'earthing_arrangement', value: 'TT' }],
    });
    const applied = applyExtractionToJob(makeJob(), result);
    expect(applied).not.toBeNull();
    const supply = applied!.patch.supply_characteristics as Record<string, unknown>;
    expect(supply.earthing_arrangement).toBe('TT');
    expect(supply.means_earthing_electrode).toBe(true);
    expect(supply.means_earthing_distributor).toBe(false);
    const schedule = applied!.patch.inspection_schedule as Record<string, unknown>;
    expect(schedule.is_tt_earthing).toBe(true);
  });

  it('does not fire for non-TT earthing systems', () => {
    const result = makeResult({
      readings: [{ circuit: 0, field: 'earthing_arrangement', value: 'TN-C-S' }],
    });
    const applied = applyExtractionToJob(makeJob(), result);
    const supply = applied!.patch.supply_characteristics as Record<string, unknown>;
    expect(supply.earthing_arrangement).toBe('TN-C-S');
    expect(supply.means_earthing_electrode).toBeUndefined();
    expect(applied!.patch.inspection_schedule).toBeUndefined();
  });
});

describe('apply-extraction M2 — bonding PASS auto-continuity', () => {
  it('auto-ticks main_bonding_continuity when bonding_water = PASS', () => {
    const result = makeResult({
      readings: [{ circuit: 0, field: 'bonding_water', value: 'PASS' }],
    });
    const applied = applyExtractionToJob(makeJob(), result);
    const supply = applied!.patch.supply_characteristics as Record<string, unknown>;
    expect(supply.bonding_water).toBe('PASS');
    expect(supply.main_bonding_continuity).toBe('PASS');
  });

  it('normalises synonyms ("yes", "confirmed") → PASS', () => {
    const result = makeResult({
      readings: [{ circuit: 0, field: 'bonding_gas', value: 'yes' }],
    });
    const applied = applyExtractionToJob(makeJob(), result);
    const supply = applied!.patch.supply_characteristics as Record<string, unknown>;
    expect(supply.bonding_gas).toBe('PASS');
    expect(supply.main_bonding_continuity).toBe('PASS');
  });

  it('preserves a user-set main_bonding_continuity = FAIL', () => {
    const job = makeJob({
      supply_characteristics: { main_bonding_continuity: 'FAIL' },
    });
    const result = makeResult({
      readings: [{ circuit: 0, field: 'bonding_water', value: 'PASS' }],
    });
    const applied = applyExtractionToJob(job, result);
    const supply = applied!.patch.supply_characteristics as Record<string, unknown>;
    // Same fold-in behaviour as the polarity test — the patch carries
    // forward the user's FAIL value (not stripped); the derivation
    // saw the existing FAIL and did NOT mirror PASS over the top.
    expect(supply.main_bonding_continuity).toBe('FAIL');
  });

  it('overwrites N/A → PASS (matches iOS tab-edit behaviour)', () => {
    const job = makeJob({
      supply_characteristics: { main_bonding_continuity: 'N/A' },
    });
    const result = makeResult({
      readings: [{ circuit: 0, field: 'bonding_water', value: 'PASS' }],
    });
    const applied = applyExtractionToJob(job, result);
    const supply = applied!.patch.supply_characteristics as Record<string, unknown>;
    expect(supply.main_bonding_continuity).toBe('PASS');
  });
});

describe('apply-extraction M3 — Ze auto-confirms polarity + continuity', () => {
  it('flips supply_polarity_confirmed=true + earthing_conductor_continuity=PASS on a numeric Ze', () => {
    const result = makeResult({
      readings: [{ circuit: 0, field: 'ze', value: '0.42' }],
    });
    const applied = applyExtractionToJob(makeJob(), result);
    const supply = applied!.patch.supply_characteristics as Record<string, unknown>;
    expect(supply.ze).toBe('0.42');
    expect(supply.earth_loop_impedance_ze).toBe('0.42'); // dual-write
    expect(supply.supply_polarity_confirmed).toBe(true);
    expect(supply.earthing_conductor_continuity).toBe('PASS');
  });

  it('does NOT fire for an empty / non-numeric Ze write', () => {
    const result = makeResult({
      readings: [{ circuit: 0, field: 'ze', value: '' }],
    });
    const applied = applyExtractionToJob(makeJob(), result);
    // Empty value: section patch may not even fire. Either way no
    // polarity flip.
    const supply = (applied?.patch.supply_characteristics ?? {}) as Record<string, unknown>;
    expect(supply.supply_polarity_confirmed).toBeUndefined();
  });

  it('preserves a user-set polarity=false (false is hasValue=true via boolean)', () => {
    const job = makeJob({
      supply_characteristics: { supply_polarity_confirmed: false },
    });
    const result = makeResult({
      readings: [{ circuit: 0, field: 'ze', value: '0.42' }],
    });
    const applied = applyExtractionToJob(job, result);
    const supply = applied!.patch.supply_characteristics as Record<string, unknown>;
    // applyCircuit0Readings folds the existing section into the patch
    // (line 218: `{ ...existing, ...bySection[section] }`), so the
    // user's false stays on the patch — the derivation did NOT flip
    // it to true.
    expect(supply.supply_polarity_confirmed).toBe(false);
  });
});
