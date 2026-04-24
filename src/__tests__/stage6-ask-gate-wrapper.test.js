/**
 * Stage 6 Phase 5 Plan 05-01 — ask-gate-wrapper unit tests.
 *
 * WHAT: Locks the higher-order composition that wires all four Phase 5 gates
 * (filled-slots shadow / restrained-mode / per-key budget / 1500ms debounce)
 * around the unmodified Plan 03-05 createAskDispatcher. Composition only;
 * the inner dispatcher is a black box.
 *
 * WHY these tests ARE the gate (RED step of the Plan 05-01 TDD pair):
 *   - STB-01 short-circuit ordering — gate.gateOrFire wraps every ask_user
 *     dispatch; restrained / budget short-circuit BEFORE the gate timer
 *     starts; gated replacements resolve with reason='gated'.
 *   - STB-04 — per-key budget enforced AHEAD of the inner dispatcher.
 *   - STB-05 — no existing guard weakened: composition does not mutate
 *     stage6-dispatcher-ask.js. The Codex grep at /verification/ proves
 *     this; the tests prove the wrapper achieves the same effect via
 *     pure composition.
 *   - Pitfall 4 (Plan 05-03 + 05-04 carry-over) — counters increment
 *     ONLY on successful fire; short-circuited asks (gated /
 *     restrained_mode / ask_budget_exhausted) MUST NOT consume budget.
 *
 * Fake-timer pattern: doNotFake Promise + queueMicrotask + nextTick is
 * the Stage 6 frozen pattern (Decision 03-09). It lets jest.advanceTimersByTime
 * step the 1500ms debounce deterministically while keeping async/await
 * scheduling real.
 *
 * REQUIREMENTS covered: STB-01, STB-04, STB-05.
 */

import { jest } from '@jest/globals';
import {
  createAskGateWrapper,
  wrapAskDispatcherWithGates,
  deriveAskKey,
} from '../extraction/stage6-ask-gate-wrapper.js';
import { QUESTION_GATE_DELAY_MS } from '../extraction/question-gate.js';

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'Promise', 'nextTick'] });
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// Helpers — kept dumb so each test reads top-down without a second indirection.
// ---------------------------------------------------------------------------

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeBudget({ exhausted = false } = {}) {
  return {
    isExhausted: jest.fn(() => exhausted),
    increment: jest.fn(),
    getCount: jest.fn(() => 0),
  };
}

function makeRestrained({ active = false } = {}) {
  return {
    isActive: jest.fn(() => active),
    recordAsk: jest.fn(),
    destroy: jest.fn(),
  };
}

function makeInnerDispatcher(outcome = { answered: true, user_text: 'ok' }) {
  return jest.fn(async (call /* , ctx */) => ({
    tool_use_id: call.id,
    content: JSON.stringify(outcome),
    is_error: false,
  }));
}

function makeCall(id, field, circuit) {
  return {
    id,
    name: 'ask_user',
    input: {
      question: 'Q?',
      reason: 'ambiguous_circuit',
      context_field: field,
      context_circuit: circuit,
      expected_answer_shape: 'text',
    },
  };
}

function makeCtx(turnId = 'sess-1-turn-1') {
  return { sessionId: 'sess-1', turnId };
}

// =============================================================================
// Group 1: deriveAskKey — sentinel normalisation (Pitfall 3)
// =============================================================================
describe('deriveAskKey', () => {
  test('extracts field:circuit from a normal input', () => {
    expect(deriveAskKey({ context_field: 'ze', context_circuit: 0 })).toBe('ze:0');
  });

  test('null field + null circuit collapse to sentinel "_:_" (NOT "null:null")', () => {
    // Pitfall 3 — null bypass. Without the sentinel collapse, a null-context
    // ask would derive a different key from a 0-circuit ask, side-stepping
    // the budget for the same logical question.
    expect(deriveAskKey({ context_field: null, context_circuit: null })).toBe('_:_');
  });

  test('undefined / missing keys also collapse to sentinel', () => {
    // undefined === null in sentinel semantics — Map<key,...> in
    // stage6-ask-budget.js treats them identically once the key is
    // normalised.
    expect(deriveAskKey({})).toBe('_:_');
  });
});

