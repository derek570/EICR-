/**
 * PLAN-A §A1 (feedback-2026-09-17) — the DEVICE-ABSENCE FENCE, through the REAL
 * harness, the REAL fence and the REAL answer finalizer.
 *
 * The predicate's own matrix is pinned against the production function in
 * `device-absence-fence.test.js`. THIS file asserts the other half: that the
 * flag the fence sets changes what the turn actually speaks.
 *
 * No production test seam was added for this. The harness already passes
 * `perTurnWritesRef` into `runToolLoop` as part of its ordinary contract, so a
 * mocked loop can seed the same per-turn state a real `clear_reading` dispatch
 * would leave behind — and everything after that is production code.
 *
 * Every positive assertion is paired with a NEGATIVE CONTROL. Without one,
 * "no fallback was staged" proves nothing: it would read the same if the
 * fallback never fired on this shape at all.
 */


import { jest } from '@jest/globals';

const SESSION_ID = 'sess-fence-harness';

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

const { EFFECTIVE_CIRCUIT_SLOT } = await import('../extraction/stage6-per-turn-writes.js');

function clearOn(field, circuit, boardId) {
  const entry = { field, circuit, board_id: boardId };
  Object.defineProperty(entry, EFFECTIVE_CIRCUIT_SLOT, {
    value: { field, circuit, boardId },
    enumerable: false,
    configurable: true,
  });
  return entry;
}

/** Seed the per-turn state a real `clear_reading` + `answer_user` turn leaves. */
function seedTurn(seed) {
  runToolLoopSpy.mockImplementationOnce(async (args) => {
    seed(args.perTurnWritesRef());
    return {
      stop_reason: 'end_turn',
      rounds: 1,
      tool_calls: [],
      aborted: false,
      messages_final: [],
      usage: {},
      terminal_reason: 'end_turn',
    };
  });
}

const HANDOFF = { circuit_ref: 3, boardId: 'main', schema: 'rcd' };

function run(session, opts) {
  return runShadowHarness(session, 'there is no RCD', [], opts);
}

describe('the fence changes what the turn speaks', () => {
  test('a surviving clear on the handed-off circuit fences the answer fallback', async () => {
    const rows = [];
    seedTurn((w) => {
      w.answer.featureTouched = true;
      w.cleared.push(clearOn('rcd_type', 3, 'main'));
    });
    const result = await run(
      makeSession(),
      baseOpts({
        handoff: HANDOFF,
        logger: {
          info: (e, p) => rows.push({ e, p }),
          warn: () => {},
          error: () => {},
          debug: () => {},
        },
      })
    );

    const fenced = rows.filter((r) => r.e === 'stage6.answer_fenced_by_clears');
    expect(fenced).toHaveLength(1);
    expect(fenced[0].p).toMatchObject({ circuit: 3, boardId: 'main', fields: ['rcd_type'] });
    // The surviving `field_cleared` line is the turn's spoken outcome; the
    // fixed fallback must not ride on top of it.
    expect(rows.some((r) => r.e === 'stage6.answer_fallback_staged')).toBe(false);
  });

  test('NEGATIVE CONTROL — the same turn with NO surviving clear DOES stage the fallback', async () => {
    const rows = [];
    seedTurn((w) => {
      w.answer.featureTouched = true;
    });
    await run(
      makeSession(),
      baseOpts({
        handoff: HANDOFF,
        logger: {
          info: (e, p) => rows.push({ e, p }),
          warn: () => {},
          error: () => {},
          debug: () => {},
        },
      })
    );
    expect(rows.some((r) => r.e === 'stage6.answer_fenced_by_clears')).toBe(false);
    expect(rows.some((r) => r.e === 'stage6.answer_fallback_staged')).toBe(true);
  });

  test('a clear on ANOTHER circuit does not fence, and does not touch the answer state', async () => {
    // The fence's contract is what is under test here, and it is NARROWER than
    // "the fallback stages": a clear on circuit 9 is itself a successful write,
    // so the finalizer's own pre-existing rule already declines the fixed
    // fallback — for a reason that has nothing to do with this plan. Asserting
    // the fallback here would test that other rule and pass or fail for the
    // wrong reason. What must be true is that the FENCE stayed out of it: no
    // fence row, and the answer state untouched by it.
    const rows = [];
    let observed = null;
    seedTurn((w) => {
      w.answer.featureTouched = true;
      w.answer.stagedText = 'the overcurrent device remains';
      w.cleared.push(clearOn('rcd_type', 9, 'main'));
      observed = w.answer;
    });
    await run(
      makeSession(),
      baseOpts({
        handoff: HANDOFF,
        logger: {
          info: (e, p) => rows.push({ e, p }),
          warn: () => {},
          error: () => {},
          debug: () => {},
        },
      })
    );
    expect(rows.some((r) => r.e === 'stage6.answer_fenced_by_clears')).toBe(false);
    // The staged answer SURVIVES — the fence discards it only for a clear on
    // the handed-off circuit.
    expect(observed.fencedByClears).not.toBe(true);
    expect(observed.stagedText).toBe('the overcurrent device remains');
  });

  test('…and the SAME turn with the clear on the HANDED-OFF circuit discards it', async () => {
    // The paired positive, so the row above cannot pass by the fence being
    // broken in the other direction.
    const rows = [];
    let observed = null;
    seedTurn((w) => {
      w.answer.featureTouched = true;
      w.answer.stagedText = 'the overcurrent device remains';
      w.cleared.push(clearOn('rcd_type', 3, 'main'));
      observed = w.answer;
    });
    await run(
      makeSession(),
      baseOpts({
        handoff: HANDOFF,
        logger: {
          info: (e, p) => rows.push({ e, p }),
          warn: () => {},
          error: () => {},
          debug: () => {},
        },
      })
    );
    expect(rows.some((r) => r.e === 'stage6.answer_fenced_by_clears')).toBe(true);
    expect(observed.fencedByClears).toBe(true);
    expect(observed.stagedText).toBeNull();
  });

  test('a turn with NO handoff never fences, whatever it cleared', async () => {
    const rows = [];
    seedTurn((w) => {
      w.answer.featureTouched = true;
      w.cleared.push(clearOn('rcd_type', 3, 'main'));
    });
    await run(
      makeSession(),
      baseOpts({
        logger: {
          info: (e, p) => rows.push({ e, p }),
          warn: () => {},
          error: () => {},
          debug: () => {},
        },
      })
    );
    expect(rows.some((r) => r.e === 'stage6.answer_fenced_by_clears')).toBe(false);
  });
});
