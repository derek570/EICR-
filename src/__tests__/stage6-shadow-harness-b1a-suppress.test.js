/**
 * Plan B (2026-06-17) B1a — assert the SUPPRESS contract: runLiveMode wires the
 * speculator's onSlotAudioReady hook to NULL so no mid_stream_preview extraction
 * envelope is ever advertised to iOS pre-validation. The parked MP3 is claimed
 * later by the canonical confirmation POST instead.
 *
 * Mock pattern mirrors stage6-shadow-harness-broadcast-intent-wiring.test.js
 * (ESM factory spies for runToolLoop + the ask dispatcher), plus a createSpeculator
 * spy that captures the opts the harness passes.
 */

import { jest } from '@jest/globals';

const SESSION_ID = 'sess-b1a-suppress';

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

// Capture the opts the harness passes into createSpeculator.
let capturedSpeculatorOpts = null;
const validateSpy = jest.fn();
const createSpeculatorSpy = jest.fn((opts) => {
  capturedSpeculatorOpts = opts;
  return {
    onSnapshotPatch: jest.fn(),
    onLoopComplete: jest.fn(),
    onToolUseStreamed: jest.fn(),
    validateAgainstConfirmations: validateSpy,
    abortBySlot: jest.fn(),
    shutdown: jest.fn(),
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
    // costTracker present → the harness creates the speculator (gated on
    // vl.flags.loadedBarrel && session.costTracker).
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
      return [{ type: 'text', text: this.systemPrompt, cache_control: { type: 'ephemeral', ttl: '5m' } }];
    },
    buildAgenticSystemBlocks() {
      return this.buildSystemBlocks();
    },
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
  createSpeculatorSpy.mockClear();
  validateSpy.mockClear();
  capturedSpeculatorOpts = null;
  activeSessions.set(SESSION_ID, {
    session: { sessionId: SESSION_ID },
    pendingFastTtsSlots: new Map(),
    fastPathCorrelationIdByTurn: new Map(),
    broadcastIntentByTurn: new Map(),
    // Enable Loaded Barrel for this session so the speculator is constructed.
    voiceLatency: { flags: { loadedBarrel: true } },
  });
});

afterEach(() => {
  activeSessions.delete(SESSION_ID);
});

describe('B1a — runLiveMode suppresses the mid-stream preview advertisement', () => {
  test('createSpeculator is wired with onSlotAudioReady: null (no preview emitter)', async () => {
    const ws = makeWs();
    await runShadowHarness(makeSession(), 'Zs for circuit 3 is 0.42 ohms.', [], {
      logger: makeLogger(),
      pendingAsks: makePendingAsks(),
      ws,
    });

    expect(createSpeculatorSpy).toHaveBeenCalledTimes(1);
    // The contract: the harness must NOT pass a function that would advertise a
    // mid_stream_preview. Pre-B1a this was a closure; B1a sets it to null.
    expect(capturedSpeculatorOpts).not.toBeNull();
    expect(capturedSpeculatorOpts.onSlotAudioReady).toBeNull();
  });

  test('no mid_stream_preview envelope is ever sent on the ws', async () => {
    const ws = makeWs();
    await runShadowHarness(makeSession(), 'Zs for circuit 3 is 0.42 ohms.', [], {
      logger: makeLogger(),
      pendingAsks: makePendingAsks(),
      ws,
    });

    const previewSends = ws.send.mock.calls.filter((call) => {
      try {
        const msg = JSON.parse(call[0]);
        return msg?.result?.mid_stream_preview === true;
      } catch {
        return false;
      }
    });
    expect(previewSends).toHaveLength(0);
  });

  test('post-loop drift validation is still invoked (canonical-claim path intact)', async () => {
    const ws = makeWs();
    await runShadowHarness(makeSession(), 'Zs for circuit 3 is 0.42 ohms.', [], {
      logger: makeLogger(),
      pendingAsks: makePendingAsks(),
      ws,
    });
    // B1b validate runs post-loop so surviving parked entries stay servable and
    // drifted ones are dropped — the gate that replaces early advertisement.
    expect(validateSpy).toHaveBeenCalledTimes(1);
  });
});
