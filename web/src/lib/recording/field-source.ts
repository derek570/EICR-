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
  /** Per-key value snapshot taken every time a source is written. Used
   *  by `reconcileFromJob` to detect inspector edits made between
   *  Sonnet/regex writes — e.g. the inspector tapping into the
   *  Circuits tab and correcting a Zs Sonnet just filled. Without
   *  this, the next Sonnet extraction would see source='sonnet' and
   *  freely overwrite the correction. */
  private readonly snapshot = new Map<string, unknown>();

  set(key: string, source: FieldSource, value?: unknown): void {
    this.sources.set(key, source);
    if (source === 'preExisting') {
      this.preExistingKeys.add(key);
    }
    // The apply rules pass `value` so the snapshot reflects the
    // exact value the source label is now guarding. Callers without
    // a value (initializeFromJob, externally-stamped preExisting
    // entries) leave the snapshot key undefined; reconcileFromJob
    // treats `undefined` as "not yet snapshotted" and falls through
    // to the normal "first encounter" branch.
    if (arguments.length >= 3) {
      this.snapshot.set(key, value);
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
    this.snapshot.clear();
  }

  /** Walk the current job and detect inspector edits made since the
   *  last source-tracked write. Any field whose current value
   *  differs from our snapshot is treated as a manual edit and
   *  re-stamped as 'preExisting' so the next Sonnet extraction
   *  doesn't naively overwrite the inspector's correction.
   *
   *  Newly-populated fields (no snapshot yet, no source label yet)
   *  are stamped as 'preExisting' on first sight — the inspector
   *  must have typed them manually for them to appear without an
   *  apply-rules call.
   *
   *  Cleared fields (snapshot had a value, current job doesn't) drop
   *  out of the source map entirely. iOS does the same — once a
   *  field is empty again, the next regex / Sonnet write starts
   *  fresh from the first-set branch.
   *
   *  Call site: recording-context invokes this BEFORE each
   *  `applyExtractionToJob` so the apply rules see an up-to-date
   *  source label. iOS-equivalent: there's no explicit reconcile in
   *  iOS; manual edits go through SwiftUI bindings on the JobVM and
   *  the iOS `applySonnetValue` reads `currentValue` from the live
   *  JobVM at apply time. We have to walk the job because React
   *  doesn't expose a per-field write hook. */
  reconcileFromJob(job: JobDetail): void {
    const seenKeys = new Set<string>();

    for (const section of TOP_LEVEL_SECTIONS) {
      const record = job[section] as Record<string, unknown> | undefined;
      if (!record) continue;
      for (const [field, value] of Object.entries(record)) {
        if (!hasValue(value)) continue;
        const key = `${section}.${field}`;
        seenKeys.add(key);
        this.reconcileKey(key, value);
      }
    }

    const circuits = (job.circuits as CircuitRow[] | undefined) ?? [];
    for (const row of circuits) {
      const ref = row.circuit_ref ?? row.number;
      if (typeof ref !== 'string' || ref.length === 0) continue;
      for (const [field, value] of Object.entries(row)) {
        if (field === 'id' || field === 'circuit_ref' || field === 'number') continue;
        if (!hasValue(value)) continue;
        const key = `circuit.${ref}.${field}`;
        seenKeys.add(key);
        this.reconcileKey(key, value);
      }
    }

    // Any tracked key whose field is no longer populated → field was
    // cleared by the inspector. Drop the source label so the next
    // write goes through the first-set branch. Snapshot is cleaned
    // up too so we don't keep stale entries forever.
    for (const key of Array.from(this.sources.keys())) {
      if (!seenKeys.has(key)) {
        this.sources.delete(key);
        this.snapshot.delete(key);
        // preExistingKeys is intentionally NOT cleared — iOS
        // `originallyPreExistingKeys` is a session-lifetime audit
        // trail, not a live status flag.
      }
    }
  }

  private reconcileKey(key: string, currentValue: unknown): void {
    const snapshotValue = this.snapshot.get(key);
    const previouslyTracked = this.snapshot.has(key);
    if (!previouslyTracked) {
      // First time we've seen this key. If a source label already
      // exists from elsewhere (initializeFromJob ran without a
      // value, say), respect it; otherwise stamp as preExisting.
      if (!this.sources.has(key)) {
        this.set(key, 'preExisting', currentValue);
      } else {
        // Just snapshot the value so subsequent reconciles can
        // detect drift from it. Don't change the source label.
        this.snapshot.set(key, currentValue);
      }
      return;
    }
    if (looseEquals(currentValue, snapshotValue)) return;
    // Value drifted from what we last source-tracked → manual edit.
    this.set(key, 'preExisting', currentValue);
  }

  /** Walk a JobDetail and stamp every populated field as 'preExisting'.
   *  Also takes the snapshot used by `reconcileFromJob` to detect
   *  inspector edits made later in the session. Idempotent.
   *
   *  Subsequent writes from regex / Sonnet flip the label as they
   *  fire (and re-snapshot the value via the apply rules' `set(key,
   *  source, newValue)` call). */
  initializeFromJob(job: JobDetail): void {
    for (const section of TOP_LEVEL_SECTIONS) {
      const record = job[section] as Record<string, unknown> | undefined;
      if (!record) continue;
      for (const [field, value] of Object.entries(record)) {
        if (hasValue(value)) {
          this.set(`${section}.${field}`, 'preExisting', value);
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
          this.set(`circuit.${ref}.${field}`, 'preExisting', value);
        }
      }
    }
  }
}

/** Loose equality used by reconcileFromJob to decide whether a job
 *  field has drifted from our last-tracked snapshot. Mirrors the
 *  apply-rules `sameValue` helper: trim whitespace on string
 *  comparison and string-coerce mixed-type pairs. */
function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a === 'string' && typeof b === 'string') {
    return a.trim() === b.trim();
  }
  if (
    (typeof a === 'string' && typeof b === 'number') ||
    (typeof a === 'number' && typeof b === 'string')
  ) {
    return String(a).trim() === String(b).trim();
  }
  return false;
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
