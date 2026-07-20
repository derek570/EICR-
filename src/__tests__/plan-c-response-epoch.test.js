/**
 * PLAN-C P4c — response-epoch ownership contract.
 *
 * Deterministic unit coverage for the load-bearing pieces of the contract:
 *   - `advanceResponseEpoch` (the advance-only-on-non-empty rule + the two
 *     answer-channel outcome keys)
 *   - `PendingAsksRegistry.resolve` / `rejectAll` carrying the epoch through
 *     every resolution path (answer, user_moved_on, lifecycle sweep)
 *
 * These stand in for the plan's eight named scenarios at the semantic level
 * (which utterance id ends up owning the outbound speech, and which
 * resolutions must NOT move the reference). Full A→B harness integration —
 * an ask on utterance A answered by a later chimed utterance B, asserting B's
 * id reaches `bundleToolCallsIntoResult` — rides the existing
 * shadow-harness/dispatcher suites plus the emit-site row tests (P4d).
 */
import { jest } from '@jest/globals';
import { advanceResponseEpoch } from '../extraction/stage6-dispatcher-ask.js';
import { createPendingAsksRegistry } from '../extraction/stage6-pending-asks-registry.js';

describe('PLAN-C P4c — advanceResponseEpoch', () => {
  test('advances on outcome.utterance_id (direct ask_user_answered frame path)', () => {
    const ref = { current: 'A' };
    advanceResponseEpoch(ref, { answered: true, utterance_id: 'B' });
    expect(ref.current).toBe('B');
  });

  test('advances on outcome.response_utterance_id (transcript-origin path)', () => {
    const ref = { current: 'A' };
    advanceResponseEpoch(ref, { answered: true, response_utterance_id: 'B' });
    expect(ref.current).toBe('B');
  });

  test('utterance_id takes precedence when both keys are present', () => {
    const ref = { current: 'A' };
    advanceResponseEpoch(ref, { utterance_id: 'DIRECT', response_utterance_id: 'TRANSCRIPT' });
    expect(ref.current).toBe('DIRECT');
  });

  test('does NOT advance on a timeout outcome (no epoch)', () => {
    const ref = { current: 'A' };
    advanceResponseEpoch(ref, { answered: false, reason: 'timeout', wait_duration_ms: 20000 });
    expect(ref.current).toBe('A');
  });

  test('does NOT advance on an empty-string epoch', () => {
    const ref = { current: 'A' };
    advanceResponseEpoch(ref, { utterance_id: '', response_utterance_id: '' });
    expect(ref.current).toBe('A');
  });

  test('does NOT advance on a non-string epoch (null / number / object)', () => {
    const ref = { current: 'A' };
    advanceResponseEpoch(ref, { utterance_id: null, response_utterance_id: null });
    expect(ref.current).toBe('A');
    advanceResponseEpoch(ref, { response_utterance_id: 12345 });
    expect(ref.current).toBe('A');
    advanceResponseEpoch(ref, { response_utterance_id: { id: 'x' } });
    expect(ref.current).toBe('A');
  });

  test('is null-safe (no ref, non-object ref, no outcome)', () => {
    expect(() => advanceResponseEpoch(null, { utterance_id: 'B' })).not.toThrow();
    expect(() => advanceResponseEpoch('nope', { utterance_id: 'B' })).not.toThrow();
    expect(() => advanceResponseEpoch({ current: 'A' }, null)).not.toThrow();
    expect(() => advanceResponseEpoch({ current: 'A' }, 'nope')).not.toThrow();
  });

  test('is idempotent — re-advancing to the same non-empty epoch is stable', () => {
    const ref = { current: 'A' };
    advanceResponseEpoch(ref, { response_utterance_id: 'B' });
    advanceResponseEpoch(ref, { response_utterance_id: 'B' });
    expect(ref.current).toBe('B');
  });
});

