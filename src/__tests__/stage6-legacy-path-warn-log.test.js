/**
 * stage6-legacy-path-warn-log.test.js — Phase 7 STR-05 / Plan 07-02 Task 1.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE LOCKS IN
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * The retirement runbook (Plan 07-02) introduces a one-shot warn-log named
 * `legacy_path_invoked` that fires the FIRST time `filterQuestionsAgainstFilledSlots`
 * is invoked on the legacy branch in a given session. Subsequent invocations
 * within the same session are silent, so a single non-empty
 * `legacy_path_invoked` row in CloudWatch over the `T+2w..T+4w` window is
 * enough to abort the deletion (per STR-05).
 *
 * The warn-log fires only when:
 *   - `consumeLegacyQuestionsForUser(entry)` returns true (i.e.
 *     `entry.session.toolCallsMode === 'off'`); AND
 *   - `result.questions_for_user` is a non-empty array; AND
 *   - the entry has not yet emitted the `legacy_path_invoked` log this
 *     session (`entry.loggedLegacyPathInvoked` is falsy on the first
 *     trigger and gets set true after).
 *
 * It does NOT fire on the tool-call branch (`shadow` / `live`) because that
 * branch does not reach `filterQuestionsAgainstFilledSlots` — the
 * `consumeLegacyQuestionsForUser` gate short-circuits before the filter
 * call site. (`logBypassOnce` covers the tool-call branch's own
 * questions_for_user-leak surface and is unrelated to this warn.)
 *
 * THREE GROUPS (5 tests):
 *   Group 1 — fires once in off mode (3 tests): batch path / sync path /
 *             review path. Each test seeds a non-empty questions_for_user
 *             on a freshly-started off-mode session and asserts the warn
 *             fires exactly once at that call site.
 *   Group 2 — silent on second invocation in same session (1 test): trigger
 *             twice in the same session via the batch path, assert exactly
 *             ONE warn log emitted.
 *   Group 3 — silent on tool-call branch (1 test): same fixture under
 *             `shadow` mode, assert ZERO warn logs.
 *
 * REQUIREMENT: STR-05 (retirement contract), STB-03 (filter retained in
 *              shadow until T+4w), STO-05 (suppressed_refill_question retired
 *              after deletion window — this warn provides the retirement
 *              gate signal).
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

// ── Module-scoped test knobs ────────────────────────────────────────────────
let nextToolCallsMode = 'off';

// ── Mocks ────────────────────────────────────────────────────────────────────

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

const filterSpy = jest.fn((questions /* , snapshot, resolved, sessionId */) => questions);

