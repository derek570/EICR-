/**
 * Fix A 2026-06-02 (handoff-2026-06-02-fixes.md §A) — verify runLiveMode
 * writes `entry.broadcastIntentByTurn.set(turnId, true)` for broadcast
 * transcripts BEFORE runToolLoop is invoked, and clears the map entry in
 * the finally block.
 *
 * This is the wiring counterpart of loaded-barrel-speculator-broadcast-intent.test.js
 * (which exercises the speculator's read of the map). The speculator test
 * pins the consumer; this file pins the producer.
 *
 * The map MUST be populated before runToolLoop runs because Sonnet can
 * emit a streamed tool_use within tens of ms of the request — the
 * speculator's onToolUseStreamed hook is the first thing that reads the
 * flag, and if the write hasn't happened yet, the per-circuit synth ships
 * before the broadcast skip has any chance to fire.
 *
 * Mock pattern mirrors stage6-shadow-harness-toolcallsmode-threading.test.js
 * (the most recent shadow-harness test that exercises live mode via mocked
 * runToolLoop).
 */

import { jest } from '@jest/globals';

import { mockClient } from './helpers/mockStream.js';

// ---------------------------------------------------------------------------
// ESM factory spies — must be registered BEFORE importing runShadowHarness.
// runToolLoopSpy captures the broadcastIntentByTurn map state observed
// at invocation time (the moment matters: the write must happen BEFORE
// runToolLoop is called, not after).
// ---------------------------------------------------------------------------

const askSentinel = Object.assign(
  async () => ({ tool_use_id: 'a', content: '{}', is_error: false }),
  { __tag: 'asks' }
);
const createAskDispatcherSpy = jest.fn(() => askSentinel);

// observedDuringRunToolLoop captures the entry state at the moment
// runToolLoop is invoked — verifies the write happened BEFORE the loop
// ran, not afterwards.
let observedDuringRunToolLoop = null;
const runToolLoopSpy = jest.fn(async () => {
  const { activeSessions } = await import('../extraction/active-sessions.js');
  const entry = activeSessions.get(SESSION_ID);
  observedDuringRunToolLoop = entry?.broadcastIntentByTurn
    ? new Map(entry.broadcastIntentByTurn)
    : null;
  return {
    stop_reason: 'end_turn',
    rounds: 1,
    tool_calls: [],
    aborted: false,
    messages_final: [],
  };
});

jest.unstable_mockModule('../extraction/stage6-dispatcher-ask.js', () => ({
  createAskDispatcher: createAskDispatcherSpy,
  ASK_USER_TIMEOUT_MS: 20000,
}));

jest.unstable_mockModule('../extraction/stage6-tool-loop.js', () => ({
  runToolLoop: runToolLoopSpy,
  LOOP_CAP: 8,
  NOOP_DISPATCHER: async () => ({}),
}));

