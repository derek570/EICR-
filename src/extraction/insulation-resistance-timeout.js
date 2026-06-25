/**
 * Insulation resistance timeout — server-side detector for partial IR fills.
 *
 * Mirrors `ring-continuity-timeout.js` but for the IR test family. Where ring
 * has three readings (R1 / Rn / R2) on one set of probes, IR has two readings
 * per circuit (Live-to-Live and Live-to-Earth) plus an optional test voltage
 * default. The companion `insulation-resistance-script.js` drives the
 * deterministic capture flow; this module is the safety net for cases where
 * the script exits with a partial bucket (cancel mid-flow, topic switch
 * before completion, hard timeout).
 *
 * Lifecycle:
 *   - On every successful record_reading on `ir_live_live_mohm` or
 *     `ir_live_earth_mohm`, the dispatcher calls `recordIrWrite` to stamp
 *     the circuit's last-write timestamp.
 *   - On every user turn, before invoking Sonnet, sonnet-stream.js calls
 *     `findExpiredPartial`. If a circuit has 1 of the 2 IR readings filled
 *     AND >60s have elapsed since its last write, the function returns the
 *     missing field; the caller then emits a server-driven ask_user with
 *     `context_field` and `context_circuit` set so the existing answer-
 *     resolver value-resolves the user's spoken value back into the
 *     missing slot.
 *
 * State: a Map<circuit_ref, last-write-ms-epoch> attached to
 * `session.insulationResistanceState`. Cleared per-circuit when the bucket
 * is full (2 of 2) or when the ask is auto-resolved.
 */

export const IR_FIELDS = ['ir_live_live_mohm', 'ir_live_earth_mohm'];

// M4 (2026-06-25): the test voltage slot. Deliberately NOT in IR_FIELDS —
// IR_FIELDS is the canonical 2-reading LL/LE set wired into the schema's
// onWrite/filledCount===2-means-complete semantics; adding voltage would break
// the partial-fill detection. Voltage recovery rides its own carrier below.
export const VOLTAGE_FIELD = 'ir_test_voltage_v';

// M4 decision (user-confirmed 2026-06-25): 60s → 30s. Governs the LL/LE
// partial-fill net (and, indirectly, how stale a circuit must be before the
// voltage carrier note fires). The in-script 30s voltage re-ask in the
// dialogue engine uses its own threshold and is NOT governed by this constant.
export const INSULATION_RESISTANCE_TIMEOUT_MS = 30_000;

const FIELD_LABELS = {
  ir_live_live_mohm: 'live-to-live',
  ir_live_earth_mohm: 'live-to-earth',
};

/**
 * Stamp a circuit's last-IR-write timestamp. Idempotent — called once per
 * successful record_reading on an IR field.
 */
export function recordIrWrite(session, circuit_ref, now = Date.now()) {
  if (!session) return;
  if (!session.insulationResistanceState) session.insulationResistanceState = new Map();
  session.insulationResistanceState.set(circuit_ref, now);
}

/**
 * Drop a circuit's tracking state. Called when the bucket fills (2 of 2) or
 * when an external event makes the entry stale. Safe on a never-tracked ref.
 */
export function clearIrState(session, circuit_ref) {
  if (!session?.insulationResistanceState) return;
  session.insulationResistanceState.delete(circuit_ref);
}

/**
 * Return the IR field values currently set on a circuit. Tolerant of the
 * snapshot schema variations (`circuits` as Object<ref, fields> or
 * Array<{circuit_ref, ...fields}>).
 */
function inspectCircuitFills(stateSnapshot, circuit_ref) {
  const filled = { ir_live_live_mohm: false, ir_live_earth_mohm: false };
  if (!stateSnapshot) return filled;

  let bucket = null;
  const circuits = stateSnapshot.circuits;
  if (circuits && typeof circuits === 'object' && !Array.isArray(circuits)) {
    bucket = circuits[circuit_ref] || circuits[String(circuit_ref)] || null;
  } else if (Array.isArray(circuits)) {
    bucket = circuits.find((c) => c && Number(c.circuit_ref) === Number(circuit_ref)) || null;
  }
  if (!bucket) return filled;

  for (const f of IR_FIELDS) {
    const v = bucket[f];
    if (v !== undefined && v !== null && v !== '') filled[f] = true;
  }
  return filled;
}

/**
 * Find the oldest partially-filled IR bucket whose last write is older than
 * the timeout window. Returns null if none.
 *
 * "Partial" = exactly 1 of the 2 IR fields is filled. A bucket with 0 (never
 * started) or 2 (complete) is not partial and gets pruned.
 */
