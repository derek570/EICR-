/**
 * Stage 6 Phase 5 Plan 05-01 — higher-order ask-dispatcher gate wrapper.
 *
 * WHAT: Composes the four Phase 5 gates around the unmodified Plan 03-05
 * `createAskDispatcher` return value. The four gates fire in strict order
 * for every model-emitted ask_user tool_use:
 *
 *   1. filledSlotsShadow (Plan 05-02 — side-effect logging only)
 *   2. restrainedMode.isActive() short-circuit (Plan 05-04)
 *   3. askBudget.isExhausted(key) short-circuit (Plan 05-03)
 *   4. gate.gateOrFire — 1500ms debounce; same-key replacement
 *      resolves the FIRST call with reason='gated'
 *   5. Counters increment ONLY on a successful inner-dispatcher fire
 *      (Pitfall 4) — short-circuited asks must NOT consume budget or
 *      restrained-window slot.
 *
 * WHY composition-over-mutation: STB-05 demands "no existing guard
 * weakened". Editing stage6-dispatcher-ask.js would re-open Codex's
 * Plan 03-05 review surface and risk regressing the deferred-Promise
 * lifecycle the registry depends on. Instead the wrapper imports the
 * dispatcher's RETURN VALUE as a black-box closure and bolts the new
 * gates around it. Codex grep target `git diff stage6-phase5-base --
 * src/extraction/stage6-dispatcher-ask.js` is REQUIRED to be empty.
 *
 * WHY the 1500ms delay is imported (not inlined): single-source-of-truth
 * with question-gate.js. If the production tuning ever moves again
 * (history: 2500→1500 in commit b606e21, 2026-04-20 after a TTS-latency
 * field bug), the wrapper follows automatically. ROADMAP §Phase 5 SC #1
 * still references 2500ms — that wording is stale; QUESTION_GATE_DELAY_MS
 * is the truth.
 *
 * WHY filledSlotsShadow runs FIRST regardless of downstream short-circuit
 * (Open Question #5 in 05-RESEARCH.md): Phase 7 retirement analysis needs
 * a complete trace of every ask the model EMITTED, not just the asks that
 * survived the gate. A pre-wrapper shadow log maximises signal — Phase 8
 * dashboards split asks by the suppression reason exactly because the
 * model's intent matters separately from the wrapper's response.
 *
 * Requirements: STB-01 (gate wraps every dispatch), STB-04 (budget enforced
 * in dispatcher, not post-hoc), STB-05 (no guard weakened — composition).
 */

import { QUESTION_GATE_DELAY_MS } from './question-gate.js';
import { logAskUser } from './stage6-dispatcher-logger.js';

/**
 * Normalise an ask_user input's (context_field, context_circuit) into a
 * budget/gate key. Null and undefined both collapse to sentinel '_' to
 * prevent the null-bypass pitfall (Research §Pitfall 3 — without the
 * sentinel a null-context ask derives a different key from a 0-circuit
 * ask, side-stepping the budget for the same logical question).
 *
 * Exported so Plan 05-03's tests can reference the same key shape and
 * future plans (05-02 filled-slots shadow, 05-06 exit harness) keep their
 * key derivation in lockstep.
 *
 * Plan 05-08 r2-#2 / Plan 05-09 r3-#3 / Plan 05-10 r4-#1 — context_field
 * canonicalisation.
 *   stage6-tool-schemas.js:327 documents the context_field enum as
 *   admitting BOTH `null` AND the literal string sentinel `"none"` for
 *   scope-less asks: "...or the sentinel "none" (equivalently null) for
 *   scope-less asks." Pre-r2 deriveAskKey produced different keys for
 *   the two forms ("none:N" vs "_:N"), allowing an attacker (or a buggy
 *   prompt) to alternate representations and bypass the per-key budget
 *   for the same logical question.
 *
 *   r2-#2 closure: collapse the canonical sentinel `'none'` (any case)
 *   to '_'. Real field values are NOT case-folded — `'Ze'` !== `'ze'`.
 *   The validator owns canonical case for real values; collapsing here
 *   would mask a typo bug whose right surface is the validator's enum
 *   check. Case-insensitivity is SENTINEL-ONLY.
 *
 *   r3-#3 narrowed the case match to verbatim lowercase 'none' on the
 *   argument that the real validator at stage6-dispatch-validation.js:204
 *   is case-SENSITIVE
 *   (`!CONTEXT_FIELD_ENUM.includes(input.context_field)` rejects
 *   upper-case forms upstream as `invalid_context_field`) so the
 *   case-insensitive branch in deriveAskKey was "dead code that encoded
 *   a contract divergence".
 *
 *   r4-#1 REVERSES r3-#3 because that argument was wrong. ORDER MATTERS.
 *   wrapAskDispatcherWithGates (below in this file) calls deriveAskKey
 *   at the line:
 *       const key = deriveAskKey(call.input);
 *   to compute the budget + debounce key, BEFORE the inner dispatcher's
 *   validateAskUser runs. So under r3-#3's case-sensitive matching, a
 *   payload alternating cases ([null,'NONE','None',null] for circuit 7)
 *   produced 4 DISTINCT keys at the wrapper layer:
 *     - '_:7' (null)
 *     - '_:7' (lowercase 'none')
 *     - 'NONE:7'
 *     - 'None:7'
 *   so the per-key budget had three independent buckets and the 1500ms
 *   debounce never collapsed any of them. The validator correctly
 *   rejected each malformed call with validation_error → wrapper
 *   classifies as PRE_EMIT_NON_FIRE_REASONS → no budget burn → BUT the
 *   wrapper's protective debounce + per-key budget gates were bypassed.
 *   Sonnet had effectively obtained an unlimited debounce window for
 *   cross-case retries within a single turn.
 *
 *   r4-#1 fix: case-insensitive matching for the literal sentinel string
 *   'none'. Every case form (`'NONE'`, `'None'`, `'nOnE'`, etc.)
 *   collapses to the canonical '_' bucket so the wrapper's same-key
 *   debounce + per-key budget catch case-alternation BEFORE the inner
 *   dispatcher's validator can reject. This is DEFENCE-IN-DEPTH at the
 *   wrapper layer; it does NOT widen the validator's contract (validator
 *   still rejects upper-case forms with invalid_context_field, the
 *   wrapper now correctly classifies that envelope as
 *   PRE_EMIT_NON_FIRE_REASONS → no budget burn).
 *
 *   The earlier dead-code argument was wrong because it conflated TWO
 *   different concerns: (1) what inputs the validator admits as
 *   well-formed (case-sensitive — only lowercase 'none'); (2) what
 *   inputs the wrapper's KEY DERIVATION should bucket together
 *   (case-insensitive — every spelling of 'none' is the same logical
 *   scope). Concern 1 is the validator's contract; concern 2 is the
 *   wrapper's protection contract. They operate on different axes.
 *
 *   Decision 05-09-D3 (Option A — narrow wrapper to validator's
 *   verbatim contract) is REVERSED at Plan 05-10 D2 (case-insensitive
 *   sentinel-only normalisation as defence-in-depth at the wrapper).
 *
 *   context_circuit canonicalisation is INTENTIONALLY narrower:
 *   stage6-tool-schemas.js:329 documents only `null` as the sentinel
 *   ("Circuit_ref this ask is scoped to, or null if the ask is board-
 *   or installation-wide."). `0` is a valid integer with no documented
 *   sentinel meaning, and the existing Group 1 test asserts that
 *   `{field:'ze', circuit:0}` derives to `'ze:0'` (not `'ze:_'`). We
 *   preserve that — collapsing `0` would silently shift every existing
 *   per-key budget bucket and is out of scope for r2-#2 / r4-#1.
 *
 * @param {{ context_field?: string|null, context_circuit?: number|null }} input
 * @returns {string}
 */
