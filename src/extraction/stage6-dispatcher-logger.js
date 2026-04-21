/**
 * Stage 6 Phase 2 Plan 02-02 — Canonical stage6_tool_call log row emitter.
 *
 * WHAT: `logToolCall(logger, row)` writes exactly one `logger.info` entry
 * tagged `'stage6_tool_call'` with a fixed schema. Research §Q9 defines the
 * schema; STD-11 + STO-01 are the requirement IDs; Phase 7's analyzer
 * (scripts/analyze-session.js) reads these rows to build the tool-call
 * histogram + validation-error count.
 *
 * WHY a dedicated module: six dispatchers across two sibling files (Plans
 * 02-03 + 02-04) plus the barrel's unknown_tool path all need to emit this
 * row. If each wrote its own `logger.info('stage6_tool_call', {...})` we
 * would inevitably drift (phase, round, outcome enum casing). Single source
 * of truth via this helper — change the schema here and every caller updates
 * for free.
 *
 * WHY this helper is INTENTIONALLY DUMB:
 *   1. It does NOT redact `input_summary`. PII discipline is a CALLER
 *      contract — dispatchers in Plans 02-03/04 must NEVER put raw
 *      transcripts, value strings, or free-text fields (location, text,
 *      user_text) into input_summary. If a caller violates this, that is a
 *      caller bug and must be caught in code review, not silently papered
 *      over here. The unit tests in `stage6-dispatcher-logging.test.js` lock
 *      this pass-through contract — if a future dev adds redaction here,
 *      those tests fail and force an explicit review conversation.
 *   2. It does NOT infer `is_error` from `outcome`. Callers must pass both
 *      explicitly. Again, a contract: coupling is_error to outcome here
 *      hides caller bugs where outcome:'rejected' is emitted with
 *      is_error:false (or vice versa).
 *
 * Row shape (Research §Q9):
 *   {
 *     sessionId         : string   // session.sessionId
 *     turnId            : string   // `${sessionId}-turn-${turnNum}` (shadow harness sets this)
 *     tool_use_id       : string   // Anthropic tool_call_id
 *     tool              : string   // 'record_reading' | 'clear_reading' | ... | 'unknown_tool'
 *     round             : number   // tool-loop round index (1-based)
 *     phase             : 2        // set automatically (Phase 2 ships it)
 *     is_error          : boolean  // true iff the tool_result envelope has is_error:true
 *     outcome           : 'ok' | 'noop' | 'rejected'
 *     validation_error  : {code, field?} | null
 *     input_summary     : {field?, circuit?, reason?, code?, observation_id?, circuit_ref?, from_ref?}
 *   }
 */

export function logToolCall(logger, row) {
  const {
    sessionId,
    turnId,
    tool_use_id,
    tool,
    round,
    is_error = false,
    outcome,
    validation_error = null,
    input_summary = {},
  } = row;

  logger.info('stage6_tool_call', {
    sessionId,
    turnId,
    tool_use_id,
    tool,
    round,
    phase: 2,
    is_error,
    outcome,
    validation_error,
    input_summary,
  });
}
