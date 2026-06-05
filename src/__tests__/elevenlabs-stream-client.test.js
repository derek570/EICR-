/**
 * ElevenLabsStreamClient — contract tests (no live vendor calls).
 *
 * We mock the `ws` module so the test exercises the WS lifecycle +
 * message handling without hitting ElevenLabs. The bench scripts in
 * scripts/voice-latency-bench/ already cover the live-vendor behaviour;
 * here we pin the protocol shape + error paths so future refactors
 * can't silently drop a `text:""` EOS or invert the multi-context
 * `context_id` routing.
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
      // emit close async so the consumer's resolve/reject can race
      setImmediate(() => this.emit('close', 1000, Buffer.from('')));
    }
  }
}
FakeWS.instances = [];
FakeWS.reset = () => {
  FakeWS.instances.length = 0;
};

jest.unstable_mockModule('ws', () => ({ default: FakeWS, WebSocket: FakeWS }));
jest.unstable_mockModule('../logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { ElevenLabsStreamClient, contentTypeForFormat } =
  await import('../extraction/elevenlabs-stream-client.js');

afterEach(() => FakeWS.reset());

function audioFrame(b64 = 'YWJj') {
  return { audio: b64 };
}
function finalFrame(contextId = undefined) {
  return contextId !== undefined ? { isFinal: true, contextId } : { isFinal: true };
}
function sendFrames(ws, frames, gapMs = 1) {
  let t = 0;
  for (const f of frames) {
    setTimeout(() => ws.emit('message', JSON.stringify(f)), (t += gapMs));
  }
}

describe('contentTypeForFormat', () => {
  test('pcm_22050 → audio/L16 with the right rate', () => {
    expect(contentTypeForFormat('pcm_22050')).toBe('audio/L16; rate=22050; channels=1');
  });
  test('mp3_22050_32 → audio/mpeg', () => {
    expect(contentTypeForFormat('mp3_22050_32')).toBe('audio/mpeg');
  });
  test('unknown format → audio/L16 default? No — octet-stream', () => {
    expect(contentTypeForFormat('weird_format')).toBe('application/octet-stream');
  });
  test('non-string defensive default', () => {
    expect(contentTypeForFormat(null)).toBe('application/octet-stream');
    expect(contentTypeForFormat(undefined)).toBe('application/octet-stream');
  });
});

describe('ElevenLabsStreamClient — single-shot stream-input', () => {
  test('opens WS, sends BOS + text + EOS in order', async () => {
    const client = new ElevenLabsStreamClient({ apiKey: 'k' });
    const chunks = [];
    const promise = client.synth('hello world', { onAudio: (b) => chunks.push(b) });

    // Driver: emit 'open', server-side messages, isFinal.
    setImmediate(() => {
      const ws = FakeWS.instances[0];
      ws.emit('open');
      sendFrames(ws, [audioFrame(), audioFrame('ZGVm'), finalFrame()], 1);
    });

    const timings = await promise;
    expect(timings.audioFrames).toBe(2);
    expect(timings.bytes).toBe(6); // 'abc' (3) + 'def' (3)
    const ws = FakeWS.instances[0];
    expect(ws.sent.length).toBe(3);
    expect(ws.sent[0]).toEqual({ text: ' ', voice_settings: expect.any(Object) });
    expect(ws.sent[1]).toEqual({ text: 'hello world', try_trigger_generation: true });
    expect(ws.sent[2]).toEqual({ text: '' });
  });

  test('rejects non-empty text', async () => {
    const client = new ElevenLabsStreamClient({ apiKey: 'k' });
    await expect(client.synth('   ', { onAudio: () => {} })).rejects.toThrow(/non-empty text/);
    await expect(client.synth('', { onAudio: () => {} })).rejects.toThrow(/non-empty text/);
  });

  test('throws when onAudio missing', () => {
    const client = new ElevenLabsStreamClient({ apiKey: 'k' });
    expect(() => client.synth('hello', {})).toThrow(/onAudio/);
  });

  test('throws when apiKey missing', () => {
    expect(() => new ElevenLabsStreamClient({})).toThrow(/apiKey/);
  });

  test('vendor error frame rejects + calls onError', async () => {
    const client = new ElevenLabsStreamClient({ apiKey: 'k' });
    const onError = jest.fn();
    const promise = client.synth('hello', { onAudio: () => {}, onError });
    setImmediate(() => {
      const ws = FakeWS.instances[0];
      ws.emit('open');
      ws.emit('message', JSON.stringify({ error: 'invalid_text' }));
    });
    await expect(promise).rejects.toThrow(/invalid_text/);
    expect(onError).toHaveBeenCalled();
  });

  test('ws.close before isFinal rejects', async () => {
    const client = new ElevenLabsStreamClient({ apiKey: 'k' });
    const promise = client.synth('hello', { onAudio: () => {} });
    setImmediate(() => {
      const ws = FakeWS.instances[0];
      ws.emit('open');
      ws.emit('close', 1006, Buffer.from('abnormal'));
    });
    await expect(promise).rejects.toThrow(/closed_before_final/);
  });

  test('AbortSignal aborts in-flight synth', async () => {
    const client = new ElevenLabsStreamClient({ apiKey: 'k' });
    const ctrl = new AbortController();
    const promise = client.synth('hello', { onAudio: () => {}, signal: ctrl.signal });
    setImmediate(() => {
      const ws = FakeWS.instances[0];
      ws.emit('open');
      // never send any audio; abort
      setTimeout(() => ctrl.abort(), 10);
    });
    await expect(promise).rejects.toThrow(/aborted/);
  });

  test('onAudio throwing rejects the synth', async () => {
    const client = new ElevenLabsStreamClient({ apiKey: 'k' });
    const promise = client.synth('hello', {
      onAudio: () => {
        throw new Error('consumer_problem');
      },
    });
    setImmediate(() => {
      const ws = FakeWS.instances[0];
      ws.emit('open');
      ws.emit('message', JSON.stringify(audioFrame()));
    });
    await expect(promise).rejects.toThrow(/consumer_problem/);
  });
});

describe('ElevenLabsStreamClient — multi-context', () => {
  test('multi-context requires contextId', async () => {
    const client = new ElevenLabsStreamClient({ apiKey: 'k', multiContext: true });
    await expect(client.synth('hello', { onAudio: () => {} })).rejects.toThrow(
      /contextId required/
    );
  });

  test('multi-context BOS + text + close_context use context_id', async () => {
    const client = new ElevenLabsStreamClient({ apiKey: 'k', multiContext: true });
    const promise = client.synth('hello', { onAudio: () => {}, contextId: 'ctx_a' });
    setImmediate(() => {
      const ws = FakeWS.instances[0];
      ws.emit('open');
      sendFrames(ws, [audioFrame(), finalFrame('ctx_a')], 1);
    });
    await promise;
    const ws = FakeWS.instances[0];
    expect(ws.sent.length).toBe(3);
    expect(ws.sent[0]).toEqual({
      text: ' ',
      context_id: 'ctx_a',
      voice_settings: expect.any(Object),
    });
    expect(ws.sent[1]).toEqual({ text: 'hello', context_id: 'ctx_a', flush: true });
    expect(ws.sent[2]).toEqual({ context_id: 'ctx_a', close_context: true });
  });

  test('multi-context drops frames for OTHER contexts', async () => {
    const client = new ElevenLabsStreamClient({ apiKey: 'k', multiContext: true });
    const chunks = [];
    const promise = client.synth('hello', {
      onAudio: (b) => chunks.push(b),
      contextId: 'ctx_target',
    });
    setImmediate(() => {
      const ws = FakeWS.instances[0];
      ws.emit('open');
      // Send a frame tagged for ctx_other — must be ignored.
      ws.emit('message', JSON.stringify({ audio: 'YWJj', contextId: 'ctx_other' }));
      ws.emit('message', JSON.stringify({ audio: 'ZGVm', contextId: 'ctx_target' }));
      ws.emit('message', JSON.stringify({ isFinal: true, contextId: 'ctx_target' }));
    });
    await promise;
    expect(chunks.length).toBe(1);
    expect(chunks[0].toString()).toBe('def');
  });

  test('multi-context URL uses multi-stream-input path', async () => {
    const client = new ElevenLabsStreamClient({ apiKey: 'k', multiContext: true });
    const promise = client.synth('hello', { onAudio: () => {}, contextId: 'ctx_a' });
    setImmediate(() => {
      const ws = FakeWS.instances[0];
      ws.emit('open');
      sendFrames(ws, [audioFrame(), finalFrame('ctx_a')], 1);
    });
    await promise;
    const ws = FakeWS.instances[0];
    expect(ws.url).toContain('multi-stream-input');
    expect(ws.url).not.toContain('/stream-input?');
  });
});

describe('ElevenLabsStreamClient — fromConfig', () => {
  test('reads VOICE_LATENCY_USE_MULTI_CONTEXT from env', () => {
    const a = ElevenLabsStreamClient.fromConfig({
      apiKey: 'k',
      env: { VOICE_LATENCY_USE_MULTI_CONTEXT: 'true' },
    });
    expect(a.multiContext).toBe(true);
    const b = ElevenLabsStreamClient.fromConfig({ apiKey: 'k', env: {} });
    expect(b.multiContext).toBe(false);
  });
});
