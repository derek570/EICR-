/**
 * A1 composition regression — Flux EndOfTurn (with transcript) must drain a
 * deferred FIFO confirmation head.
 *
 * Bug (sess_mrbnds2d_jczh, 2026-07-08): the web Flux mapping fired ONLY
 * `onFinalTranscript` for a transcript-bearing EndOfTurn, never
 * `onUtteranceEnd`. `isInspectorSpeaking` (set true by the first interim) was
 * therefore never cleared after a real utterance, `shouldDeferPlayback()`
 * stayed true, and EVERY FIFO confirmation deferred forever — universal
 * read-back silently dead on web since the Flux flip (2026-07-03).
 *
 * iOS canon: `CertMateUnified/Sources/Services/DeepgramService.swift`
 * `handleFluxTurnInfo` — EndOfTurn fires `didReceiveFinalTranscript` +
 * `didReceiveUtteranceEnd`.
 *
 * This test wires the REAL DeepgramService (Flux path, fake WS) to the REAL
 * tts-queue via the same `handleInspectorStoppedSpeaking` helper
 * recording-context uses, mirroring the recording-context callback wiring
 * (interim → speaking=true; utterance-end → speaking=false + drain). Units in
 * isolation were green while the composition was broken — this pins the
 * composition.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DeepgramService,
  type DeepgramCallbacks,
  type WebSocketFactory,
} from '@/lib/recording/deepgram-service';
import {
  enqueueConfirmation,
  resumeIfDeferred,
  setShouldDeferPlayback,
  __resetForTests,
  __hasDeferredHeadForTests,
  type PreparedAudio,
} from '@/lib/recording/tts-queue';
import { handleInspectorStoppedSpeaking } from '@/lib/recording/tts-prompt-helpers';

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
  constructor(url: string, protocols?: string[]) {
    this.url = url;
    this.protocols = protocols;
  }
  send() {}
  close() {
    this.onclose?.({ code: 1000, wasClean: true });
  }
  open() {
    this.onopen?.();
  }
  emit(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

describe('A1 composition — Flux EndOfTurn drains a deferred confirmation', () => {
  beforeEach(() => {
    __resetForTests();
  });

  it('confirmation deferred mid-utterance resumes and plays after EndOfTurn(with transcript)', () => {
    // --- recording-context-equivalent wiring ---
    const isInspectorSpeaking = { current: false };
    const deferredTtsRef = { current: null };
    const speakDirectPrompt = vi.fn();
    setShouldDeferPlayback(() => isInspectorSpeaking.current);

    let ws: FakeWS | null = null;
    const factory: WebSocketFactory = (url, protocols) => {
      ws = new FakeWS(url, protocols) as unknown as WebSocket & FakeWS;
      return ws as unknown as WebSocket;
    };
    const cbs: DeepgramCallbacks = {
      onInterimTranscript: () => {
        isInspectorSpeaking.current = true;
      },
      onFinalTranscript: vi.fn(),
      onUtteranceEnd: () => {
        // Mirrors recording-context onUtteranceEnd: clear the flag, then the
        // shared drain helper (deferred prompt + deferred confirmation head).
        isInspectorSpeaking.current = false;
        handleInspectorStoppedSpeaking({
          deferredTtsRef,
          speakDirectPrompt,
          resumeIfDeferred,
        });
      },
    };
    const service = new DeepgramService(cbs, factory, 'flux');
    service.connect('fake-key', 16000);
    const sock = ws as unknown as FakeWS;
    sock.open();

    // --- inspector starts talking (first interim flips the flag) ---
    sock.emit({ type: 'TurnInfo', event: 'StartOfTurn' });
    sock.emit({ type: 'TurnInfo', event: 'Update', transcript: 'zed s is naught point' });
    expect(isInspectorSpeaking.current).toBe(true);

    // --- a confirmation arrives mid-utterance and defers at the last mile ---
    const played = vi.fn();
    const prepared: PreparedAudio = { play: played, discard: vi.fn() };
    enqueueConfirmation({
      text: 'Zs for circuit 1, 0.35 ohms',
      dedupeKey: 'k1',
      play: (_text, controls) => {
        controls.ready(prepared); // gate is true → parks as deferredHead
      },
    });
    expect(__hasDeferredHeadForTests()).toBe(true);
    expect(played).not.toHaveBeenCalled();

    // --- Flux closes the turn WITH a transcript (the A1 case) ---
    sock.emit({
      type: 'TurnInfo',
      event: 'EndOfTurn',
      transcript: 'zed s is naught point three five',
      end_of_turn_confidence: 0.9,
    });

    // Pre-fix: no onUtteranceEnd → flag stuck true → head stranded forever.
    expect(isInspectorSpeaking.current).toBe(false);
    expect(__hasDeferredHeadForTests()).toBe(false);
    expect(played).toHaveBeenCalledTimes(1);
  });
});