describe('PLAN-C P4c — registry carries the epoch through resolutions', () => {
  function registerAsk(reg, id) {
    return new Promise((resolve) => {
      reg.register(id, {
        contextField: 'r1_r2_ohm',
        contextCircuit: 1,
        resolve,
        timer: setTimeout(() => {}, 60000),
        askStartedAt: Date.now(),
      });
    });
  }

  test('resolve() outcome carries response_utterance_id (transcript-origin answer)', async () => {
    const reg = createPendingAsksRegistry();
    const awaited = registerAsk(reg, 'call-1');
    reg.resolve('call-1', { answered: true, user_text: '0.35', response_utterance_id: 'B' });
    const outcome = await awaited;
    expect(outcome.answered).toBe(true);
    expect(outcome.response_utterance_id).toBe('B');
  });

  test('resolve() outcome carries utterance_id (direct-frame answer)', async () => {
    const reg = createPendingAsksRegistry();
    const awaited = registerAsk(reg, 'call-2');
    reg.resolve('call-2', { answered: true, user_text: 'yes', utterance_id: 'B' });
    const outcome = await awaited;
    expect(outcome.utterance_id).toBe('B');
  });

  test('rejectAll(reason, {response_utterance_id}) spreads the patch into the outcome (user_moved_on)', async () => {
    const reg = createPendingAsksRegistry();
    const awaited = registerAsk(reg, 'call-3');
    reg.rejectAll('user_moved_on', { response_utterance_id: 'B' });
    const outcome = await awaited;
    expect(outcome.answered).toBe(false);
    expect(outcome.reason).toBe('user_moved_on');
    expect(outcome.response_utterance_id).toBe('B');
  });

  test('rejectAll reserved verdict keys win over the patch (cannot forge the verdict)', async () => {
    const reg = createPendingAsksRegistry();
    const awaited = registerAsk(reg, 'call-4');
    // A hostile / buggy patch tries to flip the verdict — reserved keys must win.
    reg.rejectAll('user_moved_on', {
      answered: true,
      reason: 'forged',
      wait_duration_ms: -1,
      response_utterance_id: 'B',
    });
    const outcome = await awaited;
    expect(outcome.answered).toBe(false);
    expect(outcome.reason).toBe('user_moved_on');
    expect(outcome.wait_duration_ms).toBeGreaterThanOrEqual(0);
    expect(outcome.response_utterance_id).toBe('B');
  });

  test('lifecycle sweep rejectAll(reason) — NO patch → outcome carries no epoch (must not advance)', async () => {
    const reg = createPendingAsksRegistry();
    const awaited = registerAsk(reg, 'call-5');
    reg.rejectAll('session_terminated');
    const outcome = await awaited;
    expect(outcome.reason).toBe('session_terminated');
    expect(outcome.response_utterance_id).toBeUndefined();
    // And advancing off this teardown outcome is a no-op.
    const ref = { current: 'A' };
    advanceResponseEpoch(ref, outcome);
    expect(ref.current).toBe('A');
  });

  test('rejectAll ignores a non-object patch (default {} byte-identical shape)', async () => {
    const reg = createPendingAsksRegistry();
    const awaited = registerAsk(reg, 'call-6');
    reg.rejectAll('session_stopped', 'not-an-object');
    const outcome = await awaited;
    expect(outcome.reason).toBe('session_stopped');
    expect(outcome.response_utterance_id).toBeUndefined();
  });
});

describe('PLAN-C P4c — end-to-end epoch advance (A→B simulation)', () => {
  test('an ask opened on utterance A, answered by chimed utterance B → ref advances to B', async () => {
    // Seed as runLiveMode does: the reference starts at the loop-opening id A.
    const responseEpochRef = { current: 'utt-A' };
    const reg = createPendingAsksRegistry();
    const awaited = new Promise((resolve) => {
      reg.register('ask-A', {
        contextField: 'r1_r2_ohm',
        contextCircuit: 4,
        resolve,
        timer: setTimeout(() => {}, 60000),
        askStartedAt: Date.now(),
      });
    });
    // Utterance B answers it via the transcript-origin path.
    reg.resolve('ask-A', { answered: true, user_text: '0.35', response_utterance_id: 'utt-B' });
    const outcome = await awaited;
    // The dispatcher advance step:
    advanceResponseEpoch(responseEpochRef, outcome);
    // Post-answer confirmations now carry B's id — the watchdog B armed disarms.
    expect(responseEpochRef.current).toBe('utt-B');
  });

  test('an unanswered ask that times out leaves the reference at A (no false advance)', async () => {
    const responseEpochRef = { current: 'utt-A' };
    const reg = createPendingAsksRegistry();
    const awaited = new Promise((resolve) => {
      reg.register('ask-A', {
        contextField: 'r1_r2_ohm',
        contextCircuit: 4,
        resolve,
        timer: setTimeout(() => {}, 60000),
        askStartedAt: Date.now(),
      });
    });
    reg.resolve('ask-A', { answered: false, reason: 'timeout' });
    const outcome = await awaited;
    advanceResponseEpoch(responseEpochRef, outcome);
    expect(responseEpochRef.current).toBe('utt-A');
  });
});
