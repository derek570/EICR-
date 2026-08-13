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

const { ElevenLabsStreamClient, contentTypeForFormat, synthWithLanguageFailOpen } =
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

// D1 (feedback id 121) — language pin.
describe('ElevenLabsStreamClient — language_code pin (D1)', () => {
  test('omitted languageCode defaults to en on the WS URL', () => {
    const client = new ElevenLabsStreamClient({ apiKey: 'k' });
    expect(client.languageCode).toBe('en');
    expect(client._buildUrl()).toContain('language_code=en');
  });

  test('explicit languageCode: null suppresses the param entirely', () => {
    const client = new ElevenLabsStreamClient({ apiKey: 'k', languageCode: null });
    expect(client.languageCode).toBeNull();
    expect(client._buildUrl()).not.toContain('language_code');
  });

  test('explicit languageCode overrides the default', () => {
    const client = new ElevenLabsStreamClient({ apiKey: 'k', languageCode: 'fr' });
    expect(client._buildUrl()).toContain('language_code=fr');
  });

  test('multi-context URL also carries the pin by default', () => {
    const client = new ElevenLabsStreamClient({ apiKey: 'k', multiContext: true });
    expect(client._buildUrl()).toContain('language_code=en');
  });

  test('vendor error frame rejection carries bytesReceived=0 when no audio arrived', async () => {
    const client = new ElevenLabsStreamClient({ apiKey: 'k' });
    const promise = client.synth('hello', { onAudio: () => {} });
    setImmediate(() => {
      const ws = FakeWS.instances[0];
      ws.emit('open');
      ws.emit('message', JSON.stringify({ error: 'invalid_language_code' }));
    });
    let caught;
    try {
      await promise;
    } catch (err) {
      caught = err;
    }
    expect(caught.bytesReceived).toBe(0);
    expect(caught.timings).toBeDefined();
  });

  test('vendor error frame AFTER audio carries bytesReceived>0 (not eligible for retry)', async () => {
    const client = new ElevenLabsStreamClient({ apiKey: 'k' });
    const promise = client.synth('hello', { onAudio: () => {} });
    setImmediate(() => {
      const ws = FakeWS.instances[0];
      ws.emit('open');
      ws.emit('message', JSON.stringify(audioFrame()));
      ws.emit('message', JSON.stringify({ error: 'mid_stream_failure' }));
    });
    let caught;
    try {
      await promise;
    } catch (err) {
      caught = err;
    }
    expect(caught.bytesReceived).toBe(3);
  });

  test('ws error event carries bytesReceived=0 before any audio', async () => {
    const client = new ElevenLabsStreamClient({ apiKey: 'k' });
    const promise = client.synth('hello', { onAudio: () => {} });
    setImmediate(() => {
      const ws = FakeWS.instances[0];
      ws.emit('open');
      ws.emit('error', new Error('handshake_rejected'));
    });
    let caught;
    try {
      await promise;
    } catch (err) {
      caught = err;
    }
    expect(caught.bytesReceived).toBe(0);
  });

  test('ws close-before-final carries bytesReceived=0 before any audio', async () => {
    const client = new ElevenLabsStreamClient({ apiKey: 'k' });
    const promise = client.synth('hello', { onAudio: () => {} });
    setImmediate(() => {
      const ws = FakeWS.instances[0];
      ws.emit('open');
      ws.emit('close', 1006, Buffer.from('abnormal'));
    });
    let caught;
    try {
      await promise;
    } catch (err) {
      caught = err;
    }
    expect(caught.bytesReceived).toBe(0);
  });

  test('timeout rejection does NOT carry bytesReceived (never retry-eligible)', async () => {
    const client = new ElevenLabsStreamClient({ apiKey: 'k', timeoutMs: 5 });
    const promise = client.synth('hello', { onAudio: () => {} });
    setImmediate(() => FakeWS.instances[0].emit('open'));
    let caught;
    try {
      await promise;
    } catch (err) {
      caught = err;
    }
    expect(caught.message).toMatch(/timeout/);
    expect(caught.bytesReceived).toBeUndefined();
  });

  test('abort rejection does NOT carry bytesReceived (never retry-eligible)', async () => {
    const client = new ElevenLabsStreamClient({ apiKey: 'k' });
    const ctrl = new AbortController();
    const promise = client.synth('hello', { onAudio: () => {}, signal: ctrl.signal });
    setImmediate(() => {
      FakeWS.instances[0].emit('open');
      setTimeout(() => ctrl.abort(), 5);
    });
    let caught;
    try {
      await promise;
    } catch (err) {
      caught = err;
    }
    expect(caught.bytesReceived).toBeUndefined();
  });
});

