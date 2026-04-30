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
import { dispatchRecordBoardReading } from './stage6-dispatchers-board.js';
import { dispatchStartDialogueScript } from './stage6-dispatchers-script.js';

/**
 * Dispatch table keyed by tool name. The six original write tools from
 * REQUIREMENTS.md STS-01..06 plus the Phase 2-carryover `record_board_reading`
 * (Bug C — 2026-04-26 production analysis: the original 7-tool surface had no
 * way to write supply / installation / board-level fields). `ask_user` is
 * Phase 3's concern and is mounted via createToolDispatcher below.
 */
export const WRITE_DISPATCHERS = {
  record_reading: dispatchRecordReading,
  clear_reading: dispatchClearReading,
  create_circuit: dispatchCreateCircuit,
  rename_circuit: dispatchRenameCircuit,
  record_observation: dispatchRecordObservation,
  delete_observation: dispatchDeleteObservation,
  record_board_reading: dispatchRecordBoardReading,
  // 2026-04-30 (Silvertown follow-up): Sonnet-driven entry to the
  // dialogue engine for structured walk-throughs the engine's regex
  // missed. Treated as a "write" by the composer (it mutates
  // session.dialogueScriptState) — it does NOT invoke the ask
  // dispatcher path, so it doesn't pause Sonnet's turn the way
  // ask_user does.
  start_dialogue_script: dispatchStartDialogueScript,
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

// ---------------------------------------------------------------------------
// Phase 3 Plan 03-06 — Composer + sortRecords hook
// ---------------------------------------------------------------------------

/**
 * Name-keyed set of Phase 2 write-tool names. Sourced from WRITE_DISPATCHERS
 * above rather than hard-coded here so a future Phase (5/6) adding a seventh
 * write tool via WRITE_DISPATCHERS registration gets composer delegation for
 * free — one source of truth. Frozen at module init to stop downstream code
 * from mutating the membership and breaking the composer invariant.
 */
const WRITE_TOOL_NAMES = Object.freeze(new Set(Object.keys(WRITE_DISPATCHERS)));

/**
 * Compose the Phase 2 write dispatcher and the Plan 03-05 ask dispatcher
 * behind runToolLoop's single `(call, ctx) => Promise<ToolResult>` contract.
 * Delegation is by `call.name`:
 *
 *   - any name in WRITE_TOOL_NAMES (Phase 2) → writes(call, ctx)
 *   - 'ask_user' (Plan 03-05)                → asks(call, ctx)
 *   - anything else                          → synthetic is_error:true envelope
 *                                              { tool_use_id: call.id, content:
 *                                                JSON 'unknown_tool', is_error:true }
 *
 * WHY the composer does NOT enforce writes-before-asks ordering: the composer
 * sees ONE call at a time, never a round's worth of records. Ordering is the
 * sortRecords hook's job (below). Splitting the two concerns keeps the
 * composer reusable for any future ordering policy.
 *
 * WHY the unknown_tool envelope surfaces `call.id ?? call.tool_call_id`: the
 * ask dispatcher uses `call.id` (plan 03-05), the write dispatcher uses
 * `call.tool_call_id` (Phase 2). Runtime wiring through the harness will
 * standardise the shape (plan 03-07/08's concern); until then, the composer
 * defensively surfaces whichever id the caller supplied. `undefined` is
 * preferable to fabricating an id — runToolLoop keys tool_results to
 * `rec.tool_call_id` from the assembler regardless.
 *
 * @param {Function} writes  createWriteDispatcher(...) output (Phase 2).
 * @param {Function} asks    createAskDispatcher(...) output (Plan 03-05).
 * @returns {(call: {tool_call_id?, id?, name, input}, ctx) => Promise<{tool_use_id, content, is_error}>}
 */
export function createToolDispatcher(writes, asks) {
  return async function dispatchTool(call, ctx) {
    if (call.name === 'ask_user') return asks(call, ctx);
    if (WRITE_TOOL_NAMES.has(call.name)) return writes(call, ctx);
    return {
      tool_use_id: call.tool_call_id ?? call.id,
      content: JSON.stringify({ error: 'unknown_tool', name: call.name }),
      is_error: true,
    };
  };
}

/**
 * 2026-04-27 — bug-1B fix. Build an `autoResolveWrite(write, ctx)` hook for
 * the ask dispatcher to invoke when its deterministic resolver returns a
 * confident match. The hook synthesises a write tool call from the resolver
 * verdict and dispatches it through the normal WRITE_DISPATCHERS path so
 * perTurnWrites + state snapshot + log rows all stay consistent with a
 * Sonnet-emitted write.
 *
 * The synthetic tool_call_id namespaces with `::auto::` so post-hoc log
 * analysis can split server-resolved writes from Sonnet-direct writes if
 * needed. Confidence and source_turn_id are carried verbatim from the
 * resolver's pending_write — the inspector's spoken value is the ground
 * truth, not a regenerated approximation.
 *
 * @param {object} session         the dispatcher session (live or shadow)
 * @param {object} logger
 * @param {string} turnId
 * @param {object} perTurnWrites
 * @returns {(write: {tool, field, circuit, value, confidence, source_turn_id}, ctx?: object) => Promise<{ok: boolean, body?: object, error?: string}>}
 */
export function createAutoResolveWriteHook(session, logger, turnId, perTurnWrites) {
  let round = 0;
  return async function autoResolveWrite(write, callCtx = {}) {
    const fn = WRITE_DISPATCHERS[write.tool];
    if (!fn) {
      return { ok: false, error: 'unknown_tool' };
    }
    round += 1;
    const askToolCallId = callCtx.toolCallId ?? 'unknown_ask';
    const synthCallId = `${askToolCallId}::auto::${write.tool}::${write.field}::${
      write.circuit ?? 'board'
    }`;
    const synthInput =
      write.tool === 'record_reading'
        ? {
            field: write.field,
            circuit: write.circuit,
            value: write.value,
            confidence: write.confidence,
            source_turn_id: write.source_turn_id,
          }
        : {
            field: write.field,
            value: write.value,
            confidence: write.confidence,
            source_turn_id: write.source_turn_id,
          };
    const synthCall = {
      tool_call_id: synthCallId,
      name: write.tool,
      input: synthInput,
    };
    const env = await fn(synthCall, {
      session,
      logger,
      turnId,
      perTurnWrites,
      round,
    });
    let body = null;
    try {
      body = JSON.parse(env.content);
    } catch {
      // dispatcher contracts emit JSON; a parse failure is a contract bug.
      // Leave body null and let the ok flag carry the signal.
    }
    return { ok: env.is_error !== true, body };
  };
}

/**
 * Default Phase 3 sortRecords hook for runToolLoop. Moves every `ask_user`
 * record to the END of the array while preserving stream-emission
 * (index-ascending) order within each partition.
 *
 * STA-02 defense-in-depth: if Sonnet interleaves an `ask_user` block between
 * write-tool blocks inside a single response (prompt-discipline drift), this
 * hook still ensures the writes land BEFORE the blocking ask stalls the
 * round. Pair with Phase 4 prompt discipline.
 *
 * Pure function — does NOT mutate the input array. The hook returns a new
 * array whose elements are the same object identities as the input (shallow
 * copy). Empty / single-element inputs short-circuit to identity.
 *
 * Returns the input unchanged when it is not an array — defensive fail-open
 * so a future bug in runToolLoop that passes the hook something weird does
 * not swallow records into `undefined` and break the turn.
 *
 * @returns {(records: Array<{id, name, input, index}>) => Array<same shape>}
 */
export function createSortRecordsAsksLast() {
  return function sortAsksLast(records) {
    if (!Array.isArray(records) || records.length < 2) return records;
    const writes = [];
    const asks = [];
    for (const r of records) {
      if (r && r.name === 'ask_user') asks.push(r);
      else writes.push(r);
    }
    return [...writes, ...asks];
  };
}
