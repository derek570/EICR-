/**
 * Plan 00B §B1 — dormant evaluation lifecycle hooks + per-entry teardown
 * arbiter.
 *
 * Two layers under test:
 *   1. The hooks module itself (registration, dormancy, monotonic revisions,
 *      exactly-once quiescence-gated freeze).
 *   2. The REAL sonnet-stream lifecycle driven through `initSonnetStream`
 *      (same fake-ws pattern as sonnet-stream-resume.test.js): evaluation
 *      context attachment at entry creation, byte-for-byte production-vs-
 *      evaluation frame parity, teardown-arbiter races (explicit stop vs
 *      disconnect timeout vs both reconnect message types), and the
 *      non-quiescent stop freezing evidence-INELIGIBLE.
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

const mockSessionStart = jest.fn();
const mockSessionStop = jest.fn(() => ({ totals: { cost: 0 } }));
let mockFlushBuffer = jest.fn(async () => null);
const mockSessionInstances = [];

class FakeEICRExtractionSession {
  constructor(apiKey, sessionId, certType) {
    this.sessionId = sessionId;
    this.certType = certType;
    this.turnCount = 0;
    this.utteranceBuffer = [];
    this.costTracker = {
      toCostUpdate: () => ({ type: 'cost_update', cost: 0 }),
      inFlightBillableInvocationCount: 0,
      usageRevision: 0,
    };
    this.start = mockSessionStart;
    this.stop = mockSessionStop;
    this.flushUtteranceBuffer = (...args) => mockFlushBuffer(...args);
    this.updateJobState = jest.fn();
    this.pause = jest.fn();
    this.resume = jest.fn();
    this.toolCallsMode = 'off';
    this.applyModeChange = jest.fn();
    mockSessionInstances.push(this);
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
const {
  registerEvidenceObserver,
  hasEvidenceObserver,
  getLifecycleLedger,
  recordLifecycleEvent,
  notifySuccessfulFrame,
  freezeEvidenceCompletion,
  readInFlightCounts,
  EVIDENCE_OBSERVER,
  LIFECYCLE_LEDGER,
} = await import('../extraction/plan00-lifecycle-hooks.js');

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

function lastAck(ws) {
  return [...ws._sent].reverse().find((m) => m.type === 'session_ack');
}

const getKey = async () => 'fake-anthropic-key';
const verifyToken = jest.fn();

function makeObserver() {
  return {
    events: [],
    frozen: [],
    onRegistered: jest.fn(),
    onLifecycleEvent(row) {
      this.events.push(row);
    },
    onEvidenceFrozen(frozen) {
      this.frozen.push(frozen);
    },
    buildCandidate: jest.fn((snapshot) => ({
      timestamp: '2026-08-04T00:00:00Z',
      canonical_bytes: JSON.stringify({ boundary: snapshot.boundary }),
      content_hash: 'hash-abc',
      key: `key-${snapshot.sessionId}`,
      checksum: 'crc-1',
    })),
    publish: jest.fn(async () => 'published'),
  };
}

beforeEach(() => {
  mockSessionInstances.length = 0;
  mockSessionStart.mockClear();
  mockSessionStop.mockClear();
  mockFlushBuffer = jest.fn(async () => null);
  activeSessions.clear();
  sonnetSessionStore.clear();
});

afterEach(() => {
  activeSessions.clear();
  sonnetSessionStore.clear();
  jest.useRealTimers();
});

// ── Layer 1: the hooks module ────────────────────────────────────────────────

describe('plan00-lifecycle-hooks module', () => {
  test('registration is exactly-once, non-enumerable, and fires onRegistered', () => {
    const entry = { session: null };
    const observer = makeObserver();
    registerEvidenceObserver(entry, observer);
    expect(hasEvidenceObserver(entry)).toBe(true);
    expect(observer.onRegistered).toHaveBeenCalledWith({ at: 'entry_creation' });
    // Non-enumerable: never serialisable onto a wire frame or log row.
    expect(Object.keys(entry)).toEqual(['session']);
    expect(JSON.stringify(entry)).not.toContain('observer');
    expect(() => registerEvidenceObserver(entry, observer)).toThrow(/already registered/);
  });

  test('dormant path: no ledger means recordLifecycleEvent is a no-op', () => {
    const entry = {};
    expect(() => recordLifecycleEvent(entry, 'successful_frame', { x: 1 })).not.toThrow();
    expect(getLifecycleLedger(entry)).toBeNull();
    expect(
      freezeEvidenceCompletion(entry, { sessionId: 's', boundary: 'session_stopped' })
    ).toBeNull();
  });

  test('revisions are monotonic and sub-records immutable', () => {
    const entry = {};
    const observer = makeObserver();
    registerEvidenceObserver(entry, observer);
    notifySuccessfulFrame(entry, { frame_kind: 'extraction' });
    notifySuccessfulFrame(entry, { frame_kind: 'voice_command_response' });
    const ledger = getLifecycleLedger(entry);
    expect(ledger.revisions.successful_frame).toBe(2);
    expect(ledger.subRecords).toHaveLength(2);
    expect(ledger.subRecords[0].revision).toBe(1);
    expect(ledger.subRecords[1].revision).toBe(2);
    expect(Object.isFrozen(ledger.subRecords[0])).toBe(true);
    expect(observer.events).toHaveLength(2);
  });

  test('quiescent freeze latches candidate + publish promise exactly once', async () => {
    const entry = {
      session: { costTracker: { inFlightBillableInvocationCount: 0, usageRevision: 3 } },
    };
    const observer = makeObserver();
    registerEvidenceObserver(entry, observer);
    const frozen = freezeEvidenceCompletion(entry, {
      sessionId: 's1',
      boundary: 'session_stopped',
    });
    expect(frozen.eligible).toBe(true);
    expect(frozen.reason).toBeNull();
    expect(frozen.candidate.key).toBe('key-s1');
    expect(observer.buildCandidate).toHaveBeenCalledTimes(1);
    const snapshot = observer.buildCandidate.mock.calls[0][0];
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.boundary).toBe('session_stopped');
    await expect(frozen.publishPromise).resolves.toBe('published');
    // Retry reuses the latch — builder and publish never run again.
    const again = freezeEvidenceCompletion(entry, { sessionId: 's1', boundary: 'session_stopped' });
    expect(again).toBe(frozen);
    expect(observer.buildCandidate).toHaveBeenCalledTimes(1);
    expect(observer.publish).toHaveBeenCalledTimes(1);
  });

  test('non-quiescent counts freeze evidence-INELIGIBLE with non_quiescent_at_stop', () => {
    const entry = {
      isExtracting: true,
      session: { costTracker: { inFlightBillableInvocationCount: 1, usageRevision: 9 } },
    };
    const observer = makeObserver();
    registerEvidenceObserver(entry, observer);
    const frozen = freezeEvidenceCompletion(entry, {
      sessionId: 's2',
      boundary: 'session_stopped',
    });
    expect(frozen.eligible).toBe(false);
    expect(frozen.reason).toBe('non_quiescent_at_stop');
    expect(frozen.candidate).toBeNull();
    expect(frozen.publishPromise).toBeNull();
    expect(observer.buildCandidate).not.toHaveBeenCalled();
    expect(frozen.counts.billable_invocations_in_flight).toBe(1);
    expect(frozen.counts.extraction_in_flight).toBe(1);
    // Latched — a duplicate teardown caller sees the same ineligible record.
    expect(freezeEvidenceCompletion(entry, { sessionId: 's2', boundary: 'x' })).toBe(frozen);
  });

  test('a rejecting publish never becomes an unhandled rejection', async () => {
    const entry = {
      session: { costTracker: { inFlightBillableInvocationCount: 0, usageRevision: 0 } },
    };
    const observer = makeObserver();
    observer.publish = jest.fn(async () => {
      throw new Error('S3 down');
    });
    registerEvidenceObserver(entry, observer);
    const frozen = freezeEvidenceCompletion(entry, {
      sessionId: 's3',
      boundary: 'session_stopped',
    });
    expect(frozen.eligible).toBe(true);
    await expect(frozen.publishPromise).rejects.toThrow('S3 down');
  });

  test('readInFlightCounts derives every count from real entry state', () => {
    const entry = {
      isExtracting: true,
      pendingTranscripts: [{}, {}],
      pendingExtractions: [{}],
      addressMirrorOutboxRetryHandle: setTimeout(() => {}, 1000),
      pendingRefinements: new Map([['a', {}]]),
      pendingAsks: { size: 3 },
      session: {
        utteranceBuffer: [{}],
        costTracker: { inFlightBillableInvocationCount: 2, usageRevision: 5 },
      },
    };
    const counts = readInFlightCounts(entry);
    clearTimeout(entry.addressMirrorOutboxRetryHandle);
    expect(counts).toEqual({
      billable_invocations_in_flight: 2,
      extraction_in_flight: 1,
      queued_transcripts: 2,
      buffered_utterances: 1,
      pending_extraction_frames: 1,
      outbox_retry_armed: 1,
      refinements_in_flight: 1,
      pending_asks: 3,
    });
  });
});

// ── Layer 2: real-server lifecycle through initSonnetStream ─────────────────

describe('evaluation context through the REAL sonnet-stream lifecycle', () => {
  test('factory attaches the observer at entry creation, non-enumerably', async () => {
    const observer = makeObserver();
    const wss = initSonnetStream(null, getKey, verifyToken, {
      evaluationContextFactory: () => observer,
    });
    const ws = connect(wss);
    await sendFrame(ws, { type: 'session_start', sessionId: 'sess-eval-1', jobState: {} });
    const entry = activeSessions.get('sess-eval-1');
    expect(entry).toBeDefined();
    expect(hasEvidenceObserver(entry)).toBe(true);
    expect(entry[EVIDENCE_OBSERVER]).toBe(observer);
    // Non-enumerable — no wire frame / JSON log can carry it.
    expect(Object.getOwnPropertyNames(entry)).not.toContain('observer');
    expect(observer.onRegistered).toHaveBeenCalledTimes(1);
  });

  test('byte-for-byte frame parity: evaluation mode changes NOTHING on the wire', async () => {
    // Production shape (no factory).
    const wssProd = initSonnetStream(null, getKey, verifyToken);
    const wsProd = connect(wssProd);
    await sendFrame(wsProd, { type: 'session_start', sessionId: 'sess-parity', jobState: {} });
    await sendFrame(wsProd, { type: 'session_stop', sessionId: 'sess-parity' });
    const prodFrames = wsProd._sent.map((f) => JSON.stringify(f));
    activeSessions.clear();
    sonnetSessionStore.clear();
    mockSessionInstances.length = 0;

    // Evaluation shape (factory registered).
    const wssEval = initSonnetStream(null, getKey, verifyToken, {
      evaluationContextFactory: () => makeObserver(),
    });
    const wsEval = connect(wssEval);
    await sendFrame(wsEval, { type: 'session_start', sessionId: 'sess-parity', jobState: {} });
    await sendFrame(wsEval, { type: 'session_stop', sessionId: 'sess-parity' });
    const evalFrames = wsEval._sent.map((f) => JSON.stringify(f));

    // The rehydrate token is minted per-run; normalise it before comparing.
    const normalise = (frames) =>
      frames.map((f) => f.replace(/"sessionId":"[0-9a-f-]{36}"/g, '"sessionId":"<token>"'));
    expect(normalise(evalFrames)).toEqual(normalise(prodFrames));
  });

  test('explicit stop freezes an ELIGIBLE completion exactly once', async () => {
    const observer = makeObserver();
    const wss = initSonnetStream(null, getKey, verifyToken, {
      evaluationContextFactory: () => observer,
    });
    const ws = connect(wss);
    await sendFrame(ws, { type: 'session_start', sessionId: 'sess-stop-1', jobState: {} });
    await sendFrame(ws, { type: 'session_stop', sessionId: 'sess-stop-1' });
    expect(activeSessions.has('sess-stop-1')).toBe(false);
    expect(observer.frozen).toHaveLength(1);
    expect(observer.frozen[0].eligible).toBe(true);
    expect(observer.frozen[0].boundary).toBe('session_stopped');
    expect(observer.buildCandidate).toHaveBeenCalledTimes(1);
    expect(lastAck(ws).status).toBe('stopped');
  });

  test('a non-quiescent stop freezes evidence-INELIGIBLE without changing session_ack', async () => {
    const observer = makeObserver();
    const wss = initSonnetStream(null, getKey, verifyToken, {
      evaluationContextFactory: () => observer,
    });
    const ws = connect(wss);
    await sendFrame(ws, { type: 'session_start', sessionId: 'sess-stop-2', jobState: {} });
    // A billable scope still open at stop = the session was NOT quiescent.
    const entry = activeSessions.get('sess-stop-2');
    entry.session.costTracker.inFlightBillableInvocationCount = 1;
    await sendFrame(ws, { type: 'session_stop', sessionId: 'sess-stop-2' });
    expect(observer.frozen).toHaveLength(1);
    expect(observer.frozen[0].eligible).toBe(false);
    expect(observer.frozen[0].reason).toBe('non_quiescent_at_stop');
    expect(observer.buildCandidate).not.toHaveBeenCalled();
    // Normal stop behaviour unchanged: ack still sent, entry still deleted.
    expect(lastAck(ws).status).toBe('stopped');
    expect(activeSessions.has('sess-stop-2')).toBe(false);
  });

  test('duplicate stop frames run ONE teardown body', async () => {
    const wss = initSonnetStream(null, getKey, verifyToken);
    const ws = connect(wss);
    await sendFrame(ws, { type: 'session_start', sessionId: 'sess-race-1', jobState: {} });
    // Slow flush so the second stop lands mid-teardown.
    let releaseFlush;
    mockFlushBuffer = jest.fn(
      () =>
        new Promise((resolve) => {
          releaseFlush = () => resolve(null);
        })
    );
    const stop1 = sendFrame(ws, { type: 'session_stop', sessionId: 'sess-race-1' });
    const stop2 = sendFrame(ws, { type: 'session_stop', sessionId: 'sess-race-1' });
    releaseFlush();
    await Promise.all([stop1, stop2]);
    expect(mockSessionStop).toHaveBeenCalledTimes(1);
    expect(mockFlushBuffer).toHaveBeenCalledTimes(1);
    expect(activeSessions.has('sess-race-1')).toBe(false);
    // Exactly one stopped ack reached the wire.
    expect(ws._sent.filter((f) => f.type === 'session_ack' && f.status === 'stopped')).toHaveLength(
      1
    );
  });

  test('disconnect-timeout expiry racing an in-flight stop never runs a second teardown', async () => {
    jest.useFakeTimers();
    const wss = initSonnetStream(null, getKey, verifyToken);
    const ws = connect(wss);
    await sendFrame(ws, { type: 'session_start', sessionId: 'sess-race-2', jobState: {} });
    // Socket closes → 5-minute timer armed on the entry.
    await ws._emit('close');
    expect(activeSessions.get('sess-race-2').disconnectTimer).toBeTruthy();
    // Explicit stop starts first and is mid-flush when the timer fires.
    let releaseFlush;
    mockFlushBuffer = jest.fn(
      () =>
        new Promise((resolve) => {
          releaseFlush = () => resolve(null);
        })
    );
    const stopPromise = sendFrame(ws, { type: 'session_stop', sessionId: 'sess-race-2' });
    jest.advanceTimersByTime(300001);
    releaseFlush();
    await stopPromise;
    expect(mockSessionStop).toHaveBeenCalledTimes(1);
    expect(activeSessions.has('sess-race-2')).toBe(false);
  });

  test('disconnect-timeout teardown itself runs through the arbiter', async () => {
    jest.useFakeTimers();
    const wss = initSonnetStream(null, getKey, verifyToken);
    const ws = connect(wss);
    await sendFrame(ws, { type: 'session_start', sessionId: 'sess-timeout-1', jobState: {} });
    await ws._emit('close');
    jest.advanceTimersByTime(300001);
    // Let the async teardown body run.
    await jest.runOnlyPendingTimersAsync();
    expect(mockSessionStop).toHaveBeenCalledTimes(1);
    expect(activeSessions.has('sess-timeout-1')).toBe(false);
  });

  test('session_start reconnect during teardown awaits, never rebinds, and creates FRESH', async () => {
    const wss = initSonnetStream(null, getKey, verifyToken);
    const ws = connect(wss);
    await sendFrame(ws, { type: 'session_start', sessionId: 'sess-reconnect-1', jobState: {} });
    const dyingEntry = activeSessions.get('sess-reconnect-1');
    const dyingSession = dyingEntry.session;
    let releaseFlush;
    mockFlushBuffer = jest.fn(
      () =>
        new Promise((resolve) => {
          releaseFlush = () => resolve(null);
        })
    );
    const stopPromise = sendFrame(ws, { type: 'session_stop', sessionId: 'sess-reconnect-1' });
    // Reconnect lands mid-teardown on a NEW socket.
    const ws2 = connect(wss);
    const reconnectPromise = sendFrame(ws2, {
      type: 'session_start',
      sessionId: 'sess-reconnect-1',
      jobState: {},
    });
    releaseFlush();
    await Promise.all([stopPromise, reconnectPromise]);
    // The reconnect followed the FRESH-session path: a brand-new session
    // object, never a rebind of the dying entry.
    const fresh = activeSessions.get('sess-reconnect-1');
    expect(fresh).toBeDefined();
    expect(fresh).not.toBe(dyingEntry);
    expect(fresh.session).not.toBe(dyingSession);
    expect(fresh.ws).toBe(ws2);
    expect(lastAck(ws2).status).toBe('started');
    // No mode change / socket rebind touched the dying entry.
    expect(dyingSession.applyModeChange).not.toHaveBeenCalled();
    expect(dyingEntry.ws).toBe(ws);
  });

  test('session_resume rehydrate during teardown awaits and follows the miss path', async () => {
    const wss = initSonnetStream(null, getKey, verifyToken);
    const ws = connect(wss);
    await sendFrame(ws, { type: 'session_start', sessionId: 'sess-resume-1', jobState: {} });
    const token = lastAck(ws).sessionId;
    expect(typeof token).toBe('string');
    let releaseFlush;
    mockFlushBuffer = jest.fn(
      () =>
        new Promise((resolve) => {
          releaseFlush = () => resolve(null);
        })
    );
    const stopPromise = sendFrame(ws, { type: 'session_stop', sessionId: 'sess-resume-1' });
    const ws2 = connect(wss);
    const resumePromise = sendFrame(ws2, { type: 'session_resume', sessionId: token });
    releaseFlush();
    await Promise.all([stopPromise, resumePromise]);
    // Teardown completed first from the resume's point of view: the entry is
    // gone, so the rehydrate answers deterministically with status 'new'.
    expect(lastAck(ws2).status).toBe('new');
    expect(activeSessions.has('sess-resume-1')).toBe(false);
    expect(mockSessionStop).toHaveBeenCalledTimes(1);
  });

  test('successful-frame notifications stay fully dormant without an observer', async () => {
    const wss = initSonnetStream(null, getKey, verifyToken);
    const ws = connect(wss);
    await sendFrame(ws, { type: 'session_start', sessionId: 'sess-dormant-1', jobState: {} });
    const entry = activeSessions.get('sess-dormant-1');
    expect(entry[LIFECYCLE_LEDGER]).toBeUndefined();
    expect(hasEvidenceObserver(entry)).toBe(false);
    await sendFrame(ws, { type: 'session_stop', sessionId: 'sess-dormant-1' });
    // Freeze on a dormant entry returned null (nothing latched anywhere).
    expect(activeSessions.has('sess-dormant-1')).toBe(false);
  });
});
