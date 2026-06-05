/**
 * Wave 4c.5 — Sonnet `session_resume` rehydrate handler tests.
 *
 * These tests exercise the WS protocol surface of `sonnet-stream.js` without
 * standing up a real WebSocket: `WebSocketServer({ noServer: true })` is
 * driven through its `emit('connection', ws, req, userId)` channel with a
 * fake `ws` object that captures `.send()` payloads. The EICRExtractionSession
 * + Anthropic SDK are mocked so no network is attempted.
 *
 * Protocol under test (see WAVE_4C5_BACKEND_HANDOFF.md §2):
 *   - session_ack now carries a server-minted `sessionId` on `status: 'started'`
 *   - session_resume { sessionId } rehydrates if TTL-valid + user-matched
 *   - session_resume after TTL returns status: 'new' (client re-issues session_start)
 *   - session_resume with a wrong user's sessionId is indistinguishable from an unknown token
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

// ── Mocks ────────────────────────────────────────────────────────────────────
// EICRExtractionSession is the core multi-turn session. We replace it with a
// stub so no Anthropic HTTP calls leak out. Only the methods the stream
// handler actually calls on `session_start` / `session_stop` are stubbed.

const mockSessionStart = jest.fn();
const mockSessionStop = jest.fn(() => ({ totals: { cost: 0 } }));
const mockFlushBuffer = jest.fn(async () => null);
const mockSessionInstances = [];

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
    // Plan 06-08 r7-#1 — sonnet-stream.js's reconnect/resume paths
    // call `session.applyModeChange(...)` (the SOLE write surface
    // for mid-session mode flips). The fake mirrors a no-op
    // implementation here because this test file's surface
    // (resume rehydrate happy-path) doesn't assert mode behaviour;
    // the real method's contract is covered in
    // `eicr-extraction-session-apply-mode-change.test.js` and the
    // integration-through-sonnet-stream surface in Group H of
    // `sonnet-stream-protocol-version-handshake.test.js`.
    this.toolCallsMode = 'off';
    this.applyModeChange = jest.fn((newMode) => {
      const valid = newMode === 'off' || newMode === 'shadow' || newMode === 'live';
      this.toolCallsMode = valid ? newMode : 'off';
    });
    mockSessionInstances.push(this);
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

// ── Module under test (dynamic import after mocks) ──────────────────────────

const { initSonnetStream, activeSessions } = await import('../extraction/sonnet-stream.js');
const { sonnetSessionStore } = await import('../extraction/sonnet-session-store.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeFakeWs() {
  const sent = [];
  const ws = {
    readyState: 1, // OPEN
    OPEN: 1,
    send: jest.fn((payload) => {
      sent.push(JSON.parse(payload));
    }),
    ping: jest.fn(),
    close: jest.fn(),
    on: jest.fn(),
    _handlers: new Map(),
  };
  // Capture the on('message'/'close') handler so we can drive the fake socket.
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

function lastAck(ws) {
  return [...ws._sent].reverse().find((m) => m.type === 'session_ack');
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const getKey = async () => 'fake-anthropic-key';
const verifyToken = jest.fn();

let wss;
beforeEach(() => {
  mockSessionInstances.length = 0;
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
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('session_ack carries server-minted sessionId on start', () => {
  test('session_start reply includes a string sessionId', async () => {
    const ws = connect(wss, 'user-1');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'client-session-A',
      jobId: 'job-1',
      jobState: { certificateType: 'eicr' },
    });
    const ack = lastAck(ws);
    expect(ack).toMatchObject({ type: 'session_ack', status: 'started' });
    expect(typeof ack.sessionId).toBe('string');
    expect(ack.sessionId.length).toBeGreaterThan(0);
    // Not the client-supplied id — this is the server-minted rehydration token.
    expect(ack.sessionId).not.toBe('client-session-A');
  });

  test('minted sessionId is stored and resumable', async () => {
    const ws = connect(wss, 'user-1');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'client-session-A',
      jobId: 'job-1',
      jobState: { certificateType: 'eicr' },
    });
    const minted = lastAck(ws).sessionId;
    const payload = sonnetSessionStore.resume(minted, 'user-1');
    expect(payload).not.toBeNull();
    expect(payload.clientSessionId).toBe('client-session-A');
  });
});

describe('session_resume within TTL rehydrates', () => {
  test('resume returns status=resumed and echoes the sessionId', async () => {
    const wsA = connect(wss, 'user-1');
    await sendFrame(wsA, {
      type: 'session_start',
      sessionId: 'client-session-A',
      jobId: 'job-1',
      jobState: { certificateType: 'eicr' },
    });
    const minted = lastAck(wsA).sessionId;

    // Simulate a dropped socket + reconnect on a fresh ws. We don't fire
    // the `close` event here to avoid the 5-min disconnectTimer race —
    // the rehydrate path is expected to cancel it if present.
    const wsB = connect(wss, 'user-1');
    await sendFrame(wsB, { type: 'session_resume', sessionId: minted });

    const ack = lastAck(wsB);
    expect(ack).toMatchObject({
      type: 'session_ack',
      status: 'resumed',
      sessionId: minted,
    });
  });

  test('rehydrated session accepts subsequent frames on the new socket', async () => {
    const wsA = connect(wss, 'user-1');
    await sendFrame(wsA, {
      type: 'session_start',
      sessionId: 'client-session-A',
      jobId: 'job-1',
      jobState: { certificateType: 'eicr' },
    });
    const minted = lastAck(wsA).sessionId;

    const wsB = connect(wss, 'user-1');
    await sendFrame(wsB, { type: 'session_resume', sessionId: minted });

    // A session_pause on wsB should now land on the rehydrated entry
    // (proving currentSessionId was rewired to the original clientSessionId).
    await sendFrame(wsB, { type: 'session_pause' });
    const pauseAck = [...wsB._sent].reverse().find((m) => m.status === 'paused');
    expect(pauseAck).toBeDefined();
  });
});

describe('session_resume after TTL returns a fresh ack', () => {
  test('resume on an expired token returns status=new', async () => {
    // We can't easily fast-forward the real sonnetSessionStore's TTL (it's a
    // module-scoped shared instance). Instead we explicitly wipe the store —
    // same observable effect as TTL expiry.
    const wsA = connect(wss, 'user-1');
    await sendFrame(wsA, {
      type: 'session_start',
      sessionId: 'client-session-A',
      jobId: 'job-1',
      jobState: { certificateType: 'eicr' },
    });
    const minted = lastAck(wsA).sessionId;

    sonnetSessionStore.clear();
    activeSessions.clear();

    const wsB = connect(wss, 'user-1');
    await sendFrame(wsB, { type: 'session_resume', sessionId: minted });

    const ack = lastAck(wsB);
    expect(ack).toMatchObject({ type: 'session_ack', status: 'new' });
    // No minted token on a miss — client must re-issue session_start.
    expect(ack.sessionId).toBeNull();
  });
});

describe('session_resume with wrong user is rejected (security)', () => {
  test('a different user cannot rehydrate another user session', async () => {
    const wsA = connect(wss, 'user-1');
    await sendFrame(wsA, {
      type: 'session_start',
      sessionId: 'client-session-A',
      jobId: 'job-1',
      jobState: { certificateType: 'eicr' },
    });
    const minted = lastAck(wsA).sessionId;

    // Different user connects and tries the same token.
    const wsAttacker = connect(wss, 'user-attacker');
    await sendFrame(wsAttacker, { type: 'session_resume', sessionId: minted });

    const ack = lastAck(wsAttacker);
    expect(ack).toMatchObject({ type: 'session_ack', status: 'new' });
    expect(ack.sessionId).toBeNull();
  });

  test('a wrong-user attempt invalidates the token — legit owner cannot rehydrate either', async () => {
    const wsA = connect(wss, 'user-1');
    await sendFrame(wsA, {
      type: 'session_start',
      sessionId: 'client-session-A',
      jobId: 'job-1',
      jobState: { certificateType: 'eicr' },
    });
    const minted = lastAck(wsA).sessionId;

    const wsAttacker = connect(wss, 'user-attacker');
    await sendFrame(wsAttacker, { type: 'session_resume', sessionId: minted });

    // Legit owner reconnects — token has been blown by the attacker probe.
    const wsB = connect(wss, 'user-1');
    await sendFrame(wsB, { type: 'session_resume', sessionId: minted });

    expect(lastAck(wsB)).toMatchObject({ status: 'new', sessionId: null });
  });
});

describe('session_resume with unknown sessionId returns fresh ack', () => {
  test('unknown id → status=new', async () => {
    const ws = connect(wss, 'user-1');
    await sendFrame(ws, { type: 'session_resume', sessionId: 'never-minted' });

    const ack = lastAck(ws);
    expect(ack).toMatchObject({ type: 'session_ack', status: 'new' });
    expect(ack.sessionId).toBeNull();
  });
});

describe('legacy session_resume (sleep/wake) is untouched', () => {
  test('session_resume without sessionId wakes the paused session as before', async () => {
    const ws = connect(wss, 'user-1');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'client-session-A',
      jobId: 'job-1',
      jobState: { certificateType: 'eicr' },
    });
    await sendFrame(ws, { type: 'session_pause' });
    await sendFrame(ws, { type: 'session_resume' }); // no sessionId → legacy path

    const resumeAck = [...ws._sent].reverse().find((m) => m.status === 'resumed');
    expect(resumeAck).toBeDefined();
    // Legacy frame emits status:'resumed' with NO sessionId field (additive
    // field only populated on the Wave 4c.5 rehydrate path).
    expect(resumeAck.sessionId).toBeUndefined();
  });
});

describe('session_stop invalidates the rehydration token', () => {
  test('a stopped session cannot be rehydrated', async () => {
    const wsA = connect(wss, 'user-1');
    await sendFrame(wsA, {
      type: 'session_start',
      sessionId: 'client-session-A',
      jobId: 'job-1',
      jobState: { certificateType: 'eicr' },
    });
    const minted = lastAck(wsA).sessionId;

    await sendFrame(wsA, { type: 'session_stop' });

    const wsB = connect(wss, 'user-1');
    await sendFrame(wsB, { type: 'session_resume', sessionId: minted });
    expect(lastAck(wsB)).toMatchObject({ status: 'new', sessionId: null });
  });
});
