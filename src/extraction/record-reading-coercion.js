/**
 * Shared value coercion for record_reading / record_board_reading writes.
 *
 * EXTRACTED from `stage6-dispatchers-circuit.js`'s dispatchRecordReading
 * so the Loaded Barrel streamed-speculation path (which receives raw
 * Sonnet tool input BEFORE dispatch) can apply the same canonicalisation
 * as the dispatcher. Without a shared helper the speculator would
 * pre-synth confirmation TTS against the RAW value ("BS 60898" /
 * "true") while the dispatcher writes the CANONICAL ("BS EN 60898" /
 * "Y") — drift between speculator-text and bundler-text would surface
 * as a parity_mismatch + a cache MISS, defeating the latency win.
 *
 * Coercion classes:
 *
 *   1. BS-EN canonicalisation — ocpd_bs_en / rcd_bs_en flow through
 *      parseBsCode. The dialogue-engine parser already encodes every
 *      reasonable variant + the Levenshtein-1 fuzzy fallback for
 *      Deepgram digit drift, so we get a single source of truth across
 *      dictation, dialogue-engine, dispatcher, AND speculator.
 *
 *   2. Y/N boolean-enum coercion — polarity_confirmed,
 *      supply_polarity_confirmed, rcd_button_confirmed,
 *      afdd_button_confirmed. Sonnet emits boolean-ish strings
 *      ("true"/"false") or English aliases ("correct"/"reversed"/
 *      "good"/"works") despite the schema enums all sharing the
 *      `["", "OK", "Y", "N", ...]` shape. The coercion table maps
 *      recognised synonyms to canonical Y/N/OK; out-of-enum noise
 *      passes through verbatim so the dispatcher's enum validator (Fix
 *      B 2026-06-02) can reject it explicitly rather than silently
 *      writing garbage.
 *
 *      JS boolean true/false are also coerced (Sonnet occasionally
 *      emits real booleans despite the schema declaring strings) —
 *      reaches the same canonical Y/N output.
 *
 *   3. (Board) nominal-voltage canonicalisation — nominal_voltage_u /
 *      nominal_voltage_uo are UK NOMINAL fields. The schema's enum is
 *      `["230", "400", "110", "N/A", "Other"]`; "240" is the
 *      pre-harmonisation UK nominal that inspectors still dictate but
 *      which has been canonical-230 since BS 7671:2008. Coerce 240 →
 *      230 so the cert reflects the post-harmonisation nominal and the
 *      enum validator doesn't reject a real-world inspector reading.
 *      Board-only — circuit-side has no nominal-voltage field.
 *
 * The helpers are PURE — they do not mutate the caller's input object;
 * each returns the coerced value (or the input value when no coercion
 * applies). The dispatcher and speculator should both substitute the
 * returned value before any side effects.
 *
 * Field sets are closed: only fields listed below get coerced. If a
 * future field needs canonicalisation, add it here so dispatcher +
 * speculator agree.
 */

import { parseBsCode } from './dialogue-engine/parsers/bs-code.js';

// Fields whose value is coerced to the {Y, N, OK} subset of the schema
// enum. Every member's options array shares the shape ["", "OK", "Y", "N", ...].
// See `config/field_schema.json`:
//   polarity_confirmed           ["", "OK", "Y", "N"]
//   supply_polarity_confirmed    same (legacy alias)
//   rcd_button_confirmed         ["", "OK", "Y", "N"]
//   afdd_button_confirmed        ["", "OK", "FAIL", "N/A", "Y", "N"]
//     — FAIL is reachable only via the explicit "fail"/"failed" aliases
//       below; N is the canonical for "no". OK and FAIL stay schema-
//       distinguishable so the inspector can mark a true device test.
const YN_BOOLEAN_FIELDS = new Set([
  'polarity_confirmed',
  'supply_polarity_confirmed',
  'rcd_button_confirmed',
  'afdd_button_confirmed',
]);
const BS_EN_FIELDS = new Set(['ocpd_bs_en', 'rcd_bs_en']);

