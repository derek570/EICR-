/**
 * Stage 6 Phase 3 Plan 03-05 — createAskDispatcher unit tests.
 *
 * WHAT: Locks the blocking ask_user dispatcher lifecycle contract (STS-07,
 * STD-02, STA-01, STA-03, STO-02). The dispatcher is the first Phase 3 module
 * to compose the Wave 1 primitives — validator (Plan 03-02), registry
 * (Plan 03-01), and logger (Plan 03-03) — into the runToolLoop contract.
 *
 * WHY unit tests use a REAL PendingAsksRegistry (not a mock): the registry's
 * strict resolve-ordering (clearTimeout → delete → resolve) is an invariant
 * the dispatcher relies on. A mock could masquerade as compliant while
 * silently drifting. Live happy path + timeout path drive the real registry;
 * only the duplicate-id path pre-seeds a fake entry manually to trigger the
 * register() guard. (STT-05/06/07 integration tests in Plan 03-09 will drive
 * the dispatcher from the full harness.)
 *
 * WHY jest.useFakeTimers({doNotFake:['nextTick']}): the 20s setTimeout must
 * be deterministically advanced; but the Promise microtask queue must still
 * drain naturally. Standard Node async-timer testing pattern.
 */

import { jest } from '@jest/globals';
import {
  createAskDispatcher,
  ASK_USER_TIMEOUT_MS,
} from '../extraction/stage6-dispatcher-ask.js';
import { createPendingAsksRegistry } from '../extraction/stage6-pending-asks-registry.js';

// --- helpers ----------------------------------------------------------------

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeWs({ open = true } = {}) {
  const sent = [];
  return {
    readyState: open ? 1 : 3,
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

// --- Group 1: Validation guard ---------------------------------------------

describe('createAskDispatcher — validation guard (STS-07)', () => {
  test('missing question → is_error:true, body {answered:false,reason:validation_error,code:invalid_question}, log validation_error', async () => {
    const session = makeSession('live');
    const logger = makeLogger();
    const pending = createPendingAsksRegistry();
    const ws = makeWs();
    const dispatch = createAskDispatcher(session, logger, 'turn-1', pending, ws);

    const call = makeCall('toolu_a', { question: '' });
    const res = await dispatch(call, { sessionId: 'sess-1', turnId: 'turn-1' });

    expect(res.is_error).toBe(true);
    expect(res.tool_use_id).toBe('toolu_a');
    expect(JSON.parse(res.content)).toEqual({
      answered: false,
      reason: 'validation_error',
      code: 'invalid_question',
    });
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      'stage6.ask_user',
      expect.objectContaining({
        answer_outcome: 'validation_error',
        validation_error: 'invalid_question',
        mode: 'live',
      }),
    );
  });

  test('invalid reason enum → body.code=invalid_reason, is_error:true', async () => {
    const session = makeSession('live');
    const logger = makeLogger();
    const pending = createPendingAsksRegistry();
    const dispatch = createAskDispatcher(session, logger, 'turn-1', pending, makeWs());

    const res = await dispatch(
      makeCall('toolu_b', { reason: 'NOT_A_REAL_REASON' }),
      { sessionId: 'sess-1', turnId: 'turn-1' },
    );

    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content)).toMatchObject({
      answered: false,
      reason: 'validation_error',
      code: 'invalid_reason',
    });
  });

  test('validation runs BEFORE registry.register (registry.size stays 0)', async () => {
    const session = makeSession('live');
    const logger = makeLogger();
    const pending = createPendingAsksRegistry();
    const dispatch = createAskDispatcher(session, logger, 'turn-1', pending, makeWs());

    await dispatch(makeCall('toolu_c', { question: '' }), {
      sessionId: 'sess-1',
      turnId: 'turn-1',
    });
    expect(pending.size).toBe(0);
  });
});

// --- Group 2: Shadow-mode short-circuit (Research §Q5, Open Q #5) ----------

