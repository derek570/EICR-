/**
 * Stage 6 Phase 4 Plan 04-03 — STQ-04 + STB-03
 *
 * WHAT THIS FILE LOCKS IN
 *   The tool-call branch (SONNET_TOOL_CALLS !== 'off') NEVER consumes the
 *   legacy `questions_for_user` JSON payload in sonnet-stream.js. Every
 *   read site (logger.info preview/count, filterQuestionsAgainstFilledSlots
 *   call, questionGate.enqueue) is mode-gated on
 *   `entry.session.toolCallsMode === 'off'`. The off path is byte-identical
 *   to pre-plan behaviour. Defence-in-depth with Plan 04-01's prompt: even
 *   if a future prompt regression caused Sonnet to emit questions_for_user
 *   in live/shadow mode, the server refuses to forward them.
 *
 *   On non-off mode, the first time a turn carries a non-empty
 *   questions_for_user a `'questions_for_user bypassed (tool-call path)'`
 *   log row fires exactly once per session — subsequent turns are silent,
 *   so a genuine prompt regression surfaces in CloudWatch without log-
 *   flooding every turn until the session ends.
 *
 * FIVE GROUPS (14 tests) — mirrors the plan's <behavior> spec:
 *   Group 1 — onBatchResult path, off mode (3 tests): legacy behaviour preserved.
 *   Group 2 — onBatchResult path, shadow mode (3 tests): enqueue never fires,
 *             filter never called, bypass log fires exactly once.
 *   Group 3 — sync-path handleTranscript, off vs shadow vs live (4 tests).
 *   Group 4 — reviewForOrphanedValues path, off vs shadow (2 tests).
 *   Group 5 — cross-mode smoke (2 tests): queue depth 0 after shadow turn,
 *             and mode latches at session-construction time.
 *
 * WHY mock strategy
 *   Follows sonnet-stream-ask-routing.test.js exactly — drive a fake ws
 *   through `wss.emit('connection', ...)`, intercept FakeEICRExtractionSession
 *   so we own `toolCallsMode` + `stateSnapshot` + `reviewForOrphanedValues`,
 *   and spy on runShadowHarness / logger / QuestionGate so we can assert
 *   which paths fired per mode. The FakeEICRExtractionSession here adds a
 *   `toolCallsMode` field (defaulted per-test via a module-scoped var) so
 *   we can control the branch without touching the real session.
 *
 * REQUIREMENT: STQ-04, STB-03.
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

// ── Module-scoped test knobs ────────────────────────────────────────────────
// The FakeEICRExtractionSession below reads this when constructed so each
// test can pre-set the mode before wss.emit('connection', ...). Reset in
// beforeEach.
let nextToolCallsMode = 'off';

// ── Mocks (must be registered BEFORE dynamic import of sonnet-stream.js) ─────

const mockSessionStart = jest.fn();
const mockSessionStop = jest.fn(() => ({ totals: { cost: 0 } }));
const mockFlushBuffer = jest.fn(async () => null);
const mockReviewForOrphanedValues = jest.fn(async () => ({ questions_for_user: [] }));

class FakeEICRExtractionSession {
  constructor(apiKey, sessionId, certType) {
    this.sessionId = sessionId;
    this.certType = certType;
    this.turnCount = 0;
    this.toolCallsMode = nextToolCallsMode;
    this.costTracker = { toCostUpdate: () => ({ type: 'cost_update', cost: 0 }) };
    // Empty snapshot — tests that need a filled slot seed it directly on
    // entry.session.stateSnapshot after session_start.
    this.stateSnapshot = {
      circuits: {},
      pending_readings: [],
      observations: [],
      validation_alerts: [],
    };
    this.start = mockSessionStart;
    this.stop = mockSessionStop;
    this.flushUtteranceBuffer = mockFlushBuffer;
    this.reviewForOrphanedValues = mockReviewForOrphanedValues;
    this.updateJobState = jest.fn();
    this.pause = jest.fn();
    this.resume = jest.fn();
    this.onBatchResult = null;
  }
}

jest.unstable_mockModule('../extraction/eicr-extraction-session.js', () => ({
  EICRExtractionSession: FakeEICRExtractionSession,
}));

// Logger spy — we assert on log rows per-mode (extraction-result row carries
// `questions` count + `questionsPreview`; bypass row carries the bypass
// string). Keep a module-level handle so tests can introspect calls.
const loggerInfoSpy = jest.fn();
const loggerWarnSpy = jest.fn();
const loggerErrorSpy = jest.fn();
const loggerDebugSpy = jest.fn();

jest.unstable_mockModule('../logger.js', () => ({
  default: {
    info: loggerInfoSpy,
    warn: loggerWarnSpy,
    error: loggerErrorSpy,
    debug: loggerDebugSpy,
  },
}));

jest.unstable_mockModule('../storage.js', () => ({
  uploadJson: jest.fn(async () => {}),
}));

// Stub the filter so we can assert call-count per mode (off mode calls it,
// non-off never calls it). Default passes through.
const filterSpy = jest.fn((questions /* , snapshot, resolved, sessionId */) => questions);

