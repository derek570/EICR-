/**
 * A02D FinalWindowV1 — the transport half, through the REAL `DeepgramService`
 * with a captive WebSocket: every final carries `{epoch, admissible,
 * speechStart, windowEnd}`; `speechStart` is the session VAD's onset at the
 * epoch's dispatched offset, confirmed only by StartOfTurn / a non-empty
 * interim inside 2.5 s; `windowEnd` is the EndOfTurn `audio_window_end` in
 * the epoch's dispatched domain; admission is invalidated SYNCHRONOUSLY in
 * `disconnect()` and by an epoch mismatch — while `advanceProcessedWatermark`
 * still runs for the stale socket (PLAN-E2 retirement untouched).
 */
import { describe, expect, it, vi } from 'vitest';

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}
import {
  DeepgramService,
  createCaptureClock,
  createSessionCodecLatch,
  type DeepgramCallbacks,
  type DeepgramSessionContext,
  type WebSocketFactory,
} from '@/lib/recording/deepgram-service';
import { UplinkScopeAllocator } from '@/lib/recording/uplink-scope-allocator';
import { UplinkLossLedger } from '@/lib/recording/uplink-loss-ledger';
import { VoicedActivityDetector } from '@/lib/recording/voiced-activity';
import type { FinalTranscriptMeta } from '@/lib/recording/final-window';

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

function voiced(len = 1280): Float32Array {
  const f = new Float32Array(len);
  for (let i = 0; i < len; i++) f[i] = i % 2 === 0 ? 0.3 : -0.3;
  return f;
}

