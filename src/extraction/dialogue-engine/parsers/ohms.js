/**
 * Bare-decimal ohms parser. Used by ring continuity (R1/Rn/R2).
 *
 * Recognised shapes (docstring corrected 2026-07-29 — it previously claimed
 * an UNIMPLEMENTED ">999"/"DISC" sentinel mapping):
 *   - LIM forms ("lim" / "limb" / "limp" / "limitation") → "LIM" via the
 *     shared parseLimSlot (P3)
 *   - Bare decimal: "0.43", ".43", "43" → leading-zero-normalised numeric
 *   - Sentinel words ("infinite" / "open" / "discontinuous" / "infinity")
 *     → null. They CAPTURE in the slot regexes but do not write — the
 *     documented pre-existing limitation: sentinel-valued ring readings
 *     remain model-bound (a future wave owns writing them).
 *
 * Returns the canonical string value or null.
 */
import { parseLimSlot } from './lim-slot.js';

export function parseOhms(text) {
  if (typeof text !== 'string') return null;
  // P3 — "LIM" (limitation) is a valid ring-leg value (the inspector could not
  // obtain the reading). Checked before the numeric match so a LIM ring answer
  // writes canonical "LIM" instead of re-asking. The four-form matcher is shared
  // with the other numeric slot parsers.
  const lim = parseLimSlot(text);
  if (lim) return lim;
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
