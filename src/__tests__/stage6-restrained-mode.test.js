/**
 * Stage 6 Phase 5 Plan 05-04 — createRestrainedMode unit tests (STT-08).
 *
 * WHAT: Locks the rolling-5-turn-window state machine that fires the
 * "restrained mode" kill switch (STA-05). 18 cases across 6 describe
 * blocks cover the activation path, window-boundary edges (the off-by-one
 * trap Research §Pitfall 2 calls out as the highest-risk surface in
 * Phase 5), the 60s wall-clock release, the activate/release callback
 * contracts, destroy() teardown semantics (silent — no onRelease), and
 * the turnId-parse fallback.
 *
 * WHY all paths are tested via fake timers:
 *   - Real wall-clock waits would push this suite past Jest's per-test
 *     budget for the 60s release case.
 *   - jest.useFakeTimers({doNotFake:['queueMicrotask','Promise','nextTick']})
 *     keeps Promise/microtask scheduling REAL while granting full control
 *     of setTimeout/clearTimeout/Date.now. Required so the rolling-window
 *     boundary tests can advance time deterministically.
 *
 * WHY a custom parseTurnFn is injected for most tests: the default parser
 * uses the regex `/-turn-(\d+)$/` to extract the integer turn number from
 * `${sessionId}-turn-${n}` ids. For the boundary tests the noise of
 * synthetic session-id prefixes obscures intent — `makeIntParse()` lets
 * `recordAsk('3')` mean "ask at turn 3". The default parser is exercised
 * end-to-end in Group 6.
 *
 * Requirements: STA-05 (the rule), STT-08 (this test file IS STT-08),
 * STB-05 (no backstop weakened — adding a guard).
 *
 * ROADMAP §Phase 5 Success Criterion #5 (verbatim):
 *   "Restrained mode: ≥3 ask_user calls in any rolling 5-turn window →
 *    60s lockout + client_diagnostic: restrained_mode_triggered once per
 *    activation".
 */

import { jest } from '@jest/globals';
import { createRestrainedMode } from '../extraction/stage6-restrained-mode.js';

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'Promise', 'nextTick'] });
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

/**
 * Injectable parseTurnFn for unit tests — bypasses the default regex.
 * Test passes turnId as the integer string directly: recordAsk('3') → 3.
 * Matches the contract documented in stage6-restrained-mode.js (parseTurnFn
 * must return an integer; never throws on malformed input).
 */
function makeIntParse() {
  return (turnId) => parseInt(turnId, 10);
}

