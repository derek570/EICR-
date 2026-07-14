/**
 * §A4 (field-feedback-2026-07-14, F8) — sonnet-stream pending-value ask
 * routing integration tests.
 *
 * WHAT THIS FILE COVERS — the plan's round-11/12/13 regressions, driven at
 * the WS-frame level (fake ws → wss.emit('connection') → sendFrame), same
 * harness pattern as sonnet-stream-ask-routing.test.js:
 *
 *   (1) round-11 — PRE-QUEUE answer consumption. A blocking ask is exactly
 *       when entry.isExtracting is true (the tool loop is suspended awaiting
 *       the answer), so pre-A4 a transcript-only reply queued in
 *       pendingTranscripts and never reached classifyOvertake until the ask
 *       timed out (the F8 beep-then-silence). Now: a field-name reply to a
 *       'none'+pendingValue+free_text ask resolves the ask BEFORE the queue
 *       and is CONSUMED (never queued, no extra turn).
 *   (2) round-12 — ASYMMETRIC verdict scoping. An ordinary toolu_* concrete-
 *       field value ask must keep today's behaviour byte-for-byte: a bare-
 *       numeric transcript arriving while blocked is queued and the ask
 *       SURVIVES (the direct ask_user_answered channel stays authoritative).
 *   (3) round-12 evidence-backed movement — a recordable field+value regex
 *       hit while blocked rejectAlls the pending ask pre-queue (user really
 *       moved on) AND the transcript still queues as a fresh turn.
 *   (4) round-8/13 direct-channel guard — an ask_user_answered frame whose
 *       user_text is a structurally complete FRESH reading ("Ze is 0.22")
 *       against a pendingValue-class ask resolves user_moved_on and the text
 *       is re-injected through handleTranscript (reaches the shadow harness
 *       as a normal turn), never consumed as the ask's answer (audio-first
 *       invariant 2: structurally complete readings get WRITTEN).
 *
 * MOCK STRATEGY — deliberately NARROWER than sonnet-stream-ask-routing:
 * classifyOvertake and stage6-pending-value are NOT mocked. The whole point
 * of A4 is the interaction between the REAL classifier branches (pendingValue
 * continuation, pvr-* value asks, round-13 typed-detector guard) and the
 * sonnet-stream pre-queue / STAGE-2-gate call sites; mocking the classifier
 * would reduce these to plumbing tests of hand-scripted verdicts. The
 * extraction session, logger, storage, and shadow harness are mocked exactly
 * as in the ask-routing file.
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

const runShadowHarnessSpy = jest.fn(async () => ({
  extracted_readings: [],
  questions_for_user: [],
  observations: [],
  confirmations: [],
}));

jest.unstable_mockModule('../extraction/stage6-shadow-harness.js', () => ({
  runShadowHarness: runShadowHarnessSpy,
}));

// NOTE: NO mock for stage6-overtake-classifier.js or stage6-pending-value.js —
// the real modules run (see MOCK STRATEGY in the header).

// ── Dynamic import AFTER mocks ────────────────────────────────────────────────

const { initSonnetStream, activeSessions } = await import('../extraction/sonnet-stream.js');
const { sonnetSessionStore } = await import('../extraction/sonnet-session-store.js');

// ── Helpers (pattern lifted from sonnet-stream-ask-routing.test.js) ──────────

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

async function startSession(wss, sessionId) {
  const ws = connect(wss);
  await sendFrame(ws, {
    type: 'session_start',
    sessionId,
    jobState: { certificateType: 'eicr' },
  });
  return { ws, entry: activeSessions.get(sessionId) };
}

// Track every raw ask timer we mint so afterEach can clear the ones a test
// deliberately leaves pending (e.g. the survives-the-transcript ask in (2)).
// Without this, a standalone in-band run keeps node alive on the 60s handle
// and jest prints "did not exit one second after the test run".
const askTimers = [];
function makeAskTimer() {
  const t = setTimeout(() => {}, 60000);
  askTimers.push(t);
  return t;
}

/**
 * The F8 inverted-ask registry entry: value captured at registration
 * (pendingValue), field NAME expected in the answer. Mirrors how
 * stage6-dispatcher-ask registers context_field:"none" asks post-A4.
 */
function registerPendingValueAsk(entry, toolCallId, resolveFn) {
  entry.pendingAsks.register(toolCallId, {
    contextField: 'none',
    contextCircuit: null,
    expectedAnswerShape: 'free_text',
    pendingValue: {
      value: '26',
      unit: 'ms',
      sourceText: 'ICD trip time for circuit 2 is 26 milliseconds.',
      source: 'transcript',
    },
    resolve: resolveFn,
    timer: makeAskTimer(),
    askStartedAt: Date.now(),
  });
}