// =============================================================================
// Group 2: createAskGateWrapper — debounce semantics (Research §Q10)
// =============================================================================
describe('createAskGateWrapper — debounce', () => {
  test('single gateOrFire fires inner dispatcher exactly once after 1500ms', async () => {
    const logger = makeLogger();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });
    const inner = makeInnerDispatcher();
    const call = makeCall('call-1', 'ze', 0);
    const ctx = makeCtx();

    const promise = gate.gateOrFire(call, ctx, inner);

    // Before the 1500ms expires, inner has not been called yet.
    await Promise.resolve();
    expect(inner).not.toHaveBeenCalled();

    jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);
    const result = await promise;

    expect(inner).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledWith(call, ctx);
    expect(result.tool_use_id).toBe('call-1');
    expect(JSON.parse(result.content)).toEqual({ answered: true, user_text: 'ok' });

    gate.destroy();
  });

  test('same-key within 1500ms cancels first + replaces; first resolves with reason="gated", second fires after a fresh 1500ms', async () => {
    const logger = makeLogger();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });
    const inner = makeInnerDispatcher();
    const call1 = makeCall('call-1', 'ze', 0);
    const call2 = makeCall('call-2', 'ze', 0); // same (field, circuit) → same key
    const ctx = makeCtx();

    const p1 = gate.gateOrFire(call1, ctx, inner);

    // t=800ms — second call arrives before first fires.
    jest.advanceTimersByTime(800);
    const p2 = gate.gateOrFire(call2, ctx, inner);

    // First's outer Promise resolves immediately with the gated synthResult.
    const r1 = await p1;
    expect(r1.tool_use_id).toBe('call-1');
    expect(JSON.parse(r1.content)).toEqual({ answered: false, reason: 'gated' });
    expect(r1.is_error).toBe(false);

    // Inner dispatcher has NOT been called yet — the 1500ms timer was reset.
    expect(inner).not.toHaveBeenCalled();

    // Advance through the FRESH 1500ms (resetTimer pattern).
    jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);
    const r2 = await p2;

    expect(inner).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledWith(call2, ctx);
    expect(r2.tool_use_id).toBe('call-2');
    expect(JSON.parse(r2.content)).toEqual({ answered: true, user_text: 'ok' });

    gate.destroy();
  });

  test('different keys each get their own timer; both inner dispatches fire', async () => {
    const logger = makeLogger();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });
    const inner = makeInnerDispatcher();
    const call1 = makeCall('call-1', 'ze', 0); // key 'ze:0'
    const call2 = makeCall('call-2', 'zs', 4); // key 'zs:4' — distinct
    const ctx = makeCtx();

    const p1 = gate.gateOrFire(call1, ctx, inner);
    const p2 = gate.gateOrFire(call2, ctx, inner);

    jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(inner).toHaveBeenCalledTimes(2);
    expect(JSON.parse(r1.content).answered).toBe(true);
    expect(JSON.parse(r2.content).answered).toBe(true);

    gate.destroy();
  });

  test('gate.destroy() clears pending timers and resolves outstanding promises with reason="session_terminated"', async () => {
    const logger = makeLogger();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });
    const inner = makeInnerDispatcher();
    const call = makeCall('call-1', 'ze', 0);
    const ctx = makeCtx();

    const p = gate.gateOrFire(call, ctx, inner);
    expect(jest.getTimerCount()).toBe(1);

    gate.destroy();

    expect(jest.getTimerCount()).toBe(0);
    const r = await p;
    expect(JSON.parse(r.content)).toEqual({ answered: false, reason: 'session_terminated' });
    expect(r.tool_use_id).toBe('call-1');
    expect(inner).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Group 3: wrapAskDispatcherWithGates — short-circuit ordering