const { runShadowHarness } = await import('../extraction/stage6-shadow-harness.js');
const { activeSessions } = await import('../extraction/active-sessions.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_ID = 'sess-bcast-wire';

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function endTurnStreamEvents(text = 'done') {
  return [
    { type: 'message_start', message: { id: 'msg_end', role: 'assistant', content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ];
}

function makeSession() {
  return {
    sessionId: SESSION_ID,
    turnCount: 0,
    toolCallsMode: 'live',
    systemPrompt: 'TEST SYSTEM PROMPT',
    client: mockClient([endTurnStreamEvents('ok')]),
    stateSnapshot: { circuits: {}, pending_readings: [], observations: [], validation_alerts: [] },
    extractedObservations: [],
    activeTurnTranscript: null,
    _snapshot: null,
    buildSystemBlocks() {
      return [
        {
          type: 'text',
          text: this.systemPrompt,
          cache_control: { type: 'ephemeral', ttl: '5m' },
        },
      ];
    },
    extractFromUtterance: jest.fn().mockImplementation(async function () {
      this.turnCount = (this.turnCount ?? 0) + 1;
      return { extracted_readings: [], observations: [], questions: [] };
    }),
  };
}

function makePendingAsks() {
  return { __tag: 'pending-asks-registry', size: 0, entries: () => [] };
}

function makeWs() {
  return { readyState: 1, OPEN: 1, send: jest.fn() };
}

beforeEach(() => {
  createAskDispatcherSpy.mockClear();
  runToolLoopSpy.mockClear();
  observedDuringRunToolLoop = null;
  // Match the activeSessions shape sonnet-stream.js builds on session_start.
  activeSessions.set(SESSION_ID, {
    session: { sessionId: SESSION_ID },
    pendingFastTtsSlots: new Map(),
    fastPathCorrelationIdByTurn: new Map(),
    broadcastIntentByTurn: new Map(),
  });
});

afterEach(() => {
  activeSessions.delete(SESSION_ID);
});

// ---------------------------------------------------------------------------
// Wiring assertions — write happens BEFORE runToolLoop, cleanup in finally
// ---------------------------------------------------------------------------

describe('Fix A: runLiveMode wires broadcastIntentByTurn before runToolLoop', () => {
  test('broadcast list transcript ("circuits 2 and 3 …") → flag set during runToolLoop', async () => {
    const logger = makeLogger();
    const session = makeSession();
    const pendingAsks = makePendingAsks();
    const ws = makeWs();

    await runShadowHarness(
      session,
      'Live to earth insulation resistance on circuits 2 and 3 is greater than 299 megohms.',
      [],
      { logger, pendingAsks, ws }
    );

    // The mocked runToolLoop captured the entry state at invocation time.
    expect(runToolLoopSpy).toHaveBeenCalledTimes(1);
    expect(observedDuringRunToolLoop).not.toBeNull();
    expect(observedDuringRunToolLoop.size).toBe(1);
    // turnId shape: `${sessionId}-turn-${turnNum}` (stage6-shadow-harness.js:215).
    const observedTurnIds = [...observedDuringRunToolLoop.keys()];
    expect(observedTurnIds).toEqual([`${SESSION_ID}-turn-1`]);
    expect(observedDuringRunToolLoop.get(observedTurnIds[0])).toBe(true);
  });

  test('broadcast all transcript ("for all circuits") → flag set during runToolLoop', async () => {
    const logger = makeLogger();
    const session = makeSession();
    const pendingAsks = makePendingAsks();
    const ws = makeWs();

    await runShadowHarness(
      session,
      'Test voltage for all circuits is two hundred and fifty volts.',
      [],
      { logger, pendingAsks, ws }
    );

    expect(observedDuringRunToolLoop?.size).toBe(1);
    expect(observedDuringRunToolLoop.get(`${SESSION_ID}-turn-1`)).toBe(true);
  });

  test('broadcast range transcript ("circuits 1 through 4") → flag set during runToolLoop', async () => {
    const logger = makeLogger();
    const session = makeSession();
    const pendingAsks = makePendingAsks();
    const ws = makeWs();

    await runShadowHarness(
      session,
      'Insulation resistance L to L for circuits 1 through 4 is greater than 200 megohms.',
      [],
      { logger, pendingAsks, ws }
    );

    expect(observedDuringRunToolLoop?.size).toBe(1);
    expect(observedDuringRunToolLoop.get(`${SESSION_ID}-turn-1`)).toBe(true);
  });

  test('non-broadcast transcript (single circuit) → flag NOT set', async () => {
    const logger = makeLogger();
    const session = makeSession();
    const pendingAsks = makePendingAsks();
    const ws = makeWs();

    await runShadowHarness(session, 'Zs for circuit 3 is 0.42 ohms.', [], {
      logger,
      pendingAsks,
      ws,
    });

    // detectBroadcastIntent's regexes are noun-anchored on multi-circuit
    // shapes; a bare "for circuit 3" does NOT match BROADCAST_ALL/RANGE/LIST.
    // Map stays empty.
    expect(observedDuringRunToolLoop?.size ?? 0).toBe(0);
  });

  test('finally cleanup: flag is removed after runShadowHarness returns', async () => {
    const logger = makeLogger();
    const session = makeSession();
    const pendingAsks = makePendingAsks();
    const ws = makeWs();

    await runShadowHarness(
      session,
      'Live to earth insulation resistance on circuits 2 and 3 is greater than 299 megohms.',
      [],
      { logger, pendingAsks, ws }
    );

    // Post-return: the per-turn entry is gone. The next turn must start
    // from a clean state — otherwise a non-broadcast turn following a
    // broadcast one would inherit the flag and silently skip the synth.
    const entry = activeSessions.get(SESSION_ID);
    expect(entry.broadcastIntentByTurn.size).toBe(0);
  });

  test('finally cleanup also fires when runToolLoop throws (error path)', async () => {
    const logger = makeLogger();
    const session = makeSession();
    const pendingAsks = makePendingAsks();
    const ws = makeWs();

    runToolLoopSpy.mockImplementationOnce(async () => {
      const { activeSessions: as } = await import('../extraction/active-sessions.js');
      const entry = as.get(SESSION_ID);
      observedDuringRunToolLoop = entry?.broadcastIntentByTurn
        ? new Map(entry.broadcastIntentByTurn)
        : null;
      throw new Error('simulated runToolLoop failure');
    });

    // runShadowHarness's runLiveMode does NOT re-throw runToolLoop's error
    // back to the caller — it logs and returns a fallback shape. The
    // finally block must still clear the flag.
    await runShadowHarness(
      session,
      'Live to earth insulation resistance on circuits 2 and 3 is greater than 299 megohms.',
      [],
      { logger, pendingAsks, ws }
    ).catch(() => {
      /* swallow — finally cleanup is what we're asserting */
    });

    // The flag was set during the failed runToolLoop call:
    expect(observedDuringRunToolLoop?.get(`${SESSION_ID}-turn-1`)).toBe(true);
    // …and the finally block cleared it on the way out.
    const entry = activeSessions.get(SESSION_ID);
    expect(entry.broadcastIntentByTurn.size).toBe(0);
  });
});
