/**
 * Bare-decimal ohms parser. Used by ring continuity (R1/Rn/R2).
 *
 * Recognised shapes (docstring corrected 2026-07-29 — it previously claimed
 * an UNIMPLEMENTED ">999"/"DISC" sentinel mapping):
 *   - LIM forms ("lim" / "limb" / "limp" / "limitation") → "LIM" via the
 *     shared parseLimSlot (P3)
 *   - Discontinuity sentinels ("infinite" / "infinity" / "open" /
 *     "open circuit" / "open ring" / "discontinuous") → "∞" (PLAN-A2,
 *     feedback id 141)
 *   - Bare decimal: "0.43", ".43", "43" → leading-zero-normalised numeric
 *
 * Returns the canonical string value or null.
 */
import { parseLimSlot } from './lim-slot.js';
// The sentinel CHARACTER and its spoken form are owned by one module so the
// writer and the read-back can never disagree about what was stored.
import { INFINITY_SENTINEL } from '../../confirmation-text.js';

/**
 * PLAN-A2 (2026-09-23, feedback id 141) — the six discontinuity forms the ring
 * slot grammar already CAPTURES. Before this, `RING_VALUE_GROUP` matched them
 * and `parseOhms` returned null, so a dictated *"Open circuit"* was consumed by
 * the ring loop and written nowhere: the engine re-asked for the same leg and
 * the inspector's reading vanished (Audio-First #2 — a structurally complete
 * reading is never silently dropped).
 *
 * The pattern is a BYTE-FOR-BYTE copy of the legacy twin's, at
 * `ring-continuity-script.js` `parseValue` — the two grammars are pinned
 * against each other by the replay corpus and by the three-grammar parity test
 * in `dialogue-ohms-discontinuity.test.js`, so they must agree on exactly which
 * strings are a discontinuity. Word-anchored at BOTH ends so it can never fire
 * inside "opening" / "reopened" / "infinitely".
 *
 * "∞" (U+221E) is the stored value, matching the agentic prompt's contract and
 * `VALID_SENTINELS` in value-normalise.js:108 — not "DISC", not "OL", not a
 * number. It is spoken as the word "infinity" by
 * `buildValueSpokenTail`/`speakSentinelValue` (confirmation-text.js); a TTS
 * voice reads the bare character as silence.
 */
const DISCONTINUITY_PATTERN =
  /\b(?:infinite|open(?:\s+ring|\s+circuit)?|discontinuous|infinity)\b/i;

export function parseOhms(text) {
  if (typeof text !== 'string') return null;
  // P3 — "LIM" (limitation) is a valid ring-leg value (the inspector could not
  // obtain the reading). Checked before the numeric match so a LIM ring answer
  // writes canonical "LIM" instead of re-asking. The four-form matcher is shared
  // with the other numeric slot parsers.
  const lim = parseLimSlot(text);
  if (lim) return lim;
  // PLAN-A2 — discontinuity sentinels. Deliberately AFTER the LIM branch: "LIM"
  // means the test could not be performed, "∞" means it was performed and the
  // conductor is open. A reply carrying both words is the weaker claim, so the
  // limitation wins (same precedence the answer-resolver uses at
  // stage6-answer-resolver.js:2896-2905, where "limb" must not fall through
  // to ∞). Before the numeric branch so "open circuit on the 2.5" cannot be
  // reduced to the cable size.
  if (DISCONTINUITY_PATTERN.test(text)) return INFINITY_SENTINEL;
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
