/**
 * Canonical list of field names the iOS app's wire decoder understands
 * WITHOUT needing the `FIELD_CORRECTIONS` rewrite. Side-effect-free —
 * import to read the Set, nothing else happens at module load.
 *
 * Source of truth: this used to be a private `const` inside
 * `sonnet-stream.js` (its only consumer was `validateAndCorrectFields`).
 * Extracted 2026-06-03 so the session optimizer's analyzer-side
 * `canonical_name_leak_to_ios` signature detector (Cluster 3 Item 7
 * of the optimizer rewrite — see
 * `.planning/optimizer-rewrite-plan-2026-06-03-final.md`) can import
 * `KNOWN_FIELDS` to check whether a Sonnet-emitted field name landed
 * on iOS unmapped. The detector cannot `require('sonnet-stream.js')`
 * directly — that file has WebSocket bootstrapping side effects at
 * module load and would crash the optimizer.
 *
 * `IOS_DUAL_ALIAS_ALLOWLIST` is the companion set: canonical field
 * names iOS accepts NATIVELY (without a `FIELD_CORRECTIONS` rewrite)
 * thanks to recent dual-alias decoders. The comment in
 * `field-name-corrections.js` ("iOS happens to accept both today")
 * suggests this set is non-empty in practice, but the canonical truth
 * lives in iOS code (DeepgramRecordingViewModel.swift `applySonnetReadings`
 * switch as of Build 282+). Populating this conservatively here keeps
 * the detector from false-positiving on names iOS quietly decodes;
 * the alternative is duplicating the iOS-side decoder map by hand,
 * which would silently drift.
 *
 * The detector treats a field as "leaked" iff:
 *   !KNOWN_FIELDS.has(field)
 *   && !(field in FIELD_CORRECTIONS)
 *   && !IOS_DUAL_ALIAS_ALLOWLIST.has(field)
 *
 * `KNOWN_FIELDS` is `sonnet-stream.js`'s pre-extraction snapshot —
 * keep them in lockstep until the import is wired both ways. The
 * `re-export` shim at the bottom of sonnet-stream.js (post-extraction)
 * imports from THIS module and re-exposes `KNOWN_FIELDS` under the
 * same name so existing call sites stay byte-identical.
 */

// Known valid field names that iOS can handle.
export const KNOWN_FIELDS = new Set([
  // Supply fields
  'ze',
  'pfc',
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
  'manufacturer',
  'zs_at_db',
  // Main switch/fuse fields
  'main_switch_bs_en',
  'main_switch_current',
  'main_switch_fuse_setting',
  'main_switch_poles',
  'main_switch_voltage',
  'main_switch_location',
  'main_switch_conductor_material',
  'main_switch_conductor_csa',
  // Supply-level RCD fields
  'rcd_operating_current',
  'rcd_time_delay',
  'rcd_operating_time',
  // Additional supply fields
  'live_conductors',
  'number_of_supplies',
  'nominal_voltage_uo',
  'earth_electrode_location',
  'earthing_conductor_material',
  'earthing_conductor_continuity',
  'main_bonding_material',
  'main_bonding_continuity',
  'bonding_oil',
  'bonding_structural_steel',
  'bonding_lightning',
  'bonding_other',
  // Supply protective device (DNO cutout / main fuse) fields
  'spd_bs_en',
  'spd_type_supply',
  'spd_short_circuit',
  'spd_rated_current',
  // Surge protection device (transient overvoltage protection) fields
  'surge_spd_present',
  'surge_spd_type',
  'surge_spd_bs_en',
  'surge_status_indicator',
  // Installation fields
  'address',
  'postcode',
  'town',
  'county',
  'client_name',
  'client_address',
  'client_postcode',
  'client_town',
  'client_county',
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
  // Circuit fields
  'zs',
  'insulation_resistance_l_e',
  'insulation_resistance_l_l',
  'r1_plus_r2',
  'r1_r2',
  'r1r2',
  'r2',
  'earth_continuity',
  'ring_continuity_r1',
  'ring_continuity_rn',
  'ring_continuity_r2',
  'rcd_trip_time',
  'rcd_time',
  'rcd_rating_a',
  'rcd_rating',
  'polarity',
  'cable_size',
  'cable_size_earth',
  'cpc_csa_mm2',
  'cpc_csa',
  'ocpd_type',
  'ocpd_rating',
  'ocpd_bs_en',
  'rcd_bs_en',
  'number_of_points',
  'wiring_type',
  'ref_method',
  'rcd_type',
  'rcd_operating_current_ma',
  'max_disconnect_time',
  'ocpd_breaking_capacity',
  'ir_test_voltage',
  'rcd_button_confirmed',
  'afdd_button_confirmed',
  'circuit_description',
  'designation',
  'ir_live_earth',
  'ir_live_live',
  'earth_fault_loop_impedance',
  'ocpd_max_zs_ohm',
  'max_zs',
  'ocpd_max_zs',
  // EIC-specific fields
  'extent_of_installation',
  'installation_type',
  'departures_from_bs7671',
  'departure_details',
  'design_comments',
]);

/**
 * Canonical field names iOS accepts natively WITHOUT requiring a
 * `FIELD_CORRECTIONS` rewrite, thanks to dual-alias decoders added in
 * Build 282+. Populated conservatively — the optimizer's leak detector
 * uses this as a filter to avoid false-positives on canonical names
 * iOS quietly decodes.
 *
 * SAFE-TO-POPULATE CRITERIA: only add a canonical name here when iOS
 * code has been verified (DeepgramRecordingViewModel.swift
 * `applySonnetReadings` switch / decoder map) to handle it directly.
 * The cost of a wrongly-included entry is a missed leak detection;
 * the cost of a wrongly-excluded entry is a noisy false-positive.
 * Lean toward exclusion when unverified.
 *
 * Starts empty; populate as confidence accrues. The detector still
 * has two earlier filters (`KNOWN_FIELDS.has` and `FIELD_CORRECTIONS`
 * membership) before falling through to this one.
 */
export const IOS_DUAL_ALIAS_ALLOWLIST = new Set([
  // Intentionally empty until iOS-side decoder map is audited and
  // canonical-accepted names are verified one-by-one. See module
  // docstring for the safe-to-populate criteria.
]);
