/**
 * Harness fakes for the B1 injection seams (pwa-replay-harness Waves 2-3).
 *
 * These stand in for the EXTERNAL effects only — Deepgram audio/WS, the
 * Sonnet backend WS, the microphone, and the audio players. Everything
 * between (dispatchFinal, gates, regex, classifiers, TTS FIFO, apply
 * pipeline) is the REAL production code, driven through the real
 * RecordingProvider. That composition is the harness's whole subject.
 */
import type {
  DeepgramCallbacks,
  DeepgramConnectionState,
  SttModel,
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

/**
 * Fake Deepgram service. The harness drives the recording pipeline by
 * calling the emit* helpers, which invoke the REAL recording-context
 * callbacks — exactly what the real service does when Flux frames arrive.
 */
export class FakeDeepgramService implements DeepgramServiceLike {
  readonly callbacks: DeepgramCallbacks;
  readonly model: SttModel;
  paused = false;
  disconnected = false;
  sentSampleBlocks = 0;

  constructor(callbacks: DeepgramCallbacks, model: SttModel) {
    this.callbacks = callbacks;
    this.model = model;
  }

  connect(): void {
    this.callbacks.onStateChange?.('connected');
  }
  disconnect(): void {
    this.disconnected = true;
    this.callbacks.onStateChange?.('disconnected');
  }
  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
  }
  sendSamples(): void {
    this.sentSampleBlocks += 1;
  }
  sendInt16PCM(): void {}
  get connectionState(): DeepgramConnectionState {
    return this.disconnected ? 'disconnected' : 'connected';
  }

  // ── Flux-equivalent event drivers (mirror handleFluxTurnInfo mapping) ──
  emitSpeechStarted(): void {
    this.callbacks.onSpeechStarted?.();
  }
  emitInterim(text: string, confidence = 0.5): void {
    this.callbacks.onInterimTranscript(text, confidence);
  }
  /** Transcript-bearing EndOfTurn: final THEN utterance-end (A1 mapping). */
  emitEndOfTurn(text: string, confidence = 0.9): void {
    this.callbacks.onFinalTranscript(text, confidence, []);
    this.callbacks.onUtteranceEnd?.();
  }
  /** Empty EndOfTurn (silence-driven close): utterance-end only. */
  emitEmptyEndOfTurn(): void {
    this.callbacks.onUtteranceEnd?.();
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
  sendChitchatResume(): void {}
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
