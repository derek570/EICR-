/**
 * Slot-derivation processor — runs after every write and:
 *
 *   - Applies `sets: { field: value, ... }` side effects (e.g.,
 *     "BS 3036" filling implies ocpd_type = "Rew" so the inspector
 *     isn't asked again for something the BS code uniquely
 *     determines).
 *   - Applies `mirrors: ['otherField', ...]` — copy the slot's
 *     value to additional canonical fields on the snapshot. Used
 *     for the RCBO BS code, which is the same value on both
 *     ocpd_bs_en and rcd_bs_en columns by convention.
 *   - Reports a `pivot: 'schemaName'` request — caller schedules
 *     the schema transition; this helper does NOT mutate the
 *     active script state, only reports the intent.
 *
 * Each slot's `derivations` is an array of objects of shape:
 *   { value?, sets?, mirrors?, pivot? }
 *
 * `value` is the literal canonical value the parser produced (the
 * BS code parser returns "BS EN 61009"; downstream we compare via
 * `bsCodeDigits` so the matcher accepts either the full-prefixed
 * or bare-digit form). For other slot kinds (curve letters, RCD
 * types) the match is a direct string equality. Omitting `value`
 * makes the derivation unconditional — fires on every write.
 */
import { applyReadingToSnapshot } from '../../stage6-snapshot-mutators.js';
import { bsCodeDigits } from '../parsers/bs-code.js';

/**
 * Test whether a derivation's `value` matches what was actually
 * written to the slot. For BS-code slots we compare the digit
 * suffix (so "BS EN 61009" derivation matches written value
 * "BS EN 61009"); other slots compare canonical string.
 *
 * 2026-05-31: a derivation with `value` omitted (or explicitly
 * `undefined`) is treated as ALWAYS matching. Use case: the RCBO
 * schema mirrors `ocpd_bs_en` to `rcd_bs_en` regardless of which
 * BS code the inspector dictates — for an RCBO, by convention both
 * columns carry the same value, and gating the mirror on a single
 * literal ("61009") created a duplicate-prompt bug when the
 * inspector entered any other code (session E8C6B716, 2026-05-31:
 * inspector entered "61008" for `ocpd_bs_en`, mirror skipped, then
 * heard the identical "What's the BS number?" prompt for `rcd_bs_en`
 * and reasonably concluded the system had lost the answer).
 * Existing literal-value derivations are unaffected — every
 * in-tree derivation specifies `value`, so the new branch is dead
 * code for them.
 */
function derivationMatches(derivation, writtenValue, slotKind) {
  if (derivation.value === undefined) return true;
  if (slotKind === 'bs_code') {
    const digits = bsCodeDigits(writtenValue);
    return digits === derivation.value;
  }
  return writtenValue === derivation.value;
}

/**
 * @returns {{ pivotTo: string | null }} — caller acts on the pivot.
 */
export function applyDerivations({ session, schema, slot, value }) {
  const result = { pivotTo: null };
  if (!Array.isArray(slot.derivations)) return result;

  for (const derivation of slot.derivations) {
    if (!derivationMatches(derivation, value, slot.kind)) continue;

    // sets: { field: value, … } — additional canonical-field writes.
    if (derivation.sets && typeof derivation.sets === 'object') {
      const state = session.dialogueScriptState;
      for (const [extraField, extraValue] of Object.entries(derivation.sets)) {
        applyReadingToSnapshot(session.stateSnapshot, {
          circuit: state?.circuit_ref ?? null,
          field: extraField,
          value: extraValue,
        });
        // Also reflect into the live state.values so the next
        // nextMissingSlot iteration sees it filled.
        if (state) state.values[extraField] = extraValue;
      }
    }

    // mirrors: ['otherField', …] — copy slot's own value into
    // additional canonical fields (e.g. RCBO BS code).
    if (Array.isArray(derivation.mirrors)) {
      const state = session.dialogueScriptState;
      for (const mirrorField of derivation.mirrors) {
        applyReadingToSnapshot(session.stateSnapshot, {
          circuit: state?.circuit_ref ?? null,
          field: mirrorField,
          value,
        });
        if (state) state.values[mirrorField] = value;
      }
    }

    // pivot: 'schemaName' — schema transition request.
    if (typeof derivation.pivot === 'string') {
      result.pivotTo = derivation.pivot;
    }
  }

  return result;
}
