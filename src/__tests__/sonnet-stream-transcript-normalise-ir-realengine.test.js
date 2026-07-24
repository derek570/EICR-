/**
 * P6 — REAL-engine ingress proof for the "a hundred" word-number (id 80A).
 *
 * The sibling ingress test (sonnet-stream-transcript-normalise-ingress.test.js)
 * stubs the dialogue engine to read the exact text the wrappers receive. This
 * file complements it by running the ACTUAL insulation-resistance dialogue
 * engine end-to-end through the live handleTranscript seam: it activates a real
 * IR episode, then delivers the raw "A hundred MΩ" reply through a transcript
 * frame and asserts the REAL engine + its megaohms parser capture "100" — i.e.
 * the normaliser at Seam A hands canonical text to the live script, not just to
 * a spy. The dialogue engine is NOT mocked here.
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

// ── Mocks — everything EXCEPT the dialogue engine + the normaliser ──────────

const mockSessionStop = jest.fn(() => ({ totals: { cost: 0 } }));

class FakeEICRExtractionSession {
  constructor(apiKey, sessionId, certType) {
    this.sessionId = sessionId;
    this.certType = certType;
    this.turnCount = 0;
    this.costTracker = { toCostUpdate: () => ({ type: 'cost_update', cost: 0 }) };
    this.start = jest.fn();
    this.stop = mockSessionStop;
    this.flushUtteranceBuffer = jest.fn(async () => null);
    this.updateJobState = jest.fn();
    this.pause = jest.fn();
    this.resume = jest.fn();
    this.onBatchResult = null;
    this.toolCallsMode = 'off';
    this.applyModeChange = jest.fn();
    // The real dialogue engine reads/writes these on entry.session.
    this.stateSnapshot = { circuits: { 13: {} } };
    this.dialogueScriptState = null;
  }
}

jest.unstable_mockModule('../extraction/eicr-extraction-session.js', () => ({
  EICRExtractionSession: FakeEICRExtractionSession,
}));

const loggerModule = {
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
};
jest.unstable_mockModule('../logger.js', () => loggerModule);
jest.unstable_mockModule('../storage.js', () => ({ uploadJson: jest.fn(async () => {}) }));

// runShadowHarness is a spy but should NOT be reached — an active IR episode
// consumes the turn before the shadow harness. We assert it stays unused.
const runShadowHarnessSpy = jest.fn(async () => ({
  extracted_readings: [],
  questions_for_user: [],
  observations: [],
  confirmations: [],
}));
jest.unstable_mockModule('../extraction/stage6-shadow-harness.js', () => ({
  runShadowHarness: runShadowHarnessSpy,
}));

const classifyOvertakeSpy = jest.fn(() => ({ kind: 'no_pending_asks' }));
jest.unstable_mockModule('../extraction/stage6-overtake-classifier.js', () => ({
  classifyOvertake: classifyOvertakeSpy,
}));

// Gate forwards so the turn reaches the dialogue scripts. GATE_REASONS +
// OBSERVATION_PATTERN are read by the real engine at load.
jest.unstable_mockModule('../extraction/pre-llm-gate.js', () => ({
  shouldForwardToSonnet: jest.fn(() => ({ forward: true, reason: 'forwarded', borderline: false })),
  GATE_REASONS: Object.freeze({ HAS_COMPLAINT_OR_NEGATION: 'has_complaint_or_negation' }),
  OBSERVATION_PATTERN: /(?!)/,
}));

// ── Dynamic imports AFTER mocks (dialogue engine is REAL) ───────────────────

const { initSonnetStream, activeSessions } = await import('../extraction/sonnet-stream.js');
const { sonnetSessionStore } = await import('../extraction/sonnet-session-store.js');
const { processInsulationResistanceTurn } = await import(
  '../extraction/dialogue-engine/index.js'
);

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
    if (!h) throw new Error(`No handler for ${event}`);
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
let wss;
beforeEach(() => {
  runShadowHarnessSpy.mockClear();
  classifyOvertakeSpy.mockClear();
  loggerModule.default.info.mockClear();
  activeSessions.clear();
  sonnetSessionStore.clear();
  wss = initSonnetStream(null, getKey, jest.fn());
});
afterEach(() => {
  activeSessions.clear();
  sonnetSessionStore.clear();
  jest.useRealTimers();
});

describe('P6 real-engine IR ingress — "A hundred MΩ" captures 100', () => {
  test('the live IR engine records ir_live_live_mohm=100 from a raw "A hundred megaohms" transcript', async () => {
    const ws = connect(wss);
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-IR',
      jobId: 'job-1',
      jobState: { certificateType: 'eicr' },
    });
    const entry = activeSessions.get('sess-IR');
    // Ensure the fake session carries a circuit for the engine to resolve.
    entry.session.stateSnapshot = { circuits: { 13: {} } };
    entry.session.dialogueScriptState = null;

    // 1) Enter the REAL IR episode. "Insulation resistance for circuit 13"
    //    carries no P6 rule, so canonical == raw; the engine asks for L-L.
    await sendFrame(ws, { type: 'transcript', text: 'Insulation resistance for circuit 13.' });
    expect(entry.session.dialogueScriptState).not.toBeNull();
    const askedField = ws._sent.at(-1)?.context_field;
    expect(askedField).toBe('ir_live_live_mohm');

    // 2) Answer with the RAW word-number reply. Seam A canonicalises
    //    "A hundred megaohms" → "100 megaohms" BEFORE the live IR script sees
    //    it, so the real megaohms parser records 100 for L-L.
    await sendFrame(ws, { type: 'transcript', text: 'A hundred megaohms' });

    expect(entry.session.stateSnapshot.circuits[13].ir_live_live_mohm).toBe('100');
    // The IR episode consumed the turn — the shadow harness was never reached.
    expect(runShadowHarnessSpy).not.toHaveBeenCalled();
  });

  test('control: the RAW word-number defeats the live engine WITHOUT normalisation', () => {
    // Direct real-engine call (bypassing the seam) proves normalisation is
    // load-bearing: "a hundred megaohms" delivered RAW does not fill L-L.
    const ws = { OPEN: 1, readyState: 1, sent: [], send(d) { this.sent.push(JSON.parse(d)); } };
    const session = { sessionId: 'sess_direct', stateSnapshot: { circuits: { 13: {} } } };
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: 'sess_direct',
      transcriptText: 'Insulation resistance for circuit 13.',
      now: 1000,
    });
    expect(ws.sent.at(-1).context_field).toBe('ir_live_live_mohm');
    // RAW reply — no digit; the L-L slot stays unfilled and the engine re-asks.
    processInsulationResistanceTurn({
      ws,
      session,
      sessionId: 'sess_direct',
      transcriptText: 'a hundred megaohms',
      now: 2000,
    });
    expect(session.stateSnapshot.circuits[13].ir_live_live_mohm).toBeUndefined();
  });
});
