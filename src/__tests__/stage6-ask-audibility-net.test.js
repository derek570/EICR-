/**
 * stage6-ask-audibility-net.test.js — F7 Item 2 (task #16) contract tests for
 * the ask-emission audit hook + the pre-emission audibility net's telemetry.
 *
 * Two blocks:
 *   A) DISPATCHER emission hook (direct `createAskDispatcher`): fires
 *      onAskUserStarted({source:'initial'}) ONLY on a successful send; a
 *      THROWING hook leaves dispatch behaviour unchanged; suppressed paths
 *      (validation / closed-ws / fast-fail) never fire it.
 *   B) HARNESS telemetry (real dispatcher + real runToolLoop via a mock
 *      Anthropic client + WS stub + fake timers): the two new rows
 *      `stage6.ask_user_started_emitted` + `stage6.ask_audibility_fallback_emitted`
 *      are one-per-event and carry generationId; `ios_send_attempt` carries
 *      generationId; and a turnId reused across two concurrent generations
 *      cannot cross-join because generationId disambiguates it.
 */

import { jest } from '@jest/globals';

import { createAskDispatcher } from '../extraction/stage6-dispatcher-ask.js';
import { createPendingAsksRegistry } from '../extraction/stage6-pending-asks-registry.js';
import { ExtractionCancelledError } from '../extraction/stage6-control-flow-errors.js';
import { runShadowHarness } from '../extraction/stage6-shadow-harness.js';
import { ASK_USER_TIMEOUT_MS } from '../extraction/stage6-dispatcher-ask.js';
import { QUESTION_GATE_DELAY_MS } from '../extraction/question-gate.js';
import { activeSessions } from '../extraction/active-sessions.js';
import { mockClient } from './helpers/mockStream.js';
import {
  makeLogger,
  makeLiveSession,
  makeOpenWs,
  makeClosedWs,
  toolUseRound,
  endTurnRound,
} from './helpers/f7-audibility-matrix.js';

const VALID_ASK = {
  question: 'Which circuit were you referring to?',
  reason: 'ambiguous_circuit',
  context_field: 'measured_zs_ohm',
  context_circuit: null,
  expected_answer_shape: 'circuit_ref',
};

function rowsOf(logger, event) {
  return logger.info.mock.calls.filter((c) => c[0] === event).map((c) => c[1]);
}

