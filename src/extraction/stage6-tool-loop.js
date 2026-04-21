/**
 * Stage 6 Phase 1 — Multi-round tool-call loop (STD-02, STD-10, STO-01).
 *
 * WHAT: runToolLoop drives a model.stream() -> assemble -> dispatch -> append
 * tool_result -> re-invoke cycle until the model returns stop_reason:'end_turn'
 * OR the loop-cap (LOOP_CAP = 8 rounds) is hit. On cap-hit, the round-N
 * assistant response's tool_use blocks are NOT dispatched; instead the loop
 * iterates the round-N tool_use records and appends ONE synthetic tool_result
 * per tool_use_id with content = JSON.stringify({aborted:true, reason:'loop_cap'})
 * and is_error:true. This shape is mandated verbatim by STD-10 and is what
 * the Phase 8 stage6.tool_loop_cap_hit_rate analyzer metric expects.
 *
 * WHY a separate module (not inlined in sonnet-stream.js): The loop is pure
 * control flow over a streaming SDK client + a dispatcher + a logger. Keeping
 * it dependency-light makes Phase 2 (real dispatchers) a drop-in at the
 * `dispatcher` arg; Phase 3 (blocking ask_user) a dispatcher-internal detail;
 * Phase 7 (shadow -> live) a call-site concern in sonnet-stream.js. Pulling it
 * out also makes STD-10's cap-hit contract unit-testable without standing up
 * a WebSocket or a real Anthropic client.
 *
 * WHY count ROUNDS, not tool calls (Research §Pitfall 5): "8 tool calls" in
 * a single response must NOT trip the cap. REQUIREMENTS.md STD-10 says "8
 * rounds per user turn"; a single round may emit an arbitrary number of
 * parallel tool_use blocks (Phase 2 same-turn correction: clear_reading +
 * record_reading fits in one round).
 *
 * WHY push the assistant message BEFORE the tool_result user message, on
 * EVERY round including the cap-hit round (Research §Pitfall 3): Anthropic's
 * API rejects a request whose messages list contains a tool_use block without
 * a matching tool_result in the subsequent user message. On the cap-hit round
 * we still owe tool_result(s) for the round-N tool_use(s) the model just
 * emitted — we satisfy that obligation with the synthetic abort payload.
 * If we return WITHOUT appending the assistant message, a subsequent user
 * turn in the same session could re-use the extended `messages` and
 * inadvertently produce the legal form (assistant with tool_use followed by
 * user with tool_result) — but we'd have no traceability. Appending both
 * makes the cap-hit visible in the message log and keeps the conversation
 * coherent for the next turn.
 *
 * WHY a NOOP_DISPATCHER export (Phase 1 only): real dispatchers are Phase 2.
 * Phase 1 ships the plumbing and every log shape downstream tooling
 * (analyzer, dashboards) expects. NOOP returns {ok: true} so the assertion
 * surface in loop tests doesn't couple to payload details that don't exist
 * yet.
 */

import { createAssembler } from './stage6-stream-assembler.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Hard cap on model invocations per user turn (STD-10).
 * Exported so tests + future tuning (Phase 7 / Phase 8) can reference a single
 * source of truth. If raised, the Phase 8 CloudWatch alarm threshold for
 * stage6.tool_loop_cap_hit_rate should be revisited in tandem.
 */
export const LOOP_CAP = 8;

// ---------------------------------------------------------------------------
// No-op dispatcher (Phase 1)
// ---------------------------------------------------------------------------

/**
 * Phase 1 dispatcher stub. Returns a canonical success tool_result without
 * touching session state, emitting iOS events, or making any network calls.
 *
 * Phase 2 replaces this with a dispatcher table mapping tool_name -> real
 * implementation (record_reading writes stateSnapshot, ask_user blocks etc).
 * The signature is stable from Phase 1 onward so sonnet-stream.js doesn't
 * need to change at Phase 2 cutover.
 */
export const NOOP_DISPATCHER = async (call /* , ctx */) => ({
  tool_use_id: call.tool_call_id,
  content: JSON.stringify({ ok: true }),
  is_error: false,
});

