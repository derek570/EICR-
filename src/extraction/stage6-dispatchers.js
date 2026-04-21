/**
 * Stage 6 Phase 2 Plan 02-02 — Write-tool dispatcher BARREL.
 *
 * WHAT: Re-exports the six write-tool dispatchers from two sibling files and
 * owns the dispatch TABLE + createWriteDispatcher factory. No dispatcher
 * logic lives here — each sibling owns exactly four (circuit) or two
 * (observation) dispatchers.
 *
 * WHY a barrel (MAJOR-2 from Phase 2 planning review): Plans 02-03 (circuits)
 * and 02-04 (observations) must land in parallel without merge conflicts on a
 * single monolith file. Each plan edits exactly one sibling. The barrel
 * remains append-only — no changes expected until Phase 3 introduces a new
 * tool (e.g. ask_user).
 *
 * WHY the dispatch table + factory live HERE (not in either sibling): the
 * unknown_tool error path is a cross-cutting concern — it emits an envelope
 * and log row for ANY tool name not in WRITE_DISPATCHERS. Keeping the table
 * + factory in the barrel means a single source of truth for registration,
 * and the factory closure doesn't have to reach into both siblings.
 *
 * WHY re-exports use the same identifier names as sibling exports: the
 * barrel test in stage6-dispatcher-barrel.test.js asserts
 * WRITE_DISPATCHERS.record_reading === circuitSibling.dispatchRecordReading
 * — reference equality, not shape equality. Copy-on-import (e.g. wrapping
 * each sibling export in a new function) would break this invariant and
 * introduce a silent indirection that makes Phase 7 stack traces confusing.
 *
 * Round counter: monotonic per dispatcher instance. See original monolith
 * header (Task 3 commit) for the full rationale; nothing about the counter
 * changes in the barrel split.
 */

import { logToolCall } from './stage6-dispatcher-logger.js';
import {
  dispatchRecordReading,
  dispatchClearReading,
  dispatchCreateCircuit,
  dispatchRenameCircuit,
} from './stage6-dispatchers-circuit.js';
import {
  dispatchRecordObservation,
  dispatchDeleteObservation,
} from './stage6-dispatchers-observation.js';

/**
 * Dispatch table keyed by tool name. The six write tools from REQUIREMENTS.md
 * STS-01..06. `ask_user` is Phase 3's concern.
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
 * Factory binding per-turn context. Returns a (call, _ctx) closure matching
 * the Phase 1 runToolLoop dispatcher contract. Unknown tool names produce an
 * error envelope + log row rather than throwing.
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
