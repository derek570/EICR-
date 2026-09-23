/**
 * PLAN-A (feedback-2026-09-17) — WHICH FIELDS THIS EPISODE OWNS.
 *
 * Zero-import leaf. One rule, two readers, so they can never disagree:
 *
 *  - `buildHandoffNote` excludes owned fields from `existing_values`, because
 *    the directive tells the model it may clear what the walk recorded and must
 *    never clear what was already on the certificate. A field in both lists is
 *    two contradictory instructions about one value.
 *  - `applyDerivations` asks the same question BEFORE it overwrites a target,
 *    to decide whether the value it is about to replace is pre-existing
 *    certificate data worth remembering.
 *
 * The second reader is why this is a module and not a local Set. Asking the
 * question in two places with two copies of the predicate is the failure this
 * plan has already made three times: the copy stays green while production
 * changes underneath it.
 *
 * Ownership is `applied` operations on THIS episode's circuit, plus the targets
 * those operations derived. The circuit filter is load-bearing — a
 * scope-conflict replacement carries the prior operation list across a circuit
 * change, so a filter on `applied` alone would claim an old circuit's field.
 */

/**
 * @param {object|null} state — `session.dialogueScriptState`
 * @returns {Set<string>} every field this episode is responsible for
 */
export function episodeOwnedFields(state) {
  const owned = new Set();
  const operations = Array.isArray(state?.operations) ? state.operations : [];
  const circuit_ref = state?.circuit_ref ?? null;
  for (const op of operations) {
    if (op.disposition !== 'applied') continue;
    if (op.effective_circuit_ref !== circuit_ref) continue;
    owned.add(op.field);
    if (Array.isArray(op.derived)) {
      for (const target of op.derived) owned.add(target);
    }
  }
  return owned;
}

/**
 * Remember what a derivation is about to overwrite, when that value predates
 * the episode.
 *
 * Only the FIRST replacement of a field is recorded: a second derivation on the
 * same target replaces a value this episode already created, and the baseline
 * that matters is the one the certificate carried before any of it.
 *
 * @param {object|null} state
 * @param {string} field   — the derivation's target
 * @param {*} previous     — the target's value immediately before the write
 */
export function recordDerivedBaseline(state, field, previous) {
  if (!state || !field) return;
  if (previous === undefined || previous === null || previous === '') return;
  if (episodeOwnedFields(state).has(field)) return;
  if (!state.derivedBaselines || typeof state.derivedBaselines !== 'object') {
    state.derivedBaselines = {};
  }
  if (Object.prototype.hasOwnProperty.call(state.derivedBaselines, field)) return;
  state.derivedBaselines[field] = previous;
}
