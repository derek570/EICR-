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
  const coerced = coerceRecordReadingValue(field, value);
  // Non-string seed → pass through (don't reject a rare numeric seed).
  if (typeof coerced !== 'string') {
    return { ok: true, value: coerced };
  }
  const verdict = validateNumericReadingValue(canonicalField, coerced);
  if (!verdict.ok) {
    return { ok: false, reason: verdict.code || 'invalid_numeric_reading' };
  }
  // Honour the slot's allowedValues ladder (e.g. OCPD kA) when present.
  const slot = Array.isArray(schema?.slots) ? schema.slots.find((s) => s.field === field) : null;
  if (slot && Array.isArray(slot.allowedValues) && !slot.allowedValues.includes(coerced)) {
    return { ok: false, reason: 'not_in_allowed_values' };
  }
  return { ok: true, value: coerced };
}
