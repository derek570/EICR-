/**
 * PLAN-C P4d — rows 5/6/7: the legacy sonnet-stream frames carry the response
 * epoch so the client chime-silence watchdog disarms on them.
 *
 *   Row 5 — legacy `question` frames: cloned with utterance_id BEFORE enqueue.
 *   Row 6 — `voice_command_response`: carries utterance_id.
 *   Row 7 — reconnect replay (flushPendingExtractions): strips
 *           spoken_response/action from the extraction replay and emits a
 *           SEPARATE voice_command_response carrying the buffered epoch.
 *
 * Together with the row-8 SOURCE test (plan-c-p4d-batch-id.test.js, which proves
 * a batched extraction carries B's id) these compose the plan's A/B contract:
 * B's id (from batching) reaches the extraction, question, voice_command_response
 * and reconnect-replay frames.
 *
 * Harness: the FakeEICRExtractionSession + wss.emit('connection') pattern from
 * sonnet-stream-ask-routing / questions-for-user-deletion. onBatchResult is
 * driven directly (identical stamping code to the sync path); reconnect exercises
 * flushPendingExtractions.
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
    this.toolCallsMode = 'off'; // legacy path — rows 5-7 live here
    this.costTracker = { toCostUpdate: () => ({ type: 'cost_update', cost: 0 }) };
    this.stateSnapshot = { circuits: {}, pending_readings: [], observations: [], validation_alerts: [] };
    this.start = mockSessionStart;
    this.stop = mockSessionStop;
    this.flushUtteranceBuffer = mockFlushBuffer;
    this.reviewForOrphanedValues = jest.fn(async () => ({ questions_for_user: [] }));
    this.updateJobState = jest.fn();
    this.pause = jest.fn();
    this.resume = jest.fn();
    this.onBatchResult = null;
    this.applyModeChange = jest.fn();
  }
}

jest.unstable_mockModule('../extraction/eicr-extraction-session.js', () => ({
  EICRExtractionSession: FakeEICRExtractionSession,
}));

jest.unstable_mockModule('../logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('../storage.js', () => ({ uploadJson: jest.fn(async () => {}) }));

jest.unstable_mockModule('../extraction/stage6-shadow-harness.js', () => ({
  runShadowHarness: jest.fn(async () => ({
    extracted_readings: [],
    questions_for_user: [],
    observations: [],
    confirmations: [],
  })),
}));

jest.unstable_mockModule('../extraction/stage6-overtake-classifier.js', () => ({
  classifyOvertake: jest.fn(() => ({ kind: 'no_pending_asks' })),
}));

// Identity filter so a synthetic question isn't dropped against the empty snapshot.
jest.unstable_mockModule('../extraction/filled-slots-filter.js', () => ({
  filterQuestionsAgainstFilledSlots: jest.fn((questions) => questions),
}));

const { initSonnetStream, activeSessions, _test_stampQuestionsWithUtteranceId } = await import(
  '../extraction/sonnet-stream.js'
);
const { sonnetSessionStore } = await import('../extraction/sonnet-session-store.js');

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
  ws.on.mockImplementation((event, handler) => ws._handlers.set(event, handler));
  ws._sent = sent;
  ws._emit = async (event, data) => {
    const h = ws._handlers.get(event);
    if (!h) throw new Error(`No handler for ${event}`);
    await h(data);
  };
  return ws;
}

function connect(wss) {
  const ws = makeFakeWs();
  wss.emit('connection', ws, { headers: {} }, 'user-1');
  return ws;
}

async function sendFrame(ws, frame) {
  await ws._emit('message', Buffer.from(JSON.stringify(frame)));
}

const getKey = async () => 'fake-key';

let wss;
beforeEach(() => {
  activeSessions.clear();
  sonnetSessionStore.clear();
  wss = initSonnetStream(null, getKey, jest.fn());
});
afterEach(() => {
  activeSessions.clear();
  sonnetSessionStore.clear();
  jest.useRealTimers();
});

// ── Row 5 (helper) — the creation-time clone-and-stamp mechanism ────────────

describe('P4d row 5 — stampQuestionsWithUtteranceId (mechanism shared by all 3 enqueue sites)', () => {
  const questions = [
    { field: 'r1_r2', circuit: 2, type: 'unclear', question: 'Repeat R1+R2 for circuit 2?' },
  ];

  test('clones each question with utterance_id for a non-empty epoch', () => {
    const out = _test_stampQuestionsWithUtteranceId(questions, 'utt-B');
    expect(out[0].utterance_id).toBe('utt-B');
    // Original untouched (never mutate the caller's array — resolveByFields
    // references the same objects).
    expect(questions[0]).not.toHaveProperty('utterance_id');
    expect(out[0]).not.toBe(questions[0]);
  });

  test('null / empty epoch returns the array unchanged (byte-identical)', () => {
    expect(_test_stampQuestionsWithUtteranceId(questions, null)).toBe(questions);
    expect(_test_stampQuestionsWithUtteranceId(questions, '')).toBe(questions);
  });
});

// ── Row 5 (integration) — onBatchResult stamps questions before enqueue ─────

describe('P4d row 5 — onBatchResult stamps the response epoch onto the question', () => {
  test('enqueued questions carry result.utterance_id', async () => {
    const ws = connect(wss);
    await sendFrame(ws, { type: 'session_start', sessionId: 'sess-p4d', jobState: { certificateType: 'eicr' } });
    const entry = activeSessions.get('sess-p4d');
    const enqueueSpy = jest.spyOn(entry.questionGate, 'enqueue');

    await entry.session.onBatchResult({
      extracted_readings: [],
      questions_for_user: [{ field: 'zs', circuit: 1, type: 'unclear', question: 'Repeat Zs?' }],
      observations: [],
      confirmations: [],
      utterance_id: 'utt-B',
    });

    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    const enqueued = enqueueSpy.mock.calls[0][0];
    expect(enqueued[0].utterance_id).toBe('utt-B');
  });
});

// ── Row 6 — voice_command_response carries the epoch ────────────────────────

describe('P4d row 6 — voice_command_response carries the response epoch', () => {
  test('onBatchResult voice_command_response carries utterance_id', async () => {
    const ws = connect(wss);
    await sendFrame(ws, { type: 'session_start', sessionId: 'sess-p4d', jobState: { certificateType: 'eicr' } });
    const entry = activeSessions.get('sess-p4d');

    await entry.session.onBatchResult({
      extracted_readings: [],
      questions_for_user: [],
      observations: [],
      confirmations: [],
      spoken_response: 'Zs recorded.',
      action: null,
      utterance_id: 'utt-B',
    });

    const vcr = ws._sent.find((m) => m.type === 'voice_command_response');
    expect(vcr).toBeDefined();
    expect(vcr.utterance_id).toBe('utt-B');
  });

  test('no epoch on the result → voice_command_response omits utterance_id', async () => {
    const ws = connect(wss);
    await sendFrame(ws, { type: 'session_start', sessionId: 'sess-p4d', jobState: { certificateType: 'eicr' } });
    const entry = activeSessions.get('sess-p4d');

    await entry.session.onBatchResult({
      extracted_readings: [],
      questions_for_user: [],
      observations: [],
      confirmations: [],
      spoken_response: 'Zs recorded.',
      action: null,
    });

    const vcr = ws._sent.find((m) => m.type === 'voice_command_response');
    expect(vcr).toBeDefined();
    expect(vcr).not.toHaveProperty('utterance_id');
  });
});

// ── Row 7 — reconnect replay: strip spoken_response/action, emit separate VCR ─

describe('P4d row 7 — flushPendingExtractions replay', () => {
  test('buffered spoken_response speaks via a SEPARATE voice_command_response carrying the epoch, stripped from the extraction replay', async () => {
    const wsA = connect(wss);
    await sendFrame(wsA, { type: 'session_start', sessionId: 'sess-p4d', jobState: { certificateType: 'eicr' } });
    const entry = activeSessions.get('sess-p4d');

    // Simulate a result buffered while the socket was down (row 8 preserves
    // utterance_id on the buffered result).
    entry.pendingExtractions.push({
      extracted_readings: [{ circuit: 1, field: 'zs', value: 0.35 }],
      questions_for_user: [],
      observations: [],
      confirmations: [],
      spoken_response: 'Zs recorded on reconnect.',
      action: null,
      utterance_id: 'utt-B',
    });

    // Reconnect on a fresh socket with the same sessionId → flushPendingExtractions.
    const wsB = connect(wss);
    await sendFrame(wsB, { type: 'session_start', sessionId: 'sess-p4d', jobState: { certificateType: 'eicr' } });

    const extraction = wsB._sent.find((m) => m.type === 'extraction');
    const vcr = wsB._sent.find((m) => m.type === 'voice_command_response');

    // Separate voice_command_response replays the spoken text WITH the epoch.
    expect(vcr).toBeDefined();
    expect(vcr.spoken_response).toBe('Zs recorded on reconnect.');
    expect(vcr.utterance_id).toBe('utt-B');

    // The extraction replay no longer carries spoken_response/action.
    expect(extraction).toBeDefined();
    expect(extraction.result).not.toHaveProperty('spoken_response');
    expect(extraction.result).not.toHaveProperty('action');
    // Readings still replay.
    expect(extraction.result.readings).toHaveLength(1);
  });
});
