/**
 * PLAN-E2 — `DeepgramService` ↔ loss-ledger wiring (test 2b's web cases,
 * the watermark parse, ownership by `disconnect()`, `captureActive`, and
 * the every-open observation through `onStateChange('connected')`).
 * Uses the same hand-fake WebSocket seam as `deepgram-service-flux.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DeepgramService,
  createCaptureClock,
  createSessionCodecLatch,
  type DeepgramCallbacks,
  type DeepgramSessionContext,
  type WebSocketFactory,
} from '@/lib/recording/deepgram-service';
import { UplinkScopeAllocator } from '@/lib/recording/uplink-scope-allocator';
import { UplinkLossLedger, type LossSourceId } from '@/lib/recording/uplink-loss-ledger';
import { VoicedActivityDetector } from '@/lib/recording/voiced-activity';

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
  throwOnSend = false;
  constructor(url: string, protocols?: string[]) {
    this.url = url;
    this.protocols = protocols;
  }
  send(data: string | ArrayBuffer) {
    if (this.throwOnSend) throw new Error('backpressure');
    this.sent.push(data);
  }
  close(code = 1000) {
    this.onclose?.({ code, wasClean: true });
  }
  open() {
    this.onopen?.();
  }
  emit(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

// 3 exact 80ms Flux frames (240ms) — one `voiced()` call is a debounced
// (≥200ms) contiguous voiced run and dispatches as exactly 3 ledger entries.
function voiced(len = 3840): Float32Array {
  const f = new Float32Array(len);
  for (let i = 0; i < len; i++) f[i] = i % 2 === 0 ? 0.3 : -0.3;
  return f;
}

function harness(opts: { model?: 'flux' | 'nova3'; fetcher?: boolean } = {}) {
  const disclosed: LossSourceId[][] = [];
  const events: string[] = [];
  const ledger = new UplinkLossLedger({
    recordingSessionId: 'sess-A',
    onDisclosureReady: (ids) => disclosed.push(ids),
    telemetry: (event) => events.push(event),
  });
  const ctx: DeepgramSessionContext = {
    recordingSessionId: 'sess-A',
    codecLatch: createSessionCodecLatch(),
    allocator: new UplinkScopeAllocator(),
    captureClock: createCaptureClock(),
    vad: new VoicedActivityDetector(() => {}),
    lossLedger: ledger,
  };
  const sockets: FakeWS[] = [];
  const factory: WebSocketFactory = (url, protocols) => {
    const ws = new FakeWS(url, protocols);
    sockets.push(ws);
    return ws as unknown as WebSocket;
  };
  const states: string[] = [];
  const cbs: DeepgramCallbacks = {
    onInterimTranscript: vi.fn(),
    onFinalTranscript: vi.fn(),
    onStateChange: (s) => {
      states.push(s);
      // Production wiring: every 'connected' is the ledger's disclosure moment.
      if (s === 'connected') ledger.onSocketOpened(service.liveEpoch!);
    },
    onError: vi.fn(),
  };
  const service = new DeepgramService(cbs, factory, opts.model ?? 'flux', { sessionContext: ctx });
  service.captureActive = true;
  if (opts.fetcher) {
    service.connect(async () => ({ key: 'k' }), 16000);
  } else {
    service.connect('k', 16000);
  }
  return { service, ledger, ctx, sockets, disclosed, events, states, ws: () => sockets[sockets.length - 1] };
}

describe('DeepgramService — ownership + captureActive (2b)', () => {
  it('disconnect() marks the close OWNED: no episode, entries discarded', () => {
    const h = harness();
    h.ws().open();
    h.service.sendSamples(voiced());
    expect(h.ledger.unresolvedEntryCount).toBe(3);
    h.service.disconnect();
    expect(h.ledger.isEpisodeOpen).toBe(false);
    expect(h.ledger.unresolvedEntryCount).toBe(0);
    h.ws().close(1000); // the 300ms-later close (or the server's) — still owned
    expect(h.ledger.isEpisodeOpen).toBe(false);
  });

  it('an UNSOLICITED 1000 close while capture is active opens an episode; reconnect behaviour UNCHANGED (none)', () => {
    const h = harness({ fetcher: true });
    return new Promise<void>((resolve) => {
      queueMicrotask(async () => {
        await Promise.resolve();
        h.ws().open();
        h.service.sendSamples(voiced());
        h.ws().close(1000);
        expect(h.ledger.isEpisodeOpen).toBe(true);
        expect(h.service.connectionState).toBe('disconnected');
        expect(h.sockets).toHaveLength(1); // no reconnect scheduled (Carve A)
        resolve();
      });
    });
  });

  it('an unsolicited 1005 close → same (episode, no reconnect)', async () => {
    const h = harness({ fetcher: true });
    await Promise.resolve();
    await Promise.resolve();
    h.ws().open();
    h.service.sendSamples(voiced());
    h.ws().close(1005);
    expect(h.ledger.isEpisodeOpen).toBe(true);
    expect(h.sockets).toHaveLength(1);
  });

  it('an unsolicited close on a code today\'s gates DO retry (1006) → episode + reconnect exactly as today; disclosure fires on the reopen', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ fetcher: true });
      await Promise.resolve();
      await Promise.resolve();
      h.ws().open();
      h.service.sendSamples(voiced()); // dispatched, unretired
      h.ws().close(1006);
      expect(h.ledger.isEpisodeOpen).toBe(true);
      expect(h.service.connectionState).toBe('reconnecting');
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.resolve();
      expect(h.sockets).toHaveLength(2);
      h.ws().open();
      expect(h.ledger.isEpisodeOpen).toBe(false);
      expect(h.disclosed).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('close while capture is INACTIVE → no episode', () => {
    const h = harness();
    h.ws().open();
    h.service.sendSamples(voiced());
    h.service.captureActive = false;
    h.ws().close(1006);
    expect(h.ledger.isEpisodeOpen).toBe(false);
  });

  it('captureActive is a CLASSIFICATION signal only — it never gates a send', () => {
    const h = harness();
    h.ws().open();
    h.service.captureActive = false;
    h.service.sendSamples(voiced());
    expect(h.ws().sent.length).toBeGreaterThan(0);
  });
});

describe('DeepgramService — entry paths + watermark', () => {
  it('pre-open voiced frames (state connecting) are charged as a pre-open window; the FIRST open discloses exactly once', () => {
    const h = harness();
    h.service.sendSamples(voiced()); // before open
    h.service.sendSamples(voiced());
    expect(h.ledger.pendingPreOpenWindowCount).toBe(1);
    h.ws().open();
    expect(h.disclosed).toHaveLength(1);
    expect(h.disclosed[0][0].kind).toBe('preOpenWindow');
  });

  it('a fast open with no pre-open speech speaks nothing', () => {
    const h = harness();
    h.ws().open();
    expect(h.disclosed).toHaveLength(0);
  });

  it('Flux `audio_window_end` (seconds) retires same-epoch dispatched ranges — a fully-transcribed connection that drops discloses NOTHING', () => {
    const h = harness();
    h.ws().open();
    h.service.sendSamples(voiced()); // 3840 samples dispatched (3 frames)
    h.ws().emit({ type: 'TurnInfo', event: 'Update', transcript: 'zs point five', audio_window_end: 0.24 });
    h.ws().close(1006);
    expect(h.ledger.isEpisodeOpen).toBe(true);
    expect(h.ledger.unresolvedEntryCount).toBe(0);
  });

  it('a partially-processed voiced tail (watermark behind) → one disclosure at the reopen', () => {
    const h = harness();
    h.ws().open();
    h.service.sendSamples(voiced());
    h.service.sendSamples(voiced()); // second run (3 frames) not yet processed
    h.ws().emit({ type: 'TurnInfo', event: 'Update', transcript: 'zs', audio_window_end: 0.24 });
    h.ws().close(1006);
    expect(h.ledger.unresolvedEntryCount).toBe(3);
  });

  it('a malformed audio_window_end never retires anything', () => {
    const h = harness();
    h.ws().open();
    h.service.sendSamples(voiced());
    h.ws().emit({ type: 'TurnInfo', event: 'Update', transcript: 'x', audio_window_end: -1 });
    h.ws().emit({ type: 'TurnInfo', event: 'Update', transcript: 'x', audio_window_end: 'NaN' });
    expect(h.ledger.unresolvedEntryCount).toBe(3);
  });

  it('nova-3 records NO dispatched entries (no pinned retirement signal) — a reconnect after speech never false-discloses', () => {
    const h = harness({ model: 'nova3' });
    h.ws().open();
    h.service.sendSamples(voiced());
    expect(h.ledger.unresolvedEntryCount).toBe(0);
  });

  it('a caught send failure on a live socket is a known loss (variant a) carried into the episode', () => {
    const h = harness();
    h.ws().open();
    h.ws().throwOnSend = true;
    h.service.sendSamples(voiced());
    h.ws().close(1006);
    expect(h.ledger.isEpisodeOpen).toBe(true);
    expect(h.ledger.unresolvedEntryCount).toBe(3);
  });

  it('PLAN-E1\'s onUndispatchedLoss seam is bound to the ledger by default (variant d)', () => {
    const h = harness();
    // The Flux batcher's sub-frame tail at an unexpected close is charged via the seam.
    h.ws().open();
    h.service.sendSamples(voiced(640)); // half a frame — sits in the accumulator
    h.ws().close(1006);
    expect(h.ledger.isEpisodeOpen).toBe(true);
    expect(h.ledger.unresolvedEntryCount).toBe(1);
  });

  it('the watermark is epoch-origin-relative: a reconnect restarts audio_window_end at 0 for the new epoch only', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ fetcher: true });
      await Promise.resolve();
      await Promise.resolve();
      h.ws().open();
      h.service.sendSamples(voiced()); // abs [0,3840) epoch 1
      h.ws().emit({ type: 'TurnInfo', event: 'Update', transcript: 'a', audio_window_end: 0.24 });
      h.ws().close(1006);
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.resolve();
      h.ws().open();
      h.service.sendSamples(voiced()); // abs [3840,7680) epoch 2
      // 0.16s on the NEW connection retires only its first two frames —
      // the origin is per-epoch, so nothing of epoch 1's range is touched.
      h.ws().emit({ type: 'TurnInfo', event: 'Update', transcript: 'b', audio_window_end: 0.16 });
      expect(h.ledger.unresolvedEntryCount).toBe(1);
      h.ws().emit({ type: 'TurnInfo', event: 'Update', transcript: 'b', audio_window_end: 0.24 });
      expect(h.ledger.unresolvedEntryCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('DeepgramService — Codex cycle-1 regressions', () => {
  it('an UNOWNED 1000 close charges the partial Flux tail as episode evidence (ownership, not the close code)', () => {
    const h = harness();
    h.ws().open();
    h.service.sendSamples(voiced(640)); // half a frame — sits in the accumulator
    h.ws().close(1000); // unsolicited normal close: no reconnect today, still an outage
    expect(h.ledger.isEpisodeOpen).toBe(true);
    expect(h.ledger.unresolvedEntryCount).toBe(1);
  });

  it('pause → the owned close → resume on the same instance: the new pre-open window is disclosed at the reopen, and the owned close never opens an episode', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.ws().open();
      h.service.sendSamples(voiced());
      h.service.disconnect(); // owned: ledger discards, marks epoch 1 closed
      expect(h.ledger.unresolvedEntryCount).toBe(0);
      await vi.advanceTimersByTimeAsync(300); // the deferred ws.close(1000)
      h.sockets[0].close(1000); // the owned close callback
      expect(h.ledger.isEpisodeOpen).toBe(false);
      h.service.connect('k', 16000); // resume on the same instance
      expect(h.sockets).toHaveLength(2);
      h.service.sendSamples(voiced()); // captured before the new socket opens
      expect(h.ledger.pendingPreOpenWindowCount).toBe(1);
      h.ws().open();
      expect(h.disclosed).toHaveLength(1);
      expect(h.disclosed[0][0].kind).toBe('preOpenWindow');
    } finally {
      vi.useRealTimers();
    }
  });
});
