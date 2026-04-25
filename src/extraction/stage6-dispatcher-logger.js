/**
 * Stage 6 dispatcher logger — single-source-of-truth for extraction-path log rows.
 *
 * Observability contract (locked by stage6-dispatcher-logger-restrained.test.js
 * Groups 1-4 — Plan 05-05 / STO-03 / STB-05):
 *   - Each log row name (stage6.ask_user, stage6.restrained_mode, stage6_tool_call,
 *     etc.) has a dedicated helper function with a closed-enum argument where
 *     applicable.
 *   - Phase 8 computes CloudWatch metrics at Insights query time from these rows:
 *       stage6.ask_user_per_session_p50/p95 — via `stats percentile(...)` over
 *         stage6.ask_user rows with answer_outcome='answered' grouped by sessionId.
 *       stage6.restrained_mode_rate — via count_distinct(sessionId with
 *         event='activated') / count_distinct(sessionId) over stage6.restrained_mode.
 *   - DO NOT add percentile / count / histogram computation inside this module —
 *     it runs inside every tool-loop turn; the emit path must stay O(ms).
 *     Repo precedent: src/logger.js is Winston-only; metrics are derived at
 *     query time, never at emit. Phase 5 deliberately ships ZERO PutMetricData
 *     and ZERO EMF — log rows ARE the metric surface.
 *   - Adding a new answer_outcome value requires updating ASK_USER_ANSWER_OUTCOMES
 *     AND the schema-gate tests in stage6-dispatcher-logger-restrained.test.js.
 *   - Adding a new log name requires a new exported helper + closed-enum + schema lock.
 *
 * Phase 5 reserved values in ASK_USER_ANSWER_OUTCOMES (locked):
 *   gated, ask_budget_exhausted, restrained_mode
 * Phase 5 RESTRAINED_MODE_EVENTS:
 *   activated, released
 *
 * Requirements: STO-01, STO-02, STO-03, STB-05.
 *
 * --------------------------------------------------------------------------
 * Stage 6 Phase 2 Plan 02-02 / Phase 3 Plan 03-03 — Stage 6 log row emitters.
 *
 * Two sibling helpers share this module — intentionally co-located because
 * both write Stage 6 log rows consumed by the same Phase 8 analyzer
 * (scripts/analyze-session.js):
 *   - `logToolCall` → `stage6_tool_call`  (Phase 2, STO-01 / STD-11)
 *   - `logAskUser`  → `stage6.ask_user`   (Phase 3, STO-02)
 *   - `logRestrainedMode` → `stage6.restrained_mode` (Phase 5, STO-03)
 *
 * WHAT (logToolCall): `logToolCall(logger, row)` writes exactly one
 * `logger.info` entry tagged `'stage6_tool_call'` with a fixed schema.
 * Research §Q9 defines the schema; STD-11 + STO-01 are the requirement IDs;
 * Phase 7's analyzer reads these rows to build the tool-call histogram +
 * validation-error count.
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

/**
 * Stage 6 Phase 3 Plan 03-03 — `stage6.ask_user` log row emitter (STO-02).
 *
 * WHY a distinct log name (not merged into `stage6_tool_call`): Research §Q9
 * rationale — ask_user is a BLOCKING lifecycle event with answer_outcome
 * semantics that the Phase 8 analyzer (STO-04) and Phase 7 over-ask gate
 * (STR-04) query independently from tool-call histograms. Merging would
 * force every CloudWatch consumer to filter by an `event_type` discriminator
 * and complicate Insights queries. Two names → two clean query planes.
 *
 * WHY the 17-value enum (was 15 pre-r7, 14 pre-prompt-leak, 13 pre-r10, 12 pre-r8, 6 pre-Phase 3): Phase 3 ROADMAP
 * Open Question #1 resolved to expand the enum to cover every lifecycle
 * end-state surfaced by the Phase 3 dispatcher + session-termination flows.
 * Per STG-05 ("weakening requires sign-off"), this is expansion not
 * weakening — every value in STO-02's original 6 is preserved; 7 new values
 * cover states STO-02 did not enumerate (shadow mode, validator rejection,
 * ws.on('close') grace timeout, explicit handleSessionStop, reconnect
 * branch in handleSessionStart, the Pitfall 7 duplicate-tool_call_id guard,
 * and Plan 03-12 r6 reverse-race transcript_already_extracted).
 * Ratified in Phase 3 REVIEW.md.
 *
 * Plan 03-12 r8 BLOCK remediation: added `transcript_already_extracted`.
 * sonnet-stream.js ask_user_answered handler now resolves duplicate frames
 * (where the matching transcript was already extracted as a user turn via
 * the shadow harness) with `{answered:false, reason:'transcript_already_extracted'}`.
 * dispatchAskUser forwards `outcome.reason` verbatim into answer_outcome
 * for logging — without the enum addition, the dispatcher's shape-gate
 * throws `invalid_answer_outcome:transcript_already_extracted` and the
 * tool_result envelope is never returned, leaking the ask into the
 * dispatcher's catch path.
 *
 * Plan 03-12 r10 MAJOR remediation: added `dispatcher_error`. The dispatcher's
 * new outer try/catch (stage6-dispatcher-ask.js step-3 wrapper) emits exactly
 * one STO-02 row with answer_outcome='dispatcher_error' when the live-path
 * Promise setup/await throws unexpectedly (e.g. a resolver threw, register()
 * broke an invariant, a runtime env quirk tore down the Promise). Without
 * this enum addition, the new outer catch would itself crash on the shape-
 * gate (`invalid_answer_outcome:dispatcher_error`) — re-throwing from INSIDE
 * an error-path — and swallow both the original bug AND the logger throw,
 * leaving the session with no STO-02 breadcrumb at all. The enum must stay
 * in lockstep with every answer_outcome the dispatcher can emit.
 *
 * Plan 05-13 r7 BLOCK remediation: split `dispatcher_error` into two
 * lifecycle-keyed values (`dispatcher_error_pre_emit` and
 * `dispatcher_error_post_emit`). The r5↔r6 toggle history (Plan 05-11
 * → Plan 05-12) showed that a single outcome string cannot carry
 * lifecycle position — the SAME envelope reason was classified
 * non-fire (initial), fire (r5), and non-fire (r6) across three
 * successive rounds based on lifecycle assumption alone. r7 closes
 * the toggle problem permanently by encoding lifecycle position into
 * the outcome NAME itself.
 *
 * Current emit sites (post-r7):
 *   - stage6-dispatcher-ask.js outer catch (line 341): emits
 *     `dispatcher_error_pre_emit`. The schema audit preserved in the
 *     wrapper's _WRAPPER_SHORT_CIRCUIT_REASONS audit block confirms
 *     this catch is structurally pre-emit (register rethrow at line
 *     297 is BEFORE ws.send line 305; ws.send failures are caught +
 *     swallowed in an inner try/catch that never reaches the outer
 *     catch; no synchronous post-send work exists).
 *   - stage6-ask-gate-wrapper.js timer-catch (line ~302): emits
 *     `dispatcher_error_pre_emit` when the inner dispatcher throws
 *     (always pre-emit because the only inner-throw path is the
 *     register rethrow above).
 *
 * Reserved (no current emit site):
 *   - `dispatcher_error_post_emit`: for any future refactor that adds
 *     synchronous post-emit code (post-`ws.send` analytics, post-send
 *     registry update, etc.) that can throw and reach the same outer
 *     catch. The new emit site MUST use the `_post_emit` name (NOT
 *     reclassify `_pre_emit`) so historical analyzer queries on the
 *     existing names stay stable across the change. Classifier shape:
 *     - dispatcher_error_pre_emit  → in _PRE_EMIT_NON_FIRE_REASONS (non-fire)
 *     - dispatcher_error_post_emit → in NEITHER set (default fire branch)
 *
 * Legacy back-compat:
 *   - `dispatcher_error` (Plan 03-12 r10) stays in the enum for
 *     archived log row deserialisation. No active emit site post-r7.
 *     Classifier treats it as ambiguous-legacy (NOT a member of either
 *     pre-emit set → fire-default via isRealFire's fallthrough branch).
 *     Conservative direction matches r5's reasoning for unknown-
 *     lifecycle envelopes.
 */
