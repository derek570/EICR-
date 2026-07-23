/**
 * kA (kiloamps) parser for OCPD breaking capacity. Common ratings:
 * 3, 6, 10, 15, 25, 50 kA.
 *
 * Recognised forms:
 *   "6"     → "6"
 *   "6 kA"  → "6"
 *   "10"    → "10"
 *   "10kA"  → "10"
 *
 * The unit word is decorative — iOS stores `ocpd_breaking_capacity_ka`
 * as a bare integer/decimal string. Reasonable range 1..200.
 *
 * Returns the canonical integer string or null.
 */
import { parseLimSlot } from './lim-slot.js';

export function parseKa(text) {
  if (typeof text !== 'string' || !text) return null;
  // P3 — "LIM" (limitation) is a valid breaking-capacity value.
  const lim = parseLimSlot(text);
  if (lim) return lim;
  const m = text.match(/\b(\d+(?:\.\d+)?)\s*(?:k\s*a)?\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 1 || n > 200) return null;
  // Preserve "6" not "6.0" — match the schema's text-field storage.
  return Number.isInteger(n) ? String(n) : String(n);
}
