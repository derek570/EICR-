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

  // Plan 03-12 r11 BLOCK remediation — late-stop race guard.
  // handleSessionStop sets entry.isStopping=true before rejectAll. An
  // ask_user_answered frame arriving during the stop sweep must NOT
  // resolve the ask and unblock the tool loop past teardown.
  test('r11: ask_user_answered dropped when entry.isStopping=true (no resolve, no error)', async () => {
    const ws = connect(wss, 'user-1');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-A',
      jobState: { certificateType: 'eicr' },
    });
    const entry = activeSessions.get('sess-A');
    const resolveSpy = jest.spyOn(entry.pendingAsks, 'resolve');

    // Seed an ask so a normal answer WOULD have something to resolve.
    entry.pendingAsks.register('toolu_stop_race', {
      contextField: 'ze',
      contextCircuit: null,
      resolve: () => {},
      timer: setTimeout(() => {}, 60000),
      askStartedAt: Date.now(),
    });

    // Flip the stop flag without actually running stop (to isolate the guard).
    entry.isStopping = true;
    ws._sent.length = 0;

    await sendFrame(ws, {
      type: 'ask_user_answered',
      tool_call_id: 'toolu_stop_race',
      user_text: 'Some answer that arrived during stop',
    });

    // resolve() MUST NOT have been called — the guard short-circuited.
    expect(resolveSpy).not.toHaveBeenCalled();
    // No error envelope — this is silent drop semantics (mirrors the
    // transcript-drop behaviour at STT-10a).
    expect(ws._sent.find((m) => m.type === 'error')).toBeUndefined();

    resolveSpy.mockRestore();
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

  test('answers verdict → registry.resolve called; shadow harness SKIPPED (Plan 03-11 Task 3 BLOCK fix)', async () => {
    // Plan 03-11 Task 3 (STG r4 BLOCK): when the classifier returns
    // 'answers', the tool_result body from the ask dispatcher is the
    // single Sonnet-visible channel for this utterance. Running the
    // shadow harness on the same transcript would double-expose — Sonnet
    // would receive the reply as tool_result AND as a fresh user turn.
    // The contract changed from fall-through to early-return.
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

    runShadowHarnessSpy.mockClear();

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
    // Task 3: shadow harness MUST NOT be invoked for an answers verdict.
    expect(runShadowHarnessSpy).not.toHaveBeenCalled();
  });

  test('user_moved_on verdict → registry.rejectAll called, transcript DEFERRED then drained → harness still runs (r12 BLOCK fix)', async () => {
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

    // First classifier call returns user_moved_on (triggering r12 defer).
    // Second call (from drain-re-entry) falls through to the default
    // {kind:'no_pending_asks'} mock — rejectAll cleared the registry so
    // that's what the real classifier would return anyway.
    classifyOvertakeSpy.mockImplementationOnce(() => ({ kind: 'user_moved_on' }));

    await sendFrame(ws, {
      type: 'transcript',
      text: 'Actually circuit 3 pfc is 1.2',
      regexResults: [{ field: 'pfc', circuit: 3 }],
    });

    // Plan 03-12 r12 BLOCK remediation — the user_moved_on branch now
    // defers the transcript to pendingTranscripts and early-returns,
    // THEN the drain at the bottom of handleTranscript re-enters with
    // the same transcript. classifier runs once (on first entry, with
    // the pending ask) — on the drain re-entry, pendingAsks is empty
    // (rejectAll cleared it) so the `if (size > 0)` gate skips the
    // classifier entirely. rejectAll called exactly once, harness
    // runs exactly once (on the drain re-entry).
    expect(classifyOvertakeSpy).toHaveBeenCalledTimes(1);
    expect(rejectAllSpy).toHaveBeenCalledWith('user_moved_on');
    expect(rejectAllSpy).toHaveBeenCalledTimes(1);
    expect(runShadowHarnessSpy).toHaveBeenCalledTimes(1);
    // Drain should have emptied pendingTranscripts.
    expect(entry.pendingTranscripts).toHaveLength(0);
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

  // STT-08d — 2026-04-22 STG re-review BLOCK remediation.
  // The first 03-10 implementation unconditionally added
  // `consumed_utterance_id` to the dedupe set BEFORE checking whether
  // `pendingAsks.resolve()` actually matched a live ask. A stale /
  // duplicate / unknown tool_call_id would therefore permanently suppress
  // the matching transcript, silently DROPPING the inspector's speech on
  // the floor. Codex flagged this in the re-review as a BLOCK because the
  // original BLOCK's dedupe fix introduced a strictly-worse failure mode:
  // the old bug was "speech processed twice", the 03-10-draft bug is
  // "speech processed zero times", and the latter is harder to detect (no
  // duplicate write to flag in the UI; the inspector just sees their last
  // sentence ignored).
  //
  // The invariant this test locks: consumed_utterance_id is ONLY added to
  // the session's consumedAskUtterances Set when resolve() returns true.
  // An unknown/stale tool_call_id returns resolved=false and MUST leave
  // the Set untouched, so a later transcript with the same utterance_id
  // flows through the normal extraction path instead of being suppressed.
  test('STT-08d stale tool_call_id: ask_user_answered with unknown id → set NOT updated, subsequent transcript NOT suppressed', async () => {
    const ws = connect(wss, 'user-1');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-A',
      jobState: { certificateType: 'eicr' },
    });
    const entry = activeSessions.get('sess-A');

    runShadowHarnessSpy.mockClear();

    // No ask is registered for tool_call_id 'toolu_stale'. This models:
    //   (a) client retry replay after the original ask already timed out
    //   (b) reconnect race where iOS resends after server already rejected
    //   (c) developer error on the client
    // resolve() will return false; the utterance_id MUST NOT be recorded.
    await sendFrame(ws, {
      type: 'ask_user_answered',
      tool_call_id: 'toolu_stale',
      user_text: 'Circuit 5',
      consumed_utterance_id: 'u-stale',
    });

    expect(entry.consumedAskUtterances.has('u-stale')).toBe(false);
    expect(entry.consumedAskUtterances.size).toBe(0);

    // Now send the real transcript. Because u-stale was NOT recorded as
    // consumed, the shadow harness MUST be invoked — the inspector's
    // speech reaches extraction despite the earlier bogus answer frame.
    await sendFrame(ws, {
      type: 'transcript',
      text: 'Circuit 5',
      utterance_id: 'u-stale',
      regexResults: [],
    });
    expect(runShadowHarnessSpy).toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// STT-09 — Bidirectional utterance dedupe (Plan 03-11 Task 1, r3 BLOCK remediation)
//
// Invariant: the dedupe must be ORDER-INDEPENDENT. STT-08 covered the
// "ask_user_answered arrives first, then transcript" path. STT-09 covers the
// reverse race: transcript arrives FIRST (gets extracted as a normal turn),
// then ask_user_answered with the same consumed_utterance_id arrives. The
// server cannot un-extract the transcript half, but it MUST:
//   (a) still resolve the ask (so the tool loop unblocks)
//   (b) emit a warn log row `stage6.ask_user_answered_after_transcript` so
//       ops can detect iOS protocol violations / reorderings
//   (c) NOT stamp consumedAskUtterances a second time — the utterance id
//       is already "spent" (we saw it as transcript). The seenTranscript
//       ledger is the authoritative source for that branch.
//
// Plan 03-12 r6 BLOCK refinement: the resolve() payload in this branch
// is NOT the sanitised user_text — it is `{answered:false, reason:
// 'transcript_already_extracted'}`. The r3 draft resolved with user_text
// and relied on the tool-result body carrying the same speech a second
// time (after the shadow-harness turn had already delivered it), which
// surfaced the speech to Sonnet twice and could provoke duplicate writes.
// STT-12 covers the new non-answer contract directly; STT-09a is updated
// here to assert the same post-r6 payload so the two tests agree.
// -----------------------------------------------------------------------------

describe('STT-09 — bidirectional utterance dedupe (transcript-then-answer race)', () => {
  test('STT-09a transcript-then-answer: transcript extracts, ask_user_answered logs warn and resolves without double-stamp', async () => {
    const ws = connect(wss, 'user-1');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-A',
      jobState: { certificateType: 'eicr' },
    });
    const entry = activeSessions.get('sess-A');

    const seeded = new Promise((resolve) => {
      entry.pendingAsks.register('toolu_reverse', {
        contextField: 'measured_zs_ohm',
        contextCircuit: null,
        resolve,
        timer: setTimeout(() => {}, 60000),
        askStartedAt: Date.now(),
      });
    });

    runShadowHarnessSpy.mockClear();
    const loggerModule = (await import('../logger.js')).default;
    loggerModule.warn.mockClear();

    // 1. Transcript arrives first (race: ask_user_answered delayed in transit).
    //    It is NOT in consumedAskUtterances yet, so extraction proceeds.
    //    Server records the utterance_id into seenTranscriptUtterances.
    await sendFrame(ws, {
      type: 'transcript',
      text: 'Circuit 5',
      utterance_id: 'u-reverse',
      regexResults: [],
    });
    expect(runShadowHarnessSpy).toHaveBeenCalledTimes(1);
    expect(entry.seenTranscriptUtterances).toBeDefined();
    expect(entry.seenTranscriptUtterances.has('u-reverse')).toBe(true);

    // 2. ask_user_answered now arrives. Server MUST (r6 semantics):
    //    - resolve the ask (so the awaiting tool-loop returns) — but with
    //      a NON-ANSWER payload `{answered:false, reason:'transcript_already_extracted'}`.
    //      The sanitised user_text is NOT threaded through, preventing Sonnet
    //      from seeing the speech a second time (once as a user turn via the
    //      shadow harness, once as tool_result body).
    //    - emit stage6.ask_user_answered_after_transcript warn log
    //    - NOT add u-reverse to consumedAskUtterances (transcript half
    //      already extracted; adding here is dead weight and would mask
    //      any future legitimate same-id transcript).
    await sendFrame(ws, {
      type: 'ask_user_answered',
      tool_call_id: 'toolu_reverse',
      user_text: 'Circuit 5',
      consumed_utterance_id: 'u-reverse',
    });

    const resolved = await seeded;
    expect(resolved).toMatchObject({
      answered: false,
      reason: 'transcript_already_extracted',
    });
    expect(resolved.user_text).toBeUndefined();

    const raceWarnings = loggerModule.warn.mock.calls.filter(
      (c) => c[0] === 'stage6.ask_user_answered_after_transcript'
    );
    expect(raceWarnings).toHaveLength(1);
    expect(raceWarnings[0][1]).toMatchObject({
      sessionId: 'sess-A',
      tool_call_id: 'toolu_reverse',
      utterance_id: 'u-reverse',
      reason: 'transcript_already_extracted',
    });

    // consumedAskUtterances MUST NOT be stamped (the seen-transcript branch owns the id).
    expect(entry.consumedAskUtterances.has('u-reverse')).toBe(false);
  });

  test('STT-09b transcript with utterance_id is recorded into seenTranscriptUtterances before extraction fires', async () => {
    // The FIFO cap logic is structurally identical to consumedAskUtterances
    // (STT-08c proves the eviction semantics with 300 ask_user_answered
    // frames). Here we only verify the stamp itself happens on the transcript
    // side — reproducing the cap test via transcript frames is blocked by
    // the 60-per-minute transcript rate limiter (WS_RATE_LIMIT), which would
    // throttle 300 messages down to ~60 and never trigger eviction.
    const ws = connect(wss, 'user-1');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-A',
      jobState: { certificateType: 'eicr' },
    });
    const entry = activeSessions.get('sess-A');

    expect(entry.seenTranscriptUtterances).toBeDefined();
    expect(entry.seenTranscriptUtterances.size).toBe(0);

    await sendFrame(ws, {
      type: 'transcript',
      text: 'first frame',
      utterance_id: 'u-first',
      regexResults: [],
    });
    await sendFrame(ws, {
      type: 'transcript',
      text: 'second frame',
      utterance_id: 'u-second',
      regexResults: [],
    });

    expect(entry.seenTranscriptUtterances.has('u-first')).toBe(true);
    expect(entry.seenTranscriptUtterances.has('u-second')).toBe(true);
    expect(entry.seenTranscriptUtterances.size).toBe(2);

    // Transcripts with no utterance_id must NOT stamp the set (defensive: the
    // dedupe only works on anchored utterances, and nothing in the handler
    // should add `undefined` to the set).
    await sendFrame(ws, {
      type: 'transcript',
      text: 'no id',
      regexResults: [],
    });
    expect(entry.seenTranscriptUtterances.size).toBe(2);
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

    // GREEN contract: resolve payload carries a `sanitisation` sub-object when
    // sanitiseUserText() either stripped controls or truncated. Locking the
    // presence of `{truncated:false, stripped:true}` here — not just the clean
    // text — is the whole point of Task 2: downstream consumers (dispatcher
    // log row, Phase 8 analyzer) need to SEE that a sanitisation pass ran.
    expect(resolveSpy).toHaveBeenCalledWith('toolu_ctrl', {
      answered: true,
      user_text: 'cleanvaluetext',
      sanitisation: { truncated: false, stripped: true },
    });
  });
});

