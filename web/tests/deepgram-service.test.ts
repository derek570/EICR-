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
// `['bearer', apiKey]` (JWT auth from /v1/auth/grant) and Deepgram picks
// `bearer`.
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
        Math.round(Math.max(-1, Math.min(1, input[idx])) * 32767)
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
        const expected = Math.round(Math.max(-1, Math.min(1, interpolated)) * 32767);
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
  // Wave 3f landed both the product fix and a constructor-level WS seam
  // on DeepgramService so these assertions are now exercisable. The
  // seam is necessary because `mock-socket` hard-codes
  // `bufferedAmount = 0` — without a way to inject a WS whose
  // `bufferedAmount` is mutable, no test can observe the gate.
  //
  // Fake WS: minimum-viable subclass of EventTarget exposing the subset
  // of the WebSocket interface DeepgramService actually calls. Has a
  // publicly mutable `bufferedAmount` + `readyState` so the test can
  // drive backpressure from the outside. Keeps the surface small (~50
  // lines) per the Wave 3c hand-off recommendation; the alternative
  // would have been patching mock-socket or adding a getter hook
  // specifically for bufferedAmount.
  // ────────────────────────────────────────────────────────────────────────
  describe('KeepAlive gated on bufferedAmount', () => {
    type SentFrame = string | ArrayBuffer;

    /** Minimum WebSocket-shaped fake with a mutable `bufferedAmount`. */
    class FakeBufferedWs extends EventTarget {
      static OPEN = 1;
      readyState: number = 0; // CONNECTING
      bufferedAmount = 0;
      binaryType: BinaryType = 'blob';
      sentFrames: SentFrame[] = [];
      onopen: ((ev: Event) => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
      onclose: ((ev: CloseEvent) => void) | null = null;

      open() {
        this.readyState = FakeBufferedWs.OPEN;
        this.onopen?.(new Event('open'));
      }

      send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        // Only the string / ArrayBuffer paths are used in production
        // (JSON control + Int16 PCM), so we narrow to those here; any
        // other frame type is an assertion failure at the test level.
        if (typeof data === 'string') {
          this.sentFrames.push(data);
        } else if (data instanceof ArrayBuffer) {
          this.sentFrames.push(data);
        } else {
          throw new Error('FakeBufferedWs: unexpected frame type');
        }
      }

      close(_code?: number) {
        this.readyState = 3; // CLOSED
        this.onclose?.(new CloseEvent('close', { code: _code ?? 1000 }));
      }
    }

    function makeFakeFactory(): {
      factory: (url: string, protocols?: string[]) => WebSocket;
      ws: FakeBufferedWs;
    } {
      const ws = new FakeBufferedWs();
      // DeepgramService treats WS.OPEN as the numeric constant from the
      // global lib.dom.d.ts — our fake's `readyState = 1` matches. The
      // factory intentionally ignores url/protocols because the fake
      // doesn't model Deepgram's URL contract — only the narrow
      // subsurface (`send` / `bufferedAmount` / `readyState` / `onX`)
      // the DeepgramService calls in the KeepAlive path.
      const factory = () => ws as unknown as WebSocket;
      return { factory, ws };
    }

    it('suppresses KeepAlive JSON + silence when ws.bufferedAmount > 0', () => {
      vi.useFakeTimers({
        toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'],
      });

      const { factory, ws } = makeFakeFactory();
      const service = new DeepgramService(
        {
          onInterimTranscript: vi.fn(),
          onFinalTranscript: vi.fn(),
        },
        factory
      );
      service.connect('fake-api-key', 16000);
      // Drive the fake through the open handshake so startKeepAlive()
      // registers its interval.
      ws.open();

      // Simulate backpressure BEFORE the first interval tick fires.
      // The `lastAudioSendMs === 0` path treats idle as Infinity so the
      // 8-second idle gate is satisfied; only the new bufferedAmount
      // gate should suppress the KeepAlive here.
      ws.bufferedAmount = 1024;

      vi.advanceTimersByTime(10_000);

      expect(ws.sentFrames).toEqual([]);
    });

    it('sends the next scheduled KeepAlive once bufferedAmount drains to 0', () => {
      vi.useFakeTimers({
        toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'],
      });

      const { factory, ws } = makeFakeFactory();
      const service = new DeepgramService(
        {
          onInterimTranscript: vi.fn(),
          onFinalTranscript: vi.fn(),
        },
        factory
      );
      service.connect('fake-api-key', 16000);
      ws.open();

      // Tick 1 (t=10s): backpressured → suppressed.
      ws.bufferedAmount = 2048;
      vi.advanceTimersByTime(10_000);
      expect(ws.sentFrames.length).toBe(0);

      // Drain the buffer before the next tick. Interval fires again at
      // t=20s; this time the gate should let it through (idle still
      // Infinity since no audio has been sent yet).
      ws.bufferedAmount = 0;
      vi.advanceTimersByTime(10_000);

      // Two frames per tick: JSON control then 500 ms silent PCM.
      expect(ws.sentFrames.length).toBe(2);
      expect(typeof ws.sentFrames[0]).toBe('string');
      expect(JSON.parse(ws.sentFrames[0] as string)).toEqual({ type: 'KeepAlive' });
      expect(ws.sentFrames[1]).toBeInstanceOf(ArrayBuffer);
      expect((ws.sentFrames[1] as ArrayBuffer).byteLength).toBe(8000 * 2);
    });
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

    // ────────────────────────────────────────────────────────────────────
    // Auto-reconnect (fetcher mode) — 2026-04-19 parity with iOS.
    //
    // Backend mints /v1/auth/grant JWTs with a 30s TTL shared with iOS.
    // Before this change the web client had no reconnect logic, so the
    // JWT expiring mid-stream produced a 1006 close that bubbled to the
    // UI as "Deepgram WS closed (code=1006)" after a few sentences. The
    // fix is client-side auto-reconnect with a fresh key — the backend
    // TTL cannot flex because iOS depends on the same endpoint.
    //
    // Tests below lock the observable behaviour: fetcher mode absorbs
    // transient closes silently, re-opens with a FRESH key (not the
    // cached one — that's what expired), caps backoff at 30s, fires
    // `onReconnected` after a successful reopen so the caller can replay
    // an AudioRingBuffer, and respects `disconnect()` even when a
    // reconnect is already queued.
    // ────────────────────────────────────────────────────────────────────

    it('auto-reconnects on reconnectable close and fires onReconnected with a fresh key', async () => {
      vi.useFakeTimers({
        toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'],
      });

      const onError = vi.fn();
      const onReconnected = vi.fn();
      const onStateChange = vi.fn();
      const fetchKey = vi
        .fn<() => Promise<string>>()
        .mockResolvedValueOnce('jwt-1')
        .mockResolvedValueOnce('jwt-2');

      const service = new DeepgramService({
        onInterimTranscript: vi.fn(),
        onFinalTranscript: vi.fn(),
        onError,
        onReconnected,
        onStateChange,
      });
      service.connect(fetchKey, 16000);

      // Advance past mock-socket's 4ms handshake delay AND let the
      // initial async fetchKey promise resolve.
      await vi.advanceTimersByTimeAsync(10);
      await server.connected;
      expect(service.connectionState).toBe('connected');
      expect(fetchKey).toHaveBeenCalledTimes(1);

      // Drop a reconnectable close. jest-websocket-mock routes this to
      // the client's onclose with the provided code. The service should
      // NOT fire onError (fetcher mode absorbs) and SHOULD transition to
      // 'reconnecting'.
      server.close({ code: 1006, reason: 'drop', wasClean: false });
      await server.closed;
      expect(onError).not.toHaveBeenCalled();
      expect(service.connectionState).toBe('reconnecting');

      // Attempt 1 has a 1s backoff. Stand up a new fake server to
      // accept the reconnection handshake.
      WS.clean();
      server = makeServer();
      await vi.advanceTimersByTimeAsync(1_000);
      // Drain the microtask queue so the post-setTimeout async
      // openWithFreshKey can run. mock-socket's 4ms handshake delay
      // then needs another tick.
      await vi.advanceTimersByTimeAsync(10);
      await server.connected;

      // Fresh key was minted on reconnect (NOT the cached one — the
      // cached JWT is what expired in the first place).
      expect(fetchKey).toHaveBeenCalledTimes(2);
      expect(service.connectionState).toBe('connected');
      expect(onReconnected).toHaveBeenCalledTimes(1);
    });

    it('caps exponential backoff at 30s', async () => {
      // Four consecutive failures → attempts 1..4 = 1s, 2s, 4s, 8s. A
      // tenth failure would hit 512s un-capped; verify the cap kicks in.
      // We can observe the cap by inspecting the scheduled timer delay
      // via the mock timer queue's `getTimerCount` — but vitest exposes
      // this more simply by advancing time and observing the reconnect
      // NOT firing before the cap, and firing at the cap.
      vi.useFakeTimers({
        toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'],
      });

      const fetchKey = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('backend 503'));
      const onError = vi.fn();

      const service = new DeepgramService({
        onInterimTranscript: vi.fn(),
        onFinalTranscript: vi.fn(),
        onError,
        onStateChange: vi.fn(),
      });
      service.connect(fetchKey, 16000);

      // First fetch throws → surfaces onError (first-connect failure)
      // and schedules attempt #2 with a 2s delay.
      await vi.advanceTimersByTimeAsync(10);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(fetchKey).toHaveBeenCalledTimes(1);

      // Walk through attempts 2..10. Each key fetch rejects, scheduling
      // the next with delay min(2^(n-1) * 1000, 30_000).
      // Attempt  delay
      //   2      2_000
      //   3      4_000
      //   4      8_000
      //   5     16_000
      //   6     30_000 (cap — would be 32_000 un-capped)
      //   7     30_000
      // Total walltime for attempts 2..7 = 2+4+8+16+30+30 = 90s.
      await vi.advanceTimersByTimeAsync(90_000 + 100);
      // 1 initial + 6 scheduled retries = 7 fetchKey calls.
      expect(fetchKey).toHaveBeenCalledTimes(7);

      // onError was only fired for the very first failure. Subsequent
      // reconnect failures stay silent — `reconnecting` state is the
      // UI signal per iOS parity.
      expect(onError).toHaveBeenCalledTimes(1);
    });

    it('disconnect() cancels a pending auto-reconnect', async () => {
      vi.useFakeTimers({
        toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'],
      });

      const fetchKey = vi
        .fn<() => Promise<string>>()
        .mockResolvedValueOnce('jwt-1')
        .mockResolvedValueOnce('jwt-2-should-never-be-used');

      const service = new DeepgramService({
        onInterimTranscript: vi.fn(),
        onFinalTranscript: vi.fn(),
        onError: vi.fn(),
      });
      service.connect(fetchKey, 16000);
      await vi.advanceTimersByTimeAsync(10);
      await server.connected;
      expect(fetchKey).toHaveBeenCalledTimes(1);

      // Kick off a reconnect by dropping the socket.
      server.close({ code: 1006, reason: 'drop', wasClean: false });
      await server.closed;
      expect(service.connectionState).toBe('reconnecting');

      // Stop before the 1s backoff elapses.
      service.disconnect();
      await vi.advanceTimersByTimeAsync(5_000);

      // fetchKey was NOT called a second time — the pending reconnect
      // was cancelled. If it had fired it would have tried to resolve
      // against the cleaned WS.clean()'d server and leaked a socket.
      expect(fetchKey).toHaveBeenCalledTimes(1);
      expect(service.connectionState).toBe('disconnected');
    });

    it('static-key mode is unchanged — a reconnectable close still fires onError', async () => {
      // Regression guard: all pre-2026-04-19 tests (and any caller that
      // passes a raw string) must keep seeing onError on a 1006 close
      // with no silent reconnect happening behind their back.
      const onError = vi.fn();
      const service = new DeepgramService({
        onInterimTranscript: vi.fn(),
        onFinalTranscript: vi.fn(),
        onError,
      });
      service.connect('static-key', 16000);
      await server.connected;
      server.close({ code: 1006, reason: 'drop', wasClean: false });
      await server.closed;
      expect(onError).toHaveBeenCalledTimes(1);
      expect(service.connectionState).toBe('disconnected');
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

  // ────────────────────────────────────────────────────────────────────────
  // iOS parity — Deepgram WebSocket URL params.
  //
  // Project rule (`~/.claude/rules/mistakes.md`): keep web and iOS
  // Deepgram configs in sync. The Wave-A audit Phase 6 P0 flagged
  // `utterance_end_ms=2000` on web vs iOS canonical 1500 (post 2026-04-20
  // voice-quality-sprint Stage 1 tuning). This locks the params so a
  // future drift triggers a CI failure rather than discovering the
  // mismatch in production via a perceived recording-quality regression.
  //
  // We can't read `buildURL` directly (it's private), but `mock-socket`
  // exposes the URL the client connected with on `server.url` of the
  // *connecting client*, accessible via `server.server.clients()[0].url`
  // — except mock-socket doesn't expose that cleanly either. The
  // simplest robust approach: monkey-patch `WebSocket` once, capture the
  // URL the constructor was invoked with, restore. ────────────────────
  describe('iOS-parity URL params (audit Phase 6 P0)', () => {
    it('connects with the canonical iOS Deepgram param set', async () => {
      const realWebSocket = globalThis.WebSocket;
      let capturedUrl = '';
      class CapturingWebSocket extends realWebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          capturedUrl = typeof url === 'string' ? url : url.toString();
          super(url, protocols);
        }
      }
      // Replace global before creating the service so its `new WebSocket`
      // call uses the capturing subclass.
      globalThis.WebSocket = CapturingWebSocket as unknown as typeof WebSocket;

      try {
        const service = new DeepgramService({
          onInterimTranscript: vi.fn(),
          onFinalTranscript: vi.fn(),
        });
        service.connect('fake-api-key', 16000);
        await server.connected;

        const url = new URL(capturedUrl);
        expect(url.host).toBe('api.deepgram.com');
        expect(url.pathname).toBe('/v1/listen');

        const params = url.searchParams;
        // Every param iOS DeepgramService.swift sends, with iOS values.
        expect(params.get('model')).toBe('nova-3');
        expect(params.get('smart_format')).toBe('true');
        expect(params.get('punctuate')).toBe('true');
        expect(params.get('encoding')).toBe('linear16');
        expect(params.get('sample_rate')).toBe('16000');
        expect(params.get('language')).toBe('en-GB');
        expect(params.get('interim_results')).toBe('true');
        expect(params.get('endpointing')).toBe('300');
        // utterance_end_ms 1500 — pre-fix this was 2000 on web.
        expect(params.get('utterance_end_ms')).toBe('1500');
        expect(params.get('vad_events')).toBe('true');

        service.disconnect();
      } finally {
        globalThis.WebSocket = realWebSocket;
      }
    });
  });
});