describe('createAskDispatcher — shadow-mode short-circuit', () => {
  test('shadow mode: never calls register, never calls ws.send, returns shadow_mode body', async () => {
    const session = makeSession('shadow');
    const logger = makeLogger();
    const pending = createPendingAsksRegistry();
    const registerSpy = jest.spyOn(pending, 'register');
    const ws = makeWs();
    const dispatch = createAskDispatcher(session, logger, 'turn-1', pending, ws);

    const res = await dispatch(makeCall('toolu_sh1'), {
      sessionId: 'sess-1',
      turnId: 'turn-1',
    });

    expect(registerSpy).not.toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalled();
    expect(res.is_error).toBe(false);
    expect(JSON.parse(res.content)).toEqual({ answered: false, reason: 'shadow_mode' });
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      'stage6.ask_user',
      expect.objectContaining({
        answer_outcome: 'shadow_mode',
        mode: 'shadow',
        wait_duration_ms: 0,
      }),
    );
  });

  test('shadow mode: no timer scheduled (jest.getTimerCount unchanged)', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    try {
      const before = jest.getTimerCount();
      const session = makeSession('shadow');
      const logger = makeLogger();
      const pending = createPendingAsksRegistry();
      const dispatch = createAskDispatcher(session, logger, 'turn-1', pending, makeWs());

      await dispatch(makeCall('toolu_sh2'), { sessionId: 'sess-1', turnId: 'turn-1' });
      expect(jest.getTimerCount()).toBe(before);
    } finally {
      jest.useRealTimers();
    }
  });

  test('shadow mode with ws=null does not throw', async () => {
    const session = makeSession('shadow');
    const logger = makeLogger();
    const pending = createPendingAsksRegistry();
    const dispatch = createAskDispatcher(session, logger, 'turn-1', pending, null);

    const res = await dispatch(makeCall('toolu_sh3'), {
      sessionId: 'sess-1',
      turnId: 'turn-1',
    });
    expect(res.is_error).toBe(false);
    expect(JSON.parse(res.content).reason).toBe('shadow_mode');
  });
});

// --- Group 3: Live happy path ---------------------------------------------

