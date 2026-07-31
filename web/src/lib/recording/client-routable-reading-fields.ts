/**
 * PLAN-2D client reading manifest.
 *
 * This is the web runtime mirror of the backend's
 * `CLIENT_ROUTABLE_READING_ROUTES`. `applyExtractionToJob` consults it before
 * applying a reading, so the committed contract is an egress guard rather than
 * decorative documentation. The contract test deep-compares this live object
 * with the committed cross-client JSON fixture and with the section/circuit
 * router in `apply-extraction.ts`.
 */
export type ClientReadingRoute =
  | 'circuit'
  | 'supply_characteristics'
  | 'board_info'
  | 'installation_details'
  | 'extent_and_type'
  | 'design_construction';

function entries(
  fields: readonly string[],
  route: ClientReadingRoute
): Array<readonly [string, ClientReadingRoute]> {
  return fields.map((field) => [field, route] as const);
}

const CIRCUIT_FIELDS = [
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
] as const;

const SUPPLY_FIELDS = [
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
] as const;

const BOARD_FIELDS = [
  'manufacturer',
  'name',
  'location',
  'phases',
  'ze_at_db',
  'zs_at_db',
  'ipf_at_db',
] as const;

const INSTALLATION_FIELDS = [
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
] as const;

export const CLIENT_ROUTABLE_READING_ROUTES: Readonly<Record<string, ClientReadingRoute>> =
  Object.freeze(
    Object.fromEntries([
      ...entries(CIRCUIT_FIELDS, 'circuit'),
      ...entries(SUPPLY_FIELDS, 'supply_characteristics'),
      ...entries(BOARD_FIELDS, 'board_info'),
      ...entries(INSTALLATION_FIELDS, 'installation_details'),
      ...entries(
        [
          'extent_of_installation',
          'installation_type',
          'extent',
          'comments',
          'design_comments',
        ],
        'extent_and_type'
      ),
      ...entries(['departures_from_bs7671', 'departure_details'], 'design_construction'),
    ])
  );

export function clientReadingRoute(field: string): ClientReadingRoute | undefined {
  return CLIENT_ROUTABLE_READING_ROUTES[field];
}
