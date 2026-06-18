/**
 * Regex match-result types and wire-shape helpers for the iOS-parity
 * pre-extraction pipeline.
 *
 * Mirrors the Swift structs at
 * `CertMateUnified/Sources/Recording/TranscriptFieldMatcher.swift:19-152`
 * (RegexMatchResult and its nested SupplyUpdates / CircuitUpdates /
 * BoardUpdates / InstallationUpdates / NewCircuit / BoardSwitchEvent).
 *
 * Naming policy: snake_case keys throughout to match the existing PWA
 * `JobDetail` / `CircuitRow` field names — one-place divergence from
 * Swift's camelCase. The cost of preserving Swift naming would be a
 * translation table at every read site in apply-regex-match.ts; using
 * the existing snake_case lets the apply step spread the patches
 * directly into the section buckets.
 */

// MARK: — Per-section update shapes

export interface SupplyUpdates {
  ze?: string;
  pfc?: string;
  earthing_arrangement?: string;
  supply_polarity_confirmed?: boolean;
  main_earth_csa?: string;
  bonding_csa?: string;
  bonding_water?: string;
  bonding_gas?: string;
  main_bonding_continuity?: string;
  earth_electrode_type?: string;
  earth_electrode_resistance?: string;
  nominal_voltage?: string;
  nominal_frequency?: string;
  main_switch_bs_en?: string;
  main_switch_current?: string;
  main_switch_conductor_csa?: string;
  // Supply protective device / DNO cutout / "main fuse" (Option A — distinct
  // from the consumer-unit main switch above). surge-protection-box 2026-06-17.
  spd_bs_en?: string;
  spd_rated_current?: string;
}

export interface CircuitUpdates {
  measured_zs_ohm?: string;
  r1_r2_ohm?: string;
  ring_r1_ohm?: string;
  ring_rn_ohm?: string;
  ring_r2_ohm?: string;
  ir_live_earth_mohm?: string;
  ir_live_live_mohm?: string;
  rcd_time_ms?: string;
  ocpd_rating_a?: string;
  ocpd_type?: string;
  ocpd_bs_en?: string;
  polarity_confirmed?: string;
  rcd_button_confirmed?: string;
  afdd_button_confirmed?: string;
  live_csa_mm2?: string;
  cpc_csa_mm2?: string;
  number_of_points?: string;
  wiring_type?: string;
  ref_method?: string;
  rcd_type?: string;
}

export interface BoardUpdates {
  manufacturer?: string;
  ze_at_db?: string;
}

export interface InstallationUpdates {
  client_name?: string;
  address?: string;
  postcode?: string;
  premises_description?: string;
  next_inspection_years?: number;
  client_phone?: string;
  client_email?: string;
  reason_for_report?: string;
  occupier_name?: string;
  date_of_previous_inspection?: string;
  previous_certificate_number?: string;
  estimated_age_of_installation?: string;
  general_condition_of_installation?: string;
  client_address?: string;
  client_town?: string;
  client_county?: string;
  client_postcode?: string;
  client_address_same_as_installation?: boolean;
  date_of_inspection?: string; // ISO date string in TS land — Date is serialised before reaching apply layer
}

export interface NewCircuit {
  circuit_ref: string;
  designation: string;
}

export interface BoardSwitchEvent {
  /** Matched board identifier — either an existing board ID or a
   *  descriptive slug ("garage_board", "DB2", "main", "sub_board"). */
  board_slug: string;
  /** Raw matched text from the transcript (e.g., "garage board"). */
  raw_match: string;
}

// MARK: — Top-level result

/** Output of TranscriptFieldMatcher.match(). circuit_updates is keyed by
 *  circuit_ref (matcher emits "1", "2", etc. — not the row UUID). The
 *  apply layer translates circuit_ref → row UUID before recording field-
 *  source attribution.
 *
 *  Using a plain object map (not Map<string, CircuitUpdates>) so the result
 *  is JSON-serialisable for snapshot tests and for the wire-shape adapter. */
