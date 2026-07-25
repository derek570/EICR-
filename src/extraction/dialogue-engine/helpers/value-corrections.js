/**
 * Plan D (2026-07-25, feedback id 100(b), session C06B9904) — the state-scoped
 * impedance-correction transport for the dialogue engine.
 *
 * WHY A STORE AND NOT A RETURN VALUE
 * The dialogue engine writes a value on one turn and SPEAKS it on a later one.
 * `applyWrite` mutates `session.stateSnapshot` + `state.values`; the audible
 * line comes from `finishScript` / `buildScriptInfo` / the ring schema's
 * `confirmation.buildMessage`, which read back out of `state.values` on a
 * subsequent turn. A per-call return value therefore has no consumer on the
 * path that actually speaks, so the `16 → 1.6` provenance has to live
 * ALONGSIDE the value it describes — same lifetime, same slot identity, same
 * object that gets discarded when the script ends.
 *
 * SLOT IDENTITY
 * Keyed by `field` only, exactly matching `state.values`. The dialogue state is
 * per-script-episode and carries a single `circuit_ref`, so field-granularity
 * inside the state IS circuit-granularity — adding the ref to the key would
 * make the two maps disagree about what a slot is.
 *
 * LIFECYCLE (all three clears are contractual, see §4.7)
 *   1. Overwritten by a later UNCORRECTED write → `record()` with a null
 *      correction DELETES the entry. This is why every write must call
 *      `record()`, not just the corrected ones: skipping the null case leaves a
 *      stale "I corrected 16 to 1.6" clause to reappear on an unrelated
 *      read-back of the same slot.
 *   2. Slot cleared → `clear()`.
 *   3. Script cancelled / abandoned / re-entered → the whole `state` object is
 *      replaced by `initScriptState`, which takes the map with it.
 *
 * EXACTLY ONCE (Audio-First #1)
 * `consume()` is read-and-delete. The clause is spoken on the FIRST read-back
 * that carries the value and never again on a later re-read of the same slot —
 * a two-read-back sequence must produce one clause, not two. Speech paths use
 * `consume()`; anything merely inspecting state uses `peek()`.
 */

/**
 * Record (or clear) the correction for a slot.
 *
 * @param {object|null|undefined} state — session.dialogueScriptState
 * @param {string} field
 * @param {{original:*, corrected:*, divisor:number}|null|undefined} correction
 */
export function recordValueCorrection(state, field, correction) {
  if (!state || typeof field !== 'string' || field === '') return;
  if (!correction) {
    // Lifecycle rule 1 — an uncorrected write RETIRES the previous provenance.
    if (state.valueCorrections) delete state.valueCorrections[field];
    return;
  }
  if (!state.valueCorrections) state.valueCorrections = {};
  state.valueCorrections[field] = correction;
}

/**
 * Read the correction for a slot WITHOUT retiring it. For guards / telemetry /
 * tests — never for a speech path (that would break exactly-once).
 *
 * @returns {{original:*, corrected:*, divisor:number}|null}
 */
export function peekValueCorrection(state, field) {
  if (!state?.valueCorrections || typeof field !== 'string') return null;
  return state.valueCorrections[field] ?? null;
}

/**
 * Read AND retire the correction for a slot. This is the speech-path accessor:
 * calling it is what guarantees the clause is spoken exactly once.
 *
 * @returns {{original:*, corrected:*, divisor:number}|null}
 */
export function consumeValueCorrection(state, field) {
  const correction = peekValueCorrection(state, field);
  if (correction !== null) delete state.valueCorrections[field];
  return correction;
}

/**
 * Explicitly clear a slot's correction (lifecycle rule 2 — the slot itself was
 * cleared, so its provenance is meaningless).
 */
export function clearValueCorrection(state, field) {
  if (!state?.valueCorrections || typeof field !== 'string') return;
  delete state.valueCorrections[field];
}
