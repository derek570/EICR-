/**
 * PLAN-E1 — the codec-aware single sender + Opus encoder integration:
 * generation fencing (async output bound to the connection that created
 * it), FIFO input/output pairing, the onUndispatchedLoss seam on an
 * UNEXPECTED teardown, and graceful-stop bounded-flush residue telemetry.
 *
 * Uses a hand fake `WebSocketFactory` (same pattern as
 * `deepgram-service-flux.test.ts`) + a fake `OpusEncoderFactory` (WebCodecs
 * `AudioEncoder`/`AudioData` are not implemented under Vitest/jsdom).
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

class FakeOpusEncoder implements OpusEncoderLike {
  pending: Int16Array[] = [];
  closed = false;
  flushBehavior: 'drain' | 'hang' = 'drain';
  constructor(private readonly onPacket: (bytes: Uint8Array) => void) {}
  encode(samples: Int16Array): void {
    this.pending.push(samples);
  }
  /** Test helper — fire the fake encoder's output for the oldest
   *  still-pending input, mirroring a real 1-in/1-out streaming encoder. */
  emitNext(): void {
    const next = this.pending.shift();
    if (!next) return;
    this.onPacket(new Uint8Array([1, 2, 3]));
  }
  async flush(): Promise<void> {
    if (this.flushBehavior === 'hang') {
      return new Promise(() => {
        /* never resolves — exercises the bounded-flush timeout */
      });
    }
    while (this.pending.length > 0) this.emitNext();
  }
  close(): void {
    this.closed = true;
  }
}

