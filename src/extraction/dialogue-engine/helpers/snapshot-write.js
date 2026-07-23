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
import {
  isCapabilityGatedLimWrite,
  canonicaliseNumericReadingField,
} from '../../value-enum-validator.js';
import { isLimRangedWriteKilled } from '../../voice-latency-config.js';

export function applyWrite(session, schema, circuit_ref, field, value, now) {
  // P3 Fix 8 — the SERVER kill-switch (LIM_RANGED_WRITE_DISABLED) is the
  // rollback boundary and must cover EVERY dialogue LIM write (active-slot,
  // named ring/trip-time, seeded drain) — the single choke point every dialogue
  // write funnels through. When the switch is on, a canonical LIM on a
  // capability-gated numeric reading field is dropped (not written), so a
  // rollback denies dialogue LIM too. The IR fields stay exempt (pre-P3
  // behaviour) via isCapabilityGatedLimWrite. (The per-CLIENT capability gate
  // for the dialogue paths remains a documented follow-up — the round-5
  // session-threading item; the model-driven Zs vector is fully capability-gated.)
  if (
    isLimRangedWriteKilled() &&
    isCapabilityGatedLimWrite(canonicaliseNumericReadingField(field), value)
  ) {
    return;
  }
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