// =============================================================================
describe('wrapAskDispatcherWithGates — short-circuit ordering', () => {
  test('restrainedMode active → inner NEVER called; filledSlotsShadow STILL called; reason="restrained_mode"; counters NOT incremented', async () => {
    const logger = makeLogger();
    const inner = makeInnerDispatcher();
    const askBudget = makeBudget();
    const restrainedMode = makeRestrained({ active: true });
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });
    const filledSlotsShadow = jest.fn();

    const wrapped = wrapAskDispatcherWithGates(inner, {
      askBudget,
      restrainedMode,
      gate,
      filledSlotsShadow,
      logger,
      sessionId: 'sess-1',
    });

    const call = makeCall('call-1', 'ze', 0);
    const ctx = makeCtx();
    const result = await wrapped(call, ctx);

    expect(filledSlotsShadow).toHaveBeenCalledTimes(1);
    expect(filledSlotsShadow).toHaveBeenCalledWith(call, ctx);
    expect(inner).not.toHaveBeenCalled();
    expect(JSON.parse(result.content)).toEqual({ answered: false, reason: 'restrained_mode' });
    expect(result.tool_use_id).toBe('call-1');
    expect(result.is_error).toBe(false);

    expect(askBudget.increment).not.toHaveBeenCalled();
    expect(restrainedMode.recordAsk).not.toHaveBeenCalled();

    gate.destroy();
  });

  test('restrained inactive + budget exhausted → inner NEVER called; filledSlotsShadow STILL called; reason="ask_budget_exhausted"; counters NOT incremented', async () => {
    const logger = makeLogger();
    const inner = makeInnerDispatcher();
    const askBudget = makeBudget({ exhausted: true });
    const restrainedMode = makeRestrained({ active: false });
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });
    const filledSlotsShadow = jest.fn();

    const wrapped = wrapAskDispatcherWithGates(inner, {
      askBudget,
      restrainedMode,
      gate,
      filledSlotsShadow,
      logger,
      sessionId: 'sess-1',
    });

    const call = makeCall('call-1', 'ze', 0);
    const ctx = makeCtx();
    const result = await wrapped(call, ctx);

    expect(filledSlotsShadow).toHaveBeenCalledTimes(1);
    expect(inner).not.toHaveBeenCalled();
    expect(JSON.parse(result.content)).toEqual({
      answered: false,
      reason: 'ask_budget_exhausted',
    });
    // Budget check happened — but the post-dispatch increment must NOT fire
    // for a short-circuited ask (Pitfall 4).
    expect(askBudget.isExhausted).toHaveBeenCalledWith('ze:0');
    expect(askBudget.increment).not.toHaveBeenCalled();
    expect(restrainedMode.recordAsk).not.toHaveBeenCalled();

    gate.destroy();
  });

  test('both inactive → gate debounces; replaced ask resolves reason="gated"; replacement fires inner; only the SUCCESSFUL fire increments counters', async () => {
    const logger = makeLogger();
    const inner = makeInnerDispatcher();
    const askBudget = makeBudget();
    const restrainedMode = makeRestrained();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });
    const filledSlotsShadow = jest.fn();

    const wrapped = wrapAskDispatcherWithGates(inner, {
      askBudget,
      restrainedMode,
      gate,
      filledSlotsShadow,
      logger,
      sessionId: 'sess-1',
    });

    const call1 = makeCall('call-1', 'ze', 0);
    const call2 = makeCall('call-2', 'ze', 0); // same key — replaces
    const ctx = makeCtx();

    const p1 = wrapped(call1, ctx);
    jest.advanceTimersByTime(400);
    const p2 = wrapped(call2, ctx);

    const r1 = await p1;
    expect(JSON.parse(r1.content).reason).toBe('gated');
    // Pitfall 4: gated short-circuit must NOT consume budget or
    // restrained-window slot.
    expect(askBudget.increment).not.toHaveBeenCalled();
    expect(restrainedMode.recordAsk).not.toHaveBeenCalled();

    jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);
    const r2 = await p2;
    expect(JSON.parse(r2.content).answered).toBe(true);

    // Only the successful fire counts.
    expect(askBudget.increment).toHaveBeenCalledTimes(1);
    expect(askBudget.increment).toHaveBeenCalledWith('ze:0');
    expect(restrainedMode.recordAsk).toHaveBeenCalledTimes(1);
    expect(restrainedMode.recordAsk).toHaveBeenCalledWith(ctx.turnId);

    // filledSlotsShadow ran on EACH attempted ask — twice.
    expect(filledSlotsShadow).toHaveBeenCalledTimes(2);

    gate.destroy();
  });

  test('filledSlotsShadow is invoked on EVERY attempted ask (regardless of subsequent short-circuit)', async () => {
    const logger = makeLogger();
    const inner = makeInnerDispatcher();
    const askBudget = makeBudget();
    const filledSlotsShadow = jest.fn();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });

    // First attempt — restrained ON, short-circuits.
    const restrainedActive = makeRestrained({ active: true });
    const wrappedActive = wrapAskDispatcherWithGates(inner, {
      askBudget,
      restrainedMode: restrainedActive,
      gate,
      filledSlotsShadow,
      logger,
      sessionId: 'sess-1',
    });
    await wrappedActive(makeCall('call-1', 'ze', 0), makeCtx());
    expect(filledSlotsShadow).toHaveBeenCalledTimes(1);

    // Second attempt — budget exhausted, short-circuits.
    const restrainedInactive = makeRestrained({ active: false });
    const askBudgetExhausted = makeBudget({ exhausted: true });
    const wrappedExhausted = wrapAskDispatcherWithGates(inner, {
      askBudget: askBudgetExhausted,
      restrainedMode: restrainedInactive,
      gate,
      filledSlotsShadow,
      logger,
      sessionId: 'sess-1',
    });
    await wrappedExhausted(makeCall('call-2', 'pfc', 0), makeCtx());
    expect(filledSlotsShadow).toHaveBeenCalledTimes(2);

    gate.destroy();
  });
});

