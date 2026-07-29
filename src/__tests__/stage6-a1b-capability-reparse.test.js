/**
 * Plan A1b (2026-07-29) — the capability-reparse invariants behind the
 * live-read fence.
 *
 * The mid-session capability DOWNGRADE is pinned STRUCTURALLY IMPOSSIBLE
 * under the current wire (refine round 10), and these tests are the pins:
 *
 *  1. WEB immutability — `session_resume` carries only sessionId +
 *     protocol_version and the rehydrate handler performs NO capability
 *     re-parse: a capabilities block smuggled onto a resume frame changes
 *     NOTHING on the entry. A session's capability set is immutable on web
 *     by construction.
 *
 *  2. iOS same-session `session_start` re-parse — the ONLY capability
 *     mutation path. The `stage6.capability_changed_on_reparse` TRIPWIRE
 *     fires whenever a re-parse CHANGES any capability (zero expected
 *     occurrences in production — same build ⇒ same static advert), and
 *     stays silent on a same-capability re-parse.
 *
 * Harness: the sonnet-stream-resume.test.js noServer WebSocketServer
 * pattern — fake ws driven through emit('connection'), mocked session/SDK.
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

const mockSessionStart = jest.fn();
const mockSessionStop = jest.fn(() => ({ totals: { cost: 0 } }));
const mockFlushBuffer = jest.fn(async () => null);

class FakeEICRExtractionSession {
  constructor(apiKey, sessionId, certType) {
    this.sessionId = sessionId;
    this.certType = certType;
    this.turnCount = 0;
    this.costTracker = { toCostUpdate: () => ({ type: 'cost_update', cost: 0 }) };
    this.start = mockSessionStart;
    this.stop = mockSessionStop;
    this.flushUtteranceBuffer = mockFlushBuffer;
    this.updateJobState = jest.fn();
    this.pause = jest.fn();
    this.resume = jest.fn();
    this.toolCallsMode = 'off';
    this.applyModeChange = jest.fn((newMode) => {
      const valid = newMode === 'off' || newMode === 'shadow' || newMode === 'live';
      this.toolCallsMode = valid ? newMode : 'off';
    });
  }
}

jest.unstable_mockModule('../extraction/eicr-extraction-session.js', () => ({
  EICRExtractionSession: FakeEICRExtractionSession,
}));

jest.unstable_mockModule('../logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('../storage.js', () => ({
  uploadJson: jest.fn(async () => {}),
}));

const { initSonnetStream, activeSessions } = await import('../extraction/sonnet-stream.js');
const { sonnetSessionStore } = await import('../extraction/sonnet-session-store.js');
const { default: mockLogger } = await import('../logger.js');

function makeFakeWs() {
  const sent = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: jest.fn((payload) => {
      sent.push(JSON.parse(payload));
    }),
    ping: jest.fn(),
    close: jest.fn(),
    on: jest.fn(),
    _handlers: new Map(),
  };
  ws.on.mockImplementation((event, handler) => {
    ws._handlers.set(event, handler);
  });
  ws._sent = sent;
  ws._emit = async (event, data) => {
    const h = ws._handlers.get(event);
    if (!h) throw new Error(`No handler registered for ${event}`);
    await h(data);
  };
  return ws;
}

function connect(wss, userId = 'user-1') {
  const ws = makeFakeWs();
  wss.emit('connection', ws, { headers: {} }, userId);
  return ws;
}

async function sendFrame(ws, frame) {
  await ws._emit('message', Buffer.from(JSON.stringify(frame)));
}

const CAPS_BOARD_CLEAR = { voice_latency: { version: 1, supports: ['board_clear_v1'] } };
const CAPS_EMPTY = { voice_latency: { version: 1, supports: [] } };

const getKey = async () => 'fake-anthropic-key';
const verifyToken = jest.fn();

let wss;
beforeEach(() => {
  jest.clearAllMocks();
  activeSessions.clear();
  sonnetSessionStore.clear();
  wss = initSonnetStream(null, getKey, verifyToken);
});

afterEach(() => {
  activeSessions.clear();
  sonnetSessionStore.clear();
});

function tripwireCalls() {
  return mockLogger.info.mock.calls.filter(
    ([event]) => event === 'stage6.capability_changed_on_reparse'
  );
}

async function startSession(ws, sessionId, capabilities) {
  await sendFrame(ws, {
    type: 'session_start',
    sessionId,
    jobId: 'job-1',
    jobState: { certificateType: 'eicr' },
    capabilities,
  });
}

describe('web immutability pin — session_resume performs NO capability re-parse', () => {
  test('a capabilities block on a session_resume frame changes NOTHING on the entry', async () => {
    const wsA = connect(wss, 'user-1');
    await startSession(wsA, 'client-session-A', CAPS_BOARD_CLEAR);
    const entry = activeSessions.get('client-session-A');
    expect(entry.voiceLatency.capabilities.hasBoardClearV1).toBe(true);
    const capsRefBefore = entry.voiceLatency.capabilities;

    const minted = [...wsA._sent].reverse().find((m) => m.type === 'session_ack').sessionId;

    // Web resume — deliberately smuggling a DIFFERENT capabilities block on
    // the frame. The rehydrate handler must ignore it entirely.
    const wsB = connect(wss, 'user-1');
    await sendFrame(wsB, {
      type: 'session_resume',
      sessionId: minted,
      protocol_version: 1,
      capabilities: CAPS_EMPTY,
    });

    expect(entry.voiceLatency.capabilities).toBe(capsRefBefore); // same OBJECT — no re-parse ran
    expect(entry.voiceLatency.capabilities.hasBoardClearV1).toBe(true);
    expect(tripwireCalls()).toHaveLength(0);
  });
});

describe('iOS same-session session_start re-parse — the tripwire', () => {
  test('same-capability re-parse (the only production shape) → capabilities re-parsed, tripwire SILENT', async () => {
    const wsA = connect(wss, 'user-1');
    await startSession(wsA, 'client-session-A', CAPS_BOARD_CLEAR);
    const entry = activeSessions.get('client-session-A');
    expect(entry.voiceLatency.capabilities.hasBoardClearV1).toBe(true);

    // Reconnect: same client sessionId, same static advert (same build).
    const wsB = connect(wss, 'user-1');
    await startSession(wsB, 'client-session-A', CAPS_BOARD_CLEAR);

    expect(entry.voiceLatency.capabilities.hasBoardClearV1).toBe(true);
    expect(tripwireCalls()).toHaveLength(0);
  });

  test('a synthetic capability CHANGE on re-parse → tripwire fires once with the flag diff (impossible-scenario visibility)', async () => {
    const wsA = connect(wss, 'user-1');
    await startSession(wsA, 'client-session-A', CAPS_BOARD_CLEAR);
    const entry = activeSessions.get('client-session-A');

    const wsB = connect(wss, 'user-1');
    await startSession(wsB, 'client-session-A', CAPS_EMPTY);

    // Deny-first re-parse still applies (A1a contract preserved)…
    expect(entry.voiceLatency.capabilities.hasBoardClearV1).toBe(false);
    // …and the impossible event is now VISIBLE, never silent.
    const calls = tripwireCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][1].changed).toEqual(
      expect.arrayContaining([{ flag: 'hasBoardClearV1', from: true, to: false }])
    );
  });
});