function harness(model: 'flux' | 'nova3' = 'flux', opts: { fetcher?: boolean } = {}) {
  let now = 0;
  const finals: Array<{ text: string; meta: FinalTranscriptMeta | undefined }> = [];
  const ledger = new UplinkLossLedger({
    recordingSessionId: 'sess-A',
    onDisclosureReady: () => {},
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
  const cbs: DeepgramCallbacks = {
    onInterimTranscript: () => {},
    onFinalTranscript: (text, _c, _w, meta) => finals.push({ text, meta }),
    onStateChange: (s) => {
      if (s === 'connected') ledger.onSocketOpened(service.liveEpoch!);
    },
  };
  const service = new DeepgramService(cbs, factory, model, {
    sessionContext: ctx,
    now: () => now,
  });
  service.captureActive = true;
  if (opts.fetcher) void service.connect(async () => ({ key: 'k' }), 16000);
  else service.connect('k', 16000);
  return {
    service,
    ledger,
    sockets,
    finals,
    ws: () => sockets[sockets.length - 1],
    tick: (ms: number) => {
      now += ms;
    },
    nowMs: () => now,
  };
}

const endOfTurn = (transcript: string, windowEnd = 2.0) => ({
  type: 'TurnInfo',
  event: 'EndOfTurn',
  transcript,
  end_of_turn_confidence: 0.9,
  audio_window_end: windowEnd,
  words: [],
});

describe('FinalWindowV1 meta on Flux finals', () => {
  it('speech_start = dispatched offset at the onset frame, confirmed by StartOfTurn inside 2.5 s; window_end = origin + audio_window_end', () => {
    const h = harness();
    h.ws().open();
    // 3 frames (3840 samples) dispatched before the onset.
    for (let i = 0; i < 3; i++) h.service.sendSamples(voiced());
    expect(h.service.dispatchedStreamOffset).toBe(3840);
    h.service.noteLocalSpeechOnset(h.nowMs());
    h.service.sendSamples(voiced()); // the onset frame
    h.tick(180);
    h.ws().emit({ type: 'TurnInfo', event: 'StartOfTurn' });
    h.tick(1800);
    h.ws().emit(endOfTurn('Circuit 4 Zs is 0.35.', 2.0));
    expect(h.finals).toHaveLength(1);
    const meta = h.finals[0].meta!;
    expect(meta.admissible).toBe(true);
    expect(meta.epoch).toBe(h.service.liveEpoch);
    expect(meta.speechStart).toBe(3840);
    expect(meta.windowEnd).toBe(32000);
  });

  it('a non-empty interim confirms; an empty interim, a silence transition, or a late StartOfTurn does not (unbounded)', () => {
    const h = harness();
    h.ws().open();
    h.service.noteLocalSpeechOnset(h.nowMs());
    h.tick(900);
    h.ws().emit({ type: 'TurnInfo', event: 'Update', transcript: '', end_of_turn_confidence: 0.1 });
    h.tick(2000); // 2.9 s after the onset: the deadline has passed
    h.ws().emit({ type: 'TurnInfo', event: 'StartOfTurn' });
    h.ws().emit(endOfTurn('noise held run', 3.0));
    expect(h.finals[0].meta!.speechStart).toBeNull();

    h.service.noteLocalSpeechOnset(h.nowMs());
    h.service.noteLocalSilence(); // silence before any evidence
    h.tick(100);
    h.ws().emit({ type: 'TurnInfo', event: 'StartOfTurn' });
    h.ws().emit(endOfTurn('after silence', 4.0));
    expect(h.finals[1].meta!.speechStart).toBeNull();

    h.service.sendSamples(voiced());
    h.service.noteLocalSpeechOnset(h.nowMs());
    h.tick(500);
    h.ws().emit({
      type: 'TurnInfo',
      event: 'Update',
      transcript: 'circuit',
      end_of_turn_confidence: 0.1,
    });
    h.ws().emit(endOfTurn('confirmed by interim', 5.0));
    expect(h.finals[2].meta!.speechStart).toBe(1280);
    expect(h.finals[2].meta!.windowEnd).toBe(80000);
  });

  it('a malformed audio_window_end yields window_end null', () => {
    const h = harness();
    h.ws().open();
    h.ws().emit({
      type: 'TurnInfo',
      event: 'EndOfTurn',
      transcript: 'x',
      end_of_turn_confidence: 0.9,
      audio_window_end: -1,
      words: [],
    });
    h.ws().emit({
      type: 'TurnInfo',
      event: 'EndOfTurn',
      transcript: 'y',
      end_of_turn_confidence: 0.9,
      words: [],
    });
    expect(h.finals[0].meta!.windowEnd).toBeNull();
    expect(h.finals[1].meta!.windowEnd).toBeNull();
  });
});

describe('A02D admission — the service half', () => {
  it('disconnect() invalidates admission SYNCHRONOUSLY, before the CloseStream grace; the late final still retires its watermark', () => {
    const h = harness();
    h.ws().open();
    for (let i = 0; i < 3; i++) h.service.sendSamples(voiced());
    expect(h.ledger.unresolvedEntryCount).toBe(3);
    const socket = h.ws();
    h.service.disconnect();
    // The socket is still the instance's own during the grace window; a late
    // final from it is INADMISSIBLE for A02D …
    socket.emit(endOfTurn('late final after stop', 1.0));
    expect(h.finals).toHaveLength(1);
    expect(h.finals[0].meta!.admissible).toBe(false);
    // … while PLAN-E2's owned-close accounting is exactly as before
    // (discarded at the owned disconnect, nothing re-opened).
    expect(h.ledger.isEpisodeOpen).toBe(false);
  });

  it('a final from a superseded socket (old epoch) is inadmissible, yet advanceProcessedWatermark still retires ITS epoch', async () => {
    vi.useFakeTimers();
    try {
      const h = harness('flux', { fetcher: true });
      await flush();
      h.ws().open();
      for (let i = 0; i < 3; i++) h.service.sendSamples(voiced());
      const oldSocket = h.ws();
      const oldEpoch = h.service.liveEpoch;
      expect(h.ledger.unresolvedEntryCount).toBe(3);
      // Unowned close → backoff → reconnect on a NEW socket with a NEW epoch.
      oldSocket.onclose?.({ code: 1006, wasClean: false });
      vi.advanceTimersByTime(5_000);
      await flush();
      expect(h.sockets.length).toBe(2);
      h.ws().open();
      expect(h.service.liveEpoch).not.toBe(oldEpoch);
      // A late TurnInfo from the OLD socket: inadmissible for A02D …
      oldSocket.emit(endOfTurn('late from old socket', 0.24));
      const late = h.finals[h.finals.length - 1];
      expect(late.text).toBe('late from old socket');
      expect(late.meta!.epoch).toBe(oldEpoch);
      expect(late.meta!.admissible).toBe(false);
      // … while PLAN-E2's watermark for the OLD epoch still advanced: its
      // dispatched entries ending at or before 0.24 s (3840 samples) retired.
      expect(h.ledger.unresolvedEntryCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('nova-3 uses first word start and last word end', () => {
  it('word-timed final → speech_start and window_end from provider word times; no words → unbounded', () => {
    const h = harness('nova3');
    h.ws().open();
    h.ws().emit({
      type: 'Results',
      is_final: true,
      channel: {
        alternatives: [
          {
            transcript: 'Circuit 4 Zs is 0.35.',
            confidence: 0.9,
            words: [
              { word: 'circuit', start: 0.42, end: 0.7, confidence: 0.9 },
              { word: '0.35', start: 1.1, end: 1.5, confidence: 0.9 },
            ],
          },
        ],
      },
    });
    expect(h.finals[0].meta!.speechStart).toBe(6720);
    expect(h.finals[0].meta!.windowEnd).toBe(24000);
    h.ws().emit({
      type: 'Results',
      is_final: true,
      channel: { alternatives: [{ transcript: 'no words', confidence: 0.9, words: [] }] },
    });
    expect(h.finals[1].meta!.speechStart).toBeNull();
    expect(h.finals[1].meta!.windowEnd).toBeNull();
  });
});
