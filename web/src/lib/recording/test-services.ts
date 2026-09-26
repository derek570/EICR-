/**
 * B1 — injection seams for the PWA replay harness
 * (pwa-replay-harness plan, Wave 2).
 *
 * The `RecordingProvider` composition root constructs its services inline
 * (`new DeepgramService(...)`, `new SonnetSession(...)`, `startMicCapture`,
 * module-level TTS). The replay harness needs to substitute every external
 * effect while keeping the REAL pipeline logic (dispatchFinal, gates,
 * classifiers, FIFO) — that is the whole point: units in isolation were
 * green while the composition was broken (sess_mrbnds2d_jczh).
 *
 * Registration is module-level (`__setRecordingTestServices`) rather than a
 * provider prop so the harness doesn't have to thread a prop through the
 * app-shell layout. Production NEVER registers services: every seam
 * consults `getRecordingTestServices()` and falls back to the real
 * implementation when null (the default), so prod behaviour is
 * byte-identical. The module carries no heavy imports — types only — so it
 * adds nothing to the prod bundle beyond a null check.
 *
 * The Wave-2 gate requires every seam B2's trace capture needs to exist
 * HERE, before B2 starts: service factories, mic, scheduler, diagnostic
 * tap, job-state observer, chime + haptic effect hooks, TTS player hooks.
 */

import type {
  DeepgramCallbacks,
  DeepgramConnectionState,
  DeepgramSessionContext,
  DeepgramStreamingKeyConfig,
  SttModel,
} from './deepgram-service';
import type { CapturedPcmSegment } from './tagged-pcm-segment';
import type { ConnectionEpoch } from './uplink-scope-allocator';
import type { SonnetConnectionState } from './sonnet-session';
import type { MicCaptureHandle, MicCaptureOptions } from './mic-capture';
import type { ScheduleFn, ClearScheduleFn } from './dispatch-buffers';
import type { JobDetail } from '../types';
import type { SpeakOptions } from './tts';
import type { ConfirmationQueueItem } from './tts-queue';

/** The DeepgramService surface recording-context actually uses. The real
 *  class satisfies this structurally. */
export interface DeepgramServiceLike {
  connect(
    keyOrFetcher: string | (() => Promise<DeepgramStreamingKeyConfig>),
    sourceSampleRate: number
  ): void | Promise<void>;
  disconnect(): void;
  pause(): void;
  resume(): void;
  sendSamples(samples: Float32Array, capturedAt?: number): CapturedPcmSegment | null;
  sendTaggedAudio(segment: CapturedPcmSegment): void;
  sendInt16PCM(pcm: Int16Array): void;
  readonly connectionState: DeepgramConnectionState;
  /** PLAN-E1 — the codec latched from the session's first successful
   *  fetcher-mode key response. Exposed so a fake service used in a
   *  pause/resume test can prove the SAME session context (not a fresh
   *  one) is being consulted. */
  readonly latchedUplinkCodec?: 'linear16' | 'opus' | null;
  /** PLAN-E1 — the connection epoch minted for the current socket, or
   *  `null` if none is live. `recording-context.tsx`'s capture-tagging
   *  boundary reads this to resolve the same `EpochScope` the service
   *  would resolve internally (see `capture-tagging.ts`). */
  readonly liveEpoch?: ConnectionEpoch | null;
  /** PLAN-E2 — "the platform audio tap is still delivering samples into
   *  the sender". A CLASSIFICATION signal only (never a send gate), pushed
   *  by the tap owner at its two write sites (`micRef` set/cleared) and
   *  copied in at construction; read synchronously by the close classifier. */
  captureActive?: boolean;
  /** A02D — the session-monotonic dispatched-stream position, sampled by
   *  the provider at a manual tap as that epoch's stream cutoff. */
  readonly dispatchedStreamOffset?: number;
  /** A02D FinalWindowV1 — the session VAD's debounced onset/silence,
   *  forwarded by the provider at the tagging boundary. */
  noteLocalSpeechOnset?(atMs: number): void;
  noteLocalSilence?(): void;
}

/** The SonnetSession surface recording-context actually uses. The real
 *  class satisfies this structurally. `connect`/`sendJobStateUpdate` are
 *  typed loosely (unknown-options) to avoid importing the full option
 *  types here; the factory implementer receives the real values. */
export interface SonnetSessionLike {
  connect(options: unknown): void;
  disconnect(): void;
  pause(): void;
  resume(): void;
  sendTranscript(text: string, options?: unknown): void;
  sendAskUserAnswered(
    toolCallId: string,
    text: string,
    utteranceId?: string,
    purpose?: string | null
  ): void;
  sendAddressMirrorDeliveryAck(deliveryToken: string): void;
  sendCompactRequest(): void;
  sendJobStateUpdate(job: unknown): void;
  peekInFlightToolCallId(): string | null;
  consumeInFlightToolCallId(expectedId?: string | null): string | null;
  clearInFlightToolCallIdByPrefix(prefix: string): void;
  /** PLAN-CD (CD2) — the non-consuming unresolved-backend-ask authority. */
  hasUnresolvedBackendAsk(): boolean;
  readonly connectionState: SonnetConnectionState;
  /** Diagnostic sink surface — recording-context wires the session into
   *  `setDiagnosticSink(session)`. */
  sendClientDiagnostic(category: string, payload?: Record<string, unknown>): void;
}

