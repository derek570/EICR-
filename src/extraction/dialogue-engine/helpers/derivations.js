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
 *   { value, sets?, mirrors?, pivot? }
 *
 * `value` is the literal canonical value the parser produced (the
 * BS code parser returns "BS EN 61009"; downstream we compare via
 * `bsCodeDigits` so the matcher accepts either the full-prefixed
 * or bare-digit form). For other slot kinds (curve letters, RCD
 * types) the match is a direct string equality.
 */
import { applyReadingToSnapshot } from '../../stage6-snapshot-mutators.js';
import { bsCodeDigits } from '../parsers/bs-code.js';

/**
 * Test whether a derivation's `value` matches what was actually
 * written to the slot. For BS-code slots we compare the digit
 * suffix (so "BS EN 61009" derivation matches written value
 * "BS EN 61009"); other slots compare canonical string.
 */
function derivationMatches(derivation, writtenValue, slotKind) {
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