export function deriveAskKey(input) {
  const fieldRaw = input?.context_field;
  // Plan 05-08 r2-#2 + Plan 05-10 r4-#1 + Plan 05-11 r5-#1 — collapse
  // `null`, `undefined`, AND the literal sentinel `"none"` (case- AND
  // whitespace-INSENSITIVE) to '_'. Both normalisations are
  // SENTINEL-ONLY — real (non-sentinel) field values pass through
  // verbatim (case + whitespace preserved) so a typo / drift bug
  // surfaces in the analyzer rather than silently bucketing
  // wrong-case or padded real values together.
  //
  // Why case-insensitive at the wrapper layer (Plan 05-10 r4-#1):
  // wrapAskDispatcherWithGates below in this file calls
  // deriveAskKey() BEFORE the inner dispatcher's validateAskUser
  // runs. Case-sensitive matching here let alternating sentinel cases
  // ([null,'NONE','None',null]) derive distinct keys at the wrapper,
  // bypassing the wrapper's same-key debounce + per-key budget gates
  // even though each call was later rejected as validation_error.
  //
  // Why ALSO trim-insensitive (Plan 05-11 r5-#1): same lifecycle
  // argument — `fieldRaw.toLowerCase() === 'none'` (the r4-#1 form)
  // doesn't catch ` none `, `\tNONE\n`, ` None`. The validator at
  // stage6-dispatch-validation.js:204 is strict membership against
  // CONTEXT_FIELD_ENUM — no trim, no fold. Whitespace-padded forms
  // are rejected upstream as invalid_context_field (pre-emit
  // non-fire, no budget burn at validation), BUT the WRAPPER's
  // protective debounce + per-key budget never fired during the
  // pre-validation key derivation. Same bypass shape as r4-#1 but
  // through whitespace alternation instead of case alternation.
  // Defence-in-depth at the wrapper layer.
  //
  // Real (non-sentinel) values are NOT trimmed and NOT case-folded —
  // a malformed `'  ze  '` derives `' ze :N'` so the validator's
  // enum-check sees the drift and the analyzer can flag it. Trimming
  // here would silently mask a typo bug whose right surface is the
  // strict membership check.
  //
  // The validator's case-sensitivity is the validator's contract; the
  // wrapper's case + whitespace insensitivity is defence-in-depth on
  // a different axis (key bucketing, not input admission).
  let field;
  if (fieldRaw === null || fieldRaw === undefined) {
    field = '_';
  } else if (typeof fieldRaw === 'string' && fieldRaw.trim().toLowerCase() === 'none') {
    field = '_';
  } else {
    field = fieldRaw;
  }
  const circuit = input?.context_circuit ?? '_';
  return `${field}:${circuit}`;
}

/**
 * Build a synthetic short-circuit envelope that matches the inner
 * dispatcher's "answered: false" shape EXACTLY (`{tool_use_id, content,
 * is_error}` with `content` a JSON string carrying `{answered:false, reason}`).
 * Also emits one `stage6.ask_user` STO-02 log row per attempted ask so
 * the Phase 8 analyzer sees a complete audit trail — every reason the
 * wrapper short-circuits is already a reserved value in
 * ASK_USER_ANSWER_OUTCOMES (`gated`, `restrained_mode`, `ask_budget_exhausted`,
 * `session_terminated`).
 *
 * Reads `tool_call_id` from BOTH `call.tool_call_id` and `call.id` to match
 * the dispatcher's union (stage6-dispatcher-ask.js:116) — runToolLoop
 * dispatches with `{tool_call_id,...}` while unit tests pass `{id,...}`.
 *
 * Plan 05-07 r1-#3: `mode` is now a REQUIRED parameter (was hard-coded
 * 'live'). Callers in createAskGateWrapper + wrapAskDispatcherWithGates
 * pass through their own opt; both default to 'live' so existing call
 * sites are unaffected. runShadowHarness explicitly passes 'shadow' when
 * composing the wrapper inside the shadow path so wrapper-emitted log
 * rows match the session's actual mode (Phase 8 dashboards split by mode
 * — corrupting that split with hard-coded 'live' was the r1-#3 finding).
 *
 * @param {object} call
 * @param {string} reason  Must be one of ASK_USER_ANSWER_OUTCOMES.
 * @param {object} ctx     Must carry sessionId + turnId.
 * @param {object} logger
 * @param {string} sessionId
 * @param {'live'|'shadow'} mode  ASK_USER_MODES enum.
 * @returns {{ tool_use_id: string, content: string, is_error: false }}
 */
function synthResultWrapped(call, reason, ctx, logger, sessionId, mode) {
  const toolCallId = call.tool_call_id ?? call.id;
  logAskUser(logger, {
    sessionId,
    turnId: ctx.turnId,
    mode,
    tool_call_id: toolCallId,
    question: call.input?.question ?? '',
    reason: call.input?.reason ?? null,
    context_field: call.input?.context_field ?? null,
    context_circuit: call.input?.context_circuit ?? null,
    answer_outcome: reason,
    wait_duration_ms: 0,
  });
  return {
    tool_use_id: toolCallId,
    content: JSON.stringify({ answered: false, reason }),
    is_error: false,
  };
}

