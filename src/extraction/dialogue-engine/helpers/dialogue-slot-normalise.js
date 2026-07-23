/**
 * P3 (2026-07-23, feedback id 86) — the ONE dialogue-slot write normaliser for
 * SEEDED pending_writes, which bypass the slot parsers entirely (they are
 * applied directly / queued for the drain path). Sonnet can seed a numeric
 * reading field with a LIM garble, a near-match, an alternate sentinel, or an
 * out-of-range value; without a normaliser those apply VERBATIM (a persisted
 * wrong-write).
 *
 * Contract:
 *   - Coerce the value (four-form LIM → canonical "LIM") for numeric reading
 *     fields, THEN validate it (range / numeric-validity via
 *     validateNumericReadingValue) AND the slot's `allowedValues` when the
 *     schema declares one (e.g. the OCPD-kA ladder). A failure returns
 *     {ok:false} so the caller DROPS the write.
 *   - Non-numeric-reading fields (bs_en, rcd_type, Y/N, …) pass through with
 *     their value UNCHANGED — preserving the pre-P3 seed behaviour, which
 *     deliberately coerced only `ir_live_*` and left bs_en / Y-N alone.
 *   - Non-string coerced values pass through unchanged (seeds are strings in
 *     practice; this avoids rejecting a rare numeric seed on a ranged field).
 *
 * "Coercion is NOT validation": coerceRecordReadingValue only canonicalises the
 * accepted LIM spellings; a near-match ("limited"), an alternate sentinel, or an
 * invalid numeric survives coercion and must be REJECTED here.
 */

import { coerceRecordReadingValue } from '../../record-reading-coercion.js';
import {
  NUMERIC_READING_FIELDS,
  canonicaliseNumericReadingField,
  validateNumericReadingValue,
} from '../../value-enum-validator.js';

/**
 * @param {object} schema — the dialogue schema (for slot.allowedValues lookup)
 * @param {string} field — the wire field name
 * @param {*} value — the raw seeded value
 * @returns {{ok:true, value:*} | {ok:false, reason:string}}
 */
export function normaliseDialogueSlotWrite(schema, field, value) {
  const canonicalField = canonicaliseNumericReadingField(field);
  // Non-numeric-reading field → preserve pre-P3 seed behaviour verbatim.
  if (!NUMERIC_READING_FIELDS.has(canonicalField)) {
    return { ok: true, value };
  }
  // Coerce with the CANONICAL field so a dialogue-slot alias (rcd_trip_time)
  // still canonicalises its LIM garbles (coerceRecordReadingValue keys on
  // NUMERIC_READING_FIELDS membership, which the raw alias name misses).
  const coerced = coerceRecordReadingValue(canonicalField, value);
  // Exact LIM forms accepted first (canonical "LIM").
  if (typeof coerced === 'string' && coerced.trim().toLowerCase() === 'lim') {
    return { ok: true, value: 'LIM' };
  }
  // "Coercion is NOT validation" — ELSE run the slot's own parser (which
  // enforces the slot's specific numeric range + rejects garble/near-matches),
  // then the slot's allowedValues. A parser-rejected value (incl. a non-string
  // that isn't a finite number, a near-match, or an out-of-range numeric) is
  // REJECTED so the drain drops it instead of persisting a wrong write.
  const slot = Array.isArray(schema?.slots) ? schema.slots.find((s) => s.field === field) : null;
  // A finite-number seed is stringified so the parser can validate it; any
  // other non-string (array/object/null/NaN/Infinity) becomes '' and is
  // rejected by the parser.
  const parseInput =
    typeof coerced === 'string'
      ? coerced
      : typeof coerced === 'number' && Number.isFinite(coerced)
        ? String(coerced)
        : '';
  if (slot && typeof slot.parser === 'function') {
    const parsed = slot.parser(parseInput);
    if (parsed === null || parsed === undefined) {
      return { ok: false, reason: 'slot_parser_rejected' };
    }
    if (Array.isArray(slot.allowedValues) && !slot.allowedValues.includes(parsed)) {
      return { ok: false, reason: 'not_in_allowed_values' };
    }
    return { ok: true, value: parsed };
  }
  // No slot parser in this schema (a cross-schema seed) → fall back to the
  // canonical numeric validator. A finite-number seed is accepted; any other
  // non-string / invalid string is rejected.
  const verdict = validateNumericReadingValue(canonicalField, coerced);
  if (!verdict.ok) {
    return { ok: false, reason: verdict.code || 'invalid_numeric_reading' };
  }
  return { ok: true, value: coerced };
}