// Plan 05-05 — Object.freeze applied so runtime .push/.pop cannot silently
// widen the closed enum. The freeze is a STRUCTURAL guarantee that pairs
// with the Group 1 schema-gate test in
// stage6-dispatcher-logger-restrained.test.js — without freeze, a future
// r-round could mutate the array via `.push(...)` and the closed-enum
// gate at logAskUser line 195 would still accept the new value, but
// Phase 8's CloudWatch Insights queries would split on a value that
// drifted from the dashboard schema. RESTRAINED_MODE_EVENTS (Plan 05-04)
// already shipped freeze'd; this brings ASK_USER_ANSWER_OUTCOMES +
// ASK_USER_MODES into parity.
export const ASK_USER_ANSWER_OUTCOMES = Object.freeze([
  // STO-02 original 6 (Phase 5 will emit restrained_mode / ask_budget_exhausted / gated — reserved now)
  'answered',
  'timeout',
  'user_moved_on',
  'restrained_mode',
  'ask_budget_exhausted',
  'gated',
  // Phase 3 expansion (6)
  'shadow_mode',
  'validation_error',
  'session_terminated',
  'session_stopped',
  'session_reconnected',
  'duplicate_tool_call_id',
  // Plan 03-12 r8 expansion (1): reverse-race path resolves with this reason
  'transcript_already_extracted',
  // Plan 03-12 r10 expansion (1): outer try/catch in dispatchAskUser emits
  // this when the live-path Promise setup/await throws unexpectedly.
  // Plan 05-13 r7 — LEGACY at this point. No active emit site post-r7
  // (every current emit renamed to dispatcher_error_pre_emit). Stays
  // in the enum so logAskUser's invalid_answer_outcome gate accepts
  // archived log rows shipped pre-r7. Classifier treats unknown-
  // lifecycle envelopes carrying this reason as fire-default.
  'dispatcher_error',
  // Plan 04-26 Layer 2 — prompt-leak filter blocked the ask_user
  // pre-register because the model's question contained system-prompt
  // disclosure content. No iOS TTS emission, no registry register,
  // no STA-03 wait — just one audited row for the Phase 8 analyzer.
  'prompt_leak_blocked',
  // Plan 05-13 r7 — lifecycle-keyed split of legacy `dispatcher_error`.
  // `_pre_emit` is the active emit site post-r7 (stage6-dispatcher-ask.js
  // outer catch + stage6-ask-gate-wrapper.js timer-catch). Pre-emit
  // non-fire — register rethrow happens BEFORE ws.send, so the ask
  // never reached iOS. See _PRE_EMIT_NON_FIRE_REASONS in
  // stage6-ask-gate-wrapper.js for classifier membership.
  'dispatcher_error_pre_emit',
  // Plan 05-13 r7 — RESERVED for future post-emit code paths. Not
  // emitted at r7 closure; pre-registered so a future refactor adding
  // post-emit synchronous work that can throw + reach the same outer
  // catch can emit this name and the classifier is already wired
  // correctly (in NEITHER pre-emit set → fire by default — correct
  // for post-emit lifecycle where the user has seen ask_user_started).
  // Parallel to Plan 05-11 r5-#2's pre-registration of
  // `gate_dispatcher_error` in _WRAPPER_SHORT_CIRCUIT_REASONS.
  'dispatcher_error_post_emit',
]);

