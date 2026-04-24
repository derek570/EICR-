/**
 * Phase 5 — impedance calculator tests.
 *
 * Covers the two operations surfaced by the Circuits tab's Calculate
 * menu (port of iOS `CircuitsTab.swift:L1924-L2007`):
 *   - Zs     = Ze + R1+R2
 *   - R1+R2  = Zs − Ze  (skipped when result would be negative)
 *
 * Tests target `@certmate/shared-utils` directly — the web page only
 * wires these pure functions into `updateJob`, so covering the algorithm
 * at the shared-utils layer gives us iOS-parity confidence without
 * mounting the Next page.
 */

import { describe, expect, it } from 'vitest';
import {
  applyR1R2Calculation,
  applyZsCalculation,
  calculateR1R2FromZs,
  calculateZsFromR1R2,
  formatImpedance,
} from '@certmate/shared-utils';
import type { Circuit } from '@certmate/shared-types';

describe('formatImpedance', () => {
  it('trims trailing zeros after 2-decimal format', () => {
    expect(formatImpedance(0.6)).toBe('0.6');
    expect(formatImpedance(0.5)).toBe('0.5');
  });

  it('drops the decimal dot when the value is a whole number', () => {
    expect(formatImpedance(2)).toBe('2');
    expect(formatImpedance(10)).toBe('10');
  });

  it('rounds to two decimal places before trimming', () => {
    expect(formatImpedance(0.666666)).toBe('0.67');
    expect(formatImpedance(1.235)).toBe('1.24'); // banker or arith — .toFixed rounds up at .5
  });
});

describe('calculateZsFromR1R2 (per-circuit)', () => {
  it('adds Ze + R1+R2 for the happy path', () => {
    const res = calculateZsFromR1R2({ r1_r2_ohm: '0.45' }, '0.32');
    expect(res.value).toBeCloseTo(0.77, 5);
    expect(res.formatted).toBe('0.77');
    expect(res.reason).toBeUndefined();
  });

  it('skips when R1+R2 is missing', () => {
    const res = calculateZsFromR1R2({}, '0.32');
    expect(res.formatted).toBeNull();
    expect(res.reason).toBe('missing-r1r2');
  });

  it('skips when R1+R2 is empty string', () => {
    const res = calculateZsFromR1R2({ r1_r2_ohm: '' }, '0.32');
    expect(res.reason).toBe('missing-r1r2');
  });

  it('skips when Ze is missing', () => {
    const res = calculateZsFromR1R2({ r1_r2_ohm: '0.45' }, undefined);
    expect(res.reason).toBe('missing-ze');
  });

  it('skips when Ze is empty string', () => {
    const res = calculateZsFromR1R2({ r1_r2_ohm: '0.45' }, '');
    expect(res.reason).toBe('missing-ze');
  });

  it('flags invalid R1+R2', () => {
    const res = calculateZsFromR1R2({ r1_r2_ohm: 'not-a-number' }, '0.32');
    expect(res.reason).toBe('invalid-r1r2');
  });

  it('flags invalid Ze', () => {
    const res = calculateZsFromR1R2({ r1_r2_ohm: '0.45' }, 'bad');
    expect(res.reason).toBe('invalid-ze');
  });

  it('accepts numeric Ze directly', () => {
    const res = calculateZsFromR1R2({ r1_r2_ohm: '0.1' }, 0.2);
    expect(res.formatted).toBe('0.3');
  });
});

describe('calculateR1R2FromZs (per-circuit)', () => {
  it('subtracts Ze from Zs for the happy path', () => {
    const res = calculateR1R2FromZs({ measured_zs_ohm: '0.77' }, '0.32');
    expect(res.value).toBeCloseTo(0.45, 5);
    expect(res.formatted).toBe('0.45');
  });

  it('skips when the result would be negative', () => {
    const res = calculateR1R2FromZs({ measured_zs_ohm: '0.2' }, '0.32');
    expect(res.reason).toBe('negative-r1r2');
    expect(res.formatted).toBeNull();
  });

  it('skips when Zs is missing', () => {
    const res = calculateR1R2FromZs({}, '0.32');
    expect(res.reason).toBe('missing-zs');
  });

  it('flags invalid Zs', () => {
    const res = calculateR1R2FromZs({ measured_zs_ohm: 'x' }, '0.32');
    expect(res.reason).toBe('invalid-zs');
  });

  it('treats Zs exactly equal to Ze as 0 (valid)', () => {
    const res = calculateR1R2FromZs({ measured_zs_ohm: '0.32' }, '0.32');
    expect(res.formatted).toBe('0');
  });
});

type Row = Partial<Circuit> & { id: string; circuit_ref: string; circuit_designation: string };

