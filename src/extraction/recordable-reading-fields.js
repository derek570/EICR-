/**
 * Shared whitelist of every regex-emittable reading-field name.
 *
 * 2026-06-03 — created during the observation-correctness sprint to
 * share a single source of truth between:
 *   - stage6-overtake-classifier.js step 1.5 (does an inbound regex
 *     hit represent a fresh reading, or is it a continuation utterance
 *     for a pending observation ask?), and
 *   - reading-transcript-anchor.js (does the inspector's utterance
 *     contain a recognisable anchor for the field being written —
 *     spoken alias or normalised label?). Bug 2's coverage test
 *     iterates this set to assert anchor presence for every field.
 *
 * Covers three categories:
 *   (i)   record_reading-writable circuit_fields with numeric readings
 *         (measured_zs_ohm, r1_r2_ohm, r2_ohm, ir_*, polarity, etc.).
 *   (ii)  regex-emittable board_fields — board-level measurements the
 *         regex layer reports on the same wire shape as circuit readings
 *         (ze, ze_at_db, ipf_at_db).
 *   (iii) legacy regex aliases still used in
 *         stage6-overtake-classifier.test.js and pre-llm-gate.test.js
 *         (zs, pfc, r1_plus_r2, rcd_trip_time). Required because both
 *         test files emit regex hits in the legacy shape, and the
 *         classifier's step 1.5 must treat those as recordable readings
 *         (i.e. topic-changes, NOT bare-circuit-reference continuations)
 *         so it doesn't steal a real reading reply into a pending
 *         observation_clarify ask.
 *
 * Explicit exclusions (circuit metadata; regex hits on these are
 * observation-context continuations, not fresh readings):
 *   circuit_ref, circuit_designation, wiring_type, ref_method,
 *   ocpd_bs_en, ocpd_type, rcd_type, rcd_bs_en, name, location,
 *   manufacturer, phases, earthing_arrangement, feeds_board_id,
 *   is_distribution_circuit, board_type, parent_board_id,
 *   feed_circuit_ref, sort_order, sub_main_*.
 *
 * Note: ocpd_rating_a / ocpd_breaking_capacity_ka / ocpd_max_zs_ohm
 * ARE included below because they are numeric readings the regex layer
 * can emit with a value; only the categorical ocpd_bs_en / ocpd_type
 * are excluded.
 *
 * NOT a derivation from any single config file — adding a new
 * regex-emittable reading field requires editing this whitelist AND
 * adding a unit test that exercises the new field. Hand-curated; no
 * JSON load at module init. Silent under-membership re-introduces
 * Bug 1b (the classifier steals real readings into pending observation
 * asks); silent over-membership treats continuation utterances as
 * topic-changes.
 */

export const RECORDABLE_READING_FIELDS = new Set([
  // canonical (config/field_schema.json circuit_fields + the three
  // board-level measurements that share the regex wire shape)
  'measured_zs_ohm',
  'ze',
  'ze_at_db',
  'ipf_at_db',
  'r1_r2_ohm',
  'r2_ohm',
  'ring_r1_ohm',
  'ring_rn_ohm',
  'ring_r2_ohm',
  'ir_live_live_mohm',
  'ir_live_earth_mohm',
  'ir_test_voltage_v',
  'rcd_time_ms',
  'rcd_operating_current_ma',
  'polarity_confirmed',
  'rcd_button_confirmed',
  'afdd_button_confirmed',
  'number_of_points',
  'live_csa_mm2',
  'cpc_csa_mm2',
  'max_disconnect_time_s',
  'ocpd_rating_a',
  'ocpd_breaking_capacity_ka',
  'ocpd_max_zs_ohm',
  // legacy / wire aliases still emitted by regex + in classifier tests
  'zs',
  'pfc',
  'r1_plus_r2',
  'rcd_trip_time',
]);