/**
 * Plan 05-14 r8-#1 — sibling helper that builds the wrapper synth
 * envelope WITHOUT calling `logAskUser`.
 *
 * WHY a separate helper: every wrapper-OWNED short-circuit reason
 * (`gated`, `restrained_mode`, `ask_budget_exhausted`,
 * `session_terminated`) has the wrapper as the SOLE emitter — the
 * inner dispatcher never sees those calls, so the wrapper logs the
 * one and only `stage6.ask_user` row for that ask. `synthResultWrapped`
 * is the right helper for those paths.
 *
 * The exception is the timer-catch at line ~316 below: when the
 * inner dispatcher throws and its outer catch
 * (`stage6-dispatcher-ask.js` line ~352-364) has ALREADY called
 * `logAskUser(...)` before rethrowing, the wrapper's job here is to
 * recover from the throw with a properly-shaped envelope so the
 * awaiter is not stranded — but a second `logAskUser(...)` call
 * would emit a DUPLICATE row carrying the same answer_outcome +
 * tool_call_id but a `wait_duration_ms` of 0 (instead of the real
 * wait the dispatcher recorded). Analyzer queries on
 * `stage6.ask_user` would then over-state failure rates 2x.
 *
 * r8-#1 closure routes the timer-catch through this non-logging
 * helper so the dispatcher's outer catch stays the sole emitter
 * for the inner-throw path, producing exactly ONE row total.
 *
 * Same envelope shape as `synthResultWrapped`: `{tool_use_id,
 * content, is_error}` with `content` = JSON-encoded
 * `{answered:false, reason}`. The model-side runToolLoop contract
 * is unchanged.
 *
 * @param {object} call
 * @param {string} reason  Must still be a recognised
 *   ASK_USER_ANSWER_OUTCOMES value (the inner dispatcher's outer
 *   catch already logged with the same outcome — keeping the names
 *   in lockstep avoids a future split where one emitter uses one
 *   name and another emitter uses a different name for the same
 *   semantic event).
 * @returns {{ tool_use_id: string, content: string, is_error: false }}
 */
function synthResultWithoutLog(call, reason) {
  const toolCallId = call.tool_call_id ?? call.id;
  return {
    tool_use_id: toolCallId,
    content: JSON.stringify({ answered: false, reason }),
    is_error: false,
  };
}

/**
 * Per-turn debounce engine. Maintains a private `Map<key, entry>` of pending
 * timers. Same-key arrivals within `delayMs` cancel the pending timer and
 * REPLACE it (Research §Q10 scenario 3 — without explicit replacement the
 * first call's outer Promise would dangle forever; we resolve it with
 * `synthResult(call, 'gated')` at replacement time).
 *
 * Different keys keep their own timers (scenario 2). `destroy()` cancels
 * every pending timer and resolves outstanding promises with
 * `reason='session_terminated'` so callers waiting on a turn that just
 * died are not orphaned.
 *
 * Plan 05-07 r1-#3: `mode` opt added — defaults to 'live' so every existing
 * caller's behaviour is unchanged. runShadowHarness passes mode:'shadow'
 * when composing the wrapper inside the shadow path; the gate's `gated`
 * + `dispatcher_error_pre_emit` (post-r7; was `dispatcher_error` through
 * Plan 05-12 r6) + `session_terminated` short-circuit rows then carry
 * the correct mode.
 *
 * @param {object} opts
 * @param {number} [opts.delayMs=QUESTION_GATE_DELAY_MS]  Debounce window.
 * @param {object} opts.logger
 * @param {string} opts.sessionId
 * @param {'live'|'shadow'} [opts.mode='live']  Mode threaded into wrapper-
 *   emitted log rows. Defaults to 'live' for back-compat.
 */
export function createAskGateWrapper({
  delayMs = QUESTION_GATE_DELAY_MS,
  logger,
  sessionId,
  mode = 'live',
}) {
  /** @type {Map<string, { timer: any, pendingCall: object, pendingCtx: object, pendingResolve: Function }>} */
  const pending = new Map();

  function gateOrFire(call, ctx, innerDispatcher) {
    const key = deriveAskKey(call.input);
    return new Promise((resolve) => {
      const existing = pending.get(key);
      if (existing) {
        // Scenario 3 (Research §Q10) — replace. Resolve the FIRST call's
        // outer Promise with a `gated` synthResult, then take its slot.
        clearTimeout(existing.timer);
        pending.delete(key);
        existing.pendingResolve(
          synthResultWrapped(
            existing.pendingCall,
            'gated',
            existing.pendingCtx,
            logger,
            sessionId,
            mode
          )
        );
      }

      const timer = setTimeout(async () => {
        pending.delete(key);
        try {
          const result = await innerDispatcher(call, ctx);
          resolve(result);
        } catch {
          // Inner dispatcher should never throw (its own outer try/catch in
          // dispatchAskUser rolls every error into a logged envelope), but
          // we guard the wrapper anyway — a runtime quirk inside the
          // dispatcher must not strand the awaiter forever.
          //
          // Plan 05-13 r7 — emits 'dispatcher_error_pre_emit' (was
          // 'dispatcher_error' through Plan 05-12 r6). The only
          // inner-throw path that reaches here today is the inner
          // dispatcher's outer catch (stage6-dispatcher-ask.js line
          // 321) rethrowing after its own pre-emit `register()`
          // failure at line 297 — so this synth envelope is also
          // pre-emit. The `_pre_emit` suffix encodes the lifecycle
          // position structurally; future post-emit code paths
          // requiring a different classification must emit
          // `dispatcher_error_post_emit` (enum-reserved in
          // stage6-dispatcher-logger.js's ASK_USER_ANSWER_OUTCOMES;
          // lives in NEITHER pre-emit set → fire-default).
          //
          // Plan 05-14 r8-#1 — route through `synthResultWithoutLog`
          // instead of `synthResultWrapped`. The inner dispatcher's
          // outer catch ALREADY called `logAskUser(...)` before
          // rethrowing (stage6-dispatcher-ask.js line ~361), so
          // a second `logAskUser(...)` here would emit a DUPLICATE
          // `stage6.ask_user` row carrying the same answer_outcome +
          // tool_call_id but `wait_duration_ms: 0` (instead of the
          // real wait the dispatcher recorded). Analyzer queries
          // would over-state failure rates 2x. The wrapper's job
          // here is recovery (a properly-shaped envelope so the
          // awaiter is not stranded), NOT a second emit. The
          // dispatcher remains the sole emitter for the inner-throw
          // path; the wrapper produces zero rows on this path.
          //
          // Plan 05-14 r8-#2 — `'dispatcher_error'` (was
          // `'dispatcher_error_pre_emit'` post-r7). r8-#2 reverted
          // the wire-schema rename and layered lifecycle position
          // as a separate log-row field at the dispatcher's outer
          // catch — the wrapper synthesises the wire-schema name
          // verbatim so the envelope `body.reason` matches the
          // closed-enum value the classifier and downstream consumers
          // expect.
          resolve(synthResultWithoutLog(call, 'dispatcher_error'));
        }
      }, delayMs);

      pending.set(key, {
        timer,
        pendingCall: call,
        pendingCtx: ctx,
        pendingResolve: resolve,
      });
    });
  }

  function destroy() {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.pendingResolve(
        synthResultWrapped(
          entry.pendingCall,
          'session_terminated',
          entry.pendingCtx,
          logger,
          sessionId,
          mode
        )
      );
    }
    pending.clear();
  }

  return { gateOrFire, destroy };
}

