/**
 * PLAN-2D (2026-07-31) — authoritative reading-field disposition manifest.
 *
 * Every field that can leave the Stage-6 reading pipeline has one explicit
 * client destination. `KNOWN_FIELDS` is derived from this manifest, so adding
 * a schema field can no longer silence the unknown-field drift warning unless
 * both clients have a reviewed route for it.
 *
 * The route values describe the web JobDetail destination. They are also the
 * cross-client audit vocabulary used by the committed web/iOS manifest copies:
 * iOS proves every key has an apply case, while web deep-compares these values
 * against its live circuit-0 section router (and its circuit-row route).
 */

const ROUTABLE_CIRCUIT_FIELDS = Object.freeze([
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
]);

const ROUTABLE_SUPPLY_FIELDS = Object.freeze([
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
  'main_switch_bs_en',
  'main_switch_current',
  'main_switch_fuse_setting',
  'main_switch_poles',
  'main_switch_voltage',
  'main_switch_location',
  'main_switch_conductor_material',
  'main_switch_conductor_csa',
  'rcd_operating_current',
  'rcd_time_delay',
  'rcd_operating_time',
  'live_conductors',
  'number_of_supplies',
  'nominal_voltage_uo',
  'earth_electrode_location',
  'earthing_conductor_material',
  'earthing_conductor_csa',
  'earthing_conductor_continuity',
  'main_bonding_material',
  'main_bonding_continuity',
  'bonding_conductor_material',
  'bonding_conductor_csa',
  'bonding_conductor_continuity',
  'bonding_oil',
  'bonding_structural_steel',
  'bonding_lightning',
  'bonding_other',
  'bonding_other_na',
  'means_earthing_distributor',
  'means_earthing_electrode',
  'rcd_operating_current_test',
  'rcd_time_delay_test',
  'rcd_operating_time_test',
  'spd_bs_en',
  'spd_type_supply',
  'spd_short_circuit',
  'spd_rated_current',
  'surge_spd_present',
  'surge_spd_type',
  'surge_spd_bs_en',
  'surge_status_indicator',
]);

const ROUTABLE_BOARD_FIELDS = Object.freeze([
  'manufacturer',
  'name',
  'location',
  'phases',
  'ze_at_db',
  'zs_at_db',
  'ipf_at_db',
]);

const ROUTABLE_INSTALLATION_FIELDS = Object.freeze([
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
  'installation_records_available',
  'evidence_of_additions_alterations',
  'agreed_limitations',
  'agreed_with',
  'operational_limitations',
]);

const ROUTABLE_EXTENT_FIELDS = Object.freeze([
  'extent_of_installation',
  'installation_type',
  'extent',
  'comments',
  // Both clients store the legacy design-comments slot beside EIC extent
  // comments; neither Design/Construction model has a third comments field.
  'design_comments',
]);

const ROUTABLE_DESIGN_FIELDS = Object.freeze([
  'departures_from_bs7671',
  'departure_details',
]);

function entries(fields, route) {
  return fields.map((field) => [field, route]);
}

export const CLIENT_ROUTABLE_READING_ROUTES = Object.freeze(
  Object.fromEntries([
    ...entries(ROUTABLE_CIRCUIT_FIELDS, 'circuit'),
    ...entries(ROUTABLE_SUPPLY_FIELDS, 'supply_characteristics'),
    ...entries(ROUTABLE_BOARD_FIELDS, 'board_info'),
    ...entries(ROUTABLE_INSTALLATION_FIELDS, 'installation_details'),
    ...entries(ROUTABLE_EXTENT_FIELDS, 'extent_and_type'),
    ...entries(ROUTABLE_DESIGN_FIELDS, 'design_construction'),
  ])
);

export const CLIENT_ROUTABLE_READING_FIELDS = new Set(
  Object.keys(CLIENT_ROUTABLE_READING_ROUTES)
);

/**
 * Legitimate user-reading fields that neither client can currently apply.
 * They fail closed at dispatch with a covered Board-tab refusal.
 */
export const UNROUTABLE_READING_FIELDS = new Set([
  'sub_main_cable_material',
  'sub_main_cable_csa',
  'sub_main_cpc_csa',
]);

/**
 * Hierarchy/identity metadata. These are legal schema keys but are never legal
 * `record_*_reading` writes: their dedicated structural tools own mutation.
 */
export const STRUCTURAL_READING_FIELDS = new Set([
  'board_type',
  'parent_board_id',
  'feed_circuit_ref',
  'sort_order',
  'circuit_ref',
  'feeds_board_id',
  'is_distribution_circuit',
]);

/**
 * A correction key in KNOWN_FIELDS bypasses FIELD_CORRECTIONS because
 * validation checks KNOWN_FIELDS first. PLAN-2D deliberately keeps this empty:
 * all three pre-existing overlaps now use their corrected legacy wire names.
 */
export const CORRECTION_BYPASS_EXEMPTIONS = Object.freeze({});

/** Per-field adjudication required by PLAN-2D §3.6. */
export const CORRECTION_WIRE_DECISIONS = Object.freeze({
  cpc_csa_mm2: 'cable_size_earth',
  max_zs: 'ocpd_max_zs_ohm',
  ocpd_max_zs: 'ocpd_max_zs_ohm',
});

/**
 * Separate from BOARD_CLEAR_SCOPE_MAP: this classifies successful WRITES,
 * never which fields are clearable. Every non-circuit routable field is
 * explicit; adding a new destination without a scope therefore fails tests.
 */
export const BOARD_READING_SCOPE_MAP = Object.freeze(
  Object.fromEntries(
    Object.entries(CLIENT_ROUTABLE_READING_ROUTES)
      .filter(([, route]) => route !== 'circuit')
      .map(([field, route]) => [field, route === 'board_info' ? 'board' : 'global'])
  )
);

export function classifyStructuralReading(field, value) {
  if (field === 'is_distribution_circuit' && String(value).trim().toLowerCase() === 'yes') {
    return 'recoverable_mark_distribution';
  }
  return STRUCTURAL_READING_FIELDS.has(field) ? 'terminal' : null;
}
