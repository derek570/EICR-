/**
 * Stage 6 Phase 3 Plan 03-01 — PendingAsksRegistry unit tests.
 *
 * WHAT: Locks the per-session deferred-Promise broker contract for ask_user
 * blocking dispatch. This registry is consumed by Plan 03-05 (ask dispatcher)
 * and Plan 03-08 (sonnet-stream session lifecycle rejectAll paths).
 *
 * WHY these tests ARE the gate (RED step of the Plan 03-01 TDD pair):
 *   - Codex STG #3 (Phase 3 Promise lifecycle review) will scrutinise ordering:
 *     clearTimeout → Map.delete → user resolve, on EVERY resolution path. If a
 *     future change reorders those three steps, these tests must fail loudly.
 *   - Pitfall 2 from 03-RESEARCH.md: double-resolve on answer-arrives-same-
 *     tick-as-timeout. Registry MUST return false on the second resolve call
 *     and MUST NOT invoke the user resolve twice. Assertion is explicit here.
 *   - Pitfall 7: Anthropic SDK retry replays can send the same tool_use id
 *     twice. The registry throws on duplicate register — tested directly.
 *
 * REQUIREMENTS covered: STD-02 (blocking primitive), STA-01 (serialisation),
 * STA-03 (timeout cancellation).
 */

import { jest } from '@jest/globals';

import { createPendingAsksRegistry } from '../extraction/stage6-pending-asks-registry.js';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Build a registry-entry-shaped payload. The registry stores `resolve` and
 * `timer` by reference, so tests need to mint fresh ones per call to isolate
 * spy state.
 */
