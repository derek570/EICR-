/**
 * Stage 6 Phase 2 Plan 02-02 — Pure validators for the six write tools.
 *
 * WHAT: Six pure functions mapping (input, snapshot | session) → null | {code, field?}.
 * They are pre-mutation gates: the dispatcher calls the validator first, and
 * only proceeds to state mutation + success logging if the validator returned
 * null. Rejection envelopes are logged with outcome:'rejected' by the
 * dispatcher.
 *
 * WHY pure (no mutation, no logging, no async):
 *   - Testability: unit tests construct a plain snapshot literal, no mocks.
 *   - Composability: the shadow comparator (Plan 02-06) replays these
 *     validators to predict what the legacy path would have accepted vs
 *     rejected — that only works if the validator is a pure function of
 *     (input, state).
 *   - Clarity: a validator that also logs hides rejections from the
 *     dispatcher's log row — the dispatcher owns logging, full stop.
 *
 * Validation-code namespace (must stay bounded — Phase 7 analyzer groups by
 * these codes; unbounded string space = broken dashboards):
 *   circuit_not_found       — record_reading / clear_reading / rename_circuit
 *                             references a circuit not in snapshot.circuits.
 *   circuit_already_exists  — create_circuit on an existing circuit_ref.
 *   source_not_found        — rename_circuit.from_ref not in snapshot.circuits.
 *   target_exists           — rename_circuit.circuit_ref already exists and
 *                             differs from from_ref (would overwrite).
 *   invalid_type            — numeric meta arrived as string (Pitfall #5).
 *                             strict:true catches this at the API boundary,
 *                             but we defend locally too.
 *   unknown_tool            — emitted by createWriteDispatcher (not here).
 *
 * BLOCK-2 (NOT in this namespace): 'observation_not_found'. An attempt to
 * delete an unknown observation is semantically a noop — the post-state
 * already satisfies the request. `validateDeleteObservation` returns null
 * always; `dispatchDeleteObservation` (Plan 02-04) handles the absence case
 * by returning {ok:true, noop:true, reason:'observation_not_found'} with
 * is_error:false. Research §Q8.
 */

/**
 * record_reading: circuit must exist.
 */
export function validateRecordReading(input, snapshot) {
  if (!(input.circuit in snapshot.circuits)) {
    return { code: 'circuit_not_found', field: 'circuit' };
  }
  return null;
}

/**
 * clear_reading: circuit must exist. `field_not_set` (the field is not
 * currently populated on that circuit) is NOT a validator rejection — it is
 * a dispatcher-level noop path returning {ok:true, noop:true} per Research
 * §Q8.
 */
export function validateClearReading(input, snapshot) {
  if (!(input.circuit in snapshot.circuits)) {
    return { code: 'circuit_not_found', field: 'circuit' };
  }
  return null;
}

/**
 * create_circuit: circuit_ref must be new; numeric meta must be numeric.
 */
export function validateCreateCircuit(input, snapshot) {
  if (input.circuit_ref in snapshot.circuits) {
    return { code: 'circuit_already_exists', field: 'circuit_ref' };
  }
  if (input.rating_amps != null && typeof input.rating_amps !== 'number') {
    return { code: 'invalid_type', field: 'rating_amps' };
  }
  if (input.cable_csa_mm2 != null && typeof input.cable_csa_mm2 !== 'number') {
    return { code: 'invalid_type', field: 'cable_csa_mm2' };
  }
  return null;
}

/**
 * rename_circuit: source must exist; target must not collide (unless same as
 * source — a "rename to self" is a permitted noop). Numeric meta must be
 * numeric.
 */
export function validateRenameCircuit(input, snapshot) {
  if (!(input.from_ref in snapshot.circuits)) {
    return { code: 'source_not_found', field: 'from_ref' };
  }
  if (input.from_ref !== input.circuit_ref && input.circuit_ref in snapshot.circuits) {
    return { code: 'target_exists', field: 'circuit_ref' };
  }
  if (input.rating_amps != null && typeof input.rating_amps !== 'number') {
    return { code: 'invalid_type', field: 'rating_amps' };
  }
  if (input.cable_csa_mm2 != null && typeof input.cable_csa_mm2 !== 'number') {
    return { code: 'invalid_type', field: 'cable_csa_mm2' };
  }
  return null;
}

/**
 * record_observation: no preconditions. Enum validation (code) is strict:true
 * at the API layer; Plan 02-04 dispatcher adds a belt-and-braces local check
 * before mutation.
 */
// eslint-disable-next-line no-unused-vars
export function validateRecordObservation(_input, _session) {
  return null;
}

/**
 * delete_observation: ALWAYS valid (BLOCK-2 contract).
 *
 * Absence of the target observation is NOT a validator rejection. It is a
 * dispatcher-level noop outcome per Research §Q8. The dispatcher in Plan
 * 02-04 is responsible for detecting the absence and returning
 *   {ok: true, noop: true, reason: 'observation_not_found'}
 * with is_error:false. This preserves the invariant that validators only
 * reject inputs the dispatcher cannot meaningfully process — a delete of an
 * unknown id IS meaningful (the post-state already satisfies the request,
 * so the correct answer is "noop").
 */
// eslint-disable-next-line no-unused-vars
export function validateDeleteObservation(_input, _session) {
  return null;
}
