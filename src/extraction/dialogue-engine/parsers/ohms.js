/**
 * Bare-decimal ohms parser. Used by ring continuity (R1/Rn/R2).
 *
 * Recognised shapes (docstring corrected 2026-07-29 — it previously claimed
 * an UNIMPLEMENTED ">999"/"DISC" sentinel mapping):
 *   - LIM forms ("lim" / "limb" / "limp" / "limitation") → "LIM" via the
 *     shared parseLimSlot (P3)
 *   - Discontinuity sentinels ("infinite" / "infinity" / "open" /
 *     "open circuit" / "open ring" / "discontinuous") → "∞", as a BARE or
 *     near-bare reply only (PLAN-A2, feedback id 141)
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
 * ANCHORED TO THE WHOLE REPLY, and that is the load-bearing part. The plan
 * asked for the legacy twin's pattern, which scans for the words ANYWHERE in
 * the text. Copying it verbatim was wrong, because this parser has a caller the
 * twin's shape makes dangerous: the engine's bare-value fallback (engine.js,
 * step 8 "Bare-value fallback") runs the slot's parser over the ENTIRE
 * utterance when no named extractor matched. With an anywhere-scan, ordinary
 * speech during an active ring loop — "I'll open the board", "leave the door
 * open", "I can't get it open" — writes "∞" into whichever leg is currently
 * expected, certifying a conductor as broken on a live certificate. No
 * topic-switch pattern intercepts those, and the 60 s and 180 s timers bound
 * the exposure window without undoing the write. Codex EP review, finding 2.
 *
 * This is the SAME hazard, and the same fix, as `parseLimSlot`'s P3 Codex-r1
 * note in the sibling module: a slot parser that matches a keyword anywhere
 * cross-writes a different slot's answer. So the sentinel fires only for a
 * bare/near-bare reply, with the same light filler that helper allows. A
 * FIELD-QUALIFIED sentinel ("the CPC is open circuit") still writes, because
 * the namedExtractor matches the field word and hands this parser the bare
 * captured token — exactly the route `parseLimSlot` documents.
 *
 * DELIBERATE DIVERGENCE FROM THE TWIN, recorded rather than hidden: the engine
 * is now strictly NARROWER than `ring-continuity-script.js` `parseValue` on
 * non-bare text. The two still agree on all six forms, on numerics and on plain
 * non-values — which is what the plan's three-grammar parity test asserts — and
 * the divergence is pinned by its own test. Narrower is the safe direction (a
 * missed sentinel re-asks; a false one corrupts a certificate), and the twin is
 * not in the live path: `sonnet-stream.js` imports the dialogue engine.
 *
 * "∞" (U+221E) is the stored value, matching the agentic prompt's contract and
 * `VALID_SENTINELS` in value-normalise.js — not "DISC", not "OL", not a number.
 * It is spoken as the word "infinity" by `speakSentinelValue`
 * (confirmation-text.js); a TTS voice reads the bare character as silence.
 */
const BARE_DISCONTINUITY_RE =
  /^(?:(?:it'?s|that'?s|it\s+is|that\s+is|the\s+(?:reading|value)\s+is|reading\s+is|value\s+is)\s+)?(?:an?\s+)?(?:infinite|infinity|open(?:\s+circuit|\s+ring)?|discontinuous)\s*[.!?,;:]*$/i;

export function parseOhms(text) {
  if (typeof text !== 'string') return null;
  // P3 — "LIM" (limitation) is a valid ring-leg value (the inspector could not
  // obtain the reading). Checked before the numeric match so a LIM ring answer
  // writes canonical "LIM" instead of re-asking. The four-form matcher is shared
  // with the other numeric slot parsers.
  const lim = parseLimSlot(text);
  if (lim) return lim;
  // PLAN-A2 — discontinuity sentinels, kept AFTER the LIM branch as the plan
  // pins. Both matchers are now whole-reply anchored, so the two can never both
  // fire on one reply and the ordering is a contract rather than a tie-break: a
  // bare "limitation" is LIM, a bare "open circuit" is "∞", and a mixed
  // non-bare utterance such as "limitation — the circuit is open" matches
  // NEITHER and falls through to a re-ask. Re-asking is the right answer there:
  // "the test could not be performed" and "the test was performed and the
  // conductor is open" are contradictory facts on a certificate, and the
  // earlier permissive form resolved that contradiction silently — in the
  // OPPOSITE direction to stage6-answer-resolver.js, whose broad LIM check runs
  // first and returns LIM. Codex EP review, finding 3.
  //
  // Before the numeric branch, so a bare sentinel reply is never re-read as a
  // number. Note what that does NOT cover: a NON-bare reply mixing a sentinel
  // with a digit ("open circuit on the 2.5") still falls through to the numeric
  // branch and yields "2.5", exactly as it did before PLAN-A2. Suppressing the
  // number because a sentinel word appears somewhere would silently DROP real
  // readings ("0.43, the board was open"), which Audio-First #2 forbids — so
  // the pre-existing behavior is left alone rather than traded for a new
  // failure mode. Pinned by test.
  if (BARE_DISCONTINUITY_RE.test(text.trim())) return INFINITY_SENTINEL;
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