describe('createAskDispatcher — live happy path', () => {
  test('live mode: registers, emits ask_user_started, resolves via registry.resolve → answered body + log', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    try {
      const session = makeSession('live');
      const logger = makeLogger();
      const pending = createPendingAsksRegistry();
      const ws = makeWs();
      const dispatch = createAskDispatcher(session, logger, 'turn-1', pending, ws);

      const call = makeCall('toolu_h1', {
        question: 'Which circuit were you referring to?',
        reason: 'ambiguous_circuit',
        context_field: 'circuit_designation',
        context_circuit: 3,
        expected_answer_shape: 'circuit_ref',
      });

      const p = dispatch(call, { sessionId: 'sess-1', turnId: 'turn-1' });

      // Microtasks have run; registration + ws.send should have happened.
      await Promise.resolve();
      await Promise.resolve();

      expect(pending.size).toBe(1);
      expect(ws.send).toHaveBeenCalledTimes(1);
      expect(ws.sent[0]).toMatchObject({
        type: 'ask_user_started',
        tool_call_id: 'toolu_h1',
        question: 'Which circuit were you referring to?',
        reason: 'ambiguous_circuit',
        context_field: 'circuit_designation',
        context_circuit: 3,
        expected_answer_shape: 'circuit_ref',
      });

      // Simulate 750ms of user think time before they answer.
      jest.advanceTimersByTime(750);
      pending.resolve('toolu_h1', { answered: true, user_text: 'Circuit 5' });

      const res = await p;

      expect(res.is_error).toBe(false);
      expect(JSON.parse(res.content)).toEqual({ answered: true, user_text: 'Circuit 5' });
      expect(pending.size).toBe(0);
      expect(logger.info).toHaveBeenCalledWith(
        'stage6.ask_user',
        expect.objectContaining({
          answer_outcome: 'answered',
          mode: 'live',
          user_text: 'Circuit 5',
          wait_duration_ms: 750,
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  test('ws.readyState not OPEN: does not call send, still registers + awaits + resolves', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    try {
      const session = makeSession('live');
      const logger = makeLogger();
      const pending = createPendingAsksRegistry();
      const ws = makeWs({ open: false });
      const dispatch = createAskDispatcher(session, logger, 'turn-1', pending, ws);

      const p = dispatch(makeCall('toolu_h2'), {
        sessionId: 'sess-1',
        turnId: 'turn-1',
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(ws.send).not.toHaveBeenCalled();
      expect(pending.size).toBe(1);

      pending.resolve('toolu_h2', { answered: true, user_text: 'ok' });
      const res = await p;
      expect(res.is_error).toBe(false);
      expect(JSON.parse(res.content).answered).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  test('ws=null: does not throw, registers + awaits normally', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    try {
      const session = makeSession('live');
      const logger = makeLogger();
      const pending = createPendingAsksRegistry();
      const dispatch = createAskDispatcher(session, logger, 'turn-1', pending, null);

      const p = dispatch(makeCall('toolu_h3'), {
        sessionId: 'sess-1',
        turnId: 'turn-1',
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(pending.size).toBe(1);
      pending.resolve('toolu_h3', { answered: true, user_text: 'yes' });

      const res = await p;
      expect(res.is_error).toBe(false);
      expect(JSON.parse(res.content)).toEqual({ answered: true, user_text: 'yes' });
    } finally {
      jest.useRealTimers();
    }
  });
});

// --- Group 4: Live timeout path -------------------------------------------

describe('createAskDispatcher — live timeout path (STA-03)', () => {
  test('advancing timers by 20001ms self-resolves via registry.resolve with reason=timeout', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    try {
      const session = makeSession('live');
      const logger = makeLogger();
      const pending = createPendingAsksRegistry();
      const dispatch = createAskDispatcher(session, logger, 'turn-1', pending, makeWs());

      const p = dispatch(makeCall('toolu_t1'), {
        sessionId: 'sess-1',
        turnId: 'turn-1',
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(pending.size).toBe(1);

      jest.advanceTimersByTime(20001);

      const res = await p;
      expect(res.is_error).toBe(false);
      expect(JSON.parse(res.content)).toEqual({ answered: false, reason: 'timeout' });
      expect(logger.info).toHaveBeenCalledWith(
        'stage6.ask_user',
        expect.objectContaining({
          answer_outcome: 'timeout',
          mode: 'live',
          wait_duration_ms: 20000,
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  test('after resolution, no pending timer handle remains (jest.getTimerCount drops to 0)', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    try {
      const session = makeSession('live');
      const logger = makeLogger();
      const pending = createPendingAsksRegistry();
      const dispatch = createAskDispatcher(session, logger, 'turn-1', pending, makeWs());

      const p = dispatch(makeCall('toolu_t2'), {
        sessionId: 'sess-1',
        turnId: 'turn-1',
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(jest.getTimerCount()).toBe(1); // the 20s timer

      pending.resolve('toolu_t2', { answered: true, user_text: 'done' });
      await p;

      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

// --- Group 5: Duplicate tool_call_id (Pitfall 7) --------------------------

describe('createAskDispatcher — duplicate tool_call_id guard', () => {
  test('pre-existing id → register() throws → is_error:true body duplicate_tool_call_id + log', async () => {
    const session = makeSession('live');
    const logger = makeLogger();
    const pending = createPendingAsksRegistry();

    // Pre-seed an entry under the same id so register() throws.
    const noopTimer = setTimeout(() => undefined, 1_000_000);
    pending.register('toolu_dup', {
      contextField: null,
      contextCircuit: null,
      resolve: () => {},
      timer: noopTimer,
      askStartedAt: Date.now(),
    });

    const dispatch = createAskDispatcher(session, logger, 'turn-1', pending, makeWs());
    const res = await dispatch(makeCall('toolu_dup'), {
      sessionId: 'sess-1',
      turnId: 'turn-1',
    });

    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content)).toEqual({
      answered: false,
      reason: 'duplicate_tool_call_id',
    });
    expect(logger.info).toHaveBeenCalledWith(
      'stage6.ask_user',
      expect.objectContaining({ answer_outcome: 'duplicate_tool_call_id' }),
    );

    // Cleanup pre-seeded entry.
    clearTimeout(noopTimer);
  });
});

// --- Group 6: askStartedAt captured pre-Promise ---------------------------

describe('createAskDispatcher — askStartedAt captured before Promise construction', () => {
  test('wait_duration_ms reflects wall-clock from registration (not from log emission)', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    try {
      const session = makeSession('live');
      const logger = makeLogger();
      const pending = createPendingAsksRegistry();
      const dispatch = createAskDispatcher(session, logger, 'turn-1', pending, makeWs());

      const p = dispatch(makeCall('toolu_w1'), {
        sessionId: 'sess-1',
        turnId: 'turn-1',
      });
      await Promise.resolve();
      await Promise.resolve();

      jest.advanceTimersByTime(500);
      pending.resolve('toolu_w1', { answered: true, user_text: 'x' });
      await p;

      const logCall = logger.info.mock.calls.find(
        (c) => c[0] === 'stage6.ask_user' && c[1].answer_outcome === 'answered',
      );
      expect(logCall).toBeDefined();
      expect(logCall[1].wait_duration_ms).toBe(500);
    } finally {
      jest.useRealTimers();
    }
  });
});

// --- Group 7: Exported constant -------------------------------------------

describe('createAskDispatcher — exports', () => {
  test('ASK_USER_TIMEOUT_MS is 20000 (STA-03)', () => {
    expect(ASK_USER_TIMEOUT_MS).toBe(20000);
  });
});
