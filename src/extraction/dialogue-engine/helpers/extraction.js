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
      if (val !== null && val !== undefined) {
        out.push({ field: slot.field, value: val });
      }
    }
  }
  return out;
}

/**
 * Find the next slot that hasn't been written, in declared order.
 * Returns the slot object (not just the field name) so callers can
 * read its question / parser / flags directly.
 *
 * Skips slots flagged `countsTowardCompletion: false`? No — every
 * declared slot needs to be filled before completion. Use cancellation
 * tally separately.
 */
export function nextMissingSlot(values, slots) {
  for (const slot of slots) {
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
