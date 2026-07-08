/**
 * apply-regex-match — adapter that takes a `RegexMatchResult` produced by
 * TranscriptFieldMatcher, gates each write through a `FieldSourceTracker`,
 * and produces `{patch, changedKeys}` matching the existing
 * `applyExtractionToJob` contract from `apply-extraction.ts`.
 *
 * The tracker enforces the iOS-canonical 3-tier write priority:
 *   - regex never overwrites Sonnet OR pre-existing
 *   - regex may overwrite a previous regex write (last-hit-wins inside a
 *     single regex pass)
 *
 * **Scope of this commit (5 of 7 in the parity port):** the adapter
 * applies supply / board / installation / circuit-cell updates only.
 * `new_circuits` and `board_switch` from the matcher are intentionally
 * NOT applied here — Sonnet's `circuit_updates` path already covers
 * circuit creation and the multi-board switching surface is owned
 * server-side. Both result fields are still emitted by the matcher
 * (so iOS-wire-shape tests can verify them), they just don't drive
 * local state mutations from the regex layer.
 */

import type { JobDetail, CircuitRow } from '@/lib/types';
import type { FieldSourceTracker } from './field-source-tracker';
import type { CircuitUpdates, RegexMatchResult } from './regex-match-result';
import { pipelineLog } from '@/lib/diagnostics/pipeline-log';

// MARK: — Field-name → JobDetail-section routing
//
// Mirrors the `CIRCUIT_0_SECTION` map in apply-extraction.ts (which is
// keyed by Sonnet's field names). The matcher uses the same names, so we
// route by the same map.

type Section = 'supply_characteristics' | 'board_info' | 'installation_details';

const SUPPLY_FIELD_TO_KEY: Record<keyof NonNullable<RegexMatchResult['supply_updates']>, string> = {
  ze: 'ze',
  pfc: 'pfc',
  earthing_arrangement: 'earthing_arrangement',
  supply_polarity_confirmed: 'supply_polarity_confirmed',
  main_earth_csa: 'main_earth_csa',
  bonding_csa: 'bonding_csa',
  bonding_water: 'bonding_water',
  bonding_gas: 'bonding_gas',
  main_bonding_continuity: 'main_bonding_continuity',
  earth_electrode_type: 'earth_electrode_type',
  earth_electrode_resistance: 'earth_electrode_resistance',
  nominal_voltage: 'nominal_voltage',
  nominal_frequency: 'nominal_frequency',
  main_switch_bs_en: 'main_switch_bs_en',
  main_switch_current: 'main_switch_current',
  main_switch_conductor_csa: 'main_switch_conductor_csa',
  // Supply protective device / DNO cutout / "main fuse" (Option A — distinct
  // from the consumer-unit main switch). surge-protection-box 2026-06-17.
  spd_bs_en: 'spd_bs_en',
  spd_rated_current: 'spd_rated_current',
};

const BOARD_FIELD_TO_KEY: Record<keyof NonNullable<RegexMatchResult['board_updates']>, string> = {
  manufacturer: 'manufacturer',
  ze_at_db: 'ze_at_db',
};

// Section assignment for board / supply field routing — main_switch_*
// lives on board_info, the rest on supply_characteristics. Ze-at-DB is
// routed to board_info (mirrors iOS, where boardUpdates.zeAtDb is the
// board-end Zs).
const SUPPLY_FIELD_SECTION: Record<string, Section> = {
  main_switch_bs_en: 'board_info',
  main_switch_current: 'board_info',
  main_switch_conductor_csa: 'board_info',
  // spd_* (main fuse) mirrors the main_switch_* live-fill convention — the
  // LiveFillView reads board_info during recording. surge-protection-box.
  spd_bs_en: 'board_info',
  spd_rated_current: 'board_info',
};

const INSTALLATION_FIELD_TO_KEY: Record<
  keyof NonNullable<RegexMatchResult['installation_updates']>,
  string
> = {
  client_name: 'client_name',
  address: 'address',
  postcode: 'postcode',
  premises_description: 'premises_description',
  next_inspection_years: 'next_inspection_years',
  client_phone: 'client_phone',
  client_email: 'client_email',
  reason_for_report: 'reason_for_report',
  occupier_name: 'occupier_name',
  date_of_previous_inspection: 'date_of_previous_inspection',
  previous_certificate_number: 'previous_certificate_number',
  estimated_age_of_installation: 'estimated_age_of_installation',
  general_condition_of_installation: 'general_condition',
  client_address: 'client_address',
  client_town: 'client_town',
  client_county: 'client_county',
  client_postcode: 'client_postcode',
  client_address_same_as_installation: 'client_address_same_as_installation',
  date_of_inspection: 'date_of_inspection',
};