/**
 * Higher-order composer. Returns a new dispatcher with the same signature
 * as `createAskDispatcher`'s closure (`(call, ctx) => Promise<{tool_use_id,
 * content, is_error}>`) but with the four Phase 5 gates bolted on in the
 * order documented at the module top.
 *
 * The branch that wires this composer is in stage6-shadow-harness.js —
 * runShadowHarness wraps `createAskDispatcher(...)` ONLY when
 * `options.askBudget` AND `options.restrainedMode` are both truthy, so
 * existing Phase 1/2/3/4 callers (which thread neither) keep their
 * pre-Phase-5 behaviour unchanged.
 *
 * Plan 05-07 r1-#3: `mode` opt added — defaults to 'live' so every existing
 * caller's behaviour is unchanged. runShadowHarness passes mode:'shadow'
 * so wrapper-emitted `restrained_mode` + `ask_budget_exhausted` log rows
 * carry the correct mode (Phase 8 dashboards split by mode).
 *
 * @param {(call, ctx) => Promise<{tool_use_id: string, content: string, is_error: boolean}>} innerDispatcher
 * @param {object} opts
 * @param {{ isExhausted: (key:string)=>boolean, increment: (key:string)=>void }} opts.askBudget
 * @param {{ isActive: ()=>boolean, recordAsk: (turnId:string)=>void }} opts.restrainedMode
 * @param {{ gateOrFire: Function, destroy: Function }} opts.gate
 * @param {(call, ctx)=>void} [opts.filledSlotsShadow]  Side-effect-only logger; defaults to no-op.
 * @param {object} opts.logger
 * @param {string} opts.sessionId
 * @param {'live'|'shadow'} [opts.mode='live']  Threaded into wrapper-emitted
 *   log rows (`restrained_mode`, `ask_budget_exhausted`). Defaults to 'live'.
 * @returns {(call, ctx) => Promise<{tool_use_id: string, content: string, is_error: boolean}>}
 */
export function wrapAskDispatcherWithGates(
  innerDispatcher,
  { askBudget, restrainedMode, gate, filledSlotsShadow, logger, sessionId, mode = 'live' }
) {
  return async function dispatchAskUserGated(call, ctx) {
    // (1) Shadow-log FIRST, regardless of downstream outcome.
    // Open Question #5 — Phase 7 retirement analysis needs the full trace
    // of every ask the model EMITTED, not just the asks that survived the
    // gate. Errors in the shadow logger MUST NOT tear down dispatch (Plan
    // 05-02 owns the adapter; here we just guard the call site).
    try {
      filledSlotsShadow?.(call, ctx);
    } catch {
      /* shadow must not tear down dispatch */
    }

    const key = deriveAskKey(call.input);

    // (2) Restrained-mode short-circuit. The state machine in Plan 05-04
    // is session-wide (not per-turn), so isActive() takes no arg.
    if (restrainedMode.isActive()) {
      return synthResultWrapped(call, 'restrained_mode', ctx, logger, sessionId, mode);
    }

    // (3) Per-key budget short-circuit. STA-06 cap = 2 (default in
    // stage6-ask-budget.js). Pre-fire check; the increment fires only
    // after a successful inner dispatch (step 5 below).
    if (askBudget.isExhausted(key)) {
      return synthResultWrapped(call, 'ask_budget_exhausted', ctx, logger, sessionId, mode);
    }

    // (4) Debounce gate. Inside gateOrFire, the inner dispatcher runs on
    // timer expiry — or the outer Promise short-circuits with reason='gated'
    // if a same-key call replaces this one within delayMs.
    const gated = await gate.gateOrFire(call, ctx, innerDispatcher);

    // (5) Post-dispatch counter updates — Pitfall 4 protection.
    // Non-fire reasons MUST NOT consume budget or restrained-window slot.
    // Two categories of non-fire (see `isRealFire` below):
    //   - Wrapper short-circuit non-fires: `gated`, `session_terminated`,
    //     `gate_dispatcher_error` (reserved). Wrapper emits these from
    //     its own pre-dispatch / pre-emit code paths.
    //   - Inner-dispatcher pre-emit non-fires: `validation_error`,
    //     `duplicate_tool_call_id`, `prompt_leak_blocked`, `shadow_mode`,
    //     `dispatcher_error_pre_emit` (Plan 05-13 r7 — replaced legacy
    //     `dispatcher_error` to encode lifecycle position structurally;
    //     current source has only pre-emit code paths reaching the
    //     outer catch at line 321 of stage6-dispatcher-ask.js, and the
    //     wrapper's own timer-catch at line ~302 below — both emit the
    //     `_pre_emit` name post-r7). Reserved sibling
    //     `dispatcher_error_post_emit` lives in NEITHER pre-emit set
    //     → fire-default for any future post-emit code.
    // Real fires are everything else: `answered:true`, `timeout`,
    // `user_moved_on`, `session_*`, `transcript_already_*` — Sonnet
    // probed the user, so the budget slot is consumed.
    if (isRealFire(gated)) {
      askBudget.increment(key);
      restrainedMode.recordAsk(ctx.turnId);
    }

    return gated;
  };
}

/**
 * Classify a wrapper-return envelope as a "real fire" (counters increment)
 * vs a wrapper-emitted short-circuit (counters DO NOT increment).
 *
 * Real fire iff: the envelope's content parses to `answered:true`, OR the
 * `reason` is NOT one of the wrapper's own short-circuit reasons. Inner
 * dispatcher reasons like `timeout`, `user_moved_on`, `session_stopped`
 * count as real fires — Sonnet probed the user, so the budget slot is
 * consumed (otherwise a timeout-loop Sonnet could spam asks past the cap).
 *
 * The wrapper-emitted set (post-r5-#2 + post-r6 + post-r7): `gated`,
 * `session_terminated`, `gate_dispatcher_error` (reserved for future
 * wrapper-internal catches). `restrained_mode` and
 * `ask_budget_exhausted` never reach this classifier because their
 * code paths return synth envelopes BEFORE the post-dispatch step.
 *
 * `dispatcher_error_pre_emit` (Plan 05-13 r7) lives in
 * `_PRE_EMIT_NON_FIRE_REASONS` alongside other inner-dispatcher
 * pre-emit reasons (validation_error / shadow_mode / etc). It is
 * the post-r7 outcome name — replaces legacy `dispatcher_error`
 * which is no longer emitted (stays in the logger enum for
 * archived-row back-compat; classifier treats it as ambiguous-
 * legacy fire-default). Reserved sibling `dispatcher_error_post_emit`
 * lives in NEITHER set → fire-default by name. The r1→r5→r6→r7
 * lineage is documented in the audit block above
 * `_WRAPPER_SHORT_CIRCUIT_REASONS` (search for "Plan 05-13 r7").
 */
