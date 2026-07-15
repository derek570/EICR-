/**
 * Stage 6 Phase 6 Plan 06-02 r1-#1 — fallbackToLegacy gate on the
 * ask_user dispatcher's iOS emit.
 *
 * REQUIREMENTS: STI-06 (protocol_version handshake — when the active
 * session is in shadow mode AND the connected client did NOT advertise
 * protocol_version='stage6', sonnet-stream.js stamps
 * `entry.fallbackToLegacy = true`. The dispatcher MUST NOT emit
 * `ask_user_started` to that ws — the iOS client would not understand
 * the wire shape, defeating the whole point of the fallback flag).
 *
 * This file's contract:
 *   - Live mode + fallbackToLegacy=true:  registry.register STILL runs
 *     (Sonnet's tool loop is blocked awaiting the answer either way),
 *     but ws.send for `ask_user_started` is suppressed.
 *   - Live mode + fallbackToLegacy=false (or unset): existing behaviour
 *     — ws.send fires.
 *   - Shadow mode short-circuit: untouched. fallbackToLegacy is moot in
 *     shadow because the dispatcher already skips ws.send under shadow.
 *
 * Why a separate file: the existing stage6-dispatcher-ask.test.js is
 * already 600+ lines and tests Live / Shadow / Validation / Timeout /
 * etc. A new behaviour group lives cleaner in its own file.
 */

import { jest } from '@jest/globals';
import { createAskDispatcher } from '../extraction/stage6-dispatcher-ask.js';
import { createPendingAsksRegistry } from '../extraction/stage6-pending-asks-registry.js';

// --- helpers ----------------------------------------------------------------

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeWs() {
  const sent = [];
  return {
    readyState: 1,
    OPEN: 1,
    sent,
    send: jest.fn(function (data) {
      sent.push(JSON.parse(data));
    }),
  };
}

function makeSession(mode = 'live') {
  return { sessionId: 'sess-1', toolCallsMode: mode };
}

function validInput(overrides = {}) {
  return {
    question: 'Which circuit were you referring to?',
    reason: 'ambiguous_circuit',
    context_field: null,
    context_circuit: null,
    expected_answer_shape: 'circuit_ref',
    ...overrides,
  };
}

function makeCall(id = 'toolu_1', overrides = {}) {
  return { id, name: 'ask_user', input: validInput(overrides) };
}

// --- Group 1: fallbackToLegacy=true suppresses iOS emit --------------------

describe('createAskDispatcher — fallbackToLegacy gate (r1-#1 BLOCK)', () => {
  // F7 Item 2 step 3b — fallbackToLegacy is pre-emission/non-audible in live
  // tool-call mode (no independent legacy emission signal), so it now FAST-FAILS
  // the ask immediately (no 45s dead-air) rather than registering-and-awaiting.
  // ws.send is still suppressed and the suppression log still fires, but the
  // registry is left EMPTY and the outcome is dispatcher_error/pre_emit with a
  // fallback_to_legacy diagnostic.
  test('live + fallbackToLegacy=true: NO ws.send, suppression log fires, fast-fails pre-emission', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    try {
      const session = makeSession('live');
      const logger = makeLogger();
      const pending = createPendingAsksRegistry();
      const ws = makeWs();
      const dispatch = createAskDispatcher(session, logger, 'turn-1', pending, ws, {
        fallbackToLegacy: true,
      });

      // No external resolve, no timer advance — the fast-fail resolves it.
      const res = await dispatch(makeCall('toolu_fb1'), {
        sessionId: 'sess-1',
        turnId: 'turn-1',
      });

      // The registry is empty — the fast-fail cleared the entry + timer.
      expect(pending.size).toBe(0);

      // ws.send must NOT have been called (ask_user_started suppressed).
      expect(ws.send).not.toHaveBeenCalled();

      // Suppression visibility log still fires.
      expect(logger.info).toHaveBeenCalledWith(
        'stage6.ask_user_started_suppressed_fallback',
        expect.objectContaining({
          sessionId: 'sess-1',
          tool_call_id: 'toolu_fb1',
        })
      );

      expect(res.is_error).toBe(false);
      expect(JSON.parse(res.content).reason).toBe('dispatcher_error');
      const askRow = logger.info.mock.calls.find((c) => c[0] === 'stage6.ask_user');
      expect(askRow[1]).toMatchObject({
        answer_outcome: 'dispatcher_error',
        lifecycle: 'pre_emit',
        dispatcher_error: 'fallback_to_legacy',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  test('live + fallbackToLegacy=false (explicit): ws.send fires as today', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    try {
      const session = makeSession('live');
      const logger = makeLogger();
      const pending = createPendingAsksRegistry();
      const ws = makeWs();
      const dispatch = createAskDispatcher(session, logger, 'turn-1', pending, ws, {
        fallbackToLegacy: false,
      });

      const promise = dispatch(makeCall('toolu_fb2'), {
        sessionId: 'sess-1',
        turnId: 'turn-1',
      });
      await Promise.resolve();
      await Promise.resolve();

      // ws.send WAS called once with the ask_user_started shape.
      expect(ws.send).toHaveBeenCalledTimes(1);
      const sentMsg = ws.sent[0];
      expect(sentMsg.type).toBe('ask_user_started');
      expect(sentMsg.tool_call_id).toBe('toolu_fb2');

      // No suppression log (the gate is open).
      expect(logger.info).not.toHaveBeenCalledWith(
        'stage6.ask_user_started_suppressed_fallback',
        expect.anything()
      );

      pending.resolve('toolu_fb2', { answered: true, user_text: 'ok' });
      await promise;
    } finally {
      jest.useRealTimers();
    }
  });

  test('live + opts omitted: ws.send fires (default unspecified === false)', async () => {
    // Backward compatibility — every existing call site that does NOT pass
    // an opts arg keeps working unchanged. This is the load-bearing
    // contract for not breaking the existing 3-arg dispatcher tests.
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    try {
      const session = makeSession('live');
      const logger = makeLogger();
      const pending = createPendingAsksRegistry();
      const ws = makeWs();
      // Note: 5-arg call, no opts. Existing test surface.
      const dispatch = createAskDispatcher(session, logger, 'turn-1', pending, ws);

      const promise = dispatch(makeCall('toolu_fb3'), {
        sessionId: 'sess-1',
        turnId: 'turn-1',
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(ws.send).toHaveBeenCalledTimes(1);
      expect(ws.sent[0].type).toBe('ask_user_started');

      pending.resolve('toolu_fb3', { answered: true, user_text: 'ok' });
      await promise;
    } finally {
      jest.useRealTimers();
    }
  });

  test('shadow + fallbackToLegacy=true: short-circuit unchanged (no register, no emit)', async () => {
    // fallbackToLegacy is moot in shadow because the dispatcher's
    // shadow short-circuit skips both register and ws.send already.
    // This regression test pins the behaviour: passing fallbackToLegacy
    // in shadow mode does not change the shadow contract.
    const session = makeSession('shadow');
    const logger = makeLogger();
    const pending = createPendingAsksRegistry();
    const ws = makeWs();
    const dispatch = createAskDispatcher(session, logger, 'turn-1', pending, ws, {
      fallbackToLegacy: true,
    });

    const res = await dispatch(makeCall('toolu_fb4'), {
      sessionId: 'sess-1',
      turnId: 'turn-1',
    });

    expect(pending.size).toBe(0);
    expect(ws.send).not.toHaveBeenCalled();
    expect(res.is_error).toBe(false);
    expect(JSON.parse(res.content)).toEqual({
      answered: false,
      reason: 'shadow_mode',
    });
  });
});
