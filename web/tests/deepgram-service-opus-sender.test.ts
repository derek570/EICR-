/**
 * PLAN-E1 — the codec-aware single sender, and (PLAN-E1B2 item 1) why web
 * Opus stays permanently disabled.
 *
 * A live probe against the real browser `AudioEncoder`
 * (`scripts/deepgram-webcodecs-opus-packet-probe.mjs`, matching
 * `opus-encoder.ts`'s exact 16kHz/mono/28kbps config) found the
 * packet-to-source-sample mapping is NOT determinable for the genuinely
 * reachable production input space: a sequence of 320-sample-aligned
 * (20ms-multiple) `encode()` calls produces a clean, immediate
 * N-packets-per-call split, but a non-aligned short-tail call — exactly
 * what `flushFluxAccumulator`'s scope-boundary flush and `disconnect()`'s
 * graceful-teardown flush actually submit (any length from 1 to 1,279
 * samples) — can produce ZERO immediately-attributable output packets, with
 * its audio folded into a LATER call's batch in a way no observable
 * timestamp/duration data can decompose back out. Per
 * PLAN-E1B2-final.md item 1's outcome matrix, this is the "mapping can't be
 * determined deterministically" branch: `resolveUplinkURLConfig`
 * (`uplink-url-config.ts`) now forces `linear16` unconditionally,
 * regardless of what the backend/latch claims, so `opus-encoder.ts`'s
 * WebCodecs wrapper and `deepgram-service.ts`'s encoder-routing machinery
 * below are left in place (a future probe may re-enable them) but are
 * UNREACHABLE from any real production entry point.
 *
 * This file used to test that machinery activating end-to-end (FIFO
 * input/output pairing, generation fencing, onUndispatchedLoss on an
 * unexpected teardown, graceful-stop bounded-flush residue) — those tests
 * are gone because their premise (the sender ever resolves to Opus) is now
 * false. The `FakeOpusEncoder`/`makeFakeOpusEncoderFactory` helpers stay,
 * repurposed to PROVE the encoder is never constructed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DeepgramService,
  createSessionCodecLatch,
  createCaptureClock,
  type DeepgramCallbacks,
  type DeepgramSessionContext,
  type WebSocketFactory,
} from '@/lib/recording/deepgram-service';
import { UplinkScopeAllocator } from '@/lib/recording/uplink-scope-allocator';
import type { OpusEncoderFactory, OpusEncoderLike } from '@/lib/recording/opus-encoder';
import {
  unboundLossTelemetryCount,
  resetUnboundLossTelemetry,
  gracefulResidueTelemetryCount,
  resetGracefulResidueTelemetry,
} from '@/lib/recording/uplink-loss-report';

class FakeWS {
  static OPEN = 1;
  url: string;
  protocols?: string[];
  binaryType = 'blob';
  bufferedAmount = 0;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: { code: number; reason?: string; wasClean?: boolean }) => void) | null = null;
  sent: Array<string | ArrayBuffer> = [];
  constructor(url: string, protocols?: string[]) {
    this.url = url;
    this.protocols = protocols;
  }
  send(data: string | ArrayBuffer) {
    this.sent.push(data);
  }
  close() {
    this.onclose?.({ code: 1000, wasClean: true });
  }
}

/** Minimal `OpusEncoderLike` stand-in. Every remaining test in this file
 *  asserts the encoder is NEVER constructed (PLAN-E1B2 item 1's disabled
 *  outcome), so this fake only needs to exist as an injectable factory
 *  target — it never needs to actually emit a packet. */
class FakeOpusEncoder implements OpusEncoderLike {
  pending: Int16Array[] = [];
  closed = false;
  encode(samples: Int16Array): void {
    this.pending.push(samples);
  }
  async flush(): Promise<void> {
    /* no-op — never exercised, since the encoder is never constructed */
  }
  close(): void {
    this.closed = true;
  }
}

function makeFakeOpusEncoderFactory() {
  const encoders: FakeOpusEncoder[] = [];
  const factory: OpusEncoderFactory = () => {
    const enc = new FakeOpusEncoder();
    encoders.push(enc);
    return enc;
  };
  return { factory, encoders };
}

function makeSessionContext(): DeepgramSessionContext {
  return {
    recordingSessionId: 'sess-test',
    codecLatch: createSessionCodecLatch(),
    allocator: new UplinkScopeAllocator(),
    captureClock: createCaptureClock(),
  };
}

function makeService(
  opts: {
    opusEncoderFactory?: OpusEncoderFactory;
    onUndispatchedLoss?: (report: unknown) => void;
    sessionContext?: DeepgramSessionContext;
  } = {}
) {
  const cbs: DeepgramCallbacks = {
    onInterimTranscript: vi.fn(),
    onFinalTranscript: vi.fn(),
    onUtteranceEnd: vi.fn(),
    onSpeechStarted: vi.fn(),
    onError: vi.fn(),
  };
  let created: FakeWS | null = null;
  const factory: WebSocketFactory = (url, protocols) => {
    created = new FakeWS(url, protocols) as unknown as WebSocket & FakeWS;
    return created as unknown as WebSocket;
  };
  const sessionContext = opts.sessionContext ?? makeSessionContext();
  const service = new DeepgramService(cbs, factory, 'flux', {
    sessionContext,
    opusEncoderFactory: opts.opusEncoderFactory,
    onUndispatchedLoss: opts.onUndispatchedLoss as never,
  });
  return { service, getWs: () => created as unknown as FakeWS, cbs, sessionContext };
}

function frame1280(): Float32Array {
  return new Float32Array(1280).fill(0.1);
}

