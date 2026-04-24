/**
 * Circuit impedance calculators — mirror iOS `CircuitsTab.swift:L1924-L2007`.
 *
 * Two operations:
 *   1. Zs = Ze + R1+R2           (measured_zs_ohm derived from r1_r2_ohm + supply Ze)
 *   2. R1+R2 = Zs - Ze           (r1_r2_ohm derived from measured_zs_ohm - supply Ze)
 *
 * Both are pure and safe to call on any circuit. They skip circuits that
 * are missing the required inputs, and (for R1+R2) circuits where the
 * subtraction would yield a negative value — iOS surfaces that as an
 * alert and leaves the field alone rather than clamping to 0. We mirror
 * that invariant because a negative R1+R2 almost always means the
 * inspector entered Zs or Ze wrong, so silently zeroing it hides the
 * data-quality problem.
 *
 * `formatImpedance` trims trailing zeros to match the iOS formatter —
 * a 2-decimal default with trailing zeros / trailing dots removed,
 * so `0.5 + 0.1 → "0.6"` (not "0.60") and `1 + 1 → "2"` (not "2.00").
 * Without this the field becomes noisy after a single round-trip.
 *
 * Shared with iOS via `packages/shared-utils/`; iOS can't import TS
 * directly but keeps a hand-ported copy of the same algorithm so both
 * platforms produce byte-identical values.
 */

import type { Circuit } from '@certmate/shared-types';

/** Reason a single-circuit calculation was skipped. */
export type CalcSkipReason =
  | 'missing-ze'
  | 'missing-r1r2'
  | 'missing-zs'
  | 'invalid-ze'
  | 'invalid-r1r2'
  | 'invalid-zs'
  | 'negative-r1r2';

export interface CalcResult {
  /** The derived value, or null when skipped. */
  value: number | null;
  /** Formatted string (if value is non-null), ready for `measured_zs_ohm` / `r1_r2_ohm`. */
  formatted: string | null;
  /** Why the calc was skipped (absent on success). */
  reason?: CalcSkipReason;
}

/**
 * Trim a 2-decimal string of trailing zeros + trailing dot.
 * Mirrors iOS `formatImpedance` so round-trips don't accumulate noise.
 */
export function formatImpedance(value: number): string {
  const base = value.toFixed(2);
  if (!base.includes('.')) return base;
  let s = base;
  while (s.endsWith('0')) s = s.slice(0, -1);
  if (s.endsWith('.')) s = s.slice(0, -1);
  return s;
}

/** Parse an impedance input; reject NaN / empty / non-finite. */
function parseOhm(value: string | undefined | null): number | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (trimmed.length === 0) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  return n;
}

/**
 * Calculate Zs = Ze + R1+R2 for a single circuit.
 * Returns the formatted string if both inputs are present and valid.
 */
export function calculateZsFromR1R2(
  circuit: Partial<Circuit>,
  ze: string | number | undefined | null
): CalcResult {
  const zeNum = typeof ze === 'number' ? ze : parseOhm(ze ?? undefined);
  if (ze == null || ze === '') return { value: null, formatted: null, reason: 'missing-ze' };
  if (zeNum === null) return { value: null, formatted: null, reason: 'invalid-ze' };

  const r1r2Raw = circuit.r1_r2_ohm;
  if (r1r2Raw == null || r1r2Raw === '') {
    return { value: null, formatted: null, reason: 'missing-r1r2' };
  }
  const r1r2 = parseOhm(r1r2Raw);
  if (r1r2 === null) return { value: null, formatted: null, reason: 'invalid-r1r2' };

  const zs = zeNum + r1r2;
  return { value: zs, formatted: formatImpedance(zs) };
}

/**
 * Calculate R1+R2 = Zs - Ze for a single circuit.
 * Skips when the subtraction would be negative (see module header).
 */
export function calculateR1R2FromZs(
  circuit: Partial<Circuit>,
  ze: string | number | undefined | null
): CalcResult {
  const zeNum = typeof ze === 'number' ? ze : parseOhm(ze ?? undefined);
  if (ze == null || ze === '') return { value: null, formatted: null, reason: 'missing-ze' };
  if (zeNum === null) return { value: null, formatted: null, reason: 'invalid-ze' };

  const zsRaw = circuit.measured_zs_ohm;
  if (zsRaw == null || zsRaw === '') {
    return { value: null, formatted: null, reason: 'missing-zs' };
  }
  const zs = parseOhm(zsRaw);
  if (zs === null) return { value: null, formatted: null, reason: 'invalid-zs' };

  const r1r2 = zs - zeNum;
  if (r1r2 < 0) return { value: null, formatted: null, reason: 'negative-r1r2' };
  return { value: r1r2, formatted: formatImpedance(r1r2) };
}

export interface BulkCalcOutcome<T extends Partial<Circuit>> {
  /** The updated circuits array (same length/order as input; unchanged entries preserved by reference). */
  circuits: T[];
  /** How many circuits were actually updated. */
  updated: number;
  /** How many circuits were skipped (missing inputs, invalid, or negative). */
  skipped: number;
  /** Grouped skip reasons for the result banner. */
  skippedReasons: Partial<Record<CalcSkipReason, number>>;
  /**
   * Terminal failure code if the whole batch should be treated as a
   * "can't run" case (e.g. no Ze at all). Present only when
   * `updated === 0` and there's a single root cause.
   */
  terminalReason?: CalcSkipReason;
}

function bulkApply<T extends Partial<Circuit>>(
  circuits: T[],
  ze: string | number | undefined | null,
  computeFor: (c: T) => CalcResult,
  writeField: keyof Circuit
): BulkCalcOutcome<T> {
  // Treat "no Ze at all" as a terminal failure — iOS surfaces a single
  // "No Ze value set" alert rather than 30 per-circuit skip reasons.
  const zeNum = typeof ze === 'number' ? ze : parseOhm(ze ?? undefined);
  if (ze == null || ze === '' || zeNum === null) {
    return {
      circuits,
      updated: 0,
      skipped: circuits.length,
      skippedReasons: {},
      terminalReason: zeNum === null && ze != null && ze !== '' ? 'invalid-ze' : 'missing-ze',
    };
  }

  const skippedReasons: Partial<Record<CalcSkipReason, number>> = {};
  let updated = 0;
  const next = circuits.map((c) => {
    const res = computeFor(c);
    if (res.formatted == null) {
      if (res.reason) skippedReasons[res.reason] = (skippedReasons[res.reason] ?? 0) + 1;
      return c;
    }
    updated += 1;
    return { ...c, [writeField]: res.formatted } as T;
  });

  return {
    circuits: next,
    updated,
    skipped: circuits.length - updated,
    skippedReasons,
  };
}

/** Apply Zs = Ze + R1+R2 to every circuit that has a valid R1+R2. */
export function applyZsCalculation<T extends Partial<Circuit>>(
  circuits: T[],
  ze: string | number | undefined | null
): BulkCalcOutcome<T> {
  return bulkApply(circuits, ze, (c) => calculateZsFromR1R2(c, ze), 'measured_zs_ohm');
}

/** Apply R1+R2 = Zs - Ze to every circuit that has a valid Zs (and non-negative result). */
export function applyR1R2Calculation<T extends Partial<Circuit>>(
  circuits: T[],
  ze: string | number | undefined | null
): BulkCalcOutcome<T> {
  return bulkApply(circuits, ze, (c) => calculateR1R2FromZs(c, ze), 'r1_r2_ohm');
}
