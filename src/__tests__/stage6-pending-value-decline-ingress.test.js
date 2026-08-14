/**
 * Group 3 (feedback id 114, 2026-08-12) — production-ingress tests for the
 * pending-value DECLINE branch: the REAL ask dispatcher runs inside the REAL
 * harness (runToolLoop is mocked only as the driver that invokes the
 * composed dispatcher), so the full path is exercised end-to-end:
 *
 *   ask registered → answered "Don't worry." → chain resolves
 *   match_status:'user_declined' SILENTLY → the P4 answered-ask net (fed by
 *   the dispatcher's own onAskAnswered fire) speaks EXACTLY ONE
 *   decline-family ack, drained into result.confirmations.
 *
 * The harness drains current-generation pendingVoicePrompts into
 * result.confirmations in the same run — a completed ingress result has the
 * drained confirmation and ZERO current-generation entries left in
 * session.pendingVoicePrompts. (The pre-drain transient-queue assertions
 * live in stage6-dispatcher-ask-pending-value.test.js.)
 *
 * Mock pattern mirrors stage6-ask-decline-ack-net.test.js, EXCEPT
 * stage6-dispatcher-ask is NOT mocked — the P4 ledger is fed by the real
 * dispatcher observers, not by the _seedAskLifecycle seam.
 */

import { jest } from '@jest/globals';

const SESSION_ID = 'sess-pv-decline-ingress';

const runToolLoopSpy = jest.fn(async () => ({
  stop_reason: 'end_turn',
  rounds: 1,
  tool_calls: [],
  aborted: false,
  messages_final: [],
  usage: {},
  terminal_reason: 'end_turn',
}));

const createSpeculatorSpy = jest.fn(() => ({
  onSnapshotPatch: jest.fn(),
  onLoopComplete: jest.fn(),
  onToolUseStreamed: jest.fn(),
  validateAgainstConfirmations: jest.fn(),
  abortBySlot: jest.fn(),
  shutdown: jest.fn(),
}));

jest.unstable_mockModule('../extraction/stage6-tool-loop.js', () => ({
  runToolLoop: runToolLoopSpy,
  LOOP_CAP: 8,
  NOOP_DISPATCHER: async () => ({}),
}));

jest.unstable_mockModule('../extraction/loaded-barrel-speculator.js', () => ({
  createSpeculator: createSpeculatorSpy,
}));

const { runShadowHarness, ASK_DECLINE_ACK_PROMPTS, ASK_ANSWERED_ACK_PROMPTS } =
  await import('../extraction/stage6-shadow-harness.js');
const { activeSessions } = await import('../extraction/active-sessions.js');
const { createPendingAsksRegistry } = await import('../extraction/stage6-pending-asks-registry.js');

const DECLINE_SET = new Set(ASK_DECLINE_ACK_PROMPTS);
const ANSWERED_SET = new Set(ASK_ANSWERED_ACK_PROMPTS);

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeSession() {
  return {
    sessionId: SESSION_ID,
    systemPrompt: 'sys',
    toolCallsMode: 'live',
    turnCount: 0,
    costTracker: {
      addSonnetUsage: jest.fn(),
      recordElevenLabsSpeculativeStarted: jest.fn(() => true),
      recordElevenLabsSpeculativeTerminal: jest.fn(),
    },
    stateSnapshot: {
      circuits: { 2: { circuit_designation: 'Upstairs sockets' } },
      pending_readings: [],
      observations: [],
      validation_alerts: [],
    },
    extractedObservations: [],
    activeTurnTranscript: null,
    _snapshot: null,
    buildSystemBlocks() {
      return [
        { type: 'text', text: this.systemPrompt, cache_control: { type: 'ephemeral', ttl: '5m' } },
      ];
    },
    buildAgenticSystemBlocks() {
      return this.buildSystemBlocks();
    },
  };
}

function makeWs() {
  const sent = [];
  return {
    readyState: 1,
    OPEN: 1,
    sent,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };
}

async function tick(n = 3) {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
}

const noneAsk = (overrides = {}) => ({
  question: 'I heard 26 milliseconds — which reading was that for?',
  reason: 'missing_field',
  context_field: 'none',
  context_circuit: 2,
  expected_answer_shape: 'free_text',
  ...overrides,
});

/** Every field-null ack from either P4 family found in result.confirmations. */
function ackEntries(result) {
  return (result.confirmations ?? []).filter(
    (c) => c.field == null && (DECLINE_SET.has(c.text) || ANSWERED_SET.has(c.text))
  );
}