/**
 * Extract the tool_use.id set from a finalized assistant message. This is
 * the AUTHORITATIVE set of ids Anthropic expects tool_result pairings for —
 * the assembler's records[] can diverge (orphan_delta adds synthetic
 * records without a matching tool_use in the assistant message;
 * incomplete_stream uses the real id but the record may be intentionally
 * skipped by the caller). Returns [] on malformed / empty content.
 */
function assistantToolUseIds(assistantMsg) {
  const content = assistantMsg && assistantMsg.content;
  if (!Array.isArray(content)) return [];
  const ids = [];
  for (const block of content) {
    if (block && block.type === 'tool_use' && typeof block.id === 'string') {
      ids.push(block.id);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// runToolLoop
// ---------------------------------------------------------------------------

/**
 * Drive the multi-round tool-call loop for one user turn.
 *
 * @param {Object} opts
 * @param {Object} opts.client Anthropic SDK client exposing messages.stream({...}).
 *   Test suites pass a mockClient from src/__tests__/helpers/mockStream.js.
 * @param {string} opts.model e.g. 'claude-sonnet-4-6'.
 * @param {string} opts.system System-prompt prefix.
 * @param {Array} opts.messages Initial messages array. MUTATED: the loop
 *   appends one assistant message and one user(tool_result) message per
 *   round. Caller retains ownership — this is by design so that sonnet-
 *   stream.js can inspect the post-loop message log for logging/analyzer.
 * @param {Array} opts.tools Tool definitions (from stage6-tool-schemas.js).
 * @param {Function} opts.dispatcher ToolDispatcher. Phase 1 defaults to NOOP.
 * @param {Object} opts.ctx Context { sessionId, turnId } threaded into logs.
 * @param {Object} [opts.logger] Winston-shaped logger with info/warn/error.
 * @param {number} [opts.maxRounds=LOOP_CAP] Override cap (tests / future tuning).
 * @returns {Promise<{
 *   stop_reason: string | null,
 *   rounds: number,
 *   tool_calls: Array<{name: string, input: any, result: any}>,
 *   aborted: boolean,
 *   messages_final: Array,
 * }>}
 */
export async function runToolLoop({
  client,
  model,
  system,
  messages,
  tools,
  dispatcher,
  ctx,
  logger,
  maxRounds = LOOP_CAP,
}) {
  let rounds = 0;
  let stopReason = null;
  let aborted = false;
  const allCalls = [];

  while (rounds < maxRounds) {
    rounds += 1;

    // Per-round stream. The SDK helper returns both an async-iterable AND a
    // .finalMessage() promise — we consume both for different purposes:
    //   - iteration drives the assembler (records + stop_reason)
    //   - finalMessage() gives us the model's full assistant message to push
    //     onto `messages` so the next round sees the correct prior turn.
    const stream = client.messages.stream({
      model,
      max_tokens: 4096,
      system,
      messages,
      tools,
    });

    const asm = createAssembler({ logger });
    for await (const ev of stream) {
      asm.handle(ev);
    }
    const { records, stop_reason } = asm.finalize();
    stopReason = stop_reason;

    // Push the assistant message on EVERY round — tool_use AND end_turn.
    // On tool_use rounds this is the tool_use-before-tool_result ordering
    // invariant (Research §Pitfall 3) — the synthetic or real tool_result(s)
    // below require the referenced tool_use(s) to be present in the prior
    // assistant message or Anthropic's API would 400 on the next
    // invocation. On end_turn rounds the assistant message carries the
    // model's final text reply; dropping it (pre-fix behavior: break before
    // push) meant messages_final lost the model's last turn and any caller
    // building multi-turn history from it would lose context for the next
    // user turn. Codex's Phase-1 STG review flagged this as MAJOR.
    const assistantMsg = await stream.finalMessage();
    messages.push({ role: 'assistant', content: assistantMsg.content });

    // Happy-path terminator: model said end_turn (or null / unknown — treat
    // anything other than tool_use as "we are done").
    if (stop_reason !== 'tool_use') break;

    // CAP-HIT BRANCH (STD-10 verbatim).
    // At this point `rounds` has just been incremented to maxRounds (e.g. 8).
    // The model still wants more tool calls (stop_reason === 'tool_use').
    // We MUST NOT invoke the dispatcher on these round-N tool calls. Instead
    // we append one synthetic tool_result per pending tool_use_id with
    //   content = JSON.stringify({aborted: true, reason: 'loop_cap'})
    //   is_error = true
    // and exit cleanly. No further model invocation. Log tool_loop_cap_hit
    // for the Phase 8 stage6.tool_loop_cap_hit_rate CloudWatch metric.
    if (rounds >= maxRounds) {
      const abortResults = [];
      const answeredCap = new Set();
      for (const rec of records) {
        // Skip orphan_delta error records — they have no matching tool_use.id
        // in the assistant message (the assembler synthesised the record
        // without a preceding content_block_start), so Anthropic is not
        // owed a tool_result for them. Including one would produce a
        // tool_use_id referencing nothing.
        if (!rec.tool_call_id) continue;
        abortResults.push({
          type: 'tool_result',
          tool_use_id: rec.tool_call_id,
          content: JSON.stringify({ aborted: true, reason: 'loop_cap' }),
          is_error: true,
        });
        answeredCap.add(rec.tool_call_id);
      }
      // Pad any assistant tool_use ids the assembler did not surface
      // (pathological cases: records loss, SDK race). The authoritative id
      // set is the assistant message, NOT the assembler records — without
      // padding, messages.content=[] would be malformed even in the cap-hit
      // branch if the caller reuses messages_final for another turn.
      for (const id of assistantToolUseIds(assistantMsg)) {
        if (answeredCap.has(id)) continue;
        abortResults.push({
          type: 'tool_result',
          tool_use_id: id,
          content: JSON.stringify({ aborted: true, reason: 'loop_cap' }),
          is_error: true,
        });
      }
      messages.push({ role: 'user', content: abortResults });
      aborted = true;
      logger?.warn?.('tool_loop_cap_hit', {
        sessionId: ctx?.sessionId,
        turnId: ctx?.turnId,
        rounds,
        pending_tool_uses: abortResults.length,
      });
      break;
    }

    // NORMAL DISPATCH BRANCH: rounds < maxRounds. Dispatch each tool call in
    // the assembler's index-ascending order (finalize() already sorts), then
    // append one user-role message whose content is the array of tool_result
    // content blocks (one per dispatched call). Anthropic expects all of a
    // round's tool_results in a single user message.
    const toolResults = [];
    for (const rec of records) {
      // Assembler error records (invalid_json, orphan_delta). For errors
      // that DO carry a tool_call_id (invalid_json from a real tool_use
      // whose inputs never parsed) we still owe Anthropic a tool_result —
      // encoding the assembler error satisfies that obligation. For errors
      // that DON'T carry a tool_call_id (orphan_delta from a content_block_
      // delta with no preceding content_block_start) there is no matching
      // tool_use in the assistant message, so emitting a tool_result with
      // a synthetic "unknown" id would reference nothing — Anthropic would
      // reject the next round with tool_use_id_without_result. Skip those
      // silently, mirroring the cap-hit branch at line ~178. Codex's
      // Phase-1 STG review flagged the old `?? 'unknown'` fallback as BLOCK.
      if (rec.error) {
        if (!rec.tool_call_id) continue;
        toolResults.push({
          type: 'tool_result',
          tool_use_id: rec.tool_call_id,
          content: JSON.stringify({ error: rec.error, raw_partial: rec.raw_partial }),
          is_error: true,
        });
        logger?.warn?.('stage6.tool_call', {
          sessionId: ctx?.sessionId,
          turnId: ctx?.turnId,
          tool_call_id: rec.tool_call_id,
          tool_name: rec.name,
          duration_ms: 0,
          outcome: 'assembler_error',
          error: rec.error,
        });
        continue;
      }

      const started = Date.now();
      try {
        const res = await dispatcher(
          { tool_call_id: rec.tool_call_id, name: rec.name, input: rec.input },
          ctx,
        );
        const duration_ms = Date.now() - started;
        // STO-01: per-tool-call structured log. sessionId/turnId are
        // session+turn correlators; tool_call_id threads to the assistant's
        // tool_use.id; tool_name for metric tagging; duration_ms for the
        // Phase 8 latency dashboard; outcome distinguishes success from
        // dispatcher_error for alarming.
        logger?.info?.('stage6.tool_call', {
          sessionId: ctx?.sessionId,
          turnId: ctx?.turnId,
          tool_call_id: rec.tool_call_id,
          tool_name: rec.name,
          duration_ms,
          outcome: 'stub_ok',
        });
        // Surface dispatcher id-threading bugs in observability. The
        // dispatcher SHOULD echo call.tool_call_id back in res.tool_use_id,
        // but we do not trust it — we always key the tool_result to the
        // assembler's rec.tool_call_id (which came directly from the
        // assistant message and is what Anthropic expects paired). If the
        // dispatcher-returned id diverges, that's a Phase 2+ dispatcher
        // bug worth alarming on. Codex's Phase-1 STG re-review (round 3)
        // flagged the pre-fix `tool_use_id: res.tool_use_id` as MAJOR —
        // a buggy dispatcher could silently unpair tool_use/tool_result
        // and the next Anthropic call would 400.
        if (res.tool_use_id !== rec.tool_call_id) {
          logger?.warn?.('stage6.tool_call_id_mismatch', {
            sessionId: ctx?.sessionId,
            turnId: ctx?.turnId,
            tool_call_id: rec.tool_call_id,
            dispatcher_returned_id: res.tool_use_id,
            tool_name: rec.name,
          });
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: rec.tool_call_id,
          content: res.content,
          is_error: res.is_error,
        });
        allCalls.push({ name: rec.name, input: rec.input, result: res });
      } catch (err) {
        const duration_ms = Date.now() - started;
        logger?.error?.('stage6.tool_call', {
          sessionId: ctx?.sessionId,
          turnId: ctx?.turnId,
          tool_call_id: rec.tool_call_id,
          tool_name: rec.name,
          duration_ms,
          outcome: 'dispatcher_error',
          error: err?.message,
        });
        // Surface the error as a tool_result so the model can react rather
        // than the loop crashing the turn — this matches REQUIREMENTS STD-09
        // (every tool execution returns a tool_result, success OR
        // validation_error, before re-invoke).
        toolResults.push({
          type: 'tool_result',
          tool_use_id: rec.tool_call_id,
          content: JSON.stringify({
            error: 'dispatcher_error',
            message: err?.message,
          }),
          is_error: true,
        });
      }
    }
    // Pad any unanswered assistant tool_use ids. Anthropic requires every
    // tool_use in the prior assistant message to be paired with a
    // tool_result in the immediately-following user message — if we skipped
    // some record (orphan_delta above, or a pathological assembler-records-
    // diverged-from-assistant-message case), the API would 400 on the next
    // stream(). Authoritative id set = assistant message content (what the
    // API committed to), NOT the assembler's records (which can synthesise
    // or drop). Codex's Phase-1 STG re-review flagged the unpadded
    // empty-user-content case as MAJOR @ tool-loop:292.
    const answered = new Set(toolResults.map((r) => r.tool_use_id));
    for (const id of assistantToolUseIds(assistantMsg)) {
      if (answered.has(id)) continue;
      toolResults.push({
        type: 'tool_result',
        tool_use_id: id,
        content: JSON.stringify({
          error: 'internal_no_result',
          reason: 'record_missing_or_skipped',
        }),
        is_error: true,
      });
      logger?.warn?.('stage6.tool_call', {
        sessionId: ctx?.sessionId,
        turnId: ctx?.turnId,
        tool_call_id: id,
        duration_ms: 0,
        outcome: 'internal_no_result',
      });
    }

    // Invariant: we only reached this branch because stop_reason === 'tool_use'.
    // That means the model told Anthropic "I am about to use tools." If the
    // finalized assistant message contains NO tool_use blocks, that's an
    // Anthropic protocol violation, not something we should paper over by
    // pushing an empty user message (which the API would 400 on anyway).
    // Abort the turn cleanly with a logged error so the caller can decide.
    if (toolResults.length === 0) {
      logger?.error?.('stage6.tool_loop_invariant', {
        sessionId: ctx?.sessionId,
        turnId: ctx?.turnId,
        rounds,
        reason: 'tool_use_stop_reason_with_no_tool_use_blocks',
      });
      aborted = true;
      break;
    }

    messages.push({ role: 'user', content: toolResults });
  }

  return {
    stop_reason: stopReason,
    rounds,
    tool_calls: allCalls,
    aborted,
    messages_final: messages,
  };
}
