/**
 * Stage 6 Phase 2 Plan 02-02 Task 4 — Circuit-dispatcher STUB file.
 *
 * WHAT: Four NOOP dispatchers covering the circuit-shaped write tools:
 * record_reading, clear_reading, create_circuit, rename_circuit. Plan 02-03
 * replaces each NOOP body with a real validate → mutate → bundler-push → log
 * implementation. This file is the sole surface Plan 02-03 edits.
 *
 * WHY this stub exists BEFORE Plan 02-03: the barrel (stage6-dispatchers.js)
 * imports from here, and the canary integration test in Plan 02-02 Task 5
 * must run BEFORE Plans 02-03/04 land. Stub dispatchers satisfy the envelope
 * + log-row contracts so the canary sees a well-formed end-to-end roundtrip.
 *
 * WHY the noop() helper is duplicated across this file and its observation
 * sibling (instead of hoisted to a shared utility): Plans 02-03/04 will DELETE
 * this helper when they replace the dispatcher bodies with real logic. Sharing
 * it would create a dependency Plan 02-03 has to un-wire; keeping it local
 * keeps each plan's diff self-contained. The cost is ~10 duplicated lines —
 * acceptable for Wave-2 parallelism.
 */

import { logToolCall } from './stage6-dispatcher-logger.js';

async function noop(toolName, call, { session, logger, turnId, round }) {
  logToolCall(logger, {
    sessionId: session.sessionId,
    turnId,
    tool_use_id: call.tool_call_id,
    tool: toolName,
    round,
    is_error: false,
    outcome: 'ok',
    validation_error: null,
    input_summary: {},
  });
  return {
    tool_use_id: call.tool_call_id,
    content: JSON.stringify({ ok: true, noop_pending_impl: 'plan-02-03' }),
    is_error: false,
  };
}

export async function dispatchRecordReading(call, ctx) {
  return noop('record_reading', call, ctx);
}
export async function dispatchClearReading(call, ctx) {
  return noop('clear_reading', call, ctx);
}
export async function dispatchCreateCircuit(call, ctx) {
  return noop('create_circuit', call, ctx);
}
export async function dispatchRenameCircuit(call, ctx) {
  return noop('rename_circuit', call, ctx);
}
