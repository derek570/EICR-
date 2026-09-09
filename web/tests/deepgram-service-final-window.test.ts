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
  it('[invariant] speech_start = dispatched offset at the onset frame, confirmed by StartOfTurn inside 2.5 s; window_end = origin + audio_window_end', () => {
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

  it('[invariant] a non-empty interim confirms; an empty interim, a silence transition, or a late StartOfTurn does not (unbounded)', () => {
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

  it('[invariant] a confirmed run followed by silence and then an UNCONFIRMED run: the second run’s final is unbounded (it never inherits the first run’s onset); a confirmed run still serves its own later turns', () => {
    const h = harness();
    h.ws().open();
    // Run 1: onset at 1280, confirmed by StartOfTurn, final emitted, silence.
    h.service.sendSamples(voiced());
    h.service.noteLocalSpeechOnset(h.nowMs());
    h.service.sendSamples(voiced());
    h.tick(180);
    h.ws().emit({ type: 'TurnInfo', event: 'StartOfTurn' });
    h.tick(1500);
    // Flux may close a second turn inside the SAME run — still served.
    h.ws().emit(endOfTurn('Circuit 4 Zs is 0.35.', 2.0));
    h.tick(100);
    h.ws().emit({ type: 'TurnInfo', event: 'StartOfTurn' });
    h.tick(1000);
    h.ws().emit(endOfTurn('and circuit 3 R1 plus R2 0.2.', 3.0));
    expect(h.finals.map((f) => f.meta!.speechStart)).toEqual([1280, 1280]);
    // The VAD's debounced silence lands AFTER the run's own EndOfTurn in the
    // field; a final that follows the silence but precedes any new onset is
    // still run 1's (its confirmation survives the transition).
    h.service.noteLocalSilence();
    h.tick(300);
    h.ws().emit(endOfTurn('tail of run one', 3.5));
    expect(h.finals[2].meta!.speechStart).toBe(1280);
    // Run 2: a new onset with NO provider evidence inside 2.5 s (noise).
    for (let i = 0; i < 10; i++) h.service.sendSamples(voiced());
    h.service.noteLocalSpeechOnset(h.nowMs());
    h.tick(3000);
    h.ws().emit(endOfTurn('noise that Deepgram closed late', 6.0));
    expect(h.finals[3].meta!.speechStart).toBeNull();
    // Run 3 confirms normally and carries ITS OWN offset.
    h.service.noteLocalSilence();
    h.service.sendSamples(voiced());
    const run3Onset = h.service.dispatchedStreamOffset;
    h.service.noteLocalSpeechOnset(h.nowMs());
    h.service.sendSamples(voiced());
    h.tick(200);
    h.ws().emit({
      type: 'TurnInfo',
      event: 'Update',
      transcript: 'circuit',
      end_of_turn_confidence: 0.1,
    });
    h.ws().emit(endOfTurn('Circuit 2 Zs is 0.4.', 8.0));
    expect(h.finals[4].meta!.speechStart).toBe(run3Onset);
  });

  it('[invariant] a malformed audio_window_end yields window_end null', () => {
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
  it('[invariant] disconnect() invalidates admission SYNCHRONOUSLY, before the CloseStream grace; the late final still retires its watermark', () => {
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

  it('[invariant] a final from a superseded socket (old epoch) is inadmissible, yet advanceProcessedWatermark still retires ITS epoch', async () => {
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

describe('nova-3 — meta derived OUTSIDE the frozen handleMessage, attributed to the emitting socket', () => {
  it('[invariant] nova meta comes from the callback wrapper: speech_start/window_end from the word times, identity from the FRAME start/duration, and a late final from a superseded socket is inadmissible under ITS epoch', async () => {
    vi.useFakeTimers();
    try {
      const h = harness('nova3', { fetcher: true });
      await flush();
      h.ws().open();
      h.service.sendSamples(voiced());
      const oldSocket = h.ws();
      const oldEpoch = h.service.liveEpoch;
      // Onset, confirmed by a NON-EMPTY nova interim (the frozen path never
      // notes evidence itself — the callback wrapper does).
      h.service.noteLocalSpeechOnset(h.nowMs());
      h.tick(300);
      oldSocket.emit({
        type: 'Results',
        is_final: false,
        channel: { alternatives: [{ transcript: 'circuit', confidence: 0.5, words: [] }] },
      });
      oldSocket.emit({
        type: 'Results',
        is_final: true,
        start: 0.0,
        duration: 1.6,
        channel: {
          alternatives: [
            {
              transcript: 'circuit 4 zs 0.35',
              confidence: 0.9,
              words: [
                { word: 'circuit', start: 0.1, end: 0.4, confidence: 0.9 },
                { word: '0.35', start: 1.0, end: 1.5, confidence: 0.9 },
              ],
            },
          ],
        },
      });
      const first = h.finals[0].meta!;
      expect(first.admissible).toBe(true);
      expect(first.epoch).toBe(oldEpoch);
      expect(first.speechStart).toBe(1600); // 0.1 s × 16 kHz (provider word start)
      expect(first.windowEnd).toBe(24000); // 1.5 s
      expect(first.providerFinalId).toBe(`${oldEpoch}|nova|0|1.6`);
      // Unowned close → reconnect on a NEW socket / epoch; the OLD socket's
      // late final is attributed to the old epoch and is inadmissible.
      oldSocket.onclose?.({ code: 1006, wasClean: false });
      vi.advanceTimersByTime(5_000);
      await flush();
      h.ws().open();
      expect(h.service.liveEpoch).not.toBe(oldEpoch);
      oldSocket.emit({
        type: 'Results',
        is_final: true,
        channel: {
          alternatives: [{ transcript: 'late from old socket', confidence: 0.9, words: [] }],
        },
      });
      const late = h.finals[h.finals.length - 1].meta!;
      expect(late.epoch).toBe(oldEpoch);
      expect(late.admissible).toBe(false);
      // No frame fields, no words: NO identity (never the text).
      expect(late.providerFinalId).toBeNull();
      // A final on the NEW socket is admissible under the new epoch.
      h.ws().emit({
        type: 'Results',
        is_final: true,
        channel: { alternatives: [{ transcript: 'fresh', confidence: 0.9, words: [] }] },
      });
      const fresh = h.finals[h.finals.length - 1].meta!;
      expect(fresh.epoch).toBe(h.service.liveEpoch);
      expect(fresh.admissible).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('nova-3 provider identity — frame fields only, never the transcript', () => {
  it('[invariant] two distinct WORDLESS finals with identical text carry distinct identities (different frame start), an exact frame redelivery carries the same one, and a frame with no start/duration carries none', () => {
    const h = harness('nova3');
    h.ws().open();
    const wordless = (start: number, duration: number) => ({
      type: 'Results',
      is_final: true,
      start,
      duration,
      channel: {
        alternatives: [{ transcript: 'calculate zs for circuit 4', confidence: 0.9, words: [] }],
      },
    });
    h.ws().emit(wordless(2.0, 1.2));
    h.ws().emit(wordless(9.0, 1.2)); // the inspector genuinely repeats it
    h.ws().emit(wordless(2.0, 1.2)); // exact redelivery of the first frame
    h.ws().emit({
      type: 'Results',
      is_final: true,
      channel: {
        alternatives: [{ transcript: 'calculate zs for circuit 4', confidence: 0.9, words: [] }],
      },
    });
    const ids = h.finals.map((f) => f.meta!.providerFinalId);
    const epoch = h.service.liveEpoch;
    expect(ids).toEqual([
      `${epoch}|nova|2|1.2`,
      `${epoch}|nova|9|1.2`,
      `${epoch}|nova|2|1.2`,
      null,
    ]);
    expect(ids[0]).not.toBe(ids[1]);
    for (const f of h.finals) expect(f.meta!.speechStart).toBeNull(); // wordless → unbounded
  });
});

describe('nova-3 uses first word start and last word end', () => {
  it('[invariant] word-timed final → speech_start and window_end from provider word times; no words → unbounded', () => {
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
