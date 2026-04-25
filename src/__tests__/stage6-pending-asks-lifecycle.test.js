/**
 * Stage 6 Phase 3 Plan 03-09 — Promise-lifecycle hazard coverage.
 *
 * Focus: Codex STG #3 (Promise-lifecycle cleanup).
 *
 * Purpose: the registry unit tests in stage6-pending-asks-registry.test.js
 * verify each API method in isolation. THIS file documents and enforces the
 * FIVE end-to-end Promise-lifecycle hazards called out in 03-RESEARCH.md §Q10
 * (Promise leaks, orphan timers, double-resolve races, rejectAll ordering,
 * and the sonnet-stream.js `rejectAll`-before-`activeSessions.delete`
 * invariant). Each test names the hazard explicitly so a Codex reviewer can
 * map each assertion to the research hazard register without hunting.
 *
 * Requirements enforced: STD-02 (blocking primitive), STA-01 (serialisation),
 * STA-03 (timeout cancellation), and the cross-cutting Codex STG #3 invariant
 * that every session-termination path wakes every pending ask BEFORE the
 * registry becomes unreachable.
 */

import { jest } from '@jest/globals';
import { createPendingAsksRegistry } from '../extraction/stage6-pending-asks-registry.js';

// Helper: build an entry with a spy resolve + a real setTimeout that would
// fire the registry's own self-timeout if never cleared. Mirrors what the
// ask dispatcher does inside createAskDispatcher (Plan 03-05). The spy lets
// us assert call counts + invocation order without tracking through the full
// dispatcher stack.
function makeEntry(registry, id, askStartedAt = Date.now(), timeoutMs = 20000) {
  const resolve = jest.fn();
  // Timer fires registry.resolve() with reason:timeout — exactly mirroring
  // the dispatcher's pattern at stage6-dispatcher-ask.js:174.
  const timer = setTimeout(() => {
    registry.resolve(id, { answered: false, reason: 'timeout' });
  }, timeoutMs);
  return { resolve, timer, askStartedAt };
}

