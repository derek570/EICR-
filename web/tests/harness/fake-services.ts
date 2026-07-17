/**
 * Harness fakes for the B1 injection seams (pwa-replay-harness Waves 2-3).
 *
 * These stand in for the EXTERNAL effects only — Deepgram audio/WS, the
 * Sonnet backend WS, the microphone, and the audio players. Everything
 * between (dispatchFinal, gates, regex, classifiers, TTS FIFO, apply
 * pipeline) is the REAL production code, driven through the real
 * RecordingProvider. That composition is the harness's whole subject.
 */
import {
  DeepgramService,
  type DeepgramCallbacks,
  type DeepgramConnectionState,
  type SttModel,
} from '@/lib/recording/deepgram-service';
import type {
  DeepgramServiceLike,
  SonnetSessionLike,
  RecordingTestServices,
} from '@/lib/recording/test-services';
import type { SonnetConnectionState } from '@/lib/recording/sonnet-session';
import type { MicCaptureHandle, MicCaptureOptions } from '@/lib/recording/mic-capture';
import type { SpeakOptions } from '@/lib/recording/tts';
import type { QueuePlayControls, PreparedAudio } from '@/lib/recording/tts-queue';

/** Minimal captive WebSocket the wrapped REAL DeepgramService talks to.
 *  Mirrors the FakeWS the flux unit tests use. */
