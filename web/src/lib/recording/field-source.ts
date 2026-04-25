/**
 * Tracks which tier of the recording pipeline last wrote each field
 * during a session.
 *
 * Port of iOS `DeepgramRecordingViewModel.fieldSources` +
 * `originallyPreExistingKeys` (R2 of `web/audit/REGEX_TIER_PLAN.md`).
 *
 * Used by `applySonnetValue` / `applyRegexValue` (in `apply-rules.ts`)
 * to enforce the 3-tier priority chain that mirrors iOS:
 *
 *   pre-existing  >  Sonnet  >  regex
 *
 * Sources for keys:
 *   - 'preExisting' — value was already populated when the recording
 *     session started (manual entry, CCU import, document extraction,
 *     prior session). The map is initialised by walking the JobDetail
 *     and stamping every populated field on session start.
 *   - 'regex'       — the most recent write was from
 *     `TranscriptFieldMatcher` (R3). Last-write-wins within the regex
 *     tier; Sonnet writes will overwrite when different.
 *   - 'sonnet'      — the most recent write was from a Sonnet
 *     extraction frame. Sonnet writes overwrite regex and pre-existing
 *     values when different (logged as `discrepancy_overwrite` /
 *     `preexisting_overwrite` for parity with iOS telemetry).
 *
 * `originallyPreExistingKeys` survives Sonnet overwrites so question-
 * suppression for "we already had this from CCU/manual" still works
 * after Sonnet has corrected the value. Match iOS:
 * `DeepgramRecordingViewModel.swift:4414` checks `originallyPreExisting`
 * to decide whether to fire a clarification question.
 *
 * Key format: iOS-canon dot paths.
 *   - Top-level sections: `supply.ze`, `board.manufacturer`,
 *     `installation.postcode`, `extent.<field>`, `design.<field>`.
 *   - Per-circuit: `circuit.<circuitRef>.<field>`. circuitRef is the
 *     stringified circuit number from `CircuitRow.circuit_ref` (1, 2,
 *     12, …) — NOT the row id. iOS keys this way and the regex-hint
 *     wire protocol (R5) requires the same shape.
 *   - Observations: not tracked here (Sonnet only ever appends, never
 *     amends; the priority rules don't apply).
 */

import type { CircuitRow, JobDetail } from '../types';
import { hasValue } from './apply-utils';

export type FieldSource = 'regex' | 'sonnet' | 'preExisting';

/** Top-level JobDetail keys whose flat record contributes pre-existing
 *  field-source entries on session start. Mirrors `SCALAR_SECTIONS` in
 *  apply-extraction.ts (kept independent so future divergence in either
 *  direction is explicit). */
const TOP_LEVEL_SECTIONS: ReadonlyArray<keyof JobDetail> = [
  'installation',
  'supply',
  'board',
  'extent',
  'design',
];

export class FieldSourceMap {
  private readonly sources = new Map<string, FieldSource>();
  private readonly preExistingKeys = new Set<string>();

  set(key: string, source: FieldSource): void {
    this.sources.set(key, source);
    if (source === 'preExisting') {
      this.preExistingKeys.add(key);
    }
  }

  get(key: string): FieldSource | undefined {
    return this.sources.get(key);
  }

  has(key: string): boolean {
    return this.sources.has(key);
  }

  delete(key: string): void {
    this.sources.delete(key);
  }

  /** Mark a key as having been pre-existing at session start. Used
   *  internally by `applySonnetValue` so question-suppression for
   *  CCU/manual-imported fields survives a Sonnet correction. */
  markOriginallyPreExisting(key: string): void {
    this.preExistingKeys.add(key);
  }

  /** True if the key was pre-existing on session start, even if a
   *  later regex/sonnet write has since changed the source label. */
  isOriginallyPreExisting(key: string): boolean {
    return this.preExistingKeys.has(key);
  }

  /** Snapshot the current entries — read-only iteration for tests
   *  and for the regex-hint summary builder (R5). */
  entries(): IterableIterator<[string, FieldSource]> {
    return this.sources.entries();
  }

  /** Reset the map. Called at session start (after
   *  `initializeFromJob`) and on session end so a new session
   *  doesn't inherit the previous one's source labels. */
  clear(): void {
    this.sources.clear();
    this.preExistingKeys.clear();
  }

  /** Walk a JobDetail and stamp every populated field as 'preExisting'.
   *  Subsequent writes from regex / Sonnet flip the label as they
   *  fire. Idempotent — calling twice on the same job is a no-op
   *  (pre-existing labels stay sticky on the key set). */
  initializeFromJob(job: JobDetail): void {
    for (const section of TOP_LEVEL_SECTIONS) {
      const record = job[section] as Record<string, unknown> | undefined;
      if (!record) continue;
      for (const [field, value] of Object.entries(record)) {
        if (hasValue(value)) {
          this.set(`${section}.${field}`, 'preExisting');
        }
      }
    }
    const circuits = (job.circuits as CircuitRow[] | undefined) ?? [];
    for (const row of circuits) {
      const ref = row.circuit_ref ?? row.number;
      if (typeof ref !== 'string' || ref.length === 0) continue;
      for (const [field, value] of Object.entries(row)) {
        // Skip identity / structural fields — they are never user-
        // measurable readings the priority chain applies to.
        if (field === 'id' || field === 'circuit_ref' || field === 'number') continue;
        if (hasValue(value)) {
          this.set(`circuit.${ref}.${field}`, 'preExisting');
        }
      }
    }
  }
}

/** Build a stable dot-path key for a circuit-0 reading on the section
 *  the routing layer chose (kept here so apply-rules and the hint
 *  builder share a single keying source). */
export function circuit0Key(section: string, field: string): string {
  return `${section}.${field}`;
}

/** Build a stable dot-path key for a per-circuit reading. */
export function perCircuitKey(circuitRef: string | number, field: string): string {
  return `circuit.${circuitRef}.${field}`;
}
