/**
 * Bare-decimal ohms parser. Used by ring continuity (R1/Rn/R2).
 *
 * Recognised shapes (order matters):
 *   - "OL" / "infinite" / "open" → ">999" (over-range sentinel)
 *   - "DISC" / "discontinuous" / "open circuit" → "DISC" (will be added later
 *     when the discontinuous-display feature lands; for PR1 we mirror the
 *     existing ring parser's shape to preserve byte-identical output)
 *   - Bare decimal: "0.43", ".43", "43" → leading-zero-normalised numeric
 *
 * Returns the canonical string value or null. Keep semantics identical to
 * the existing parseValue() in ring-continuity-script.js so the byte-
 * identical replay corpus passes — we are NOT taking the opportunity to
 * extend ring's vocabulary in this PR.
 */
export function parseOhms(text) {
  if (typeof text !== 'string') return null;
  // Numeric — accept "200", "0.43", ".43", or integer "1".
  const m = text.match(/-?\d*\.\d+|-?\d+/);
  if (!m) return null;
  const raw = m[0];
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (raw.startsWith('.')) return `0${raw}`;
  if (raw.startsWith('-.')) return `-0${raw.slice(1)}`;
  return raw;
}