jest.unstable_mockModule('../extraction/filled-slots-filter.js', () => ({
  filterQuestionsAgainstFilledSlots: filterSpy,
  __TEST_REFILL_QUESTION_TYPES: new Set(['unclear', 'orphaned', 'circuit_disambiguation']),
}));

// runShadowHarness spy — per-test we mockImplementationOnce to return a
// fixture that carries questions_for_user so we can assert what the
// server does with them.
const runShadowHarnessSpy = jest.fn(async () => ({
  extracted_readings: [],
  questions_for_user: [],
  observations: [],
  confirmations: [],
}));

jest.unstable_mockModule('../extraction/stage6-shadow-harness.js', () => ({
  runShadowHarness: runShadowHarnessSpy,
}));

// classifyOvertake — inert for this suite; we're asserting on the
// post-harness branch, not the ask routing that ask-routing tests cover.
jest.unstable_mockModule('../extraction/stage6-overtake-classifier.js', () => ({
  classifyOvertake: jest.fn(() => ({ kind: 'no_pending_asks' })),
}));

// ── Dynamic import AFTER mocks ────────────────────────────────────────────────

const { initSonnetStream, activeSessions } = await import('../extraction/sonnet-stream.js');
const { sonnetSessionStore } = await import('../extraction/sonnet-session-store.js');

// ── Helpers (pattern from sonnet-stream-ask-routing.test.js) ─────────────────

