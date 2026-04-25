// stage6-snapshot-mutators.js
//
// Shared mutation atoms for the Stage 6 agentic-extraction state snapshot.
// Both the LEGACY updateStateSnapshot path (eicr-extraction-session.js) and
// the new Phase 2 tool-call dispatchers MUST call these helpers — any logic
// that mutates stateSnapshot.circuits or session.extractedObservations lives
// here and only here. If it doesn't live here, the two paths WILL drift.
//
// Design:
//  - Every function is pure with respect to the snapshot/session ref it
//    receives. No logging. No WebSocket traffic. No session-level bookkeeping
//    beyond the narrow input shape documented per-function.
//  - Functions either mutate and return void, or mutate and return a small
//    `{ok, error?}` / `{cleared}` / `{id}` envelope so callers can react
//    without re-inspecting the snapshot.
//  - appendObservation OWNS UUID generation (crypto.randomUUID). The caller
//    does not pass an id in. This is deliberate — the dispatcher will surface
//    the returned id to the model in the tool_result envelope so the model
//    can reference it later in delete_observation.
//
// Plan 02-01 §Q4 locks an intentional divergence: record_reading for an
// unknown circuit is auto-created here (applyReadingToSnapshot creates the
// bucket) because the LEGACY path did so at eicr-extraction-session.js:989
// and behaviour must be preserved for the legacy refactor to pass its
// existing tests. Phase 2 dispatchers layer their own existence check on
// TOP of this atom — the strict-mode rejection lives in the dispatcher, not
// here.
//
// See Plan 02-01 for the full rationale; see §Interfaces for the locked
// function signatures that Phase 2 will consume verbatim.

import { randomUUID } from 'node:crypto';

/**
 * Write a reading into stateSnapshot.circuits[circuit][field]. Auto-creates
 * the circuit bucket if missing — LEGACY behaviour. Phase 2 dispatchers MUST
 * validate circuit existence BEFORE calling this helper.
 *
 * @param {{circuits: Object}} snapshot — session.stateSnapshot reference
 * @param {{circuit: number, field: string, value: string}} input
 */
export function applyReadingToSnapshot(snapshot, { circuit, field, value }) {
  if (!snapshot.circuits[circuit]) snapshot.circuits[circuit] = {};
  snapshot.circuits[circuit][field] = value;
}

/**
 * Delete stateSnapshot.circuits[circuit][field]. Noop if circuit missing or
 * field absent on the bucket.
 *
 * @param {{circuits: Object}} snapshot
 * @param {{circuit: number, field: string}} input
 * @returns {{cleared: boolean}}
 */
export function clearReadingInSnapshot(snapshot, { circuit, field }) {
  const bucket = snapshot.circuits?.[circuit];
  if (!bucket || !(field in bucket)) return { cleared: false };
  delete bucket[field];
  return { cleared: true };
}

/**
 * Upsert a circuit bucket with optional meta fields. Used by create_circuit
 * (to seed a new bucket with meta) and by rename_circuit (the meta-update
 * half — caller composes rename + upsert if both are changing). Does NOT
 * rekey — use renameCircuit for that.
 *
 * Null/undefined meta fields are ignored (no key written). This preserves
 * the "leave unchanged" semantics documented on the rename_circuit tool
 * schema — callers pass null when they don't want to touch a meta field.
 *
 * @param {{circuits: Object}} snapshot
 * @param {{circuit_ref: number, designation?: string|null, phase?: string|null,
 *          rating_amps?: number|null, cable_csa_mm2?: number|null}} input
 */
export function upsertCircuitMeta(
  snapshot,
  { circuit_ref, designation, phase, rating_amps, cable_csa_mm2 },
) {
  if (!snapshot.circuits[circuit_ref]) snapshot.circuits[circuit_ref] = {};
  const target = snapshot.circuits[circuit_ref];
  if (designation != null) target.designation = designation;
  if (phase != null) target.phase = phase;
  if (rating_amps != null) target.rating_amps = rating_amps;
  if (cable_csa_mm2 != null) target.cable_csa_mm2 = cable_csa_mm2;
}

/**
 * Rekey a circuit bucket from `from_ref` to `circuit_ref`.
 *
 * Edge cases:
 *  - from_ref === circuit_ref → idempotent noop; returns {ok:true}. Plan
 *    02-01 §Q8 locks this — callers may emit a meta-only rename and we
 *    don't want to force them to choose a different tool.
 *  - from_ref missing in snapshot.circuits → {ok:false, error:source_not_found}.
 *  - target circuit_ref already exists (and is different from from_ref) →
 *    {ok:false, error:target_exists}. NO destructive merge — the caller must
 *    decide what to do (typically ask_user).
 *
 * Mutates in place on success. Does NOT call upsertCircuitMeta — caller
 * composes the two calls if meta is ALSO changing.
 *
 * @param {{circuits: Object}} snapshot
 * @param {{from_ref: number, circuit_ref: number}} input
 * @returns {{ok: true} | {ok: false, error: {code: 'source_not_found'|'target_exists'}}}
 */
export function renameCircuit(snapshot, { from_ref, circuit_ref }) {
  if (from_ref === circuit_ref) return { ok: true };
  if (!snapshot.circuits[from_ref]) {
    return { ok: false, error: { code: 'source_not_found' } };
  }
  if (snapshot.circuits[circuit_ref]) {
    return { ok: false, error: { code: 'target_exists' } };
  }
  snapshot.circuits[circuit_ref] = snapshot.circuits[from_ref];
  delete snapshot.circuits[from_ref];
  return { ok: true };
}

/**
 * Append an observation to session.extractedObservations with a fresh
 * crypto.randomUUID(). The atom owns id generation — callers never pass an
 * id in. Initialises session.extractedObservations if absent.
 *
 * Returns {id} so the dispatcher can surface the new id to the model in the
 * tool_result envelope (Plan 02-04 will consume this).
 *
 * Semantic dedup (e.g. OBSERVATION_CORRECTION_LEAD_IN) is NOT handled here —
 * that is a dispatcher-layer concern and deliberately differs between the
 * legacy path and the tool-call path.
 *
 * @param {{extractedObservations?: Array}} session
 * @param {{code: string, location: string, text: string,
 *          circuit: number|null, suggested_regulation: string|null}} input
 * @returns {{id: string}}
 */
export function appendObservation(
  session,
  { code, location, text, circuit, suggested_regulation },
) {
  const id = randomUUID();
  if (!Array.isArray(session.extractedObservations)) {
    session.extractedObservations = [];
  }
  session.extractedObservations.push({
    id,
    code,
    location,
    text,
    circuit: circuit ?? null,
    suggested_regulation: suggested_regulation ?? null,
  });
  return { id };
}

/**
 * Remove an observation from session.extractedObservations by its id.
 * Returns {ok:true, removed} with the removed object on success, or
 * {ok:false, error:{code:'not_found'}} if no observation with that id
 * exists. Semantic noop handling (duplicate delete, etc.) lives in the
 * dispatcher — the atom simply reports boolean removal.
 *
 * @param {{extractedObservations?: Array}} session
 * @param {{observation_id: string}} input
 * @returns {{ok: true, removed: object} | {ok: false, error: {code: 'not_found'}}}
 */
export function deleteObservation(session, { observation_id }) {
  const arr = Array.isArray(session.extractedObservations)
    ? session.extractedObservations
    : [];
  const idx = arr.findIndex((o) => o.id === observation_id);
  if (idx === -1) return { ok: false, error: { code: 'not_found' } };
  const [removed] = arr.splice(idx, 1);
  return { ok: true, removed };
}
