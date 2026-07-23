/**
 * Milliseconds parser for RCD trip time (rcd_trip_time).
 *
 * BS 7671 limits: 300 ms max at 1×IΔn for type AC/A RCDs (regs 415.1.1),
 * 40 ms max at 5×IΔn for general RCDs. Real-world readings are
 * typically 10–80 ms on a healthy 30 mA RCD. Cap at 1000 ms — anything
 * above is a recording error or a defective RCD, and rejecting an
 * implausible value lets the script re-ask cleanly.
 *
 * Recognised forms:
 *   "25"           → "25"     (bare digit, only valid when this slot
 *                              accepts a bare value — see ms.test)
 *   "25 ms"        → "25"
 *   "25ms"         → "25"
 *   "25 milliseconds" → "25"
 *   "30 millisecond"  → "30"
 *
 * Returns canonical integer-string ("25", not "25.0"); the database
 * stores trip time as a string for consistency with other ring/IR
 * fields.
 */
import { parseLimSlot } from './lim-slot.js';

export function parseMs(text) {
  if (typeof text !== 'string' || !text) return null;
  // P3 — "LIM" (limitation) is a valid RCD trip-time value.
  const lim = parseLimSlot(text);
  if (lim) return lim;
  // \b\d+(?:\.\d+)?\b captures bare integers and decimals (some testers
  // emit "12.5 ms"); the trailing unit is optional so a bare-value
  // answer like "25" still parses.
  const m = text.match(/\b(\d+(?:\.\d+)?)\s*(?:m\s*s|millisecond|milliseconds)?\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 1 || n > 1000) return null;
  // Canonicalise: drop trailing ".0" so "25.0" → "25", but preserve
  // "12.5" as-is.
  return n === Math.round(n) ? String(Math.round(n)) : String(n);
}
