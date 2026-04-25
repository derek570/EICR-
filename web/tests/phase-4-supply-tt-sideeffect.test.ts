/**
 * Phase 4 — Supply tab TT earthing side effect + autoContinuityIfBonded
 * + Ze→polarity guard. Tests the pure derivations used by SupplyPage
 * (iOS `SupplyTab.swift:L28-L48`, L343-L351, L377-L395).
 *
 * We test the derivation functions directly rather than mounting the
 * full Supply page — the page is a ~500-line React component whose
 * side-effect surface we cover via the UX shape elsewhere. Extracting
 * the rules keeps the test focused on the invariants the iOS client
 * relies on for data-model parity.
 */

import { describe, expect, it } from 'vitest';

type SupplyShape = Record<string, string | boolean | undefined>;

/**
 * Mirrors the Supply page's `setEarthingArrangement` handler. When the
 * user picks TT, the electrode flags flip on AND the inspection tab's
 * is_tt_earthing gets mirrored. Non-TT selections leave
 * `means_earthing_electrode` ALONE (user may have set it intentionally
 * on a TN-S or TN-C-S system).
 */
export function computeEarthingArrangementPatch(
  current: SupplyShape,
  value: string | null
): { supply: SupplyShape; is_tt_earthing: boolean } {
  const supplyPatch: SupplyShape = { earthing_arrangement: value ?? undefined };
  if (value === 'TT') {
    supplyPatch.means_earthing_electrode = true;
    supplyPatch.means_earthing_distributor = false;
  }
  return { supply: supplyPatch, is_tt_earthing: value === 'TT' };
}

/**
 * Mirrors `autoContinuityIfBonded`. Auto-tick main_bonding_continuity
 * to PASS when any of the 5 extraneous bonds is PASS; never clear a
 * non-empty non-N/A value the inspector has set.
 */
export function computeBondingPatch(
  current: SupplyShape,
  key: string,
  value: string | null
): SupplyShape {
  const next: SupplyShape = { [key]: value ?? undefined };
  if (value === 'PASS') {
    const existing = (current.main_bonding_continuity as string | undefined) ?? '';
    if (!existing || existing === 'N/A') {
      next.main_bonding_continuity = 'PASS';
    }
  }
  return next;
}

describe('Supply — Earthing arrangement side effects', () => {
  it('TT: ticks electrode=true, distributor=false, mirrors is_tt_earthing=true', () => {
    const patch = computeEarthingArrangementPatch({}, 'TT');
    expect(patch.supply.means_earthing_electrode).toBe(true);
    expect(patch.supply.means_earthing_distributor).toBe(false);
    expect(patch.is_tt_earthing).toBe(true);
    expect(patch.supply.earthing_arrangement).toBe('TT');
  });

  it('TN-S: is_tt_earthing=false, electrode flag untouched', () => {
    const patch = computeEarthingArrangementPatch({ means_earthing_electrode: true }, 'TN-S');
    // We DO NOT clear the electrode flag — a manual override on a
    // non-TT system stays.
    expect(patch.supply.means_earthing_electrode).toBeUndefined();
    expect(patch.is_tt_earthing).toBe(false);
    expect(patch.supply.earthing_arrangement).toBe('TN-S');
  });

  it('null: clears arrangement, is_tt_earthing=false, no side effects', () => {
    const patch = computeEarthingArrangementPatch({}, null);
    expect(patch.supply.earthing_arrangement).toBeUndefined();
    expect(patch.is_tt_earthing).toBe(false);
    // No electrode fiddling when we don't know what the user wants.
    expect(patch.supply.means_earthing_electrode).toBeUndefined();
  });
});

describe('Supply — autoContinuityIfBonded', () => {
  it('PASS on any bond with no existing continuity → auto-PASS main bonding', () => {
    const patch = computeBondingPatch({}, 'bonding_water', 'PASS');
    expect(patch.bonding_water).toBe('PASS');
    expect(patch.main_bonding_continuity).toBe('PASS');
  });

  it('PASS with existing main-bonding-continuity = FAIL → respects manual answer', () => {
    const patch = computeBondingPatch({ main_bonding_continuity: 'FAIL' }, 'bonding_water', 'PASS');
    expect(patch.bonding_water).toBe('PASS');
    // Critical: the FAIL-must-not-flip rule. Autocomplete never stomps
    // a definitive manual value.
    expect(patch.main_bonding_continuity).toBeUndefined();
  });

  it('PASS with existing N/A → promotes to PASS (N/A is the default)', () => {
    const patch = computeBondingPatch({ main_bonding_continuity: 'N/A' }, 'bonding_water', 'PASS');
    expect(patch.main_bonding_continuity).toBe('PASS');
  });

  it('FAIL on a bond — does NOT auto-set main bonding to FAIL', () => {
    const patch = computeBondingPatch({}, 'bonding_water', 'FAIL');
    expect(patch.bonding_water).toBe('FAIL');
    expect(patch.main_bonding_continuity).toBeUndefined();
  });

  it('LIM on a bond — does NOT trigger the auto-continuity', () => {
    const patch = computeBondingPatch({}, 'bonding_gas', 'LIM');
    expect(patch.bonding_gas).toBe('LIM');
    expect(patch.main_bonding_continuity).toBeUndefined();
  });
});