function makeFakeOpusEncoderFactory() {
  const encoders: FakeOpusEncoder[] = [];
  const factory: OpusEncoderFactory = (onPacket) => {
    const enc = new FakeOpusEncoder(onPacket);
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

  it('routes captured audio through the encoder when the latched codec is opus', async () => {
    const { factory, encoders } = makeFakeOpusEncoderFactory();
    const { service, getWs } = makeService({ opusEncoderFactory: factory });
    service.connect(async () => ({ key: 'jwt', uplink_codec: 'opus' }), 16000);
    // Fetcher mode resolves the promise on a microtask.
    await Promise.resolve();
    await Promise.resolve();
    getWs().onopen?.();

    service.sendSamples(frame1280());
    expect(encoders.length).toBe(1);
    expect(encoders[0].pending.length).toBe(1);
    // Nothing sent yet — the encoded packet hasn't arrived.
    expect(getWs().sent.length).toBe(0);

    encoders[0].emitNext();
    expect(getWs().sent.length).toBe(1);
  });

  it('preserves FIFO input/output pairing across multiple queued frames', async () => {
    const { factory, encoders } = makeFakeOpusEncoderFactory();
    const { service, getWs } = makeService({ opusEncoderFactory: factory });
    service.connect(async () => ({ key: 'jwt', uplink_codec: 'opus' }), 16000);
    await Promise.resolve();
    await Promise.resolve();
    getWs().onopen?.();

    service.sendSamples(frame1280());
    service.sendSamples(frame1280());
    service.sendSamples(frame1280());
    expect(encoders[0].pending.length).toBe(3);

    encoders[0].emitNext();
    expect(getWs().sent.length).toBe(1);
    encoders[0].emitNext();
    expect(getWs().sent.length).toBe(2);
    encoders[0].emitNext();
    expect(getWs().sent.length).toBe(3);
    // A fourth emit with nothing pending is a safe no-op.
    encoders[0].emitNext();
    expect(getWs().sent.length).toBe(3);
  });

  it('discards encoder output that arrives after a NEWER generation started', async () => {
    const { factory, encoders } = makeFakeOpusEncoderFactory();
    const { service, getWs } = makeService({ opusEncoderFactory: factory });
    vi.useFakeTimers();
    service.connect(async () => ({ key: 'jwt', uplink_codec: 'opus' }), 16000);
    await vi.advanceTimersByTimeAsync(0);
    getWs().onopen?.();

    service.sendSamples(frame1280()); // queued on generation 1's encoder
    const ws1 = getWs();
    expect(encoders.length).toBe(1);

    // Abnormal close — schedules a reconnect (fetcher mode).
    ws1.onclose?.({ code: 1006, reason: 'abnormal', wasClean: false });
    await vi.advanceTimersByTimeAsync(1100); // past the 1s initial backoff
    const ws2 = getWs();
    expect(ws2).not.toBe(ws1);
    expect(encoders.length).toBe(2); // a fresh generation's encoder

    // The STALE (generation-1) encoder's late output must be discarded —
    // never sent on the (now-defunct) old socket, and never crashes.
    encoders[0].emitNext();
    expect(ws1.sent.length).toBe(0);
    expect(ws2.sent.length).toBe(0);
  });

  it('charges pending encoder input as onUndispatchedLoss on an UNEXPECTED teardown', async () => {
    const reports: Array<{
      recordingSessionId: string;
      captureSampleRange: { start: number; end: number };
    }> = [];
    const { factory, encoders } = makeFakeOpusEncoderFactory();
    const { service, getWs } = makeService({
      opusEncoderFactory: factory,
      onUndispatchedLoss: (r) => reports.push(r as never),
    });
    service.connect(async () => ({ key: 'jwt', uplink_codec: 'opus' }), 16000);
    await Promise.resolve();
    await Promise.resolve();
    getWs().onopen?.();

    service.sendSamples(frame1280());
    service.sendSamples(frame1280());
    expect(encoders[0].pending.length).toBe(2); // never emitted — still "in flight"

    // Abnormal (reconnectable) close.
    getWs().onclose?.({ code: 1006, reason: 'abnormal', wasClean: false });

    expect(reports.length).toBe(2);
    expect(reports[0].recordingSessionId).toBe('sess-test');
    expect(reports[0].captureSampleRange).toEqual({ start: 0, end: 1280 });
    expect(reports[1].captureSampleRange).toEqual({ start: 1280, end: 2560 });
    // The default no-op+telemetry handler is bypassed when a real handler
    // is supplied — the unbound counter stays at 0.
    expect(unboundLossTelemetryCount()).toBe(0);
  });

  it('defaults to the no-op + telemetry counter when no onUndispatchedLoss handler is supplied', async () => {
    const { factory, encoders } = makeFakeOpusEncoderFactory();
    const { service, getWs } = makeService({ opusEncoderFactory: factory });
    service.connect(async () => ({ key: 'jwt', uplink_codec: 'opus' }), 16000);
    await Promise.resolve();
    await Promise.resolve();
    getWs().onopen?.();
    service.sendSamples(frame1280());
    expect(encoders[0].pending.length).toBe(1);
    getWs().onclose?.({ code: 1006, reason: 'abnormal', wasClean: false });
    expect(unboundLossTelemetryCount()).toBe(1);
  });

  it('a graceful stop runs a bounded flush; unflushable residue is telemetered, NOT loss-reported', async () => {
    const reports: unknown[] = [];
    const { factory, encoders } = makeFakeOpusEncoderFactory();
    const { service, getWs } = makeService({
      opusEncoderFactory: factory,
      onUndispatchedLoss: (r) => reports.push(r),
    });
    vi.useFakeTimers();
    service.connect(async () => ({ key: 'jwt', uplink_codec: 'opus' }), 16000);
    await vi.advanceTimersByTimeAsync(0);
    getWs().onopen?.();
    service.sendSamples(frame1280());
    encoders[0].flushBehavior = 'hang'; // simulate an unflushable tail
    expect(encoders[0].pending.length).toBe(1);

    service.disconnect();
    await vi.advanceTimersByTimeAsync(600); // past the 500ms flush bound

    expect(gracefulResidueTelemetryCount()).toBe(1);
    expect(reports.length).toBe(0); // NOT the ledger-adjacent seam
  });

  it('a graceful stop that flushes cleanly reports ZERO residue', async () => {
    const { factory, encoders } = makeFakeOpusEncoderFactory();
    const { service, getWs } = makeService({ opusEncoderFactory: factory });
    vi.useFakeTimers();
    service.connect(async () => ({ key: 'jwt', uplink_codec: 'opus' }), 16000);
    await vi.advanceTimersByTimeAsync(0);
    getWs().onopen?.();
    service.sendSamples(frame1280());
    // Default flushBehavior = 'drain' — flush() drains everything itself.

    service.disconnect();
    await vi.advanceTimersByTimeAsync(0);

    expect(gracefulResidueTelemetryCount()).toBe(0);
  });

  it('nova-3 forces linear16 regardless of the latched codec — no encoder constructed', async () => {
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
    const service = new DeepgramService(cbs, wsFactory, 'nova3', {
      sessionContext: makeSessionContext(),
      opusEncoderFactory: factory,
    });
    service.connect(async () => ({ key: 'jwt', uplink_codec: 'opus' }), 16000);
    await Promise.resolve();
    await Promise.resolve();
    expect(encoders.length).toBe(0);
    expect(service.resolvedCodec).toBe('linear16');
    expect((created as unknown as FakeWS | null)?.url).toContain('encoding=linear16');
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