// Plan 03-12 r19 MINOR remediation — closed enum for the `mode` field.
// STR-04 + Phase 8 observability queries split logs by mode; a typo at
// any caller ('Shadow' / 'production' / 'ghost') would silently corrupt
// the split with zero loud surface. Validate at the emit site.
// Plan 05-05 — Object.freeze applied for parity with ASK_USER_ANSWER_OUTCOMES;
// see freeze rationale on the constant above.
export const ASK_USER_MODES = Object.freeze(['shadow', 'live']);

const ASK_USER_QUESTION_LOG_MAX = 200;

function truncateQuestion(text, max) {
  if (typeof text !== 'string') return text;
  if (text.length <= max) return text;
  // Reserve 1 char for the ellipsis so the emitted string is exactly `max` chars.
  return text.slice(0, max - 1) + '…';
}

/**
 * Emit `stage6.ask_user` log row per STO-02.
 *
 * Contract:
 *   - `sessionId`, `turnId`, `tool_call_id`, `answer_outcome`, `mode` are REQUIRED.
 *     Missing any → throws `missing_required_field:<name>` (bug surface — never silent).
 *   - `answer_outcome` must be in `ASK_USER_ANSWER_OUTCOMES`; otherwise throws
 *     `invalid_answer_outcome:<value>`.
 *   - `question` is truncated to 200 chars with '…' suffix when it would exceed
 *     the cap. Chosen to prevent CloudWatch row-size blow-up on long user
 *     questions — caller does not need to know the cap.
 *   - `wait_duration_ms` defaults to 0 when absent (covers shadow-mode + gated
 *     paths where nothing was ever awaited).
 *   - `user_text` and `validation_error` are optional; the emitted row omits
 *     them entirely when undefined (rather than writing `null`) so downstream
 *     CloudWatch Insights queries can use `filter ispresent(user_text)` as
 *     shorthand for "a real answer was captured".
 *
 * TODO (Phase 8, STR-05 — ROADMAP Open Question #2): apply retention-based
 * redaction to `user_text` (and any 'raw_text' tail on `question`) at the
 * analyzer/query layer. Raw text is retained in Phase 3 to keep the feedback
 * loop tight during the shadow-mode observation window. Do NOT add redaction
 * here — PII policy is enforced at the query/retention boundary, not at the
 * emit site. This matches the `logToolCall` philosophy (callers own PII).
 */