export function findExpiredPartial(session, now = Date.now()) {
  if (!session?.insulationResistanceState || session.insulationResistanceState.size === 0) {
    return null;
  }

  let oldest = null;
  const keys = Array.from(session.insulationResistanceState.keys());
  for (const circuit_ref of keys) {
    const lastWrite = session.insulationResistanceState.get(circuit_ref);
    if (typeof lastWrite !== 'number') {
      session.insulationResistanceState.delete(circuit_ref);
      continue;
    }
    const fills = inspectCircuitFills(session.stateSnapshot, circuit_ref);
    const filledCount = IR_FIELDS.filter((f) => fills[f]).length;

    if (filledCount === 0 || filledCount === 2) {
      session.insulationResistanceState.delete(circuit_ref);
      continue;
    }

    if (now - lastWrite < INSULATION_RESISTANCE_TIMEOUT_MS) continue;

    if (!oldest || lastWrite < oldest.last_write_ms) {
      const missing_field = IR_FIELDS.find((f) => !fills[f]);
      oldest = { circuit_ref, missing_field, last_write_ms: lastWrite };
    }
  }
  return oldest;
}

/**
 * Build the ask_user payload for a missing IR value. Server-side construct
 * — caller registers in `entry.pendingAsks` and emits `ask_user_started`.
 */
export function buildAskForMissingIrValue(expiry, sessionId, now = Date.now()) {
  const { circuit_ref, missing_field } = expiry;
  const label = FIELD_LABELS[missing_field] ?? missing_field;
  return {
    tool_call_id: `srv-ir-${sessionId}-${circuit_ref}-${now}`,
    question: `I seem to have missed an insulation resistance value — what's the ${label} for circuit ${circuit_ref}?`,
    reason: 'missing_value',
    context_field: missing_field,
    context_circuit: circuit_ref,
    expected_answer_shape: 'value',
    server_emitted: true,
  };
}

// ─── M4: voltage re-ask carrier (2026-06-25, field session 6674E8C5) ───
// When the IR script captures LL+LE but exits the voltage phase before a test
// voltage is given — because the inspector dictated a FRESH reading (escape
// hatch) or switched topic — the circuit is left with both readings filled and
// voltage empty. findExpiredPartial PRUNES filledCount===2 circuits, so this
// case needs its own carrier. The dialogue engine pushes the prior circuit onto
// `session.pendingVoltageReask` before finishing; sonnet-stream drains it AFTER
// the IR-script early return (i.e. only when no script is active) and prepends a
// voltage server-note → Sonnet ask_user → pendingAsks → answer resolver. Doing
// it post-script (next eligible turn) avoids a concurrent-ask conflict with a
// fresh walk-through started by the interrupting reading.

/**
 * Record a pending voltage re-ask for a circuit. De-duped by circuit_ref.
 */
export function recordVoltageReask(session, circuit_ref, board_id = null) {
  if (!session || circuit_ref == null) return;
  if (!Array.isArray(session.pendingVoltageReask)) session.pendingVoltageReask = [];
  if (session.pendingVoltageReask.some((e) => e.circuit_ref === circuit_ref)) return;
  session.pendingVoltageReask.push({ circuit_ref, board_id });
}

function circuitHasVoltage(stateSnapshot, circuit_ref) {
  if (!stateSnapshot) return false;
  let bucket = null;
  const circuits = stateSnapshot.circuits;
  if (circuits && typeof circuits === 'object' && !Array.isArray(circuits)) {
    bucket = circuits[circuit_ref] || circuits[String(circuit_ref)] || null;
  } else if (Array.isArray(circuits)) {
    bucket = circuits.find((c) => c && Number(c.circuit_ref) === Number(circuit_ref)) || null;
  }
  if (!bucket) return false;
  const v = bucket[VOLTAGE_FIELD];
  return v !== undefined && v !== null && v !== '';
}

/**
 * Pop the next pending voltage re-ask whose circuit STILL lacks a voltage.
 * Circuits that have since received a voltage are silently dropped. Returns
 * `{ circuit_ref, missing_field, board_id }` or null.
 */
export function drainExpiredVoltage(session) {
  if (!Array.isArray(session?.pendingVoltageReask) || session.pendingVoltageReask.length === 0) {
    return null;
  }
  while (session.pendingVoltageReask.length > 0) {
    const entry = session.pendingVoltageReask.shift();
    if (entry && !circuitHasVoltage(session.stateSnapshot, entry.circuit_ref)) {
      return {
        circuit_ref: entry.circuit_ref,
        missing_field: VOLTAGE_FIELD,
        board_id: entry.board_id ?? null,
      };
    }
  }
  return null;
}
