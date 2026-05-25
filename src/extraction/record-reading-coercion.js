/**
 * Shared value coercion for record_reading-shaped writes.
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
 * Two coercion classes:
 *
 *   1. BS-EN canonicalisation — ocpd_bs_en / rcd_bs_en flow through
 *      parseBsCode. The dialogue-engine parser already encodes every
 *      reasonable variant + the Levenshtein-1 fuzzy fallback for
 *      Deepgram digit drift, so we get a single source of truth across
 *      dictation, dialogue-engine, dispatcher, AND speculator.
 *
 *   2. polarity_confirmed / supply_polarity_confirmed enum coercion —
 *      Sonnet emits boolean-ish strings ("true"/"false") or English
 *      aliases ("correct"/"reversed"/"good") despite the schema enum
 *      `["", "OK", "Y", "N"]`. The coercion table maps recognised
 *      synonyms to canonical Y / N / OK; out-of-enum noise passes
 *      through verbatim so a future divergence still surfaces visibly.
 *
 * The helper is PURE — it does not mutate the caller's input object;
 * it returns the coerced value (or the input value when no coercion
 * applies). The dispatcher and speculator should both substitute the
 * returned value before any side effects.
 *
 * Field set is closed: only fields listed below get coerced. If a
 * future field needs canonicalisation, add it here so dispatcher +
 * speculator agree.
 */

import { parseBsCode } from './dialogue-engine/parsers/bs-code.js';

const POLARITY_FIELDS = new Set(['polarity_confirmed', 'supply_polarity_confirmed']);
const BS_EN_FIELDS = new Set(['ocpd_bs_en', 'rcd_bs_en']);

const POLARITY_TRUE_ALIASES = new Set([
  'true',
  'yes',
  'y',
  'correct',
  'pass',
  'passed',
  'good',
  'confirmed',
]);

const POLARITY_FALSE_ALIASES = new Set([
  'false',
  'no',
  'n',
  'reversed',
  'fail',
  'failed',
  'incorrect',
  'wrong',
]);

/**
 * Apply the same coercion the record_reading dispatcher applies. Pure;
 * returns the coerced value (string) or the input value unchanged.
 *
 * @param {string} field — record_reading.field
 * @param {*} value — record_reading.value (typically string)
 * @returns {*} coerced value
 */
export function coerceRecordReadingValue(field, value) {
  if (typeof value !== 'string') return value;

  if (BS_EN_FIELDS.has(field)) {
    const canonical = parseBsCode(value);
    if (canonical) return canonical;
    return value;
  }

  if (POLARITY_FIELDS.has(field)) {
    const v = value.trim().toLowerCase();
    if (POLARITY_TRUE_ALIASES.has(v)) return 'Y';
    if (POLARITY_FALSE_ALIASES.has(v)) return 'N';
    if (v === 'ok') return 'OK';
    return value;
  }

  return value;
}
