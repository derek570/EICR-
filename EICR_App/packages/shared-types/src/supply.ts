/**
 * Supply characteristics types.
 */

export interface SupplyCharacteristics {
  earthing_arrangement: string;
  live_conductors: string;
  number_of_supplies: string;
  nominal_voltage_u: string;
  nominal_voltage_uo: string;
  nominal_frequency: string;
  prospective_fault_current?: string;
  earth_loop_impedance_ze?: string;
  supply_polarity_confirmed?: string;
  spd_bs_en?: string;
  spd_type_supply?: string;
  spd_short_circuit?: string;
  spd_rated_current?: string;
  means_earthing_distributor?: boolean;
  means_earthing_electrode?: boolean;
  main_switch_bs_en?: string;
  main_switch_poles?: string;
  main_switch_voltage?: string;
  main_switch_current?: string;
  main_switch_fuse_setting?: string;
  main_switch_location?: string;
  main_switch_conductor_material?: string;
  main_switch_conductor_csa?: string;
  rcd_operating_current?: string;
  rcd_time_delay?: string;
  rcd_operating_time?: string;
  rcd_operating_current_test?: string;
  rcd_time_delay_test?: string;
  rcd_operating_time_test?: string;
  earthing_conductor_material?: string;
  earthing_conductor_csa?: string;
  earthing_conductor_continuity?: string;
  bonding_conductor_material?: string;
  bonding_conductor_csa?: string;
  bonding_conductor_continuity?: string;
  bonding_water?: string;
  bonding_gas?: string;
  bonding_oil?: string;
  bonding_structural_steel?: string;
  bonding_lightning?: string;
  bonding_other?: string;
  bonding_other_na?: boolean;
}