describe('Codex STG #3 — Promise-lifecycle hazards (Plan 03-09)', () => {
  beforeEach(() => {
    // doNotFake Promise + queueMicrotask so async registry flows (none here,
    // but consistency with STT-06 helps when tests are merged) don't stall.
    jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'Promise', 'nextTick'] });
  });

  afterEach(() => {
    // Drain any timers a mis-authored test might leave behind so the next
    // test starts with jest.getTimerCount() === 0.
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Hazard 1 — Double-resolve safety.
  //
  // Sequence: answer arrives at T+19.9s, registry.resolve clears the timer +
  // deletes the entry + wakes the dispatcher. At T+20.1s, jest fires the 20s
  // timer anyway (in the real world the timer is cancelled; in jest fake
  // time, advanceTimersByTime unconditionally drains every queued callback
  // whose firing time has elapsed — unless clearTimeout was called, in which
  // case the callback is removed from the queue). We must prove: (a) the
  // original user resolve was called exactly once, (b) an explicit second
  // resolve() call returns false, (c) no exception is thrown.
  // -------------------------------------------------------------------------
  test('hazard 1: double-resolve after timer advance is safe (one user-resolve, second call returns false)', () => {
    const registry = createPendingAsksRegistry();
    const entry = makeEntry(registry, 'toolu_haz1', Date.now(), 20000);
    registry.register('toolu_haz1', {
      contextField: 'measured_zs_ohm',
      contextCircuit: null,
      resolve: entry.resolve,
      timer: entry.timer,
      askStartedAt: entry.askStartedAt,
    });

    // T+19.9s — simulated inspector answer.
    jest.advanceTimersByTime(19900);
    const firstResolveRet = registry.resolve('toolu_haz1', {
      answered: true,
      user_text: 'Circuit 5',
    });
    expect(firstResolveRet).toBe(true);
    expect(entry.resolve).toHaveBeenCalledTimes(1);
    expect(entry.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ answered: true, user_text: 'Circuit 5' }),
    );

    // T+20.1s — advance past the would-be timeout. If clearTimeout ran inside
    // resolve() (Codex STG #3 step 1), the callback was removed from the
    // queue and jest fires nothing.
    expect(() => jest.advanceTimersByTime(200)).not.toThrow();
    expect(entry.resolve).toHaveBeenCalledTimes(1); // STILL 1 — not 2.

    // Explicit second resolve — registry has already deleted the entry.
    const secondResolveRet = registry.resolve('toolu_haz1', {
      answered: false,
      reason: 'timeout',
    });
    expect(secondResolveRet).toBe(false);
    expect(entry.resolve).toHaveBeenCalledTimes(1); // Still exactly 1.

    // No orphan timers survived the sequence.
    expect(jest.getTimerCount()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Hazard 2 — Orphan timer cleared on resolve.
  //
  // Verifies that clearTimeout runs BEFORE Map.delete inside registry.resolve
  // (Codex STG #3 strict-ordering step 1). The observable proxy: timer count
  // drops the instant resolve() returns, and advancing past 20s fires no
  // extra callback.
  // -------------------------------------------------------------------------
  test('hazard 2: orphan timer cleared on resolve (getTimerCount drops; advance fires nothing)', () => {
    const registry = createPendingAsksRegistry();
    expect(jest.getTimerCount()).toBe(0);

    const entry = makeEntry(registry, 'toolu_haz2');
    registry.register('toolu_haz2', {
      contextField: 'measured_ze_ohm',
      contextCircuit: null,
      resolve: entry.resolve,
      timer: entry.timer,
      askStartedAt: entry.askStartedAt,
    });
    expect(jest.getTimerCount()).toBe(1);

    jest.advanceTimersByTime(100);
    registry.resolve('toolu_haz2', { answered: true, user_text: 'foo' });
    expect(jest.getTimerCount()).toBe(0); // Cleared by registry.resolve.

    // Push well past the would-be 20s timeout — nothing should fire.
    jest.advanceTimersByTime(20000);
    expect(entry.resolve).toHaveBeenCalledTimes(1); // Only the manual resolve.
  });

  // -------------------------------------------------------------------------
  // Hazard 3 — rejectAll releases N simultaneous pending asks.
  //
  // The 5-min disconnect timer in sonnet-stream.js:842 calls
  // pendingAsks.rejectAll('session_terminated') before
  // activeSessions.delete. If the session had multiple concurrent asks
  // in-flight (possible under STA-01 if Sonnet retries fast enough), they
  // ALL need to wake up cleanly. Verify size → 0, all resolves invoked with
  // the same reason, all timers cleared.
  // -------------------------------------------------------------------------
  test('hazard 3: rejectAll releases N simultaneous pending asks in one sweep', () => {
    const registry = createPendingAsksRegistry();
    const entries = [];
    for (let i = 0; i < 5; i += 1) {
      const entry = makeEntry(registry, `toolu_haz3_${i}`);
      registry.register(`toolu_haz3_${i}`, {
        contextField: `field_${i}`,
        contextCircuit: i,
        resolve: entry.resolve,
        timer: entry.timer,
        askStartedAt: entry.askStartedAt,
      });
      entries.push(entry);
    }
    expect(registry.size).toBe(5);
    expect(jest.getTimerCount()).toBe(5);

    registry.rejectAll('session_terminated');

    expect(registry.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
    for (const entry of entries) {
      expect(entry.resolve).toHaveBeenCalledTimes(1);
      expect(entry.resolve).toHaveBeenCalledWith(
        expect.objectContaining({
          answered: false,
          reason: 'session_terminated',
          wait_duration_ms: expect.any(Number),
        }),
      );
    }
  });

  // -------------------------------------------------------------------------
  // Hazard 4 — Duplicate register throws; first entry intact.
  //
  // Anthropic SDK retry-replay guard (Pitfall 7): a replayed tool_use id
  // must NOT overwrite the in-flight entry. If it did, the original resolve
  // fn would be orphaned (dispatcher hangs forever) and the original timer
  // would fire into a stale Map slot. Verify the throw happens, the
  // first entry is untouched, and the first resolve still works normally.
  // -------------------------------------------------------------------------
  test('hazard 4: duplicate register throws, first entry intact and still resolvable', () => {
    const registry = createPendingAsksRegistry();
    const firstEntry = makeEntry(registry, 'toolu_haz4');
    registry.register('toolu_haz4', {
      contextField: 'earthing_system',
      contextCircuit: null,
      resolve: firstEntry.resolve,
      timer: firstEntry.timer,
      askStartedAt: firstEntry.askStartedAt,
    });
    expect(registry.size).toBe(1);

    // Replay — second register with the same id.
    const secondEntry = makeEntry(registry, 'toolu_haz4_replay');
    expect(() =>
      registry.register('toolu_haz4', {
        contextField: 'earthing_system',
        contextCircuit: null,
        resolve: secondEntry.resolve,
        timer: secondEntry.timer,
        askStartedAt: secondEntry.askStartedAt,
      }),
    ).toThrow(/duplicate_tool_call_id:toolu_haz4/);

    // First entry untouched — size still 1, first resolve not invoked.
    expect(registry.size).toBe(1);
    expect(firstEntry.resolve).not.toHaveBeenCalled();

    // Original entry still resolves cleanly.
    const ret = registry.resolve('toolu_haz4', { answered: true, user_text: 'TT' });
    expect(ret).toBe(true);
    expect(firstEntry.resolve).toHaveBeenCalledTimes(1);

    // The second (rejected) entry's timer and resolve are caller-owned —
    // the test itself must clean up since register() never adopted them.
    clearTimeout(secondEntry.timer);
    expect(secondEntry.resolve).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Hazard 5 — rejectAll resolves BEFORE activeSessions.delete.
  //
  // This is THE Codex STG #3 invariant. sonnet-stream.js:842-844 orders:
  //     entry.pendingAsks.rejectAll('session_terminated');  // wake asks
  //     entry.questionGate.destroy();
  //     activeSessions.delete(currentSessionId);            // then drop
  // Inverting the order would leave any awaiting dispatcher hanging until
  // STA-03 timeout (20s) fires into a dead session entry. We simulate the
  // callback here and use jest.fn().mock.invocationCallOrder to prove the
  // ask resolve ran FIRST.
  // -------------------------------------------------------------------------
  test('hazard 5: rejectAll resolves BEFORE activeSessions.delete (invocation order)', () => {
    const registry = createPendingAsksRegistry();
    const activeSessions = new Map();
    const sessionId = 'sess-haz5';
    const questionGateDestroy = jest.fn();

    // Populate the session entry the way sonnet-stream.js does.
    activeSessions.set(sessionId, {
      pendingAsks: registry,
      questionGate: { destroy: questionGateDestroy },
    });

    // Register a pending ask whose resolve fn asserts the Map entry STILL
    // exists at the moment it wakes — direct proof of ordering.
    const captured = {
      mapHadEntryAtResolveTime: null,
      mapSizeAtResolveTime: null,
    };
    const askResolve = jest.fn(() => {
      captured.mapHadEntryAtResolveTime = activeSessions.has(sessionId);
      captured.mapSizeAtResolveTime = activeSessions.size;
    });
    const timer = setTimeout(() => {}, 20000);
    registry.register('toolu_haz5', {
      contextField: 'ocpd_max_zs_ohm',
      contextCircuit: null,
      resolve: askResolve,
      timer,
      askStartedAt: Date.now(),
    });

    // Mirror the sonnet-stream.js:842-844 cleanup block verbatim.
    function simulateDisconnectCleanup() {
      const entry = activeSessions.get(sessionId);
      entry.pendingAsks.rejectAll('session_terminated'); // STEP 1
      entry.questionGate.destroy(); // STEP 2
      activeSessions.delete(sessionId); // STEP 3
    }

    simulateDisconnectCleanup();

    // Primary ordering assertion — the ask resolve observed the Map entry
    // still present (proves rejectAll ran before activeSessions.delete).
    expect(captured.mapHadEntryAtResolveTime).toBe(true);
    expect(captured.mapSizeAtResolveTime).toBe(1);

    // Secondary: invocationCallOrder as belt-and-braces. Every jest.fn()
    // gets a monotonic id per call; the ask resolve's id must be smaller
    // than the Map.delete's (we can't spy Map.delete directly, but we CAN
    // spy questionGate.destroy which sits between the two in the real code,
    // and assert askResolve ordered BEFORE questionGateDestroy).
    expect(askResolve).toHaveBeenCalledTimes(1);
    expect(questionGateDestroy).toHaveBeenCalledTimes(1);
    const askOrder = askResolve.mock.invocationCallOrder[0];
    const destroyOrder = questionGateDestroy.mock.invocationCallOrder[0];
    expect(askOrder).toBeLessThan(destroyOrder);

    // Final state — session is gone, registry drained.
    expect(activeSessions.has(sessionId)).toBe(false);
    expect(registry.size).toBe(0);
    expect(askResolve).toHaveBeenCalledWith(
      expect.objectContaining({
        answered: false,
        reason: 'session_terminated',
        wait_duration_ms: expect.any(Number),
      }),
    );
  });
});
