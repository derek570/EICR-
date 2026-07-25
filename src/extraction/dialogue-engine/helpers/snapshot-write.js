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
import { clampReadingForDispatch, resolveBoardAwareEarthing } from '../../impedance-clamp.js';
import { canonicaliseNumericReadingField } from '../../value-enum-validator.js';
import { applyReadingToSnapshot } from '../../stage6-snapshot-mutators.js';
import { recordValueCorrection } from './value-corrections.js';

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
/**
 * Plan D Seam B (2026-07-25, feedback id 100(b), session C06B9904).
 *
 * `applyWrite` is now the dialogue engine's AUTHORITATIVE impedance clamp: it
 * clamps the value, writes the CLAMPED value everywhere it writes, records the
 * correction provenance in the state-scoped store, and RETURNS the effective
 * value so callers stop emitting their own raw copy.
 *
 * Why the return value is mandatory, not a nicety: before this change every
 * caller kept its own local `value` and pushed THAT into the array it hands to
 * `buildExtractionPayload`. Clamping the snapshot alone would leave the frame
 * carrying 16 while the snapshot held 1.6 — the split-brain merely relocated
 * from stored-vs-spoken to stored-vs-DISPLAYED, with the client writing 16 into
 * the cell. Every one of the engine's `applyWrite` invocations must therefore
 * use the returned value for its `state.values` assignment, its
 * writes/wireWrites/overwrites entry, any derivation input, and its log row.
 *
 * The correction goes to a state-scoped store rather than out through the
 * return value because the write turn and the speech turn are different turns —
 * see helpers/value-corrections.js.
 *
 * @returns {{value:*, correction:{original:*,corrected:*,divisor:number}|null}}
 */
export function applyWrite(session, schema, circuit_ref, field, value, now) {
  // Canonical field name: the clamp sets are keyed canonically, so a dialogue
  // alias (rcd_trip_time, r1_r2) must be translated before the lookup or an
  // impedance slot would silently skip the clamp.
  const canonicalField = canonicaliseNumericReadingField(field);
  const clamped = clampReadingForDispatch({
    field: canonicalField,
    value,
    // Board-aware: a sub-board on a TT rod has a different band from a TN-C-S
    // origin. Resolved per write, exactly as the Stage-6 dispatchers do, so the
    // engine and the dispatchers can never disagree about the band. Dialogue
    // scripts are circuit-scoped on the current board, hence a null board id.
    earthing: resolveBoardAwareEarthing(session?.stateSnapshot, null),
  });
  const effective = clamped.value;

  applyReadingToSnapshot(session.stateSnapshot, {
    circuit: circuit_ref,
    field,
    value: effective,
  });
  const state = session.dialogueScriptState;
  if (state && state.schemaName === schema.name) {
    state.values[field] = effective;
    state.last_turn_at = now;
    // Called UNCONDITIONALLY — a null correction retires any previous
    // provenance for this slot (lifecycle rule 1). Skipping the null case is
    // what would let a stale correction clause reappear on a later,
    // uncorrected read-back of the same slot.
    recordValueCorrection(state, field, clamped.correction);
  }
  if (typeof schema.onWrite === 'function') {
    schema.onWrite(session, circuit_ref, now);
  }
  return { value: effective, correction: clamped.correction };
}