class CaptiveWS {
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
  open() {
    this.onopen?.();
  }
  emit(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

/**
 * Harness Deepgram service — wraps a REAL `DeepgramService` around a
 * captive fake WebSocket, so the harness drives RAW FLUX FRAMES through
 * the REAL frame parsing + TurnInfo→delegate mapping. This is
 * load-bearing for the keystone: A1 lives INSIDE that mapping
 * (EndOfTurn-with-transcript → final + utterance-end), so a fake that
 * invoked the delegate callbacks directly would keep the harness green
 * with A1 reverted (discovered in the first keystone RED attempt —
 * the fake was hardcoding the fixed mapping).
 *
 * Only the network is fake: connect() feeds the real service a static
 * key (skipping the fetcher — no network) and auto-opens the captive
 * socket.
 */
export class FakeDeepgramService implements DeepgramServiceLike {
  readonly model: SttModel;
  private readonly inner: DeepgramService;
  private ws: CaptiveWS | null = null;
  sentSampleBlocks = 0;

  constructor(callbacks: DeepgramCallbacks, model: SttModel) {
    this.model = model;
    this.inner = new DeepgramService(
      callbacks,
      (url, protocols) => {
        this.ws = new CaptiveWS(url, protocols);
        return this.ws as unknown as WebSocket;
      },
      model
    );
  }

  connect(_keyOrFetcher: string | (() => Promise<string>), sourceSampleRate: number): void {
    // Static-key mode constructs the socket synchronously (same recipe as
    // the flux unit tests); the production fetcher is ignored — no network.
    this.inner.connect('harness-static-key', sourceSampleRate);
    this.ws?.open();
  }
  disconnect(): void {
    this.inner.disconnect();
  }
  pause(): void {
    this.inner.pause();
  }
  resume(replay?: Int16Array | null): void {
    this.inner.resume(replay ?? undefined);
  }
  sendSamples(samples: Float32Array): void {
    this.sentSampleBlocks += 1;
    this.inner.sendSamples(samples);
  }
  sendInt16PCM(pcm: Int16Array): void {
    this.inner.sendInt16PCM(pcm);
  }
  get connectionState(): DeepgramConnectionState {
    return this.inner.connectionState;
  }

  // ── Raw Flux frame drivers — parsed by the REAL service ──
  emitFrame(frame: Record<string, unknown>): void {
    if (!this.ws) throw new Error('FakeDeepgramService: connect() has not run');
    this.ws.emit(frame);
  }
  emitSpeechStarted(): void {
    this.emitFrame({ type: 'TurnInfo', event: 'StartOfTurn' });
  }
  emitInterim(text: string, confidence = 0.5): void {
    this.emitFrame({
      type: 'TurnInfo',
      event: 'Update',
      transcript: text,
      end_of_turn_confidence: confidence,
    });
  }
  /** Transcript-bearing EndOfTurn — the REAL mapping decides what fires
   *  (post-A1: final + utterance-end; pre-A1: final only). */
  emitEndOfTurn(text: string, confidence = 0.9): void {
    this.emitFrame({
      type: 'TurnInfo',
      event: 'EndOfTurn',
      transcript: text,
      end_of_turn_confidence: confidence,
      words: [],
    });
  }
  /** Empty EndOfTurn (silence-driven close). */
  emitEmptyEndOfTurn(): void {
    this.emitFrame({ type: 'TurnInfo', event: 'EndOfTurn', transcript: '' });
  }
}

/** Minimal callback surface the fake session needs (subset of the real
 *  SonnetSessionCallbacks — typed loosely; recording-context passes the
 *  full object). */
export interface FakeSonnetCallbacks {
  onStateChange?: (state: SonnetConnectionState) => void;
  onSessionAck?: (status: string, sessionId: string | null) => void;
  onExtraction?: (result: unknown) => void;
  onQuestion?: (q: unknown) => void;
  onFieldCorrected?: (msg: unknown) => void;
  [key: string]: unknown;
}

export interface SentTranscript {
  text: string;
  options: unknown;
}

/**
 * Fake Sonnet session. Records what the pipeline sends; the harness emits
 * scripted backend frames by calling the recorded callbacks (mock mode,
 * B3) or an adapter can bridge to a live SonnetSession (live mode).
 */
export class FakeSonnetSession implements SonnetSessionLike {
  readonly callbacks: FakeSonnetCallbacks;
  readonly sentTranscripts: SentTranscript[] = [];
  readonly sentAskAnswers: Array<{ toolCallId: string; text: string }> = [];
  readonly diagnostics: Array<{ category: string; payload: Record<string, unknown> }> = [];
  private inFlightToolCallId: string | null = null;
  private state: SonnetConnectionState = 'idle' as SonnetConnectionState;

  constructor(callbacks: FakeSonnetCallbacks) {
    this.callbacks = callbacks;
  }

  connect(): void {
    this.state = 'connected' as SonnetConnectionState;
    this.callbacks.onStateChange?.(this.state);
    this.callbacks.onSessionAck?.('started', 'fake-server-session');
  }
  disconnect(): void {
    this.state = 'disconnected' as SonnetConnectionState;
  }
  pause(): void {}
  resume(): void {}
  sendTranscript(text: string, options?: unknown): void {
    this.sentTranscripts.push({ text, options });
  }
  sendAskUserAnswered(toolCallId: string, text: string): void {
    this.sentAskAnswers.push({ toolCallId, text });
  }
  sendCompactRequest(): void {}
  sendJobStateUpdate(): void {}
  peekInFlightToolCallId(): string | null {
    return this.inFlightToolCallId;
  }
  consumeInFlightToolCallId(): string | null {
    const id = this.inFlightToolCallId;
    this.inFlightToolCallId = null;
    return id;
  }
  clearInFlightToolCallIdByPrefix(): void {
    this.inFlightToolCallId = null;
  }
  get connectionState(): SonnetConnectionState {
    return this.state;
  }
  sendClientDiagnostic(category: string, payload: Record<string, unknown> = {}): void {
    this.diagnostics.push({ category, payload });
  }

  // ── harness drivers ──
  setInFlightToolCallId(id: string | null): void {
    this.inFlightToolCallId = id;
  }
  emitExtraction(result: unknown): void {
    this.callbacks.onExtraction?.(result);
  }
  emitQuestion(q: unknown): void {
    this.callbacks.onQuestion?.(q);
  }
  /** Stage 6 STI-05 `field_corrected` frame (clear_reading wire). Drives
   *  the REAL recording-context onFieldCorrected → field_clears apply
   *  path — the A2 canonicalised-clear-key mock-lane pin rides this. */
  emitFieldCorrected(msg: { circuit: number; field: string }): void {
    this.callbacks.onFieldCorrected?.(msg);
  }
}

/** Silent fake mic — resolves immediately; the harness feeds transcripts
 *  through FakeDeepgramService, so no audio samples are needed. */
export function fakeMicCaptureFactory(_opts: MicCaptureOptions): Promise<MicCaptureHandle> {
  return Promise.resolve({ sampleRate: 16000, stop: () => {} });
}

export interface PlayedAudio {
  kind: 'confirmation' | 'direct';
  text: string;
}

/**
 * Instant TTS players: "audio" completes synchronously by default (or on
 * manual control when `manual` is set). Confirmation player honours the
 * queue's prepared/ready contract so the REAL last-mile defer gate runs.
 */
export class FakeTtsPlayers {
  readonly played: PlayedAudio[] = [];
  readonly discarded: string[] = [];
  /** When true, prepared confirmation audio must be released via
   *  `releaseAll()` (models the ElevenLabs fetch window). */
  manual = false;
  private pendingPlays: Array<() => void> = [];

  confirmationPlayer = (text: string, controls: QueuePlayControls): void => {
    const prepared: PreparedAudio = {
      play: () => {
        this.played.push({ kind: 'confirmation', text });
        controls.onStart();
        // Synchronous end — the queue advances immediately.
        controls.onEnd();
      },
      discard: () => {
        this.discarded.push(text);
      },
    };
    const deliver = () => controls.ready(prepared);
    if (this.manual) this.pendingPlays.push(deliver);
    else deliver();
  };

  directSpeak = (text: string, options?: SpeakOptions): void => {
    this.played.push({ kind: 'direct', text });
    options?.onStart?.();
    options?.onEnd?.();
  };

  releaseAll(): void {
    const pending = this.pendingPlays;
    this.pendingPlays = [];
    for (const deliver of pending) deliver();
  }
}

/**
 * Build a complete RecordingTestServices bundle with capture hooks.
 * The returned `refs` fill in as the provider constructs services.
 */
export function buildHarnessServices(): {
  services: RecordingTestServices;
  refs: {
    deepgram: FakeDeepgramService | null;
    sonnet: FakeSonnetSession | null;
  };
  tts: FakeTtsPlayers;
  chimes: { count: number };
  diagnostics: Array<{ category: string; payload: Record<string, unknown> }>;
  jobChanges: Array<{ source: string; changedKeys?: string[] }>;
} {
  const refs: { deepgram: FakeDeepgramService | null; sonnet: FakeSonnetSession | null } = {
    deepgram: null,
    sonnet: null,
  };
  const tts = new FakeTtsPlayers();
  const chimes = { count: 0 };
  const diagnostics: Array<{ category: string; payload: Record<string, unknown> }> = [];
  const jobChanges: Array<{ source: string; changedKeys?: string[] }> = [];
  const services: RecordingTestServices = {
    deepgramServiceFactory: (callbacks, model) => {
      refs.deepgram = new FakeDeepgramService(callbacks, model);
      return refs.deepgram;
    },
    sonnetSessionFactory: (callbacks) => {
      refs.sonnet = new FakeSonnetSession(callbacks as FakeSonnetCallbacks);
      return refs.sonnet;
    },
    micCaptureFactory: fakeMicCaptureFactory,
    resolveSttModel: () => Promise.resolve('flux'),
    diagnosticTap: (category, payload) => {
      diagnostics.push({ category, payload });
    },
    jobStateObserver: (change) => {
      jobChanges.push({ source: change.source, changedKeys: change.changedKeys });
    },
    chime: () => {
      chimes.count += 1;
    },
    haptic: () => {},
    ttsConfirmationPlayer: tts.confirmationPlayer,
    ttsDirectSpeak: tts.directSpeak,
  };
  return { services, refs, tts, chimes, diagnostics, jobChanges };
}