// ───────────────────────────────────────────────────────────────────────────
describe('F7 Item 2 A — dispatcher emission hook (onAskUserStarted)', () => {
  test('fires {source:"initial"} exactly once on a successful ask send', async () => {
    const logger = makeLogger();
    const pending = createPendingAsksRegistry();
    const ws = makeOpenWs();
    const fired = [];
    const dispatch = createAskDispatcher(
      { sessionId: 's', toolCallsMode: 'live' },
      logger,
      'turn-1',
      pending,
      ws,
      {
        onAskUserStarted: (e) => fired.push(e),
      }
    );
    const p = dispatch({ tool_call_id: 'toolu_1', name: 'ask_user', input: VALID_ASK }, {});
    await Promise.resolve();
    await Promise.resolve();
    expect(fired).toEqual([{ toolCallId: 'toolu_1', source: 'initial' }]);
    pending.resolve('toolu_1', { answered: true, user_text: 'circuit 3' });
    await p;
  });

  test('a THROWING onAskUserStarted leaves dispatch behaviour unchanged (still emits + resolves)', async () => {
    const logger = makeLogger();
    const pending = createPendingAsksRegistry();
    const ws = makeOpenWs();
    const dispatch = createAskDispatcher(
      { sessionId: 's', toolCallsMode: 'live' },
      logger,
      'turn-1',
      pending,
      ws,
      {
        onAskUserStarted: () => {
          throw new Error('observer blew up');
        },
      }
    );
    const p = dispatch({ tool_call_id: 'toolu_2', name: 'ask_user', input: VALID_ASK }, {});
    await Promise.resolve();
    await Promise.resolve();
    // The ask still emitted (frame on the wire) and still registers + awaits.
    expect(ws.sent.some((f) => f.type === 'ask_user_started')).toBe(true);
    expect(pending.size).toBe(1);
    pending.resolve('toolu_2', { answered: true, user_text: 'ok' });
    const res = await p;
    expect(res.is_error).toBe(false);
    expect(JSON.parse(res.content).answered).toBe(true);
  });

  test('a SUPPRESSED path (validation_error) never fires the hook', async () => {
    const logger = makeLogger();
    const pending = createPendingAsksRegistry();
    const ws = makeOpenWs();
    const fired = [];
    const dispatch = createAskDispatcher(
      { sessionId: 's', toolCallsMode: 'live' },
      logger,
      'turn-1',
      pending,
      ws,
      {
        onAskUserStarted: (e) => fired.push(e),
      }
    );
    // Invalid reason → validation_error before any send.
    const res = await dispatch(
      {
        tool_call_id: 'toolu_3',
        name: 'ask_user',
        input: { ...VALID_ASK, reason: 'not_a_reason' },
      },
      {}
    );
    expect(res.is_error).toBe(true);
    expect(fired).toEqual([]);
    expect(ws.sent).toEqual([]);
  });

  test('F7 Item 3 — a cancellation that lands while the ask is resolving THROWS the fatal error and does NOT auto-resolve a write', async () => {
    const logger = makeLogger();
    const pending = createPendingAsksRegistry();
    const ws = makeOpenWs();
    const ac = new AbortController();
    const autoResolveWrite = jest.fn().mockResolvedValue({ ok: true });
    const dispatch = createAskDispatcher(
      { sessionId: 's', toolCallsMode: 'live', stateSnapshot: { circuits: {} } },
      logger,
      'turn-1',
      pending,
      ws,
      { autoResolveWrite, signal: ac.signal }
    );
    const p = dispatch(
      {
        tool_call_id: 'toolu_c',
        name: 'ask_user',
        input: {
          question: 'Which circuit was that reading for?',
          reason: 'missing_field',
          context_field: 'none',
          context_circuit: null,
          expected_answer_shape: 'free_text',
        },
      },
      {}
    );
    await Promise.resolve();
    await Promise.resolve();
    // The watchdog aborts, THEN the inspector's answer arrives.
    ac.abort(new ExtractionCancelledError('ceiling'));
    pending.resolve('toolu_c', { answered: true, user_text: 'measured Zs' });
    await expect(p).rejects.toBeInstanceOf(ExtractionCancelledError);
    // No write was auto-resolved on the cancelled generation.
    expect(autoResolveWrite).not.toHaveBeenCalled();
  });

  test('a CLOSED-ws fast-fail never fires the hook', async () => {
    const logger = makeLogger();
    const pending = createPendingAsksRegistry();
    const ws = makeClosedWs();
    const fired = [];
    const dispatch = createAskDispatcher(
      { sessionId: 's', toolCallsMode: 'live' },
      logger,
      'turn-1',
      pending,
      ws,
      {
        onAskUserStarted: (e) => fired.push(e),
      }
    );
    const res = await dispatch({ tool_call_id: 'toolu_4', name: 'ask_user', input: VALID_ASK }, {});
    expect(JSON.parse(res.content).reason).toBe('dispatcher_error');
    expect(fired).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('F7 Item 2 B — harness telemetry + generationId', () => {
  const SESSION_ID = 'sess-f7-telemetry';
  const MAX_ADVANCE_MS = QUESTION_GATE_DELAY_MS + ASK_USER_TIMEOUT_MS + 2000;

  function registerEntry(id = SESSION_ID) {
    activeSessions.set(id, {
      session: { sessionId: id },
      pendingFastTtsSlots: new Map(),
      fastPathCorrelationIdByTurn: new Map(),
      broadcastIntentByTurn: new Map(),
      voiceLatency: { flags: { loadedBarrel: false } },
    });
  }

  async function drive(session, transcript, opts, { answers = {} } = {}) {
    const pendingAsks = opts.pendingAsks;
    const answerMap = new Map(Object.entries(answers));
    let settled = false;
    let value;
    const p = runShadowHarness(session, transcript, [], opts).then((v) => {
      settled = true;
      value = v;
    });
    await jest.advanceTimersByTimeAsync(0);
    let elapsed = 0;
    while (!settled && elapsed <= MAX_ADVANCE_MS) {
      for (const [id, payload] of [...answerMap]) {
        if (pendingAsks && pendingAsks.resolve(id, payload)) answerMap.delete(id);
      }

      await jest.advanceTimersByTimeAsync(250);
      elapsed += 250;
    }
    await jest.advanceTimersByTimeAsync(0);
    await p;
    return value;
  }

  beforeEach(() => {
    jest.useFakeTimers();
    registerEntry();
  });
  afterEach(() => {
    activeSessions.delete(SESSION_ID);
    jest.useRealTimers();
  });

  test('a successfully-emitted ask logs exactly one ask_user_started_emitted row (source:initial, generationId)', async () => {
    const session = makeLiveSession({
      sessionId: SESSION_ID,
      client: mockClient([
        toolUseRound([{ id: 'toolu_e1', name: 'ask_user', input: VALID_ASK }]),
        endTurnRound('ok'),
      ]),
    });
    const opts = {
      logger: makeLogger(),
      pendingAsks: createPendingAsksRegistry(),
      ws: makeOpenWs(),
      confirmationsEnabled: true,
      generationId: 'gen-A',
    };
    await drive(session, 'which circuit', opts, {
      answers: { toolu_e1: { answered: true, user_text: 'circuit 3' } },
    });
    const emitRows = rowsOf(opts.logger, 'stage6.ask_user_started_emitted');
    expect(emitRows).toHaveLength(1);
    expect(emitRows[0]).toMatchObject({
      tool_call_id: 'toolu_e1',
      source: 'initial',
      generationId: 'gen-A',
    });
    // No fallback on an emitted-and-answered turn.
    expect(rowsOf(opts.logger, 'stage6.ask_audibility_fallback_emitted')).toHaveLength(0);
  });

  test('a suppressed-ask turn logs exactly one ask_audibility_fallback_emitted row (generationId, attempted ids)', async () => {
    const session = makeLiveSession({
      sessionId: SESSION_ID,
      client: mockClient([
        toolUseRound([{ id: 'toolu_e2', name: 'ask_user', input: VALID_ASK }]),
        endTurnRound('ok'),
      ]),
    });
    const opts = {
      logger: makeLogger(),
      pendingAsks: createPendingAsksRegistry(),
      ws: makeClosedWs(), // suppressed — never emits
      confirmationsEnabled: true,
      generationId: 'gen-B',
    };
    await drive(session, 'which circuit', opts);
    const fbRows = rowsOf(opts.logger, 'stage6.ask_audibility_fallback_emitted');
    expect(fbRows).toHaveLength(1);
    expect(fbRows[0]).toMatchObject({ generationId: 'gen-B', emitted_ask_count: 0 });
    expect(fbRows[0].attempted_ask_tool_call_ids).toContain('toolu_e2');
    // No positive emission row on a suppressed turn.
    expect(rowsOf(opts.logger, 'stage6.ask_user_started_emitted')).toHaveLength(0);
    // The ios_send_attempt row for the fallback carries generationId too.
    const sendRows = rowsOf(opts.logger, 'ios_send_attempt');
    expect(sendRows.length).toBeGreaterThanOrEqual(1);
    expect(sendRows.every((r) => r.generationId === 'gen-B')).toBe(true);
  });

  test('cross-join regression: same turnId across two generations cannot cross-join (generationId disambiguates)', async () => {
    // Two direct concurrent runShadowHarness invocations against ONE session
    // both compute the same session.turnCount + 1 (turnId reuse the 30s
    // force-clear permits today). Distinct generationIds keep their telemetry
    // separable.
    const mkSession = () =>
      makeLiveSession({
        sessionId: SESSION_ID,
        turnCount: 0,
        client: mockClient([
          toolUseRound([{ id: 'toolu_x', name: 'ask_user', input: VALID_ASK }]),
          endTurnRound('ok'),
        ]),
      });
    const optsA = {
      logger: makeLogger(),
      pendingAsks: createPendingAsksRegistry(),
      ws: makeClosedWs(),
      confirmationsEnabled: true,
      generationId: 'gen-1',
    };
    const optsB = {
      logger: makeLogger(),
      pendingAsks: createPendingAsksRegistry(),
      ws: makeClosedWs(),
      confirmationsEnabled: true,
      generationId: 'gen-2',
    };
    await drive(mkSession(), 'first', optsA);
    await drive(mkSession(), 'second', optsB);
    const aFb = rowsOf(optsA.logger, 'stage6.ask_audibility_fallback_emitted');
    const bFb = rowsOf(optsB.logger, 'stage6.ask_audibility_fallback_emitted');
    expect(aFb).toHaveLength(1);
    expect(bFb).toHaveLength(1);
    // Same turnId (turn-1), but the generationId disambiguates the join.
    expect(aFb[0].turnId).toBe(bFb[0].turnId);
    expect(aFb[0].generationId).toBe('gen-1');
    expect(bFb[0].generationId).toBe('gen-2');
    expect(aFb[0].generationId).not.toBe(bFb[0].generationId);
  });
});