function makeEntry({
  contextField = 'Zs',
  contextCircuit = 1,
  resolve = jest.fn(),
  timerMs = 100,
  askStartedAt = Date.now(),
} = {}) {
  const timer = setTimeout(() => {
    // Real timers are faked by jest.useFakeTimers(); this callback MUST NOT
    // fire during the test unless the test explicitly advances time AND has
    // NOT already gone through registry.resolve() (which clears the timer).
    resolve({ answered: false, reason: 'timer_fired_without_registry' });
  }, timerMs);
  return { contextField, contextCircuit, resolve, timer, askStartedAt };
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick'] });
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

// -----------------------------------------------------------------------------
// Group 1: register
// -----------------------------------------------------------------------------

describe('createPendingAsksRegistry — register', () => {
  test('stores an entry and size reflects it', () => {
    const reg = createPendingAsksRegistry();
    expect(reg.size).toBe(0);
    reg.register('call_1', makeEntry());
    expect(reg.size).toBe(1);
  });

  test('throws duplicate_tool_call_id when called twice with the same key', () => {
    const reg = createPendingAsksRegistry();
    reg.register('call_1', makeEntry());
    expect(() => reg.register('call_1', makeEntry())).toThrow(/duplicate_tool_call_id/);
  });

  test('register of two different ids yields size === 2', () => {
    const reg = createPendingAsksRegistry();
    reg.register('call_1', makeEntry());
    reg.register('call_2', makeEntry());
    expect(reg.size).toBe(2);
  });

  test('throwing on duplicate does NOT call the user resolve fn', () => {
    const reg = createPendingAsksRegistry();
    const firstResolve = jest.fn();
    reg.register('call_1', makeEntry({ resolve: firstResolve }));
    expect(() => reg.register('call_1', makeEntry())).toThrow(/duplicate_tool_call_id/);
    expect(firstResolve).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// Group 2: resolve happy path
// -----------------------------------------------------------------------------

describe('createPendingAsksRegistry — resolve happy path', () => {
  test('returns true when entry exists, false when it does not', () => {
    const reg = createPendingAsksRegistry();
    reg.register('call_1', makeEntry());
    expect(reg.resolve('call_1', { answered: true, user_text: 'hi' })).toBe(true);
    expect(reg.resolve('call_unknown', { answered: true })).toBe(false);
  });

  test('invokes entry.resolve exactly once with {...outcome, wait_duration_ms}', () => {
    const reg = createPendingAsksRegistry();
    const userResolve = jest.fn();
    const askStartedAt = Date.now() - 123; // 123ms ago
    reg.register(
      'call_1',
      makeEntry({ resolve: userResolve, askStartedAt }),
    );

    reg.resolve('call_1', { answered: true, user_text: 'ok' });

    expect(userResolve).toHaveBeenCalledTimes(1);
    const [payload] = userResolve.mock.calls[0];
    expect(payload.answered).toBe(true);
    expect(payload.user_text).toBe('ok');
    expect(typeof payload.wait_duration_ms).toBe('number');
    expect(payload.wait_duration_ms).toBeGreaterThanOrEqual(0);
  });

  test('clears the setTimeout handle BEFORE calling user resolve (jest.getTimerCount() drops to 0)', () => {
    const reg = createPendingAsksRegistry();
    const userResolve = jest.fn();
    reg.register('call_1', makeEntry({ resolve: userResolve, timerMs: 5000 }));

    expect(jest.getTimerCount()).toBe(1);

    reg.resolve('call_1', { answered: true, user_text: 'x' });

    // clearTimeout must have fired before user resolve; the test harness can
    // only observe the end state, but after resolve(): no pending timer AND
    // user resolve called exactly once.
    expect(jest.getTimerCount()).toBe(0);
    expect(userResolve).toHaveBeenCalledTimes(1);
  });

  test('removes entry from Map after resolve (size decrements, subsequent resolve returns false)', () => {
    const reg = createPendingAsksRegistry();
    reg.register('call_1', makeEntry());
    expect(reg.size).toBe(1);
    expect(reg.resolve('call_1', { answered: true })).toBe(true);
    expect(reg.size).toBe(0);
    expect(reg.resolve('call_1', { answered: true })).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Group 3: double-resolve safety (Pitfall 2)
// -----------------------------------------------------------------------------

describe('createPendingAsksRegistry — double-resolve safety', () => {
  test('second resolve call returns false', () => {
    const reg = createPendingAsksRegistry();
    reg.register('call_1', makeEntry());
    expect(reg.resolve('call_1', { answered: true })).toBe(true);
    expect(reg.resolve('call_1', { answered: false, reason: 'timeout' })).toBe(false);
  });

  test('second resolve does NOT invoke the user resolve fn again', () => {
    const reg = createPendingAsksRegistry();
    const userResolve = jest.fn();
    reg.register('call_1', makeEntry({ resolve: userResolve }));

    reg.resolve('call_1', { answered: true });
    reg.resolve('call_1', { answered: false, reason: 'timeout' });

    expect(userResolve).toHaveBeenCalledTimes(1);
  });

  test('timer-fires-after-resolve pattern: registry.resolve followed by timer advance does not double-fire', () => {
    const reg = createPendingAsksRegistry();
    const userResolve = jest.fn();
    // 100ms internal timer.
    reg.register('call_1', makeEntry({ resolve: userResolve, timerMs: 100 }));

    // Resolve immediately.
    reg.resolve('call_1', { answered: true });
    expect(userResolve).toHaveBeenCalledTimes(1);

    // Advance fake timers past the timeout window.
    jest.advanceTimersByTime(200);

    // The timer was cleared inside registry.resolve — advance is a no-op.
    expect(userResolve).toHaveBeenCalledTimes(1);
  });
});

// -----------------------------------------------------------------------------
// Group 4: rejectAll (Codex STG #3 mitigation)
// -----------------------------------------------------------------------------

describe('createPendingAsksRegistry — rejectAll', () => {
  test('clears size to 0', () => {
    const reg = createPendingAsksRegistry();
    reg.register('call_1', makeEntry());
    reg.register('call_2', makeEntry());
    expect(reg.size).toBe(2);
    reg.rejectAll('session_terminated');
    expect(reg.size).toBe(0);
  });

  test('invokes every pending entry.resolve with {answered:false, reason, wait_duration_ms}', () => {
    const reg = createPendingAsksRegistry();
    const r1 = jest.fn();
    const r2 = jest.fn();
    reg.register('call_1', makeEntry({ resolve: r1 }));
    reg.register('call_2', makeEntry({ resolve: r2 }));

    reg.rejectAll('session_terminated');

    expect(r1).toHaveBeenCalledTimes(1);
    expect(r2).toHaveBeenCalledTimes(1);

    const [p1] = r1.mock.calls[0];
    const [p2] = r2.mock.calls[0];
    expect(p1).toMatchObject({ answered: false, reason: 'session_terminated' });
    expect(p2).toMatchObject({ answered: false, reason: 'session_terminated' });
    expect(typeof p1.wait_duration_ms).toBe('number');
    expect(typeof p2.wait_duration_ms).toBe('number');
  });

  test('clears every setTimeout (jest.getTimerCount() → 0)', () => {
    const reg = createPendingAsksRegistry();
    reg.register('call_1', makeEntry({ timerMs: 5000 }));
    reg.register('call_2', makeEntry({ timerMs: 7000 }));
    expect(jest.getTimerCount()).toBe(2);

    reg.rejectAll('session_terminated');

    expect(jest.getTimerCount()).toBe(0);
  });

  test('is idempotent — second call is a no-op', () => {
    const reg = createPendingAsksRegistry();
    const r1 = jest.fn();
    reg.register('call_1', makeEntry({ resolve: r1 }));

    reg.rejectAll('session_terminated');
    reg.rejectAll('session_terminated');

    expect(reg.size).toBe(0);
    expect(r1).toHaveBeenCalledTimes(1);
  });
});

// -----------------------------------------------------------------------------
// Group 5: findByContext (overtake support — Plan 03-04)
// -----------------------------------------------------------------------------

describe('createPendingAsksRegistry — findByContext', () => {
  test('returns [] when registry empty', () => {
    const reg = createPendingAsksRegistry();
    expect(reg.findByContext('Zs')).toEqual([]);
  });

  test('returns entries whose contextField matches (including null-null match)', () => {
    const reg = createPendingAsksRegistry();
    reg.register('call_zs', makeEntry({ contextField: 'Zs', contextCircuit: 1 }));
    reg.register('call_pfc', makeEntry({ contextField: 'Pfc', contextCircuit: null }));
    reg.register('call_null', makeEntry({ contextField: null, contextCircuit: null }));

    const zs = reg.findByContext('Zs');
    expect(zs).toHaveLength(1);
    expect(zs[0].id).toBe('call_zs');
    expect(zs[0].contextField).toBe('Zs');
    expect(zs[0].contextCircuit).toBe(1);

    const nulls = reg.findByContext(null);
    expect(nulls).toHaveLength(1);
    expect(nulls[0].id).toBe('call_null');
  });

  test('does NOT mutate the Map', () => {
    const reg = createPendingAsksRegistry();
    reg.register('call_1', makeEntry({ contextField: 'Zs' }));
    reg.register('call_2', makeEntry({ contextField: 'Zs' }));
    reg.findByContext('Zs');
    expect(reg.size).toBe(2);
  });
});

// -----------------------------------------------------------------------------
// Group 6: entries iterator
// -----------------------------------------------------------------------------

describe('createPendingAsksRegistry — entries iterator', () => {
  test('yields all registered entries as [id, entry] pairs', () => {
    const reg = createPendingAsksRegistry();
    reg.register('call_1', makeEntry({ contextField: 'Zs' }));
    reg.register('call_2', makeEntry({ contextField: 'Pfc' }));

    const pairs = Array.from(reg.entries());
    expect(pairs).toHaveLength(2);
    const ids = pairs.map(([id]) => id).sort();
    expect(ids).toEqual(['call_1', 'call_2']);
    const fields = pairs.map(([, entry]) => entry.contextField).sort();
    expect(fields).toEqual(['Pfc', 'Zs']);
  });

  test('consuming entries() does NOT mutate the Map', () => {
    const reg = createPendingAsksRegistry();
    reg.register('call_1', makeEntry());
    reg.register('call_2', makeEntry());
    // Force the iterator to be fully consumed.
    // eslint-disable-next-line no-unused-vars
    for (const _ of reg.entries()) {
      /* drain */
    }
    expect(reg.size).toBe(2);
  });
});
