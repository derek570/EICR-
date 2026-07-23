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

import { isValidSentinel } from './value-normalise.js';

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
 * P3 (2026-07-23, feedback id 86) — the canonical set of numeric READING /
 * VALUE fields that accept "LIM" (limitation — the inspector could not obtain
 * a reading). This is the ONE named allow-set that drives:
 *   - the range-gate LIM acceptance (isWithinRange, below),
 *   - post-coercion validation (validateNumericReadingValue, below),
 *   - the shared garble coercion (record-reading-coercion.js coerces only the
 *     four canonical LIM forms on members of this set),
 *   - the cross-platform derivation / result-status guards (shared-utils +
 *     iOS mirror the same membership via inlined sentinel sets).
 *
 * Membership = the SIX ranged fields (CIRCUIT_FIELD_NUMERIC_RANGES) PLUS the
 * ungated numeric readings that have NO range gate (r1_r2_ohm, r2_ohm, the
 * three ring legs, ocpd_max_zs_ohm, and the two IR mohm fields). Closed-enum
 * CLASSIFICATION fields (ocpd_bs_en/type, rcd_bs_en/type, wiring_type,
 * ref_method, polarity/button results) and structural identifiers
 * (circuit_ref, designation) are FIRMLY OUT of scope — a "limitation" means
 * "I could not obtain a reading", and a classification/identifier is not a
 * reading. (Extending LIM to closed enums is a separate future plan.)
 *
 * @type {Set<string>}
 */
export const NUMERIC_READING_FIELDS = new Set([
  // The six ranged fields (also in CIRCUIT_FIELD_NUMERIC_RANGES):
  'measured_zs_ohm',
  'rcd_time_ms',
  'rcd_operating_current_ma',
  'ocpd_rating_a',
  'ocpd_breaking_capacity_ka',
  'ir_test_voltage_v',
  // Ungated numeric readings (no isWithinRange entry — validated only by
  // validateNumericReadingValue below):
  'r1_r2_ohm',
  'r2_ohm',
  'ring_r1_ohm',
  'ring_rn_ohm',
  'ring_r2_ohm',
  'ocpd_max_zs_ohm',
  'ir_live_live_mohm',
  'ir_live_earth_mohm',
]);

/**
 * Dialogue-slot field aliases → canonical NUMERIC_READING_FIELDS names. The
 * dialogue scripts seed writes under schema slot names that differ from the
 * canonical Sonnet field name (e.g. the RCD trip-time slot is `rcd_trip_time`,
 * schemas/rcd.js:42, not canonical `rcd_time_ms`). A membership/validation
 * check against only the canonical set would miss such seeded alias writes, so
 * normalise the field name through this map BEFORE any membership test — while
 * still writing the schema's required wire field.
 *
 * @type {Map<string, string>}
 */
export const DIALOGUE_SLOT_FIELD_ALIASES = new Map([['rcd_trip_time', 'rcd_time_ms']]);

/**
 * Return the canonical NUMERIC_READING_FIELDS name for a possibly-aliased
 * dialogue slot field, or the field unchanged when it has no alias.
 *
 * @param {string} field
 * @returns {string}
 */
export function canonicaliseNumericReadingField(field) {
  return DIALOGUE_SLOT_FIELD_ALIASES.get(field) ?? field;
}

/**
 * P3 — the EXACT four LIM garble forms accepted anywhere in the pipeline.
 * Enumerated (NOT fuzzy) per the parity §3E fuzzy-matching ban: only these
 * four spellings canonicalise to "LIM". `limit`/`limited`/`lynn`/`lym` are
 * DELIBERATELY excluded (they are common non-limitation words / far garbles);
 * they must NOT coerce, so the post-coercion validator rejects them. Trailing
 * punctuation is handled by the `\b` word boundaries. This is the single
 * source of truth referenced by record-reading-coercion.js, the dialogue-slot
 * parsers, and the answer/routing matchers.
 *
 * @type {RegExp}
 */
export const LIM_FORM_RE = /\b(?:lim|limb|limp|limitation)\b/i;

/**
 * True if `value` (a string) contains one of the four canonical LIM forms.
 *
 * @param {*} value
 * @returns {boolean}
 */
