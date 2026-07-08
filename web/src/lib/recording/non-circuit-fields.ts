/**
 * Non-circuit (section-level) field rescue set — A2, sess_mrbnds2d_jczh.
 *
 * iOS canon: `CertMateUnified/Sources/Recording/DeepgramRecordingViewModel.swift`
 * `Self.supplyFields` (:10031-10087) — copied VERBATIM (2026-07-08), comments
 * included where they explain membership. iOS's orphan path buffers any
 * reading with `circuit == -1` UNLESS its field is in this set; those are
 * supply/installation-level readings that need no circuit and were already
 * applied. The web D4 port omitted the rescue entirely, so a dictated
 * "customer is Michael Payden" was applied AND buffered, and 2s later the
 * client asked "Which circuit was that client_name Michael Payden reading
 * for?" — a circuit-disambiguation ask for a field that has no circuit
 * (Audio-First invariant #1 violation: the false ask preempt-flushed the
 * queued read-back).
 *
 * Sync rule (mirrors the iOS comment): this set MUST stay in sync with the
 * non-circuit apply routes in `apply-extraction.ts` (`CIRCUIT_0_SECTION`).
 * Drift here is the silent-drop/false-ask bug class (Ivydene Road
 * 2026-04-27). `web/tests/non-circuit-fields.test.ts` is the drift guard.
 *
 * Cross-repo note (accepted, on ledger row `recording/recording-context-tsx`):
 * this is a literal copy of the iOS set — if iOS adds a member, web must be
 * updated by hand; the drift guard can only catch web-side route drift.
 */
export const NON_CIRCUIT_FIELDS: ReadonlySet<string> = new Set([
  // Supply characteristics
  'ze',
  'earth_loop_impedance_ze',
  'pfc',
  'prospective_fault_current',
  'earthing_arrangement',
  'main_earth_conductor_csa',
  'main_bonding_conductor_csa',
  'bonding_water',
  'bonding_gas',
  'earth_electrode_type',
  'earth_electrode_resistance',
  'supply_voltage',
  'nominal_voltage',
  'nominal_voltage_u',
  'supply_frequency',
  'nominal_frequency',
  'supply_polarity_confirmed',
  'main_switch_bs_en',
  'main_switch_type',
  'main_switch_current',
  'main_switch_rating',
  'main_switch_fuse_setting',
  'main_switch_poles',
  'main_switch_voltage',

  // Supply Protective Device (DNO cutout / service fuse / main fuse).
  // iOS Fix D1 (2026-06-04) — Sonnet routinely emits these with
  // circuit == -1 per the SUPPLY vs MAIN SWITCH DISAMBIGUATION prompt
  // block. Legacy `main_fuse_*` / `supply_fuse_*` aliases are NOT members
  // (canonicalised server-side before the wire).
  'spd_bs_en',
  'spd_type_supply',
  'spd_short_circuit',
  'spd_rated_current',

  // Surge Protection Device (transient overvoltage, BS EN 61643-11) —
  // distinct family from the cutout above (iOS surge-protection-box
  // 2026-06-17; bare 'spd_type' deliberately absent).
  'surge_spd_present',
  'surge_spd_type',
  'surge_spd_bs_en',
  'surge_status_indicator',

  // Board metadata + canonical Ze-at-DB rename (legacy zs_at_db kept for
  // stale-Sonnet back-compat)
  'manufacturer',
  'ze_at_db',
  'zs_at_db',

  // Address / client / job metadata
  'address',
  'postcode',
  'town',
  'county',
  'client_name',
  'client_phone',
  'client_email',
  'reason_for_report',
  'occupier_name',
  'date_of_inspection',
  'date_of_previous_inspection',
  'previous_certificate_number',
  'estimated_age_of_installation',
  'general_condition',
  'next_inspection_years',
  'premises_description',
  'extent_of_installation',
  'installation_type',
  'departures_from_bs7671',
  'departure_details',
  'design_comments',

  // Schema-coverage block (iOS 2026-04-27)
  'name',
  'location',
  'phases',
  'ipf_at_db',
  'bonding_conductor_material',
  'bonding_conductor_csa',
  'bonding_conductor_continuity',
  'bonding_other_na',
  'earthing_conductor_csa',
  'means_earthing_distributor',
  'means_earthing_electrode',
  'rcd_operating_current_test',
  'rcd_time_delay_test',
  'rcd_operating_time_test',
  'installation_records_available',
  'evidence_of_additions_alterations',
  'agreed_limitations',
  'agreed_with',
  'operational_limitations',
  'extent',
  'comments',
]);

/** True when `field` is a section-level (non-circuit) field that must never
 *  enter the pending-readings circuit-disambiguation buffer. */
export function isNonCircuitField(field: string): boolean {
  return NON_CIRCUIT_FIELDS.has(field);
}
