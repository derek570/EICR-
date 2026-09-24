/**
 * Deepgram Flux (`/v2/listen` `flux-general-en`) client tests — parity WS4.
 *
 * The nova-3 path is covered by `deepgram-service.test.ts` (jest-websocket-mock).
 * Flux is exercised here through the constructor's `wsFactory` seam with a hand
 * fake WebSocket, so we can (a) capture the connect URL and assert the Flux URL
 * shape, (b) inject Flux `TurnInfo`/`Configure*`/`Error` frames and assert the
 * delegate mapping, (c) drive the Configure round-trip + echo validation, and
 * (d) assert 80ms audio batching. All without a live socket.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  DeepgramService,
  type DeepgramCallbacks,
  type WebSocketFactory,
} from '@/lib/recording/deepgram-service';
import type { CapturedPcmSegment } from '@/lib/recording/tagged-pcm-segment';

// Minimal controllable WebSocket fake. Records the URL + every frame sent,
// and lets the test drive onopen/onmessage.
class FakeWS {
  static OPEN = 1;
  url: string;
  protocols?: string[];
  binaryType = 'blob';
  bufferedAmount = 0;
  readyState = 1; // OPEN
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
  // Test helpers
  open() {
    this.onopen?.();
  }
  emit(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

function makeService(overrides: Partial<DeepgramCallbacks> = {}) {
  const cbs: DeepgramCallbacks = {
    onInterimTranscript: vi.fn(),
    onFinalTranscript: vi.fn(),
    onUtteranceEnd: vi.fn(),
    onSpeechStarted: vi.fn(),
    onError: vi.fn(),
    onConfigureResult: vi.fn(),
    ...overrides,
  };
  let created: FakeWS | null = null;
  const factory: WebSocketFactory = (url, protocols) => {
    created = new FakeWS(url, protocols) as unknown as WebSocket & FakeWS;
    return created as unknown as WebSocket;
  };
  const service = new DeepgramService(cbs, factory, 'flux');
  service.connect('fake-key', 16000);
  // connect() → openSocket() constructs the WS synchronously (static-key mode).
  const ws = created as unknown as FakeWS;
  return { service, ws, cbs };
}

describe('DeepgramService — Flux URL builder', () => {
  it('builds the /v2/listen flux-general-en URL with the canonical params + NO :boost suffix', () => {
    const { ws } = makeService();
    const url = ws.url;
    expect(url).toContain('wss://api.deepgram.com/v2/listen');
    expect(url).toContain('model=flux-general-en');
    expect(url).toContain('encoding=linear16');
    expect(url).toContain('sample_rate=16000');
    expect(url).toContain('eot_threshold=0.7');
    expect(url).toContain('eot_timeout_ms=5000');
    expect(url).toContain('mip_opt_out=true');
    // Equal-weight keyterms — plain, no boost suffix anywhere.
    expect(url).toContain('keyterm=');
    expect(url).not.toContain('%3A'); // no ":" (url-encoded) → no :boost suffixes
    // nova-3-only knobs must be absent.
    expect(url).not.toContain('interim_results');
    expect(url).not.toContain('utterance_end_ms');
    expect(url).not.toContain('vad_events');
    expect(url).not.toContain('/v1/listen');
    // Auth stays subprotocol-based (bearer JWT), same as nova-3.
    expect(ws.protocols).toEqual(['bearer', 'fake-key']);
  });

  it('reports its model', () => {
    const { service } = makeService();
    expect(service.model).toBe('flux');
  });
});

describe('DeepgramService — Flux TurnInfo → delegate mapping', () => {
  it('maps Update → onInterimTranscript', () => {
    const { ws, cbs } = makeService();
    ws.open();
    ws.emit({ type: 'TurnInfo', event: 'Update', transcript: 'insulation resis' });
    // PLAN-D — the third argument names the emitting socket (current here).
    expect(cbs.onInterimTranscript).toHaveBeenCalledWith(
      'insulation resis',
      expect.any(Number),
      expect.objectContaining({ current: true })
    );
  });

  it('maps StartOfTurn → onSpeechStarted', () => {
    const { ws, cbs } = makeService();
    ws.open();
    ws.emit({ type: 'TurnInfo', event: 'StartOfTurn' });
    expect(cbs.onSpeechStarted).toHaveBeenCalledTimes(1);
  });

  it('maps EndOfTurn (with transcript) → onFinalTranscript AND onUtteranceEnd, in that order', () => {
    const { ws, cbs } = makeService();
    ws.open();
    ws.emit({
      type: 'TurnInfo',
      event: 'EndOfTurn',
      transcript: 'live to live is LIM',
      end_of_turn_confidence: 0.92,
      words: [{ word: 'LIM', start: 1.0, end: 1.2, confidence: 0.9 }],
    });
    expect(cbs.onFinalTranscript).toHaveBeenCalledTimes(1);
    const [text, conf, words] = (cbs.onFinalTranscript as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(text).toBe('live to live is LIM');
    expect(conf).toBeCloseTo(0.92);
    expect(words).toHaveLength(1);
    expect(words[0].word).toBe('LIM');
    // iOS canon: EndOfTurn with transcript fires final + utterance-end. The
    // missing utterance-end left isInspectorSpeaking stuck true on web and
    // permanently deferred every FIFO confirmation (sess_mrbnds2d_jczh, A1).
    expect(cbs.onUtteranceEnd).toHaveBeenCalledTimes(1);
    const finalOrder = (cbs.onFinalTranscript as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    const utteranceEndOrder = (cbs.onUtteranceEnd as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    expect(finalOrder).toBeLessThan(utteranceEndOrder);
  });

  it('maps EndOfTurn (empty transcript) → onUtteranceEnd, NOT a final', () => {
    const { ws, cbs } = makeService();
    ws.open();
    ws.emit({ type: 'TurnInfo', event: 'EndOfTurn', transcript: '' });
    expect(cbs.onUtteranceEnd).toHaveBeenCalledTimes(1);
    expect(cbs.onFinalTranscript).not.toHaveBeenCalled();
  });

  it('does NOT feed Flux frames through the nova-3 Results path', () => {
    const { ws, cbs } = makeService();
    ws.open();
    // A nova-3-shaped Results message must NOT produce a final on the Flux path.
    ws.emit({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: 'x' }] } });
    expect(cbs.onFinalTranscript).not.toHaveBeenCalled();
  });
});

describe('DeepgramService — Flux Error/Fatal surfaced (never dropped)', () => {
  it('surfaces a Flux Error frame via onError', () => {
    const { ws, cbs } = makeService();
    ws.open();
    ws.emit({ type: 'Error', description: 'UNPARSABLE_CLIENT_MESSAGE' });
    expect(cbs.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'UNPARSABLE_CLIENT_MESSAGE' })
    );
  });
  it('surfaces a Flux Fatal frame via onError', () => {
    const { ws, cbs } = makeService();
    ws.open();
    ws.emit({ type: 'Fatal', description: 'boom' });
    expect(cbs.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }));
  });
});

describe('DeepgramService — Flux Configure round-trip + echo validation', () => {
  it('resolves ok with an RTT when ConfigureSuccess echoes matching thresholds + keyterm count', async () => {
    const { service, ws, cbs } = makeService();
    ws.open();
    const p = service.sendConfigure({
      keyterms: ['LIM', 'Zs'],
      eotThreshold: 0.7,
      eotTimeoutMs: 5000,
    });
    // The Configure JSON was sent.
    const sentConfigure = ws.sent.find(
      (f) => typeof f === 'string' && f.includes('"Configure"')
    ) as string;
    expect(sentConfigure).toBeTruthy();
    expect(JSON.parse(sentConfigure).keyterms).toEqual(['LIM', 'Zs']);
    // Echo it back.
    ws.emit({
      type: 'ConfigureSuccess',
      thresholds: { eot_threshold: 0.7, eot_timeout_ms: 5000 },
      keyterms: ['LIM', 'Zs'],
    });
    const result = await p;
    expect(result.ok).toBe(true);
    expect(cbs.onConfigureResult).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });

  it('fails closed when the echo keyterm count diverges', async () => {
    const { service, ws } = makeService();
    ws.open();
    const p = service.sendConfigure({ keyterms: ['LIM', 'Zs', 'Ze'] });
    ws.emit({
      type: 'ConfigureSuccess',
      thresholds: { eot_threshold: 0.7, eot_timeout_ms: 5000 },
      keyterms: ['LIM'],
    });
    const result = await p;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('echo_keyterm_count');
  });

  it('surfaces ConfigureFailure as ok:false (never dropped)', async () => {
    const { service, ws } = makeService();
    ws.open();
    const p = service.sendConfigure({ keyterms: ['LIM'] });
    ws.emit({ type: 'ConfigureFailure', description: 'bad_keyterm' });
    const result = await p;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_keyterm');
  });

  it('sendConfigure is a no-op failure on the nova-3 path', async () => {
    const cbs: DeepgramCallbacks = { onInterimTranscript: vi.fn(), onFinalTranscript: vi.fn() };
    const service = new DeepgramService(
      cbs,
      (u, p) => new FakeWS(u, p) as unknown as WebSocket,
      'nova3'
    );
    const result = await service.sendConfigure({ keyterms: ['LIM'] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_flux');
  });
});

describe('DeepgramService — Flux 80ms audio batching', () => {
  it('flushes exactly 1280-sample (2560-byte) frames and holds the sub-frame tail', () => {
    const { service, ws } = makeService();
    ws.open();
    // Send 3000 samples → two full 1280 frames (2560), 440 held back.
    service.sendSamples(new Float32Array(3000));
    const binaryFrames = ws.sent.filter((f) => f instanceof ArrayBuffer) as ArrayBuffer[];
    expect(binaryFrames).toHaveLength(2);
    for (const f of binaryFrames) expect(f.byteLength).toBe(1280 * 2);
    // Send 840 more → 440 + 840 = 1280 → one more frame.
    service.sendSamples(new Float32Array(840));
    const after = ws.sent.filter((f) => f instanceof ArrayBuffer) as ArrayBuffer[];
    expect(after).toHaveLength(3);
  });

  // PLAN-E1B2 item 3 — capturedAt propagation through Flux batching's
  // segment merges. `dispatchFrame` is private; spying on it via a cast is
  // the least invasive way to observe a dispatched frame's capturedAt
  // without adding production-only test instrumentation.
  function makeTaggedSegment(
    samples: Int16Array,
    start: number,
    capturedAt: number
  ): CapturedPcmSegment {
    return {
      origin: 'captured',
      samples,
      recordingSessionId: 'sess-test',
      captureSampleRange: { start, end: start + samples.length },
      epochScope: { kind: 'preOpen', captureAttemptId: 1 as any },
      capturedAt,
    };
  }

  it("a full-frame emission reports the FIRST constituent segment's capturedAt, never the second's", () => {
    const { service, ws } = makeService();
    ws.open();
    const dispatchSpy = vi.spyOn(service as any, 'dispatchFrame');
    // Segment A (800 samples, capturedAt=100) + segment B (480 samples,
    // capturedAt=200) together span exactly one full 1280-sample frame.
    service.sendTaggedAudio(makeTaggedSegment(new Int16Array(800), 0, 100));
    service.sendTaggedAudio(makeTaggedSegment(new Int16Array(480), 800, 200));
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect((dispatchSpy.mock.calls[0][0] as CapturedPcmSegment).capturedAt).toBe(100);
  });

  it("a scope-boundary flush reports the held-back remainder's own capturedAt", () => {
    const { service, ws } = makeService();
    ws.open();
    const dispatchSpy = vi.spyOn(service as any, 'dispatchFrame');
    // 500 samples — short of a full frame, held as a remainder.
    service.sendTaggedAudio(makeTaggedSegment(new Int16Array(500), 0, 111));
    expect(dispatchSpy).not.toHaveBeenCalled();
    // A DIFFERENT epoch scope forces a scope-boundary flush of the
    // remainder before the new segment is accepted.
    const differentScope = { kind: 'epoch' as const, id: 9 as any };
    service.sendTaggedAudio({
      ...makeTaggedSegment(new Int16Array(320), 500, 222),
      epochScope: differentScope,
    });
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect((dispatchSpy.mock.calls[0][0] as CapturedPcmSegment).capturedAt).toBe(111);
  });

  // PLAN-E1B2 item 3 (round-8 finding) — the multi-frame FIFO regression a
  // two/three-segment case can't catch: segment B stays at the queue head
  // by accident on the path a smaller case would exercise. Mirrors
  // mic-capture.ts's documented typical per-callback size (~128 samples).
  it('the capturedAt FIFO survives consuming several small segments per frame (multi-segment loop, not a single-head check)', () => {
    const { service, ws } = makeService();
    ws.open();
    const dispatchSpy = vi.spyOn(service as any, 'dispatchFrame');
    // 20 segments of 128 samples each, distinct capturedAt per segment.
    // The first 10 (10 * 128 = 1280) combine into frame 1 with NO
    // remainder; segment 11 starts frame 2.
    let start = 0;
    for (let i = 0; i < 20; i++) {
      service.sendTaggedAudio(makeTaggedSegment(new Int16Array(128), start, 1000 + i));
      start += 128;
    }
    expect(dispatchSpy).toHaveBeenCalledTimes(2);
    // Frame 1 = segments 0..9 → capturedAt of segment 0 (1000).
    expect((dispatchSpy.mock.calls[0][0] as CapturedPcmSegment).capturedAt).toBe(1000);
    // Frame 2 = segments 10..19 → capturedAt of segment 10 (1010), NEVER
    // segment 1's (1001) — a single-head, non-looping consumer would
    // dequeue only segment 0 for frame 1, leave segments 1..9 stranded in
    // the queue, and wrongly report segment 1's capturedAt here.
    expect((dispatchSpy.mock.calls[1][0] as CapturedPcmSegment).capturedAt).toBe(1010);
  });
});

// PLAN-E1B2 item 3 — the plan's own MANDATORY three-segment remainder case
// (round-6 finding): the single-value bug only surfaces after a full-frame
// emission has already consumed one segment entirely.
describe('DeepgramService — Flux capturedAt FIFO (PLAN-E1B2 item 3, self-audit additions)', () => {
  function seg(samples: number, start: number, capturedAt: number): CapturedPcmSegment {
    return {
      origin: 'captured',
      samples: new Int16Array(samples),
      recordingSessionId: 'sess-test',
      captureSampleRange: { start, end: start + samples },
      epochScope: { kind: 'preOpen', captureAttemptId: 1 as any },
      capturedAt,
    };
  }

  it("A/B/C: frame 2 reports segment B's capturedAt (A fully consumed by frame 1), never A's or C's", () => {
    const { service, ws } = makeService();
    ws.open();
    const dispatchSpy = vi.spyOn(service as any, 'dispatchFrame');
    service.sendTaggedAudio(seg(500, 0, 100)); // A — held as remainder, no emission
    expect(dispatchSpy).not.toHaveBeenCalled();
    service.sendTaggedAudio(seg(1000, 500, 200)); // B — 1500 buffered → frame 1 (A + 780 of B), 220 of B remains
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect((dispatchSpy.mock.calls[0][0] as CapturedPcmSegment).capturedAt).toBe(100);
    service.sendTaggedAudio(seg(1060, 1500, 300)); // C — 220 + 1060 = 1280 → frame 2
    expect(dispatchSpy).toHaveBeenCalledTimes(2);
    expect((dispatchSpy.mock.calls[1][0] as CapturedPcmSegment).capturedAt).toBe(200);
  });

  it("an abnormal close that loss-charges a partial tail also clears the capturedAt FIFO — the first post-reconnect frame uses only the fresh segment's capturedAt", () => {
    const cbs: DeepgramCallbacks = {
      onInterimTranscript: vi.fn(),
      onFinalTranscript: vi.fn(),
      onUtteranceEnd: vi.fn(),
      onSpeechStarted: vi.fn(),
      onError: vi.fn(),
    };
    let latest: FakeWS | null = null;
    const factory: WebSocketFactory = (url, protocols) => {
      latest = new FakeWS(url, protocols) as unknown as WebSocket & FakeWS;
      return latest as unknown as WebSocket;
    };
    const service = new DeepgramService(cbs, factory, 'flux');
    service.connect('fake-key', 16000);
    (latest as unknown as FakeWS).open();
    const dispatchSpy = vi.spyOn(service as any, 'dispatchFrame');

    // A partial tail sits in the accumulator with a queue entry behind it.
    service.sendTaggedAudio(seg(700, 0, 111));
    expect(dispatchSpy).not.toHaveBeenCalled();
    // Abnormal (reconnectable-code) close → chargeFluxTailLoss clears the
    // buffer. Before the fix it left the FIFO holding {700, 111}.
    (latest as unknown as FakeWS).onclose?.({ code: 1006, reason: 'abnormal', wasClean: false });

    service.connect('fake-key', 16000);
    (latest as unknown as FakeWS).open();
    service.sendTaggedAudio(seg(1280, 700, 999));
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    // With the stale entry, consumeCapturedAtQueue would have returned 111.
    expect((dispatchSpy.mock.calls[0][0] as CapturedPcmSegment).capturedAt).toBe(999);
  });
  it('a sub-ratio input that resamples to ZERO samples never enters the capturedAt FIFO (Codex r2 NIT)', () => {
    const cbs: DeepgramCallbacks = {
      onInterimTranscript: vi.fn(),
      onFinalTranscript: vi.fn(),
      onUtteranceEnd: vi.fn(),
      onSpeechStarted: vi.fn(),
      onError: vi.fn(),
    };
    let ws: FakeWS | null = null;
    const factory: WebSocketFactory = (url, protocols) => {
      ws = new FakeWS(url, protocols) as unknown as WebSocket & FakeWS;
      return ws as unknown as WebSocket;
    };
    const service = new DeepgramService(cbs, factory, 'flux');
    service.connect('fake-key', 48000); // 3:1 ratio — 2 input samples → 0 output samples
    (ws as unknown as FakeWS).open();
    const dispatchSpy = vi.spyOn(service as any, 'dispatchFrame');
    expect(service.sendSamples(new Float32Array(2).fill(0.1), 111)).toBeNull();
    // A real full frame afterwards must carry ITS OWN stamp, not 111.
    service.sendSamples(new Float32Array(1280 * 3).fill(0.1), 999);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect((dispatchSpy.mock.calls[0][0] as CapturedPcmSegment).capturedAt).toBe(999);
  });
});
