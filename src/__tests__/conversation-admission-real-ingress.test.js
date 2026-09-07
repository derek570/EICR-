/**
 * ConversationAdmissionV1 backend companion: drive the production WebSocket
 * ingress and real pre-LLM gate. Client admission only determines which raw
 * finals arrive here; the server's session-latched VOICE_AGENTIC_ANSWERS flag
 * remains the authority for borderline question turns.
 */
import { jest, describe, test, expect, beforeEach, afterEach, afterAll } from '@jest/globals';

const originalVoicePreLLMGate = process.env.VOICE_PRE_LLM_GATE;
process.env.VOICE_PRE_LLM_GATE = 'true';

const runShadowHarnessSpy = jest.fn(async () => ({
  extracted_readings: [],
  questions_for_user: [],
  observations: [],
  confirmations: [],
}));
const loggerInfoSpy = jest.fn();

class FakeEICRExtractionSession {
  constructor(_apiKey, sessionId, certType) {
    this.sessionId = sessionId;
    this.certType = certType;
    this.turnCount = 0;
    this.agenticAnswersEnabled = process.env.VOICE_AGENTIC_ANSWERS !== 'false';
    this.stateSnapshot = { circuits: {}, installation_details: {} };
    this.dialogueScriptState = null;
    this.costTracker = { toCostUpdate: () => ({ type: 'cost_update', cost: 0 }) };
    this.start = jest.fn();
    this.stop = jest.fn(() => ({ totals: { cost: 0 } }));
    this.flushUtteranceBuffer = jest.fn(async () => null);
    this.updateJobState = jest.fn();
    this.pause = jest.fn();
    this.resume = jest.fn();
    this.applyModeChange = jest.fn();
    this.toolCallsMode = 'live';
    this.onBatchResult = null;
  }
}

jest.unstable_mockModule('../extraction/eicr-extraction-session.js', () => ({
  EICRExtractionSession: FakeEICRExtractionSession,
}));
jest.unstable_mockModule('../logger.js', () => ({
  default: { info: loggerInfoSpy, warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../storage.js', () => ({ uploadJson: jest.fn(async () => {}) }));
jest.unstable_mockModule('../extraction/stage6-shadow-harness.js', () => ({
  runShadowHarness: runShadowHarnessSpy,
  mergeFastPathCorrelationIds: jest.fn(),
  unmergeFastPathCorrelationIds: jest.fn(),
  coerceFastPathCorrelationIds: jest.fn(() => new Set()),
}));
jest.unstable_mockModule('../extraction/stage6-overtake-classifier.js', () => ({
  classifyOvertake: jest.fn(() => ({ kind: 'no_pending_asks' })),
  classifyFreshCommandText: jest.fn(() => ({
    isFreshCommand: false,
    matchedImperative: false,
    matchedBulkScope: false,
    wordCount: 0,
  })),
}));

const { initSonnetStream, activeSessions } = await import('../extraction/sonnet-stream.js');
const { sonnetSessionStore } = await import('../extraction/sonnet-session-store.js');
const { GATE_REASONS } = await import('../extraction/pre-llm-gate.js');

function makeFakeWs() {
  const handlers = new Map();
  return {
    readyState: 1,
    OPEN: 1,
    send: jest.fn(),
    ping: jest.fn(),
    close: jest.fn(),
    on: jest.fn((event, handler) => handlers.set(event, handler)),
    emitClient: async (event, data) => handlers.get(event)?.(data),
  };
}

async function sendFrame(ws, frame) {
  await ws.emitClient('message', Buffer.from(JSON.stringify(frame)));
}

async function stopAndClose(ws) {
  await sendFrame(ws, { type: 'session_stop' });
  await ws.emitClient('close');
}

let wss;
beforeEach(() => {
  activeSessions.clear();
  sonnetSessionStore.clear();
  runShadowHarnessSpy.mockClear();
  loggerInfoSpy.mockClear();
  wss = initSonnetStream(null, async () => 'fake-key', jest.fn());
});

afterAll(() => {
  if (originalVoicePreLLMGate === undefined) delete process.env.VOICE_PRE_LLM_GATE;
  else process.env.VOICE_PRE_LLM_GATE = originalVoicePreLLMGate;
});

afterEach(() => {
  delete process.env.VOICE_AGENTIC_ANSWERS;
  activeSessions.clear();
  sonnetSessionStore.clear();
});

describe('ConversationAdmissionV1 through real initSonnetStream ingress', () => {
  for (const text of ['Could you repeat that please?', 'What did you hear?']) {
    test(`${text} is BORDERLINE_FORWARD only while the session latch is enabled`, async () => {
      process.env.VOICE_AGENTIC_ANSWERS = 'true';
      const enabledWs = makeFakeWs();
      wss.emit('connection', enabledWs, { headers: {} }, 'user-1');
      await sendFrame(enabledWs, {
        type: 'session_start', sessionId: 'enabled', jobId: 'job-1',
        jobState: { certificateType: 'eicr' },
      });
      await sendFrame(enabledWs, { type: 'transcript', text });
      expect(runShadowHarnessSpy).toHaveBeenCalledTimes(1);
      expect(runShadowHarnessSpy.mock.calls[0][1]).toContain(text);
      expect(loggerInfoSpy).toHaveBeenCalledWith(
        'voice_latency.gate_borderline_forwarded',
        expect.objectContaining({
          sessionId: 'enabled',
        })
      );
      expect(activeSessions.get('enabled').session.stateSnapshot).toEqual({
        circuits: {}, installation_details: {},
      });
      await stopAndClose(enabledWs);

      runShadowHarnessSpy.mockClear();
      process.env.VOICE_AGENTIC_ANSWERS = 'false';
      const disabledWs = makeFakeWs();
      wss.emit('connection', disabledWs, { headers: {} }, 'user-1');
      await sendFrame(disabledWs, {
        type: 'session_start', sessionId: 'disabled', jobId: 'job-2',
        jobState: { certificateType: 'eicr' },
      });
      await sendFrame(disabledWs, { type: 'transcript', text });
      expect(runShadowHarnessSpy).not.toHaveBeenCalled();
      expect(loggerInfoSpy).toHaveBeenCalledWith(
        'voice_latency.gate_blocked',
        expect.objectContaining({
          sessionId: 'disabled',
          reason: GATE_REASONS.LOW_CONTENT,
        })
      );
      await stopAndClose(disabledWs);
    });
  }

  test('lookup-only postcode metadata cannot create a write with a no-write model', async () => {
    process.env.VOICE_AGENTIC_ANSWERS = 'true';
    const ws = makeFakeWs();
    wss.emit('connection', ws, { headers: {} }, 'user-1');
    await sendFrame(ws, {
      type: 'session_start', sessionId: 'postcode', jobId: 'job-3',
      jobState: { certificateType: 'eicr' },
    });
    await sendFrame(ws, {
      type: 'transcript',
      text: 'Is the postcode RG30 1AB?',
      postcode_hint: 'RG30 1AB',
    });

    expect(runShadowHarnessSpy).toHaveBeenCalledTimes(1);
    expect(activeSessions.get('postcode').session.stateSnapshot.installation_details).toEqual({});
    await stopAndClose(ws);
  });
});
