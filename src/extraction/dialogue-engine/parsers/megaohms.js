/**
 * Megaohms parser for IR readings (L-L / L-E). Richer than the ohms parser
 * because IR readings routinely saturate the meter scale and need ">N"
 * sentinel handling.
 *
 * Recognised shapes (order matters — most specific first):
 *   - Greater-than: "greater than 200", "over 999", ">200", "more than X",
 *     "above X" → ">N" preserved verbatim with leading-zero normalisation.
 *   - Saturation sentinels: "infinite", "infinity", "off scale", "OL",
 *     "out of range", "maxed out" → ">999" (canonical max — IR meters
 *     typically saturate at 999 MΩ).
 *   - Numeric: "200", "0.43", ".43" → preserved verbatim with leading-zero
 *     normalisation.
 *
 * The greater-than form accepts ANY value (per field-test request) — the
 * downstream schema validator allows arbitrary text in `ir_live_*_mohm`
 * (type "text"), so any ">N" string passes through.
 *
 * DELIBERATELY EXCLUDED: "LIM" / "limit" / "limitation" — those are EICR
 * conventions for "test not performed due to access/safety limitation",
 * NOT saturation readings. A separate limitation-handling flow is the
 * right place for that signal (out of scope here).
 *
 * Behaviour identical to parseValue() in insulation-resistance-script.js
 * to keep the byte-identical replay corpus passing.
 */
export function parseMegaohms(text) {
  if (typeof text !== 'string') return null;

  // 1. Explicit greater-than forms. Allow integer or decimal payload.
  const gt = text.match(
    /(?:greater\s+(?:than|then)|more\s+than|over|above|>)\s*(\d+(?:\.\d+)?|\.\d+)/i
  );
  if (gt) {
    const raw = gt[1];
    const normalised = raw.startsWith('.') ? `0${raw}` : raw;
    return `>${normalised}`;
  }

  // 2. Saturation sentinels — meter is over-range. Canonical ">999".
  if (
    /\b(?:infinite|infinity|off\s*scale|out\s*of\s*range|o\s*l|max(?:ed)?(?:\s+out)?)\b/i.test(text)
  ) {
    return '>999';
  }

  // 3. Numeric — accept "200", "0.43", ".43", or integer "1".
  const m = text.match(/-?\d*\.\d+|-?\d+/);
  if (!m) return null;
  const raw = m[0];
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (raw.startsWith('.')) return `0${raw}`;
  if (raw.startsWith('-.')) return `-0${raw.slice(1)}`;
  return raw;
}

/**
 * Regex fragment that matches a single megaohms value inside a larger
 * named-field pattern. Exposed because the engine builds named-field
 * patterns dynamically from each slot's parser-vocabulary.
 *
 * Mirrors the `valueGroup` constant inside the original IR script's
 * extractNamedFieldValues so the same value forms are accepted.
 */
export const MEGAOHMS_VALUE_GROUP =
  '>\\s*\\d+(?:\\.\\d+)?|>\\s*\\.\\d+|greater\\s+(?:than|then)\\s+\\d+(?:\\.\\d+)?|greater\\s+(?:than|then)\\s+\\.\\d+|more\\s+than\\s+\\d+(?:\\.\\d+)?|more\\s+than\\s+\\.\\d+|over\\s+\\d+(?:\\.\\d+)?|above\\s+\\d+(?:\\.\\d+)?|infinite|infinity|off\\s*scale|out\\s*of\\s*range|o\\s*l|max(?:ed)?(?:\\s+out)?|\\d*\\.?\\d+';