export interface RegexMatchResult {
  supply_updates: SupplyUpdates;
  circuit_updates: Record<string, CircuitUpdates>;
  board_updates: BoardUpdates;
  installation_updates: InstallationUpdates;
  new_circuits: NewCircuit[];
  board_switch?: BoardSwitchEvent;
}

export function emptyRegexMatchResult(): RegexMatchResult {
  return {
    supply_updates: {},
    circuit_updates: {},
    board_updates: {},
    installation_updates: {},
    new_circuits: [],
  };
}

/** True iff the result has no updates and no new circuits/board switch. */
export function isEmptyResult(r: RegexMatchResult): boolean {
  return (
    Object.keys(r.supply_updates).length === 0 &&
    Object.keys(r.circuit_updates).length === 0 &&
    Object.keys(r.board_updates).length === 0 &&
    Object.keys(r.installation_updates).length === 0 &&
    r.new_circuits.length === 0 &&
    r.board_switch === undefined
  );
}

// MARK: — Wire shape (regexResults frame field)

/**
 * Per-entry shape sent on the `transcript` WebSocket frame as the
 * `regexResults` array. Mirrors iOS `TranscriptProcessor.buildRegexSummary`
 * (`Sources/Recording/TranscriptProcessor.swift:199-208`) byte-for-byte.
 *
 * iOS emits ONLY:
 *   - `field`: the full FieldSourceTracker key (e.g. "supply.ze",
 *     "circuit.c-abc.measured_zs_ohm", "install.postcode"). Circuit
 *     attribution is encoded inside the key — iOS does NOT emit a
 *     separate `circuit` number key.
 *   - `value`: optional, added ONLY for `install.postcode` so backend's
 *     postcodes.io lookup at `eicr-extraction-session.js:1490` can fire.
 *
 * Backend reads the array at `src/extraction/sonnet-stream.js:3416-3443`
 * (validates `Array.isArray`); downstream consumers:
 *   - length only:      `sonnet-stream.js:1026, 1061` (chitchat wake gate,
 *                       counter reset)
 *   - field comparison: `stage6-overtake-classifier.js:133, 146` —
 *                       strict-equality on `field` AND `circuit`. Since
 *                       neither client emits `circuit`, both `r.circuit`
 *                       are `undefined` — match only fires when the
 *                       pending ask's `contextCircuit` is also undefined,
 *                       which is the iOS-canonical behaviour.
 *   - postcode lookup:  `eicr-extraction-session.js:1490` reads `value`.
 *
 * User-rule "iOS is canon for parity" — do not extend the wire shape
 * beyond what iOS sends. The codex review's `circuit: null` suggestion
 * assumed we'd be emitting it separately; we don't, so it doesn't apply.
 */
export interface RegexResultWireEntry {
  field: string;
  value?: string;
}

export type RegexResultsWire = RegexResultWireEntry[];

// MARK: — Wire-shape builder

import type { JobDetail } from '@/lib/types';

/**
 * Build the `regexResults` payload from this turn's regex-write field
 * keys. Mirrors iOS `buildRegexSummary` (TranscriptProcessor.swift:199-208).
 *
 * Returns `undefined` when no keys were written this turn — matches the
 * iOS guard at line 200 (`guard !writtenKeys.isEmpty else { return nil }`).
 * The Swift version returns `[[String:Any]]?`; on the wire `nil` becomes
 * an absent JSON property, matching the TS `undefined`.
 */
export function buildRegexSummary(
  writtenKeys: string[],
  job: JobDetail
): RegexResultsWire | undefined {
  if (writtenKeys.length === 0) return undefined;
  return writtenKeys.map((key) => {
    const entry: RegexResultWireEntry = { field: key };
    if (key === 'install.postcode') {
      const postcode = (job.installation_details as { postcode?: unknown } | undefined)?.postcode;
      if (typeof postcode === 'string' && postcode.length > 0) {
        entry.value = postcode;
      }
    }
    return entry;
  });
}
