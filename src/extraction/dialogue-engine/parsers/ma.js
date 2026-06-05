/**
 * Milliamps parser for RCD operating current (rcd_operating_current_ma).
 * Standard residential RCDs are 30 mA; selective upstream RCDs are
 * 100 / 300 mA; commercial / industrial up to 500.
 *
 * Recognised forms:
 *   "30"        → "30"
 *   "30 mA"     → "30"
 *   "30mA"      → "30"
 *   "thirty milliamps"  → already digit-form via iOS NumberNormaliser
 *
 * Reasonable range 1..1000.
 */
export function parseMa(text) {
  if (typeof text !== 'string' || !text) return null;
  const m = text.match(/\b(\d{1,4})\s*(?:m\s*a|milli\s*amps?)?\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 1 || n > 1000) return null;
  return String(n);
}