describe('DeepgramService — Opus sender (PLAN-E1)', () => {
  beforeEach(() => {
    resetUnboundLossTelemetry();
    resetGracefulResidueTelemetry();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['flux', 'nova3'] as const)(
    'PLAN-E1B2 item 1/2 (disabled outcome) — %s never constructs an Opus encoder or resolves an opus URL, even when the backend/latch claims uplink_codec is opus',
    async (model) => {
      const { factory, encoders } = makeFakeOpusEncoderFactory();
      const cbs: DeepgramCallbacks = {
        onInterimTranscript: vi.fn(),
        onFinalTranscript: vi.fn(),
        onUtteranceEnd: vi.fn(),
        onSpeechStarted: vi.fn(),
        onError: vi.fn(),
      };
      let created: FakeWS | null = null;
      const wsFactory: WebSocketFactory = (url, protocols) => {
        created = new FakeWS(url, protocols) as unknown as WebSocket & FakeWS;
        return created as unknown as WebSocket;
      };
      const getWs = () => created as unknown as FakeWS;
      const service = new DeepgramService(cbs, wsFactory, model, {
        sessionContext: makeSessionContext(),
        opusEncoderFactory: factory,
      });
      // The mock backend claims uplink_codec is 'opus' — the live-probe
      // finding means this must be ignored, not merely defaulted-around.
      service.connect(async () => ({ key: 'jwt', uplink_codec: 'opus' }), 16000);
      await Promise.resolve();
      await Promise.resolve();
      expect(encoders.length).toBe(0);
      expect(service.resolvedCodec).toBe('linear16');
      expect(getWs().url).toContain('encoding=linear16');
      expect(getWs().url).not.toContain('encoding=opus');

      // Sending audio must go out as linear16 over the wire, never queue
      // into an encoder that was never built.
      getWs().onopen?.();
      service.sendSamples(frame1280());
      expect(encoders.length).toBe(0);
      expect(getWs().sent.length).toBe(1);
    }
  );

  it('a fresh session with no backend response yet also never constructs an Opus encoder (default-linear16 latch)', async () => {
    const { factory, encoders } = makeFakeOpusEncoderFactory();
    const { service, getWs } = makeService({ opusEncoderFactory: factory });
    service.connect(async () => ({ key: 'jwt' }), 16000); // no uplink_codec field at all
    await Promise.resolve();
    await Promise.resolve();
    getWs().onopen?.();
    service.sendSamples(frame1280());
    expect(encoders.length).toBe(0);
    expect(service.resolvedCodec).toBe('linear16');
  });

  it('charges a partial Flux sub-frame tail as onUndispatchedLoss on an UNEXPECTED close (Codex review r1 IMPORTANT fix)', async () => {
    const reports: Array<{
      recordingSessionId: string;
      captureSampleRange: { start: number; end: number };
    }> = [];
    const { service, getWs } = makeService({
      onUndispatchedLoss: (r) => reports.push(r as never),
    });
    service.connect(async () => ({ key: 'jwt', uplink_codec: 'linear16' }), 16000);
    await Promise.resolve();
    await Promise.resolve();
    getWs().onopen?.();

    // A full 1280-sample frame dispatches immediately (sent over the
    // wire) — only the remainder below stays pending as a sub-frame tail.
    service.sendSamples(new Float32Array(1280).fill(0.1));
    expect(getWs().sent.length).toBe(1);
    // 500 samples short of a second full frame — sits in the accumulator.
    service.sendSamples(new Float32Array(780).fill(0.1));
    expect(getWs().sent.length).toBe(1);

    getWs().onclose?.({ code: 1006, reason: 'abnormal', wasClean: false });

    expect(reports.length).toBe(1);
    expect(reports[0].recordingSessionId).toBe('sess-test');
    expect(reports[0].captureSampleRange).toEqual({ start: 1280, end: 2060 });
    expect(unboundLossTelemetryCount()).toBe(0);
  });

  it('a graceful disconnect flushes the Flux tail through the sender instead of losing it', async () => {
    const { service, getWs } = makeService();
    service.connect(async () => ({ key: 'jwt', uplink_codec: 'linear16' }), 16000);
    await Promise.resolve();
    await Promise.resolve();
    getWs().onopen?.();

    service.sendSamples(new Float32Array(780).fill(0.1));
    expect(getWs().sent.length).toBe(0); // still short of a full frame

    service.disconnect();
    // The flushed tail's binary frame, THEN the CloseStream JSON message —
    // the tail must reach the wire BEFORE CloseStream, not be dropped.
    expect(getWs().sent.length).toBe(2);
    expect(getWs().sent[0]).toBeInstanceOf(ArrayBuffer);
    expect(typeof getWs().sent[1]).toBe('string');
  });

  it('a service constructed WITHOUT a session context (the ~20 pre-existing direct tests) still works standalone', () => {
    const cbs: DeepgramCallbacks = {
      onInterimTranscript: vi.fn(),
      onFinalTranscript: vi.fn(),
      onUtteranceEnd: vi.fn(),
      onSpeechStarted: vi.fn(),
      onError: vi.fn(),
    };
    const wsFactory: WebSocketFactory = (url, protocols) =>
      new FakeWS(url, protocols) as unknown as WebSocket;
    // No 4th arg — exercises the default self-contained context.
    const service = new DeepgramService(cbs, wsFactory, 'nova3');
    expect(() => service.connect('static-key', 16000)).not.toThrow();
    expect(service.latchedUplinkCodec).toBeNull(); // static-key mode never latches
  });
});
