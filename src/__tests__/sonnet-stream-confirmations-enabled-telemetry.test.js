/**
 * PLAN-D (feedback-2026-08-11 wave) — D2 backend: per-transcript
 * `confirmations_enabled` telemetry row (ids 122, 124).
 *
 * The confirmations toggle has no session-start wire carrier — the
 * session_start frame doesn't carry the flag; it only arrives on
 * transcript frames. This is the one ingress seam that can observe the
 * flag every turn. The row is emitted in the WS message handler's
 * `case 'transcript':`, AFTER rate-limit acceptance and BEFORE
 * `handleTranscript` is even called — so it fires unconditionally on
 * every transcript frame that clears the rate limiter, regardless of
 * what handleTranscript's internal state machine (queue, ask-answer
 * resolution, pre-LLM gate) subsequently does with it. The six tests
 * below prove exactly that: the row's presence and value never depend
 * on downstream handling.
 *
 * MOCK STRATEGY — lifted verbatim from
 * sonnet-stream-transcript-normalise-ingress.test.js, the known-working
 * minimal mock set for sonnet-stream.js to load in a test environment
 * (drive real frames through `ws._emit('message', …)`, matching
 * ask-routing.test.js's harness pattern).
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

// ── Mocks (registered BEFORE the dynamic import of sonnet-stream.js) ─────────

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
    this.applyModeChange = jest.fn();
  }
}

jest.unstable_mockModule('../extraction/eicr-extraction-session.js', () => ({
  EICRExtractionSession: FakeEICRExtractionSession,
}));

const loggerModule = {
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
};
jest.unstable_mockModule('../logger.js', () => loggerModule);

jest.unstable_mockModule('../storage.js', () => ({
  uploadJson: jest.fn(async () => {}),
}));

const runShadowHarnessSpy = jest.fn(async () => ({
  extracted_readings: [],
  questions_for_user: [],
  observations: [],
  confirmations: [],
}));
// Codex diff-review cycle 3 D1 — sonnet-stream.js now imports
// mergeFastPathCorrelationIds from this module too; ESM named-export
// resolution requires the mock factory to provide every name any
// importer uses. No-op stub is safe here — this file's assertions never
// inspect entry.fastPathCorrelationIdByTurn.
jest.unstable_mockModule('../extraction/stage6-shadow-harness.js', () => ({
  runShadowHarness: runShadowHarnessSpy,
  mergeFastPathCorrelationIds: jest.fn(),
  unmergeFastPathCorrelationIds: jest.fn(),
  coerceFastPathCorrelationIds: jest.fn(() => new Set()),
}));

const classifyOvertakeSpy = jest.fn(() => ({ kind: 'no_pending_asks' }));
jest.unstable_mockModule('../extraction/stage6-overtake-classifier.js', () => ({
  classifyOvertake: classifyOvertakeSpy,
  classifyFreshCommandText: jest.fn(() => ({
    isFreshCommand: false,
    matchedImperative: false,
    matchedBulkScope: false,
    wordCount: 0,
  })),
}));

const gateSpy = jest.fn(() => ({ forward: true, reason: 'forwarded', borderline: false }));
jest.unstable_mockModule('../extraction/pre-llm-gate.js', () => ({
  shouldForwardToSonnet: gateSpy,
  GATE_REASONS: Object.freeze({ HAS_COMPLAINT_OR_NEGATION: 'has_complaint_or_negation' }),
  OBSERVATION_PATTERN: /(?!)/,
}));

const noopDialogue = () => ({ handled: false, fallthrough: false });
const stubSchema = (name) => ({ name });
jest.unstable_mockModule('../extraction/dialogue-engine/index.js', () => ({
  processDialogueTurn: noopDialogue,
  enterScriptByName: noopDialogue,
  tryResumePausedScript: noopDialogue,
  tryEnterScriptFromWrites: noopDialogue,
  ringContinuitySchema: stubSchema('ring_continuity'),
  insulationResistanceSchema: stubSchema('insulation_resistance'),
  ocpdSchema: stubSchema('ocpd'),
  rcdSchema: stubSchema('rcd'),
  rcboSchema: stubSchema('rcbo'),
  ALL_DIALOGUE_SCHEMAS: [
    stubSchema('ring_continuity'),
    stubSchema('insulation_resistance'),
    stubSchema('rcbo'),
    stubSchema('ocpd'),
    stubSchema('rcd'),
  ],
  ALL_DIALOGUE_SCHEMA_NAMES: ['insulation_resistance', 'ocpd', 'rcbo', 'rcd', 'ring_continuity'],
  processRingContinuityTurn: noopDialogue,
  processInsulationResistanceTurn: noopDialogue,
  processProtectiveDeviceTurn: noopDialogue,
  valuesCanonicallyEqual: (slot, a, b) => a === b || String(a) === String(b),
}));

// ── Dynamic imports AFTER mocks ─────────────────────────────────────────────

const { initSonnetStream, activeSessions } = await import('../extraction/sonnet-stream.js');
const { sonnetSessionStore } = await import('../extraction/sonnet-session-store.js');

// ── Harness helpers (lifted from ask-routing.test.js) ────────────────────────

function makeFakeWs() {
  const sent = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: jest.fn((payload) => sent.push(JSON.parse(payload))),
    ping: jest.fn(),
    close: jest.fn(),
    on: jest.fn(),
    _handlers: new Map(),
  };
  ws.on.mockImplementation((event, handler) => ws._handlers.set(event, handler));
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

async function startSession(ws, sessionId) {
  await sendFrame(ws, {
    type: 'session_start',
    sessionId,
    jobId: 'job-1',
    jobState: { certificateType: 'eicr' },
  });
}

/** Find the confirmations-telemetry row(s) logged so far, in order. */
function confirmationsRows() {
  return loggerModule.default.info.mock.calls
    .filter(([label]) => label === 'stage6.confirmations_enabled_state')
    .map(([, meta]) => meta);
}

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
  classifyOvertakeSpy.mockClear();
  classifyOvertakeSpy.mockImplementation(() => ({ kind: 'no_pending_asks' }));
  gateSpy.mockClear();
  gateSpy.mockImplementation(() => ({ forward: true, reason: 'forwarded', borderline: false }));
  loggerModule.default.info.mockClear();
  loggerModule.default.warn.mockClear();
  loggerModule.default.error.mockClear();
  activeSessions.clear();
  sonnetSessionStore.clear();
  wss = initSonnetStream(null, getKey, verifyToken);
});

