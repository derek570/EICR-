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

import type { DeepgramCallbacks, DeepgramConnectionState, SttModel } from './deepgram-service';
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
    keyOrFetcher: string | (() => Promise<string>),
    sourceSampleRate: number
  ): void | Promise<void>;
  disconnect(): void;
  pause(): void;
  resume(replay?: Int16Array | null): void;
  sendSamples(samples: Float32Array): void;
  sendInt16PCM(pcm: Int16Array): void;
  readonly connectionState: DeepgramConnectionState;
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
  sendAskUserAnswered(toolCallId: string, text: string, utteranceId?: string): void;
  sendChitchatResume(): void;
  sendCompactRequest(): void;
  sendJobStateUpdate(job: unknown): void;
  peekInFlightToolCallId(): string | null;
  consumeInFlightToolCallId(): string | null;
  clearInFlightToolCallIdByPrefix(prefix: string): void;
  readonly connectionState: SonnetConnectionState;
  /** Diagnostic sink surface — recording-context wires the session into
   *  `setDiagnosticSink(session)`. */
  sendClientDiagnostic(category: string, payload?: Record<string, unknown>): void;
}

/** One applied job-state change from the recording pipeline (regex apply or
 *  Sonnet extraction apply). `source` distinguishes the write tier so the
 *  B2 trace can diff per-utterance applied fields with provenance. */
export interface JobStateChange {
  source: 'regex' | 'extraction' | 'board_ops';
  patch: Partial<JobDetail>;
  /** The job AFTER the patch folded in (the pipeline's own jobRef view). */
  job: JobDetail;
  changedKeys?: string[];
}

export interface RecordingTestServices {
  /** Replaces `new DeepgramService(callbacks, undefined, model)`. */
  deepgramServiceFactory?: (callbacks: DeepgramCallbacks, model: SttModel) => DeepgramServiceLike;
  /** Replaces `new SonnetSession(callbacks)`. Callbacks are the full
   *  SonnetSessionCallbacks object recording-context builds (typed loosely
   *  to keep this module import-light; cast in the harness). */
  sonnetSessionFactory?: (callbacks: unknown) => SonnetSessionLike;
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