// Plan 05-10 r4-#2 — Sets are module-PRIVATE, public surface is the
// predicate helpers `isWrapperShortCircuitReason` /
// `isPreEmitNonFireReason` exported below. Pre-r4-#2 these were
// exported as raw Sets:
//
//   - WRAPPER_SHORT_CIRCUIT_REASONS = new Set([...])
//     (no Object.freeze at all — bare Set)
//   - PRE_EMIT_NON_FIRE_REASONS = Object.freeze(new Set([...]))
//
// `Object.freeze` on a Set does NOT prevent `.add()` / `.delete()` —
// it freezes the Set object's own enumerable properties + prevents
// extensions, but the Set's internal [[SetData]] slot is unaffected.
// So an importer could call:
//
//   import { WRAPPER_SHORT_CIRCUIT_REASONS } from '...';
//   WRAPPER_SHORT_CIRCUIT_REASONS.add('foo');
//
// and silently change the budget classifier in-process for the rest
// of its lifetime. The harness's
// `HARNESS_WRAPPER_SHORT_CIRCUIT_REASONS = new Set([...
// WRAPPER_SHORT_CIRCUIT_REASONS, ...])` would also pull in the
// mutated entry on next harness run. Same risk on the
// `PRE_EMIT_NON_FIRE_REASONS` side — `.delete('shadow_mode')` would
// silently undo Plan 05-09 r3-#1's fix.
//
// Footgun, not active attack surface (we don't pass these Sets to
// untrusted code), but the API contract was that they were
// constants and the previous shape didn't enforce it. r4-#2 fix:
// keep the Sets module-private + expose predicate helpers. The
// harness updates to use the predicates instead of importing +
// spreading the Sets — single source of truth becomes the predicate
// behaviour, not the Set's contents (the Sets themselves are no
// longer reachable from outside this module).
//
// Internal consumer (isRealFire below) continues to call `.has()`
// directly on the private Sets — internal access to a module-
// private Set is fine; only the EXTERNAL exposure changed.
//
// =============================================================================
// _WRAPPER_SHORT_CIRCUIT_REASONS — Plan 05-07 r1-#1 + Plan 05-11 r5-#2
// + Plan 05-12 r6.
// Reasons emitted by the wrapper itself (synthResultWrapped) when its
// own gates short-circuit BEFORE the inner dispatcher runs OR when a
// future wrapper-internal catch fires. These reasons MUST NOT count
// as real fires (no budget burn, no restrained-window slot consumed).
// The wrapper's `isRealFire` consults this set; the offline exit-gate
// harness mirrors the same set via the `isWrapperShortCircuitReason`
// predicate (single source of truth so the offline aggregate metric
// matches runtime budget accounting).
//
// Current membership: `gated`, `session_terminated`,
// `gate_dispatcher_error`. `dispatcher_error` lives in
// `_PRE_EMIT_NON_FIRE_REASONS` (see audit block below) — both sets
// are "non-fire" but they carve up the non-fire space by lifecycle
// origin: this set holds wrapper-internal pre-emit reasons; the
// other set holds inner-dispatcher pre-emit reasons.
//
// =============================================================================
// `dispatcher_error` lineage — r5↔r6 toggle history.
// =============================================================================
//
// The classification of the inner dispatcher's `dispatcher_error`
// reason has shifted three times. The lineage is preserved here in
// full so future reviewers can re-verify each transition without
// digging through git blame.
//
// (1) Pre-r5-#2 — member of _WRAPPER_SHORT_CIRCUIT_REASONS (non-fire).
//
//     Plan 05-07 r1-#1 originally added `dispatcher_error` to the
//     wrapper short-circuit set on the assumption that the wrapper
//     emits it from its OWN timer-catch path (line ~282 of this file)
//     when the inner dispatcher throws. That argument is structurally
//     pre-emit with respect to the wrapper's work but conflates two
//     emit sites that both use the same reason name (see (3) for
//     why this conflation matters).
//
// (2) Plan 05-11 r5-#2 — REMOVED from this set; classified as fire.
//
//     Codex r5 surfaced that the wrapper's timer catch at line ~282
//     fires when the INNER dispatcher itself threw — and the inner
//     dispatcher (stage6-dispatcher-ask.js) has its OWN
//     dispatcher_error emit site at line 341 inside an outer
//     try/catch starting at line 321 that wraps EVERYTHING inside
//     the live-path Promise constructor (lines 240-349). r5
//     reasoned: we cannot distinguish whether the inner threw
//     pre-register/pre-ws.send (CASE A) or post-ws.send (CASE B)
//     from the envelope alone. Conservative classification: TREAT
//     AS FIRE — false-positive cost (CASE A as fire) bounded +1
//     budget slot per real bug; false-negative cost (CASE B as
//     non-fire) is unbounded Sonnet bypass.
//
// (3) Plan 05-12 r6 — REVERTED back to non-fire, but in
//     `_PRE_EMIT_NON_FIRE_REASONS` (semantic fit) rather than back
//     in this set.
//
//     Codex r6 audited the CURRENT source of stage6-dispatcher-ask.js
//     and confirmed that r5's CASE B does not exist in current code:
//
//     Inner dispatcher live-path Promise constructor (lines 240-349):
//
//       line 247 — setTimeout(() => pendingAsks.resolve(...), 20000)
//                  Registers a timer; cannot throw synchronously.
//
//       line 266 — pendingAsks.register(toolCallId, entry)
//                  Throws on duplicate (caught at line 285 — never
//                  escapes to outer catch). Throws on other invariants
//                  → not-duplicate branch at line 297 → clearTimeout
//                  + throw → Promise rejection → outer catch at line
//                  321 → dispatcher_error logged at line 341.
//                  STRUCTURALLY PRE-EMIT — happens BEFORE ws.send.
//
//       line 305 — ws.send('ask_user_started', ...) wrapped in its
//                  OWN try/catch (inner) which swallows send failures.
//                  Throws CANNOT reach the outer catch.
//
//     There is NO synchronous post-send code in current source. The
//     outer catch at line 321 can only fire from pre-emit code paths
//     (register rethrow at line 297). r5's CASE B was forward-
//     looking — defending against a theoretical future refactor.
//
//     The cost of r5's forward-looking conservative classification
//     was that EVERY current dispatcher_error envelope (always
//     CASE A pre-emit) was mismeasured as a phantom fire — a
//     false-positive every time the inner dispatcher errored at
//     register. r6 reverts.
//
//     Why r6 places dispatcher_error in `_PRE_EMIT_NON_FIRE_REASONS`
//     rather than back in `_WRAPPER_SHORT_CIRCUIT_REASONS`:
//     dispatcher_error originates from the INNER dispatcher's outer
//     catch (line 341 of stage6-dispatcher-ask.js), so it
//     semantically fits alongside `validation_error` /
//     `prompt_leak_blocked` / `shadow_mode` / `duplicate_tool_call_id`
//     — all of which are inner-dispatcher pre-emit reasons. The
//     classification result is identical (both sets are non-fire);
//     the categorisation tightens the audit trail for future
//     reviewers.
//
// (4) Future-defence note — what to do if a refactor introduces
//     post-emit code:
//
//     If a future refactor adds synchronous code after `ws.send`
//     (post-send analytics, post-send registry update, etc.) that
//     can throw and reaches the same outer catch at line 321, do
//     NOT reclassify `dispatcher_error` itself. Retroactive
//     reclassification breaks historical analyzer queries on
//     `stage6.ask_user` log rows that already accrued under the
//     current (post-r6 non-fire) classification.
//
//     Instead, introduce a NEW outcome name
//     (`dispatcher_error_post_emit`) for the new emit site, and
//     classify THAT as fire.
//
// (5) Plan 05-13 r7 — split `dispatcher_error` into lifecycle-keyed
//     names (`_pre_emit` / `_post_emit`). REVERTED at (6) below.
//
//     Codex r7 BLOCK: the r5↔r6 toggle history (initial non-fire
//     → r5 fire → r6 non-fire) is the symptom of a structural shape
//     problem — a single outcome name cannot carry lifecycle
//     position. r7 split the outcome NAME so the closed-enum
//     wire-schema value encoded the lifecycle position structurally.
//
//     The split closed the toggle problem at the classifier level
//     (re-audits couldn't toggle the SAME name) but it INTRODUCED
//     a wire-schema break that re-surfaced as Codex r8-#2 below.
//
// (6) Plan 05-14 r8-#2 — REVERT (5)'s wire-schema rename; layer
//     lifecycle position as a SEPARATE optional log-row metadata
//     field.
//
//     Codex r8-#2 MAJOR: Plan 05-13 r7's split was a BREAKING
//     wire-schema change to the closed enum
//     ASK_USER_ANSWER_OUTCOMES. Downstream consumers (CloudWatch
//     Insights queries, future analyzer expansions) filtering on
//     `answer_outcome = 'dispatcher_error'` post-r7 silently match
//     nothing because the active emit site at
//     stage6-dispatcher-ask.js was renamed.
//
//     r8-#2 closure: revert the rename. Restore `'dispatcher_error'`
//     as the single canonical wire-schema value. Encode lifecycle
//     position as an out-of-band optional log-row field (`lifecycle:
//     'pre_emit' | 'post_emit'`) — additive metadata, no break,
//     same idiom as r10's `dispatcher_error` diagnostic field.
//
//     Concretely (post-r8-#2):
//       - The outer catch in stage6-dispatcher-ask.js (line ~361)
//         emits `answer_outcome: 'dispatcher_error'` (canonical
//         wire-schema) WITH `lifecycle: 'pre_emit'` (out-of-band
//         metadata). The r6 + r7 schema audit still applies — this
//         catch is structurally pre-emit; the lifecycle field
//         carries that audit conclusion at the log-row level.
//       - The wrapper's timer-catch (line ~302 of this file) routes
//         through the new `synthResultWithoutLog` helper (Plan
//         05-14 r8-#1) so the dispatcher's outer catch is the sole
//         emitter for the inner-throw path. The synthesised envelope
//         carries `body.reason: 'dispatcher_error'` (matches the
//         dispatcher's wire-schema value).
//       - `_PRE_EMIT_NON_FIRE_REASONS` returns to the r6 placement:
//         `'dispatcher_error'` is back in the set → non-fire on
//         the envelope-layer classification.
//       - `dispatcher_error_pre_emit` and `dispatcher_error_post_emit`
//         REMOVED from the closed enum. The lifecycle position lives
//         only at the log-row metadata layer post-r8-#2.
//
//     How r8-#2 still closes the r7 toggle-problem concern:
//     a future re-audit of the SAME emit site reaches the SAME
//     conclusion (pre-emit, given current code), so the lifecycle
//     field stays stable. A genuinely different lifecycle position
//     (a post-emit refactor adding code AFTER ws.send that can
//     throw + reach the outer catch) emits `lifecycle: 'post_emit'`
//     at the new code path — same `answer_outcome: 'dispatcher_error'`
//     wire-schema name (analyzer queries keep matching); the
//     lifecycle split happens at the metadata-field level, NOT at
//     the closed-enum level.
//
//     Phase 4 r28 disposition policy permitted the targeted
//     forbidden-file edit (revert in stage6-dispatcher-ask.js,
//     line 361 outcome string + new lifecycle key + comment block
//     updates) because the revert is semantic clarification of an
//     existing invariant + a non-breaking metadata addition, not
//     behavioural change.
//
//     Wire-schema continuity: pre-r7 archived rows carry
//     `'dispatcher_error'`; r7-period rows carry `'_pre_emit'`;
//     post-r8 rows carry `'dispatcher_error'` with `lifecycle:
//     'pre_emit'`. Analyzer queries on the wire-schema name match
//     pre-r7 + post-r8 rows; r7-period rows are a small archived
//     bucket that future analyzers can union into the canonical
//     name (`answer_outcome IN ('dispatcher_error',
//     'dispatcher_error_pre_emit', 'dispatcher_error_post_emit')`)
//     if precise back-compat coverage is needed.
//
// =============================================================================
// `gate_dispatcher_error` — wrapper-internal pre-emit reservation.
// =============================================================================
//
// Plan 05-11 r5-#2 added this reason to _WRAPPER_SHORT_CIRCUIT_REASONS
// for future wrapper-internal failures structurally guaranteed to be
// pre-emit (timer leak, gate.destroy mid-fire, Promise constructor
// synchronous throw, etc.). At r5-#2 closure (and at r6 closure)
// there is NO emit site — the reason is pre-registered in the
// membership set so when a future refactor introduces a wrapper-
// internal try/catch, the classification is already wired correctly.
// r6 keeps this reservation unchanged.
//
// Note: `restrained_mode` and `ask_budget_exhausted` are ALSO
// wrapper-emitted synth reasons BUT they live in pre-dispatch
// branches of wrapAskDispatcherWithGates (NOT in isRealFire's
// classifier path). The harness's accounting layer (envelopes only,
// no wrapper internals) treats them as wrapper-suppressed too — but
// it composes them ON TOP of the wrapper's predicate, not inside
// this internal Set. See scripts/stage6-over-ask-exit-gate.js
// `isHarnessWrapperShortCircuitReason` for the harness composition.
// =============================================================================
const _WRAPPER_SHORT_CIRCUIT_REASONS = new Set([
  'gated',
  'session_terminated',
  // Plan 05-11 r5-#2 — RESERVED for future wrapper-internal catches.
  // Currently no emit site; pre-registered so a future refactor
  // introducing a wrapper-internal try/catch already has the
  // classification wired.
  'gate_dispatcher_error',
]);

