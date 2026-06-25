/**
 * item #10 / #4 / #6 — deterministic post-turn orphan net (session DFCE2145).
 *
 * When a forwarded, digit-bearing utterance produces ZERO tool calls and ZERO
 * output, runLiveMode must emit exactly ONE non-blocking clarifying prompt via
 * result.confirmations (NOT an ask_user) and stash the unplaced transcript on
 * session.orphanContext so the NEXT turn re-extracts the repeat WITH it as
 * context. It must NOT fire on: a bare field-only fragment (no digit), a turn
 * that produced any tool call, or an answer turn.
 *
 * Mock pattern mirrors stage6-shadow-harness-b1a-suppress.test.js.
 */

import { jest } from '@jest/globals';

const SESSION_ID = 'sess-orphan-net';

const askSentinel = Object.assign(
  async () => ({ tool_use_id: 'a', content: '{}', is_error: false }),
  { __tag: 'asks' }
);
const createAskDispatcherSpy = jest.fn(() => askSentinel);

// Default mock: a no-op turn (zero tool calls) — the orphan trigger shape.
const runToolLoopSpy = jest.fn(async () => ({
  stop_reason: 'end_turn',
  rounds: 1,
  tool_calls: [],
  aborted: false,
  messages_final: [],
  usage: {},
  terminal_reason: 'end_turn',
}));

const validateSpy = jest.fn();
const createSpeculatorSpy = jest.fn(() => ({
  onSnapshotPatch: jest.fn(),
  onLoopComplete: jest.fn(),
  onToolUseStreamed: jest.fn(),
  validateAgainstConfirmations: validateSpy,
  abortBySlot: jest.fn(),
  shutdown: jest.fn(),
}));

jest.unstable_mockModule('../extraction/stage6-dispatcher-ask.js', () => ({
  createAskDispatcher: createAskDispatcherSpy,
  ASK_USER_TIMEOUT_MS: 20000,
}));

jest.unstable_mockModule('../extraction/stage6-tool-loop.js', () => ({
  runToolLoop: runToolLoopSpy,
  LOOP_CAP: 8,
  NOOP_DISPATCHER: async () => ({}),
}));

jest.unstable_mockModule('../extraction/loaded-barrel-speculator.js', () => ({
  createSpeculator: createSpeculatorSpy,
}));

const { runShadowHarness } = await import('../extraction/stage6-shadow-harness.js');
const { activeSessions } = await import('../extraction/active-sessions.js');

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
    stateSnapshot: { circuits: {}, pending_readings: [], observations: [], validation_alerts: [] },
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

function makePendingAsks(size = 0) {
  return { __tag: 'pending-asks-registry', size, entries: () => [] };
}

function makeWs() {
  return { readyState: 1, OPEN: 1, send: jest.fn() };
}

function baseOpts(overrides = {}) {
  return {
    logger: makeLogger(),
    pendingAsks: makePendingAsks(),
    ws: makeWs(),
    confirmationsEnabled: true,
    ...overrides,
  };
}

beforeEach(() => {
  createAskDispatcherSpy.mockClear();
  runToolLoopSpy.mockClear();
  createSpeculatorSpy.mockClear();
  validateSpy.mockClear();
  runToolLoopSpy.mockImplementation(async () => ({
    stop_reason: 'end_turn',
    rounds: 1,
    tool_calls: [],
    aborted: false,
    messages_final: [],
    usage: {},
    terminal_reason: 'end_turn',
  }));
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

describe('orphan net — fires on a forwarded, digit-bearing zero-output turn', () => {
  test('"EFC is 0.86." → one non-blocking clarifying confirmation + orphanContext stashed', async () => {
    const session = makeSession();
    const result = await runShadowHarness(session, 'EFC is 0.86.', [], baseOpts());

    expect(Array.isArray(result.confirmations)).toBe(true);
    const prompt = result.confirmations.find(
      (c) => c.field == null && /(catch|repeat|say it)/i.test(c.text)
    );
    expect(prompt).toBeDefined();
    // Non-blocking: a confirmation, NOT an ask_user (field/circuit null, kept
    // out of the finalizer ack accounting).
    expect(prompt.circuit).toBeNull();
    expect(prompt.expects_ios_ack).toBe(false);
    // Context-carry armed for the next turn.
    expect(session.orphanContext).toMatchObject({ transcript: 'EFC is 0.86.', turnNum: 1 });
  });

  test('the repeat next turn is re-extracted WITH the orphan transcript as context', async () => {
    const session = makeSession();
    await runShadowHarness(session, 'EFC is 0.86.', [], baseOpts());
    expect(session.orphanContext).not.toBeNull();

    runToolLoopSpy.mockClear();
    // Inspector repeats; this turn the orphan note must be injected before the
    // current transcript so the model resolves placement from both.
    await runShadowHarness(session, 'PFC is 0.86.', [], baseOpts());

    const messages = runToolLoopSpy.mock.calls[0][0].messages;
    const noteMsg = messages.find(
      (m) => m.role === 'user' && /previous words "EFC is 0\.86\."/.test(m.content)
    );
    expect(noteMsg).toBeDefined();
    // The current transcript is still the LAST message.
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: 'PFC is 0.86.' });
    // Turn-1's context was consumed (not carried again); because this mocked
    // turn ALSO extracts nothing, the net re-arms with turn-2's transcript —
    // proving the prior context was cleared, not duplicated.
    expect(session.orphanContext).toMatchObject({ transcript: 'PFC is 0.86.', turnNum: 2 });
  });
});