// Insulation-resistance reading fields (circuit side). "LIM" (limitation —
// test could not be performed) is a valid value for these; Deepgram garbles
// spoken "LIM" as lim/limb/limp/limit(ation|ed)/lynn/lym. Coerce all to the
// canonical "LIM" so a Sonnet record_reading / streamed speculation value of
// "limitation" stores canonically rather than bypassing the dialogue-engine
// parser's IR canonicalisation (F1AC26FB 2026-06-16; repeat of 2026-02-18 /
// 2026-06-08 requests). Word-anchored matcher kept byte-aligned with
// parseMegaohms() in dialogue-engine/parsers/megaohms.js.
const IR_MOHM_FIELDS = new Set(['ir_live_live_mohm', 'ir_live_earth_mohm']);
const IR_LIM_RE = /\b(?:lim|limb|limp|limit(?:ation|ed)?|lynn|lym)\b/i;

const YN_TRUE_ALIASES = new Set([
  'true',
  'yes',
  'y',
  'correct',
  'pass',
  'passed',
  'good',
  'confirmed',
  'works',
  'working',
  'ok',
]);

// "fail"/"failed" stay in the canonical false set so legacy polarity
// callers continue to produce "N" — pre-Fix-B behaviour preserved. The
// afdd_button_confirmed branch below overrides them to "FAIL" because
// that field's enum lists FAIL as a distinct outcome (a tested-but-
// failed device button, vs a normal "no" answer).
const YN_FALSE_ALIASES = new Set([
  'false',
  'no',
  'n',
  'reversed',
  'incorrect',
  'wrong',
  'broken',
  'not working',
  'fail',
  'failed',
]);

const FAIL_PREFERRING_FIELDS = new Set(['afdd_button_confirmed']);
const FAIL_ALIASES = new Set(['fail', 'failed']);

const NOMINAL_VOLTAGE_FIELDS = new Set(['nominal_voltage_u', 'nominal_voltage_uo']);

// PASS/FAIL/LIM/N/A check fields (board side) — 2026-06-12 field report
// (session 15B88D6B, voiceFeedbackId 21): inspector said "Bonding is 10
// millimeters to both the water and to the gas"; Sonnet recorded
// bonding_conductor_csa fine but its bonding_water / bonding_gas writes
// carried off-enum values and were rejected value_not_in_options — the
// model did not retry, so the cert silently lost both checks and no TTS
// confirmation fired. Coerce the common truthy synonyms Sonnet emits for
// "this service is bonded" to the canonical PASS, and explicit
// not-applicable phrasing to N/A. fail/failed map to FAIL. Bare "no" is
// deliberately NOT mapped (ambiguous between "no gas supply" → N/A and
// "not bonded" → FAIL — let the enum validator reject so Sonnet
// disambiguates). Numeric values (e.g. the 10 mm² CSA misrouted into the
// check field) stay rejected too — coercing a size into PASS would fake
// a verification that wasn't dictated.
//
// bonding_other is deliberately ABSENT: it is a free-TEXT field in
// field_schema.json ("Other extraneous conductive parts bonded", e.g.
// "Central heating") with a separate bonding_other_na boolean — coercing
// its values would destroy dictated content.
const PASS_CHECK_FIELDS = new Set([
  'bonding_conductor_continuity',
  'bonding_water',
  'bonding_gas',
  'bonding_oil',
  'bonding_structural_steel',
  'bonding_lightning',
]);

const PASS_ALIASES = new Set([
  'pass',
  'passed',
  'yes',
  'true',
  'y',
  'ok',
  'good',
  'present',
  'confirmed',
  'verified',
  'satisfactory',
  'done',
  'bonded',
  'connected',
  'installed',
]);

const NA_ALIASES = new Set(['n/a', 'na', 'not applicable', 'none', 'no supply']);

const CHECK_FAIL_ALIASES = new Set(['fail', 'failed', 'unsatisfactory']);