// =============================================================================
// Group 4: synthResult shape + STO-02 logging
// =============================================================================
describe('wrapAskDispatcherWithGates — synthResult shape and logging', () => {
  test('short-circuit envelope shape: { tool_use_id: call.id, content: JSON({answered:false,reason}), is_error: false }', async () => {
    const logger = makeLogger();
    const inner = makeInnerDispatcher();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });
    const wrapped = wrapAskDispatcherWithGates(inner, {
      askBudget: makeBudget(),
      restrainedMode: makeRestrained({ active: true }),
      gate,
      filledSlotsShadow: () => {},
      logger,
      sessionId: 'sess-1',
    });

    const call = makeCall('call-1', 'ze', 0);
    const result = await wrapped(call, makeCtx());

    expect(result.tool_use_id).toBe('call-1');
    expect(typeof result.content).toBe('string');
    expect(result.is_error).toBe(false);
    const body = JSON.parse(result.content);
    expect(body.answered).toBe(false);
    expect(typeof body.reason).toBe('string');

    gate.destroy();
  });

  test('exactly one logger.info row per short-circuit path with answer_outcome === reason and wait_duration_ms === 0', async () => {
    const logger = makeLogger();
    const inner = makeInnerDispatcher();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });
    const wrapped = wrapAskDispatcherWithGates(inner, {
      askBudget: makeBudget(),
      restrainedMode: makeRestrained({ active: true }),
      gate,
      filledSlotsShadow: () => {},
      logger,
      sessionId: 'sess-1',
    });

    await wrapped(makeCall('call-1', 'ze', 0), makeCtx());

    // logAskUser uses logger.info with first arg 'stage6.ask_user' — find it.
    const askUserCalls = logger.info.mock.calls.filter((c) => c[0] === 'stage6.ask_user');
    expect(askUserCalls).toHaveLength(1);
    const payload = askUserCalls[0][1];
    expect(payload.answer_outcome).toBe('restrained_mode');
    expect(payload.wait_duration_ms).toBe(0);
    expect(payload.mode).toBe('live');
    expect(payload.tool_call_id).toBe('call-1');
    expect(payload.sessionId).toBe('sess-1');
    expect(payload.turnId).toBe('sess-1-turn-1');

    gate.destroy();
  });
});

// =============================================================================
// Group 5: Pitfall 4 — counters increment ONLY on successful fire
// =============================================================================
describe('wrapAskDispatcherWithGates — Pitfall 4: counters only on successful fire', () => {
  test('happy path: gate fires inner, wrapper increments askBudget(key) + restrainedMode.recordAsk(turnId) exactly once', async () => {
    const logger = makeLogger();
    const inner = makeInnerDispatcher({ answered: true, user_text: 'yes' });
    const askBudget = makeBudget();
    const restrainedMode = makeRestrained();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });

    const wrapped = wrapAskDispatcherWithGates(inner, {
      askBudget,
      restrainedMode,
      gate,
      filledSlotsShadow: () => {},
      logger,
      sessionId: 'sess-1',
    });

    const call = makeCall('call-1', 'ze', 0);
    const ctx = makeCtx('sess-1-turn-7');
    const promise = wrapped(call, ctx);

    jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);
    const result = await promise;

    expect(JSON.parse(result.content).answered).toBe(true);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(askBudget.increment).toHaveBeenCalledTimes(1);
    expect(askBudget.increment).toHaveBeenCalledWith('ze:0');
    expect(restrainedMode.recordAsk).toHaveBeenCalledTimes(1);
    expect(restrainedMode.recordAsk).toHaveBeenCalledWith('sess-1-turn-7');

    gate.destroy();
  });

  test('inner dispatcher returning answered:false (e.g. timeout) STILL increments counters — counters track FIRES, not user-yes outcomes', async () => {
    // Rationale: budget caps how many times Sonnet may PROBE the user for
    // a given (field, circuit). A timeout used the budget slot just as
    // surely as a real answer did — otherwise Sonnet could spam asks and
    // cycle through every counter slot without ever burning one.
    const logger = makeLogger();
    const inner = makeInnerDispatcher({ answered: false, reason: 'timeout' });
    const askBudget = makeBudget();
    const restrainedMode = makeRestrained();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });

    const wrapped = wrapAskDispatcherWithGates(inner, {
      askBudget,
      restrainedMode,
      gate,
      filledSlotsShadow: () => {},
      logger,
      sessionId: 'sess-1',
    });

    const promise = wrapped(makeCall('call-1', 'ze', 0), makeCtx());
    jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);
    await promise;

    expect(askBudget.increment).toHaveBeenCalledTimes(1);
    expect(restrainedMode.recordAsk).toHaveBeenCalledTimes(1);

    gate.destroy();
  });
});
