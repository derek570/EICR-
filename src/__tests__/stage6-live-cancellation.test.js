/**
 * stage6-live-cancellation.test.js — F7 Item 3. The shadow-harness
 * cancellation-FINALIZATION contract: when runToolLoop throws a fatal
 * ExtractionCancelledError (watchdog ceiling / no-ask deadline), runLiveMode
 * does NOT rethrow a silent abort — it FINALIZES the already-applied
 * perTurnWrites through the normal bundler → read-back path (so every applied
 * reading is still read back once), drains the queued apology, and appends the
 * deterministic field-null fallback when nothing audible survived. It runs the
 * REDUCED toolLoopOut-INDEPENDENT wire pipeline (bundler + designation maps +
 * drain + fallback + ios_send_attempt) WITHOUT crashing on the undefined
 * toolLoopOut, and SKIPS the toolLoopOut-dependent A3/D2/cost/telemetry blocks
 * and the dialogue hooks.
 *
 * Mocks runToolLoop (made to throw) + the ask dispatcher + speculator.
 */

import { jest } from '@jest/globals';

const SESSION_ID = 'sess-cancel';

const askSentinel = Object.assign(
  async () => ({ tool_use_id: 'a', content: '{}', is_error: false }),
  {
    __tag: 'asks',
  }
);

let populateWrites = null;
let throwOnLoop = false;

jest.unstable_mockModule('../extraction/stage6-dispatcher-ask.js', () => ({
  createAskDispatcher: jest.fn(() => askSentinel),
  ASK_USER_TIMEOUT_MS: 45000,
}));

const { ExtractionCancelledError } = await import('../extraction/stage6-control-flow-errors.js');

const runToolLoopSpy = jest.fn(async (opts) => {
  if (typeof populateWrites === 'function' && typeof opts.perTurnWritesRef === 'function') {
    populateWrites(opts.perTurnWritesRef());
  }
  if (throwOnLoop) {
    // Simulate the watchdog ceiling aborting the loop AFTER some writes applied.
    throw new ExtractionCancelledError('extraction_watchdog_absolute_ceiling');
  }
  return {
    stop_reason: 'end_turn',
    rounds: 1,
    tool_calls: [{ name: 'record_reading', input: {}, result: { is_error: false } }],
    aborted: false,
    messages_final: [],
    usage: {},
    terminal_reason: 'end_turn',
  };
});

jest.unstable_mockModule('../extraction/stage6-tool-loop.js', () => ({
  runToolLoop: runToolLoopSpy,
  LOOP_CAP: 8,
  NOOP_DISPATCHER: async () => ({}),
}));

jest.unstable_mockModule('../extraction/loaded-barrel-speculator.js', () => ({
  createSpeculator: jest.fn(() => ({
    onSnapshotPatch: jest.fn(),
    onLoopComplete: jest.fn(),
    onToolUseStreamed: jest.fn(),
    validateAgainstConfirmations: jest.fn(),
    abortBySlot: jest.fn(),
    shutdown: jest.fn(),
  })),
}));

const { runShadowHarness } = await import('../extraction/stage6-shadow-harness.js');
const { activeSessions } = await import('../extraction/active-sessions.js');

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}
function makeSession(overrides = {}) {
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
    buildSystemBlocks() {
      return [
        { type: 'text', text: this.systemPrompt, cache_control: { type: 'ephemeral', ttl: '5m' } },
      ];
    },
    buildAgenticSystemBlocks() {
      return this.buildSystemBlocks();
    },
    ...overrides,
  };
}
function baseOpts(overrides = {}) {
  return {
    logger: makeLogger(),
    pendingAsks: { __tag: 'pending-asks-registry', size: 0, entries: () => [] },
    ws: { readyState: 1, OPEN: 1, send: jest.fn() },
    confirmationsEnabled: true,
    generationId: 'gen-cancel',
    signal: new AbortController().signal,
    ...overrides,
  };
}

beforeEach(() => {
  populateWrites = null;
  throwOnLoop = false;
  runToolLoopSpy.mockClear();
  activeSessions.set(SESSION_ID, {
    session: { sessionId: SESSION_ID },
    pendingFastTtsSlots: new Map(),
    fastPathCorrelationIdByTurn: new Map(),
    broadcastIntentByTurn: new Map(),
    voiceLatency: { flags: { loadedBarrel: false } },
  });
});
afterEach(() => activeSessions.delete(SESSION_ID));