/**
 * Apply the same coercion the record_reading dispatcher applies. Pure;
 * returns the coerced value (string) or the input value unchanged.
 *
 * @param {string} field — record_reading.field
 * @param {*} value — record_reading.value (typically string; JS boolean
 *   accepted for the Y/N field set since Sonnet sometimes emits raw
 *   booleans)
 * @returns {*} coerced value
 */
export function coerceRecordReadingValue(field, value) {
  // Fix B 2026-06-02 — boolean-true/false handling for the Y/N field set.
  // Audit found Sonnet writes `"true"` (string) to afdd_button_confirmed
  // verbatim; for symmetry we ALSO coerce raw booleans on these fields
  // before falling through to the string path. Other fields keep the
  // pre-fix behaviour of returning non-string values unchanged so the
  // dispatcher's invalid_type path can flag them.
  if (typeof value === 'boolean' && YN_BOOLEAN_FIELDS.has(field)) {
    return value ? 'Y' : 'N';
  }
  if (typeof value !== 'string') return value;

  if (BS_EN_FIELDS.has(field)) {
    const canonical = parseBsCode(value);
    if (canonical) return canonical;
    return value;
  }

  if (IR_MOHM_FIELDS.has(field)) {
    // Only LIM garbles are coerced; numeric / ">N" / sentinel readings pass
    // through verbatim (none contain a LIM word token).
    if (IR_LIM_RE.test(value)) return 'LIM';
    return value;
  }

  if (YN_BOOLEAN_FIELDS.has(field)) {
    const v = value.trim().toLowerCase();
    if (YN_TRUE_ALIASES.has(v)) return v === 'ok' ? 'OK' : 'Y';
    // afdd_button_confirmed prefers FAIL over N for "fail"/"failed"
    // because FAIL is a distinct enum value (a tested-but-failed device
    // button). On polarity_confirmed / rcd_button_confirmed FAIL is not
    // in the enum, so the legacy "fail" → "N" mapping is preserved
    // (an inspector saying "polarity fail" historically meant reversed,
    // which canonicalises to N on those fields).
    if (FAIL_PREFERRING_FIELDS.has(field) && FAIL_ALIASES.has(v)) return 'FAIL';
    if (YN_FALSE_ALIASES.has(v)) return 'N';
    return value;
  }

  return value;
}

/**
 * Fix B 2026-06-02 — parallel coercion for record_board_reading writes.
 *
 * Pure; returns the coerced value or the input verbatim.
 *
 * Scope today: nominal_voltage_u / nominal_voltage_uo "240" → "230"
 * (UK pre-harmonisation nominal collapses to the post-2008 canonical;
 * inspector intent is preserved as "230V supply" because that's what
 * the cert form actually reports). All other board fields pass through;
 * extend here as new board-side coercion needs surface.
 *
 * @param {string} field — record_board_reading.field
 * @param {*} value — record_board_reading.value
 * @returns {*} coerced value
 */
export function coerceRecordBoardReadingValue(field, value) {
  // PASS-check fields accept raw booleans (Sonnet occasionally emits real
  // booleans despite the string schema) — true means "this check passed".
  // false is NOT coerced: it is ambiguous between FAIL and N/A, so it falls
  // through to the enum validator for an explicit model retry.
  if (typeof value === 'boolean' && PASS_CHECK_FIELDS.has(field)) {
    return value ? 'PASS' : value;
  }
  if (typeof value !== 'string') return value;

  if (NOMINAL_VOLTAGE_FIELDS.has(field)) {
    const trimmed = value.trim();
    if (trimmed === '240') return '230';
    return value;
  }

  if (PASS_CHECK_FIELDS.has(field)) {
    const v = value.trim().toLowerCase();
    // Exact canonical values pass through case-normalised so "pass"/"Pass"
    // land as the schema's uppercase enum members.
    if (PASS_ALIASES.has(v)) return 'PASS';
    if (NA_ALIASES.has(v)) return 'N/A';
    if (CHECK_FAIL_ALIASES.has(v)) return 'FAIL';
    if (v === 'lim' || v === 'limitation') return 'LIM';
    return value;
  }

  return value;
}
