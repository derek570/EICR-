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
// `\\bo\\s*l\\b` (not bare `o\\s*l`) anchors the OL meter shorthand to
// word boundaries so it doesn't match inside common English words —
// "isolation", "old", "tolerance", "voltage", "follow" all contain "ol"
// substrings that, without word boundaries, would falsely fire as the
// saturation sentinel and certify an IR reading as ">999". Defence in
// depth: the insulation-resistance schema's namedExtractor also uses a
// connector allowlist to prevent the bridge into these words, but the
// value group itself is reused in fallback paths (parseBareMegaohmsWithUnit,
// active-script bare-value matching) and any future consumer would pick
// up the same fix here.
export const MEGAOHMS_VALUE_GROUP =
  '>\\s*\\d+(?:\\.\\d+)?|>\\s*\\.\\d+|greater\\s+(?:than|then)\\s+\\d+(?:\\.\\d+)?|greater\\s+(?:than|then)\\s+\\.\\d+|more\\s+than\\s+\\d+(?:\\.\\d+)?|more\\s+than\\s+\\.\\d+|over\\s+\\d+(?:\\.\\d+)?|above\\s+\\d+(?:\\.\\d+)?|infinite|infinity|off\\s*scale|out\\s*of\\s*range|\\bo\\s*l\\b|max(?:ed)?(?:\\s+out)?|\\d*\\.?\\d+';

/**
 * Restricted value group for the BARE-BRIDGE arm of the L-L/L-E named
 * extractor. Identical to MEGAOHMS_VALUE_GROUP except the trailing
 * bare-numeric branch `\\d*\\.?\\d+` is replaced with
 * `\\d{2,}|\\d+\\.\\d+|\\.\\d+` — so single-digit integers no longer
 * match the bare path.
 *
 * Why two value groups instead of one: the bare-bridge form
 * (`[^a-z\\d∞]{0,6}? VALUE`) accepts up to 6 chars of arbitrary
 * non-letter/non-digit punctuation between the label and the value.
 * That's load-bearing for natural inspector dictation like
 * "L-L 200", "L-L >299", "L-L OL". But the same loose bridge lets a
 * Flux-garbled "L L 2 L E greater than 299" certify L-L as 2 MΩ when
 * the inspector actually said "Greater than 299" once (the bare digit
 * "2" came from Flux mis-aligning "to" / two words / the start of
 * "299"). Session 284CBBCD (2026-06-03 08:26:40) reproduced this in
 * production: the IR L-L was stored as "2" while L-E correctly stored
 * ">299" from the same single utterance.
 *
 * The fix: restrict the BARE bridge's value to forms that carry
 * structural meaning:
 *   - sentinels (>X, OL, infinite, max, off-scale, out of range)
 *   - decimals (0.5, .43, 2.5) — the decimal point is a strong signal
 *     of intent
 *   - multi-digit integers (200, 999) — two or more digits implies
 *     the inspector dictated a real reading, not a single garbled digit
 *
 * The CONNECTOR bridge form (`is/was/of/reads/measures/equals/...`)
 * keeps the wider MEGAOHMS_VALUE_GROUP because the connector word is
 * itself a strong intent signal — an inspector saying "L-L is 5"
 * is clearly dictating a 5 MΩ reading, not garble. Same goes for
 * the bare-value fallback path (parseMegaohms over the whole text)
 * which the engine runs when no named extractor matched — there the
 * full text serves as the context, not a 6-char bridge.
 *
 * Single-digit bare via the connector or bare-fallback path remains
 * supported. Only the loose bare-bridge form is tightened.
 */
export const MEGAOHMS_BARE_SAFE_VALUE_GROUP =
  '>\\s*\\d+(?:\\.\\d+)?|>\\s*\\.\\d+|greater\\s+(?:than|then)\\s+\\d+(?:\\.\\d+)?|greater\\s+(?:than|then)\\s+\\.\\d+|more\\s+than\\s+\\d+(?:\\.\\d+)?|more\\s+than\\s+\\.\\d+|over\\s+\\d+(?:\\.\\d+)?|above\\s+\\d+(?:\\.\\d+)?|infinite|infinity|off\\s*scale|out\\s*of\\s*range|\\bo\\s*l\\b|max(?:ed)?(?:\\s+out)?|\\d+\\.\\d+|\\.\\d+|\\d{2,}';

/**
 * Match a bare megaohms value at IR script entry — a number or sentinel
 * followed by a megaohm-unit suffix. The unit requirement is what
 * prevents false positives on circuit numbers ("Insulation resistance
 * for circuit 5" must NOT be parsed as 5 MΩ).
 *
 * Recognised units (loose to tolerate Deepgram garble):
 *   - megaohms / megaohm / mega ohm / mega-ohm / mega ohms
 *   - milligrams / milli grams / millies — Deepgram's most common
 *     mishearing of "megaohms" in the field (session C3963EA1 was
 *     "299 milligrams" meaning 299 MΩ)
 *   - megs / mΩ / MΩ
 *
 * Used by IR schema's `bareEntryParser` to capture a single composite
 * IR figure ("the IR for the cooker is 299") that the named-extractors
 * can't tag to L-L vs L-E. The engine stashes the value in
 * `state.ambiguous_bare_value` so a later disambiguation step can ask
 * which slot it belongs to.
 *
 * Returns the canonicalised megaohm string (via parseMegaohms) or null.
 */
export function parseBareMegaohmsWithUnit(text) {
  if (typeof text !== 'string' || !text) return null;
  const re = new RegExp(
    `(${MEGAOHMS_VALUE_GROUP})\\s*(?:m(?:ega)?\\s*[- ]?\\s*ohms?|mΩ|milli\\s*grams?|millies?|megs?)`,
    'i'
  );
  const m = text.match(re);
  if (!m) return null;
  return parseMegaohms(m[1]);
}
