/**
 * Convert a TranscriptFieldMatcher RegexMatchResult into a JobDetail
 * patch via the 3-tier priority chain (R4 of REGEX_TIER_PLAN.md).
 *
 * Each candidate write goes through `applyRegexValue` so the regex
 * tier respects the iOS rules:
 *   - Empty currentValue → write, source=regex.
 *   - Same source already regex AND value differs → last-wins.
 *   - Source is sonnet or preExisting → no-op.
 *
 * Returns a partial JobDetail patch + a list of dot-path keys that
 * actually got written so the LiveFill chip + the R5 regex-hint
 * summary builder can both source-of-truth from one place.
 */

import type { CircuitRow, JobDetail } from '../types';
import { applyRegexValue } from './apply-rules';
import { circuit0Key, perCircuitKey, type FieldSourceMap } from './field-source';
import type { CircuitUpdates, RegexMatchResult } from './transcript-field-matcher';

type Section = 'supply' | 'board' | 'installation';

/** Where each regex-tier field lives on the JobDetail. ze + pfc go
 *  to `supply`; circuit-level fields go to `circuits[]`. Kept in
 *  sync with the matcher's RegexMatchResult shape. */
const SUPPLY_FIELDS = ['ze', 'pfc'] as const;

export type AppliedRegex = {
  patch: Partial<JobDetail>;
  changedKeys: string[];
};

export function applyRegexResultToJob(
  job: JobDetail,
  result: RegexMatchResult,
  sources: FieldSourceMap
): AppliedRegex | null {
  const patch: Partial<JobDetail> = {};
  const changedKeys: string[] = [];

  // Supply fields (ze, pfc).
  for (const field of SUPPLY_FIELDS) {
    const newValue = result.supplyUpdates[field];
    if (newValue == null) continue;
    const section: Section = 'supply';
    const existingSection =
      (patch.supply as Record<string, unknown> | undefined) ??
      (job.supply as Record<string, unknown> | undefined) ??
      {};
    const currentValue = existingSection[field];
    const key = circuit0Key(section, field);
    const outcome = applyRegexValue({
      key,
      newValue,
      currentValue,
      sources,
      apply: () => {
        patch.supply = { ...(patch.supply ?? job.supply ?? {}), [field]: newValue };
      },
    });
    if (outcome.applied) changedKeys.push(`${section}.${field}`);
  }

  // Per-circuit fields. The matcher emits keys against circuit_ref
  // (not row id), so route through circuit_ref → row index.
  if (result.circuitUpdates.size > 0) {
    const circuits = [...((job.circuits as CircuitRow[] | undefined) ?? [])];
    const indexByRef = new Map<string, number>();
    circuits.forEach((row, idx) => {
      const ref = row.circuit_ref ?? row.number;
      if (typeof ref === 'string' && ref) indexByRef.set(ref, idx);
    });

    let circuitsChanged = false;

    for (const [circuitRef, updates] of result.circuitUpdates) {
      const idx = indexByRef.get(circuitRef);
      if (idx == null) continue; // matcher claimed an unknown ref → skip rather than create.
      for (const [field, newValue] of Object.entries(updates) as Array<
        [keyof CircuitUpdates, string | undefined]
      >) {
        if (newValue == null) continue;
        const row = circuits[idx];
        const currentValue = row[field as keyof typeof row];
        const key = perCircuitKey(circuitRef, field);
        const outcome = applyRegexValue({
          key,
          newValue,
          currentValue,
          sources,
          apply: () => {
            circuits[idx] = { ...circuits[idx], [field]: newValue };
            circuitsChanged = true;
          },
        });
        if (outcome.applied) {
          // LiveFill keys are "circuit.<rowId>.<field>" — match the
          // existing apply-extraction key shape so the same chip
          // animation fires on regex writes as on Sonnet writes.
          changedKeys.push(`circuit.${row.id}.${field as string}`);
        }
      }
    }

    if (circuitsChanged) patch.circuits = circuits;
  }

  if (Object.keys(patch).length === 0 && changedKeys.length === 0) return null;
  return { patch, changedKeys };
}
