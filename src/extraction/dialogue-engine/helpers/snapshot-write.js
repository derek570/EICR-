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

// P3 (2026-07-23) NOTE — the DIALOGUE-engine LIM writes (active-slot, named
// ring/trip-time, seeded pending_writes) are a documented follow-up for BOTH
// the per-client `lim_ranged_write_v1` capability gate AND the server
// `LIM_RANGED_WRITE_DISABLED` kill-switch. Gating them here (the write choke
// point) drops the snapshot mutation but NOT the extraction-payload wire emit
// the callers still perform, so a partial gate here would be a confusing
// half-cover. The rollout gate + kill-switch fully cover the MODEL-driven paths
// (record_reading + set_field_for_all_circuits + the speculator) — the
// feedback-86 Zs vector; the dialogue scripts write non-Zs OCPD/RCD/ring fields.
// Closing the dialogue paths cleanly needs the round-5 session-threading +
// caller return-value propagation (a bounded follow-up), not a low-level guard.
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
