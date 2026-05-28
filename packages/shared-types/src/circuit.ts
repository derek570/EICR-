/**
 * Circuit and Board types.
 *
 * Mirrors `CertMateUnified/Sources/Models/Circuit.swift` and `BoardInfo.swift`.
 * If you add a field to one side, add it to the other — see Phase 2 of
 * `.planning-stage6-agentic/handoffs/multi-board-support-2026-05-07/PLAN.md`.
 */

export type BoardType = 'main' | 'sub_distribution' | 'sub_main' | 'off_peak';

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
  // Multi-board attribution + sub-board feed (iOS Circuit.swift:8,41-42)
  board_id?: string;
  is_distribution_circuit?: string;
  feeds_board_id?: string;
  [key: string]: string | undefined;
}

export interface BoardInfo {
  // Existing
  name?: string;
  location?: string;
  manufacturer?: string;
  phases?: string;
  earthing_arrangement?: string;
  ze?: string;
  /**
   * Legacy alias for `ze_at_db`. Kept for backward-compat with jobs persisted
   * before the 2026-04-27 rename — see `BoardInfo.swift` decoder comment.
   * Many backend readers (`src/utils/jobs.js`, `src/export.js`,
   * `src/generate_pdf.js`, `src/extraction/eicr-extraction-session.js`) still
   * use this key as their canonical, so it must stay on the wire interface.
   */
  zs_at_db?: string;
  /** Canonical key for board-end Ze (renamed 2026-04-27). */
  ze_at_db?: string;
  ipf_at_db?: string;
  // Already on iOS, missing from shared-types until Phase 2
  designation?: string;
  supplied_from?: string;
  polarity_confirmed?: string;
  phases_confirmed?: string;
  rcd_trip_time?: string;
  main_switch_bs_en?: string;
  voltage_rating?: string;
  rated_current?: string;
  ipf_rating?: string;
  rcd_rating_ma?: string;
  spd_type?: string;
  spd_status?: string;
  overcurrent_bs_en?: string;
  overcurrent_voltage?: string;
  overcurrent_current?: string;
  notes?: string;
  // Multi-board hierarchy (NEW)
  board_type?: BoardType;
  parent_board_id?: string;
  feed_circuit_ref?: string;
  sort_order?: number;
  // Sub-main cable (NEW — Phase 1 dropped `sub_main_cable_length`)
  sub_main_cable_material?: string;
  sub_main_cable_csa?: string;
  sub_main_cpc_csa?: string;
}

export interface Board {
  id: string;
  designation?: string;
  location?: string;
  board_info: BoardInfo;
  circuits: Circuit[];
}
