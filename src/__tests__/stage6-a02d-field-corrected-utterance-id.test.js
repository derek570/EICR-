/**
 * A02D (2026-09-09) — standalone `field_corrected` frames carry the additive
 * optional `utterance_id` of the utterance that fed the turn, so a client can
 * place its clear/replacement cutoff on the CAUSATIVE final. Absent when the
 * result carries none (pre-A02D bytes unchanged). Driven through the real
 * reconnect-flush ledger of `initSonnetStream` (the single emitter of these
 * frames), mirroring stage6-clear-board-reading-wire.test.js.
 */

import { jest } from '@jest/globals';

jest.unstable_mockModule('@anthropic-ai/sdk', () => ({
  default: jest.fn(() => ({ messages: { create: jest.fn(async () => ({ content: [] })) } })),
}));
jest.unstable_mockModule('../logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../storage.js', () => ({ uploadJson: jest.fn(async () => {}) }));

const { initSonnetStream, activeSessions } = await import('../extraction/sonnet-stream.js');
const { sonnetSessionStore } = await import('../extraction/sonnet-session-store.js');

function makeFakeWs() {
  const sent = [];
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: jest.fn((payload, cb) => {
      sent.push(JSON.parse(payload));
      cb?.();
    }),
    ping: jest.fn(),
    close: jest.fn(),
    on: jest.fn(),
    _handlers: new Map(),
  };
  Object.defineProperty(ws.send, 'length', { value: 2 });
  ws.on.mockImplementation((event, handler) => ws._handlers.set(event, handler));
  ws._sent = sent;
  ws._emit = async (event, data) => ws._handlers.get(event)(data);
  return ws;
}

function clearResult(utteranceId) {
  return {
    extracted_readings: [],
    observations: [],
    questions: [],
    ...(utteranceId ? { utterance_id: utteranceId } : {}),
    field_corrections: [
      {
        type: 'field_corrected',
        circuit: null,
        field: 'ze',
        previous_value: '0.4',
        reason: 'clear_reading',
        board_id: 'main',
      },
      {
        type: 'field_corrected',
        circuit: 4,
        field: 'measured_zs_ohm',
        previous_value: '0.55',
        reason: 'clear_reading',
        utterance_id: 'utt-explicit',
      },
    ],
    spoken_response: 'Ze cleared.',
    action: null,
  };
}

let wss;
beforeEach(() => {
  activeSessions.clear();
  sonnetSessionStore.clear();
  wss = initSonnetStream(null, async () => 'fake-key', jest.fn());
});
afterEach(() => {
  for (const entry of activeSessions.values()) {
    try {
      entry?.session?.stop?.();
    } catch {
      /* teardown only */
    }
  }
  activeSessions.clear();
  sonnetSessionStore.clear();
});

async function startSession() {
  const ws = makeFakeWs();
  wss.emit('connection', ws, { headers: {} }, 'user-1');
  await ws._emit(
    'message',
    Buffer.from(
      JSON.stringify({ type: 'session_start', sessionId: 'sess-a02d-uid', jobState: { certificateType: 'eicr' } })
    )
  );
  return { ws, entry: activeSessions.get('sess-a02d-uid') };
}

describe('[invariant] A02D — field_corrected frames echo the causative utterance_id', () => {
  test('a result with utterance_id stamps every standalone field_corrected frame that lacks one; an explicit one is kept', async () => {
    const { entry } = await startSession();
    entry.pendingExtractions.push(clearResult('utt-F2'));
    const { ws } = await startSession();
    const frames = ws._sent.filter((m) => m.type === 'field_corrected');
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ field: 'ze', board_id: 'main', utterance_id: 'utt-F2' });
    expect(frames[1]).toMatchObject({ field: 'measured_zs_ohm', circuit: 4, utterance_id: 'utt-explicit' });
    // The VCR keeps echoing the same id (unchanged contract).
    expect(ws._sent.find((m) => m.type === 'voice_command_response').utterance_id).toBe('utt-F2');
  });

  test('[current_behaviour] a result WITHOUT utterance_id emits byte-identical pre-A02D frames (no key)', async () => {
    const { entry } = await startSession();
    entry.pendingExtractions.push(clearResult(null));
    const { ws } = await startSession();
    const frames = ws._sent.filter((m) => m.type === 'field_corrected');
    expect(frames).toHaveLength(2);
    expect('utterance_id' in frames[0]).toBe(false);
    expect(frames[1].utterance_id).toBe('utt-explicit');
  });
});
