/**
 * Ring continuity timeout — server-side detector for partial ring fills.
 *
 * Background — 2026-04-28: ring continuity is the only EICR test family
 * that legitimately spans multiple Flux turns (the inspector physically
 * repositions probes between r1, rn, r2 readings; pauses of 10-30s are
 * normal). The agentic prompt instructs Sonnet to carry the circuit
 * forward across turns, but Sonnet has no reliable way to track elapsed
 * time, so the prompt explicitly delegates the 60-second timeout to
 * the server. This module is that timeout.
 *
 * Lifecycle:
 *   - On every successful record_reading on `ring_r1_ohm`, `ring_rn_ohm`,
 *     or `ring_r2_ohm`, the dispatcher calls `recordRingContinuityWrite`
 *     to stamp the circuit's last-write timestamp.
 *   - On every user turn, before invoking Sonnet, the per-turn flow in
 *     sonnet-stream.js calls `findExpiredPartial`. If a circuit has 1
 *     or 2 of the 3 ring fields filled AND >60s have elapsed since its
 *     last write, the function returns the missing field; the caller
 *     then emits a server-driven ask_user with `context_field` and
 *     `context_circuit` set so the existing answer-resolver value-resolves
 *     the user's spoken value back into the missing slot.
 *
 * State: a Map<circuit_ref, last-write-ms-epoch> attached to
 * `session.ringContinuityState`. Cleared per-circuit when the bucket
 * is full (3 of 3) or when the ask is auto-resolved.
 */

export const RING_FIELDS = ['ring_r1_ohm', 'ring_rn_ohm', 'ring_r2_ohm'];

export const RING_CONTINUITY_TIMEOUT_MS = 60_000;

const FIELD_LABELS = {
  ring_r1_ohm: 'R1 (lives)',
  ring_rn_ohm: 'Rn (neutrals)',
  ring_r2_ohm: 'R2 (earths)',
};

/**
 * Stamp a circuit's last-ring-write timestamp. Idempotent — called once
 * per successful record_reading on a ring continuity field.
 *
 * @param {object} session  EICRExtractionSession instance.
 * @param {number} circuit_ref
 * @param {number} [now]  Override for test determinism.
 */
export function recordRingContinuityWrite(session, circuit_ref, now = Date.now()) {
  if (!session) return;
  if (!session.ringContinuityState) session.ringContinuityState = new Map();
  session.ringContinuityState.set(circuit_ref, now);
}

/**
 * Drop a circuit's tracking state. Called when the bucket fills (3 of
 * 3) or when an external event (manual clear, circuit delete) makes
 * the entry stale. Safe to call on a never-tracked circuit_ref.
 *
 * @param {object} session
 * @param {number} circuit_ref
 */
export function clearRingContinuityState(session, circuit_ref) {
  if (!session?.ringContinuityState) return;
  session.ringContinuityState.delete(circuit_ref);
}

/**
 * Return the field values currently set on a given circuit. Tolerant of
 * the snapshot schema variations (`circuits` as Object<ref, fields> or
 * Array<{circuit_ref, ...fields}>). Returns an object mapping ring
 * field names → boolean (filled or not).
 *
 * @param {object} stateSnapshot
 * @param {number} circuit_ref
 * @returns {{ring_r1_ohm: boolean, ring_rn_ohm: boolean, ring_r2_ohm: boolean}}
 */
function inspectCircuitFills(stateSnapshot, circuit_ref) {
  const filled = { ring_r1_ohm: false, ring_rn_ohm: false, ring_r2_ohm: false };
  if (!stateSnapshot) return filled;

  let bucket = null;
  const circuits = stateSnapshot.circuits;
  if (circuits && typeof circuits === 'object' && !Array.isArray(circuits)) {
    bucket = circuits[circuit_ref] || circuits[String(circuit_ref)] || null;
  } else if (Array.isArray(circuits)) {
    bucket = circuits.find((c) => c && Number(c.circuit_ref) === Number(circuit_ref)) || null;
  }
  if (!bucket) return filled;

  for (const f of RING_FIELDS) {
    const v = bucket[f];
    if (v !== undefined && v !== null && v !== '') filled[f] = true;
  }
  return filled;
}

