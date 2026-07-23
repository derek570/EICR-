/**
 * P3 (2026-07-23, feedback id 86) — the ONE shared enumerated LIM slot-value
 * helper used by the five numeric dialogue-slot parsers (amps, ka, ma, ms,
 * voltage). "LIM" (limitation — the inspector could not obtain a reading) is a
 * valid value for EVERY numeric reading field, and the active-slot / named /
 * bare-value dialogue paths route the slot answer through the slot's parser —
 * so each numeric parser must recognise the four canonical LIM forms and return
 * canonical "LIM" instead of null (a null re-asks the slot forever).
 *
 * Uses the single four-form matcher (value-enum-validator.js LIM_FORM_RE) so the
 * dialogue slots, the direct record_reading coercion, and the answer/routing
 * matchers all share one enumerated policy (lim/limb/limp/limitation). The
 * near-matches limit/limited/lynn/lym are deliberately excluded.
 */

/**
 * P3 Codex-r1 — the slot parsers run on the WHOLE active-slot reply (and on the
 * bare captured token from a namedExtractor). If this matched a LIM word
 * ANYWHERE, a field-qualified answer for a DIFFERENT slot ("breaking capacity is
 * a limitation", heard while the RATING slot is active) would cross-write LIM to
 * the current slot. So the active-slot LIM parse fires ONLY for a BARE /
 * near-bare LIM reply — the whole trimmed utterance is a LIM word plus optional
 * light filler ("it's a limitation", "a limitation", "LIM."). A FIELD-QUALIFIED
 * LIM ("the rating is a limitation") is routed by the field-anchored
 * namedExtractor instead, which passes the bare captured LIM token here — that
 * bare token matches. The four forms (lim/limb/limp/limitation) only.
 *
 * @type {RegExp}
 */
const BARE_LIM_RE =
  /^(?:(?:it'?s|that'?s|it\s+is|that\s+is|the\s+(?:reading|value)\s+is|reading\s+is|value\s+is)\s+)?(?:an?\s+)?(?:lim|limb|limp|limitation)\s*[.!?,;:]*$/i;

/**
 * Return canonical "LIM" when `text` is a BARE (unqualified) LIM reply, else
 * null (so the caller falls through to its numeric parse).
 *
 * @param {*} text
 * @returns {'LIM' | null}
 */
export function parseLimSlot(text) {
  return typeof text === 'string' && BARE_LIM_RE.test(text.trim()) ? 'LIM' : null;
}
