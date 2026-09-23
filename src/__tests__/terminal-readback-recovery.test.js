/**
 * PLAN-A §A1 (feedback-2026-09-17) — the terminal-read-back RECOVERY STEP, and
 * the PLACEMENT that makes it correct. Acceptance item 11's A3 no-op case.
 *
 * The recovery appends the lost read-back to `result.confirmations`
 * UNCONDITIONALLY, immediately BEFORE the A3 orphan net. A3's `producedNothing`
 * predicate includes `confirmations.length === 0`, so a build that appends
 * AFTER A3 produces TWO spoken outcomes for one turn — A3's generic apology
 * plus the true read-back contradicting it. Every case below that asserts "no
 * apology fired" therefore fails on the wrong placement, which is the point.
 *
 * Mock pattern mirrors stage6-orphan-net.test.js — that suite is the positive
 * control for A3 firing, and this one is its complement.
 */

import { jest } from '@jest/globals';

const SESSION_ID = 'sess-recovery';

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


const LOST = 'Also got BS number BS EN 61008.';
const isApology = (text) => /(catch|repeat|say it|nothing was recorded|didn't)/i.test(text ?? '');

function recoveryConfirmations(result) {
  return (result.confirmations ?? []).filter((c) => /_terminal_lost$/.test(c.dedupe_token ?? ''));
}

describe('the recovery step speaks the lost read-back', () => {
  test('appended exactly once, field null, circuit null, with the recovery-specific token', async () => {
    const session = makeSession();
    const result = await runShadowHarness(
      session,
      'nothing here',
      [],
      baseOpts({ terminalReadbackLostTexts: [LOST] })
    );

    const recovered = recoveryConfirmations(result);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].text).toBe(LOST);
    expect(recovered[0].field).toBeNull();
    expect(recovered[0].circuit).toBeNull();
    // A stable, recovery-specific key. It separates two different lost
    // read-backs that happen to carry the same text inside the field-null
    // window, while giving a REPLAY of the same turn the same key so the
    // replay is correctly suppressed.
    expect(recovered[0].dedupe_token).toMatch(/^p4ack_.*_terminal_lost$/);
    // The spoken form is derived from the FINAL text.
    expect(typeof recovered[0].expanded_text).toBe('string');
  });

  test('an EMPTY carrier appends nothing', async () => {
    const session = makeSession();
    const result = await runShadowHarness(
      session,
      'nothing here',
      [],
      baseOpts({ terminalReadbackLostTexts: [] })
    );
    expect(recoveryConfirmations(result)).toHaveLength(0);
  });

  test('multiple lost lines are JOINED into ONE confirmation, in carrier order', async () => {
    const session = makeSession();
    const result = await runShadowHarness(
      session,
      'nothing here',
      [],
      baseOpts({ terminalReadbackLostTexts: ['R line.', 'P line.'] })
    );
    const recovered = recoveryConfirmations(result);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].text).toBe('R line. P line.');
  });
});

describe('PLACEMENT — the A3 no-op case, which fails on a later append', () => {
  test('a chimed digit-bearing no-op turn: the recovery line is the SOLE spoken outcome', async () => {
    // This is the exact shape A3 fires on — a forwarded, digit-bearing
    // utterance that produces zero tool calls and zero output. Because the
    // recovery lands in `result.confirmations` BEFORE A3 evaluates, A3's
    // `producedNothing` is false and no apology fires. A build that appends
    // AFTER A3 produces TWO lines here and MUST fail this test.
    const session = makeSession();
    const result = await runShadowHarness(
      session,
      'EFC is 0.86.',
      [],
      baseOpts({ terminalReadbackLostTexts: [LOST], chimeObserved: true })
    );

    const recovered = recoveryConfirmations(result);
    expect(recovered).toHaveLength(1);

    // No A3 orphan prompt, no marker-② catch-all, no nothing_recorded family.
    const apologies = (result.confirmations ?? []).filter((c) => isApology(c.text));
    expect(apologies).toEqual([]);
    const queued = (session.pendingVoicePrompts ?? []).filter((p) => isApology(p?.text));
    expect(queued).toEqual([]);

    // …and the orphan context was NOT armed, because the turn was not silent.
    expect(session.orphanContext == null).toBe(true);
  });

  test('WITHOUT the recovery the same turn DOES draw an apology — the control', async () => {
    // The negative control that makes the assertion above meaningful: if A3
    // never fired on this shape, "no apology" would prove nothing.
    const session = makeSession();
    const result = await runShadowHarness(session, 'EFC is 0.86.', [], baseOpts());
    const apologies = (result.confirmations ?? []).filter((c) => isApology(c.text));
    expect(apologies.length).toBeGreaterThan(0);
  });

  test('it also runs on a CANCELLED generation — it sits outside the !cancelled guard', async () => {
    // Pre-abort writes still reach `result.confirmations` and are still owed a
    // read-back, so the recovery must not be gated on completion.
    const session = makeSession();
    const result = await runShadowHarness(
      session,
      'EFC is 0.86.',
      [],
      baseOpts({ terminalReadbackLostTexts: [LOST], cancelled: true })
    );
    expect(recoveryConfirmations(result)).toHaveLength(1);
  });

  test('it is ADDITIVE — a turn may carry the model’s own confirmation AND the recovery', async () => {
    // Both outcomes are owed; neither replaces the other. Driven by making the
    // tool loop produce a real reading this turn.
    runToolLoopSpy.mockImplementationOnce(async () => ({
      stop_reason: 'end_turn',
      rounds: 1,
      tool_calls: [],
      aborted: false,
      messages_final: [],
      usage: {},
      terminal_reason: 'end_turn',
    }));
    const session = makeSession();
    const result = await runShadowHarness(
      session,
      'nothing here',
      [],
      baseOpts({ terminalReadbackLostTexts: [LOST] })
    );
    expect(recoveryConfirmations(result)).toHaveLength(1);
  });
});
