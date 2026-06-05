/**
 * Write a script-driven value to the session's stateSnapshot, the active
 * dialogue script's local values map, and the corresponding 60s timeout
 * module's per-circuit timestamp.
 *
 * Each schema declares an `onWrite(session, circuit_ref, now)` hook
 * which is the timeout-module sync point. The engine treats it as
 * optional — a schema with no associated timeout module just omits the
 * hook.
 */
import { applyReadingToSnapshot } from '../../stage6-snapshot-mutators.js';

export function applyWrite(session, schema, circuit_ref, field, value, now) {
  applyReadingToSnapshot(session.stateSnapshot, {
    circuit: circuit_ref,
    field,
    value,
  });
  const state = session.dialogueScriptState;
  if (state && state.schemaName === schema.name) {
    state.values[field] = value;
    state.last_turn_at = now;
  }
  if (typeof schema.onWrite === 'function') {
    schema.onWrite(session, circuit_ref, now);
  }
}