export interface RegexApplyOutput {
  patch: Partial<JobDetail>;
  /** Field-source-tracker keys that flipped this turn — also fed into
   *  liveFill.markUpdated() for the brand-blue flash. */
  changedKeys: string[];
}

// MARK: — A3 freshness gate (sess_mrbnds2d_jczh, 2026-07-08)
//
// The matcher deliberately re-scans a CUMULATIVE transcript window
// (cross-utterance carryover), so an old match re-fires on every later
// utterance. Pre-fix the apply layer had no value-equality check, so a
// re-hit of "Customer is Michael Payden" masqueraded as a fresh write on
// pure chitchat ("What do you mean?"), passed the TranscriptGate, played
// the sent-for-processing chime, and reset the backend chitchat pause
// counter. iOS freshness canon: `applyRegexValue`'s
// `newValue != currentValue` check (DeepgramRecordingViewModel.swift:
// 7577-7595) feeds `thisTurnRegexWrites` → the gate's `hasRegexHit`.
// The pure helper below ports that mechanism for BOTH env paths
// (hints-ON compares against job state — the write happens; hints-OFF
// compares against a per-session shadow map because the value is never
// written to the job there).

/** One tracker-approved candidate write from a regex pass. */
export interface RegexWriteCandidate {
  trackerKey: string;
  target: 'supply_characteristics' | 'board_info' | 'installation_details' | 'circuit';
  fieldKey: string;
  value: unknown;
  /** circuit-target only */
  circuitIdx?: number;
}

/** Reads the value a candidate would overwrite. Injected so hints-ON can
 *  baseline on the job while hints-OFF baselines on the freshness shadow. */
export type BaselineReader = (candidate: RegexWriteCandidate) => unknown;

/** String-compare after trim (the matcher emits trimmed strings; job values
 *  may be numbers/booleans/null). null/undefined fold to '' so an unset
 *  field never equals a real value. */
export function valuesEqualAfterTrim(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => (v == null ? '' : String(v).trim());
  return norm(a) === norm(b);
}

/** Baseline reader for the hints-ON path: the current job value at the
 *  location the patch would write. */
export function jobBaselineReader(job: JobDetail): BaselineReader {
  return (c) => {
    if (c.target === 'circuit') {
      const row = (job.circuits ?? [])[c.circuitIdx ?? -1] as Record<string, unknown> | undefined;
      return row?.[c.fieldKey];
    }
    const section = job[c.target] as Record<string, unknown> | null | undefined;
    return section?.[c.fieldKey];
  };
}

/** Baseline reader for the hints-OFF path: a per-session shadow of the last
 *  gate-passed candidate values (the job is never patched in that mode, so
 *  job state would leave every re-hit looking fresh forever). */
export function shadowBaselineReader(shadow: ReadonlyMap<string, unknown>): BaselineReader {
  return (c) => shadow.get(c.trackerKey);
}

/**
 * Pure candidate computation — the four write loops (supply / board /
 * installation / circuit) with the tracker's 3-tier gating and the A3
 * value-equality freshness gate, but NO state commits: no
 * `tracker.recordRegexWrite`, no patch. Candidates whose value string-equals
 * the baseline are NOT fresh and are dropped (no changedKey, no chime, no
 * Sonnet send, no chitchat-counter reset). A changed value for a
 * previously-set field is still fresh (legit cumulative carryover).
 */
export function computeFreshRegexWrites(
  job: JobDetail,
  result: RegexMatchResult,
  tracker: FieldSourceTracker,
  baseline: BaselineReader
): RegexWriteCandidate[] {
  const fresh: RegexWriteCandidate[] = [];
  const consider = (candidate: RegexWriteCandidate) => {
    if (!tracker.canRegexWrite(candidate.trackerKey)) return;
    if (valuesEqualAfterTrim(candidate.value, baseline(candidate))) return; // re-hit, not fresh
    fresh.push(candidate);
  };

  // Supply (some fields route to board_info — main_switch_* / spd_*).
  for (const [matcherField, value] of Object.entries(result.supply_updates)) {
    if (value === undefined) continue;
    const fieldKey =
      SUPPLY_FIELD_TO_KEY[matcherField as keyof typeof SUPPLY_FIELD_TO_KEY] ?? matcherField;
    const section = SUPPLY_FIELD_SECTION[matcherField] ?? 'supply_characteristics';
    consider({
      trackerKey: `${section === 'board_info' ? 'board' : 'supply'}.${fieldKey}`,
      target: section,
      fieldKey,
      value,
    });
  }

  // Board.
  for (const [matcherField, value] of Object.entries(result.board_updates)) {
    if (value === undefined) continue;
    const fieldKey =
      BOARD_FIELD_TO_KEY[matcherField as keyof typeof BOARD_FIELD_TO_KEY] ?? matcherField;
    consider({ trackerKey: `board.${fieldKey}`, target: 'board_info', fieldKey, value });
  }

  // Installation.
  for (const [matcherField, value] of Object.entries(result.installation_updates)) {
    if (value === undefined) continue;
    const fieldKey =
      INSTALLATION_FIELD_TO_KEY[matcherField as keyof typeof INSTALLATION_FIELD_TO_KEY] ??
      matcherField;
    consider({
      trackerKey: `install.${fieldKey}`,
      target: 'installation_details',
      fieldKey,
      value,
    });
  }

  // Per-circuit. Translate matcher's `circuit_ref` keys to row UUIDs so
  // the tracker key uses the stable id.
  if (Object.keys(result.circuit_updates).length > 0) {
    const circuits = job.circuits ?? [];
    const indexByRef = new Map<string, number>();
    circuits.forEach((row, idx) => {
      const ref = (row as { circuit_ref?: unknown }).circuit_ref;
      if (typeof ref === 'string') indexByRef.set(ref, idx);
    });
    for (const [ref, updates] of Object.entries(result.circuit_updates)) {
      const idx = indexByRef.get(ref);
      if (idx === undefined) continue; // ref without a row — out of scope
      const id = circuits[idx].id;
      for (const [field, value] of Object.entries(updates as CircuitUpdates)) {
        if (value === undefined) continue;
        consider({
          trackerKey: `circuit.${id}.${field}`,
          target: 'circuit',
          fieldKey: field,
          value,
          circuitIdx: idx,
        });
      }
    }
  }

  return fresh;
}