function toolCallRecord(toolCallId, env) {
  return {
    tool_call_id: toolCallId,
    name: 'ask_user',
    input: { question: 'q', reason: 'missing_field' },
    result: env,
  };
}

function loopOut(records) {
  return {
    stop_reason: 'end_turn',
    rounds: records.length + 1,
    tool_calls: records,
    aborted: false,
    messages_final: [],
    usage: {},
    terminal_reason: 'end_turn',
  };
}

/**
 * Shared expectations for every decline-ingress result: exactly ONE
 * decline-family confirmation, no apology, no leftover current-generation
 * queue entries, no write.
 */
function expectExactlyOneDeclineAck(result, session, ws) {
  const acks = ackEntries(result);
  expect(acks).toHaveLength(1);
  expect(DECLINE_SET.has(acks[0].text)).toBe(true);
  // No apology family fired (the pre-fix terminal was the apology).
  for (const c of result.confirmations ?? []) {
    expect(String(c.text ?? '')).not.toMatch(/couldn't place/i);
  }
  // Drained: zero current-generation entries left on the transient queue.
  expect(session.pendingVoicePrompts ?? []).toHaveLength(0);
  // No write reached the wire.
  expect(ws.sent.filter((f) => f.type === 'extraction')).toHaveLength(0);
}

beforeEach(() => {
  runToolLoopSpy.mockClear();
  createSpeculatorSpy.mockClear();
  activeSessions.set(SESSION_ID, {
    session: { sessionId: SESSION_ID },
    pendingFastTtsSlots: new Map(),
    fastPathCorrelationIdByTurn: new Map(),
    broadcastIntentByTurn: new Map(),
    voiceLatency: { flags: { loadedBarrel: true } },
  });
});

afterEach(() => {
  activeSessions.delete(SESSION_ID);
});

describe('id 114 ingress — decline at the INITIAL pending-value ask', () => {
  test('"Don\'t worry." → ONE decline-family confirmation, no apology, no broker, no write, no re-ask possible', async () => {
    const pendingAsks = createPendingAsksRegistry();
    const ws = makeWs();
    runToolLoopSpy.mockImplementation(async (o) => {
      const p = o.dispatcher(
        { tool_call_id: 'toolu_i1', name: 'ask_user', input: noneAsk() },
        o.ctx
      );
      await tick();
      pendingAsks.resolve('toolu_i1', { answered: true, user_text: "Don't worry." });
      const env = await p;
      expect(JSON.parse(env.content).match_status).toBe('user_declined');
      return loopOut([toolCallRecord('toolu_i1', env)]);
    });
    const session = makeSession();
    const opts = {
      logger: makeLogger(),
      pendingAsks,
      ws,
      confirmationsEnabled: true,
      generationId: 'gen-i1',
    };
    const result = await runShadowHarness(
      session,
      'RCD trip time upstairs is 26 milliseconds',
      [],
      opts
    );
    expectExactlyOneDeclineAck(result, session, ws);
    // Only the ONE initial ask was ever emitted — no pvr broker followed.
    expect(ws.sent.filter((f) => f.type === 'ask_user_started')).toHaveLength(1);
  });

  test('PLAN-G (2026-08-14, id 114): confirmationsEnabled:false → the decline ack STILL fires end-to-end through the REAL dispatcher (fingerprint/no-reask unchanged)', async () => {
    const pendingAsks = createPendingAsksRegistry();
    const ws = makeWs();
    runToolLoopSpy.mockImplementation(async (o) => {
      const p = o.dispatcher(
        { tool_call_id: 'toolu_g1', name: 'ask_user', input: noneAsk() },
        o.ctx
      );
      await tick();
      pendingAsks.resolve('toolu_g1', { answered: true, user_text: "Don't worry." });
      const env = await p;
      expect(JSON.parse(env.content).match_status).toBe('user_declined');
      return loopOut([toolCallRecord('toolu_g1', env)]);
    });
    const session = makeSession();
    const opts = {
      logger: makeLogger(),
      pendingAsks,
      ws,
      confirmationsEnabled: false,
      generationId: 'gen-g1',
    };
    const result = await runShadowHarness(
      session,
      'RCD trip time upstairs is 26 milliseconds',
      [],
      opts
    );
    // Same real-dispatcher path as the toggle-ON case above: exactly ONE
    // decline ack, drained, no apology, no write — the toggle bypass alone
    // changed, nothing else about the fingerprint/no-reask contract.
    expectExactlyOneDeclineAck(result, session, ws);
    expect(ws.sent.filter((f) => f.type === 'ask_user_started')).toHaveLength(1);
  });

  test('decline + SAME-generation model retry → the retry is suppressed and the FULL sequence still yields exactly ONE decline ack', async () => {
    const pendingAsks = createPendingAsksRegistry();
    const ws = makeWs();
    runToolLoopSpy.mockImplementation(async (o) => {
      const p = o.dispatcher(
        { tool_call_id: 'toolu_r1', name: 'ask_user', input: noneAsk() },
        o.ctx
      );
      await tick();
      pendingAsks.resolve('toolu_r1', { answered: true, user_text: "Don't worry." });
      const env1 = await p;
      // The model retries the same pending operation in the SAME generation.
      const env2 = await o.dispatcher(
        { tool_call_id: 'toolu_r2', name: 'ask_user', input: noneAsk() },
        o.ctx
      );
      const body2 = JSON.parse(env2.content);
      expect(body2).toMatchObject({
        answered: false,
        reason: 'user_declined',
        match_status: 'user_declined',
      });
      return loopOut([toolCallRecord('toolu_r1', env1), toolCallRecord('toolu_r2', env2)]);
    });
    const session = makeSession();
    const opts = {
      logger: makeLogger(),
      pendingAsks,
      ws,
      confirmationsEnabled: true,
      generationId: 'gen-r',
    };
    const result = await runShadowHarness(
      session,
      'RCD trip time upstairs is 26 milliseconds',
      [],
      opts
    );
    // Across the FULL retry sequence: ONE decline-family entry, not two.
    expectExactlyOneDeclineAck(result, session, ws);
    // The suppressed retry never emitted an ask frame.
    expect(ws.sent.filter((f) => f.type === 'ask_user_started')).toHaveLength(1);
  });
});

describe('id 114 ingress — decline at each brokered outcome', () => {
  async function resolveNextPvr(ws, pendingAsks, replyText, alreadySeen) {
    await tick();
    const pvrs = ws.sent.filter(
      (f) => f.type === 'ask_user_started' && String(f.tool_call_id).startsWith('pvr-')
    );
    const fresh = pvrs.filter((f) => !alreadySeen.has(f.tool_call_id));
    expect(fresh).toHaveLength(1);
    alreadySeen.add(fresh[0].tool_call_id);
    pendingAsks.resolve(fresh[0].tool_call_id, { answered: true, user_text: replyText });
  }

  const scenarios = [
    {
      name: 'FIELD ask (shape 1)',
      transcript: 'blah blah 26 milliseconds',
      ask: noneAsk(),
      initialReply: 'erm the auto feature thing', // resolves no field → field broker
    },
    {
      name: 'VALUE ask (shape 2)',
      transcript: 'no numbers here at all',
      ask: noneAsk({ question: 'Which reading was that for?' }),
      initialReply: 'RCD trip time.', // field resolves, no value → value broker
    },
    {
      name: 'CIRCUIT ask (shape 3)',
      transcript: 'trip time 26 milliseconds somewhere',
      ask: noneAsk({ context_circuit: null }),
      initialReply: 'RCD trip time', // field+value, no circuit → circuit broker
    },
  ];

  test.each(scenarios)(
    'decline at the brokered $name → exactly ONE decline-family confirmation, no apology, no write',
    async ({ transcript, ask, initialReply }) => {
      const pendingAsks = createPendingAsksRegistry();
      const ws = makeWs();
      runToolLoopSpy.mockImplementation(async (o) => {
        const seen = new Set();
        const p = o.dispatcher({ tool_call_id: 'toolu_b1', name: 'ask_user', input: ask }, o.ctx);
        await tick();
        pendingAsks.resolve('toolu_b1', { answered: true, user_text: initialReply });
        await resolveNextPvr(ws, pendingAsks, "Don't worry.", seen);
        const env = await p;
        expect(JSON.parse(env.content).match_status).toBe('user_declined');
        return loopOut([toolCallRecord('toolu_b1', env)]);
      });
      const session = makeSession();
      const opts = {
        logger: makeLogger(),
        pendingAsks,
        ws,
        confirmationsEnabled: true,
        generationId: 'gen-b',
      };
      const result = await runShadowHarness(session, transcript, [], opts);
      expectExactlyOneDeclineAck(result, session, ws);
      // Exactly TWO ask frames: the initial + the ONE broker; nothing after
      // the decline.
      expect(ws.sent.filter((f) => f.type === 'ask_user_started')).toHaveLength(2);
    }
  );
});