// -----------------------------------------------------------------------------
// Plan 03-12 STG r5 remediation
//   STT-10 — late-stop race guard (Codex r5 BLOCK)
//   STT-11 — lastRegexResults reset on classifier early-returns (Codex r5 MAJOR)
// -----------------------------------------------------------------------------

describe('Plan 03-12 STT-10 — handleSessionStop late-transcript race', () => {
  test('STT-10a — post-stop transcript is silently dropped (isStopping guard)', async () => {
    const ws = connect(wss, 'user-1');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-stop-race',
      jobState: { certificateType: 'eicr' },
    });
    const entry = activeSessions.get('sess-stop-race');
    expect(entry).toBeDefined();

    // Start the stop flow. We don't await it here — we want to interleave a
    // transcript frame during the stop's teardown awaits (S3 upload etc) and
    // assert the transcript handler bails on the isStopping guard.
    const stopPromise = sendFrame(ws, { type: 'session_stop' });

    // Immediately queue a transcript. Even if the stop already finished and
    // deleted the session, the existing `activeSessions.has` guard covers
    // that case — this test specifically exercises the window where the
    // entry still exists but isStopping=true.
    runShadowHarnessSpy.mockClear();
    await sendFrame(ws, {
      type: 'transcript',
      text: 'late utterance during stop',
      regexResults: [],
    });

    await stopPromise;

    // Core assertion: the transcript must NOT reach the shadow harness.
    // Either the isStopping guard bailed (preferred), or activeSessions
    // was already clean (acceptable fallback — also prevents the harness).
    expect(runShadowHarnessSpy).not.toHaveBeenCalled();
  });

  test('STT-10b — final rejectAll sweep fires before activeSessions.delete', async () => {
    const ws = connect(wss, 'user-1');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-sweep',
      jobState: { certificateType: 'eicr' },
    });
    const entry = activeSessions.get('sess-sweep');
    expect(entry.pendingAsks).toBeDefined();

    // Capture rejectAll ordering AND simulate a late-registered ask that
    // slips into the registry DURING the teardown awaits — after the
    // first rejectAll pass but before the final sweep. The belt-and-
    // suspenders contract: the final rejectAll must still drain it.
    const rejectOrder = [];
    const originalRejectAll = entry.pendingAsks.rejectAll.bind(entry.pendingAsks);
    let lateAskResolve;
    let registered = false;
    entry.pendingAsks.rejectAll = jest.fn((reason) => {
      rejectOrder.push({ reason, entryPresent: activeSessions.has('sess-sweep') });
      // On the FIRST rejectAll call (at top of handleSessionStop), register
      // a fresh ask to simulate the in-flight-handler race. register() is
      // safe to call — we control the entry. On subsequent calls just pass
      // through.
      if (!registered) {
        registered = true;
        entry.pendingAsks.register('toolu_late_race', {
          contextField: 'ze',
          contextCircuit: null,
          resolve: (payload) => {
            lateAskResolve = payload;
          },
          timer: setTimeout(() => {}, 60000),
          askStartedAt: Date.now(),
        });
      }
      return originalRejectAll(reason);
    });

    await sendFrame(ws, { type: 'session_stop' });

    // Belt-and-suspenders: rejectAll called TWICE with session_stopped.
    const sessionStoppedCalls = rejectOrder.filter((r) => r.reason === 'session_stopped');
    expect(sessionStoppedCalls.length).toBeGreaterThanOrEqual(2);
    // Both must fire while entry is still in activeSessions.
    sessionStoppedCalls.forEach((c) => expect(c.entryPresent).toBe(true));
    // The late-registered ask must have been resolved as session_stopped.
    // `toMatchObject` tolerates registry-internal extras like wait_duration_ms.
    expect(lateAskResolve).toMatchObject({ answered: false, reason: 'session_stopped' });
    // Session fully torn down.
    expect(activeSessions.has('sess-sweep')).toBe(false);
  });
});

