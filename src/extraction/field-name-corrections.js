/**
 * Canonical field-name corrections.
 *
 * Sonnet's `record_reading` tool emits Stage 6 canonical field names
 * (e.g. `r1_r2_ohm`, `measured_zs_ohm`, `rcd_time_ms`). The iOS wire
 * contract historically uses LEGACY names (e.g. `r1_plus_r2`, `zs`,
 * `rcd_trip_time`). `validateAndCorrectFields` in sonnet-stream.js
 * walks `result.extracted_readings` and rewrites each Sonnet-emitted
 * name to the legacy wire form before the result leaves the backend.
 *
 * Extracted to its own module 2026-05-26 so the dialogue engine's
 * post-dispatch `tryEnterScriptFromWrites` hook (stage6-shadow-
 * harness.js) can resolve the same aliases when scanning Sonnet's
 * writes for slot membership. The hook runs INSIDE runLiveMode,
 * before `validateAndCorrectFields` rewrites the field names — so
 * the readings it sees still carry Sonnet's canonical names.
 *
 * Repro for the engine-side alias need: session 904344CD turn-10
 * (2026-05-26). Sonnet emitted `record_reading {field: 'rcd_time_ms',
 * circuit: 2}`. rcdSchema's slot is `rcd_trip_time`. Without alias
 * resolution the hook bailed (`no_matching_schema`) even though the
 * write logically belongs to the RCD walk-through. Field correction
 * then ran post-hook, rewriting `rcd_time_ms` → `rcd_trip_time` — too
 * late.
 *
 * Live import sites:
 *   - sonnet-stream.js: validateAndCorrectFields (legacy rewrite path)
 *   - stage6-shadow-harness.js: passes into tryEnterScriptFromWrites
 *
 * When adding a new entry: confirm whether the canonical (LHS) or the
 * corrected (RHS) name is the one a dialogue-engine schema lists in
 * its `slots`. The hook resolves LHS → RHS and matches on either, so
 * schemas can choose either naming. Today rcdSchema uses RHS
 * (`rcd_trip_time`) while insulationResistanceSchema uses LHS
 * (`ir_live_live_mohm`) — both work after this extraction.
 */
export const FIELD_CORRECTIONS = {
  insulation_resistance_le: 'insulation_resistance_l_e',
  insulation_resistance_ll: 'insulation_resistance_l_l',
  earth_loop_impedance_ze: 'ze',
  prospective_fault_current: 'pfc',
  // r1_plus_r2 is in KNOWN_FIELDS (iOS handles both r1_plus_r2 and r1_r2)
  rcd_trip_time_ms: 'rcd_trip_time',
  rcd_rating_ma: 'rcd_rating_a',
  cable_size_live: 'cable_size',
  cable_size_cpc: 'cable_size_earth',
  cpc_size: 'cable_size_earth',
  ir_l_e: 'insulation_resistance_l_e',
  ir_l_l: 'insulation_resistance_l_l',
  ir_le: 'insulation_resistance_l_e',
  ir_ll: 'insulation_resistance_l_l',
  loop_impedance: 'zs',
  earth_loop_impedance: 'zs',
  ring_r1: 'ring_continuity_r1',
  ring_rn: 'ring_continuity_rn',
  ring_r2: 'ring_continuity_r2',
  // 2026-04-28 (Bug-H sibling): Stage 6 `record_reading` emits the canonical
  // `field_schema.json.circuit_fields` keys (r2_ohm / ring_r1_ohm /
  // ring_rn_ohm / ring_r2_ohm / measured_zs_ohm / r1_r2_ohm /
  // ir_live_earth_mohm / ir_live_live_mohm / ir_test_voltage_v / rcd_time_ms /
  // ocpd_rating_a / ocpd_breaking_capacity_ka / max_disconnect_time_s /
  // live_csa_mm2 / cpc_csa_mm2 / polarity_confirmed / circuit_designation).
  // iOS Build 282's `applySonnetReadings` switch (DeepgramRecordingViewModel
  // .swift:3326+) only knows the LEGACY names. Without these aliases the
  // readings decode but land on `unmapped_field_buffered` — same end-user
  // symptom as the observation decode failure, just one circuit at a time.
  // Closes the field-name half of the Bug-H repro (session A354882B
  // 2026-04-28: discontinuous ring continuity readings on circuit 2 mapped
  // to `ring_r*_ohm` server-side, never landed on the iOS Circuit model).
  r2_ohm: 'r2',
  ring_r1_ohm: 'ring_continuity_r1',
  ring_rn_ohm: 'ring_continuity_rn',
  ring_r2_ohm: 'ring_continuity_r2',
  measured_zs_ohm: 'zs',
  r1_r2_ohm: 'r1_plus_r2',
  ir_live_earth_mohm: 'insulation_resistance_l_e',
  ir_live_live_mohm: 'insulation_resistance_l_l',
  ir_test_voltage_v: 'ir_test_voltage',
  rcd_time_ms: 'rcd_trip_time',
  ocpd_rating_a: 'ocpd_rating',
  ocpd_breaking_capacity_ka: 'ocpd_breaking_capacity',
  max_disconnect_time_s: 'max_disconnect_time',
  live_csa_mm2: 'cable_size',
  cpc_csa_mm2: 'cable_size_earth',
  polarity_confirmed: 'polarity',
  circuit_designation: 'designation',
  max_zs: 'ocpd_max_zs_ohm',
  ocpd_max_zs: 'ocpd_max_zs_ohm',
  max_zs_ohm: 'ocpd_max_zs_ohm',
  mcb_type: 'ocpd_type',
  mcb_rating: 'ocpd_rating',
  breaker_type: 'ocpd_type',
  breaker_rating: 'ocpd_rating',
  bs_en: 'ocpd_bs_en',
  ocpd_standard: 'ocpd_bs_en',
  rcd_standard: 'rcd_bs_en',
  main_switch_rating: 'main_switch_current',
  main_switch_type: 'main_switch_bs_en',
  // Date field variants
  inspection_date: 'date_of_inspection',
  test_date: 'date_of_inspection',
  previous_inspection_date: 'date_of_previous_inspection',
  last_inspection_date: 'date_of_previous_inspection',
  // "Main fuse" / "supply fuse" = Supply Protective Device (DNO cutout), NOT the CU main switch
  main_fuse_rating: 'spd_rated_current',
  main_fuse_current: 'spd_rated_current',
  main_fuse_bs_en: 'spd_bs_en',
  main_fuse_type: 'spd_type_supply',
  supply_fuse_rating: 'spd_rated_current',
  supply_fuse_type: 'spd_bs_en',
};