jest.unstable_mockModule('../extraction/filled-slots-filter.js', () => ({
  filterQuestionsAgainstFilledSlots: filterSpy,
  __TEST_REFILL_QUESTION_TYPES: new Set(['unclear', 'orphaned', 'circuit_disambiguation']),
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

jest.unstable_mockModule('../extraction/stage6-overtake-classifier.js', () => ({
  classifyOvertake: jest.fn(() => ({ kind: 'no_pending_asks' })),
}));

const { initSonnetStream, activeSessions } = await import('../extraction/sonnet-stream.js');
const { sonnetSessionStore } = await import('../extraction/sonnet-session-store.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

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

// True iff the given call was the new warn-log row.
function isLegacyPathInvokedWarn(call) {
  return call[0] === 'legacy_path_invoked';
}

const SAMPLE_QUESTIONS = [
  {
    field: 'r1_r2',
    circuit: 2,
    type: 'unclear',
    heard_value: 'unclear',
    question: 'Could you repeat the R1+R2 reading for circuit 2?',
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

const getKey = async () => 'fake-anthropic-key';
const verifyToken = jest.fn();

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

async function startSession(mode, sessionId = 'sess-W') {
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
    jest.spyOn(entry.questionGate, 'enqueue');
  }
  return { ws, entry };
}

// ---------------------------------------------------------------------------
// Group 1 — fires once in off mode at each legacy filter call site
// ---------------------------------------------------------------------------

describe('Group 1 — legacy_path_invoked fires once on off-mode legacy paths', () => {
  test('batch path: off mode + non-empty questions_for_user → exactly one legacy_path_invoked warn', async () => {
    const { entry } = await startSession('off', 'sess-batch');
    expect(entry).toBeDefined();
    await entry.session.onBatchResult(extractionResult());
    const warnRows = loggerWarnSpy.mock.calls.filter(isLegacyPathInvokedWarn);
    expect(warnRows.length).toBe(1);
    expect(warnRows[0][1]).toMatchObject({
      sessionId: 'sess-batch',
      callSite: expect.stringMatching(/batch|onBatchResult/i),
      toolCallsMode: 'off',
    });
    // entry stamped — second invocation will be silent (Group 2 locks this).
    expect(entry.loggedLegacyPathInvoked).toBe(true);
  });

  test('sync path: off mode handleTranscript path → exactly one legacy_path_invoked warn', async () => {
    const { ws, entry } = await startSession('off', 'sess-sync');
    expect(entry).toBeDefined();
    // Have runShadowHarness return non-empty questions_for_user so the
    // sync handleTranscript path reaches the legacy filter call site.
    runShadowHarnessSpy.mockImplementationOnce(async () => extractionResult());
    await sendFrame(ws, {
      type: 'transcript',
      utterance_id: 'utt-1',
      text: 'arbitrary',
    });
    const warnRows = loggerWarnSpy.mock.calls.filter(isLegacyPathInvokedWarn);
    expect(warnRows.length).toBe(1);
    expect(warnRows[0][1]).toMatchObject({
      sessionId: 'sess-sync',
      callSite: expect.stringMatching(/sync|handleTranscript/i),
      toolCallsMode: 'off',
    });
  });

  test('review path: off mode reviewForOrphanedValues → exactly one legacy_path_invoked warn', async () => {
    const { ws, entry } = await startSession('off', 'sess-review');
    expect(entry).toBeDefined();
    // Trigger periodic orphan review (turnCount % 10 === 0 + > 0). Pre-set
    // turnCount to 10 directly on the session double; review wakes when the
    // sync handler advances post-extraction.
    entry.session.turnCount = 10;
    mockReviewForOrphanedValues.mockResolvedValueOnce({
      questions_for_user: SAMPLE_QUESTIONS,
    });
    runShadowHarnessSpy.mockImplementationOnce(async () => ({
      extracted_readings: [],
      questions_for_user: [],
      observations: [],
      confirmations: [],
    }));
    await sendFrame(ws, {
      type: 'transcript',
      utterance_id: 'utt-rev',
      text: 'review trigger',
    });
    const warnRows = loggerWarnSpy.mock.calls.filter(isLegacyPathInvokedWarn);
    expect(warnRows.length).toBe(1);
    expect(warnRows[0][1]).toMatchObject({
      sessionId: 'sess-review',
      callSite: expect.stringMatching(/review|orphan/i),
      toolCallsMode: 'off',
    });
  });
});

// ---------------------------------------------------------------------------
// Group 2 — silent on second invocation in same session
// ---------------------------------------------------------------------------

describe('Group 2 — legacy_path_invoked is one-shot per session', () => {
  test('batch path triggered twice in same session → exactly one legacy_path_invoked warn total', async () => {
    const { entry } = await startSession('off', 'sess-twice');
    expect(entry).toBeDefined();
    await entry.session.onBatchResult(extractionResult());
    await entry.session.onBatchResult(extractionResult());
    const warnRows = loggerWarnSpy.mock.calls.filter(isLegacyPathInvokedWarn);
    expect(warnRows.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Group 3 — silent on tool-call branch
// ---------------------------------------------------------------------------

describe('Group 3 — legacy_path_invoked never fires on tool-call branch', () => {
  test('shadow mode + identical fixture → zero legacy_path_invoked warns', async () => {
    const { entry } = await startSession('shadow', 'sess-shadow');
    expect(entry).toBeDefined();
    await entry.session.onBatchResult(extractionResult());
    const warnRows = loggerWarnSpy.mock.calls.filter(isLegacyPathInvokedWarn);
    expect(warnRows.length).toBe(0);
    // entry not stamped — the warn is gated on the legacy branch only.
    expect(entry.loggedLegacyPathInvoked).toBeFalsy();
  });
});
