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
// Plan 00B §B2 — producer-boundary origin frames for the evaluation
// mutation observer. Dormant: one Symbol lookup per dispatch when no
// observer is attached (production always).
import { MUTATION_OBSERVER } from './plan00-semantic-capture.js';
import {
  dispatchRecordReading,
  dispatchClearReading,
  dispatchCreateCircuit,
  dispatchRenameCircuit,
  dispatchDeleteCircuit,
  dispatchCalculateZs,
  dispatchCalculateR1PlusR2,
  dispatchSetFieldForAllCircuits,
} from './stage6-dispatchers-circuit.js';
import {
  dispatchRecordObservation,
  dispatchDeleteObservation,
} from './stage6-dispatchers-observation.js';
import {
  dispatchRecordBoardReading,
  dispatchClearBoardReading,
  dispatchAddBoard,
  dispatchSelectBoard,
  dispatchMarkDistributionCircuit,
} from './stage6-dispatchers-board.js';
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
  // 2026-05-04 (field test 07635782): three tools added in one batch.
  // delete_circuit closes the gap surfaced when "delete circuit 2" said
  // twice did nothing (the leftover bucket then stole "the cooker"
  // designation lookup). calculate_zs / calculate_r1_plus_r2 close the
  // gap where "calculate the Zs for circuit N" produced empty turns
  // because the model had no tool to call. All three are circuit-shaped
  // writes; the composer routes them through `writes` like the other
  // record/create/rename/delete tools.
  delete_circuit: dispatchDeleteCircuit,
  calculate_zs: dispatchCalculateZs,
  calculate_r1_plus_r2: dispatchCalculateR1PlusR2,
  // 2026-05-06 (session DC946608) — bulk-set tool. Replaces the model's
  // 14-tool-call burst pattern with one server-iterated call. Sonnet
  // truncated the burst to 7 in production, so the structural fix is to
  // make "all circuits" atomic on the server side.
  set_field_for_all_circuits: dispatchSetFieldForAllCircuits,
  // 2026-05-07 multi-board sprint Phase 6.1 — add_board. Sonnet calls
  // this when the inspector mentions a NEW consumer unit / sub-distribution
  // board / sub-main; dispatcher synthesises a stable id, validates the
  // hierarchy, mutates snapshot.boards + currentBoardId, and emits an op
  // onto perTurnWrites.boardOps (Phase 6.0 wire channel) for iOS.
  add_board: dispatchAddBoard,
  // 2026-05-07 multi-board sprint Phase 6.2 — select_board (id-only).
  // Inspector switches between previously-added boards. Designation fuzzy
  // match is deferred to a supervised session.
  select_board: dispatchSelectBoard,
  // 2026-05-07 multi-board sprint Phase 6.3 — mark_distribution_circuit.
  // Marks an existing circuit as feeding another board. STOP-SLICE: no
  // forward-ref ask_user when feeds_board_id doesn't exist — Sonnet must
  // call add_board FIRST. Path-2 resolver entanglement risk made the
  // ask_user flow a supervised slice.
  mark_distribution_circuit: dispatchMarkDistributionCircuit,
  // Plan A1a (2026-07-27, feedback id 101) — clear_board_reading, the
  // board/supply-scope analogue of clear_reading ("Delete Ze" had no possible
  // tool; session C06B9904). Deny-first at the DISPATCHER via board_clear_v1
  // (denyBoardClear) — the tool is always advertised, and every session
  // without the capability gets a soft-skip + spoken notice, never a
  // mutation or a board field_corrected frame.
  clear_board_reading: dispatchClearBoardReading,
};

/**
 * Factory binding per-turn context. Returns a (call, ctx) closure matching
 * the Phase 1 runToolLoop dispatcher contract. Unknown tool names produce an
 * error envelope + log row rather than throwing.
 *
 * `extraCtx` (added 2026-04-30 Silvertown follow-up): per-turn, dispatcher-
 * agnostic fields runToolLoop's ctx wants every dispatcher to see — currently
 * just `ws` for the start_dialogue_script dispatcher's first-ask emission.
 * Spread into the per-call ctx AFTER the standard fields so dispatchers can
 * read them but never accidentally shadow {session, logger, turnId,
 * perTurnWrites, round}. Keep this a tight allow-list, not a passthrough of
 * the entire runToolLoop ctx — implicit coupling between the loop and every
 * dispatcher would be hard to revoke once it set in.
 */
