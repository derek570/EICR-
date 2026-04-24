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
 * @param {{ context_field?: string|null, context_circuit?: number|null }} input
 * @returns {string}
 */
export function deriveAskKey(input) {
  const field = input?.context_field ?? '_';
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
 * @param {object} call
 * @param {string} reason  Must be one of ASK_USER_ANSWER_OUTCOMES.
 * @param {object} ctx     Must carry sessionId + turnId.
 * @param {object} logger
 * @param {string} sessionId
 * @returns {{ tool_use_id: string, content: string, is_error: false }}
 */
function synthResultWrapped(call, reason, ctx, logger, sessionId) {
  const toolCallId = call.tool_call_id ?? call.id;
  logAskUser(logger, {
    sessionId,
    turnId: ctx.turnId,
    mode: 'live',
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
 * @param {object} opts
 * @param {number} [opts.delayMs=QUESTION_GATE_DELAY_MS]  Debounce window.
 * @param {object} opts.logger
 * @param {string} opts.sessionId
 */
export function createAskGateWrapper({ delayMs = QUESTION_GATE_DELAY_MS, logger, sessionId }) {
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
          synthResultWrapped(existing.pendingCall, 'gated', existing.pendingCtx, logger, sessionId)
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
          resolve(synthResultWrapped(call, 'dispatcher_error', ctx, logger, sessionId));
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
          sessionId
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
 * @param {(call, ctx) => Promise<{tool_use_id: string, content: string, is_error: boolean}>} innerDispatcher
 * @param {object} opts
 * @param {{ isExhausted: (key:string)=>boolean, increment: (key:string)=>void }} opts.askBudget
 * @param {{ isActive: ()=>boolean, recordAsk: (turnId:string)=>void }} opts.restrainedMode
 * @param {{ gateOrFire: Function, destroy: Function }} opts.gate
 * @param {(call, ctx)=>void} [opts.filledSlotsShadow]  Side-effect-only logger; defaults to no-op.
 * @param {object} opts.logger
 * @param {string} opts.sessionId
 * @returns {(call, ctx) => Promise<{tool_use_id: string, content: string, is_error: boolean}>}
 */
export function wrapAskDispatcherWithGates(
  innerDispatcher,
  { askBudget, restrainedMode, gate, filledSlotsShadow, logger, sessionId }
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
      return synthResultWrapped(call, 'restrained_mode', ctx, logger, sessionId);
    }

    // (3) Per-key budget short-circuit. STA-06 cap = 2 (default in
    // stage6-ask-budget.js). Pre-fire check; the increment fires only
    // after a successful inner dispatch (step 5 below).
    if (askBudget.isExhausted(key)) {
      return synthResultWrapped(call, 'ask_budget_exhausted', ctx, logger, sessionId);
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
const WRAPPER_SHORT_CIRCUIT_REASONS = new Set(['gated', 'session_terminated', 'dispatcher_error']);

function isRealFire(envelope) {
  try {
    const body = JSON.parse(envelope.content);
    if (body.answered === true) return true;
    return !WRAPPER_SHORT_CIRCUIT_REASONS.has(body.reason);
  } catch {
    // Malformed envelope from a buggy inner dispatcher — treat as real
    // fire so the budget conservatively consumes a slot. Defensive: a
    // false-positive here caps Sonnet at one extra ask, while a
    // false-negative would let Sonnet bypass the cap entirely.
    return true;
  }
}
