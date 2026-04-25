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
  // Plan 05-08 r2-#2 + Plan 05-10 r4-#1 — collapse `null`, `undefined`,
  // AND the literal sentinel `"none"` (case-INSENSITIVE) to '_'. The
  // case-insensitivity is SENTINEL-ONLY — real (non-sentinel) field
  // values pass through with their original case preserved so a typo
  // bug surfaces in the analyzer rather than silently bucketing
  // wrong-case real values together.
  //
  // Why case-insensitive at the wrapper layer (Plan 05-10 r4-#1):
  // wrapAskDispatcherWithGates below in this file calls
  // deriveAskKey() BEFORE the inner dispatcher's validateAskUser
  // runs. Case-sensitive matching here let alternating sentinel cases
  // ([null,'NONE','None',null]) derive distinct keys at the wrapper,
  // bypassing the wrapper's same-key debounce + per-key budget gates
  // even though each call was later rejected as validation_error.
  // The validator's case-sensitivity is the validator's contract; the
  // wrapper's case-insensitivity here is defence-in-depth on a
  // different axis.
  let field;
  if (fieldRaw === null || fieldRaw === undefined) {
    field = '_';
  } else if (typeof fieldRaw === 'string' && fieldRaw.toLowerCase() === 'none') {
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
 * + `dispatcher_error` + `session_terminated` short-circuit rows then
 * carry the correct mode.
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
          resolve(synthResultWrapped(call, 'dispatcher_error', ctx, logger, sessionId, mode));
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
    // Short-circuit reasons (`gated`, `session_terminated`, `dispatcher_error`)
    // MUST NOT consume budget or restrained-window slot. We classify by
    // parsing the envelope's content body: if it has `answered:true` OR
    // the reason is one of the inner dispatcher's own reasons (timeout /
    // user_moved_on / etc — anything NOT in the wrapper's short-circuit set),
    // we count it as a real fire.
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
 * The wrapper-emitted set is closed: `gated`, `session_terminated`,
 * `dispatcher_error`. `restrained_mode` and `ask_budget_exhausted` never
 * reach this classifier because their code paths return synth envelopes
 * BEFORE the post-dispatch step.
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
// _WRAPPER_SHORT_CIRCUIT_REASONS — Plan 05-07 r1-#1.
// Reasons emitted by the wrapper itself (synthResultWrapped) when its
// own gates short-circuit BEFORE the inner dispatcher runs. These
// reasons MUST NOT count as real fires (no budget burn, no restrained-
// window slot consumed). The wrapper's `isRealFire` consults this set;
// the offline exit-gate harness mirrors the same set via the
// `isWrapperShortCircuitReason` predicate (single source of truth so
// the offline aggregate metric matches runtime budget accounting).
// =============================================================================
const _WRAPPER_SHORT_CIRCUIT_REASONS = new Set([
  'gated',
  'session_terminated',
  'dispatcher_error',
  // Plan 05-07 r1-#1 — note: `restrained_mode` and `ask_budget_exhausted`
  // are also wrapper-emitted synth reasons BUT they live in pre-dispatch
  // branches of wrapAskDispatcherWithGates (NOT in isRealFire's
  // classifier path). The harness's accounting layer (envelopes only,
  // no wrapper internals) treats them as wrapper-suppressed too — but
  // it composes them ON TOP of the wrapper's predicate, not inside
  // this internal Set. See scripts/stage6-over-ask-exit-gate.js
  // `isHarnessWrapperShortCircuitReason` for the harness composition.
]);

// =============================================================================
// _PRE_EMIT_NON_FIRE_REASONS — Plan 05-08 r2-#1 + Plan 05-09 r3-#1.
// FOUR answer_outcomes whose envelopes signal "the ask never reached
// iOS / never registered with pendingAsks". All four are dispatcher
// PRE-EMIT failures whose returns happen BEFORE pendingAsks.register
// and ws.send(ask_user_started):
//   - validation_error    (Plan 03-02; pre-dispatch shape rejection)
//   - duplicate_tool_call_id (Plan 03-05; SDK retry-replay caught at register)
//   - prompt_leak_blocked (Plan 04-26; output filter blocked the ask pre-emit)
//   - shadow_mode         (Plan 03-05; shadow-path short-circuit pre-register)
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
// to iOS. Confirmed call-site lines (read at Plan 05-09 r3-#1 close):
//   - validation_error      → returns at line 135 (the validation `return`)
//   - prompt_leak_blocked   → returns at line 196 (the leak-filter `return`)
//   - shadow_mode           → returns at lines 206-225 (`if (mode === 'shadow') { … }`)
//   - duplicate_tool_call_id → resolves at line 287 inside the register catch
// Step 3 (register + ws.send) starts at line 228+ — every reason
// listed above returns BEFORE that block.
//
// ASK_USER_ANSWER_OUTCOMES contains 13 entries (Plan 05-05); every
// other entry either represents a real fire that DID register
// (answered, timeout, user_moved_on, session_*, transcript_already_*)
// or a wrapper-internal short-circuit already handled in
// _WRAPPER_SHORT_CIRCUIT_REASONS / the wrapper's pre-dispatch synth
// branches.
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
// Production effect of the pre-fix bug:
//   - Shadow runs (Plan 05-02 + Plan 05-04 shadow harness) burned
//     askBudget on every shadow_mode envelope. Shadow's whole point is
//     observe-without-affect — burning shadow runs against the budget
//     cap is the OPPOSITE of that.
//   - Shadow-mode rolling-5-turn restrained-mode counter accrued
//     phantom asks, contaminating the next live run's threshold
//     accounting.
// =============================================================================
const _PRE_EMIT_NON_FIRE_REASONS = new Set([
  'validation_error',
  'duplicate_tool_call_id',
  'prompt_leak_blocked',
  'shadow_mode',
]);

/**
 * Public predicate: is `reason` one of the wrapper's own short-circuit
 * reasons (`gated`, `session_terminated`, `dispatcher_error`)?
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
 * `prompt_leak_blocked`, `shadow_mode`)?
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