describe('F7 Item 3 — cancellation-finalization contract', () => {
  test('a fatal cancellation is NOT rethrown — runLiveMode returns a finalized partial (no throw past runLiveMode)', async () => {
    throwOnLoop = true;
    const result = await runShadowHarness(makeSession(), 'anything', [], baseOpts());
    expect(result).toBeDefined();
    expect(Array.isArray(result.extracted_readings)).toBe(true);
  });

  test('a record_reading applied BEFORE the ceiling is still read back exactly once', async () => {
    throwOnLoop = true;
    populateWrites = (w) => {
      w.readings.set('measured_zs_ohm::1', {
        value: '0.62',
        confidence: 0.9,
        source_turn_id: 't1',
      });
    };
    const result = await runShadowHarness(makeSession(), 'zs circuit 1 0.62', [], baseOpts());
    const zsConfs = (result.confirmations ?? []).filter((c) => c.field === 'measured_zs_ohm');
    expect(zsConfs).toHaveLength(1);
    // The reading's legacy wire projection survives (bundler ran on cancellation).
    expect((result.extracted_readings ?? []).some((r) => r.field === 'measured_zs_ohm')).toBe(true);
  });

  test('a no-write / no-audible cancellation fires the deterministic fallback (never silence)', async () => {
    throwOnLoop = true; // no populateWrites → nothing audible survives
    const opts = baseOpts();
    const result = await runShadowHarness(makeSession(), 'wedged turn', [], opts);
    const fallback = (result.confirmations ?? []).filter(
      (c) => c.field == null && /couldn.t action that/i.test(c.text || '')
    );
    expect(fallback).toHaveLength(1);
    const fbRows = opts.logger.info.mock.calls
      .filter((c) => c[0] === 'stage6.ask_audibility_fallback_emitted')
      .map((c) => c[1]);
    expect(fbRows).toHaveLength(1);
    expect(fbRows[0].generationId).toBe('gen-cancel');
  });

  test('a cancellation WITH a surviving reading does NOT also add the fallback (no double)', async () => {
    throwOnLoop = true;
    populateWrites = (w) => {
      w.readings.set('measured_zs_ohm::1', {
        value: '0.62',
        confidence: 0.9,
        source_turn_id: 't1',
      });
    };
    const result = await runShadowHarness(makeSession(), 'zs 0.62', [], baseOpts());
    const fallback = (result.confirmations ?? []).filter(
      (c) => c.field == null && /couldn.t action that/i.test(c.text || '')
    );
    expect(fallback).toHaveLength(0);
  });

  test('a CURRENT-generation queued apology is still drained on cancellation (+ one ios_send_attempt)', async () => {
    throwOnLoop = true;
    const session = makeSession();
    session.pendingVoicePrompts = [
      { text: 'Sorry, I couldn’t place that reading — say it again?' },
    ];
    const opts = baseOpts();
    const result = await runShadowHarness(session, 'wedged', [], opts);
    const prompts = (result.confirmations ?? []).filter(
      (c) => c.field == null && c.expects_ios_ack === false
    );
    expect(prompts.length).toBeGreaterThanOrEqual(1);
    // The drained prompt got an ios_send_attempt row carrying generationId.
    const sendRows = opts.logger.info.mock.calls
      .filter((c) => c[0] === 'ios_send_attempt')
      .map((c) => c[1]);
    expect(sendRows.length).toBeGreaterThanOrEqual(1);
    expect(sendRows.every((r) => r.generationId === 'gen-cancel')).toBe(true);
  });

  test('generation-owned drain: an OTHER-generation queued prompt is PRESERVED (not spoken this turn) and does not suppress the current fallback', async () => {
    throwOnLoop = true; // cancellation, nothing audible from the current gen
    const session = makeSession();
    // A stale prompt from a DIFFERENT generation is already queued.
    session.pendingVoicePrompts = [
      { text: 'stale apology from a prior generation', generationId: 'gen-OTHER' },
    ];
    const result = await runShadowHarness(session, 'wedged', [], baseOpts());
    // Exactly ONE current-generation fallback reached the wire (the stale one did NOT).
    const fieldNull = (result.confirmations ?? []).filter((c) => c.field == null);
    expect(fieldNull).toHaveLength(1);
    expect(/couldn.t action that/i.test(fieldNull[0].text)).toBe(true);
    // The other-generation prompt is PRESERVED on the session (never drained here).
    expect(session.pendingVoicePrompts.some((p) => p.generationId === 'gen-OTHER')).toBe(true);
  });

  test('the NORMAL path (no cancellation) still runs the full pipeline (no regression)', async () => {
    throwOnLoop = false;
    populateWrites = (w) => {
      w.readings.set('measured_zs_ohm::1', {
        value: '0.62',
        confidence: 0.9,
        source_turn_id: 't1',
      });
    };
    const result = await runShadowHarness(makeSession(), 'zs 0.62', [], baseOpts());
    const zsConfs = (result.confirmations ?? []).filter((c) => c.field === 'measured_zs_ohm');
    expect(zsConfs).toHaveLength(1);
    // Normal path advances turnCount + runs cost/telemetry (no fallback).
    const fallback = (result.confirmations ?? []).filter(
      (c) => c.field == null && /couldn.t action that/i.test(c.text || '')
    );
    expect(fallback).toHaveLength(0);
  });
});
