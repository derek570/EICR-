/**
 * PLAN-C P4d — the END-TO-END A/B legacy-batch contract (Codex diff-review r1/r2).
 *
 * The plan requires ONE two-item A/B test proving the REAL batched result — not a
 * synthetic injected id — reaches the extraction, question, live
 * voice_command_response, AND reconnect-replay frames all carrying B's id.
 *
 * This uses the REAL EICRExtractionSession (only the Anthropic SDK, logger,
 * storage, and the slot filter are mocked) constructed by the real sonnet-stream
 * WS handler: buffer utterance A then B (BATCH_SIZE=2 → the batch fires on B),
 * take the ACTUAL result object (row 8 stamps result.utterance_id from the last
 * non-empty buffered id = B), then drive it through the handler's own
 * onBatchResult + reconnect flush and assert B on every derived frame.
 */

import { jest } from '@jest/globals';

const mockCreate = jest.fn();

jest.unstable_mockModule('@anthropic-ai/sdk', () => ({
  default: jest.fn(() => ({ messages: { create: mockCreate } })),
}));
jest.unstable_mockModule('../logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../storage.js', () => ({ uploadJson: jest.fn(async () => {}) }));
// Identity filter so the synthetic question survives against the empty snapshot.
jest.unstable_mockModule('../extraction/filled-slots-filter.js', () => ({
  filterQuestionsAgainstFilledSlots: jest.fn((questions) => questions),
}));

// NOTE: EICRExtractionSession and runShadowHarness are NOT mocked — the real
// session produces the real batched result; onBatchResult is the real handler
// callback.
const { initSonnetStream, activeSessions } = await import('../extraction/sonnet-stream.js');
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
const sendFrame = (ws, frame) => ws._emit('message', Buffer.from(JSON.stringify(frame)));

const BATCH_TOOL_RESPONSE = {
  content: [
    {
      type: 'tool_use',
      name: 'record_extraction',
      input: {
        extracted_readings: [{ circuit: 1, field: 'zs', value: 0.35, confidence: 0.9 }],
        field_clears: [],
        circuit_updates: [],
        observations: [],
        validation_alerts: [],
        questions_for_user: [
          { field: 'r1_r2', circuit: 2, type: 'unclear', question: 'Repeat R1+R2 for circuit 2?' },
        ],
        confirmations: [],
        spoken_response: 'Zs recorded.',
        action: null,
      },
    },
  ],
  usage: { input_tokens: 10, output_tokens: 5 },
  stop_reason: 'tool_use',
};

let wss;
beforeEach(() => {
  mockCreate.mockReset();
  mockCreate.mockResolvedValue(BATCH_TOOL_RESPONSE);
  activeSessions.clear();
  sonnetSessionStore.clear();
  wss = initSonnetStream(null, async () => 'fake-key', jest.fn());
});
afterEach(() => {
  activeSessions.clear();
  sonnetSessionStore.clear();
});

describe("P4d — end-to-end A/B: the REAL batched result's id (B) reaches every derived frame", () => {
  async function startRealSession() {
    const ws = connect(wss);
    await sendFrame(ws, {
      type: 'session_start',
      sessionId: 'sess-ab',
      jobState: { certificateType: 'eicr' },
    });
    const entry = activeSessions.get('sess-ab');
    entry.session.toolCallsMode = 'off'; // legacy question path
    return { ws, entry };
  }

  test('buffer A then B → result.utterance_id=B → extraction, question, live VCR all carry B', async () => {
    const { ws, entry } = await startRealSession();
    entry.session.start(null);

    // First utterance buffers (empty result); second fills BATCH_SIZE=2 and fires
    // the combined API call — the REAL batched result carries the last non-empty id.
    await entry.session.extractFromUtterance('Zs is 0.35', [], {
      utteranceId: 'utt-A',
      confirmationsEnabled: true,
    });
    const batchResult = await entry.session.extractFromUtterance('on circuit 1', [], {
      utteranceId: 'utt-B',
      confirmationsEnabled: true,
    });
    // Row 8 SOURCE — not injected.
    expect(batchResult.utterance_id).toBe('utt-B');

    const enqueueSpy = jest.spyOn(entry.questionGate, 'enqueue');
    // Drive the real handler frame emission with the real batched result.
    await entry.session.onBatchResult(batchResult);

    const extraction = ws._sent.find((m) => m.type === 'extraction');
    const vcr = ws._sent.find((m) => m.type === 'voice_command_response');
    expect(extraction).toBeDefined();
    expect(extraction.result.utterance_id).toBe('utt-B');
    expect(vcr).toBeDefined();
    expect(vcr.utterance_id).toBe('utt-B');
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy.mock.calls[0][0][0].utterance_id).toBe('utt-B');
  });

  test('the same real batched result replays on reconnect carrying B (separate VCR, stripped extraction)', async () => {
    const { entry } = await startRealSession();
    entry.session.start(null);
    await entry.session.extractFromUtterance('Zs is 0.35', [], { utteranceId: 'utt-A' });
    const batchResult = await entry.session.extractFromUtterance('on circuit 1', [], {
      utteranceId: 'utt-B',
    });
    expect(batchResult.utterance_id).toBe('utt-B');

    // Buffer it as if the socket had been down, then reconnect.
    entry.pendingExtractions.push(batchResult);
    const wsB = connect(wss);
    await sendFrame(wsB, {
      type: 'session_start',
      sessionId: 'sess-ab',
      jobState: { certificateType: 'eicr' },
    });

    const extraction = wsB._sent.find((m) => m.type === 'extraction');
    const vcr = wsB._sent.find((m) => m.type === 'voice_command_response');
    expect(extraction).toBeDefined();
    expect(extraction.result).not.toHaveProperty('spoken_response');
    expect(vcr).toBeDefined();
    expect(vcr.utterance_id).toBe('utt-B');
    expect(entry.pendingExtractions.length).toBe(0);
  });
});
