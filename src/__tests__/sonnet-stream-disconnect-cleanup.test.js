/**
 * Disconnect-timer cleanup tests — pin the contract that when the
 * 5-minute reconnect window expires after a WS close, the session's
 * stop() runs (and therefore its cache-keepalive timer chain stops)
 * before activeSessions.delete().
 *
 * Regression: prod session sess_moxffh2j_82f8 (2026-05-08 21:28 UTC)
 * showed "Session timed out, cleaning up" at 21:34:06 followed by
 * three more "Cache keepalive sent" logs at 21:36:12 / 21:40:13 /
 * 21:44:15. The disconnect timer was deleting the entry without
 * calling session.stop(), so the EICRExtractionSession's keepalive
 * setTimeout chain (eicr-extraction-session.js:1373) kept rescheduling
 * itself forever — each fire holding a closure-strong reference to
 * the session and its full prompt + state snapshot.
 *
 * Test strategy: drive a session_start, fire `ws.close`, advance fake
 * timers by 300_000 ms (the disconnect window), assert mockSessionStop
 * was called. The pre-fix sonnet-stream would call activeSessions.delete
 * but never invoke session.stop, so this test fails on the previous
 * commit.
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
    this.isActive = false;
    this.costTracker = { toCostUpdate: () => ({ type: 'cost_update', cost: 0 }) };
    this.start = (...args) => {
      this.isActive = true;
      mockSessionStart(...args);
    };
    this.stop = (...args) => {
      this.isActive = false;
      return mockSessionStop(...args);
    };
    this.flushUtteranceBuffer = mockFlushBuffer;
    this.updateJobState = jest.fn();
    this.pause = jest.fn();
    this.resume = jest.fn();
    this.toolCallsMode = 'off';
    this.applyModeChange = jest.fn();
  }
}

jest.unstable_mockModule('../extraction/eicr-extraction-session.js', () => ({
  EICRExtractionSession: FakeEICRExtractionSession,
}));

jest.unstable_mockModule('../logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.unstable_mockModule('../storage.js', () => ({
  uploadJson: jest.fn(async () => {}),
}));

const { initSonnetStream, activeSessions } = await import('../extraction/sonnet-stream.js');
const { sonnetSessionStore } = await import('../extraction/sonnet-session-store.js');

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

const getKey = async () => 'fake-anthropic-key';
const verifyToken = jest.fn();

let wss;

beforeEach(() => {
  jest.useFakeTimers();
  mockSessionStart.mockClear();
  mockSessionStop.mockClear();
  mockFlushBuffer.mockClear();
  activeSessions.clear();
  sonnetSessionStore.clear();
  wss = initSonnetStream(null, getKey, verifyToken);
});

afterEach(() => {
  activeSessions.clear();
  sonnetSessionStore.clear();
  jest.useRealTimers();
});

describe('disconnect-timer cleanup stops the EICRExtractionSession', () => {
  test('after WS close + 5-min idle, session.stop() runs before activeSessions.delete', async () => {
    const ws = connect(wss);
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'client-A',
      jobId: 'job-1',
      jobState: { certificateType: 'eicr' },
    });

    // Confirm the entry is registered and stop hasn't been called yet.
    expect(mockSessionStart).toHaveBeenCalledTimes(1);
    expect(mockSessionStop).not.toHaveBeenCalled();
    expect(activeSessions.size).toBe(1);

    // Drop the socket — registers the 5-minute disconnect timer.
    await ws._emit('close');

    // Mid-window: the entry is still alive (a reconnect could land
    // here) and stop() has NOT been called yet.
    jest.advanceTimersByTime(60_000);
    expect(mockSessionStop).not.toHaveBeenCalled();
    expect(activeSessions.size).toBe(1);

    // Past the 5-minute boundary: cleanup runs. Both stop AND delete
    // must have happened — without stop the keepalive chain would
    // keep firing (the production leak we're regressing against).
    jest.advanceTimersByTime(241_000);
    expect(mockSessionStop).toHaveBeenCalledTimes(1);
    expect(activeSessions.size).toBe(0);
  });

  test('reconnect within the 5-minute window cancels the disconnect timer (stop is NOT called)', async () => {
    const wsA = connect(wss);
    await sendFrame(wsA, {
      type: 'session_start',
      sessionId: 'client-A',
      jobId: 'job-1',
      jobState: { certificateType: 'eicr' },
    });
    await wsA._emit('close');

    // Fire a session_resume on a fresh socket BEFORE the disconnect
    // timer expires. The rehydrate path must clear the timer so
    // session.stop() does NOT run on the still-live session.
    const ack = wsA._sent.find((m) => m.type === 'session_ack');
    const minted = ack?.sessionId;
    expect(typeof minted).toBe('string');

    jest.advanceTimersByTime(60_000);

    const wsB = connect(wss);
    await sendFrame(wsB, { type: 'session_resume', sessionId: minted });

    // Advance well past where the original disconnect timer would
    // have fired — if rehydrate didn't clear it, stop would fire here.
    jest.advanceTimersByTime(360_000);
    expect(mockSessionStop).not.toHaveBeenCalled();
  });
});
