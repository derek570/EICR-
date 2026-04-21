/**
 * Stage 6 Phase 2 Plan 02-02 — Write-tool dispatcher scaffold.
 *
 * WHAT: Dispatch table + factory. Plan 02-02 ships six NOOP internal
 * dispatchers, each of which (a) returns a well-formed {tool_use_id, content,
 * is_error} envelope matching the Phase 1 runToolLoop contract, and (b)
 * emits exactly one stage6_tool_call log row via the shared logger. Plans
 * 02-03 and 02-04 replace the NOOP bodies with real validation + mutation +
 * bundler-push logic.
 *
 * WHY NOOP scaffolding before real logic: Wave 2 parallelism. The shadow
 * harness (Plan 02-06) wires `createWriteDispatcher` into runToolLoop. If we
 * wait for Plans 02-03/04 to both land before any dispatcher-level testing,
 * integration regressions show up late. NOOPs let the scaffold be exercised
 * end-to-end against the Phase 1 loop immediately — that's the canary test
 * in Task 5 of Plan 02-02.
 *
 * WHY unknown_tool is an error ENVELOPE, not a throw: Anti-pattern from
 * Research §Common Pitfalls. Phase 1's runToolLoop catches dispatcher throws
 * and pads the tool_result with is_error:true, but throwing hides the tool
 * name from downstream analysis. Explicit unknown_tool envelope keeps the
 * invariant "every tool_use has a matching tool_result with a known error
 * code" visible to the Phase 7 analyzer.
 *
 * WHY a factory closure (session/logger/turnId bound at construction): the
 * Phase 1 dispatcher contract is `(call, ctx) => Promise<envelope>`. The
 * runToolLoop passes its OWN ctx to the dispatcher (currently `{sessionId,
 * turnId}` for Phase 1 logging). We need MORE context (session, logger,
 * turnId, perTurnWrites, round). The factory closes over those and exposes
 * the (call, _ctx) shape runToolLoop expects. `_ctx` is unused in Phase 2 —
 * Phase 1's ctx is redundant with the closed-over turnId; keeping both lets
 * Phase 7 tighten the contract without breaking callers.
 *
 * Round counter: monotonic per dispatcher instance. Phase 1's runToolLoop
 * calls the dispatcher once per tool_use block (potentially many per round)
 * but each call increments. Close enough to round-based accounting for
 * STO-01's needs; Phase 7's analyzer dedupes by tool_use_id anyway.
 */

import { logToolCall } from './stage6-dispatcher-logger.js';

// ---- NOOP internal dispatchers (Plan 02-02 scaffold) ------------------------
// Plans 02-03 + 02-04 replace these with real validate → mutate → bundle → log
// bodies. Shape: async (call, ctx) => {tool_use_id, content, is_error}.

async function noopDispatch(toolName, call, { session, logger, turnId, round }) {
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
    content: JSON.stringify({ ok: true, noop_pending_impl: 'plan-02-03-or-02-04' }),
    is_error: false,
  };
}

async function dispatchRecordReading(call, ctx) {
  return noopDispatch('record_reading', call, ctx);
}
async function dispatchClearReading(call, ctx) {
  return noopDispatch('clear_reading', call, ctx);
}
async function dispatchCreateCircuit(call, ctx) {
  return noopDispatch('create_circuit', call, ctx);
}
async function dispatchRenameCircuit(call, ctx) {
  return noopDispatch('rename_circuit', call, ctx);
}
async function dispatchRecordObservation(call, ctx) {
  return noopDispatch('record_observation', call, ctx);
}
async function dispatchDeleteObservation(call, ctx) {
  return noopDispatch('delete_observation', call, ctx);
}

/**
 * Dispatch table keyed by tool name. The six write tools from REQUIREMENTS.md
 * STS-01..06. `ask_user` is Phase 3's concern and is dispatched separately
 * (blocking-tool contract is very different).
 */
export const WRITE_DISPATCHERS = {
  record_reading: dispatchRecordReading,
  clear_reading: dispatchClearReading,
  create_circuit: dispatchCreateCircuit,
  rename_circuit: dispatchRenameCircuit,
  record_observation: dispatchRecordObservation,
  delete_observation: dispatchDeleteObservation,
};

/**
 * Factory that binds per-turn context and returns the (call, _ctx) closure
 * runToolLoop expects. Unknown tool names produce an error envelope and log
 * row rather than throwing, so Phase 1's loop keeps advancing cleanly.
 */
export function createWriteDispatcher(session, logger, turnId, perTurnWrites) {
  let round = 0;
  return async (call, _ctx) => {
    round += 1;
    const fn = WRITE_DISPATCHERS[call.name];
    if (!fn) {
      logToolCall(logger, {
        sessionId: session.sessionId,
        turnId,
        tool_use_id: call.tool_call_id,
        tool: call.name,
        round,
        is_error: true,
        outcome: 'rejected',
        validation_error: { code: 'unknown_tool' },
        input_summary: {},
      });
      return {
        tool_use_id: call.tool_call_id,
        content: JSON.stringify({ ok: false, error: { code: 'unknown_tool' } }),
        is_error: true,
      };
    }
    return fn(call, { session, logger, turnId, perTurnWrites, round });
  };
}