export function logAskUser(logger, payload) {
  const required = ['sessionId', 'turnId', 'tool_call_id', 'answer_outcome', 'mode'];
  for (const k of required) {
    if (payload?.[k] === undefined || payload[k] === null) {
      throw new Error(`missing_required_field:${k}`);
    }
  }
  if (!ASK_USER_ANSWER_OUTCOMES.includes(payload.answer_outcome)) {
    throw new Error(`invalid_answer_outcome:${payload.answer_outcome}`);
  }
  // r19 MINOR — mode must be one of the closed enum values. Parallels
  // the answer_outcome gate above so both splits used by STR-04 and
  // Phase 8 analysis are typo-hardened.
  if (!ASK_USER_MODES.includes(payload.mode)) {
    throw new Error(`invalid_mode:${payload.mode}`);
  }

  const row = {
    sessionId: payload.sessionId,
    turnId: payload.turnId,
    phase: 3,
    mode: payload.mode,
    tool_call_id: payload.tool_call_id,
    question: truncateQuestion(payload.question ?? '', ASK_USER_QUESTION_LOG_MAX),
    reason: payload.reason ?? null,
    context_field: payload.context_field ?? null,
    context_circuit: payload.context_circuit ?? null,
    answer_outcome: payload.answer_outcome,
    wait_duration_ms: payload.wait_duration_ms ?? 0,
  };
  if (payload.user_text !== undefined) row.user_text = payload.user_text;
  if (payload.validation_error !== undefined) row.validation_error = payload.validation_error;
  // Plan 03-10 Task 2 — sanitisation sub-object {truncated, stripped}
  // forwarded verbatim when the caller sets it. Kept dumb (single source of
  // truth on the sanitiser semantics is in stage6-sanitise-user-text.js;
  // this helper is still a pass-through shape gate, per module docstring).
  if (payload.sanitisation !== undefined) row.sanitisation = payload.sanitisation;
  // Plan 03-12 r10 — forward dispatcher_error diagnostic string when the
  // outer try/catch in dispatchAskUser logged this row. Kept optional so
  // the common happy path does not carry a null field. Caller owns the
  // string (err.code || err.message || String(err) convention).
  if (payload.dispatcher_error !== undefined) row.dispatcher_error = payload.dispatcher_error;

  logger.info('stage6.ask_user', row);
}

/**
 * Stage 6 Phase 5 Plan 05-04 — `stage6.restrained_mode` lifecycle log row
 * emitter (STA-05, STO-03).
 *
 * Two events fire per activation cycle:
 *   - `activated` on entering active state (the rolling 5-turn window
 *     accumulated triggerCount asks) — emitted from the activeSessions
 *     entry's onActivate callback in sonnet-stream.js.
 *   - `released`  on the wall-clock 60s expiry — emitted from the
 *     onRelease callback. NOT emitted on destroy() (destroy is silent
 *     per Plan 05-04 §Group 5 lock).
 *
 * WHY a CLOSED enum (not free-form string): Phase 8 dashboards split
 * by `event` value to compute restrained_mode_rate per session. A typo
 * at any caller ('actived', 'unlocked', 'expired') would silently
 * corrupt the split with zero loud surface. Validate at the emit site.
 * Same discipline as ASK_USER_ANSWER_OUTCOMES (Phase 3 r10 STG
 * remediation) and ASK_USER_MODES (Phase 3 r19 MINOR remediation).
 *
 * WHY trigger_ask_count defaults to null (not omitted): the released
 * path doesn't carry an ask count, but consumers query
 * `filter ispresent(trigger_ask_count)` as shorthand for "this row
 * marks an activation". Emitting null keeps the field present with a
 * deterministic missing-value sentinel — same idiom as
 * `validation_error: payload.validation_error ?? null` in logToolCall.
 *
 * WHY this helper does NOT log emittedAt itself outside the row body:
 * logger.info adds its own timestamp via the structured-log adapter
 * (Phase 1 logger.js convention). The in-row emittedAt is a SECOND
 * timestamp recorded at the helper's wall-clock — useful for cross-
 * checking row interleaving when the logger's transport buffers (e.g.
 * Winston's batched flush). Same pattern as logAskUser, kept for
 * Phase 8 query-plan parity.
 */
export const RESTRAINED_MODE_EVENTS = Object.freeze(['activated', 'released']);

export function logRestrainedMode(
  logger,
  { sessionId, turnId, event, triggerAskCount, windowTurns, releaseMs }
) {
  if (!RESTRAINED_MODE_EVENTS.includes(event)) {
    throw new Error(`invalid_restrained_mode_event:${event}`);
  }
  logger.info('stage6.restrained_mode', {
    sessionId,
    turnId: turnId ?? null,
    phase: 5,
    event,
    trigger_ask_count: triggerAskCount ?? null,
    window_turns: windowTurns,
    release_ms: releaseMs,
    emittedAt: new Date().toISOString(),
  });
}
