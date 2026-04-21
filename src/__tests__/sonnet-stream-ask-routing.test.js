/**
 * Stage 6 Phase 3 Plan 03-08 — sonnet-stream.js per-session PendingAsksRegistry
 * wiring tests.
 *
 * WHAT THIS FILE COVERS
 *   Group A — handleSessionStart pendingAsks lifecycle
 *     1. New session_start creates a registry instance on the activeSessions entry.
 *     2. Reconnect session_start calls rejectAll('session_reconnected') BEFORE
 *        rebinding ws. Seeded ask is resolved with reason 'session_reconnected'.
 *
 *   Group B — inbound `ask_user_answered` switch case
 *     3. Valid payload → registry.resolve called with {answered:true, user_text}.
 *     4. Unknown tool_call_id → registry.resolve returns false; no error emitted.
 *     5. Invalid payload (missing tool_call_id) → error envelope; registry untouched.
 *     6. Invalid payload (non-string user_text) → same error envelope.
 *
 *   Group C — termination paths call rejectAll
 *     7. handleSessionStop → rejectAll('session_stopped') BEFORE session_ack emit
 *        AND BEFORE activeSessions.delete.
 *     8. ws.on('close') 5-min timer fires → rejectAll('session_terminated')
 *        BEFORE questionGate.destroy() and BEFORE activeSessions.delete.
 *
 *   Group D — handleTranscript overtake wiring
 *     9. Empty registry → classifyOvertake NOT called; runShadowHarness still
 *        invoked with pendingAsks + ws in options.
 *     10. pendingAsks has entry; regex hits same (field, circuit) → classifier
 *        returns 'answers'; registry.resolve fires BEFORE runShadowHarness.
 *     11. pendingAsks has entry; regex hits different context → classifier
 *        returns 'user_moved_on'; registry.rejectAll('user_moved_on') fires
 *        BEFORE runShadowHarness.
 *
 *   Group E — runShadowHarness arg plumbing
 *     12. handleTranscript invokes runShadowHarness with options.pendingAsks ===
 *         entry.pendingAsks (identity) and options.ws === ws.
 *
 * WHY MOCK STRATEGY
 *   sonnet-stream.js is a WS server entrypoint — its handlers are closure-scoped
 *   around `initSonnetStream`. We follow the existing `sonnet-stream-resume.test.js`
 *   pattern: drive a fake ws through `wss.emit('connection', ws, req, userId)` and
 *   capture the closure-bound handlers via the fake's `ws.on` mock. ESM mocks are
 *   registered BEFORE the dynamic import of sonnet-stream.js so classifyOvertake
 *   and runShadowHarness become jest.fn spies.
 *
 * REQUIREMENT: STA-04 (overtake detection).
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

// ── Mocks (must be registered BEFORE dynamic import of sonnet-stream.js) ─────

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
    this.onBatchResult = null;
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

// runShadowHarness spy — captures the options arg so we can assert pendingAsks
// + ws are threaded through identity-preserved. Returns a minimal extraction
// result shape the caller pipes into validateAndCorrectFields + ws.send.
const runShadowHarnessSpy = jest.fn(async () => ({
  extracted_readings: [],
  questions_for_user: [],
  observations: [],
  confirmations: [],
}));

jest.unstable_mockModule('../extraction/stage6-shadow-harness.js', () => ({
  runShadowHarness: runShadowHarnessSpy,
}));

// classifyOvertake spy — default returns no_pending_asks so most tests see a
// passthrough; per-test mockImplementationOnce overrides for the specific
// verdicts we're asserting on.
const classifyOvertakeSpy = jest.fn(() => ({ kind: 'no_pending_asks' }));

jest.unstable_mockModule('../extraction/stage6-overtake-classifier.js', () => ({
  classifyOvertake: classifyOvertakeSpy,
}));

// ── Dynamic import AFTER mocks ────────────────────────────────────────────────

const { initSonnetStream, activeSessions } = await import('../extraction/sonnet-stream.js');
const { sonnetSessionStore } = await import('../extraction/sonnet-session-store.js');

// ── Helpers (pattern lifted from sonnet-stream-resume.test.js) ───────────────

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

// ── Fixtures ─────────────────────────────────────────────────────────────────

const getKey = async () => 'fake-anthropic-key';
const verifyToken = jest.fn();

let wss;
beforeEach(() => {
  mockSessionStart.mockClear();
  mockSessionStop.mockClear();
  mockFlushBuffer.mockClear();
  runShadowHarnessSpy.mockClear();
  classifyOvertakeSpy.mockClear();
  classifyOvertakeSpy.mockImplementation(() => ({ kind: 'no_pending_asks' }));
  runShadowHarnessSpy.mockImplementation(async () => ({
    extracted_readings: [],
    questions_for_user: [],
    observations: [],
    confirmations: [],
  }));
  activeSessions.clear();
  sonnetSessionStore.clear();
  wss = initSonnetStream(null, getKey, verifyToken);
});

afterEach(() => {
  activeSessions.clear();
  sonnetSessionStore.clear();
  jest.useRealTimers();
});

// -----------------------------------------------------------------------------
// Group A — handleSessionStart pendingAsks lifecycle
// -----------------------------------------------------------------------------

describe('Group A — handleSessionStart creates + cleans per-session registry', () => {
  test('new session_start instantiates pendingAsks on activeSessions entry', async () => {
    const ws = connect(wss, 'user-1');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-A',
      jobId: 'job-1',
      jobState: { certificateType: 'eicr' },
    });
    const entry = activeSessions.get('sess-A');
    expect(entry).toBeDefined();
    expect(entry.pendingAsks).toBeDefined();
    // Registry surface — minimum contract the consumers rely on.
    expect(typeof entry.pendingAsks.register).toBe('function');
    expect(typeof entry.pendingAsks.resolve).toBe('function');
    expect(typeof entry.pendingAsks.rejectAll).toBe('function');
    expect(typeof entry.pendingAsks.size).toBe('number');
    expect(entry.pendingAsks.size).toBe(0);
  });

  test('reconnect path rejectAlls seeded asks with reason=session_reconnected', async () => {
    const wsA = connect(wss, 'user-1');
    await sendFrame(wsA, {
      type: 'session_start',
      sessionId: 'sess-A',
      jobState: { certificateType: 'eicr' },
    });
    const entry = activeSessions.get('sess-A');
    expect(entry.pendingAsks).toBeDefined();

    // Seed a pending ask as if the ask dispatcher had already registered one.
    const seeded = new Promise((resolve) => {
      entry.pendingAsks.register('toolu_seed', {
        contextField: 'ze',
        contextCircuit: null,
        resolve,
        timer: setTimeout(() => {}, 60000),
        askStartedAt: Date.now(),
      });
    });
    expect(entry.pendingAsks.size).toBe(1);

    // Reconnect on a fresh socket with the same sessionId — triggers
    // handleSessionStart's activeSessions.has branch.
    const wsB = connect(wss, 'user-1');
    await sendFrame(wsB, {
      type: 'session_start',
      sessionId: 'sess-A',
      jobState: { certificateType: 'eicr' },
    });

    // Seeded Promise resolved with session_reconnected outcome.
    await expect(seeded).resolves.toMatchObject({
      answered: false,
      reason: 'session_reconnected',
    });
    // Registry drained.
    expect(activeSessions.get('sess-A').pendingAsks.size).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// Group B — ask_user_answered inbound switch case
// -----------------------------------------------------------------------------

describe('Group B — inbound ask_user_answered routing', () => {
  test('valid payload resolves the registry entry with {answered:true, user_text}', async () => {
    const ws = connect(wss, 'user-1');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-A',
      jobState: { certificateType: 'eicr' },
    });
    const entry = activeSessions.get('sess-A');
    expect(entry.pendingAsks).toBeDefined();
    const resolveSpy = jest.spyOn(entry.pendingAsks, 'resolve');
    // Seed an ask so resolve has something to find.
    const seeded = new Promise((resolve) => {
      entry.pendingAsks.register('toolu_1', {
        contextField: 'ze',
        contextCircuit: null,
        resolve,
        timer: setTimeout(() => {}, 60000),
        askStartedAt: Date.now(),
      });
    });

    await sendFrame(ws, {
      type: 'ask_user_answered',
      tool_call_id: 'toolu_1',
      user_text: 'Circuit 5 reads 0.25 ohms',
    });

    expect(resolveSpy).toHaveBeenCalledWith('toolu_1', {
      answered: true,
      user_text: 'Circuit 5 reads 0.25 ohms',
    });
    await expect(seeded).resolves.toMatchObject({
      answered: true,
      user_text: 'Circuit 5 reads 0.25 ohms',
    });
    // No error frame emitted.
    expect(ws._sent.find((m) => m.type === 'error')).toBeUndefined();
  });

  test('unknown tool_call_id is a no-op — no error emitted', async () => {
    const ws = connect(wss, 'user-1');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-A',
      jobState: { certificateType: 'eicr' },
    });

    ws._sent.length = 0; // drop session_ack before assertions

    await sendFrame(ws, {
      type: 'ask_user_answered',
      tool_call_id: 'toolu_unknown',
      user_text: 'whatever',
    });

    expect(ws._sent.find((m) => m.type === 'error')).toBeUndefined();
  });

  test('invalid payload (missing tool_call_id) emits error envelope; registry untouched', async () => {
    const ws = connect(wss, 'user-1');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-A',
      jobState: { certificateType: 'eicr' },
    });
    const entry = activeSessions.get('sess-A');
    expect(entry.pendingAsks).toBeDefined();
    const resolveSpy = jest.spyOn(entry.pendingAsks, 'resolve');
    ws._sent.length = 0;

    await sendFrame(ws, {
      type: 'ask_user_answered',
      user_text: 'only the user_text',
    });

    const err = ws._sent.find((m) => m.type === 'error');
    expect(err).toBeDefined();
    expect(err.message).toMatch(/ask_user_answered requires/);
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  test('invalid payload (non-string user_text) emits error envelope; registry untouched', async () => {
    const ws = connect(wss, 'user-1');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-A',
      jobState: { certificateType: 'eicr' },
    });
    const entry = activeSessions.get('sess-A');
    expect(entry.pendingAsks).toBeDefined();
    const resolveSpy = jest.spyOn(entry.pendingAsks, 'resolve');
    ws._sent.length = 0;

    await sendFrame(ws, {
      type: 'ask_user_answered',
      tool_call_id: 'toolu_1',
      user_text: 42,
    });

    const err = ws._sent.find((m) => m.type === 'error');
    expect(err).toBeDefined();
    expect(err.message).toMatch(/ask_user_answered requires/);
    expect(resolveSpy).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// Group C — termination paths call rejectAll in strict order
// -----------------------------------------------------------------------------

describe('Group C — termination paths rejectAll', () => {
  test('handleSessionStop rejectAlls with session_stopped BEFORE activeSessions.delete', async () => {
    const ws = connect(wss, 'user-1');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-A',
      jobState: { certificateType: 'eicr' },
    });
    const entry = activeSessions.get('sess-A');
    expect(entry.pendingAsks).toBeDefined();

    // Install a trap that captures the rejectAll-vs-delete ordering.
    const ordering = [];
    const originalRejectAll = entry.pendingAsks.rejectAll.bind(entry.pendingAsks);
    entry.pendingAsks.rejectAll = jest.fn((reason) => {
      ordering.push({ step: 'rejectAll', reason, entryPresent: activeSessions.has('sess-A') });
      return originalRejectAll(reason);
    });

    // Seed an ask so rejectAll has observable effect.
    const seeded = new Promise((resolve) => {
      entry.pendingAsks.register('toolu_stop', {
        contextField: 'ze',
        contextCircuit: null,
        resolve,
        timer: setTimeout(() => {}, 60000),
        askStartedAt: Date.now(),
      });
    });

    await sendFrame(ws, { type: 'session_stop' });

    expect(entry.pendingAsks.rejectAll).toHaveBeenCalledWith('session_stopped');
    // At the moment rejectAll fired the activeSessions entry must still exist
    // (STG #3: rejectAll precedes delete).
    expect(ordering[0]).toEqual({
      step: 'rejectAll',
      reason: 'session_stopped',
      entryPresent: true,
    });
    // After stop, entry removed.
    expect(activeSessions.has('sess-A')).toBe(false);
    await expect(seeded).resolves.toMatchObject({
      answered: false,
      reason: 'session_stopped',
    });
  });

  test("ws.on('close') 5-min timer rejectAlls with session_terminated BEFORE delete", async () => {
    jest.useFakeTimers();
    const ws = connect(wss, 'user-1');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-A',
      jobState: { certificateType: 'eicr' },
    });
    const entry = activeSessions.get('sess-A');
    expect(entry.pendingAsks).toBeDefined();

    const ordering = [];
    const originalRejectAll = entry.pendingAsks.rejectAll.bind(entry.pendingAsks);
    entry.pendingAsks.rejectAll = jest.fn((reason) => {
      ordering.push({ step: 'rejectAll', reason, entryPresent: activeSessions.has('sess-A') });
      return originalRejectAll(reason);
    });
    const destroySpy = jest.spyOn(entry.questionGate, 'destroy');

    const seeded = new Promise((resolve) => {
      entry.pendingAsks.register('toolu_close', {
        contextField: 'ze',
        contextCircuit: null,
        resolve,
        timer: setTimeout(() => {}, 120000),
        askStartedAt: Date.now(),
      });
    });

    // Fire the close handler → installs the 5-min timer.
    await ws._emit('close');
    // Advance past 300s.
    jest.advanceTimersByTime(300001);

    expect(entry.pendingAsks.rejectAll).toHaveBeenCalledWith('session_terminated');
    expect(ordering[0]).toEqual({
      step: 'rejectAll',
      reason: 'session_terminated',
      entryPresent: true,
    });
    // Ordering: rejectAll → questionGate.destroy → activeSessions.delete.
    expect(entry.pendingAsks.rejectAll.mock.invocationCallOrder[0]).toBeLessThan(
      destroySpy.mock.invocationCallOrder[0]
    );
    expect(activeSessions.has('sess-A')).toBe(false);
    jest.useRealTimers();
    await expect(seeded).resolves.toMatchObject({
      answered: false,
      reason: 'session_terminated',
    });
  });
});

// -----------------------------------------------------------------------------
// Group D — handleTranscript overtake wiring
// -----------------------------------------------------------------------------

describe('Group D — handleTranscript invokes classifyOvertake only when asks pending', () => {
  test('empty registry → classifyOvertake NOT called; runShadowHarness still receives pendingAsks + ws', async () => {
    const ws = connect(wss, 'user-1');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-A',
      jobState: { certificateType: 'eicr' },
    });

    await sendFrame(ws, {
      type: 'transcript',
      text: 'Circuit 1 ze is 0.25',
      regexResults: [{ field: 'ze', circuit: 1 }],
    });

    expect(classifyOvertakeSpy).not.toHaveBeenCalled();
    expect(runShadowHarnessSpy).toHaveBeenCalled();
    const lastCall = runShadowHarnessSpy.mock.calls.at(-1);
    const options = lastCall[3];
    expect(options.pendingAsks).toBe(activeSessions.get('sess-A').pendingAsks);
    expect(options.ws).toBe(ws);
  });

  test('answers verdict → registry.resolve called, harness still runs', async () => {
    const ws = connect(wss, 'user-1');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-A',
      jobState: { certificateType: 'eicr' },
    });
    const entry = activeSessions.get('sess-A');
    expect(entry.pendingAsks).toBeDefined();

    // Pre-seed registry so classifier's precondition (size > 0) holds.
    entry.pendingAsks.register('toolu_ze_c5', {
      contextField: 'ze',
      contextCircuit: 5,
      resolve: () => {},
      timer: setTimeout(() => {}, 60000),
      askStartedAt: Date.now(),
    });
    const resolveSpy = jest.spyOn(entry.pendingAsks, 'resolve');

    classifyOvertakeSpy.mockImplementationOnce(() => ({
      kind: 'answers',
      toolCallId: 'toolu_ze_c5',
      userText: 'Circuit 5 ze is 0.25',
    }));

    await sendFrame(ws, {
      type: 'transcript',
      text: 'Circuit 5 ze is 0.25',
      regexResults: [{ field: 'ze', circuit: 5 }],
    });

    expect(classifyOvertakeSpy).toHaveBeenCalledTimes(1);
    expect(resolveSpy).toHaveBeenCalledWith('toolu_ze_c5', {
      answered: true,
      user_text: 'Circuit 5 ze is 0.25',
    });
    // Shadow harness STILL invoked (fall-through semantics).
    expect(runShadowHarnessSpy).toHaveBeenCalled();
  });

  test('user_moved_on verdict → registry.rejectAll called, harness still runs', async () => {
    const ws = connect(wss, 'user-1');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-A',
      jobState: { certificateType: 'eicr' },
    });
    const entry = activeSessions.get('sess-A');
    expect(entry.pendingAsks).toBeDefined();

    entry.pendingAsks.register('toolu_ze_c5', {
      contextField: 'ze',
      contextCircuit: 5,
      resolve: () => {},
      timer: setTimeout(() => {}, 60000),
      askStartedAt: Date.now(),
    });
    const rejectAllSpy = jest.spyOn(entry.pendingAsks, 'rejectAll');

    classifyOvertakeSpy.mockImplementationOnce(() => ({ kind: 'user_moved_on' }));

    await sendFrame(ws, {
      type: 'transcript',
      text: 'Actually circuit 3 pfc is 1.2',
      regexResults: [{ field: 'pfc', circuit: 3 }],
    });

    expect(classifyOvertakeSpy).toHaveBeenCalledTimes(1);
    expect(rejectAllSpy).toHaveBeenCalledWith('user_moved_on');
    expect(runShadowHarnessSpy).toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// Group E — runShadowHarness arg plumbing (identity check)
// -----------------------------------------------------------------------------

describe('Group E — runShadowHarness receives identity-preserved pendingAsks + ws', () => {
  test('options.pendingAsks identical to entry.pendingAsks, options.ws identical to live ws', async () => {
    const ws = connect(wss, 'user-1');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-A',
      jobState: { certificateType: 'eicr' },
    });
    const entry = activeSessions.get('sess-A');

    await sendFrame(ws, {
      type: 'transcript',
      text: 'sample utterance',
      regexResults: [],
    });

    expect(runShadowHarnessSpy).toHaveBeenCalled();
    const options = runShadowHarnessSpy.mock.calls.at(-1)[3];
    expect(options.pendingAsks).toBe(entry.pendingAsks);
    expect(options.ws).toBe(ws);
  });
});

// -----------------------------------------------------------------------------
// STT-08 — Utterance-consumption dedupe (Plan 03-10 Task 1, BLOCK remediation)
//
// Invariant: the utterance iOS routed as an answer to a pending ask MUST NOT
// ALSO flow through handleTranscript as a normal user-turn transcript. Without
// server-side dedupe, the same speech would be extracted twice — once via the
// ask flow (tool_result body) and once via the normal extraction path. The
// anchoring must be server-enforced, not iOS-trust-based, because iOS could
// buffer the transcript and the ask_user_answered independently and the
// network could reorder / duplicate frames during reconnects.
// -----------------------------------------------------------------------------

describe('STT-08 — utterance-consumption dedupe on ask_user_answered', () => {
  test('STT-08a double-frame: ask_user_answered with consumed_utterance_id then transcript with same id → transcript suppressed', async () => {
    const ws = connect(wss, 'user-1');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-A',
      jobState: { certificateType: 'eicr' },
    });
    const entry = activeSessions.get('sess-A');

    // Seed an ask so ask_user_answered has a real entry to resolve (the
    // registry is strict — resolve() returns false on unknown ids).
    entry.pendingAsks.register('toolu_dedupe', {
      contextField: 'measured_zs_ohm',
      contextCircuit: null,
      resolve: () => {},
      timer: setTimeout(() => {}, 60000),
      askStartedAt: Date.now(),
    });

    runShadowHarnessSpy.mockClear();

    // 1. iOS routes the utterance as an ask answer, carrying its utterance id.
    await sendFrame(ws, {
      type: 'ask_user_answered',
      tool_call_id: 'toolu_dedupe',
      user_text: 'Circuit 5',
      consumed_utterance_id: 'u-1',
    });

    // 2. The SAME Deepgram utterance then arrives as a transcript — iOS's
    // Deepgram routing is not always strictly ordered and we might get the
    // final transcript frame after the ask_user_answered frame. Server MUST
    // detect the double and suppress extraction.
    await sendFrame(ws, {
      type: 'transcript',
      text: 'Circuit 5',
      utterance_id: 'u-1',
      regexResults: [],
    });

    // Shadow harness must NOT have been invoked for the suppressed transcript.
    expect(runShadowHarnessSpy).not.toHaveBeenCalled();

    // Suppression log row emitted.
    const loggerModule = (await import('../logger.js')).default;
    const suppressed = loggerModule.info.mock.calls.filter(
      (c) => c[0] === 'stage6.transcript_suppressed'
    );
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0][1]).toMatchObject({
      sessionId: 'sess-A',
      utterance_id: 'u-1',
      reason: 'answered_ask',
    });
  });

  test('STT-08b legacy compat: ask_user_answered without consumed_utterance_id → ask still resolves, warning logged, subsequent transcript NOT suppressed', async () => {
    const ws = connect(wss, 'user-1');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-A',
      jobState: { certificateType: 'eicr' },
    });
    const entry = activeSessions.get('sess-A');

    const seeded = new Promise((resolve) => {
      entry.pendingAsks.register('toolu_legacy', {
        contextField: 'ze',
        contextCircuit: null,
        resolve,
        timer: setTimeout(() => {}, 60000),
        askStartedAt: Date.now(),
      });
    });

    runShadowHarnessSpy.mockClear();
    const loggerModule = (await import('../logger.js')).default;
    loggerModule.warn.mockClear();

    // Legacy iOS: no consumed_utterance_id — ask still resolves.
    await sendFrame(ws, {
      type: 'ask_user_answered',
      tool_call_id: 'toolu_legacy',
      user_text: 'whatever',
    });
    await expect(seeded).resolves.toMatchObject({
      answered: true,
      user_text: 'whatever',
    });

    // Warning log row flagging the missing field.
    const untrackedWarnings = loggerModule.warn.mock.calls.filter(
      (c) => c[0] === 'stage6.ask_user_answered_untracked'
    );
    expect(untrackedWarnings).toHaveLength(1);

    // A subsequent transcript with some utterance_id is NOT suppressed — the
    // dedupe can't fire for an answer that never registered an id.
    await sendFrame(ws, {
      type: 'transcript',
      text: 'another sentence',
      utterance_id: 'u-unrelated',
      regexResults: [],
    });
    expect(runShadowHarnessSpy).toHaveBeenCalled();
  });

  test('STT-08c FIFO bound: 300 asks with distinct utterance_ids → set size capped at 256, oldest evict FIFO', async () => {
    const ws = connect(wss, 'user-1');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-A',
      jobState: { certificateType: 'eicr' },
    });
    const entry = activeSessions.get('sess-A');

    // Register 300 distinct asks and answer each with a unique utterance_id.
    // FIFO cap must hold at 256 — oldest IDs evict as new ones arrive.
    for (let i = 0; i < 300; i += 1) {
      const id = `toolu_${i}`;
      entry.pendingAsks.register(id, {
        contextField: null,
        contextCircuit: null,
        resolve: () => {},
        timer: setTimeout(() => {}, 60000),
        askStartedAt: Date.now(),
      });
      // eslint-disable-next-line no-await-in-loop
      await sendFrame(ws, {
        type: 'ask_user_answered',
        tool_call_id: id,
        user_text: 'x',
        consumed_utterance_id: `u-${i}`,
      });
    }

    // Set exposed on the activeSessions entry (Plan 03-10 Task 1).
    expect(entry.consumedAskUtterances).toBeDefined();
    expect(entry.consumedAskUtterances.size).toBeLessThanOrEqual(256);

    // Oldest IDs (0..43) must have evicted; newest IDs (44..299) retained.
    expect(entry.consumedAskUtterances.has('u-0')).toBe(false);
    expect(entry.consumedAskUtterances.has('u-43')).toBe(false);
    expect(entry.consumedAskUtterances.has('u-44')).toBe(true);
    expect(entry.consumedAskUtterances.has('u-299')).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Task 2 (MAJOR remediation) — user_text sanitisation on ask_user_answered
//
// Invariant: user_text is untrusted input that flows into BOTH CloudWatch logs
// (stage6.ask_user row) AND the Anthropic tool_result content. It MUST be
// bounded (length cap) and scrubbed (C0 controls stripped) before either
// consumption. Deliberately-abusive sizes (>8192 chars) are rejected outright
// with an error envelope; merely-long user_text is silently truncated with a
// log flag so legitimate paste-from-notes answers aren't dropped.
// -----------------------------------------------------------------------------

describe('user_text sanitisation on ask_user_answered (Plan 03-10 Task 2)', () => {
  test('normal user_text (< 2048) passes through unchanged to registry.resolve', async () => {
    const ws = connect(wss, 'user-1');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-A',
      jobState: { certificateType: 'eicr' },
    });
    const entry = activeSessions.get('sess-A');
    const resolveSpy = jest.spyOn(entry.pendingAsks, 'resolve');
    entry.pendingAsks.register('toolu_normal', {
      contextField: 'ze',
      contextCircuit: null,
      resolve: () => {},
      timer: setTimeout(() => {}, 60000),
      askStartedAt: Date.now(),
    });

    await sendFrame(ws, {
      type: 'ask_user_answered',
      tool_call_id: 'toolu_normal',
      user_text: 'clean answer',
      consumed_utterance_id: 'u-clean',
    });

    expect(resolveSpy).toHaveBeenCalledWith('toolu_normal', {
      answered: true,
      user_text: 'clean answer',
    });
  });

  test('oversized (>2048, <=8192) user_text is truncated before reaching registry + log carries sanitisation flag', async () => {
    const ws = connect(wss, 'user-1');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-A',
      jobState: { certificateType: 'eicr' },
    });
    const entry = activeSessions.get('sess-A');
    const resolveSpy = jest.spyOn(entry.pendingAsks, 'resolve');
    entry.pendingAsks.register('toolu_long', {
      contextField: 'ze',
      contextCircuit: null,
      resolve: () => {},
      timer: setTimeout(() => {}, 60000),
      askStartedAt: Date.now(),
    });

    const longText = 'a'.repeat(3000);
    await sendFrame(ws, {
      type: 'ask_user_answered',
      tool_call_id: 'toolu_long',
      user_text: longText,
      consumed_utterance_id: 'u-long',
    });

    const resolveCall = resolveSpy.mock.calls.find((c) => c[0] === 'toolu_long');
    expect(resolveCall).toBeDefined();
    expect(resolveCall[1].user_text.length).toBe(2048);
    expect(resolveCall[1].user_text).toBe('a'.repeat(2048));
  });

  test('>8192 user_text is rejected: error envelope, registry.resolve NOT called, set NOT stamped', async () => {
    const ws = connect(wss, 'user-1');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-A',
      jobState: { certificateType: 'eicr' },
    });
    const entry = activeSessions.get('sess-A');
    const resolveSpy = jest.spyOn(entry.pendingAsks, 'resolve');
    ws._sent.length = 0;

    const abusiveText = 'x'.repeat(8193);
    await sendFrame(ws, {
      type: 'ask_user_answered',
      tool_call_id: 'toolu_abusive',
      user_text: abusiveText,
      consumed_utterance_id: 'u-abusive',
    });

    const err = ws._sent.find((m) => m.type === 'error');
    expect(err).toBeDefined();
    expect(err.message).toMatch(/user_text_too_long/);
    expect(resolveSpy).not.toHaveBeenCalled();
    // Set must NOT have been stamped — we rejected before the mark-consumed step.
    expect(entry.consumedAskUtterances.has('u-abusive')).toBe(false);
  });

  test('control characters in user_text are stripped before reaching registry', async () => {
    const ws = connect(wss, 'user-1');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-A',
      jobState: { certificateType: 'eicr' },
    });
    const entry = activeSessions.get('sess-A');
    const resolveSpy = jest.spyOn(entry.pendingAsks, 'resolve');
    entry.pendingAsks.register('toolu_ctrl', {
      contextField: 'ze',
      contextCircuit: null,
      resolve: () => {},
      timer: setTimeout(() => {}, 60000),
      askStartedAt: Date.now(),
    });

    await sendFrame(ws, {
      type: 'ask_user_answered',
      tool_call_id: 'toolu_ctrl',
      user_text: 'clean\x00value\x01text',
      consumed_utterance_id: 'u-ctrl',
    });

    expect(resolveSpy).toHaveBeenCalledWith('toolu_ctrl', {
      answered: true,
      user_text: 'cleanvaluetext',
    });
  });
});