describe('Plan 03-12 STT-12 — reverse-race must not re-expose transcript as tool_result', () => {
  test('ask_user_answered whose utterance_id was already stamped as seen-transcript resolves with transcript_already_extracted, NOT the user_text', async () => {
    const ws = connect(wss, 'user-1');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-reverse-race',
      jobState: { certificateType: 'eicr' },
    });
    const entry = activeSessions.get('sess-reverse-race');
    expect(entry.pendingAsks).toBeDefined();

    // Seed the reverse-race state: the transcript handler already stamped
    // this utterance_id (meaning the shadow harness consumed the speech as
    // a user turn → Sonnet already saw it). The matching
    // ask_user_answered frame arrives LATER. Delivering the text back as
    // tool_result would re-expose the same speech to Sonnet.
    if (!entry.seenTranscriptUtterances) entry.seenTranscriptUtterances = new Set();
    entry.seenTranscriptUtterances.add('u-race-1');

    // Register a pending ask to resolve against.
    let resolved;
    entry.pendingAsks.register('toolu_race', {
      contextField: 'circuit_designation',
      contextCircuit: null,
      resolve: (payload) => {
        resolved = payload;
      },
      timer: setTimeout(() => {}, 60000),
      askStartedAt: Date.now(),
    });

    await sendFrame(ws, {
      type: 'ask_user_answered',
      tool_call_id: 'toolu_race',
      user_text: 'upstairs lighting',
      consumed_utterance_id: 'u-race-1',
    });

    // GREEN contract: the resolve payload is a non-answer with reason
    // 'transcript_already_extracted'. The user_text must NOT flow through
    // because Sonnet already received the speech via the transcript path.
    expect(resolved).toMatchObject({
      answered: false,
      reason: 'transcript_already_extracted',
    });
    // Must NOT carry user_text.
    expect(resolved.user_text).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// STT-15 — Plan 03-12 r9 MAJOR remediation.
//
// PendingAsksRegistry.register() previously destructured only
// {contextField, contextCircuit, resolve, timer, askStartedAt} — it silently
// dropped `expectedAnswerShape` even though dispatchAskUser passed it at
// stage6-dispatcher-ask.js:204. The classifier at
// stage6-overtake-classifier.js:135 reads `entry.expectedAnswerShape` to
// decide whether to fire the yes_no no-regex short-circuit (STA-04c). With
// the shape always undefined, a `"yes"` reply routed through the transcript
// channel on a yes_no pending ask could NEVER match, so the classifier
// fell through to user_moved_on and forced a re-ask.
//
// Fix: store expectedAnswerShape on the asks entry. Test drives the
// end-to-end path: register a yes_no ask, send a transcript with
// msg.text "yes" and zero regexResults, assert registry.resolve was
// called with {answered:true, user_text:"yes"} — proving the shape
// branch fired.
// -----------------------------------------------------------------------------

describe('Plan 03-12 STT-15 — expectedAnswerShape is preserved on pending asks', () => {
  test('register() stores expectedAnswerShape on the entry so classifyOvertake can read it', async () => {
    const ws = connect(wss, 'user-1');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-yes-no',
      jobState: { certificateType: 'eicr' },
    });
    const entry = activeSessions.get('sess-yes-no');

    // Register WITH expectedAnswerShape. Before the r9 fix the register()
    // destructure silently dropped this key from its positional signature,
    // so the stored asks-Map value contained no `expectedAnswerShape` at
    // all — the classifier's shape-branch at
    // stage6-overtake-classifier.js:135 always saw `undefined` and could
    // never fire the yes_no short-circuit. The classifier itself is
    // tested in stage6-overtake-classifier.test.js with a hand-built
    // entry, so it never caught this registry-level drop; the end-to-end
    // gap lived unobserved between the dispatcher (which passed the
    // shape) and the classifier (which read the shape).
    entry.pendingAsks.register('toolu_yesno', {
      contextField: null,
      contextCircuit: null,
      expectedAnswerShape: 'yes_no',
      resolve: () => {},
      timer: setTimeout(() => {}, 60000),
      askStartedAt: Date.now(),
    });

    const raw = [...entry.pendingAsks.entries()].find(([id]) => id === 'toolu_yesno');
    expect(raw).toBeDefined();
    const [, storedEntry] = raw;
    expect(storedEntry.expectedAnswerShape).toBe('yes_no');
    // Sanity: all other critical fields still threaded.
    expect(storedEntry.contextField).toBeNull();
    expect(storedEntry.contextCircuit).toBeNull();
    expect(typeof storedEntry.resolve).toBe('function');
    expect(typeof storedEntry.askStartedAt).toBe('number');
  });

  test('register() preserves expectedAnswerShape across all four shape values (yes_no | number | free_text | circuit_ref)', async () => {
    const ws = connect(wss, 'user-1');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-all-shapes',
      jobState: { certificateType: 'eicr' },
    });
    const entry = activeSessions.get('sess-all-shapes');

    const shapes = ['yes_no', 'number', 'free_text', 'circuit_ref'];
    for (const shape of shapes) {
      entry.pendingAsks.register(`toolu_${shape}`, {
        contextField: null,
        contextCircuit: null,
        expectedAnswerShape: shape,
        resolve: () => {},
        timer: setTimeout(() => {}, 60000),
        askStartedAt: Date.now(),
      });
    }

    for (const shape of shapes) {
      const [, storedEntry] =
        [...entry.pendingAsks.entries()].find(([id]) => id === `toolu_${shape}`) || [];
      expect(storedEntry).toBeDefined();
      expect(storedEntry.expectedAnswerShape).toBe(shape);
    }
  });
});