/**
 * Apply a RegexMatchResult onto a JobDetail. Returns null if no fields
 * actually wrote (so the caller can skip a needless updateJob cycle).
 *
 * Each candidate write is gated through `tracker.canRegexWrite(key)` —
 * if Sonnet or a pre-existing value already owns the field, the regex
 * write is silently dropped and the key does NOT appear in changedKeys
 * or the next regexResults wire payload. Since A3 (2026-07-08) each
 * candidate is ALSO freshness-gated against the current job value —
 * cumulative-window re-hits of an unchanged value no longer write,
 * count as changedKeys, or reach the tracker's turn-writes (so they no
 * longer flip the TranscriptGate's hasRegexHit).
 */
export function applyRegexMatchToJob(
  job: JobDetail,
  result: RegexMatchResult,
  tracker: FieldSourceTracker
): RegexApplyOutput | null {
  pipelineLog('apply_regex_entry', {
    supply: Object.keys(result.supply_updates ?? {}).length,
    board: Object.keys(result.board_updates ?? {}).length,
    installation: Object.keys(result.installation_updates ?? {}).length,
    circuit_updates_refs: Object.keys(result.circuit_updates ?? {}).length,
  });
  const patch: Partial<JobDetail> = {};
  const changedKeys: string[] = [];

  const freshWrites = computeFreshRegexWrites(job, result, tracker, jobBaselineReader(job));

  // Section buckets — accumulated and folded into the patch at the end so
  // multiple section writes don't smear across each other.
  const supplyPatch: Record<string, unknown> = {};
  const boardPatch: Record<string, unknown> = {};
  const installPatch: Record<string, unknown> = {};
  let circuits: CircuitRow[] | null = null;

  for (const c of freshWrites) {
    if (c.target === 'circuit') {
      if (circuits === null) circuits = [...(job.circuits ?? [])];
      const idx = c.circuitIdx ?? -1;
      const row = circuits[idx];
      if (!row) continue;
      circuits[idx] = { ...row, [c.fieldKey]: c.value };
    } else if (c.target === 'board_info') {
      boardPatch[c.fieldKey] = c.value;
    } else if (c.target === 'installation_details') {
      installPatch[c.fieldKey] = c.value;
    } else {
      supplyPatch[c.fieldKey] = c.value;
    }
    tracker.recordRegexWrite(c.trackerKey);
    changedKeys.push(c.trackerKey);
  }

  // Fold section patches into JobDetail patch (preserving other keys
  // already on the section).
  if (Object.keys(supplyPatch).length > 0) {
    patch.supply_characteristics = {
      ...(job.supply_characteristics ?? {}),
      ...supplyPatch,
    };
  }
  if (Object.keys(boardPatch).length > 0) {
    patch.board_info = {
      ...(job.board_info ?? {}),
      ...boardPatch,
    };
  }
  if (Object.keys(installPatch).length > 0) {
    patch.installation_details = {
      ...(job.installation_details ?? {}),
      ...installPatch,
    };
  }
  if (circuits !== null) {
    patch.circuits = circuits;
  }

  if (changedKeys.length === 0) {
    pipelineLog('apply_regex_exit_no_changes', {});
    return null;
  }
  pipelineLog('apply_regex_exit', {
    changed_keys: changedKeys.length,
    patch_sections: Object.keys(patch),
  });
  return { patch, changedKeys };
}