export function createWriteDispatcher(session, logger, turnId, perTurnWrites, extraCtx = {}) {
  let round = 0;
  // Defensive copy so a mutating caller can't change ctx fields mid-turn.
  const safeExtra = { ...extraCtx };
  return async (call, _ctx) => {
    round += 1;
    const fn = WRITE_DISPATCHERS[call.name];
    if (!fn) {
      // Plan B §3.2 — the OBJECT-form unknown_tool route (e.g. ask_user
      // delegated to writes when no ask dispatcher is composed). Stage the
      // model_contract refusal through the bound callback so the turn's
      // audible outcome is an honest internal-snag line instead of the
      // generic "couldn't action that"; the envelope below stays
      // byte-identical (the model's self-correction signal is unchanged).
      // Best-effort: staging must never break dispatch.
      try {
        safeExtra.onUnknownToolRefusal?.(call.tool_call_id ?? call.id ?? null);
      } catch {
        // swallowed — the envelope is the contract; the A3/marker-② nets
        // keep the turn audible without the notice.
      }
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
    // 2026-08-07 (Derek, field-test observability) — a SEPARATE log name
    // from stage6_tool_call's schema-locked input_summary (never touch that
    // contract; see stage6-dispatcher-logger.js's restrained-mode tests).
    // input_summary deliberately excludes the actual value on a blanket PII
    // rule; for a sole-user field test comparing Luna's real output against
    // what was dictated, the value itself (an ohms reading, a defect code)
    // isn't personal data, so it's logged here verbatim, once, at the single
    // point every write-tool call passes through regardless of which
    // dispatcher handles it.
    logger.info('stage6_tool_call_raw_input', {
      sessionId: session.sessionId,
      turnId,
      tool_use_id: call.tool_call_id,
      tool: call.name,
      round,
      raw_input: call.input ?? null,
    });
    // Plan 00B §B2 — declare the semantic origin at the ONE producer
    // boundary every model-driven write flows through. calculate_* results
    // are explicit-intent computed writes ('calculator'); everything else
    // the model dispatches directly is 'model_direct'. The observer is the
    // SAME instance attached to session and snapshot, so one frame covers
    // reading/circuit/board atoms (snapshot) and observation atoms
    // (session). Production path (no observer) is byte- and
    // timing-identical: the bare `return fn(...)` below.
    const mutationObserver =
      session?.stateSnapshot?.[MUTATION_OBSERVER] ?? session?.[MUTATION_OBSERVER] ?? null;
    if (!mutationObserver) {
      return fn(call, { ...safeExtra, session, logger, turnId, perTurnWrites, round });
    }
    mutationObserver.setOriginFrame({
      origin:
        call.name === 'calculate_zs' || call.name === 'calculate_r1_plus_r2'
          ? 'calculator'
          : 'model_direct',
      meta: { tool: call.name, tool_call_id: call.tool_call_id ?? null },
    });
    try {
      return await fn(call, { ...safeExtra, session, logger, turnId, perTurnWrites, round });
    } finally {
      mutationObserver.clearOriginFrame();
    }
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
export function createToolDispatcher(
  writes,
  asks,
  { answers, inspects, observationClarificationTerminals, onUnknownToolRefusal } = {}
) {
  return async function dispatchTool(call, ctx) {
    // A1 agentic-voice (2026-07-23) — dedicated routes for the two read-only
    // answer-feature tools. Deliberately NOT WRITE_DISPATCHERS entries (that
    // table feeds WRITE_TOOL_NAMES and every consumer keyed on it, and an
    // answer is not a write). The answer/inspect dispatchers are constructed
    // independently of pendingAsks at BOTH harness composition sites — a tool
    // must never be advertised without a dispatch route.
    if (call.name === 'answer_user' && typeof answers === 'function') return answers(call, ctx);
    if (call.name === 'inspect_session_state' && typeof inspects === 'function') {
      return inspects(call, ctx);
    }
    if (
      call.name === 'resolve_observation_clarification' &&
      typeof observationClarificationTerminals === 'function'
    ) {
      return observationClarificationTerminals(call, ctx);
    }
    // `asks` is nullable since A1: the no-pendingAsks composition path now
    // also flows through this composer (it previously used the bare writes
    // dispatcher). Delegating ask_user to `writes` there reproduces the
    // pre-A1 behaviour byte-for-byte: the write dispatcher's unknown_tool
    // envelope + log row.
    if (call.name === 'ask_user') return asks ? asks(call, ctx) : writes(call, ctx);
    if (WRITE_TOOL_NAMES.has(call.name)) return writes(call, ctx);
    // Plan B §3.2 — the STRING-form unknown_tool route (a hallucinated tool
    // name the composer has no route for). Stage the model_contract refusal
    // via the bound callback: a hallucinated tool is a protocol error, not
    // an impossible request, so the spoken line is the internal-snag family,
    // never a capability refusal. The envelope stays byte-identical.
    try {
      onUnknownToolRefusal?.(call.tool_call_id ?? call.id ?? null);
    } catch {
      // swallowed — see createWriteDispatcher's unknown-tool branch.
    }
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
export function createAutoResolveWriteHook(session, logger, turnId, perTurnWrites, extraCtx = {}) {
  let round = 0;
  // P3 Codex-r4 — the auto-resolve path (a LIM/value answer to an ask_user /
  // pending-value question) dispatches through the SAME record_reading
  // dispatcher, so it must carry the SAME capability context; otherwise a
  // capable client's LIM answer to a pending question is denied as
  // capability-missing (and the resolver would report auto_resolved with no
  // write).
  const safeExtra = { ...extraCtx };
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
    // §A4 Codex r1-#1 (field-feedback-2026-07-14) — carry the ask's board
    // scope through to the dispatcher. The resolvers (resolveValueAnswer /
    // resolveEnumAnswer / the pending-value chain) stamp `board_id` onto
    // their writes per readback-correction-optionb §3.3/§6, but this hook
    // rebuilt synthInput WITHOUT it, so on a multi-board job an auto-resolved
    // reading validated/wrote against currentBoardId instead of the board
    // the original ask named. Omit-when-null keeps single-board synthCalls
    // byte-identical.
    //
    // A2-multiboard item 6 — this gate stays a bare `!= null` on purpose. An
    // auto-resolved write is dispatched through the SAME `WRITE_DISPATCHERS`
    // table as a model-emitted one, and the in-scope dispatchers now normalise
    // an empty-string `board_id` at their own entry — so auto-resolve is
    // routed through the normaliser without this hook knowing about it.
    // Normalising HERE instead would also silently normalise the dispatchers
    // that are deliberately EXEMPT (`record_board_reading`, `clear_board_reading`),
    // punching a hole in their destructive-write safety contract.
    if (write.board_id != null) {
      synthInput.board_id = write.board_id;
    }
    const synthCall = {
      tool_call_id: synthCallId,
      name: write.tool,
      input: synthInput,
    };
    // Plan 00B §B2 — an auto-resolved answer write is its OWN semantic
    // origin ('ask_auto_resolve'), declared at this producer boundary (the
    // hook bypasses createWriteDispatcher's model_direct framing). Dormant
    // single Symbol lookup in production.
    const autoResolveObserver =
      session?.stateSnapshot?.[MUTATION_OBSERVER] ?? session?.[MUTATION_OBSERVER] ?? null;
    if (autoResolveObserver) {
      autoResolveObserver.setOriginFrame({
        origin: 'ask_auto_resolve',
        meta: { tool: write.tool, ask_tool_call_id: askToolCallId, field: write.field ?? null },
      });
    }
    let env;
    try {
      env = await fn(synthCall, {
        ...safeExtra,
        session,
        logger,
        turnId,
        perTurnWrites,
        round,
        // PLAN-2B — an mdr-* answer may arrive after select_board moved the
        // session cursor. This capability is derived inside the ask dispatcher,
        // never from model input, and authorises only the synthetic
        // record_reading / record_board_reading dispatcher call to retain its
        // frozen census board.
        allowFrozenAutoResolveBoardScope:
          (write.tool === 'record_reading' || write.tool === 'record_board_reading') &&
          callCtx.frozenBoardScope === true,
      });
    } finally {
      if (autoResolveObserver) autoResolveObserver.clearOriginFrame();
    }
    let body = null;
    try {
      body = JSON.parse(env.content);
    } catch {
      // dispatcher contracts emit JSON; a parse failure is a contract bug.
      // Leave body null and let the ok flag carry the signal.
    }
    // P3 Codex-r5 — a non-error SKIP (the record_reading dispatcher's
    // capability-missing / low-conf pre-apply gate returns {ok:true,skipped:true}
    // with NO snapshot or per-turn write) must NOT be reported as a successful
    // auto-resolve. Treating it as failure routes the ask resolver to its
    // apology/failure path instead of falsely claiming auto_resolved with no
    // write.
    const skipped = body?.skipped === true;
    return { ok: env.is_error !== true && !skipped, body };
  };
}

/**
 * True for a `record_board_reading` record whose target field is the closed-enum
 * `earthing_arrangement`. This is the CANONICAL definition; runToolLoop's
 * emergency sort fallback inlines a byte-equivalent copy (it must stay free of
 * any dependency on this module) and a parity test pins the two together.
 *
 * Defensive on shape: `input` may be absent or non-object on a malformed record,
 * and a non-string `field` must never throw here — the dispatcher owns validation.
 *
 * @param {{name?: string, input?: unknown}} rec
 * @returns {boolean}
 */
export function isEarthingArrangementRecord(rec) {
  // Plan A1a (Codex diff-review r1): `clear_board_reading` joins the
  // earthing-OPERATION group. With only the write recognised, the hoist
  // would reorder an earthing WRITE ahead of a preceding earthing CLEAR,
  // inverting a model-emitted clear→write correction into write→clear —
  // once A1b classifies `earthing_arrangement` as clearable, mechanism A
  // would then delete the write and the final state would be blank. The
  // partition preserves order WITHIN a partition, so keeping the whole
  // group in partition 1 keeps clear→write and write→clear in their
  // emitted order. Today `earthing_arrangement` is scope-UNCLASSIFIED
  // (the clear soft-skips without mutating), so this is a zero-behaviour
  // change that removes a latent A1b footgun.
  if (!rec || (rec.name !== 'record_board_reading' && rec.name !== 'clear_board_reading')) {
    return false;
  }
  const input = rec.input;
  if (!input || typeof input !== 'object') return false;
  return input.field === 'earthing_arrangement';
}

/**
 * True for a record that MUTATES `snapshot.currentBoardId` — `add_board`
 * (stage6-dispatchers-board.js:738) and `select_board` (:880). These are BOARD
 * CONTEXT BOUNDARIES for the sort below: `record_board_reading` carries no
 * `board_id` in its tool schema, so its target board is resolved at dispatch
 * time as `snapshot.currentBoardId` — reordering a board write ACROSS one of
 * these lands it on a different board. Canonical definition; runToolLoop's
 * emergency sort fallback inlines a byte-equivalent copy and a parity test pins
 * the two together.
 *
 * @param {{name?: string}} rec
 * @returns {boolean}
 */
export function isBoardContextChangingRecord(rec) {
  if (!rec) return false;
  return rec.name === 'add_board' || rec.name === 'select_board';
}

/**
 * Default Phase 3 sortRecords hook for runToolLoop. Produces a THREE-way stable
 * partition, preserving stream-emission (index-ascending) order WITHIN each
 * partition:
 *
 *   1. `record_board_reading {field: 'earthing_arrangement'}` — FIRST
 *   2. every other write record
 *   3. `ask_user` — LAST
 *
 * …except that partitions 1 and 2 are applied PER BOARD-CONTEXT SEGMENT, not
 * across the whole round (see `isBoardContextChangingRecord`).
 *
 * STA-02 defense-in-depth (partition 3): if Sonnet interleaves an `ask_user`
 * block between write-tool blocks inside a single response (prompt-discipline
 * drift), this hook still ensures the writes land BEFORE the blocking ask stalls
 * the round. Pair with Phase 4 prompt discipline.
 *
 * id-100(b) / Codex lens-3 (2026-07-25) — partition 1 exists because the
 * SERVER-AUTHORITATIVE impedance clamp resolves the Ze band from the COMMITTED
 * `session.stateSnapshot`, and runToolLoop dispatches a round's records
 * SEQUENTIALLY in this order. A single utterance can carry both facts ("Ze is 16
 * on a TN-C-S system") and the model then emits them in UTTERANCE order — Ze
 * first, earthing second. Without this partition that Ze write resolves an
 * UNKNOWN arrangement and declines to divide (the documented fail-safe), while
 * the same utterance phrased the other way round ("TN-C-S system, Ze is 16")
 * WOULD clamp. Silent order-dependence is unacceptable on a safety-critical
 * path — and once a client latches `server_impedance_clamp` and stands its own
 * clamp down, the unclamped value is what reaches the certificate. Committing
 * the arrangement first makes the clamp deterministic for the whole round.
 *
 * ONLY `earthing_arrangement` is hoisted. It is a closed-enum FACT that no other
 * record consults for its own validation, so moving it cannot change any other
 * record's outcome — it can only make the Ze band resolution better-informed.
 * This is deliberately NOT a general "facts before measurements" reordering: the
 * narrow rule is the one with a proven failure mode.
 *
 * BOARD-CONTEXT SEGMENTS (Codex mini-review, 2026-07-25) — the hoist is bounded.
 * `record_board_reading` has NO `board_id` in its tool schema, so the dispatcher
 * resolves its target as `snapshot.currentBoardId`, and `add_board`/`select_board`
 * MUTATE that field mid-round. Hoisting an earthing write across one of those
 * would silently land the arrangement on a DIFFERENT board — "add the garage
 * board, earthing is TT, Ze is 16" would stamp TT on the origin supply instead of
 * the new board. `add_board`/`select_board` records therefore stay pinned in
 * place and act as segment boundaries: the earthing-first partition is applied
 * WITHIN each maximal run of non-context-changing writes, never across one. With
 * no such record in the round (the overwhelmingly common case, and the id-100(b)
 * repro) the whole round is one segment and the behaviour is exactly the simple
 * three-way partition. `ask_user` is still moved to the round tail globally: it
 * writes nothing, so it has no board context to lose.
 *
 * Pure function — does NOT mutate the input array. The hook returns a new array
 * whose elements are the same object identities as the input (shallow copy).
 * Empty / single-element inputs short-circuit to identity.
 *
 * Returns the input unchanged when it is not an array — defensive fail-open so a
 * future bug in runToolLoop that passes the hook something weird does not
 * swallow records into `undefined` and break the turn.
 *
 * @returns {(records: Array<{id, name, input, index}>) => Array<same shape>}
 */
export function createSortRecordsAsksLast() {
  return function sortAsksLast(records) {
    if (!Array.isArray(records) || records.length < 2) return records;
    const ordered = [];
    const asks = [];
    let earthing = [];
    let writes = [];
    // Emit the segment accumulated so far: earthing writes first, then the rest,
    // each in stream order. Called at every board-context boundary and once at
    // the end, so a hoist can never cross an add_board/select_board.
    const flushSegment = () => {
      if (earthing.length > 0) {
        ordered.push(...earthing);
        earthing = [];
      }
      if (writes.length > 0) {
        ordered.push(...writes);
        writes = [];
      }
    };
    for (const r of records) {
      if (r && r.name === 'ask_user') {
        asks.push(r);
      } else if (isBoardContextChangingRecord(r)) {
        flushSegment();
        ordered.push(r);
      } else if (isEarthingArrangementRecord(r)) {
        earthing.push(r);
      } else {
        writes.push(r);
      }
    }
    flushSegment();
    return [...ordered, ...asks];
  };
}