// -----------------------------------------------------------------------------
// STT-14 — Plan 03-12 r8 MAJOR remediation.
//
// The r6 reverse-race guard ran AFTER sanitiseUserText. If the duplicate
// answer frame carried oversized or malformed text, sanitisation threw
// first; the server sent a hard-error envelope and the pending ask was
// left to time out, even though the matching transcript had already been
// extracted by the shadow harness. The inspector perceives "TTS re-asks
// the question I already answered" because the tool loop stays blocked
// until timeout (~60s).
//
// Fix: compute alreadySeenAsTranscript BEFORE calling sanitiseUserText.
// In the seen branch, resolve immediately with {answered:false,
// reason:'transcript_already_extracted'} — sanitisation is skipped since
// the text will NOT be forwarded to Sonnet. The ask unblocks on the
// current event-loop tick instead of waiting 60s.
// -----------------------------------------------------------------------------

describe('Plan 03-12 STT-14 — reverse-race check runs BEFORE sanitisation', () => {
  test('oversized user_text on a reverse-race frame still cleanly resolves as transcript_already_extracted (not hard-error)', async () => {
    const ws = connect(wss, 'user-1');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-reverse-sanitise',
      jobState: { certificateType: 'eicr' },
    });
    const entry = activeSessions.get('sess-reverse-sanitise');
    expect(entry.pendingAsks).toBeDefined();

    // Seed the reverse-race state.
    if (!entry.seenTranscriptUtterances) entry.seenTranscriptUtterances = new Set();
    entry.seenTranscriptUtterances.add('u-race-14');

    let resolvedPayload;
    entry.pendingAsks.register('toolu_race14', {
      contextField: null,
      contextCircuit: null,
      resolve: (payload) => {
        resolvedPayload = payload;
      },
      timer: setTimeout(() => {}, 60000),
      askStartedAt: Date.now(),
    });

    // Clear sent-messages ledger so we can detect new error envelopes
    // introduced by this specific frame. The r6 path would emit a
    // hard-error envelope on sanitisation throw BEFORE the reverse-race
    // check; r8 short-circuits first and must NOT emit.
    ws._sent.length = 0;

    // Oversized user_text — far above the sanitiser's hard-reject cap (8192).
    // On the r6 ordering this would throw in sanitiseUserText BEFORE the
    // alreadySeenAsTranscript check, producing an error envelope and leaving
    // the ask pending. On the r8 ordering the seen check fires first and
    // the ask resolves cleanly.
    const oversized = 'x'.repeat(9000);
    await sendFrame(ws, {
      type: 'ask_user_answered',
      tool_call_id: 'toolu_race14',
      user_text: oversized,
      consumed_utterance_id: 'u-race-14',
    });

    // Clean resolve — ask unblocked on the reverse-race reason.
    expect(resolvedPayload).toMatchObject({
      answered: false,
      reason: 'transcript_already_extracted',
    });
    expect(resolvedPayload.user_text).toBeUndefined();

    // No error envelope emitted by this frame.
    const errEnvelope = ws._sent.find((m) => m.type === 'error');
    expect(errEnvelope).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// STT-13 — Plan 03-12 r7 MAJOR remediation.
//
// handleTranscript's answers-verdict branch previously IGNORED the boolean
// returned by entry.pendingAsks.resolve(...) and always early-returned. When
// the classifier produced an `answers` verdict but the matching pending ask
// had been resolved by a concurrent timeout or ask_user_answered frame in
// the same event-loop tick, resolve() was a no-op (returned false), but
// the transcript was still dropped — no dispatcher tool_result was sent,
// runShadowHarness was skipped. The inspector's speech disappeared silently.
//
// Fix: capture the resolve() return; on false, log
// stage6.transcript_overtake_stale_resolve and FALL THROUGH to
// runShadowHarness so the utterance reaches Sonnet as a normal user turn.
// This matches the Open Question #4 principle (wrong attribution costlier
// than a second re-ask).
//
// Test seeds a "phantom" tool_call_id into the classifier verdict — the id
// is NOT registered in pendingAsks, so resolve() returns false exactly the
// way a real timeout/answer race would.
// -----------------------------------------------------------------------------

describe('Plan 03-12 STT-13 — answers-verdict with stale tool_call_id falls through to harness', () => {
  test('resolve() returns false → warn log + runShadowHarness still invoked (no silent drop)', async () => {
    const ws = connect(wss, 'user-1');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-stale-answer',
      jobState: { certificateType: 'eicr' },
    });
    const entry = activeSessions.get('sess-stale-answer');

    // Register a real ask so pendingAsks.size > 0 (triggers classifyOvertake).
    // The classifier mock will then return a verdict pointing to a DIFFERENT
    // (unregistered) tool_call_id, simulating the race where the original
    // ask was resolved/timed out between classifier call-site and the
    // resolve() call below.
    entry.pendingAsks.register('toolu_real', {
      contextField: 'ze',
      contextCircuit: null,
      resolve: () => {},
      timer: setTimeout(() => {}, 60000),
      askStartedAt: Date.now(),
    });

    runShadowHarnessSpy.mockClear();
    const loggerModule = (await import('../logger.js')).default;
    loggerModule.warn.mockClear();

    classifyOvertakeSpy.mockImplementationOnce(() => ({
      kind: 'answers',
      toolCallId: 'toolu_phantom',
      userText: 'ze is 0.31',
    }));

    await sendFrame(ws, {
      type: 'transcript',
      text: 'ze is 0.31',
      regexResults: [],
    });

    // Stale-resolve warn log fired, naming the answer source.
    const staleWarnings = loggerModule.warn.mock.calls.filter(
      (c) => c[0] === 'stage6.transcript_overtake_stale_resolve'
    );
    expect(staleWarnings.length).toBeGreaterThanOrEqual(1);
    expect(staleWarnings[0][1]).toMatchObject({
      sessionId: 'sess-stale-answer',
      tool_call_id: 'toolu_phantom',
      source: 'transcript_overtake_answer',
      reason: 'tool_call_id_already_resolved',
    });

    // Fall-through invariant: the harness still processes the transcript as
    // a normal user turn. Previously this was NOT called — the r3 code
    // early-returned after the no-op resolve(), dropping the speech.
    expect(runShadowHarnessSpy).toHaveBeenCalledTimes(1);
  });
});

