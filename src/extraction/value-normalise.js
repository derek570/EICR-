// value-normalise.js
// Single source of truth for normalising resistance / text values so the
// filled-slots filter (state-snapshot cross-reference) and the QuestionGate
// (heard-value dedup) agree on what counts as "the same value". Without
// shared normalisation, "0.13", " 0.13 ", "0.130", and "0.13 ohms" would
// all be treated as distinct and the two defences would disagree.

/**
 * Normalise a value so equivalent forms compare equal.
 *
 * Numeric inputs are parsed and reformatted via Number.toString so trailing
 * zeros ("0.130") collapse to the canonical form ("0.13"). Strings prefixed
 * with a number and optional unit suffix ("0.13 ohms", "0.13 Ω") reduce to
 * the same numeric form. Non-numeric strings (e.g. "LIM", ">200", "TT",
 * observation phrases) are lowercased and whitespace-collapsed but otherwise
 * preserved — their semantic meaning is the exact text.
 *
 * Returns "" for null / undefined / empty / whitespace-only input so callers
 * can early-return on empty.
 *
 * Intentionally conservative — does NOT:
 *   - round to a fixed decimal precision (Sonnet's extraction already
 *     preserves the inspector's stated precision; rounding could merge
 *     genuinely-different readings like 0.13 and 0.15 if we later widened
 *     the tolerance).
 *   - strip ">" or "<" prefixes (">200" is a >-flagged reading, not "200" —
 *     these have different meaning on an IR test).
 *   - handle units beyond stripping (e.g. "13 kΩ" vs "13000" won't match —
 *     mixing units inside a session is rare enough that supporting it
 *     would be more risk than benefit).
 *
 * @param {*} v
 * @returns {string} normalised string (may be empty)
 */
export function normaliseValue(v) {
  if (v === null || v === undefined) return '';
  const raw = String(v).trim().toLowerCase();
  if (!raw) return '';
  // Preserve semantic prefixes — these are NOT numeric equivalences.
  if (raw.startsWith('>') || raw.startsWith('<')) return raw;
  // Leading-number match: captures "0.13", "0.13 ohms", "0.13Ω", "-0.5mV".
  // If the non-numeric suffix is anything other than whitespace + a short
  // unit token, fall back to the raw string to avoid silently dropping
  // meaningful content.
  const m = raw.match(/^([-+]?\d*\.?\d+)(?:\s*([a-zμωΩµ]{0,4}))?$/iu);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) return n.toString();
  }
  // Collapse internal whitespace for multi-word phrases (observation text).
  return raw.replace(/\s+/g, ' ');
}
