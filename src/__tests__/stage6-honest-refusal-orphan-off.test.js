/**
 * Plan B §3.3 kill-switch independence (round-17): VOICE_ORPHAN_PROMPT=false
 * bypasses the orphan-PROMPT-EMISSION portion of A3 (recovery +
 * REJECTED_PROMPTS + orphanContext), but the allRejected CLASSIFICATION and
 * plan B's coverage arbitration still run. Under flag-off:
 *
 *   - PARTIAL coverage still stamps drain:false on the covered subset, so
 *     the drained refusal cannot suppress marker-② while the uncovered
 *     rejection loses today's fallback — marker-② speaks its catch-all.
 *   - FULL coverage drains the refusal notices as the turn's audible output
 *     (no generic prompt of any family; never silence).
 *
 * Separate file because ORPHAN_PROMPT_ENABLED is a module-load constant —
 * the env var must be set BEFORE the harness module is imported.
 */

import { jest } from '@jest/globals';

process.env.VOICE_ORPHAN_PROMPT = 'false';

const SESSION_ID = 'sess-honest-refusal-off';

const askSentinel = Object.assign(
  async () => ({ tool_use_id: 'a', content: '{}', is_error: false }),
  { __tag: 'asks' }
);
const createAskDispatcherSpy = jest.fn(() => askSentinel);

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

const { runShadowHarness, CATCHALL_AUDIBILITY_PROMPTS, REJECTED_PROMPTS } =
  await import('../extraction/stage6-shadow-harness.js');
const { activeSessions } = await import('../extraction/active-sessions.js');
const { parseVoiceLatencyCapabilities } = await import('../extraction/voice-latency-config.js');
const { B_STAGED_POOLS } = await import('../extraction/refusal-notices.js');

const CATCHALL_SET = new Set(CATCHALL_AUDIBILITY_PROMPTS);
const REJECTED_SET = new Set(REJECTED_PROMPTS);

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeSession(stateOverrides = {}) {
  return {
    sessionId: SESSION_ID,
    systemPrompt: 'sys',
    toolCallsMode: 'live',
    certType: 'eicr',
    turnCount: 0,
    costTracker: {
      addSonnetUsage: jest.fn(),
      recordElevenLabsSpeculativeStarted: jest.fn(() => true),
      recordElevenLabsSpeculativeTerminal: jest.fn(),
    },
    stateSnapshot: {
      circuits: {},
      pending_readings: [],
      observations: [],
      validation_alerts: [],
      boards: [{ id: 'main', designation: 'DB-1', board_type: 'main' }],
      currentBoardId: 'main',
      ...stateOverrides,
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

function registerEntry() {
  activeSessions.set(SESSION_ID, {
    session: { sessionId: SESSION_ID },
    pendingFastTtsSlots: new Map(),
    fastPathCorrelationIdByTurn: new Map(),
    broadcastIntentByTurn: new Map(),
    voiceLatency: {
      flags: { loadedBarrel: false },
      capabilities: parseVoiceLatencyCapabilities({
        voice_latency: { version: 1, supports: [] },
      }),
    },
  });
}

function baseOpts() {
  return {
    logger: makeLogger(),
    pendingAsks: { __tag: 'pending-asks-registry', size: 0, entries: () => [] },
    ws: { readyState: 1, OPEN: 1, send: jest.fn() },
    confirmationsEnabled: true,
    chimeObserved: true,
  };
}

function loopDispatching(calls) {
  runToolLoopSpy.mockImplementation(async (opts) => {
    const toolCalls = [];
    for (let i = 0; i < calls.length; i += 1) {
      const c = calls[i];
      const env = await opts.dispatcher(
        { tool_call_id: c.id ?? `toolu_${i}`, name: c.name, input: c.input },
        opts.ctx
      );
      toolCalls.push({
        tool_call_id: c.id ?? `toolu_${i}`,
        name: c.name,
        input: c.input,
        result: env,
      });
    }
    return {
      stop_reason: 'end_turn',
      rounds: 1,
      tool_calls: toolCalls,
      aborted: false,
      messages_final: [],
      usage: {},
      terminal_reason: 'end_turn',
    };
  });
}

function audibleConfs(result) {
  return (result.confirmations ?? []).filter(
    (c) => typeof c.text === 'string' && c.text.trim().length > 0
  );
}

beforeEach(() => {
  runToolLoopSpy.mockClear();
  registerEntry();
});

afterEach(() => {
  activeSessions.delete(SESSION_ID);
});

afterAll(() => {
  delete process.env.VOICE_ORPHAN_PROMPT;
});

test('flag-off + PARTIAL coverage: covered notices stamped drain:false; marker-② keeps the existing fallback for the uncovered rejection (exactly one catch-all line, zero refusal lines, zero REJECTED_PROMPTS)', async () => {
  const session = makeSession({ circuits: { 4: {} } });
  loopDispatching([
    {
      name: 'clear_reading',
      input: { field: 'circuit_ref', circuit: 4, reason: 'user_correction' },
      id: 'toolu_cov',
    },
    {
      name: 'clear_reading',
      input: { field: 'measured_zs_ohm', circuit: 99, reason: 'user_correction' },
      id: 'toolu_unc',
    },
  ]);
  const opts = baseOpts();
  const result = await runShadowHarness(session, 'Clear those.', [], opts);

  const speakers = audibleConfs(result);
  expect(speakers).toHaveLength(1);
  expect(CATCHALL_SET.has(speakers[0].text)).toBe(true);
  expect(REJECTED_SET.has(speakers[0].text)).toBe(false);
  const refusalish = speakers.filter((c) => /clear/i.test(c.text) && !CATCHALL_SET.has(c.text));
  expect(refusalish).toHaveLength(0);
});

test('flag-off + FULL coverage: the refusal notice drains as the audible output (no catch-all, no REJECTED_PROMPTS, never silence)', async () => {
  const session = makeSession({ circuits: { 4: {} } });
  loopDispatching([
    {
      name: 'clear_reading',
      input: { field: 'circuit_ref', circuit: 4, reason: 'user_correction' },
      id: 'toolu_full',
    },
  ]);
  const opts = baseOpts();
  const result = await runShadowHarness(session, 'Clear the reference on 4.', [], opts);

  const speakers = audibleConfs(result);
  expect(speakers).toHaveLength(1);
  expect(CATCHALL_SET.has(speakers[0].text)).toBe(false);
  expect(REJECTED_SET.has(speakers[0].text)).toBe(false);
  expect(
    B_STAGED_POOLS.unsupported_clear.map((f) => f('Circuit Reference for circuit 4 on board 1'))
  ).toContain(speakers[0].text);
});