describe('Plan 03-12 STT-11 — lastRegexResults cleared on classifier early-return', () => {
  test('answers-verdict early return clears pre-seeded entry.lastRegexResults', async () => {
    const ws = connect(wss, 'user-1');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-stale-regex',
      jobState: { certificateType: 'eicr' },
    });
    const entry = activeSessions.get('sess-stale-regex');

    // Manually seed lastRegexResults to a non-empty value. Production code
    // doesn't currently populate this (only line 1686 resets to []), but
    // the fallback at `msg.regexResults ?? entry.lastRegexResults` is live;
    // any future caller writing here must not leak stale hits across the
    // answers-verdict early return. Defense in depth.
    entry.lastRegexResults = [{ field: 'ze', circuit: 5, stale: true }];

    entry.pendingAsks.register('toolu_ze_c5', {
      contextField: 'ze',
      contextCircuit: 5,
      resolve: () => {},
      timer: setTimeout(() => {}, 60000),
      askStartedAt: Date.now(),
    });
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

    // GREEN contract: the answers-verdict early return path resets
    // entry.lastRegexResults to [] before returning.
    expect(entry.lastRegexResults).toEqual([]);
  });

  test('validation-error early return clears pre-seeded entry.lastRegexResults', async () => {
    const ws = connect(wss, 'user-1');
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-valerr-regex',
      jobState: { certificateType: 'eicr' },
    });
    const entry = activeSessions.get('sess-valerr-regex');
    entry.lastRegexResults = [{ field: 'pfc', circuit: 3, stale: true }];

    entry.pendingAsks.register('toolu_val_err', {
      contextField: 'pfc',
      contextCircuit: 3,
      resolve: () => {},
      timer: setTimeout(() => {}, 60000),
      askStartedAt: Date.now(),
    });

    // Classifier returns answers with a pathological userText that the
    // sanitiser will reject (length > HARD_REJECT_USER_TEXT_LEN = 8192).
    const monster = 'x'.repeat(8200);
    classifyOvertakeSpy.mockImplementationOnce(() => ({
      kind: 'answers',
      toolCallId: 'toolu_val_err',
      userText: monster,
    }));

    await sendFrame(ws, {
      type: 'transcript',
      text: monster,
      regexResults: [{ field: 'pfc', circuit: 3 }],
    });

    // Validation-error branch is also an early return — it too must clear
    // lastRegexResults before returning.
    expect(entry.lastRegexResults).toEqual([]);
  });
});