describe('orphan net — does NOT fire', () => {
  test('bare field-only fragment "Zs" (no digit) → WAIT, no prompt', async () => {
    const session = makeSession();
    const result = await runShadowHarness(session, 'Zs', [], baseOpts());
    const prompt = (result.confirmations ?? []).find((c) =>
      /(catch|repeat|say it)/i.test(c.text || '')
    );
    expect(prompt).toBeUndefined();
    expect(session.orphanContext == null).toBe(true);
  });

  test('a turn that produced a tool call → no prompt (covers the ask_user negative)', async () => {
    runToolLoopSpy.mockImplementation(async () => ({
      stop_reason: 'tool_use',
      rounds: 1,
      tool_calls: [{ name: 'ask_user', input: {} }],
      aborted: false,
      messages_final: [],
      usage: {},
      terminal_reason: 'end_turn',
    }));
    const session = makeSession();
    const result = await runShadowHarness(session, 'EFC is 0.86.', [], baseOpts());
    const prompt = (result.confirmations ?? []).find((c) =>
      /(catch|repeat|say it)/i.test(c.text || '')
    );
    expect(prompt).toBeUndefined();
    expect(session.orphanContext == null).toBe(true);
  });

  test('an answer turn (pendingAsks pending) → no prompt', async () => {
    const session = makeSession();
    const result = await runShadowHarness(
      session,
      'EFC is 0.86.',
      [],
      baseOpts({ pendingAsks: makePendingAsks(1) })
    );
    const prompt = (result.confirmations ?? []).find((c) =>
      /(catch|repeat|say it)/i.test(c.text || '')
    );
    expect(prompt).toBeUndefined();
  });

  test('an answer turn (inResponseTo) → no prompt', async () => {
    const session = makeSession();
    const result = await runShadowHarness(
      session,
      'EFC is 0.86.',
      [],
      baseOpts({ inResponseTo: true })
    );
    const prompt = (result.confirmations ?? []).find((c) =>
      /(catch|repeat|say it)/i.test(c.text || '')
    );
    expect(prompt).toBeUndefined();
  });

  test('confirmations disabled (voice mode off) → no prompt', async () => {
    const session = makeSession();
    const result = await runShadowHarness(
      session,
      'EFC is 0.86.',
      [],
      baseOpts({ confirmationsEnabled: false })
    );
    const prompt = (result.confirmations ?? []).find((c) =>
      /(catch|repeat|say it)/i.test(c.text || '')
    );
    expect(prompt).toBeUndefined();
  });
});

// M1 Defect B — the all-tool-calls-rejected silent-drop hole. A turn that
// made tool calls but had EVERY call rejected (is_error===true) emits zero
// TTS — the "circuits 5,6,7,8 are spare" all-duplicate-rejected case
// (field session 6674E8C5 turn-11). The net must fire a spoken prompt for it
// too, but NEVER for a turn that emitted a real ask_user.
describe('orphan net — all-rejected branch (M1 Defect B)', () => {
  const rejectedCall = (name) => ({
    name,
    input: {},
    result: { tool_use_id: 't', content: '{"ok":false}', is_error: true },
  });
  const okCall = (name) => ({
    name,
    input: {},
    result: { tool_use_id: 't', content: '{"ok":true}', is_error: false },
  });

  test('every tool call rejected + digit-bearing → fires exactly ONE rejected-style confirmation', async () => {
    runToolLoopSpy.mockImplementation(async () => ({
      stop_reason: 'end_turn',
      rounds: 1,
      tool_calls: [rejectedCall('create_circuit'), rejectedCall('create_circuit')],
      aborted: false,
      messages_final: [],
      usage: {},
      terminal_reason: 'end_turn',
    }));
    const session = makeSession();
    const result = await runShadowHarness(
      session,
      'Circuits 5, 6, 7, 8 are spare.',
      [],
      baseOpts()
    );
    const prompts = (result.confirmations ?? []).filter((c) =>
      /(couldn't action|able to apply|didn't go through)/i.test(c.text || '')
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0].circuit).toBeNull();
    expect(prompts[0].expects_ios_ack).toBe(false);
    expect(session.orphanContext).toMatchObject({ transcript: 'Circuits 5, 6, 7, 8 are spare.' });
  });

  test('rejected calls + a real ask_user (is_error:false) → NO prompt (ask_user already spoken over WS)', async () => {
    runToolLoopSpy.mockImplementation(async () => ({
      stop_reason: 'tool_use',
      rounds: 1,
      tool_calls: [rejectedCall('create_circuit'), okCall('ask_user')],
      aborted: false,
      messages_final: [],
      usage: {},
      terminal_reason: 'end_turn',
    }));
    const session = makeSession();
    const result = await runShadowHarness(session, 'Circuit 5 is spare.', [], baseOpts());
    const prompt = (result.confirmations ?? []).find((c) =>
      /(couldn't action|able to apply|didn't go through|catch|repeat|say it)/i.test(c.text || '')
    );
    expect(prompt).toBeUndefined();
  });

  test('a successful tool call present (not all rejected) → NO prompt', async () => {
    runToolLoopSpy.mockImplementation(async () => ({
      stop_reason: 'end_turn',
      rounds: 1,
      tool_calls: [rejectedCall('create_circuit'), okCall('create_circuit')],
      aborted: false,
      messages_final: [],
      usage: {},
      terminal_reason: 'end_turn',
    }));
    const session = makeSession();
    const result = await runShadowHarness(session, 'Circuits 5, 6 are spare.', [], baseOpts());
    const prompt = (result.confirmations ?? []).find((c) =>
      /(couldn't action|able to apply|didn't go through)/i.test(c.text || '')
    );
    expect(prompt).toBeUndefined();
  });
});