/** Flush the microtask/macrotask queue until the shadow harness fires (or give up). */
async function flushUntilHarnessCalled(maxTicks = 50) {
  for (let i = 0; i < maxTicks && runShadowHarnessSpy.mock.calls.length === 0; i += 1) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
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
// (1) round-11 — pre-queue answer consumption while blocked
// -----------------------------------------------------------------------------

describe('§A4 (1) — transcript-only reply to a pendingValue ask resolves PRE-QUEUE while isExtracting', () => {
  test('field-name reply consumed by the ask channel: resolve(answered:true) fires, transcript never queued, no extra turn', async () => {
    const { ws, entry } = await startSession(wss, 'sess-pv-1');
    const loggerModule = (await import('../logger.js')).default;
    loggerModule.info.mockClear();

    // Simulate the blocking-ask state: the tool loop is suspended awaiting
    // the answer, so isExtracting is true (production sets this at the top
    // of the turn; the pre-queue block is specified to run EXACTLY here).
    entry.isExtracting = true;

    let resolvedPayload = null;
    registerPendingValueAsk(entry, 'toolu_pv_1', (payload) => {
      resolvedPayload = payload;
    });
    const resolveSpy = jest.spyOn(entry.pendingAsks, 'resolve');
    runShadowHarnessSpy.mockClear();

    // The F8 reply — a FIELD NAME. No digits, no regex hits; the pre-LLM
    // gate forwards it because a pending ask exists.
    await sendFrame(ws, {
      type: 'transcript',
      text: 'RCD trip time.',
      utterance_id: 'u-pv-1',
      regexResults: [],
    });

    // Resolved BEFORE any queueing, with the reply text as the answer.
    expect(resolveSpy).toHaveBeenCalledWith('toolu_pv_1', {
      answered: true,
      user_text: 'RCD trip time.',
    });
    // The awaited dispatcher receives the answer AND the registry-copied
    // pendingValue (the write-or-reask join input).
    expect(resolvedPayload).toMatchObject({
      answered: true,
      user_text: 'RCD trip time.',
      pendingValue: { value: '26', unit: 'ms' },
    });
    expect(entry.pendingAsks.size).toBe(0);

    // CONSUMED by the ask channel: never queued, and no additional turn —
    // the tool loop already owns this utterance via the tool_result body.
    expect(entry.pendingTranscripts).toHaveLength(0);
    expect(runShadowHarnessSpy).not.toHaveBeenCalled();

    // The consumption is stamped so a duplicate frame for the same
    // utterance dedupes, and the decision is observable in CloudWatch.
    expect(entry.seenTranscriptUtterances.has('u-pv-1')).toBe(true);
    const answeredRows = loggerModule.info.mock.calls.filter(
      (c) => c[0] === 'stage6.transcript_pre_queue_answered'
    );
    expect(answeredRows).toHaveLength(1);
    expect(answeredRows[0][1]).toMatchObject({
      sessionId: 'sess-pv-1',
      tool_call_id: 'toolu_pv_1',
    });
  });
});

// -----------------------------------------------------------------------------
// (2) round-12 — ordinary toolu_* value asks keep today's behaviour
// -----------------------------------------------------------------------------

describe('§A4 (2) — ordinary toolu_* concrete-field ask survives a bare-numeric transcript', () => {
  test('bare numeric while blocked: ask SURVIVES, transcript queued as today, nothing resolved/rejected', async () => {
    const { ws, entry } = await startSession(wss, 'sess-pv-2');
    entry.isExtracting = true;

    const userResolve = jest.fn();
    entry.pendingAsks.register('toolu_ordinary_value', {
      contextField: 'measured_zs_ohm',
      contextCircuit: 5,
      expectedAnswerShape: 'number',
      resolve: userResolve,
      timer: setTimeout(() => {}, 60000),
      askStartedAt: Date.now(),
    });
    const resolveSpy = jest.spyOn(entry.pendingAsks, 'resolve');
    const rejectAllSpy = jest.spyOn(entry.pendingAsks, 'rejectAll');
    runShadowHarnessSpy.mockClear();

    // A bare numeric produces no regex hit and no detector-complete reading;
    // classifyOvertake's conservative default (user_moved_on) has NO
    // evidence backing, so the pre-queue block must fall through to the
    // queue UNCHANGED — the direct ask_user_answered channel stays the
    // authoritative route for non-brokered number asks.
    await sendFrame(ws, {
      type: 'transcript',
      text: '0.25',
      utterance_id: 'u-pv-2',
      regexResults: [],
    });

    expect(resolveSpy).not.toHaveBeenCalled();
    expect(rejectAllSpy).not.toHaveBeenCalled();
    expect(userResolve).not.toHaveBeenCalled();
    expect(entry.pendingAsks.size).toBe(1); // ask survives
    expect(entry.pendingTranscripts).toHaveLength(1); // queued as today
    expect(entry.pendingTranscripts[0].text).toBe('0.25');
    expect(runShadowHarnessSpy).not.toHaveBeenCalled(); // still blocked
  });
});

// -----------------------------------------------------------------------------
// (3) round-12 — evidence-backed user_moved_on rejects pre-queue AND queues
// -----------------------------------------------------------------------------

describe('§A4 (3) — recordable regex hit while blocked → pre-queue rejectAll + transcript still queues', () => {
  test('fresh reading with field+circuit+value regex evidence rejectAlls the pendingValue ask and queues the transcript', async () => {
    const { ws, entry } = await startSession(wss, 'sess-pv-3');
    const loggerModule = (await import('../logger.js')).default;
    loggerModule.info.mockClear();

    entry.isExtracting = true;

    let rejectedPayload = null;
    registerPendingValueAsk(entry, 'toolu_pv_3', (payload) => {
      rejectedPayload = payload;
    });
    const rejectAllSpy = jest.spyOn(entry.pendingAsks, 'rejectAll');
    runShadowHarnessSpy.mockClear();

    await sendFrame(ws, {
      type: 'transcript',
      text: 'Zs circuit 3 is 0.3',
      utterance_id: 'u-pv-3',
      regexResults: [{ field: 'measured_zs_ohm', circuit: 3, value: 0.3 }],
    });

    // Evidence-backed movement: the ask dies pre-queue so the tool loop
    // unblocks immediately instead of waiting for the 20s timeout.
    expect(rejectAllSpy).toHaveBeenCalledWith('user_moved_on');
    expect(rejectAllSpy).toHaveBeenCalledTimes(1);
    expect(rejectedPayload).toMatchObject({ answered: false, reason: 'user_moved_on' });
    expect(entry.pendingAsks.size).toBe(0);

    // The transcript itself is a fresh reading — it must still queue and
    // process once the in-flight turn completes (not be consumed/dropped).
    expect(entry.pendingTranscripts).toHaveLength(1);
    expect(entry.pendingTranscripts[0].text).toBe('Zs circuit 3 is 0.3');
    expect(runShadowHarnessSpy).not.toHaveBeenCalled(); // still blocked

    const movedOnRows = loggerModule.info.mock.calls.filter(
      (c) => c[0] === 'stage6.transcript_pre_queue_moved_on'
    );
    expect(movedOnRows).toHaveLength(1);
    expect(movedOnRows[0][1]).toMatchObject({
      sessionId: 'sess-pv-3',
      evidence: 'recordable_regex',
    });
  });
});

// -----------------------------------------------------------------------------
// (4) round-8/13 — direct ask_user_answered channel guard
// -----------------------------------------------------------------------------

describe('§A4 (4) — ask_user_answered carrying a structurally complete fresh reading', () => {
  test('"Ze is 0.22" against a pendingValue-class ask → user_moved_on + re-injection through handleTranscript, never consumed as the answer', async () => {
    const { ws, entry } = await startSession(wss, 'sess-pv-4');
    const loggerModule = (await import('../logger.js')).default;
    loggerModule.warn.mockClear();

    let resolvedPayload = null;
    registerPendingValueAsk(entry, 'toolu_pv_4', (payload) => {
      resolvedPayload = payload;
    });
    runShadowHarnessSpy.mockClear();

    // Zero regex context on this channel — only the TYPED detector can tell
    // "Ze is 0.22" (a complete supply-family reading) apart from a field-name
    // answer. Burning it as the answer would lose the reading AND join the
    // stale 26 ms to the wrong field.
    await sendFrame(ws, {
      type: 'ask_user_answered',
      tool_call_id: 'toolu_pv_4',
      user_text: 'Ze is 0.22',
      consumed_utterance_id: 'u-pv-4',
    });

    // Never consumed as the answer: the ask resolves user_moved_on so the
    // tool loop unblocks (Sonnet re-asks or moves on).
    expect(resolvedPayload).toMatchObject({ answered: false, reason: 'user_moved_on' });
    expect(resolvedPayload.user_text).toBeUndefined();
    expect(entry.pendingAsks.size).toBe(0);

    // The STAGE-2 gate names the structured-reading trigger in its log row.
    const rejectedRows = loggerModule.warn.mock.calls.filter(
      (c) => c[0] === 'stage6.ask_user_answered_rejected_new_command'
    );
    expect(rejectedRows).toHaveLength(1);
    expect(rejectedRows[0][1]).toMatchObject({
      tool_call_id: 'toolu_pv_4',
      matched_structured_reading: true,
      matched_imperative: false,
      matched_bulk_scope: false,
      structured_field: 'earth_loop_impedance_ze',
    });

    // Re-injection: the synthetic transcript flows through handleTranscript
    // (fire-and-forget) and reaches the shadow harness as a NORMAL user turn
    // — the fresh reading gets written, not dropped (audio-first invariant 2).
    await flushUntilHarnessCalled();
    expect(runShadowHarnessSpy).toHaveBeenCalledTimes(1);
    const lastCall = runShadowHarnessSpy.mock.calls.at(-1);
    // runShadowHarness(session, transcriptText, regexResults, options)
    expect(lastCall[1]).toContain('Ze is 0.22');
  });
});
