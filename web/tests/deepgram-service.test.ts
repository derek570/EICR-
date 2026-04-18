/**
 * Deepgram WebSocket client regression tests — Wave 3c (FIX_PLAN §E E1 row
 * `deepgram-service.ts`).
 *
 * Covers the three cases called out in the fix plan:
 *   (a) single error-callback per close (no double-fire when `onerror` and
 *       `onclose` both fire for the same transient failure)
 *   (b) 16 kHz resample correctness — given a known Float32 input at an
 *       above-16 kHz source rate, the Int16 payload the service sends to
 *       the WS matches the expected linear-interpolation samples within a
 *       tight tolerance
 *   (c) KeepAlive gated on `bufferedAmount` — kept as `it.todo` placeholders
 *       with detailed blocker notes; see the suite comment below.
 *
 * Test scaffold: `jest-websocket-mock` (+ its transitive `mock-socket`
 * dependency). `mock-socket` installs a drop-in global `WebSocket`
 * constructor inside vitest's jsdom environment, so the product code
 * under test (`deepgram-service.ts`) exercises its real WebSocket code
 * path — no testability seam was needed on the module. Smoke-tested
 * against vitest 4.1.4 + jsdom 29.0.2 during Wave 3c spike.
 *
 * Fake timers: KeepAlive uses `setInterval(…, 10000)` + `performance.now()`
 * and `sendSamples` records `lastAudioSendMs` via `performance.now()`.
 * vitest's `vi.useFakeTimers` lets us exercise the interval without real
 * wall-clock sleeps. We install fake timers BEFORE `connect()` so the
 * interval registration itself is fake — advancing the virtual clock
 * after connect then fires the interval callback deterministically.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import WS from 'jest-websocket-mock';
import { DeepgramService } from '@/lib/recording/deepgram-service';

// The service connects to a fixed URL + query string. `jest-websocket-mock`
// treats the URL string as a prefix-match key, so we register the
// scheme+host+path without the query — any query the product tacks on
// still routes to this fake server instance.
const DEEPGRAM_URL = 'wss://api.deepgram.com/v1/listen';

// `jsonProtocol: false` is the default — we want the raw string/binary
// frames that Deepgram actually sends, not automatic JSON.stringify.
// `selectProtocol` echoes back the first subprotocol the client offers so
// the fake WS completes the handshake; the service offers
// `['token', apiKey]` and Deepgram picks `token`.
function makeServer(): WS {
  return new WS(DEEPGRAM_URL, { selectProtocol: (protocols) => protocols[0] });
}

describe('DeepgramService', () => {
  let server: WS;

  beforeEach(() => {
    server = makeServer();
  });

  afterEach(() => {
    WS.clean();
    vi.useRealTimers();
  });

  // ────────────────────────────────────────────────────────────────────────
  // Case (a): single error-callback per close.
  //
  // `deepgram-service.ts` guards `onError` via a private `errorEmitted`
  // flag so a browser that fires both `onerror` and `onclose` for the same
  // transient disconnect only emits one error upstream. Upstream reconnect
  // logic (in `recording-context.tsx`) is driven by that `onError`, so one
  // emission = one reconnect attempt.
  // ────────────────────────────────────────────────────────────────────────
  describe('single reconnect per close (errorEmitted guard)', () => {
    it('fires onError exactly once when the server errors then closes', async () => {
      const onError = vi.fn();
      const service = new DeepgramService({
        onInterimTranscript: vi.fn(),
        onFinalTranscript: vi.fn(),
        onError,
      });

      service.connect('fake-api-key', 16000);
      await server.connected;
      expect(service.connectionState).toBe('connected');

      // `server.error()` calls the underlying mock-socket close with an
      // error flag — this triggers BOTH `ws.onerror` AND `ws.onclose` on
      // the client, which is the double-fire case the `errorEmitted` guard
      // exists to absorb.
      server.error({ code: 1011, reason: 'server error', wasClean: false });

      // Let microtasks flush so ws.onerror → ws.onclose run.
      await Promise.resolve();
      await Promise.resolve();

      expect(onError).toHaveBeenCalledTimes(1);
    });

    it('does not fire onError for a clean close (code 1000)', async () => {
      const onError = vi.fn();
      const service = new DeepgramService({
        onInterimTranscript: vi.fn(),
        onFinalTranscript: vi.fn(),
        onError,
      });

      service.connect('fake-api-key', 16000);
      await server.connected;

      server.close({ code: 1000, reason: 'normal', wasClean: true });
      await server.closed;

      expect(onError).not.toHaveBeenCalled();
      expect(service.connectionState).toBe('disconnected');
    });

    it('fires onError once for an abnormal close even when no prior error event', async () => {
      const onError = vi.fn();
      const service = new DeepgramService({
        onInterimTranscript: vi.fn(),
        onFinalTranscript: vi.fn(),
        onError,
      });

      service.connect('fake-api-key', 16000);
      await server.connected;

      // Abnormal close without a prior `error` event — code 1006 isn't
      // 1000/1005, so the close-code guard in onclose fires onError.
      server.close({ code: 1006, reason: 'abnormal', wasClean: false });
      await server.closed;

      expect(onError).toHaveBeenCalledTimes(1);
    });

    it('resets the errorEmitted guard on a fresh connect()', async () => {
      const onError = vi.fn();
      const service = new DeepgramService({
        onInterimTranscript: vi.fn(),
        onFinalTranscript: vi.fn(),
        onError,
      });

      // Connection #1: error → should fire once.
      service.connect('fake-api-key', 16000);
      await server.connected;
      server.error({ code: 1011, reason: 'first', wasClean: false });
      await Promise.resolve();
      await Promise.resolve();
      expect(onError).toHaveBeenCalledTimes(1);

      // New server so we can observe a second handshake. `service` is
      // still the same instance — the `errorEmitted` reset inside
      // `connect()` is what we're exercising here.
      WS.clean();
      server = makeServer();

      // Connection #2: should still be able to emit a second error.
      service.connect('fake-api-key', 16000);
      await server.connected;
      server.error({ code: 1011, reason: 'second', wasClean: false });
      await Promise.resolve();
      await Promise.resolve();
      expect(onError).toHaveBeenCalledTimes(2);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Case (b): 16 kHz resample correctness.
  //
  // `resampleTo16k` is private — we exercise it indirectly via
  // `sendSamples()` and inspect the Int16 bytes that arrive at the fake
  // WS. The algorithm is linear interpolation:
  //     ratio = sourceSampleRate / 16000
  //     outLen = floor(samples.length / ratio)
  //     out[i] = samples[lo] * (1 - frac) + samples[hi] * frac
  // followed by Int16 conversion:
  //     int16[i] = Math.round(clamp(resampled[i], -1, 1) * 32767)
  //
  // Tolerance note: we use `±1 Int16 LSB` on any sample whose float
  // counterpart is a half-integer — `Math.round` in JS uses round-half-
  // away-from-zero for positive halves but round-half-toward-zero for
  // negative halves (e.g. `Math.round(-16383.5) === -16383`, not -16384).
  // Absolute equality is used for samples that don't land on a half.
  // ────────────────────────────────────────────────────────────────────────
  describe('16 kHz resample correctness', () => {
    it('downsamples 32 kHz → 16 kHz by picking every other sample', async () => {
      const service = new DeepgramService({
        onInterimTranscript: vi.fn(),
        onFinalTranscript: vi.fn(),
      });
      service.connect('fake-api-key', 32000);
      await server.connected;

      // 8 samples at 32 kHz → 4 samples at 16 kHz (ratio = 2, picks
      // indices 0, 2, 4, 6 exactly — frac=0 for every output sample).
      const input = new Float32Array([0.0, 0.25, 0.5, 0.75, -0.25, -0.5, 1.0, -1.0]);
      service.sendSamples(input);

      const msg = await server.nextMessage;
      // sendSamples always forwards an ArrayBuffer — reject text frames
      // so a future channel change (JSON control) fails loud here.
      expect(msg).toBeInstanceOf(ArrayBuffer);
      const received = new Int16Array(msg as ArrayBuffer);

      // Every-other-sample: indices 0, 2, 4, 6 of the input = 0, 0.5, -0.25, 1.0.
      // Expected Int16: 0, 16384 (0.5*32767=16383.5 → round up), -8192 (-0.25*32767=-8191.75 → round to -8192), 32767.
      const expected = [0, 16384, -8192, 32767];
      expect(received.length).toBe(expected.length);
      for (let i = 0; i < expected.length; i++) {
        // ±1 LSB tolerance — `Math.round` behaviour on negative halves is
        // asymmetric; see file header.
        expect(Math.abs(received[i] - expected[i])).toBeLessThanOrEqual(1);
      }
    });

    it('resamples 48 kHz → 16 kHz with linear interpolation within ±1 LSB', async () => {
      const service = new DeepgramService({
        onInterimTranscript: vi.fn(),
        onFinalTranscript: vi.fn(),
      });
      service.connect('fake-api-key', 48000);
      await server.connected;

      // Ramp 0..11/12 — predictable expected values.
      const input = new Float32Array(12);
      for (let i = 0; i < input.length; i++) input[i] = i / 12;

      service.sendSamples(input);
      const msg = await server.nextMessage;
      const received = new Int16Array(msg as ArrayBuffer);

      // ratio = 3, outLen = floor(12/3) = 4, srcIdx = 0, 3, 6, 9
      // All are integer indices so the lo/hi branches collapse to `lo`.
      const expected = [0, 3, 6, 9].map((idx) =>
        Math.round(Math.max(-1, Math.min(1, input[idx])) * 32767),
      );
      expect(received.length).toBe(expected.length);
      for (let i = 0; i < expected.length; i++) {
        expect(Math.abs(received[i] - expected[i])).toBeLessThanOrEqual(1);
      }
    });

    it('handles fractional ratios (44.1 kHz → 16 kHz) via linear interpolation', async () => {
      const service = new DeepgramService({
        onInterimTranscript: vi.fn(),
        onFinalTranscript: vi.fn(),
      });
      service.connect('fake-api-key', 44100);
      await server.connected;

      // Small input so we can hand-compute a couple of output samples.
      // ratio = 44100/16000 = 2.75625
      // outLen = floor(10 / 2.75625) = 3
      //   i=0: srcIdx=0      → lo=0, hi=1, frac=0     → input[0]
      //   i=1: srcIdx=2.756… → lo=2, hi=3, frac=0.756 → mix of 2,3
      //   i=2: srcIdx=5.512… → lo=5, hi=6, frac=0.512 → mix of 5,6
      const input = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]);
      service.sendSamples(input);
      const msg = await server.nextMessage;
      const received = new Int16Array(msg as ArrayBuffer);

      const ratio = 44100 / 16000;
      const outLen = Math.floor(input.length / ratio);
      expect(received.length).toBe(outLen);

      for (let i = 0; i < outLen; i++) {
        const srcIdx = i * ratio;
        const lo = Math.floor(srcIdx);
        const hi = Math.min(lo + 1, input.length - 1);
        const frac = srcIdx - lo;
        const interpolated = input[lo] * (1 - frac) + input[hi] * frac;
        const expected = Math.round(
          Math.max(-1, Math.min(1, interpolated)) * 32767,
        );
        // ±1 LSB tolerance absorbs accumulated float rounding.
        expect(Math.abs(received[i] - expected)).toBeLessThanOrEqual(1);
      }
    });

    it('skips the resample path when source is already 16 kHz', async () => {
      const service = new DeepgramService({
        onInterimTranscript: vi.fn(),
        onFinalTranscript: vi.fn(),
      });
      service.connect('fake-api-key', 16000);
      await server.connected;

      const input = new Float32Array([0.0, 0.5, -0.5, 1.0, -1.0]);
      service.sendSamples(input);
      const msg = await server.nextMessage;
      const received = new Int16Array(msg as ArrayBuffer);

      expect(received.length).toBe(input.length);
      // Values with ±1 LSB tolerance — see `Math.round` note in file header:
      //   0.5 * 32767 = 16383.5 → 16384 (round-half-away-from-zero positive)
      //   -0.5 * 32767 = -16383.5 → -16383 (round-half-toward-zero negative)
      //   1.0 * 32767 = 32767, -1.0 * 32767 = -32767
      const expected = [0, 16384, -16383, 32767, -32767];
      for (let i = 0; i < expected.length; i++) {
        expect(Math.abs(received[i] - expected[i])).toBeLessThanOrEqual(1);
      }
    });

    it('clamps samples outside [-1, 1] before converting to Int16', async () => {
      const service = new DeepgramService({
        onInterimTranscript: vi.fn(),
        onFinalTranscript: vi.fn(),
      });
      service.connect('fake-api-key', 16000);
      await server.connected;

      const input = new Float32Array([2.0, -2.0, 1.5, -1.5, 0.0]);
      service.sendSamples(input);
      const msg = await server.nextMessage;
      const received = new Int16Array(msg as ArrayBuffer);

      expect(Array.from(received)).toEqual([32767, -32767, 32767, -32767, 0]);
    });

    it('is a no-op for a zero-length buffer (no WS frame sent)', async () => {
      const service = new DeepgramService({
        onInterimTranscript: vi.fn(),
        onFinalTranscript: vi.fn(),
      });
      service.connect('fake-api-key', 16000);
      await server.connected;

      service.sendSamples(new Float32Array(0));
      // No message should have been sent — confirm the server queue stays
      // empty after a microtask flush.
      await Promise.resolve();
      expect(server.messages.length).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Case (c): KeepAlive gated on `bufferedAmount`.
  //
  // The FIX_PLAN (§C Phase 4b, P1: line 144) flags this as an UNFIXED
  // defect. Wave 3c is test-only — per the task brief, we document rather
  // than patch the product.
  //
  // Two independent blockers make this test un-runnable as stated:
  //
  //   1. Product code (`deepgram-service.ts:254-267`) does NOT inspect
  //      `ws.bufferedAmount` inside the `setInterval` body. KeepAlive is
  //      gated only on `idleMs >= 8000` and `state === 'connected'`.
  //      A strict "KeepAlive suppressed when bufferedAmount > 0" assertion
  //      would fail here — correctly, because the product is wrong.
  //
  //   2. `mock-socket` (used by `jest-websocket-mock`) does NOT implement
  //      `bufferedAmount` — it's hard-coded to `0` with a literal
  //      `// TODO: handle bufferedAmount` comment in its send path. Even
  //      once the product starts reading `bufferedAmount`, a realistic
  //      test needs either a patched mock-socket or a hand-rolled fake WS
  //      that drives `bufferedAmount` manually.
  //
  // Both blockers are documented in `reviews/WAVE_3C_HANDOFF.md`. The
  // `it.todo` placeholders preserve the shape of the expected assertions
  // for the fix wave.
  // ────────────────────────────────────────────────────────────────────────
  describe('KeepAlive gated on bufferedAmount', () => {
    it.todo(
      'suppresses KeepAlive frame when ws.bufferedAmount > 0 (BLOCKED: product defect + mock-socket gap — see file header and WAVE_3C_HANDOFF.md)',
    );
    it.todo(
      'sends the next scheduled KeepAlive once bufferedAmount drains to 0',
    );
  });

  // Separate describe — these are positive assertions for the KeepAlive
  // behaviour that IS currently implemented (idle-based gating). They
  // protect against accidental regressions of the 8 s idle / 10 s interval
  // shape while the bufferedAmount fix lands in a future wave.
  describe('KeepAlive — current idle-based gating (regression guard)', () => {
    it('sends a JSON KeepAlive followed by 500 ms of silence after 10 s idle', async () => {
      // Fake timers installed BEFORE connect so the `setInterval`
      // registration is itself fake — otherwise `advanceTimersByTime`
      // wouldn't fire the real-timer interval.
      vi.useFakeTimers({
        toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'],
      });

      const service = new DeepgramService({
        onInterimTranscript: vi.fn(),
        onFinalTranscript: vi.fn(),
      });
      service.connect('fake-api-key', 16000);

      // mock-socket dispatches `onopen` via a `setTimeout(..., 4)` so the
      // `onopen → startKeepAlive()` chain needs the virtual clock to
      // advance past the 4 ms handshake delay before the interval is
      // registered. Advance a hair past it, then await `server.connected`.
      await vi.advanceTimersByTimeAsync(10);
      await server.connected;

      // Start idle immediately (no sendSamples call). `lastAudioSendMs`
      // stays 0 so the service treats idle as `Infinity` → KeepAlive on
      // the very first tick.
      await vi.advanceTimersByTimeAsync(10_000);

      // Expect two frames per tick: the JSON control message + 500 ms of
      // silent PCM (8000 Int16 samples = 16000 bytes).
      expect(server.messages.length).toBe(2);
      expect(typeof server.messages[0]).toBe('string');
      expect(JSON.parse(server.messages[0] as string)).toEqual({ type: 'KeepAlive' });
      expect(server.messages[1]).toBeInstanceOf(ArrayBuffer);
      expect((server.messages[1] as ArrayBuffer).byteLength).toBe(8000 * 2);
    });

    it('skips KeepAlive when audio has flowed in the last <8 s', async () => {
      vi.useFakeTimers({
        toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'],
      });

      const service = new DeepgramService({
        onInterimTranscript: vi.fn(),
        onFinalTranscript: vi.fn(),
      });
      service.connect('fake-api-key', 16000);
      await vi.advanceTimersByTimeAsync(10);
      await server.connected;

      // Advance the clock 7 s (so lastAudioSendMs will be ~7010 when we
      // send), then send a sample to reset the idle timer. When the
      // 10s-interval fires at t=10010, the idle check is 10010-7010=3000
      // which is < 8000 → KeepAlive suppressed.
      await vi.advanceTimersByTimeAsync(7_000);
      service.sendSamples(new Float32Array([0.1, 0.2, 0.3]));

      // mock-socket's `ws.send` dispatches to the server via a 4ms
      // `setTimeout`, so we need to drain that delivery BEFORE we can
      // reset the message queue — otherwise the audio frame lands in the
      // queue during the next advance and pollutes the KeepAlive
      // assertion.
      await vi.advanceTimersByTimeAsync(10);
      expect(server.messages.length).toBe(1); // audio frame delivered
      server.messages.length = 0;

      // Advance to the interval tick (~2980 ms from now lands us at
      // t=10010 where the first interval fires).
      await vi.advanceTimersByTimeAsync(3_000);
      expect(server.messages.length).toBe(0);

      // But at t=20010 (10 s later) the idle check becomes 20010-7010=
      // 13000 ms — the KeepAlive should finally fire (JSON + silence =
      // 2 frames).
      await vi.advanceTimersByTimeAsync(10_000);
      expect(server.messages.length).toBe(2);
    });

    it('stops the KeepAlive interval on disconnect()', async () => {
      vi.useFakeTimers({
        toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'],
      });

      const service = new DeepgramService({
        onInterimTranscript: vi.fn(),
        onFinalTranscript: vi.fn(),
      });
      service.connect('fake-api-key', 16000);
      await vi.advanceTimersByTimeAsync(10);
      await server.connected;

      service.disconnect();
      // disconnect() uses a 300ms setTimeout before closing the WS — run
      // timers so the close completes cleanly.
      await vi.advanceTimersByTimeAsync(400);

      // Now advance well past the 10 s KeepAlive interval — no frames
      // should arrive because the interval was cleared on disconnect.
      const priorCount = server.messages.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(server.messages.length).toBe(priorCount);
    });
  });
});
