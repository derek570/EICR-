/**
 * Stage 6 — start_dialogue_script dispatcher.
 *
 * WHAT: Single dispatcher for the `start_dialogue_script` tool added
 * 2026-04-30 as the Sonnet-side entry point for the dialogue engine
 * (src/extraction/dialogue-engine/). When Sonnet recognises a
 * structured walk-through entry the engine's regex missed (Deepgram
 * garble, paraphrase, vocabulary the schema author didn't anticipate),
 * Sonnet calls this tool; the dispatcher invokes the engine's
 * `enterScriptByName` to set up state and emit the first ask.
 *
 * WHY a separate sibling (not appended to circuit / observation / board):
 * MAJOR-2 file-isolation rule from Phase 2 — each new dispatcher class
 * gets its own file. Keeps merge surface predictable, mirrors the
 * existing pattern.
 *
 * Wire-emit responsibility: enterScriptByName uses session.activeWs (or
 * the explicit `ws` arg) to send the first ask. The dispatcher passes
 * the per-session WS through `ctx.ws` if available; otherwise the
 * engine's safeSend swallows the no-ws case (test fixtures, audit
 * replays) and the dispatcher still returns a structured envelope.
 *
 * Idempotency: enterScriptByName short-circuits when a script is
 * already active, returning `{ok:true, status:'already_active'}`. The
 * dispatcher passes that through verbatim so Sonnet can call
 * defensively (e.g. alongside the engine's regex entry on the same
 * turn) without breaking the flow.
 */

import { enterScriptByName, ALL_DIALOGUE_SCHEMAS } from './dialogue-engine/index.js';
import { logToolCall } from './stage6-dispatcher-logger.js';

function envelope(tool_use_id, body, is_error) {
  return { tool_use_id, content: JSON.stringify(body), is_error };
}

/**
 * Validate → enterScriptByName → log → envelope.
 *
 * Validation contract (defence-in-depth on top of strict-mode tool
 * schema):
 *   - input.schema must be one of the registered schemas (already
 *     enum-gated by the API; checked here in case of fixture drift).
 *   - input.circuit must be null or a positive integer matching an
 *     existing circuit on the snapshot. Unknown circuit → 'unknown_circuit'
 *     error so Sonnet calls create_circuit first.
 *
 * Outcomes (all mirrored in the log row):
 *   - 'ok'             — engine entered the script, first ask emitted.
 *   - 'already_active' — a script (possibly a different schema) is in
 *                        flight; engine state was NOT touched.
 *   - 'rejected'       — validation failed; tool_result is_error:true.
 *
 * @param {{tool_call_id: string, name: string, input: {schema: string, circuit: ?number, source_turn_id: string, reason: string}}} call
 * @param {{session: object, logger: object, turnId: string, perTurnWrites: object, round: number, ws?: object}} ctx
 */
export async function dispatchStartDialogueScript(call, ctx) {
  const { session, logger, turnId, round, ws } = ctx;
  const input = call.input || {};

  // Resolve the WebSocket the engine should emit the first ask through.
  // The composer in stage6-dispatchers.js doesn't currently thread
  // `ws` into ctx; sessions stash the live WS as `session.activeWs`
  // (set by sonnet-stream.js when it builds the per-turn context).
  // Fall back to ctx.ws for tests / future plumbing.
  const targetWs = ws ?? session.activeWs ?? null;

  const result = enterScriptByName({
    session,
    sessionId: session.sessionId,
    schemas: ALL_DIALOGUE_SCHEMAS,
    schemaName: input.schema,
    circuit_ref: input.circuit ?? null,
    pending_writes: Array.isArray(input.pending_writes) ? input.pending_writes : [],
    ws: targetWs,
    logger,
    now: Date.now(),
  });

  if (!result.ok) {
    logToolCall(logger, {
      sessionId: session.sessionId,
      turnId,
      tool_use_id: call.tool_call_id,
      tool: 'start_dialogue_script',
      round,
      is_error: true,
      outcome: 'rejected',
      validation_error: result.error,
      input_summary: { schema: input.schema, circuit: input.circuit },
    });
    return envelope(call.tool_call_id, { ok: false, error: result.error }, true);
  }

  // Outcome enum is 'ok' | 'noop' | 'rejected' (per stage6-dispatcher-logger.js
  // contract). 'noop' for already_active matches the existing semantic
  // (delete_observation uses noop when the observation id is unknown).
  // The detail of WHICH already-active schema is in the engine's separate
  // `stage6.dialogue_script_already_active` log row (emitted from
  // enterScriptByName), so CloudWatch can join sessionId+turnId to recover
  // the full picture without polluting the tool-call enum.
  logToolCall(logger, {
    sessionId: session.sessionId,
    turnId,
    tool_use_id: call.tool_call_id,
    tool: 'start_dialogue_script',
    round,
    is_error: false,
    outcome: result.status === 'already_active' ? 'noop' : 'ok',
    validation_error: null,
    input_summary: {
      schema: input.schema,
      circuit: input.circuit ?? null,
      reason: input.reason,
    },
  });

  return envelope(
    call.tool_call_id,
    {
      ok: true,
      status: result.status,
      schema: result.schema,
      circuit_ref: result.circuit_ref,
      seeded_writes: result.seeded_writes ?? [],
      queued_writes: result.queued_writes ?? [],
      dropped_fields: result.dropped_fields ?? [],
    },
    false
  );
}