// D1 — shared fail-open two-attempt retry helper.
describe('synthWithLanguageFailOpen', () => {
  test('attempt 1 succeeds: returns timings, the same client, attempts=1, and the URL carries the pin', async () => {
    const client = new ElevenLabsStreamClient({ apiKey: 'k' });
    const retryClientFactory = jest.fn();
    const promise = synthWithLanguageFailOpen(client, retryClientFactory, 'hello', {
      onAudio: () => {},
    });
    setImmediate(() => {
      const ws = FakeWS.instances[0];
      ws.emit('open');
      sendFrames(ws, [audioFrame(), finalFrame()], 1);
    });
    const result = await promise;
    expect(result.attempts).toBe(1);
    expect(result.client).toBe(client);
    expect(FakeWS.instances[0].url).toContain('language_code=en');
    expect(retryClientFactory).not.toHaveBeenCalled();
  });

  test('attempt 1 rejects zero-bytes attributable → retries with a SECOND instance whose URL lacks the param; exactly two instances/attempts', async () => {
    const client = new ElevenLabsStreamClient({ apiKey: 'k' });
    let retryClient;
    const retryClientFactory = jest.fn(() => {
      retryClient = new ElevenLabsStreamClient({ apiKey: 'k', languageCode: null });
      return retryClient;
    });
    const promise = synthWithLanguageFailOpen(client, retryClientFactory, 'hello', {
      onAudio: () => {},
    });

    setImmediate(() => {
      const ws1 = FakeWS.instances[0];
      ws1.emit('open');
      ws1.emit('message', JSON.stringify({ error: 'invalid_language_code' }));
    });

    // Drive the second attempt once it opens.
    const driveSecond = setInterval(() => {
      if (FakeWS.instances.length === 2) {
        clearInterval(driveSecond);
        const ws2 = FakeWS.instances[1];
        ws2.emit('open');
        sendFrames(ws2, [audioFrame(), finalFrame()], 1);
      }
    }, 1);

    const result = await promise;
    expect(result.attempts).toBe(2);
    expect(result.client).toBe(retryClient);
    expect(FakeWS.instances.length).toBe(2);
    expect(FakeWS.instances[0].url).toContain('language_code=en');
    expect(FakeWS.instances[1].url).not.toContain('language_code');
    // A mock that merely rejects attempt one and lets a same-URL "attempt
    // two" pass would be caught here: instance count AND URL are both
    // asserted, not just the outcome.
    expect(retryClientFactory).toHaveBeenCalledTimes(1);
  });

  test('second failure after retry is terminal (throws, does not retry again)', async () => {
    const client = new ElevenLabsStreamClient({ apiKey: 'k' });
    const retryClientFactory = jest.fn(
      () => new ElevenLabsStreamClient({ apiKey: 'k', languageCode: null })
    );
    const promise = synthWithLanguageFailOpen(client, retryClientFactory, 'hello', {
      onAudio: () => {},
    });

    setImmediate(() => {
      FakeWS.instances[0].emit('open');
      FakeWS.instances[0].emit('message', JSON.stringify({ error: 'invalid_language_code' }));
    });
    const driveSecond = setInterval(() => {
      if (FakeWS.instances.length === 2) {
        clearInterval(driveSecond);
        FakeWS.instances[1].emit('open');
        FakeWS.instances[1].emit('message', JSON.stringify({ error: 'still_broken' }));
      }
    }, 1);

    await expect(promise).rejects.toThrow(/still_broken/);
    expect(FakeWS.instances.length).toBe(2);
    expect(retryClientFactory).toHaveBeenCalledTimes(1);
  });

  test('post-first-audio-byte error never retries', async () => {
    const client = new ElevenLabsStreamClient({ apiKey: 'k' });
    const retryClientFactory = jest.fn();
    const promise = synthWithLanguageFailOpen(client, retryClientFactory, 'hello', {
      onAudio: () => {},
    });
    setImmediate(() => {
      const ws = FakeWS.instances[0];
      ws.emit('open');
      ws.emit('message', JSON.stringify(audioFrame()));
      ws.emit('message', JSON.stringify({ error: 'mid_stream_failure' }));
    });
    await expect(promise).rejects.toThrow(/mid_stream_failure/);
    expect(retryClientFactory).not.toHaveBeenCalled();
    expect(FakeWS.instances.length).toBe(1);
  });

  test('timeout never retries (no bytesReceived on the error)', async () => {
    const client = new ElevenLabsStreamClient({ apiKey: 'k', timeoutMs: 5 });
    const retryClientFactory = jest.fn();
    const promise = synthWithLanguageFailOpen(client, retryClientFactory, 'hello', {
      onAudio: () => {},
    });
    setImmediate(() => FakeWS.instances[0].emit('open'));
    await expect(promise).rejects.toThrow(/timeout/);
    expect(retryClientFactory).not.toHaveBeenCalled();
    expect(FakeWS.instances.length).toBe(1);
  });
});
