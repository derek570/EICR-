/**
 * ElevenLabsStreamClient — stream byte budget (runaway-clip cap).
 *
 * Background (field sessions 3387D15C 2026-08-29, 1033B05D 2026-08-07,
 * 6B6FE011): eleven_flash_v2_5 occasionally returns the phrase followed by
 * many seconds of digital silence (108 KB / 27 s for a 28-char line). The
 * client now derives a byte budget from text length + output format and,
 * once exceeded, delivers only up to the budget, closes the socket, and
 * RESOLVES with `timings.capped = true` so every caller keeps its
 * completed path (the speech sits at the front of a runaway clip).
 *
 * Pins:
 *   - budget arithmetic per format (pcm / mp3 / ulaw / unknown → null)
 *   - a normal clip under budget is untouched (capped=false, no warn)
 *   - a runaway clip is cut at the budget byte, the socket is closed, the
 *     promise resolves (not rejects) with capped=true and a WARN row
 *   - maxBytes: null disables the cap
 */

import { jest } from '@jest/globals';
import { EventEmitter } from 'node:events';

class FakeWS extends EventEmitter {
  constructor(url, opts) {
    super();
    this.url = url;
    this.opts = opts;
    this.sent = [];
    this.closed = false;
    FakeWS.instances.push(this);
  }
  send(payload) {
    this.sent.push(JSON.parse(payload));
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      setImmediate(() => this.emit('close', 1000, Buffer.from('')));
    }
  }
}
FakeWS.instances = [];

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('ws', () => ({ default: FakeWS, WebSocket: FakeWS }));
jest.unstable_mockModule('../logger.js', () => ({ default: mockLogger }));

const { ElevenLabsStreamClient, ttsStreamByteBudget, bytesPerSecondForFormat } =
  await import('../extraction/elevenlabs-stream-client.js');

afterEach(() => {
  FakeWS.instances.length = 0;
  mockLogger.warn.mockClear();
});

function b64Bytes(n) {
  return Buffer.alloc(n, 1).toString('base64');
}

async function openAndSynth(client, text, opts = {}) {
  const chunks = [];
  const p = client.synth(text, { onAudio: (b) => chunks.push(b), ...opts });
  await new Promise((r) => setImmediate(r));
  const ws = FakeWS.instances[0];
  ws.emit('open');
  return { p, ws, chunks };
}

describe('ttsStreamByteBudget', () => {
  test('bytes per second per format', () => {
    expect(bytesPerSecondForFormat('pcm_22050')).toBe(44100);
    expect(bytesPerSecondForFormat('mp3_22050_32')).toBe(4000);
    expect(bytesPerSecondForFormat('mp3_44100_128')).toBe(16000);
    expect(bytesPerSecondForFormat('ulaw_8000')).toBe(8000);
    expect(bytesPerSecondForFormat('opus_48000')).toBeNull();
    expect(bytesPerSecondForFormat(undefined)).toBeNull();
  });

  test("today's runaway line: 28 chars at mp3_22050_32 caps at ~8.9 s, well under 108 KB", () => {
    const budget = ttsStreamByteBudget('earthing arrangement T N C S', 'mp3_22050_32');
    expect(budget).toBe(35761);
    expect(budget).toBeLessThan(108192);
    // …and comfortably above a normal rendering (~7 KB).
    expect(budget).toBeGreaterThan(7 * 1024 * 2);
  });

  test('floor 4 s, ceiling 30 s, unknown format → null', () => {
    expect(ttsStreamByteBudget('hi', 'pcm_22050')).toBe(4 * 44100);
    expect(ttsStreamByteBudget('x'.repeat(500), 'pcm_22050')).toBe(30 * 44100);
    expect(ttsStreamByteBudget('anything', 'opus_48000')).toBeNull();
  });
});

describe('ElevenLabsStreamClient.synth byte cap', () => {
  const text = 'earthing arrangement T N C S'; // budget 35761 @ mp3_22050_32

  test('normal clip under budget is untouched', async () => {
    const client = new ElevenLabsStreamClient({ apiKey: 'k', outputFormat: 'mp3_22050_32' });
    const { p, ws, chunks } = await openAndSynth(client, text);
    ws.emit('message', JSON.stringify({ audio: b64Bytes(4000) }));
    ws.emit('message', JSON.stringify({ audio: b64Bytes(3000) }));
    ws.emit('message', JSON.stringify({ isFinal: true }));
    const timings = await p;
    expect(timings.capped).toBe(false);
    expect(timings.bytes).toBe(7000);
    expect(chunks.reduce((n, b) => n + b.length, 0)).toBe(7000);
    expect(mockLogger.warn).not.toHaveBeenCalledWith('elevenlabs_stream_capped', expect.anything());
  });

  test('runaway clip is cut at the budget byte, socket closed, promise RESOLVES capped', async () => {
    const client = new ElevenLabsStreamClient({ apiKey: 'k', outputFormat: 'mp3_22050_32' });
    const { p, ws, chunks } = await openAndSynth(client, text);
    // 2 s of speech, then silence frames arriving forever.
    ws.emit('message', JSON.stringify({ audio: b64Bytes(8000) }));
    for (let i = 0; i < 20; i++) ws.emit('message', JSON.stringify({ audio: b64Bytes(10000) }));
    const timings = await p;
    expect(timings.capped).toBe(true);
    expect(timings.bytes).toBe(35761);
    expect(chunks.reduce((n, b) => n + b.length, 0)).toBe(35761);
    expect(ws.closed).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'elevenlabs_stream_capped',
      expect.objectContaining({
        text_length: text.length,
        output_format: 'mp3_22050_32',
        budget_bytes: 35761,
        delivered_bytes: 35761,
      })
    );
    // Frames after the cap are ignored (socket closed, promise settled).
    expect(timings.audioFrames).toBe(4);
  });

  test('a frame that lands exactly on the budget is not capped', async () => {
    const client = new ElevenLabsStreamClient({ apiKey: 'k', outputFormat: 'mp3_22050_32' });
    const { p, ws } = await openAndSynth(client, text);
    ws.emit('message', JSON.stringify({ audio: b64Bytes(35761) }));
    ws.emit('message', JSON.stringify({ isFinal: true }));
    const timings = await p;
    expect(timings.capped).toBe(false);
    expect(timings.bytes).toBe(35761);
  });

  test('maxBytes: null disables the cap', async () => {
    const client = new ElevenLabsStreamClient({ apiKey: 'k', outputFormat: 'mp3_22050_32' });
    const { p, ws } = await openAndSynth(client, text, { maxBytes: null });
    ws.emit('message', JSON.stringify({ audio: b64Bytes(200000) }));
    ws.emit('message', JSON.stringify({ isFinal: true }));
    const timings = await p;
    expect(timings.capped).toBe(false);
    expect(timings.bytes).toBe(200000);
  });

  test('unknown output format → no cap', async () => {
    const client = new ElevenLabsStreamClient({ apiKey: 'k', outputFormat: 'opus_48000' });
    const { p, ws } = await openAndSynth(client, text);
    ws.emit('message', JSON.stringify({ audio: b64Bytes(200000) }));
    ws.emit('message', JSON.stringify({ isFinal: true }));
    const timings = await p;
    expect(timings.capped).toBe(false);
  });
});
