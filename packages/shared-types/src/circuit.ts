/**
 * Circuit and Board types.
 */

export interface Circuit {
  circuit_ref: string;
  circuit_designation: string;
  wiring_type?: string;
  ref_method?: string;
  number_of_points?: string;
  live_csa_mm2?: string;
  cpc_csa_mm2?: string;
  max_disconnect_time_s?: string;
  ocpd_bs_en?: string;
  ocpd_type?: string;
  ocpd_rating_a?: string;
  ocpd_breaking_capacity_ka?: string;
  ocpd_max_zs_ohm?: string;
  rcd_bs_en?: string;
  rcd_type?: string;
  rcd_operating_current_ma?: string;
  ring_r1_ohm?: string;
  ring_rn_ohm?: string;
  ring_r2_ohm?: string;
  r1_r2_ohm?: string;
  r2_ohm?: string;
  ir_test_voltage_v?: string;
  ir_live_live_mohm?: string;
  ir_live_earth_mohm?: string;
  polarity_confirmed?: string;
  measured_zs_ohm?: string;
  rcd_time_ms?: string;
  rcd_button_confirmed?: string;
  afdd_button_confirmed?: string;
  [key: string]: string | undefined;
}

export interface BoardInfo {
  name?: string;
  location?: string;
  manufacturer?: string;
  phases?: string;
  earthing_arrangement?: string;
  ze?: string;
  zs_at_db?: string;
  ipf_at_db?: string;
}

export interface Board {
  id: string;
  designation: string;
  location: string;
  board_info: BoardInfo;
  circuits: Circuit[];
}
