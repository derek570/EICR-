/**
 * Numeric range validator for record_reading / record_board_reading.
 *
 * WHAT: per-field min/max ranges for free-text numeric fields that have no
 * closed `options[]` enum on field_schema.json — so `CIRCUIT_FIELD_VALUE_ENUMS`
 * in stage6-dispatch-validation.js can't catch implausible writes (e.g.
 * `rcd_time_ms="3000"` — Sonnet sometimes hears "three thousand"
 * milliseconds for a measurement that BS 7671 caps at 300 ms for AC type
 * 30 mA RCDs).
 *
 * Audit-2026-06-02 dispatcher gap probe `probe_rcd_time_off_spec.yaml`:
 * Sonnet wrote `rcd_time_ms="3000"`. Existing validators only checked
 * circuit existence + confidence + (post-Fix B) closed enums. Numeric-text
 * fields like `rcd_time_ms` were unguarded — the value reached the
 * snapshot and shipped to iOS verbatim.
 *
 * WHY a separate module (not inlined into stage6-dispatch-validation.js):
 *  - The map will grow as we identify more ranged fields. Keeping it
 *    isolated from the dispatcher validator surface stops the file from
 *    becoming a kitchen sink.
 *  - The board-side dispatcher (stage6-dispatchers-board.js) needs the
 *    same predicate inline; importing one helper from one module is
 *    cleaner than re-implementing it twice or threading a second import
 *    through the circuit validator.
 *
 * WHY keyed on CANONICAL Sonnet field names (not legacy iOS wire names):
 * the dispatcher runs BEFORE `validateAndCorrectFields` rewrites the
 * field names for iOS. At dispatch time `record_reading.field` carries
 * the canonical name straight out of Sonnet (e.g. `rcd_time_ms`, not
 * `rcd_trip_time`). See field-name-corrections.js for the full canonical
 * → legacy mapping.
 *
 * Range choices (LOW confidence on the EXACT bounds — these are
 * sanity ceilings, not BS 7671 compliance gates):
 *   - rcd_time_ms 0–1000   0 = "didn't trip" edge case; 1000 covers
 *                          5×IΔn S-type RCD test results comfortably.
 *   - rcd_operating_current_ma 5–1000   covers 10/30/100/300/500/1000 mA
 *                          enum + any non-standard test result.
 *   - ocpd_rating_a 1–630   spans 6/10/16/20/25/32/40/50/63/80/100/125 A
 *                          MCBs + LV-side fuse switches.
 *   - ocpd_breaking_capacity_ka 1–200   covers 3/6/10/16/25/50 kA MCBs
 *                          + HRC fuse breaking capacities.
 *   - measured_zs_ohm 0–100   orders-of-magnitude check (BS 7671 tabulated
 *                          maxima cap at ~10 Ω; 100 catches order-of-
 *                          magnitude transcription errors without
 *                          rejecting legitimate high-Z circuits).
 *   - ir_test_voltage_v 100–1000   covers 250/500/1000 V test voltages.
 *
 * If a legitimate field-test write lands `value_out_of_range`, widen
 * the range in this file (or drop the field's entry entirely). The
 * 24h CloudWatch sanity sweep after deploy is the calibration loop.
 */

/**
 * Circuit-side numeric ranges, keyed by canonical Sonnet field name.
 *
 * @type {Map<string, {min: number, max: number}>}
 */
export const CIRCUIT_FIELD_NUMERIC_RANGES = new Map([
  ['rcd_time_ms', { min: 0, max: 1000 }],
  ['rcd_operating_current_ma', { min: 5, max: 1000 }],
  ['ocpd_rating_a', { min: 1, max: 630 }],
  ['ocpd_breaking_capacity_ka', { min: 1, max: 200 }],
  ['measured_zs_ohm', { min: 0, max: 100 }],
  ['ir_test_voltage_v', { min: 100, max: 1000 }],
]);

/**
 * Board-side numeric ranges, keyed by canonical Sonnet field name.
 * Today empty — none of the board-side fields have an unbounded
 * numeric range that the Fix B closed-enum gate doesn't already
 * cover (board MCB rating, Ze, PFC, etc. live in their own enums
 * via field_schema.json). Kept as a Map so future board-side
 * additions follow the same pattern as the circuit side without
 * a parallel code path.
 *
 * @type {Map<string, {min: number, max: number}>}
 */
export const BOARD_FIELD_NUMERIC_RANGES = new Map();

/**
 * Predicate: is `value` within the configured numeric range for `field`?
 *
 *  - Fields not present in the supplied range map pass through (returns
 *    {ok:true}) — non-ranged fields are out of scope for this gate.
 *  - Empty string passes — "clear this reading" semantics belong to
 *    the clear_reading tool, not record_reading; if Sonnet emits an
 *    empty string, that's a separate contract failure to handle
 *    elsewhere.
 *  - Sentinel form `>N` (e.g. `>200` for an over-range IR reading) is
 *    valid for IR fields per the schema; we strip the `>` prefix
 *    before the numeric check so a sentinel value still range-checks.
 *  - Non-numeric strings on RANGED fields are REJECTED — that's the
 *    whole point of this gate. Sonnet writing `rcd_time_ms="three
 *    thousand"` should fail dispatch and feed the model an error
 *    envelope to self-correct from, not silently appear on iOS.
 *
 * @param {string} field — canonical Sonnet field name
 * @param {string|*} value — value as received by the dispatcher
 * @param {Map<string, {min: number, max: number}>} rangeMap — which
 *   side's numeric ranges to use (CIRCUIT_FIELD_NUMERIC_RANGES for
 *   record_reading, BOARD_FIELD_NUMERIC_RANGES for record_board_reading).
 * @returns {{ok: true} | {ok: false, code: 'invalid_type' | 'value_out_of_range', field: string, value: any, min?: number, max?: number}}
 */
export function isWithinRange(field, value, rangeMap = CIRCUIT_FIELD_NUMERIC_RANGES) {
  const range = rangeMap.get(field);
  if (!range) return { ok: true };
  if (typeof value !== 'string') {
    return { ok: false, code: 'invalid_type', field, value };
  }
  // Blank passes — see JSDoc rationale above. The dispatcher's coercion
  // pass + the upstream enum gate already deal with the "Sonnet emitted
  // a blank value on a closed-enum field" failure mode.
  if (value === '') return { ok: true };
  // Sentinel form: ">N" / ">  N.NN". Strip the prefix + any whitespace,
  // then numeric-check the tail. Schema-level "is sentinel valid for
  // this field" is out of scope here — the range gate just confirms
  // the tail parses to a number inside the bound. If a field shouldn't
  // accept sentinel form at all, that's a closed-enum concern
  // (CIRCUIT_FIELD_VALUE_ENUMS), not a range concern.
  const sentinel = /^>\s*(\d+(?:\.\d+)?)$/.exec(value);
  const numeric = sentinel ? Number(sentinel[1]) : Number(value);
  if (!Number.isFinite(numeric)) {
    return {
      ok: false,
      code: 'value_out_of_range',
      field,
      value,
      min: range.min,
      max: range.max,
    };
  }
  if (numeric < range.min || numeric > range.max) {
    return {
      ok: false,
      code: 'value_out_of_range',
      field,
      value,
      min: range.min,
      max: range.max,
    };
  }
  return { ok: true };
}
