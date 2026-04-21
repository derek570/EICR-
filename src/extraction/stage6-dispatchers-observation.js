/**
 * Stage 6 Phase 2 Plan 02-02 Task 4 — Observation-dispatcher STUB file.
 *
 * WHAT: Two NOOP dispatchers covering the observation-shaped write tools:
 * record_observation, delete_observation. Plan 02-04 replaces each NOOP body
 * with a real validate → mutate → bundler-push → log implementation. This
 * file is the sole surface Plan 02-04 edits.
 *
 * WHY separated from circuit dispatchers (MAJOR-2): Wave-2 parallelism.
 * Plan 02-03 (circuits) and Plan 02-04 (observations) each own ONE file.
 * The barrel (stage6-dispatchers.js) glues them together. Merge conflicts
 * between the two plans become structurally impossible.
 *
 * WHY validateDeleteObservation always returns null (BLOCK-2 contract):
 * see stage6-dispatch-validation.js header + Research §Q8. Plan 02-04's
 * dispatchDeleteObservation handles the absence case by returning
 *   {ok: true, noop: true, reason: 'observation_not_found'}
 * with is_error:false. The scaffold NOOP here does not distinguish — it just
 * returns the generic ok-envelope, which Plan 02-04 will replace.
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
    content: JSON.stringify({ ok: true, noop_pending_impl: 'plan-02-04' }),
    is_error: false,
  };
}

export async function dispatchRecordObservation(call, ctx) {
  return noop('record_observation', call, ctx);
}
export async function dispatchDeleteObservation(call, ctx) {
  return noop('delete_observation', call, ctx);
}