/** One applied job-state change from the recording pipeline (regex apply or
 *  Sonnet extraction apply). `source` distinguishes the write tier so the
 *  B2 trace can diff per-utterance applied fields with provenance. */
export interface JobStateChange {
  source: 'regex' | 'extraction' | 'board_ops' | 'local_command';
  patch: Partial<JobDetail>;
  /** The job AFTER the patch folded in (the pipeline's own jobRef view). */
  job: JobDetail;
  changedKeys?: string[];
}

export interface RecordingTestServices {
  /** Replaces `new DeepgramService(callbacks, undefined, model, {
   *  sessionContext })`. PLAN-E1 widened this with a third, optional
   *  session-context parameter — the harness's fake MUST exercise it
   *  (read the latch, not ignore it) or a pause/resume env-flip test
   *  would go falsely green. */
  deepgramServiceFactory?: (
    callbacks: DeepgramCallbacks,
    model: SttModel,
    sessionContext?: DeepgramSessionContext
  ) => DeepgramServiceLike;
  /** Replaces `new SonnetSession(callbacks)`. Callbacks are the full
   *  SonnetSessionCallbacks object recording-context builds (typed loosely
   *  to keep this module import-light; cast in the harness). */
  sonnetSessionFactory?: (callbacks: unknown) => SonnetSessionLike;
  /** PLAN-W2 (W2-4) — receives the provider's `teardownSonnet`, so a harness
   *  can null the Sonnet session while Deepgram stays live and prove the
   *  no-session routing row end to end. No production path dispatches a final
   *  in that state (the session is torn down only alongside Deepgram, and the
   *  burst buffer is dropped at teardown), which is exactly why the guard needs
   *  a seam to be tested. Never called in production: the services are null. */
  exposeSonnetTeardown?: (teardown: () => void) => void;
  /** Replaces `startMicCapture(opts)`. */
  micCaptureFactory?: (opts: MicCaptureOptions) => Promise<MicCaptureHandle>;
  /** Replaces `ensureRuntimeConfigLoaded({force:true})` in start() — lets
   *  the harness pin the STT model without a `/runtime-config` fetch. */
  resolveSttModel?: () => Promise<SttModel>;
  /** Injected into the PendingReadingsBuffer (2s circuit-disambiguation
   *  timer) so the harness can drive it deterministically. Other inline
   *  timers (1.2s phantom watchdog, 500ms TTS resume, burst buffer) are
   *  driven via vitest fake timers — documented harness strategy. */
  scheduler?: ScheduleFn;
  clearScheduler?: ClearScheduleFn;
  /** Tap on EVERY clientDiagnostic envelope (fires in addition to the
   *  normal sink). Wired in client-diagnostic.ts, listed here for the
   *  Wave-2 gate. See `setDiagnosticTap`. */
  diagnosticTap?: (category: string, payload: Record<string, unknown>) => void;
  /** Observer of every pipeline-applied job-state change (regex +
   *  extraction apply sites) — the B2 "did the field land with the spoken
   *  value" seam. */
  jobStateObserver?: (change: JobStateChange) => void;
  /** Replaces `playSentForProcessingChime()` on the gate-pass path (the
   *  chime emits no diagnostic — this hook makes chime/no-chime a
   *  first-class trace event). */
  chime?: () => void;
  /** Replaces `haptic(kind)` on the gate-pass path. */
  haptic?: (kind: string) => void;
  /** Replaces the ElevenLabs-primary/native-fallback FIFO confirmation
   *  player built by `tts.ts speakConfirmation` — receives the queue item
   *  text and the standard QueuePlayControls. Wired in tts.ts; listed here
   *  for the Wave-2 gate. See `tts.ts __setTtsTestServices`. */
  ttsConfirmationPlayer?: ConfirmationQueueItem['play'];
  /** Replaces the DIRECT `speak()` audio path (ask_user / alerts / drained
   *  deferred prompts). Must honour options.onStart/onEnd/onError like the
   *  real path. Wired in tts.ts. */
  ttsDirectSpeak?: (text: string, options?: SpeakOptions) => void;
}

let current: RecordingTestServices | null = null;

/** Register (or clear with null) the harness services. Test-only — never
 *  called from production code paths. */
export function __setRecordingTestServices(services: RecordingTestServices | null): void {
  current = services;
}

export function getRecordingTestServices(): RecordingTestServices | null {
  return current;
}