afterEach(() => {
  activeSessions.clear();
  sonnetSessionStore.clear();
  jest.useRealTimers();
});

describe('stage6.confirmations_enabled_state — per-transcript telemetry (D2, ids 122/124)', () => {
  test('confirmations_enabled: true is recorded true', async () => {
    const ws = connect(wss);
    await startSession(ws, 'sess-true');
    await sendFrame(ws, {
      type: 'transcript',
      text: 'Circuit 1 Zs 0.5',
      utterance_id: 'utt-1',
      confirmations_enabled: true,
    });
    const rows = confirmationsRows();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toMatchObject({
      sessionId: 'sess-true',
      utterance_id: 'utt-1',
      confirmations_enabled: true,
    });
  });

  test('confirmations_enabled: false is recorded false', async () => {
    const ws = connect(wss);
    await startSession(ws, 'sess-false');
    await sendFrame(ws, {
      type: 'transcript',
      text: 'Circuit 1 Zs 0.5',
      utterance_id: 'utt-2',
      confirmations_enabled: false,
    });
    const rows = confirmationsRows();
    expect(rows[0]).toMatchObject({
      sessionId: 'sess-false',
      utterance_id: 'utt-2',
      confirmations_enabled: false,
    });
  });

  test('an ABSENT confirmations_enabled field is recorded false (never true, never omitted)', async () => {
    const ws = connect(wss);
    await startSession(ws, 'sess-absent');
    await sendFrame(ws, {
      type: 'transcript',
      text: 'Circuit 1 Zs 0.5',
      utterance_id: 'utt-3',
      // confirmations_enabled deliberately omitted.
    });
    const rows = confirmationsRows();
    expect(rows[0]).toMatchObject({
      sessionId: 'sess-absent',
      utterance_id: 'utt-3',
      confirmations_enabled: false,
    });
  });

  test('a QUEUED transcript (session already isExtracting) still gets its own row before queueing', async () => {
    const ws = connect(wss);
    await startSession(ws, 'sess-queued');
    // Force the session into isExtracting so the SECOND transcript takes
    // the queue path inside handleTranscript — the telemetry row fires in
    // the outer switch, entirely before handleTranscript runs, so it must
    // still be recorded regardless.
    const entry = activeSessions.get('sess-queued');
    entry.isExtracting = true;
    await sendFrame(ws, {
      type: 'transcript',
      text: 'Circuit 2 Zs 0.6',
      utterance_id: 'utt-4-queued',
      confirmations_enabled: true,
    });
    const rows = confirmationsRows();
    const row = rows.find((r) => r.utterance_id === 'utt-4-queued');
    expect(row).toMatchObject({
      sessionId: 'sess-queued',
      confirmations_enabled: true,
    });
  });

  test('an ASK-ANSWER transcript (classifyOvertake → answers) still gets its own row', async () => {
    const ws = connect(wss);
    await startSession(ws, 'sess-ask-answer');
    classifyOvertakeSpy.mockImplementationOnce(() => ({
      kind: 'answers',
      toolCallId: 'tc-1',
      userText: '0.5',
    }));
    await sendFrame(ws, {
      type: 'transcript',
      text: '0.5',
      utterance_id: 'utt-5-answer',
      confirmations_enabled: true,
    });
    const rows = confirmationsRows();
    const row = rows.find((r) => r.utterance_id === 'utt-5-answer');
    expect(row).toMatchObject({
      sessionId: 'sess-ask-answer',
      confirmations_enabled: true,
    });
  });

  test('a GATE-CONSUMED transcript (pre-LLM gate blocks forwarding) still gets its own row', async () => {
    const ws = connect(wss);
    await startSession(ws, 'sess-gate-consumed');
    gateSpy.mockImplementationOnce(() => ({
      forward: false,
      reason: 'has_complaint_or_negation',
      borderline: false,
    }));
    await sendFrame(ws, {
      type: 'transcript',
      text: "that's wrong",
      utterance_id: 'utt-6-gated',
      confirmations_enabled: false,
    });
    const rows = confirmationsRows();
    const row = rows.find((r) => r.utterance_id === 'utt-6-gated');
    expect(row).toMatchObject({
      sessionId: 'sess-gate-consumed',
      confirmations_enabled: false,
    });
    // The row fired even though the gate never let this transcript reach
    // the model — proving placement is BEFORE the gate, not conditional on it.
    expect(runShadowHarnessSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      "that's wrong",
      expect.anything(),
      expect.anything()
    );
  });
});