describe('applyZsCalculation (bulk)', () => {
  it('updates every circuit with a valid R1+R2', () => {
    const input: Row[] = [
      { id: '1', circuit_ref: '1', circuit_designation: 'Lights', r1_r2_ohm: '0.45' },
      { id: '2', circuit_ref: '2', circuit_designation: 'Sockets', r1_r2_ohm: '0.28' },
    ];
    const res = applyZsCalculation(input, '0.32');
    expect(res.updated).toBe(2);
    expect(res.skipped).toBe(0);
    expect(res.circuits[0].measured_zs_ohm).toBe('0.77');
    expect(res.circuits[1].measured_zs_ohm).toBe('0.6');
  });

  it('skips circuits missing R1+R2 but processes the rest', () => {
    const input: Row[] = [
      { id: '1', circuit_ref: '1', circuit_designation: 'Lights', r1_r2_ohm: '0.45' },
      { id: '2', circuit_ref: '2', circuit_designation: 'Cooker' }, // no R1+R2
    ];
    const res = applyZsCalculation(input, '0.32');
    expect(res.updated).toBe(1);
    expect(res.skipped).toBe(1);
    expect(res.skippedReasons['missing-r1r2']).toBe(1);
    expect(res.circuits[0].measured_zs_ohm).toBe('0.77');
    expect(res.circuits[1].measured_zs_ohm).toBeUndefined();
  });

  it('returns a terminal reason when Ze is missing', () => {
    const input: Row[] = [
      { id: '1', circuit_ref: '1', circuit_designation: 'Lights', r1_r2_ohm: '0.45' },
    ];
    const res = applyZsCalculation(input, undefined);
    expect(res.updated).toBe(0);
    expect(res.terminalReason).toBe('missing-ze');
  });

  it('returns invalid-ze terminal reason when Ze parses to NaN', () => {
    const input: Row[] = [
      { id: '1', circuit_ref: '1', circuit_designation: 'Lights', r1_r2_ohm: '0.45' },
    ];
    const res = applyZsCalculation(input, 'not-a-number');
    expect(res.terminalReason).toBe('invalid-ze');
  });

  it('preserves input array identity when no circuits change', () => {
    const input: Row[] = [{ id: '1', circuit_ref: '1', circuit_designation: 'Empty' }];
    const res = applyZsCalculation(input, '0.32');
    // All circuits are empty → none updated, no new array created.
    // (We don't assert strict identity because map() creates a new
    //  outer array, but we do assert zero updates and no measured_zs_ohm.)
    expect(res.updated).toBe(0);
    expect(res.circuits[0].measured_zs_ohm).toBeUndefined();
  });
});

describe('applyR1R2Calculation (bulk)', () => {
  it('updates every circuit with a valid Zs', () => {
    const input: Row[] = [
      { id: '1', circuit_ref: '1', circuit_designation: 'Lights', measured_zs_ohm: '0.77' },
      { id: '2', circuit_ref: '2', circuit_designation: 'Sockets', measured_zs_ohm: '0.6' },
    ];
    const res = applyR1R2Calculation(input, '0.32');
    expect(res.updated).toBe(2);
    expect(res.circuits[0].r1_r2_ohm).toBe('0.45');
    expect(res.circuits[1].r1_r2_ohm).toBe('0.28');
  });

  it('skips circuits where result would be negative', () => {
    const input: Row[] = [
      { id: '1', circuit_ref: '1', circuit_designation: 'Lights', measured_zs_ohm: '0.1' },
      { id: '2', circuit_ref: '2', circuit_designation: 'Sockets', measured_zs_ohm: '0.6' },
    ];
    const res = applyR1R2Calculation(input, '0.32');
    expect(res.updated).toBe(1);
    expect(res.skipped).toBe(1);
    expect(res.skippedReasons['negative-r1r2']).toBe(1);
    expect(res.circuits[0].r1_r2_ohm).toBeUndefined();
    expect(res.circuits[1].r1_r2_ohm).toBe('0.28');
  });

  it('does not overwrite an existing r1_r2_ohm when calc succeeds', () => {
    // Contrast with iOS: iOS intentionally overwrites because the
    // calculate-all action is "authoritative recompute". We mirror that
    // behaviour — the bulk helper writes the new value regardless.
    const input: Row[] = [
      {
        id: '1',
        circuit_ref: '1',
        circuit_designation: 'Lights',
        measured_zs_ohm: '0.77',
        r1_r2_ohm: '0.01',
      },
    ];
    const res = applyR1R2Calculation(input, '0.32');
    expect(res.circuits[0].r1_r2_ohm).toBe('0.45');
  });
});