// =============================================================================
// Group 1: Default activation path (3 tests)
// =============================================================================
describe('createRestrainedMode — Group 1: default activation path', () => {
  test('activates on 3rd ask within 5-turn window — verbatim ROADMAP SC #5 ("≥3 ask_user calls in any rolling 5-turn window")', () => {
    // Asks at turns 1, 3, 4 → all within window [0..4] of T=4 → activate.
    const onActivate = jest.fn();
    const rm = createRestrainedMode({ onActivate, parseTurnFn: makeIntParse() });

    rm.recordAsk('1');
    expect(rm.isActive()).toBe(false);
    expect(onActivate).not.toHaveBeenCalled();

    rm.recordAsk('3');
    expect(rm.isActive()).toBe(false);
    expect(onActivate).not.toHaveBeenCalled();

    rm.recordAsk('4');
    expect(rm.isActive()).toBe(true);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  test('does NOT activate with only 2 asks — under threshold', () => {
    const onActivate = jest.fn();
    const rm = createRestrainedMode({ onActivate, parseTurnFn: makeIntParse() });
    rm.recordAsk('1');
    rm.recordAsk('2');
    expect(rm.isActive()).toBe(false);
    expect(onActivate).not.toHaveBeenCalled();
    expect(rm._state().askTurns).toEqual([1, 2]);
  });

  test('does NOT activate when oldest ask rolls out of window — boundary case [1, 3, 6]', () => {
    // T=6, windowTurns=5 → window [2..6]. Turn 1 evicted.
    // askTurns becomes [3, 6] after eviction-then-push of 6 → length 2 → no activate.
    const onActivate = jest.fn();
    const rm = createRestrainedMode({ onActivate, parseTurnFn: makeIntParse() });
    rm.recordAsk('1');
    rm.recordAsk('3');
    rm.recordAsk('6');
    expect(rm.isActive()).toBe(false);
    expect(onActivate).not.toHaveBeenCalled();
    expect(rm._state().askTurns).toEqual([3, 6]);
  });
});

// =============================================================================
// Group 2: Window boundary (3 tests) — Research §Pitfall 2 off-by-one focus
// =============================================================================
describe('createRestrainedMode — Group 2: window boundary (inclusive-inclusive)', () => {
  test('inclusive boundary: asks at turns [1, 3, 5] with windowTurns=5 → 1 is on the boundary, included → activate', () => {
    // T=5, windowTurns=5 → eviction predicate: askTurns[0] < 5-(5-1) = 1 → keep ≥1.
    // Turn 1 is on the boundary, kept. askTurns=[1,3,5] length 3 ≥ triggerCount → activate.
    const onActivate = jest.fn();
    const rm = createRestrainedMode({ onActivate, parseTurnFn: makeIntParse() });
    rm.recordAsk('1');
    rm.recordAsk('3');
    rm.recordAsk('5');
    expect(rm.isActive()).toBe(true);
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(rm._state().askTurns).toEqual([1, 3, 5]);
  });

  test('just-outside boundary: asks at turns [0, 3, 5] → 0 < T-4=1 → evicted → no activate', () => {
    // T=5, eviction predicate < 1. Turn 0 is < 1, evicted before push of 5.
    // askTurns becomes [3, 5] length 2 → do NOT activate.
    const onActivate = jest.fn();
    const rm = createRestrainedMode({ onActivate, parseTurnFn: makeIntParse() });
    rm.recordAsk('0');
    rm.recordAsk('3');
    rm.recordAsk('5');
    expect(rm.isActive()).toBe(false);
    expect(onActivate).not.toHaveBeenCalled();
    expect(rm._state().askTurns).toEqual([3, 5]);
  });

  test('same turn repeated: asks at [1, 1, 1] → 3 asks at the same turn still count, activates (Research §Q6)', () => {
    // Window is turn-based, not ask-count-per-turn. Three asks at the same
    // turn integer all push onto askTurns and count toward the trigger.
    const onActivate = jest.fn();
    const rm = createRestrainedMode({ onActivate, parseTurnFn: makeIntParse() });
    rm.recordAsk('1');
    rm.recordAsk('1');
    rm.recordAsk('1');
    expect(rm.isActive()).toBe(true);
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(rm._state().askTurns).toEqual([1, 1, 1]);
  });
});

// =============================================================================
// Group 3: 60s wall-clock release (3 tests)
// =============================================================================
describe('createRestrainedMode — Group 3: 60s wall-clock release', () => {
  test('activates → advance 59999ms → still active', () => {
    const onActivate = jest.fn();
    const onRelease = jest.fn();
    const rm = createRestrainedMode({ onActivate, onRelease, parseTurnFn: makeIntParse() });
    rm.recordAsk('1');
    rm.recordAsk('2');
    rm.recordAsk('3');
    expect(rm.isActive()).toBe(true);
    jest.advanceTimersByTime(59999);
    expect(rm.isActive()).toBe(true);
    expect(onRelease).not.toHaveBeenCalled();
  });

  test('advance to 60000ms → released → onRelease called exactly once', () => {
    const onActivate = jest.fn();
    const onRelease = jest.fn();
    const rm = createRestrainedMode({ onActivate, onRelease, parseTurnFn: makeIntParse() });
    rm.recordAsk('1');
    rm.recordAsk('2');
    rm.recordAsk('3');
    jest.advanceTimersByTime(60000);
    expect(rm.isActive()).toBe(false);
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  test('custom releaseMs=30000: activates → advance 30001 → inactive', () => {
    const onRelease = jest.fn();
    const rm = createRestrainedMode({
      releaseMs: 30000,
      onRelease,
      parseTurnFn: makeIntParse(),
    });
    rm.recordAsk('1');
    rm.recordAsk('2');
    rm.recordAsk('3');
    expect(rm.isActive()).toBe(true);
    jest.advanceTimersByTime(30001);
    expect(rm.isActive()).toBe(false);
    expect(onRelease).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// Group 4: Callback contracts (3 tests)
// =============================================================================
describe('createRestrainedMode — Group 4: callback contracts', () => {
  test('onActivate fires exactly once on initial activation', () => {
    const onActivate = jest.fn();
    const rm = createRestrainedMode({ onActivate, parseTurnFn: makeIntParse() });
    rm.recordAsk('1');
    rm.recordAsk('2');
    rm.recordAsk('3');
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  test('additional recordAsk calls while active do NOT fire onActivate a second time', () => {
    // The wrapper short-circuits on isActive() before reaching recordAsk in
    // production. This test simulates a defective wrapper or paranoia: even if
    // recordAsk IS called while active, the internal !isActive guard inside
    // activate() prevents a duplicate onActivate callback (Pitfall 1 defence).
    const onActivate = jest.fn();
    const rm = createRestrainedMode({ onActivate, parseTurnFn: makeIntParse() });
    rm.recordAsk('1');
    rm.recordAsk('2');
    rm.recordAsk('3'); // activates
    expect(onActivate).toHaveBeenCalledTimes(1);
    // Hammer it — five more asks within the same window.
    rm.recordAsk('3');
    rm.recordAsk('4');
    rm.recordAsk('4');
    rm.recordAsk('5');
    rm.recordAsk('5');
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(rm.isActive()).toBe(true);
  });

  test('post-release re-activation: separate activation event, NOT a duplicate (mock.calls.length === 2)', () => {
    const onActivate = jest.fn();
    const onRelease = jest.fn();
    const rm = createRestrainedMode({ onActivate, onRelease, parseTurnFn: makeIntParse() });
    rm.recordAsk('1');
    rm.recordAsk('2');
    rm.recordAsk('3'); // activate #1
    expect(onActivate).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(60000); // release
    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(rm.isActive()).toBe(false);

    // New 5-turn window; trigger again at turns 7, 8, 9 (T=9, window [5..9]).
    rm.recordAsk('7');
    rm.recordAsk('8');
    rm.recordAsk('9'); // activate #2
    expect(onActivate).toHaveBeenCalledTimes(2);
    expect(rm.isActive()).toBe(true);
  });
});

// =============================================================================
// Group 5: Destroy + timer hygiene (3 tests)
// =============================================================================
describe('createRestrainedMode — Group 5: destroy() teardown', () => {
  test('destroy() on active state cancels the pending release timer (jest.getTimerCount() === 0)', () => {
    const rm = createRestrainedMode({ parseTurnFn: makeIntParse() });
    rm.recordAsk('1');
    rm.recordAsk('2');
    rm.recordAsk('3');
    expect(rm.isActive()).toBe(true);
    expect(jest.getTimerCount()).toBe(1);
    rm.destroy();
    expect(jest.getTimerCount()).toBe(0);
    expect(rm.isActive()).toBe(false);
  });

  test('destroy() does NOT call onRelease — silent teardown', () => {
    const onRelease = jest.fn();
    const rm = createRestrainedMode({ onRelease, parseTurnFn: makeIntParse() });
    rm.recordAsk('1');
    rm.recordAsk('2');
    rm.recordAsk('3');
    rm.destroy();
    expect(onRelease).not.toHaveBeenCalled();
    // And advancing wall-clock past the would-be release boundary stays silent.
    jest.advanceTimersByTime(120000);
    expect(onRelease).not.toHaveBeenCalled();
  });

  test('destroy() on a never-activated instance: no-op, no throw', () => {
    const onActivate = jest.fn();
    const onRelease = jest.fn();
    const rm = createRestrainedMode({ onActivate, onRelease, parseTurnFn: makeIntParse() });
    expect(() => rm.destroy()).not.toThrow();
    expect(onActivate).not.toHaveBeenCalled();
    expect(onRelease).not.toHaveBeenCalled();
    // Idempotent — second destroy still no-op.
    expect(() => rm.destroy()).not.toThrow();
  });
});

// =============================================================================
// Group 6: Turn-parse fallback (3 tests) — exercises the default parser
// =============================================================================
describe('createRestrainedMode — Group 6: default turn-id parser', () => {
  test('default parseTurn extracts integer from `${sessionId}-turn-${n}` per shadow-harness convention (line 216)', () => {
    // Activation through the real id shape: sess-abc-turn-1, -turn-3, -turn-4.
    const onActivate = jest.fn();
    const rm = createRestrainedMode({ onActivate });
    rm.recordAsk('sess-abc-turn-1');
    rm.recordAsk('sess-abc-turn-3');
    rm.recordAsk('sess-abc-turn-4');
    expect(rm.isActive()).toBe(true);
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(rm._state().askTurns).toEqual([1, 3, 4]);
  });

  test('malformed turnId: default parser falls back to monotonic counter — never throws, never blocks activation', () => {
    // Three ids that don't match `-turn-(\d+)$`. Default parser yields 1, 2, 3
    // via the closure fallback counter → askTurns becomes [1, 2, 3] which is
    // a valid 5-turn window → activates on the 3rd recordAsk.
    const onActivate = jest.fn();
    const rm = createRestrainedMode({ onActivate });
    rm.recordAsk('garbage-no-suffix');
    rm.recordAsk(undefined);
    rm.recordAsk('also-bad');
    expect(rm.isActive()).toBe(true);
    expect(onActivate).toHaveBeenCalledTimes(1);
    // Implementation-detail check: state holds the fallback integers.
    const askTurns = rm._state().askTurns;
    expect(askTurns).toHaveLength(3);
    expect(askTurns.every((n) => Number.isInteger(n))).toBe(true);
  });

  test('mixed valid/invalid turn ids: parsed integers and fallback counter both push onto askTurns', () => {
    // Defensive coverage — a real session might mix shapes during a refactor.
    // Default parser must keep emitting integers regardless.
    const onActivate = jest.fn();
    const rm = createRestrainedMode({ onActivate });
    rm.recordAsk('sess-x-turn-100'); // → 100
    rm.recordAsk('garbage'); // → fallback (1)
    rm.recordAsk('sess-x-turn-101'); // → 101
    // T=101, window [97..101]. Eviction: any turn < 97 evicted.
    // After push: [100, 1, 101] — wait, eviction runs BEFORE the push of 101.
    // Order: push 100 → askTurns=[100]. push fallback(1) → no eviction (next push is BEFORE eviction; eviction is on each recordAsk's currentTurn). Walk through:
    //   Step 1 recordAsk('sess-x-turn-100'): currentTurn=100. evict while askTurns[0]<96 — empty. push → [100].
    //   Step 2 recordAsk('garbage'): currentTurn=fallback(1). evict while askTurns[0]<-3 — false. push → [100, 1].
    //   Step 3 recordAsk('sess-x-turn-101'): currentTurn=101. evict while askTurns[0]<97 — true (100 stays — 100>=97), but 1<97? YES. So shift removes 1. Wait — askTurns[0] is 100 first, 100<97 is false, loop exits. So 1 is NOT evicted.
    // After step 3: [100, 1, 101] length 3 → activate.
    expect(rm.isActive()).toBe(true);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// Group 7: nowFn dependency injection (Plan 05-04 plan-check remediation +
// 05-06 exit-gate compatibility)
// =============================================================================
describe('createRestrainedMode — Group 7: nowFn DI hook', () => {
  test('factory accepts nowFn option; when injected, isActive() uses nowFn() (NOT Date.now()) for wall-clock comparison', () => {
    // 05-06's exit-gate harness needs to advance the rolling-window clock
    // without waiting real wall-clock. The plan-check verdict
    // (.planning-stage6-agentic/phases/05-backstops-restrained-mode/05-PLAN-CHECK.md)
    // requires this hook to land in 05-04 BEFORE Wave 2.
    //
    // Test strategy: drive nowFn() with a manual counter, NOT jest fake timers.
    // The setTimeout for the release callback still uses real (faked) timers,
    // but isActive()'s wall-clock reading is pure nowFn().
    let mockNow = 1000;
    const nowFn = () => mockNow;
    const rm = createRestrainedMode({ parseTurnFn: makeIntParse(), nowFn });

    rm.recordAsk('1');
    rm.recordAsk('2');
    rm.recordAsk('3');
    expect(rm.isActive()).toBe(true);

    // Advance ONLY the injected clock; setTimeout is still on its faked clock
    // and has not fired yet. isActive() should read nowFn() and return false.
    mockNow = 1000 + 60000; // exactly at activeUntilMs boundary → < check fails
    expect(rm.isActive()).toBe(false);

    // Roll back the clock — isActive() should flip back to true (because the
    // setTimeout-driven release timer still has not fired). This proves the
    // hook is read live on every isActive() call, not cached.
    mockNow = 1000 + 30000;
    expect(rm.isActive()).toBe(true);
  });

  test('nowFn defaults to Date.now when not provided — backward compat with 05-04 production wiring', () => {
    // Production wiring at sonnet-stream.js does NOT pass nowFn — the default
    // must keep working unchanged. Smoke test: recordAsk + isActive + release
    // path through the real-Date.now / fake-timer system.
    const onActivate = jest.fn();
    const rm = createRestrainedMode({ onActivate, parseTurnFn: makeIntParse() });
    rm.recordAsk('1');
    rm.recordAsk('2');
    rm.recordAsk('3');
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(rm.isActive()).toBe(true);
    jest.advanceTimersByTime(60000);
    expect(rm.isActive()).toBe(false);
  });
});
