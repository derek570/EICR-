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
    if (!m) continue;
    // Audit-2026-06-02 Phase 4 — read the first non-null capture group
    // so a slot regex can use multiple alternations with different
    // value-capture positions without contortions. Backward-compatible:
    // existing single-group regexes (ring r1, IR L-L, ocpd_type, etc.)
    // still take m[1] because m[2] / m[3] are undefined for them.
    //
    // Why: the rcd_type slot in rcbo.js + rcd.js needs anchored
    // alternations to stop "Type B" in an RCBO walkthrough from
    // false-matching `rcd_type` via the bare-letter `[AFB]` set
    // (same letter is in the OCPD curve enum). The cleanest
    // tightening uses three alternations with the value capture in
    // three different positions; Codex Pass 4 caught that the
    // pre-Phase-4 helper only ever read m[1] so multi-group regexes
    // would silently fail.
    const captured = m[1] ?? m[2] ?? m[3];
    if (captured === undefined) continue;
    const val = slot.parser(captured);
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
 *
 * `volunteeredOnly: true` slots (RCD trip time, 2026-05-21) are also
 * skipped — they're harvested from the entry utterance via
 * extractNamedFieldValues but never asked for via TTS. They behave
 * like "always done" from nextMissingSlot's perspective.
 */
export function nextMissingSlot(values, slots, skippedSet, deferredSet) {
  for (const slot of slots) {
    if (slot.volunteeredOnly) continue;
    if (skippedSet?.has?.(slot.field)) continue;
    // PLAN-backend-final.md Phase 6.2 — per-session deferred-slot
    // memory survives script lifecycle (state.skipped_slots is cleared
    // every clearScriptState). Same iteration behaviour as
    // skippedSet — treat the slot as "done" so the script moves past
    // it on re-entry. The volunteered-write path clears the entry so
    // a deliberate override ("the BS code is 60898") still asks /
    // resolves through the normal slot machinery.
    if (deferredSet?.has?.(slot.field)) continue;
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
