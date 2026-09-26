/**
 * PLAN-W1 M2d (W1-23) — across wrappers. sonnet-stream runs the ring, IR and
 * protective-device wrappers on the same raw reply. When the ring wrapper
 * refuses entry because its named capture is ambiguous, it arms the existing
 * cross-wrapper veto, so the IR wrapper cannot enter on the same words and the
 * model gets the whole utterance.
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

class FakeEICRExtractionSession {
  constructor(apiKey, sessionId) {
    this.sessionId = sessionId;
    this.turnCount = 0;
    this.costTracker = { toCostUpdate: () => ({ type: 'cost_update', cost: 0 }) };
    this.start = jest.fn();
    this.stop = jest.fn(() => ({ totals: { cost: 0 } }));
    this.flushUtteranceBuffer = jest.fn(async () => null);
    this.updateJobState = jest.fn();
    this.pause = jest.fn();
    this.resume = jest.fn();
    this.onBatchResult = null;
    this.toolCallsMode = 'off';
    this.applyModeChange = jest.fn((m) => {
      this.toolCallsMode = m;
    });
  }
}

jest.unstable_mockModule('../extraction/eicr-extraction-session.js', () => ({
  EICRExtractionSession: FakeEICRExtractionSession,
}));

const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('../logger.js', () => ({ default: loggerMock }));
jest.unstable_mockModule('../storage.js', () => ({ uploadJson: jest.fn(async () => {}) }));

const harnessCalls = [];
const runShadowHarnessSpy = jest.fn(async (_session, text) => {
  harnessCalls.push(text);
  return { extracted_readings: [], questions_for_user: [], observations: [], confirmations: [] };
});
jest.unstable_mockModule('../extraction/stage6-shadow-harness.js', () => ({
  runShadowHarness: runShadowHarnessSpy,
  mergeFastPathCorrelationIds: jest.fn(),
  unmergeFastPathCorrelationIds: jest.fn(),
  coerceFastPathCorrelationIds: jest.fn(() => new Set()),
}));

const { initSonnetStream, activeSessions } = await import('../extraction/sonnet-stream.js');
const { sonnetSessionStore } = await import('../extraction/sonnet-session-store.js');

function makeFakeWs() {
  const sent = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: jest.fn((p) => sent.push(JSON.parse(p))),
    ping: jest.fn(),
    close: jest.fn(),
    on: jest.fn(),
    _handlers: new Map(),
  };
  ws.on.mockImplementation((e, h) => ws._handlers.set(e, h));
  ws._sent = sent;
  ws._emit = (e, d) => ws._handlers.get(e)?.(d);
  return ws;
}

let wss;
const openWs = [];

async function startLiveSession(sessionId) {
  const ws = makeFakeWs();
  openWs.push(ws);
  wss.emit('connection', ws, { headers: {} }, 'user-1');
  await ws._emit(
    'message',
    Buffer.from(
      JSON.stringify({ type: 'session_start', sessionId, jobState: { certificateType: 'eicr' } })
    )
  );
  const entry = activeSessions.get(sessionId);
  entry.session.toolCallsMode = 'live';
  entry.session.stateSnapshot = {
    circuits: { 3: { circuit_ref: 3 } },
    pending_readings: [],
    observations: [],
    validation_alerts: [],
  };
  return { ws, entry };
}

beforeEach(() => {
  loggerMock.info.mockClear();
  runShadowHarnessSpy.mockClear();
  harnessCalls.length = 0;
  activeSessions.clear();
  sonnetSessionStore.clear();
  wss = initSonnetStream(null, async () => 'key', jest.fn());
});
afterEach(async () => {
  for (const ws of openWs.splice(0)) {
    ws.readyState = 3;
    await ws._emit('close');
  }
  for (const entry of activeSessions.values()) {
    if (entry?.disconnectTimer) clearTimeout(entry.disconnectTimer);
  }
  activeSessions.clear();
  sonnetSessionStore.clear();
});

describe('PLAN-W1 M2d — cross-wrapper veto on an ambiguous capture', () => {
  test('ring self-correction + an IR reading in one breath: no ring write, no IR entry or write, whole utterance to the model', async () => {
    const utterance =
      'ring continuity for circuit 3, lives 0.5, no, lives 0.6; insulation resistance live to earth 200 megaohms';
    const { ws, entry } = await startLiveSession('sess-w1-m2d-xwrapper');
    await ws._emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'transcript',
          text: utterance,
          utterance_id: 'u1',
          regexResults: [],
        })
      )
    );

    const c3 = entry.session.stateSnapshot.circuits[3];
    for (const f of ['ring_r1_ohm', 'ring_rn_ohm', 'ring_r2_ohm', 'ir_live_earth_mohm']) {
      expect(c3[f]).toBeUndefined();
    }
    expect(entry.session.dialogueScriptState?.active ?? false).toBe(false);
    const engineAsks = ws._sent.filter(
      (f) => f.type === 'ask_user_started' && /^srv-/.test(String(f.tool_call_id ?? ''))
    );
    expect(engineAsks).toHaveLength(0);
    expect(
      loggerMock.info.mock.calls.some(([ev]) => ev === 'dialogue_entry_guard_veto_honoured')
    ).toBe(true);
    expect(runShadowHarnessSpy).toHaveBeenCalledTimes(1);
    expect(harnessCalls[0]).toContain(utterance);
  });
});
