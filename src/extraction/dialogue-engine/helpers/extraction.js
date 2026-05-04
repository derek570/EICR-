/**
 * Generic named-field extraction. Replaces the per-script
 * extractNamedFieldValues — instead of hardcoding the field/regex pairs,
 * it iterates over a slot list and uses each slot's `triggerPhrases` +
 * `parser`.
 *
 * Each slot entry contributes a regex of the shape:
 *
 *   /\b(<triggerPhrase1>|<triggerPhrase2>|...)\b<separators>?(<valueGroup>)/i
 *
 * with `valueGroup` declared on the slot (or defaulting to a generic
 * decimal-with-leading-zero shape). The captured group is fed through
 * the slot's `parser` to canonicalise.
 *
 * Returns an ordered array of {field, value} for every match. Callers
 * dedupe / skip-already-filled themselves.
 */
export function extractNamedFieldValues(text, slots) {
  if (typeof text !== 'string' || !text || !Array.isArray(slots)) return [];
  const out = [];
  for (const slot of slots) {
    if (!slot.namedExtractor) continue;
    const m = text.match(slot.namedExtractor);
    if (m && m[1] !== undefined) {
      const val = slot.parser(m[1]);
      if (val === null || val === undefined) continue;
      // 2026-05-04 (field test 07635782 follow-up): per-slot allowed-value
      // gate. Same semantics as the engine's bare-value gate — out-of-set
      // values are dropped here (named extraction won't write the field)
      // so the engine re-asks the slot. Without this guard a named-form
      // mistranscription ("66 kA") would slip through the named path
      // even when the bare-value path would catch it.
      if (Array.isArray(slot.allowedValues) && !slot.allowedValues.includes(val)) {
        continue;
      }
      out.push({ field: slot.field, value: val });
    }
  }
  return out;
}

/**
 * Find the next slot that hasn't been written, in declared order.
 * Returns the slot object (not just the field name) so callers can
 * read its question / parser / flags directly.
 *
 * `skippedSet` — optional Set of slot field names that the inspector
 * has explicitly skipped via a per-slot skip verb ("don't know",
 * "skip that"). Skipped slots are treated as "done" for iteration
 * purposes so the script moves past them. PR2 OCPD/RCD/RCBO use
 * this; ring/IR pass undefined and behave as before.
 */
export function nextMissingSlot(values, slots, skippedSet) {
  for (const slot of slots) {
    if (skippedSet?.has?.(slot.field)) continue;
    const v = values[slot.field];
    if (v === undefined || v === null || v === '') return slot;
  }
  return null;
}

/**
 * Count how many of the cancellation-tally slots are filled. Used to
 * format the "N of M saved" cancel message. Voltage in IR is excluded
 * via `countsTowardCancelTally: false`.
 */
export function countFilledForCancel(values, slots) {
  let filled = 0;
  let total = 0;
  for (const slot of slots) {
    if (slot.countsTowardCancelTally === false) continue;
    total += 1;
    const v = values[slot.field];
    if (v !== undefined && v !== null && v !== '') filled += 1;
  }
  return { filled, total };
}