function makeFakeWs() {
  const sent = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: jest.fn((payload) => {
      try {
        sent.push(JSON.parse(payload));
      } catch {
        sent.push(payload);
      }
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

// Returns true iff the given logger.info call is the 'Extraction result'
// row (the one the plan requires gated per-mode).
function isExtractionResultLog(call) {
  return call[0] === 'Extraction result';
}

// Returns true iff the given logger.info call is the bypass log (fires
// exactly once per session on the tool-call branch when a non-empty
// questions_for_user payload is encountered).
function isBypassLog(call) {
  return call[0] === 'questions_for_user bypassed (tool-call path)';
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const getKey = async () => 'fake-anthropic-key';
const verifyToken = jest.fn();

const SAMPLE_QUESTIONS = [
  {
    field: 'r1_r2',
    circuit: 2,
    type: 'unclear',
    heard_value: 'unclear',
    question: "Could you repeat the R1+R2 reading for circuit 2?",
  },
];

function extractionResult(extra = {}) {
  return {
    extracted_readings: [],
    questions_for_user: SAMPLE_QUESTIONS,
    observations: [],
    confirmations: [],
    ...extra,
  };
}

let wss;
beforeEach(() => {
  mockSessionStart.mockClear();
  mockSessionStop.mockClear();
  mockFlushBuffer.mockClear();
  mockReviewForOrphanedValues.mockReset();
  mockReviewForOrphanedValues.mockResolvedValue({ questions_for_user: [] });
  runShadowHarnessSpy.mockClear();
  runShadowHarnessSpy.mockImplementation(async () => ({
    extracted_readings: [],
    questions_for_user: [],
    observations: [],
    confirmations: [],
  }));
  filterSpy.mockClear();
  filterSpy.mockImplementation((questions) => questions);
  loggerInfoSpy.mockClear();
  loggerWarnSpy.mockClear();
  loggerErrorSpy.mockClear();
  loggerDebugSpy.mockClear();
  nextToolCallsMode = 'off';
  activeSessions.clear();
  sonnetSessionStore.clear();
  wss = initSonnetStream(null, getKey, verifyToken);
});

afterEach(() => {
  activeSessions.clear();
  sonnetSessionStore.clear();
  jest.useRealTimers();
});

// Starts a session in the given mode and returns the activeSessions entry.
async function startSession(mode, sessionId = 'sess-A') {
  nextToolCallsMode = mode;
  const ws = connect(wss, 'user-1');
  await sendFrame(ws, {
    type: 'session_start',
    sessionId,
    jobId: 'job-1',
    jobState: { certificateType: 'eicr' },
  });
  const entry = activeSessions.get(sessionId);
  if (entry) {
    // Spy on enqueue so we can assert whether the gated branch fired.
    jest.spyOn(entry.questionGate, 'enqueue');
  }
  return { ws, entry };
}

// ---------------------------------------------------------------------------
// Group 1 — onBatchResult path, off mode (legacy behaviour preserved)
// ---------------------------------------------------------------------------

describe('Group 1 — onBatchResult path, off mode (legacy behaviour preserved)', () => {
  test('off mode + non-empty questions_for_user → filter called, enqueue called with filtered batch', async () => {
    const { entry } = await startSession('off');
    expect(entry).toBeDefined();
    // Directly invoke the batch callback the handler bound during session_start.
    await entry.session.onBatchResult(extractionResult());
    expect(filterSpy).toHaveBeenCalledTimes(1);
    expect(entry.questionGate.enqueue).toHaveBeenCalledTimes(1);
    expect(entry.questionGate.enqueue.mock.calls[0][0]).toEqual(SAMPLE_QUESTIONS);
  });

  test('off mode + filled slot suppresses question (filter returns empty) → enqueue NOT called', async () => {
    const { entry } = await startSession('off');
    // Pretend the filter dropped the only question (slot already filled).
    filterSpy.mockImplementationOnce(() => []);
    await entry.session.onBatchResult(extractionResult());
    expect(filterSpy).toHaveBeenCalledTimes(1);
    expect(entry.questionGate.enqueue).not.toHaveBeenCalled();
  });

  test('off mode + non-empty questions_for_user → Extraction result log carries questions count + preview', async () => {
    const { entry } = await startSession('off');
    await entry.session.onBatchResult(extractionResult());
    const resultCall = loggerInfoSpy.mock.calls.find(isExtractionResultLog);
    expect(resultCall).toBeDefined();
    expect(resultCall[1].questions).toBe(1);
    expect(Array.isArray(resultCall[1].questionsPreview)).toBe(true);
    expect(resultCall[1].questionsPreview).toHaveLength(1);
    expect(resultCall[1].questionsPreview[0].field).toBe('r1_r2');
  });
});

// ---------------------------------------------------------------------------
// Group 2 — onBatchResult path, shadow mode (ingestion fully silenced)
// ---------------------------------------------------------------------------

describe('Group 2 — onBatchResult path, shadow mode (no enqueue, no filter, one-shot bypass log)', () => {
  test('shadow mode + non-empty questions_for_user → enqueue NEVER called', async () => {
    const { entry } = await startSession('shadow');
    await entry.session.onBatchResult(extractionResult());
    expect(entry.questionGate.enqueue).not.toHaveBeenCalled();
  });

  test('shadow mode + non-empty questions_for_user → filter NEVER called', async () => {
    const { entry } = await startSession('shadow');
    await entry.session.onBatchResult(extractionResult());
    expect(filterSpy).not.toHaveBeenCalled();
  });

  test('shadow mode → bypass log fires exactly once per session (subsequent turns silent)', async () => {
    const { entry } = await startSession('shadow');
    await entry.session.onBatchResult(extractionResult());
    await entry.session.onBatchResult(extractionResult());
    await entry.session.onBatchResult(extractionResult());
    const bypassCalls = loggerInfoSpy.mock.calls.filter(isBypassLog);
    expect(bypassCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Group 3 — sync-path handleTranscript — off vs shadow vs live
// ---------------------------------------------------------------------------

describe('Group 3 — handleTranscript sync-path respects toolCallsMode', () => {
  test('off mode + questions_for_user → enqueue called', async () => {
    const { ws, entry } = await startSession('off');
    runShadowHarnessSpy.mockImplementationOnce(async () => extractionResult());
    await sendFrame(ws, {
      type: 'transcript',
      text: 'circuit 2 r1 plus r2 is 0.64',
      regexResults: [],
    });
    expect(entry.questionGate.enqueue).toHaveBeenCalledTimes(1);
  });

  test('shadow mode + questions_for_user → enqueue NEVER called', async () => {
    const { ws, entry } = await startSession('shadow');
    runShadowHarnessSpy.mockImplementationOnce(async () => extractionResult());
    await sendFrame(ws, {
      type: 'transcript',
      text: 'circuit 2 r1 plus r2 is 0.64',
      regexResults: [],
    });
    expect(entry.questionGate.enqueue).not.toHaveBeenCalled();
  });

  test('live mode + questions_for_user → enqueue NEVER called', async () => {
    const { ws, entry } = await startSession('live');
    runShadowHarnessSpy.mockImplementationOnce(async () => extractionResult());
    await sendFrame(ws, {
      type: 'transcript',
      text: 'circuit 2 r1 plus r2 is 0.64',
      regexResults: [],
    });
    expect(entry.questionGate.enqueue).not.toHaveBeenCalled();
  });

  test('log-line parity — Extraction result `questions` count is 1 on off, 0 on shadow/live', async () => {
    // Off path first.
    const offHarness = await startSession('off', 'sess-off');
    runShadowHarnessSpy.mockImplementationOnce(async () => extractionResult());
    await sendFrame(offHarness.ws, {
      type: 'transcript',
      text: 'circuit 2 r1 plus r2 is 0.64',
      regexResults: [],
    });
    const offCalls = loggerInfoSpy.mock.calls.filter(isExtractionResultLog);
    // Sync-path Extraction result row should say questions=1.
    expect(offCalls.find((c) => c[1].sessionId === 'sess-off' && c[1].questions === 1)).toBeDefined();

    // Now shadow path on a SECOND session (mode latches at construction).
    loggerInfoSpy.mockClear();
    const shadowHarness = await startSession('shadow', 'sess-shadow');
    runShadowHarnessSpy.mockImplementationOnce(async () => extractionResult());
    await sendFrame(shadowHarness.ws, {
      type: 'transcript',
      text: 'circuit 2 r1 plus r2 is 0.64',
      regexResults: [],
    });
    const shadowCalls = loggerInfoSpy.mock.calls.filter(isExtractionResultLog);
    const shadowResultRow = shadowCalls.find((c) => c[1].sessionId === 'sess-shadow');
    expect(shadowResultRow).toBeDefined();
    expect(shadowResultRow[1].questions).toBe(0);
    expect(shadowResultRow[1].questionsPreview).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Group 4 — reviewForOrphanedValues path (10-turn periodic review)
// ---------------------------------------------------------------------------

describe('Group 4 — reviewForOrphanedValues respects toolCallsMode', () => {
  test('off mode + review returns questions_for_user → enqueue called', async () => {
    const { ws, entry } = await startSession('off');
    entry.session.turnCount = 9; // next increment in session pushes to 10 — but turn count is updated by the real session only; we drive directly via the mock.
    // The sync-path reviewForOrphanedValues is fired when
    // `entry.session.turnCount > 0 && entry.session.turnCount % 10 === 0`.
    // The shadow harness mock does not bump turnCount — bump it inside the
    // mock so the branch fires this turn.
    runShadowHarnessSpy.mockImplementationOnce(async () => {
      entry.session.turnCount = 10;
      return { extracted_readings: [], questions_for_user: [], observations: [], confirmations: [] };
    });
    mockReviewForOrphanedValues.mockResolvedValueOnce({ questions_for_user: SAMPLE_QUESTIONS });
    await sendFrame(ws, {
      type: 'transcript',
      text: 'ten',
      regexResults: [],
    });
    expect(mockReviewForOrphanedValues).toHaveBeenCalledTimes(1);
    expect(entry.questionGate.enqueue).toHaveBeenCalled();
  });

  test('shadow mode + review returns questions_for_user → enqueue NOT called', async () => {
    const { ws, entry } = await startSession('shadow');
    runShadowHarnessSpy.mockImplementationOnce(async () => {
      entry.session.turnCount = 10;
      return { extracted_readings: [], questions_for_user: [], observations: [], confirmations: [] };
    });
    mockReviewForOrphanedValues.mockResolvedValueOnce({ questions_for_user: SAMPLE_QUESTIONS });
    await sendFrame(ws, {
      type: 'transcript',
      text: 'ten',
      regexResults: [],
    });
    // Review itself may or may not be called; what matters is enqueue is NOT called.
    expect(entry.questionGate.enqueue).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Group 5 — cross-mode smoke + regression guard
// ---------------------------------------------------------------------------

describe('Group 5 — cross-mode smoke + regression guards', () => {
  test('shadow-mode turn leaves QuestionGate queue empty', async () => {
    const { ws, entry } = await startSession('shadow');
    runShadowHarnessSpy.mockImplementationOnce(async () => extractionResult());
    await sendFrame(ws, {
      type: 'transcript',
      text: 'some utterance',
      regexResults: [],
    });
    expect(entry.questionGate.pendingQuestions).toEqual([]);
  });

  test('mode latches at session construction — concurrent sessions in off + shadow behave independently', async () => {
    const off = await startSession('off', 'sess-concurrent-off');
    const shadow = await startSession('shadow', 'sess-concurrent-shadow');

    await off.entry.session.onBatchResult(extractionResult());
    await shadow.entry.session.onBatchResult(extractionResult());

    expect(off.entry.questionGate.enqueue).toHaveBeenCalledTimes(1);
    expect(shadow.entry.questionGate.enqueue).not.toHaveBeenCalled();
  });
});