export function isLimForm(value) {
  return typeof value === 'string' && LIM_FORM_RE.test(value);
}

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
  // P3 (2026-07-23, feedback id 86) — "LIM" (limitation: the inspector could
  // not obtain a reading) is a legitimate value for EVERY ranged reading
  // field. Accept the CANONICAL "LIM" here (record-reading-coercion.js has
  // already canonicalised the four garble forms before this gate runs). The
  // `typeof === 'string'` guard above is load-bearing: `["LIM"]` must NOT
  // stringify through — an array/object still hits the invalid_type gate. Only
  // the exact "LIM" sentinel is admitted; the OTHER sentinels (n/a, na, ∞,
  // inf, infinity) stay rejected on ranged fields (a "not applicable" or
  // "discontinuous" is not a valid measurement here — only a limitation is).
  if (value.trim().toLowerCase() === 'lim') return { ok: true };
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

/**
 * P3 (2026-07-23, feedback id 86) — post-coercion validation for the WHOLE
 * NUMERIC_READING_FIELDS set, invoked from BOTH the direct record_reading
 * dispatcher AND the set_field_for_all_circuits bulk dispatcher.
 *
 * WHY this exists on top of isWithinRange: only the SIX ranged fields have an
 * isWithinRange entry. The ungated numeric readings (r1_r2_ohm, r2_ohm, the
 * three ring legs, ocpd_max_zs_ohm, the two IR mohm fields) have NO gate — so
 * a near-match garble the coercion left unchanged (e.g. `r1_r2_ohm="limited"`)
 * would persist VERBATIM and then be treated as blank by the derivation guard
 * and overwritten. This validator rejects any non-numeric string on an ungated
 * numeric field that is not a recognised sentinel / off-scale form / canonical
 * LIM.
 *
 * Contract per field class:
 *   - Ranged field (in CIRCUIT_FIELD_NUMERIC_RANGES): delegate to isWithinRange
 *     so it stays the SINGLE authority (numeric bounds + canonical LIM accepted;
 *     other sentinels + out-of-range rejected).
 *   - Ungated numeric reading field: accept finite numerics (string or number),
 *     `>N`/`<N` off-scale forms, the recognised VALID_SENTINELS (n/a, na, ∞,
 *     inf, infinity — legitimate for IR/ring fields today), canonical "LIM",
 *     and blank; REJECT every other string (the four near-matches included).
 *   - Any field NOT in NUMERIC_READING_FIELDS: pass through {ok:true} (not our
 *     concern — the closed-enum + text validators own those).
 *
 * The caller (dispatcher) passes the CANONICAL field name (or normalises a
 * dialogue-slot alias first via canonicaliseNumericReadingField). Coercion
 * (record-reading-coercion.js) runs BEFORE this so canonical "LIM" is what we
 * see for an accepted garble.
 *
 * @param {string} field — canonical Sonnet field name (alias-normalised)
 * @param {string|number|*} value — post-coercion value
 * @returns {{ok: true} | {ok: false, code: string, field: string, value: any, min?: number, max?: number}}
 */
export function validateNumericReadingValue(field, value) {
  // Ranged fields → isWithinRange is authoritative (bounds + LIM + sentinel
  // rejection all live there). Keeps one source of truth for the six.
  if (CIRCUIT_FIELD_NUMERIC_RANGES.has(field)) {
    return isWithinRange(field, value, CIRCUIT_FIELD_NUMERIC_RANGES);
  }
  // Not a numeric reading field → not this validator's concern.
  if (!NUMERIC_READING_FIELDS.has(field)) return { ok: true };

  // Ungated numeric reading field.
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? { ok: true }
      : { ok: false, code: 'invalid_type', field, value };
  }
  if (typeof value !== 'string') {
    return { ok: false, code: 'invalid_type', field, value };
  }
  const v = value.trim();
  if (v === '') return { ok: true };
  if (v.toLowerCase() === 'lim') return { ok: true }; // canonical LIM (post-coercion)
  if (isValidSentinel(v)) return { ok: true }; // n/a, na, ∞, inf, infinity
  if (/^[<>]\s*\d+(?:\.\d+)?$/.test(v)) return { ok: true }; // off-scale sentinel form
  if (Number.isFinite(Number(v))) return { ok: true }; // numeric string
  return { ok: false, code: 'value_invalid_numeric_reading', field, value };
}