/**
 * Find the oldest partially-filled ring continuity bucket whose last
 * write is older than the timeout window. Returns null if none.
 *
 * "Partial" = exactly 1 or 2 of the 3 ring fields are filled. A bucket
 * with 0 filled (never started) or 3 filled (complete) is not partial
 * and gets its tracking state pruned as a side effect.
 *
 * If multiple circuits qualify, the oldest is returned so the longest-
 * waiting question fires first; subsequent turns will pick up the next.
 *
 * @param {object} session  EICRExtractionSession instance.
 * @param {number} [now]    Override for test determinism.
 * @returns {{circuit_ref: number, missing_field: string, last_write_ms: number} | null}
 */
export function findExpiredPartial(session, now = Date.now()) {
  if (!session?.ringContinuityState || session.ringContinuityState.size === 0) return null;

  let oldest = null;
  // Snapshot keys to avoid mutation-during-iteration when we prune.
  const keys = Array.from(session.ringContinuityState.keys());
  for (const circuit_ref of keys) {
    const lastWrite = session.ringContinuityState.get(circuit_ref);
    if (typeof lastWrite !== 'number') {
      session.ringContinuityState.delete(circuit_ref);
      continue;
    }
    const fills = inspectCircuitFills(session.stateSnapshot, circuit_ref);
    const filledCount = RING_FIELDS.filter((f) => fills[f]).length;

    // 0 filled → bucket reset by upstream; 3 filled → complete. Either way,
    // tracking is no longer needed. Prune and skip.
    if (filledCount === 0 || filledCount === 3) {
      session.ringContinuityState.delete(circuit_ref);
      continue;
    }

    if (now - lastWrite < RING_CONTINUITY_TIMEOUT_MS) continue; // still within window

    if (!oldest || lastWrite < oldest.last_write_ms) {
      // Pick the first missing field in canonical order so the question
      // wording is stable. If two are missing, ask about the earliest
      // (R1 before Rn before R2) — the inspector will name whichever
      // they actually have, and the answer-resolver writes to whatever
      // context_field we asked for. (If the user names a different one,
      // we re-fire on the next turn with the still-missing field.)
      const missing_field = RING_FIELDS.find((f) => !fills[f]);
      oldest = { circuit_ref, missing_field, last_write_ms: lastWrite };
    }
  }
  return oldest;
}

/**
 * Build the ask_user payload for a missing ring continuity value. The
 * shape matches what `dispatchAskUser` would emit, but is constructed
 * server-side without invoking Sonnet. Caller is responsible for
 * registering in `entry.pendingAsks` and emitting `ask_user_started`
 * over the iOS WebSocket.
 *
 * @param {{circuit_ref: number, missing_field: string}} expiry
 * @param {string} sessionId
 * @param {number} [now]  Override for test determinism — also used in the
 *   synthetic tool_call_id so concurrent re-fires on the same circuit
 *   don't collide.
 * @returns {{
 *   tool_call_id: string,
 *   question: string,
 *   reason: 'missing_value',
 *   context_field: string,
 *   context_circuit: number,
 *   expected_answer_shape: 'value',
 *   server_emitted: true,
 * }}
 */
export function buildAskForMissingRingValue(expiry, sessionId, now = Date.now()) {
  const { circuit_ref, missing_field } = expiry;
  const label = FIELD_LABELS[missing_field] ?? missing_field;
  return {
    tool_call_id: `srv-ring-${sessionId}-${circuit_ref}-${now}`,
    question: `I seem to have missed a ring continuity value — what's the ${label} for circuit ${circuit_ref}?`,
    reason: 'missing_value',
    context_field: missing_field,
    context_circuit: circuit_ref,
    expected_answer_shape: 'value',
    server_emitted: true,
  };
}
