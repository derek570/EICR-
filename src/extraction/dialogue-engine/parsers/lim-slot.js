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

import { isLimForm } from '../../value-enum-validator.js';

/**
 * Return canonical "LIM" when `text` contains one of the four LIM forms, else
 * null (so the caller falls through to its numeric parse).
 *
 * @param {*} text
 * @returns {'LIM' | null}
 */
export function parseLimSlot(text) {
  return isLimForm(text) ? 'LIM' : null;
}