// =============================================================================
// _PRE_EMIT_NON_FIRE_REASONS — Plan 05-08 r2-#1 + Plan 05-09 r3-#1
// + Plan 05-12 r6 + Plan 05-13 r7.
// FIVE answer_outcomes whose envelopes signal "the ask never reached
// iOS / never registered with pendingAsks". All five are dispatcher
// PRE-EMIT failures whose returns happen BEFORE pendingAsks.register
// and ws.send(ask_user_started):
//   - validation_error    (Plan 03-02; pre-dispatch shape rejection)
//   - duplicate_tool_call_id (Plan 03-05; SDK retry-replay caught at register)
//   - prompt_leak_blocked (Plan 04-26; output filter blocked the ask pre-emit)
//   - shadow_mode         (Plan 03-05; shadow-path short-circuit pre-register)
//   - dispatcher_error_pre_emit (Plan 05-13 r7; outer catch at
//                          stage6-dispatcher-ask.js line 321 emits
//                          at line 341 + the wrapper's own timer-
//                          catch at line ~302 emits when an inner
//                          throw propagates. Both paths are
//                          structurally pre-emit; the `_pre_emit`
//                          suffix encodes that lifecycle position
//                          in the outcome name itself, closing the
//                          r5↔r6 same-name toggle problem
//                          permanently. See "Plan 05-13 r7" section
//                          in the audit block above
//                          _WRAPPER_SHORT_CIRCUIT_REASONS for the
//                          full lineage (initial → r5 → r6 → r7).
//                          Legacy `dispatcher_error` (Plan 03-12
//                          r10) NO LONGER in this set post-r7 —
//                          stays in the logger enum for back-compat
//                          but is treated as ambiguous-legacy
//                          fire-default by the classifier.)
//
// Pre-fix isRealFire returned true for these because they aren't in
// _WRAPPER_SHORT_CIRCUIT_REASONS — the wrapper then incremented
// askBudget + restrainedMode.recordAsk for inputs the user never even
// saw. That inverts the meaning of the budget cap (which counts
// "Sonnet probed the user", not "Sonnet attempted to probe"). It also
// raises the false-positive rate of the rolling-5-turn restrained-
// mode trigger by counting phantom asks.
//
// Audit basis (every value here): each reason's emit site in
// src/extraction/stage6-dispatcher-ask.js is structurally BEFORE
// pendingAsks.register(toolCallId, …) and BEFORE the ws.send(…
// ask_user_started …) emission, so the ask never crossed the boundary
// to iOS. Confirmed call-site lines (read at Plan 05-09 r3-#1 close +
// Plan 05-12 r6 close for the dispatcher_error entry, renamed at
// Plan 05-13 r7 to dispatcher_error_pre_emit):
//   - validation_error      → returns at line 135 (the validation `return`)
//   - prompt_leak_blocked   → returns at line 196 (the leak-filter `return`)
//   - shadow_mode           → returns at lines 206-225 (`if (mode === 'shadow') { … }`)
//   - duplicate_tool_call_id → resolves at line 287 inside the register catch
//   - dispatcher_error_pre_emit → outer catch at line 321 emits at
//                              line 341 (post-r7 outcome name).
//                              In CURRENT source the only path that
//                              reaches this catch is
//                              `pendingAsks.register` rethrow at
//                              line 297 (clearTimeout + throw before
//                              ws.send line 305). ws.send failures
//                              live in their own inner try/catch and
//                              never escape to the outer catch. NO
//                              synchronous post-send code exists. So
//                              every emit is structurally pre-emit.
//                              The wrapper's own timer-catch at
//                              line ~302 of THIS file also emits
//                              `_pre_emit` when an inner throw
//                              propagates — same lifecycle reasoning
//                              (the only inner-throw path today is
//                              the dispatcher's outer-catch rethrow
//                              above). See the toggle history in the
//                              audit block above
//                              _WRAPPER_SHORT_CIRCUIT_REASONS for
//                              the full lineage (Plan 05-07 r1-#1 →
//                              Plan 05-11 r5-#2 → Plan 05-12 r6 →
//                              Plan 05-13 r7).
// Step 3 (register + ws.send) starts at line 228+ — every reason
// listed above returns BEFORE that block.
//
// ASK_USER_ANSWER_OUTCOMES contains 17 entries (Plan 05-13 r7); every
// other entry either represents a real fire that DID register
// (answered, timeout, user_moved_on, session_*, transcript_already_*)
// or a wrapper-internal short-circuit already handled in
// _WRAPPER_SHORT_CIRCUIT_REASONS / the wrapper's pre-dispatch synth
// branches, or the legacy `dispatcher_error` / reserved
// `dispatcher_error_post_emit` (NEITHER pre-emit set → fire-default).
//
// Plan 05-09 r3-#1 — D2 reversal. Plan 05-08 D2 originally claimed
// "shadow_mode runs after register/ws emission ... so it counts as a
// fire and stays out of this set." That conclusion was wrong. The
// "after validation + leak filter" characterisation is true
// (shadow_mode is step 2 in dispatcher ordering, which is after
// step 1 = validation and step 1b = leak filter), but irrelevant —
// the predicate that determines whether budget burns is "did
// register + ws.send fire?", and for shadow_mode the answer is no.
// Codex r3 surfaced this; r3-#1 corrects the set + the audit prose.
//
// Plan 05-12 r6 — `dispatcher_error` ADDED as fifth member (later
// renamed at r7).
// Reverses Plan 05-11 r5-#2's conservative fire classification (which
// was forward-looking — defending against a theoretical post-emit
// CASE B that doesn't exist in current source). Same defence-integrity
// pattern as r3-#1 reversing r2-#1's omission of shadow_mode: a
// re-audit of the actual emit sites surfaced that the prior
// classification mismeasured the dispatcher's behaviour. Why
// `_PRE_EMIT_NON_FIRE_REASONS` rather than back in
// `_WRAPPER_SHORT_CIRCUIT_REASONS`: dispatcher_error originates from
// the inner dispatcher's outer catch (not the wrapper's own catch),
// so it semantically fits this set.
//
// Plan 05-13 r7 — `dispatcher_error` RENAMED to
// `dispatcher_error_pre_emit` (membership replaced; legacy name
// REMOVED from this set).
// The r5↔r6 toggle (initial non-fire → r5 fire → r6 non-fire) showed
// that a single name cannot carry lifecycle position — three rounds
// re-classified the SAME envelope reason at the SAME emit site based
// on lifecycle assumption alone. r7 closes the toggle problem
// permanently by encoding lifecycle position into the outcome NAME
// itself (lines 327, 341 of stage6-dispatcher-ask.js + line ~302 of
// this file renamed under the Phase 4 r28 disposition policy as
// targeted forbidden-file edit). Legacy `dispatcher_error` stays in
// the logger enum for archived row back-compat but classifier treats
// it as ambiguous-legacy → fire-default via isRealFire's fallthrough.
//
// Production effect of the pre-fix bug:
//   - Shadow runs (Plan 05-02 + Plan 05-04 shadow harness) burned
//     askBudget on every shadow_mode envelope. Shadow's whole point is
//     observe-without-affect — burning shadow runs against the budget
//     cap is the OPPOSITE of that.
//   - Shadow-mode rolling-5-turn restrained-mode counter accrued
//     phantom asks, contaminating the next live run's threshold
//     accounting.
//   - (Plan 05-12 r6 / Plan 05-13 r7) every dispatcher_error envelope
//     (always pre-emit in current source — register rethrow at line
//     297) burned askBudget + accrued a restrained-window slot. False
//     positive every time the inner dispatcher errored at register.
//     r7 keeps the r6 fix shape but renames the outcome so a future
//     re-audit cannot re-toggle the SAME name.
// =============================================================================
const _PRE_EMIT_NON_FIRE_REASONS = new Set([
  'validation_error',
  'duplicate_tool_call_id',
  'prompt_leak_blocked',
  'shadow_mode',
  // Plan 05-12 r6 → Plan 05-13 r7 → Plan 05-14 r8-#2 round-trip:
  //   - r6 added `'dispatcher_error'` to this set after Codex r6
  //     audited the current source and confirmed every emit site is
  //     structurally pre-emit (register rethrow at line 297 BEFORE
  //     ws.send line 305; ws.send failures caught + swallowed; no
  //     synchronous post-send work).
  //   - r7 RENAMED the wire-schema value to `dispatcher_error_pre_emit`
  //     and updated this set's membership accordingly. Reserved
  //     `dispatcher_error_post_emit` for future post-emit code paths
  //     (NOT in either set → fire-default).
  //   - r8-#2 REVERTED r7's rename — the closed-enum split was a
  //     BREAKING wire-schema change, silently invalidating downstream
  //     consumers filtering on `answer_outcome = 'dispatcher_error'`.
  //     Restored `'dispatcher_error'` as the canonical wire-schema
  //     name; layered lifecycle position as an out-of-band log-row
  //     metadata field via `lifecycle: 'pre_emit' | 'post_emit'` at
  //     the dispatcher's outer catch.
  // The classifier returns to the r6 placement: `'dispatcher_error'`
  // is back in this set → non-fire. The lifecycle metadata is for
  // analyzer-query splits; the runtime classifier doesn't need it
  // (the wire-schema name carries the classification at the envelope
  // layer).
  'dispatcher_error',
]);

