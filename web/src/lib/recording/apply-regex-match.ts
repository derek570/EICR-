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

/**
 * Apply a RegexMatchResult onto a JobDetail. Returns null if no fields
 * actually wrote (so the caller can skip a needless updateJob cycle).
 *
 * Each candidate write is gated through `tracker.canRegexWrite(key)` —
 * if Sonnet or a pre-existing value already owns the field, the regex
 * write is silently dropped and the key does NOT appear in changedKeys
 * or the next regexResults wire payload.
 */
export function applyRegexMatchToJob(
  job: JobDetail,
  result: RegexMatchResult,
  tracker: FieldSourceTracker
): RegexApplyOutput | null {
  const patch: Partial<JobDetail> = {};
  const changedKeys: string[] = [];

  // Section buckets — accumulated and folded into the patch at the end so
  // multiple section writes don't smear across each other.
  const supplyPatch: Record<string, unknown> = {};
  const boardPatch: Record<string, unknown> = {};
  const installPatch: Record<string, unknown> = {};

  // Supply.
  for (const [matcherField, value] of Object.entries(result.supply_updates)) {
    if (value === undefined) continue;
    const fieldKey =
      SUPPLY_FIELD_TO_KEY[matcherField as keyof typeof SUPPLY_FIELD_TO_KEY] ?? matcherField;
    const section = SUPPLY_FIELD_SECTION[matcherField] ?? 'supply_characteristics';
    const trackerKey = `${section === 'board_info' ? 'board' : 'supply'}.${fieldKey}`;
    if (!tracker.canRegexWrite(trackerKey)) continue;
    if (section === 'board_info') boardPatch[fieldKey] = value;
    else supplyPatch[fieldKey] = value;
    tracker.recordRegexWrite(trackerKey);
    changedKeys.push(trackerKey);
  }

  // Board.
  for (const [matcherField, value] of Object.entries(result.board_updates)) {
    if (value === undefined) continue;
    const fieldKey =
      BOARD_FIELD_TO_KEY[matcherField as keyof typeof BOARD_FIELD_TO_KEY] ?? matcherField;
    const trackerKey = `board.${fieldKey}`;
    if (!tracker.canRegexWrite(trackerKey)) continue;
    boardPatch[fieldKey] = value;
    tracker.recordRegexWrite(trackerKey);
    changedKeys.push(trackerKey);
  }

  // Installation.
  for (const [matcherField, value] of Object.entries(result.installation_updates)) {
    if (value === undefined) continue;
    const fieldKey =
      INSTALLATION_FIELD_TO_KEY[matcherField as keyof typeof INSTALLATION_FIELD_TO_KEY] ??
      matcherField;
    const trackerKey = `install.${fieldKey}`;
    if (!tracker.canRegexWrite(trackerKey)) continue;
    installPatch[fieldKey] = value;
    tracker.recordRegexWrite(trackerKey);
    changedKeys.push(trackerKey);
  }

  // Per-circuit. Translate matcher's `circuit_ref` keys to row UUIDs so
  // the tracker key uses the stable id.
  let circuits: CircuitRow[] | null = null;
  if (Object.keys(result.circuit_updates).length > 0) {
    circuits = [...(job.circuits ?? [])];
    const indexByRef = new Map<string, number>();
    circuits.forEach((row, idx) => {
      const ref = (row as { circuit_ref?: unknown }).circuit_ref;
      if (typeof ref === 'string') indexByRef.set(ref, idx);
    });

    let circuitsChanged = false;
    for (const [ref, updates] of Object.entries(result.circuit_updates)) {
      const idx = indexByRef.get(ref);
      if (idx === undefined) continue; // matcher emitted a ref we don't have a row for — out of scope
      const row = circuits[idx];
      const id = row.id;
      const rowFieldUpdates: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(updates as CircuitUpdates)) {
        if (value === undefined) continue;
        const trackerKey = `circuit.${id}.${field}`;
        if (!tracker.canRegexWrite(trackerKey)) continue;
        rowFieldUpdates[field] = value;
        tracker.recordRegexWrite(trackerKey);
        changedKeys.push(trackerKey);
      }
      if (Object.keys(rowFieldUpdates).length > 0) {
        circuits[idx] = { ...row, ...rowFieldUpdates };
        circuitsChanged = true;
      }
    }
    if (!circuitsChanged) circuits = null;
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

  if (changedKeys.length === 0) return null;
  return { patch, changedKeys };
}