/**
 * Public predicate: is `reason` one of the wrapper's own short-circuit
 * reasons (`gated`, `session_terminated`, `gate_dispatcher_error`)?
 *
 * Plan 05-13 r7 — neither `dispatcher_error_pre_emit` nor
 * `dispatcher_error_post_emit` (nor the legacy `dispatcher_error`)
 * are wrapper short-circuit reasons; they all originate from the
 * INNER dispatcher's outer catch (or the wrapper's timer-catch
 * propagating an inner throw). `_pre_emit` lives in
 * `isPreEmitNonFireReason`'s set; `_post_emit` lives in NEITHER set
 * (fire-default); legacy `dispatcher_error` lives in NEITHER set
 * post-r7 (ambiguous-legacy fire-default). The membership of THIS
 * set is the wrapper-OWNED pre-emit non-fire reasons; the other
 * predicate covers the inner-dispatcher pre-emit non-fire reasons.
 * Both predicate sets together carve up the non-fire space by
 * lifecycle origin.
 *
 * Plan 05-10 r4-#2 — replaces the previous `WRAPPER_SHORT_CIRCUIT_REASONS`
 * Set export. The previous shape was a footgun: `Object.freeze` on a Set
 * doesn't prevent `.add()` / `.delete()`, so any importer could mutate
 * the budget classifier silently. The predicate keeps the data module-
 * private and exposes only a read-only check.
 *
 * @param {string} reason — answer_outcome string from the envelope body.
 * @returns {boolean}
 */
export function isWrapperShortCircuitReason(reason) {
  return _WRAPPER_SHORT_CIRCUIT_REASONS.has(reason);
}

/**
 * Public predicate: is `reason` one of the dispatcher's pre-emit
 * non-fire reasons (`validation_error`, `duplicate_tool_call_id`,
 * `prompt_leak_blocked`, `shadow_mode`, `dispatcher_error_pre_emit`)?
 * Note: legacy `dispatcher_error` (Plan 03-12 r10) is NOT in this
 * set post-Plan 05-13 r7 — it stays in the logger enum for archived
 * row back-compat but classifier treats it as ambiguous-legacy
 * fire-default.
 *
 * Plan 05-10 r4-#2 — replaces the previous `PRE_EMIT_NON_FIRE_REASONS`
 * Set export. Same rationale as `isWrapperShortCircuitReason`: the Set
 * was nominally "frozen" but `Object.freeze` doesn't lock Set
 * mutation methods. The predicate prevents external mutation entirely.
 *
 * @param {string} reason — answer_outcome string from the envelope body.
 * @returns {boolean}
 */
export function isPreEmitNonFireReason(reason) {
  return _PRE_EMIT_NON_FIRE_REASONS.has(reason);
}

function isRealFire(envelope) {
  try {
    const body = JSON.parse(envelope.content);
    if (body.answered === true) return true;
    if (_WRAPPER_SHORT_CIRCUIT_REASONS.has(body.reason)) return false;
    // Plan 05-08 r2-#1 — pre-emit failures are non-fires (the ask never
    // reached iOS / never registered). Burning budget on these is wrong.
    if (_PRE_EMIT_NON_FIRE_REASONS.has(body.reason)) return false;
    return true;
  } catch {
    // Malformed envelope from a buggy inner dispatcher — treat as real
    // fire so the budget conservatively consumes a slot. Defensive: a
    // false-positive here caps Sonnet at one extra ask, while a
    // false-negative would let Sonnet bypass the cap entirely.
    return true;
  }
}
