/**
 * Direct-to-Deepgram Nova-3 WebSocket client.
 *
 * Mirrors the iOS `DeepgramService.swift` protocol so the two clients
 * behave identically — same URL parameters (nova-3 / linear16 / 16kHz /
 * en-GB / interim_results / endpointing=400 / utterance_end_ms=1000 /
 * vad_events=true). Auth differs by transport: iOS sets an
 * `Authorization: Bearer <jwt>` header on the WS upgrade; browsers can't
 * set upgrade headers so we pass the same JWT as the `bearer` subprotocol
 * (`['bearer', apiKey]`). See `connect()` for the history of why this
 * changed from `token` → `bearer`.
 *
 * Pause/resume + auto-reconnect are deferred to Phase 4e where the
 * SleepDetector lands — until then this service offers the minimum
 * viable surface needed to deliver interim + final transcripts to the
 * RecordingContext: `connect`, `sendSamples`, `disconnect`.
 *
 * Apart from the different runtime, the URL and message shapes are
 * identical to transcript-standalone — keep in sync if Deepgram params
 * change there.
 */

import { type CcuAnalysisLite } from './keyword-boosts';
import { pipelineLog } from '@/lib/diagnostics/pipeline-log';
import {
  resolveUplinkURLConfig,
  type UplinkCodec,
  type UplinkKeepalivePolicy,
} from './uplink-url-config';
import {
  UplinkScopeAllocator,
  epochScopeEquals,
  type ConnectionEpoch,
  type EpochScope,
} from './uplink-scope-allocator';
import type {
  CaptureSampleRange,
  TaggedPcmSegment,
  CapturedPcmSegment,
} from './tagged-pcm-segment';
import {
  realOpusEncoderFactory,
  type OpusEncoderFactory,
  type OpusEncoderLike,
} from './opus-encoder';
import {
  defaultUndispatchedLossHandler,
  chargeGracefulResidueTelemetry,
  type UndispatchedLossHandler,
} from './uplink-loss-report';
import { classifyPcmEnergy, type VoicedActivityDetector } from './voiced-activity';
import { tagCapturedFloat32 } from './capture-tagging';
import type { UplinkLossLedger } from './uplink-loss-ledger';
import { audioWindowEndToSampleOffset } from './sample-offset';
import { SpeechOnsetTracker, resolveWindowEnd, type FinalTranscriptMeta } from './final-window';

/**
 * STT model selector. `nova3` is the legacy `/v1/listen` path (still the
 * product default + kill-switch fallback until Flux is field-validated).
 * `flux` is the `/v2/listen` `flux-general-en` path ported from iOS
 * `DeepgramService.swift` in parity WS4. The URL shape, turn-detection
 * events, and keyterm semantics differ substantially between the two — see
 * `buildNova3URL` / `buildFluxURL` and `handleMessage` / `handleFluxMessage`.
 */
export type SttModel = 'nova3' | 'flux';

/** Outcome of a Flux `Configure` control-message round-trip. */
export type ConfigureResult =
  | { ok: true; rttMs: number }
  | { ok: false; reason: string; rttMs: number };

export type DeepgramConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error';

export interface DeepgramWord {
  word: string;
  start: number;
  end: number;
  confidence: number;
  punctuated_word?: string;
}

export interface DeepgramCallbacks {
  onInterimTranscript: (text: string, confidence: number) => void;
  /** A02D — the optional fourth argument is the transport half of the
   *  FinalWindowV1 record (epoch, admissibility, `speech_start`,
   *  `window_end`). Always supplied by the real service; a caller that omits
   *  it is treated by the provider as an unbounded, admissible final. */
  onFinalTranscript: (
    text: string,
    confidence: number,
    words: DeepgramWord[],
    meta?: FinalTranscriptMeta
  ) => void;
  onUtteranceEnd?: () => void;
  onSpeechStarted?: () => void;
  onStateChange?: (state: DeepgramConnectionState) => void;
  onError?: (err: Error) => void;
  /**
   * Flux-only. Fires when a `Configure` control-message round-trip resolves
   * (ConfigureSuccess with a matching echo, ConfigureFailure, or timeout).
   * Lets the caller surface Configure success + RTT (parent WS4 acceptance)
   * and fail closed on a ConfigureFailure. No-op on the nova-3 path.
   */
  onConfigureResult?: (result: ConfigureResult) => void;
  /**
   * Fires after a successful auto-reconnect (not on the initial open).
   * Consumers typically drain their `AudioRingBuffer`'s tagged segments and
   * replay them via `sendTaggedAudio()` here so words spoken during the WS
   * downtime aren't lost — matching the iOS wake path that replays a
   * 3-second ring buffer on Deepgram reopen.
   */
  onReconnected?: () => void;
}

/**
 * Accepts either a raw key (one-shot, no auto-reconnect — the original
 * Phase 4a contract) or an async fetcher that mints a fresh key on every
 * (re)connect. Fetcher mode is what production uses post-2026-04-19:
 * Deepgram's /v1/auth/grant JWTs are minted with a 30s TTL (src/routes/
 * keys.js), which is fine for iOS because its DeepgramService auto-
 * reconnects with a fresh key on close. Web had no reconnect logic until
 * this change, so JWT expiry presented as a 1006 close after ~30s of
 * talking. Bumping the backend TTL would've fixed the symptom but the
 * backend is shared with iOS and shouldn't flex to work around a
 * web-client gap — the correct fix is reconnect parity here. Static-key
 * mode is preserved so existing unit tests keep working untouched.
 */
/**
 * PLAN-E1 E1 — the additive backend field on the key response. `key` is
 * always present; `uplink_codec` is optional so an old backend (no field)
 * degrades safely to `undefined` → treated as `linear16`.
 */
export interface DeepgramStreamingKeyConfig {
  key: string;
  uplink_codec?: 'linear16' | 'opus';
}

export type DeepgramKeySource = string | (() => Promise<DeepgramStreamingKeyConfig>);

/**
 * PLAN-E1 (split-round-4 IMPORTANT) — the session-owned codec latch. Lives
 * with the SESSION OWNER (`recording-context.tsx`'s
 * `sessionUplinkCodecRef`), not the socket owner, because
 * `openDeepgram` constructs a NEW `DeepgramService` on pause/resume — a
 * latch living ON the service would either die with it or re-latch a
 * mid-session env flip. `set()` is idempotent (a no-op once populated) so
 * callers don't need to double-guard the "latch once" invariant
 * themselves.
 */
export interface SessionCodecLatch {
  get(): UplinkCodec | null;
  set(codec: UplinkCodec): void;
}

export function createSessionCodecLatch(): SessionCodecLatch {
  let value: UplinkCodec | null = null;
  return {
    get: () => value,
    set: (codec) => {
      if (value === null) value = codec;
    },
  };
}

/**
 * PLAN-E1 — the recording-session-owned context threaded into EVERY
 * `DeepgramService` the session constructs (initial connect, pause/resume
 * reconnects). `recordingSessionId` is PLUMBED, not ambient (a keepalive
 * can fire before any captured segment exists, so the id cannot be
 * inferred from prior audio) — it is an explicit IMMUTABLE member set
 * once at `start()` and never regenerated for the lifetime of one
 * recording session.
 */
/**
 * The session-owned monotonic capture-domain sample clock. Every accepted
 * live/replay frame reserves its own `[start, end)` range off this clock
 * BEFORE any connection-state check, so materiality accounting (the
 * shared VAD) sees a gapless timeline regardless of reconnects.
 */
export interface CaptureClock {
  advance(sampleCount: number): CaptureSampleRange;
}

export function createCaptureClock(): CaptureClock {
  let position = 0;
  return {
    advance(sampleCount: number): CaptureSampleRange {
      const start = position;
      position += sampleCount;
      return { start, end: position };
    },
  };
}

export interface DeepgramSessionContext {
  readonly recordingSessionId: string;
  readonly codecLatch: SessionCodecLatch;
  readonly allocator: UplinkScopeAllocator;
  readonly captureClock: CaptureClock;
  /** Optional — the session owner's shared `VoicedActivityDetector`. Fed
   *  every accepted LIVE frame (`sendSamples`/`tagCapturedFloat32`) —
   *  replay (`sendTaggedAudio`/`sendInt16PCM`) does not re-feed it, since
   *  a replayed segment was already fed once at its original capture
   *  moment. `null`/absent for the ~20 pre-existing direct unit tests
   *  that construct a default context and don't care about materiality. */
  readonly vad?: VoicedActivityDetector;
  /** PLAN-E2 — the session-owned unresolved-voiced-audio ledger. Fed by
   *  this service's single sender (dispatched ranges + dropped frames),
   *  the close/error classifier, and the Flux `audio_window_end`
   *  watermark. Absent for the pre-existing direct unit tests (no
   *  accounting → no disclosure). */
  readonly lossLedger?: UplinkLossLedger;
}

export interface DeepgramServiceOptions {
  /** A02D test seam — monotonic ms clock for the onset-confirmation
   *  deadline. Defaults to `performance.now`. */
  now?: () => number;
  sessionContext?: DeepgramSessionContext;
  /** Test seam — production defaults to `realOpusEncoderFactory`
   *  (WebCodecs). Tests inject a fake since `AudioEncoder`/`AudioData`
   *  are not implemented under Vitest/jsdom. */
  opusEncoderFactory?: OpusEncoderFactory;
  /** PLAN-E1's `onUndispatchedLoss` seam. Defaults to a no-op + telemetry
   *  counter; PLAN-E2 replaces this with the real ledger binding. */
  onUndispatchedLoss?: UndispatchedLossHandler;
}

let anonymousSessionCounter = 0;
function makeAnonymousSessionId(): string {
  anonymousSessionCounter += 1;
  return `anon-session-${anonymousSessionCounter}`;
}

/**
 * Constructor-level seam for injecting an alternate WebSocket factory.
 *
 * Defaults to the global `WebSocket` constructor in production. Tests
 * use this to inject a fake WS whose `bufferedAmount` is mutable so the
 * KeepAlive-gating regression can be asserted — `mock-socket`'s
 * `bufferedAmount` is hardcoded to 0 (see WAVE_3C_HANDOFF.md "Known
 * limitation"), which makes the gate unobservable through the default
 * test harness.
 *
 * The shape intentionally mirrors `new WebSocket(url, protocols)` so
 * drop-in substitution costs one line.
 */
export type WebSocketFactory = (url: string, protocols?: string[]) => WebSocket;

export class DeepgramService {
  private ws: WebSocket | null = null;
  private state: DeepgramConnectionState = 'disconnected';
  private callbacks: DeepgramCallbacks;
  private wsFactory: WebSocketFactory;
  private sourceSampleRate = 16000;
  // Tracked so the KeepAlive loop only fires during extended silence.
  private lastAudioSendMs = 0;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  // Phase 4e — when paused, `sendSamples` silently drops incoming audio
  // but the WS stays open via the KeepAlive loop. Lets the SleepManager
  // re-wake in <100ms without a full reconnect.
  private paused = false;
  // WebSocket fires BOTH `onerror` and `onclose` for most failure modes
  // (spec says either can fire standalone but Chrome/Safari currently
  // fire both). Without a guard the upstream recording-context would
  // see two `onError` callbacks for a single close and trigger two
  // reconnects — doubling Deepgram connect-storm billing on flaky links.
  // This flag is reset every `connect()` AND on each scheduled reconnect
  // attempt (so a subsequent terminal failure after N retries can still
  // fire onError once).
  private errorEmitted = false;

  // ── Auto-reconnect state ─────────────────────────────────────────────
  // Only populated in fetcher mode. Mirrors the iOS pattern
  // (CertMateUnified/.../DeepgramService.swift — `shouldReconnect`,
  // `isReconnectScheduled`, `reconnectAttempt`, `reconnectWorkItem`).
  //
  // `fetchKey` is stored because reconnection must mint a FRESH key, not
  // reuse the cached JWT — the JWT is what expired in the first place.
  private fetchKey: (() => Promise<DeepgramStreamingKeyConfig>) | null = null;
  // PLAN-E1 — the session-owned identity bundle (recordingSessionId,
  // codec latch, scope allocator). Threaded in via the constructor's
  // `options.sessionContext`; a private default is constructed when
  // omitted (every pre-existing 3-arg call site — ~20 unit tests) so
  // those tests keep passing unchanged and each gets its own
  // self-contained, functionally-correct (if not session-shared) context.
  private readonly sessionContext: DeepgramSessionContext;
  private readonly opusEncoderFactory: OpusEncoderFactory;
  private readonly onUndispatchedLoss: UndispatchedLossHandler;
  // The connection epoch minted for THIS socket, and the resolved sender
  // codec decided when its URL was built (nova-3 always forces linear16
  // regardless of the latch — see `resolveUplinkURLConfig`).
  private currentEpoch: ConnectionEpoch | null = null;
  // PLAN-E2 — close OWNERSHIP marker. Set ONLY inside `disconnect()` (the
  // web client's single `ws.close()` site, so every caller — all ten
  // `teardownDeepgram()` sites plus `disconnectDeepgramForPause()` — is
  // owned by construction) to the epoch being deliberately closed. The
  // `ws.onclose` classifier compares the dying epoch against it: equal →
  // owned (no episode, entries discarded); otherwise → an outage.
  // Generation-scoped so a late close callback from a superseded socket
  // can never be mistaken for an unsolicited close on the current one.
  private ownedCloseEpoch: ConnectionEpoch | null = null;
  // PLAN-E2 — the ABSOLUTE `dispatchedSampleOffset` at the instant this
  // socket's epoch was minted. Deepgram's `audio_window_end` restarts from
  // 0 per connection, so the watermark's absolute position is
  // origin + converted-seconds; the ledger compares ONLY same-epoch
  // dispatched ranges against it.
  private epochDispatchOrigin = 0;
  /** PLAN-E2 — set when an Opus packet's `ws.send` threw; consumed by the
   *  next input drain (which then charges instead of recording dispatch). */
  private opusPacketSendFailedSinceDrain = false;
  /** PLAN-E2 — "is the platform audio tap still delivering samples into
   *  this sender?" A CLASSIFICATION signal read synchronously at close
   *  time by the ledger; NEVER a send gate (the tap owner pushes `false`
   *  only AFTER its residual flush). Session-scoped and latest-wins:
   *  copied in at construction from the provider-owned ref and pushed at
   *  every tap transition, so a reconnect (no tap transition) on this
   *  reused instance still reads the live value. */
  captureActive = false;
  /** A02D FinalWindowV1 — per-onset confirmation state for THIS instance
   *  (session VAD transitions are forwarded by the provider; StartOfTurn /
   *  non-empty interims confirm). */
  private readonly onsetTracker = new SpeechOnsetTracker();
  private readonly nowMs: () => number;
  /** A02D admission — flipped synchronously at the top of `disconnect()`,
   *  BEFORE the CloseStream grace during which `this.ws` still equals the
   *  socket. A final emitted by this instance after that is inadmissible. */
  private admissionClosed = false;
  private resolvedSenderCodec: UplinkCodec = 'linear16';
  private keepalivePolicy: UplinkKeepalivePolicy = 'disabled';
  // The generation-bound Opus encoder for the CURRENT socket (null when
  // the resolved codec is linear16 — no encoder needed). Recreated per
  // connection, closed on reconnect/teardown; never reused across
  // generations (round-8: async encoder output is socket/generation-bound).
  private opusEncoder: OpusEncoderLike | null = null;
  private opusEncoderGeneration = 0;
  // FIFO of captured segments handed to the encoder whose INPUT hasn't
  // finished draining yet (popped on `onInputDrained`, NOT on `onPacket`
  // — see `handleOpusInputDrained`'s doc comment: an encoder's `encode()`
  // call can legitimately emit more than one output packet, so pop-per-
  // packet would desync). Anything still queued at teardown is CONFIRMED
  // local loss, reported via `onUndispatchedLoss` before the reset.
  private pendingOpusInput: TaggedPcmSegment[] = [];
  // Monotonic 16kHz-sample dispatched-audio-time offset — advances ONLY
  // after a successful socket handoff (raw send for linear16; the
  // corresponding encoder-output send for opus), continuously across
  // synthetic and captured segments, never in the byte domain.
  private dispatchedSampleOffset = 0;
  // Scope-tagged tail of the Flux batching accumulator — batching SPLITS
  // at metadata boundaries (a batch never spans two scopes/sessions).
  private fluxBatchScope: EpochScope | null = null;
  // Capture-domain sample offset of the FIRST byte currently sitting in
  // `fluxSampleBuffer`, so a completed/flushed frame's own tagged range
  // can be reconstructed even though it may have been assembled from
  // more than one original `sendSamples`/`sendInt16PCM` call.
  private fluxAccumulatorRangeStart: number | null = null;
  // PLAN-E1B2 item 3 — a single `fluxAccumulatorCapturedAt` value can't
  // track `fluxAccumulatorRangeStart`'s own per-emission advance (round-6
  // finding): once a full-frame emission consumes samples that span more
  // than one incoming segment, the emitted frame's `capturedAt` must come
  // from whichever segment's samples sit at the buffer's CURRENT front —
  // not a single value only reset when the buffer empties. FIFO of
  // {sampleCount, capturedAt}, one entry per incoming segment, consumed in
  // the same order the buffer's own bytes are.
  private fluxAccumulatorCapturedAtQueue: Array<{ sampleCount: number; capturedAt: number }> = [];
  // Set true on fetcher-mode connect, flipped false by `disconnect()` so
  // any in-flight async key-fetch aborts cleanly and no further retries
  // are scheduled.
  private shouldReconnect = false;
  // Dedup: a single close can race ws.onerror + ws.onclose, or a stray
  // delayed callback from a prior socket; without this flag one close
  // would queue multiple reconnect timers and stampede Deepgram.
  private isReconnectScheduled = false;
  // Incremented on each scheduled attempt, reset to 0 on successful
  // `ws.onopen`. Drives exponential backoff. NOT reset inside
  // scheduleReconnect() because that would restart backoff on every
  // retry and produce rapid-fire 1s spam against an unreachable server.
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Caps exponential backoff at 30s — matches iOS `maxReconnectDelay`.
  // Any higher and the user waits too long for service restoration on
  // flaky mobile links; lower and we DOS Deepgram on prolonged outages.
  private static readonly MAX_RECONNECT_DELAY_MS = 30_000;
  // Tracks whether we've ever successfully opened the socket for this
  // session. First-connect failures fire onError so the UI can surface
  // "can't reach Deepgram"; reconnect failures stay silent (the
  // `reconnecting` state change is the UI signal) so transient blips
  // don't flash scary errors mid-session.
  private hasEverOpened = false;

  // Most recent CCU photo analysis. When non-null, `buildURL` augments
  // the keyterm list with board-specific vocabulary (manufacturer,
  // OCPD types, circuit labels) for stronger Deepgram boosts on the
  // job under test. Set via `setCcuAnalysis()` from the recording
  // context after CCU analysis lands; persisted across reconnects so
  // mid-session reopens keep the augmented keyterm set.
  private ccuAnalysis: CcuAnalysisLite | null = null;

  // STT model for this service instance. Locked at construction (the runtime
  // kill-switch resolves the model once per RECORDING session in
  // recording-context and passes it here; auto-reconnects reuse the same
  // instance/model, never refetch). Defaults to 'nova3' so every pre-Flux
  // call site + unit test keeps its exact behaviour.
  private readonly sttModel: SttModel;

  // ── Flux Configure round-trip state ─────────────────────────────────────
  // A single in-flight Configure at a time (matches iOS — the focused-answer
  // path sends one Configure and awaits its echo before the next). The pending
  // resolver is settled by ConfigureSuccess/ConfigureFailure or a timeout.
  private pendingConfigure: {
    sentAtMs: number;
    expectedKeytermCount: number;
    eotThreshold: number;
    eotTimeoutMs: number;
    resolve: (r: ConfigureResult) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  // ── Flux 80ms audio batching ────────────────────────────────────────────
  // Flux ingests audio best in ~80ms frames (1280 samples @16k = 2560 bytes),
  // matching the iOS chunk batcher. The mic pipeline hands us variable-size
  // blocks, so we accumulate Int16 samples and flush in 1280-sample frames.
  // nova-3 sends blocks as-is (no batching) — behaviour unchanged.
  private static readonly FLUX_FRAME_SAMPLES = 1280; // 80ms @ 16kHz
  private fluxSampleBuffer: Int16Array = new Int16Array(0);

  constructor(
    callbacks: DeepgramCallbacks,
    wsFactory?: WebSocketFactory,
    sttModel: SttModel = 'nova3',
    options: DeepgramServiceOptions = {}
  ) {
    // A02D — the FROZEN nova-3 `handleMessage` path invokes the callbacks
    // with no FinalWindowV1 meta and no provider speech evidence; the
    // wrapper derives both OUTSIDE the frozen surface (see
    // `wrapCallbacksForFinalWindow`). Flux (`handleFluxMessage`, unfrozen)
    // supplies its own meta and evidence and passes straight through.
    this.callbacks = this.wrapCallbacksForFinalWindow(callbacks);
    // Default to the real global WebSocket. Tests pass a factory whose
    // sockets expose a mutable `bufferedAmount` so the KeepAlive gate
    // can be exercised deterministically. Kept as an optional second
    // arg so every existing call site keeps working unchanged.
    this.wsFactory = wsFactory ?? ((url, protocols) => new WebSocket(url, protocols));
    this.sttModel = sttModel;
    // PLAN-E1 — production + the recording-context factory + the fake
    // service ALWAYS pass a real session-owned context (constructor
    // contract, split-round-4). Every pre-existing 3-arg call site (the
    // direct unit-test suite) gets a private, self-contained default so
    // it keeps its exact prior behaviour — this service alone latches
    // linear16 implicitly and never shares scope with a sibling instance,
    // which is fine because none of those tests construct a second
    // instance expecting shared session state.
    this.sessionContext = options.sessionContext ?? {
      recordingSessionId: makeAnonymousSessionId(),
      codecLatch: createSessionCodecLatch(),
      allocator: new UplinkScopeAllocator(),
      captureClock: createCaptureClock(),
    };
    this.opusEncoderFactory = options.opusEncoderFactory ?? realOpusEncoderFactory;
    this.nowMs = options.now ?? (() => performance.now());
    // PLAN-E2 binds PLAN-E1's `onUndispatchedLoss` seam to the session
    // ledger (entry variant d) whenever the session owner supplied one; an
    // explicit handler option still wins (tests of the seam itself).
    const ledger = this.sessionContext.lossLedger;
    this.onUndispatchedLoss =
      options.onUndispatchedLoss ??
      (ledger ? (report) => ledger.recordUndispatchedLoss(report) : defaultUndispatchedLossHandler);
  }

  /** The STT model this instance was constructed with (diagnostics/tests). */
  get model(): SttModel {
    return this.sttModel;
  }

  get connectionState(): DeepgramConnectionState {
    return this.state;
  }

  /**
   * PLAN-E1 E1 — the codec latched from the first successful fetcher-mode
   * key response this session (`null` before any fetch, or in static-key
   * mode). Exposed for tests and for future consumers (the sender, once
   * built) to read; not yet consulted anywhere in this service.
   */
  get latchedUplinkCodec(): 'linear16' | 'opus' | null {
    return this.sessionContext.codecLatch.get();
  }

  /** The recording-session id this instance was constructed with — read
   *  by tests to assert a pause/resume-constructed sibling shares the
   *  SAME session identity as its predecessor. */
  get recordingSessionId(): string {
    return this.sessionContext.recordingSessionId;
  }

  /** The scope allocator this instance shares with its session owner. */
  get scopeAllocator(): UplinkScopeAllocator {
    return this.sessionContext.allocator;
  }

  /** The codec this connection actually sends — resolved at URL-build
   *  time (nova-3 always forces linear16). `null` before the first
   *  `connect()`. */
  get resolvedCodec(): UplinkCodec {
    return this.resolvedSenderCodec;
  }

  /** The connection epoch minted for the CURRENT socket, or `null` if
   *  none is live (before the first `connect()`, or during a reconnect
   *  gap). Exposed so a caller that tags audio independently of this
   *  instance's lifecycle (the session-owned ring buffer in
   *  `recording-context.tsx` — see `capture-tagging.ts`) can resolve the
   *  same `EpochScope` this service would resolve internally. */
  get liveEpoch(): ConnectionEpoch | null {
    return this.currentEpoch;
  }

  /** A02D — the session-monotonic dispatched-stream position (source
   *  samples handed to ANY socket so far). Sampled by the provider at a
   *  manual tap as that epoch's dispatched-stream cutoff, on the same
   *  thread the sender advances it on. */
  get dispatchedStreamOffset(): number {
    return this.dispatchedSampleOffset;
  }

  /** A02D FinalWindowV1 — the session VAD's debounced ONSET, forwarded by
   *  the provider at the tagging boundary, before the onset frame is sent:
   *  `dispatchedSampleOffset` here IS the onset frame's dispatched start. */
  noteLocalSpeechOnset(atMs: number = this.nowMs()): void {
    this.onsetTracker.onOnset(this.dispatchedSampleOffset, atMs);
  }

  /** A02D FinalWindowV1 — the session VAD's debounced SILENCE transition:
   *  an onset still unconfirmed is discarded. */
  noteLocalSilence(): void {
    this.onsetTracker.onSilence();
  }

  /** A02D FinalWindowV1 — provider speech evidence (StartOfTurn or a
   *  NON-EMPTY interim) confirms a pending onset when it arrives within the
   *  confirmation window. The transport calls this itself on those frames;
   *  it is public so a text-only fake can model the VAD-then-Deepgram
   *  ordering without synthesising audio. */
  noteProviderSpeechEvidence(atMs: number = this.nowMs()): void {
    this.onsetTracker.onProviderSpeechEvidence(atMs);
  }

  /** A02D — the transport half of the admission predicate for a final
   *  emitted under `socketEpoch`: this instance has not been disconnected
   *  and the emitting socket is its current one. */
  private admissibleFor(socketEpoch: ConnectionEpoch | null | undefined): boolean {
    return (
      !this.admissionClosed &&
      socketEpoch != null &&
      this.currentEpoch !== null &&
      socketEpoch === this.currentEpoch
    );
  }

  private finalMeta(
    socketContext: { epoch: ConnectionEpoch | null; origin: number } | undefined,
    rawWindowEnd: unknown,
    speechStartOverride?: number | null,
    providerFinalId: string | null = null
  ): FinalTranscriptMeta {
    const epoch = socketContext?.epoch ?? null;
    const origin = socketContext?.origin ?? this.epochDispatchOrigin;
    return {
      epoch,
      admissible: this.admissibleFor(epoch),
      speechStart:
        speechStartOverride !== undefined
          ? speechStartOverride
          : this.onsetTracker.currentSpeechStart(this.nowMs()),
      windowEnd: resolveWindowEnd(rawWindowEnd, origin),
      providerFinalId,
    };
  }

  /** A02D — the provider's own identity for a final on `epoch` (see
   *  `FinalTranscriptMeta.providerFinalId`). `parts` are the frame fields
   *  that name the turn; a frame with none of them (unknown shape) gets
   *  the transcript itself, so an exact re-delivery still coincides. */
  private providerFinalId(
    epoch: ConnectionEpoch | null,
    kind: 'flux' | 'nova',
    parts: unknown[],
    transcript: string
  ): string {
    const named = parts.filter((p) => typeof p === 'number' || (typeof p === 'string' && p));
    const tail = named.length > 0 ? named.join('|') : `text:${transcript}`;
    return `${epoch ?? 'e?'}|${kind}|${tail}`;
  }

  /**
   * A02D — the socket whose message is being delivered RIGHT NOW, with the
   * epoch and dispatch origin `openSocket` bound to it. Set around every
   * `onmessage` delivery by `bindDispatchContext`, so the callback wrapper
   * can attribute a nova-3 final to the EMITTING socket (a superseded
   * socket's late final is inadmissible, exactly as on Flux) without any
   * change to the frozen `onmessage` / `handleMessage` surface.
   */
  private dispatchingSocketContext: { epoch: ConnectionEpoch | null; origin: number } | null = null;

  /**
   * Wrap a freshly constructed socket so that whatever handler the frozen
   * `openSocket` code assigns to `onmessage` runs with
   * `dispatchingSocketContext` set to THIS socket's epoch/origin. The
   * assignment site (`ws.onmessage = (event) => { … }`) is byte-for-byte
   * unchanged; only the instance's `onmessage` property is intercepted
   * (an own accessor shadowing the prototype's — legal on `WebSocket` and
   * on the harness's captive socket alike).
   */
  private bindDispatchContext(ws: WebSocket): WebSocket {
    type Handler = ((this: WebSocket, ev: MessageEvent) => unknown) | null;
    const service = this;
    const epoch = this.currentEpoch;
    const origin = this.epochDispatchOrigin;
    // The prototype accessor (a real `WebSocket`); a plain-field fake has
    // none and is served entirely by the own accessor below.
    let protoSetter: ((this: WebSocket, fn: Handler) => void) | undefined;
    for (let proto = Object.getPrototypeOf(ws); proto && proto !== Object.prototype; ) {
      const desc = Object.getOwnPropertyDescriptor(proto, 'onmessage');
      if (desc?.set) {
        protoSetter = desc.set as typeof protoSetter;
        break;
      }
      proto = Object.getPrototypeOf(proto);
    }
    let delegate: Handler = null;
    Object.defineProperty(ws, 'onmessage', {
      configurable: true,
      enumerable: true,
      get: () => delegate,
      set: (fn: Handler) => {
        delegate = fn
          ? function (this: WebSocket, ev: MessageEvent) {
              const previous = service.dispatchingSocketContext;
              service.dispatchingSocketContext = { epoch, origin };
              try {
                return fn.call(this, ev);
              } finally {
                service.dispatchingSocketContext = previous;
              }
            }
          : null;
        protoSetter?.call(ws, delegate);
      },
    });
    return ws;
  }

  /**
   * A02D FinalWindowV1 for the frozen nova-3 path. `handleMessage` (byte-
   * for-byte the pre-A02D method) delivers `onFinalTranscript(text,
   * confidence, words)` with no meta and never notes provider speech
   * evidence; this wrapper adds both from the words and the emitting
   * socket's context: `speech_start` from the first provider word start,
   * `window_end` from the last word end (no words → unbounded), and the
   * provider-final identity from the word bounds. Flux calls arrive WITH
   * meta and pass through untouched (its evidence is noted inside the
   * unfrozen `handleFluxMessage`).
   */
  private wrapCallbacksForFinalWindow(callbacks: DeepgramCallbacks): DeepgramCallbacks {
    return {
      ...callbacks,
      onFinalTranscript: (text, confidence, words, meta) => {
        if (meta !== undefined) {
          callbacks.onFinalTranscript(text, confidence, words, meta);
          return;
        }
        const socketContext = this.dispatchingSocketContext ?? undefined;
        const origin = socketContext?.origin ?? this.epochDispatchOrigin;
        const first = words[0];
        const last = words[words.length - 1];
        callbacks.onFinalTranscript(
          text,
          confidence,
          words,
          this.finalMeta(
            socketContext,
            last ? last.end : undefined,
            first ? origin + audioWindowEndToSampleOffset(first.start) : null,
            this.providerFinalId(
              socketContext?.epoch ?? null,
              'nova',
              [first?.start, last?.end],
              text
            )
          )
        );
      },
      onInterimTranscript: (text, confidence) => {
        // nova-3 interims are non-empty by construction (the frozen path
        // returns on an empty transcript); Flux notes its own evidence.
        if (this.sttModel !== 'flux') this.noteProviderSpeechEvidence();
        callbacks.onInterimTranscript(text, confidence);
      },
      onSpeechStarted: () => {
        if (this.sttModel !== 'flux') this.noteProviderSpeechEvidence();
        callbacks.onSpeechStarted?.();
      },
    };
  }

  /**
   * Open a Deepgram WebSocket.
   *
   * Two modes:
   *  - **Static key** (`string`): one-shot connect. No auto-reconnect; a
   *    reconnectable close fires `onError` and stops. Used by unit tests
   *    and any caller that wants to manage the lifecycle itself.
   *  - **Fetcher** (`() => Promise<string>`): auto-reconnect enabled. On
   *    any reconnectable close (code ≠ 1000/1005) the service mints a
   *    fresh key via the callback and reopens with exponential backoff
   *    (1→2→4→8→16→30s cap). Matches iOS parity — see
   *    `CertMateUnified/.../DeepgramService.swift scheduleReconnect()`.
   *    Callers observe the round trip via `onStateChange('reconnecting')`
   *    and `onReconnected` (fires after a successful reopen so the
   *    caller's AudioRingBuffer can be replayed).
   *
   * Mode choice is locked at call time and reset on the next `connect()`.
   */
  connect(keyOrFetcher: DeepgramKeySource, sourceSampleRate = 16000): void {
    if (this.ws && this.state !== 'disconnected') {
      // Already connecting/connected — caller mis-wired. No-op.
      return;
    }
    this.sourceSampleRate = sourceSampleRate;
    this.errorEmitted = false;
    this.reconnectAttempt = 0;
    this.isReconnectScheduled = false;
    this.hasEverOpened = false;

    if (typeof keyOrFetcher === 'function') {
      this.fetchKey = keyOrFetcher;
      this.shouldReconnect = true;
      void this.openWithFreshKey();
    } else {
      this.fetchKey = null;
      this.shouldReconnect = false;
      // Static-key mode carries no codec information (legacy Phase 4a
      // contract, unit tests) — latches implicit linear16.
      this.openSocket(keyOrFetcher);
    }
  }

  /**
   * Fetcher-mode entry point. Mints a fresh key and opens the socket.
   * Called on initial connect AND on every scheduled reconnect attempt.
   * Kept separate from `openSocket()` so static-key mode (+ every
   * existing unit test) doesn't pay for the async path.
   */
  private async openWithFreshKey(): Promise<void> {
    if (!this.fetchKey) return;
    this.setState(this.reconnectAttempt === 0 ? 'connecting' : 'reconnecting');
    let key: string;
    try {
      const config = await this.fetchKey();
      key = config.key;
      // Latch ONCE from the first successful fetch this session; later
      // fetches (reconnect) refresh only the JWT, never re-latch. `set()`
      // is itself idempotent (see `createSessionCodecLatch`), so this
      // reads as a plain assignment even though it may be a no-op.
      this.sessionContext.codecLatch.set(config.uplink_codec ?? 'linear16');
    } catch (err) {
      // Key-fetch failed (backend 5xx, network, etc.). First-connect
      // failures surface to the UI; reconnect failures stay quiet and
      // the state machine keeps retrying — `reconnecting` is already
      // the visible signal. Matches iOS `RECONNECT_KEY_FETCH_FAILED`
      // behaviour which also silently reschedules.
      //
      // Gate on `reconnectAttempt === 0` not `hasEverOpened`: an
      // always-down backend would leave hasEverOpened=false forever
      // and spam onError on every retry. reconnectAttempt is 0 only
      // on the very first call (it's incremented inside
      // scheduleReconnect before the timer fires), so this emits
      // exactly once per connect() session.
      if (this.reconnectAttempt === 0) {
        this.setState('error');
        this.emitError(err instanceof Error ? err : new Error(String(err)));
      }
      this.scheduleReconnect();
      return;
    }
    // `disconnect()` while the fetch was in flight — bail before we
    // open a socket that would leak a connection + billable seconds.
    if (!this.shouldReconnect) return;
    this.openSocket(key);
  }

  /**
   * Open the raw Deepgram WS for a specific key. Does not auto-reconnect
   * on its own — the onclose handler delegates to `scheduleReconnect()`
   * iff fetcher mode was selected at `connect()` time.
   */
  private openSocket(apiKey: string): void {
    // Only flip to 'connecting' for the initial handshake; a reconnect
    // already showed 'reconnecting' via openWithFreshKey.
    if (this.state !== 'reconnecting') this.setState('connecting');

    // PLAN-E1 — mint the connection epoch at the TOP of the single
    // socket-construction site, parented by whichever CaptureAttemptId is
    // currently live (reserving a fresh one if none is — a reconnect
    // whose predecessor's epoch was already minted reserves its own).
    // This runs on EVERY attempt (not gated on success), so even a
    // superseded/failed connect still parents a valid epoch for the live
    // one that follows it — ids never repeat within the session either
    // way.
    const allocator = this.sessionContext.allocator;
    const captureAttemptId =
      allocator.currentCaptureAttemptId() ?? allocator.reserveCaptureAttemptIfNeeded();
    this.currentEpoch = allocator.mintEpoch(captureAttemptId);
    // PLAN-E2 — snapshot the watermark origin for this epoch. No send can
    // land on this socket before `onopen`, and `onopen` is frozen, so the
    // offset here IS the offset at open.
    this.epochDispatchOrigin = this.dispatchedSampleOffset;
    this.resetOpusEncoderForNewGeneration();

    let config = resolveUplinkURLConfig({
      model: this.sttModel,
      latchedCodec: this.sessionContext.codecLatch.get(),
      ccuAnalysis: this.ccuAnalysis,
    });
    if (config.resolvedSenderCodec === 'opus') {
      const encoderBuilt = this.constructOpusEncoderForCurrentGeneration();
      // Codex review r1 BLOCKER: constructing the encoder can fail
      // (WebCodecs unavailable) — the URL was already built declaring
      // `encoding=opus` at that point. Re-resolve the URL against a
      // forced-linear16 config so the socket never opens declaring a
      // codec the sender isn't actually producing — sending raw
      // linear16 bytes to an Opus-declared connection would break
      // transcription outright.
      if (!encoderBuilt) {
        config = resolveUplinkURLConfig({
          model: this.sttModel,
          latchedCodec: 'linear16',
          ccuAnalysis: this.ccuAnalysis,
        });
      }
    }
    const url = config.url;
    this.resolvedSenderCodec = config.resolvedSenderCodec;
    this.keepalivePolicy = config.keepalivePolicy;
    // Deepgram accepts subprotocol-based auth; URL query params are blocked
    // on iOS Safari during the HTTP→WS upgrade (rules/mistakes.md), and
    // browsers can't set an Authorization header on the WS upgrade at all
    // (iOS's native URLSession can, which is why DeepgramService.swift uses
    // an `Authorization: Bearer …` header instead).
    //
    // Scheme must match the credential the backend returns:
    //   - Raw Deepgram master API key  → ['token', key]
    //   - JWT from /v1/auth/grant      → ['bearer', jwt]   ← what we get now
    //
    // The backend (src/routes/keys.js, createDeepgramTempKey) mints JWTs via
    // /v1/auth/grant as of 248953b (2026-04-18, P0-10 security fix — the old
    // master-key fallback was dropped). Before that a 2026-03-31 hotfix
    // (550278e) bypassed auth/grant and returned the master key directly,
    // which is why this was ['token', …] historically. Using 'token' with a
    // JWT makes Deepgram 401 the upgrade; the browser surfaces that as a
    // generic WebSocket error with no body. Confirmed via DeepgramService.swift
    // line 228-230 ("JWT+Token=401, JWT+Bearer=connected").
    //
    // Single comma-separated string (e.g. "bearer, jwt") is rejected by
    // newer Deepgram validation — must be a two-element array.
    //
    // `wsFactory` defaults to the global `WebSocket` constructor; see
    // `WebSocketFactory` doc comment for the test seam.
    const ws = this.bindDispatchContext(this.wsFactory(url, ['bearer', apiKey]));
    ws.binaryType = 'arraybuffer';
    // PLAN-E2 (Codex cycle-1 BLOCKER fix) — the epoch THIS socket was
    // minted under, bound into its error/close callbacks. A late callback
    // from a superseded socket must classify ITS OWN epoch (the ledger
    // ignores a stale one) and must never clear or tear down a successor.
    const socketEpoch = this.currentEpoch;
    // Codex E2 cycle-4 — snapshot this epoch's dispatch origin too, bound to
    // the socket, so a late final message still retires against the right base.
    const socketDispatchOrigin = this.epochDispatchOrigin;

    ws.onopen = () => {
      const wasReconnect = this.hasEverOpened;
      pipelineLog('deepgram_ws_open', {
        wasReconnect,
        reconnectAttempt: this.reconnectAttempt,
      });
      this.setState('connected');
      this.reconnectAttempt = 0; // success resets backoff
      this.hasEverOpened = true;
      this.startKeepAlive();
      if (wasReconnect) {
        // Fire AFTER setState so the caller observes 'connected' first
        // and any replay it sends through sendInt16PCM lands on an
        // already-open socket.
        this.callbacks.onReconnected?.();
      }
    };

    ws.onmessage = (event) => {
      // Codex E2 cycle-4 — bind the message to the emitting socket's epoch
      // AND its dispatch origin, so a valid final message from a just-closed
      // socket still retires ITS OWN epoch's evidence (never dropped, never
      // rebound to a successor).
      this.handleMessage(event.data, { epoch: socketEpoch, origin: socketDispatchOrigin });
    };

    ws.onerror = () => {
      pipelineLog('deepgram_ws_error', {
        willDeferToClose: this.shouldReconnect,
        stale: this.ws !== ws,
      });
      // PLAN-E2 — one of the episode's entry paths (transport failure).
      // Idempotent with the `onclose` classification below; the ledger
      // ignores a signal for a superseded epoch. Changes NO reconnect
      // decision — the existing early-return/emitError logic follows.
      if (socketEpoch !== null) {
        this.sessionContext.lossLedger?.onSocketFailure(socketEpoch, {
          owned: socketEpoch === this.ownedCloseEpoch,
          captureActive: this.captureActive,
        });
      }
      // A superseded socket's late error never touches the live one.
      if (this.ws !== null && this.ws !== ws) return;
      // In fetcher mode, defer to onclose — it will schedule a
      // reconnect. Surfacing an error event here would double-fire
      // through the `errorEmitted` guard and, worse, flash an error
      // UI during every transient network blip.
      if (this.shouldReconnect) return;
      this.setState('error');
      this.emitError(new Error('Deepgram WebSocket error'));
    };

    ws.onclose = (event) => {
      // PLAN-E2 (Codex cycle-1 BLOCKER fix) — a LATE close from a
      // superseded socket (a new one already opened on this instance):
      // classify its own epoch for the ledger (stale → ignored there) and
      // return WITHOUT touching the live socket's state, epoch, encoder,
      // or reconnect decision.
      if (this.ws !== null && this.ws !== ws) {
        pipelineLog('deepgram_ws_close_stale', { code: event.code, socketEpoch });
        if (socketEpoch !== null) {
          this.sessionContext.lossLedger?.onSocketClosed(socketEpoch, {
            owned: socketEpoch === this.ownedCloseEpoch,
            captureActive: this.captureActive,
          });
        }
        return;
      }
      this.stopKeepAlive();
      this.ws = null;
      // Codex review r1 BLOCKER: `currentEpoch` was never cleared on
      // close, so any audio arriving during a reconnect gap (this
      // service's OWN internal auto-reconnect keeps calling
      // `sendSamples` on the SAME instance between the old socket dying
      // and the new one opening) was tagged with the now-DEAD epoch
      // instead of `preOpen` — a stale-epoch mislabel, not merely a
      // restamp. Clearing it here makes `currentUplinkScope()` correctly
      // fall back to reserving a fresh preOpen capture attempt for
      // anything captured before `_connect()`'s next mint.
      const dyingEpoch = socketEpoch;
      if (this.currentEpoch === socketEpoch) this.currentEpoch = null;
      const reconnectable = event.code !== 1000 && event.code !== 1005;
      const ownedClose = dyingEpoch !== null && dyingEpoch === this.ownedCloseEpoch;
      // PLAN-E2 — close classification by LOCAL OWNERSHIP, never by code:
      // an unsolicited 1000/1005 from a middlebox or a vendor rotation is
      // an outage (episode opens, counted) even though today's gate below
      // — unchanged, Carve A — does not reconnect on it. Runs BEFORE the
      // loss charges so a residue report attributes to the episode this
      // close just opened. Reads `captureActive` synchronously.
      if (dyingEpoch !== null) {
        this.sessionContext.lossLedger?.onSocketClosed(dyingEpoch, {
          owned: dyingEpoch === this.ownedCloseEpoch,
          captureActive: this.captureActive,
        });
      }
      // An UNEXPECTED teardown (reconnectable close) charges any samples
      // still sitting inside the encoder pipeline AND any partial Flux
      // sub-frame tail as confirmed local loss BEFORE the reset — a
      // graceful stop/pause instead runs the bounded flush in
      // `disconnect()` and never reaches this branch's loss-charging path.
      // A clean 1000/1005 close (server CloseStream response) has already
      // been drained by `disconnect()`'s flush, so nothing should be
      // pending here either way. Uses the epoch snapshotted BEFORE the
      // clear above — these methods no longer read `this.currentEpoch`
      // themselves (it would always see the just-cleared `null`).
      // PLAN-E2 (Codex cycle-1 BLOCKER fix) — OWNERSHIP, not the close
      // code, decides: an unsolicited 1000/1005 is an outage whose partial
      // Flux batch / encoder residue is real evidence for the episode the
      // classifier just opened. An owned close's residue was flushed by
      // `disconnect()` and is discarded by the ledger regardless.
      if (dyingEpoch !== null && !ownedClose) {
        this.chargeUndispatchedEncoderLoss(dyingEpoch);
        this.chargeFluxTailLoss(dyingEpoch);
      }
      this.teardownOpusEncoder();
      pipelineLog('deepgram_ws_close', {
        code: event.code,
        reason: event.reason ?? '',
        wasClean: event.wasClean,
        reconnectable,
        shouldReconnect: this.shouldReconnect,
        reconnectAttempt: this.reconnectAttempt,
      });
      // Log close code + reason on every close so backend/ops can
      // correlate flaky-link incidents with browser-side reconnect
      // behaviour. 1000 (normal) + 1005 (no status) are expected
      // teardowns (disconnect() / server CloseStream response); anything
      // else is a reconnect candidate. `autoReconnect` disambiguates
      // fetcher mode from static-key mode in the logs.
      console.info(
        `[deepgram] close code=${event.code} reason=${JSON.stringify(event.reason ?? '')} reconnectable=${reconnectable} autoReconnect=${this.shouldReconnect}`
      );
      if (reconnectable && this.shouldReconnect) {
        this.scheduleReconnect();
        return;
      }
      if (this.state !== 'error') {
        this.setState('disconnected');
      }
      if (reconnectable) {
        // Static-key mode: surface the close so the caller can decide
        // whether to reconnect (legacy Phase 4a contract + tests).
        this.emitError(new Error(`Deepgram WS closed (code=${event.code})`));
      }
    };

    this.ws = ws;
  }

  private emitError(err: Error): void {
    if (this.errorEmitted) return;
    this.errorEmitted = true;
    this.callbacks.onError?.(err);
  }

  /**
   * Queue a fresh reconnect attempt. Dedup'd against concurrent callers
   * (ws.onerror + ws.onclose for the same failure, or a stray delayed
   * callback from a prior socket). Exponential backoff capped at 30s —
   * matches iOS `scheduleReconnect()`.
   */
  private scheduleReconnect(): void {
    if (!this.shouldReconnect || this.isReconnectScheduled) return;
    this.isReconnectScheduled = true;
    this.reconnectAttempt += 1;
    const delayMs = Math.min(
      Math.pow(2, this.reconnectAttempt - 1) * 1000,
      DeepgramService.MAX_RECONNECT_DELAY_MS
    );
    this.setState('reconnecting');
    console.info(
      `[deepgram] reconnect scheduled attempt=${this.reconnectAttempt} delay=${delayMs}ms`
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.isReconnectScheduled = false;
      if (!this.shouldReconnect) return;
      // NOTE: errorEmitted is intentionally NOT reset here. After the
      // initial onError fires (gated on reconnectAttempt === 0 in
      // openWithFreshKey), subsequent retries stay silent — both the
      // errorEmitted latch AND the reconnectAttempt gate independently
      // suppress further emissions. Resetting errorEmitted would have
      // re-enabled spammy per-retry errors.
      void this.openWithFreshKey();
    }, delayMs);
  }

  /** Send a Float32Array block (mic samples). Resamples to 16kHz if needed
   *  and converts to Int16 PCM before framing. No-op if not connected or
   *  if the service has been paused by the SleepManager.
   *
   *  PLAN-E1: every accepted frame is tagged (recordingSessionId,
   *  captureSampleRange, epochScope) via the shared `tagCapturedFloat32`
   *  helper BEFORE the connection-state check — so the shared
   *  `VoicedActivityDetector` (if the session owner supplied one) sees a
   *  CONTINUOUS feed across reconnects, exactly like a genuinely
   *  connected session would, even on frames this socket ends up
   *  dropping. Returns the tagged segment (even when dropped) so a
   *  caller that ALSO wants to retain this exact tag — the ring buffer
   *  in `recording-context.tsx` — can do so without re-tagging (Codex
   *  review r1 BLOCKER: a replay path that mints its OWN fresh tag at
   *  drain time double-advances the capture clock and mislabels
   *  gap-period audio under the wrong epoch — see `sendTaggedAudio`).
   *
   *  `capturedAt` (PLAN-E1B2 item 3) defaults to `performance.now()` at
   *  THIS function's own entry when omitted — covering `sendSamples`'s
   *  ~20 pre-existing direct unit-test callers and any other genuinely
   *  independent caller. The one production call site
   *  (`recording-context.tsx`'s fallback branch) passes the SAME
   *  `capturedAt` its `onSamples` callback already captured immediately
   *  after its TTS-discard guard, since on that path `sendSamples` is
   *  entered only after the guard AND the resample have both already run
   *  — computing a fresh timestamp here would record a strictly LATER
   *  time than the primary tagging branch's callback-entry stamp.
   *
   *  Returns `null` (nothing tagged) when the input resamples to zero
   *  16 kHz samples — the same contract `recording-context.tsx`'s primary
   *  path applies before tagging. */
  sendSamples(
    samples: Float32Array,
    capturedAt: number = performance.now()
  ): CapturedPcmSegment | null {
    if (this.paused) return null;
    if (samples.length === 0) return null;

    const resampled = this.sourceSampleRate === 16000 ? samples : this.resampleTo16k(samples);
    // A sub-ratio input (e.g. 2 samples at 48 kHz) resamples to ZERO
    // samples — nothing to tag, and a zero-count entry must never enter the
    // Flux capturedAt FIFO (it would hand its timestamp to the next real
    // frame). Codex r2 NIT.
    if (resampled.length === 0) return null;
    const segment = tagCapturedFloat32(
      resampled,
      this.sessionContext,
      this.currentEpoch,
      capturedAt
    );

    if (!this.ws || this.state !== 'connected') {
      this.chargeDroppedCapture(segment);
      return segment;
    }

    this.lastAudioSendMs = performance.now();

    if (this.sttModel === 'flux') {
      this.enqueueFluxFrames(segment);
    } else {
      this.dispatchFrame(segment);
    }
    return segment;
  }

  /** Dispatch an ALREADY-TAGGED captured segment straight through the
   *  single sender, WITHOUT recomputing its capture range or epoch scope
   *  — the "no restamping" invariant. Used for ring-buffer replay, where
   *  the caller tagged the segment at its ORIGINAL capture moment (see
   *  `capture-tagging.ts`), including moments when no `DeepgramService`
   *  instance existed yet (e.g. full sleep). Does NOT feed VAD — the
   *  segment was already fed once, at original capture time, by whoever
   *  tagged it. */
  sendTaggedAudio(segment: CapturedPcmSegment): void {
    if (segment.samples.length === 0) return;
    if (!this.ws || this.state !== 'connected') {
      // PLAN-E2 entry variant (a) — accepted from the tap, no socket to
      // take it (the initial connecting window, a reconnect gap). Full
      // sleep never reaches here: no service instance exists then, so
      // the ring's staged audio is excluded by construction. Behaviour is
      // otherwise EXACTLY today's drop.
      this.chargeDroppedCapture(segment);
      return;
    }
    this.lastAudioSendMs = performance.now();
    if (this.sttModel === 'flux') {
      this.enqueueFluxFrames(segment);
      return;
    }
    this.dispatchFrame(segment);
  }

  /**
   * Flux 80ms chunk batcher. Accumulates tagged Int16 samples and flushes
   * exactly 1280-sample (2560-byte) frames — the ~80ms cadence Flux
   * ingests best, and the iOS chunk-batcher size. A partial tail (< one
   * frame) is held until the next block completes it. Cleared on
   * disconnect so a stale tail can't leak into the next session. nova-3
   * never calls this (sends blocks as-is).
   *
   * PLAN-E1: batching SPLITS at metadata boundaries — a batch never
   * spans two scopes. If the accumulator holds bytes from a DIFFERENT
   * `epochScope` than the arriving segment, the (possibly short)
   * accumulator is flushed as its own frame FIRST, never fused with the
   * new scope's bytes.
   */
  private enqueueFluxFrames(segment: CapturedPcmSegment): void {
    const FRAME = DeepgramService.FLUX_FRAME_SAMPLES;
    // Defence in depth for the capturedAt FIFO: a zero-sample segment
    // contributes no bytes, so it must contribute no queue entry either.
    if (segment.samples.length === 0) return;
    if (
      this.fluxSampleBuffer.length > 0 &&
      this.fluxBatchScope !== null &&
      !epochScopeEquals(this.fluxBatchScope, segment.epochScope)
    ) {
      this.flushFluxAccumulator();
    }
    if (this.fluxSampleBuffer.length === 0) {
      this.fluxAccumulatorRangeStart = segment.captureSampleRange.start;
    }
    this.fluxBatchScope = segment.epochScope;
    // PLAN-E1B2 item 3 — push EVERY incoming segment's own {sampleCount,
    // capturedAt}, not only when the buffer starts empty. Order matches
    // the buffer's own byte order (entries are appended and consumed in
    // the same sequence), so the head always corresponds to whichever
    // segment's samples sit at the front of `buf` below.
    this.fluxAccumulatorCapturedAtQueue.push({
      sampleCount: segment.samples.length,
      capturedAt: segment.capturedAt,
    });

    // Append to the carry-over buffer.
    let buf: Int16Array;
    if (this.fluxSampleBuffer.length === 0) {
      buf = segment.samples;
    } else {
      buf = new Int16Array(this.fluxSampleBuffer.length + segment.samples.length);
      buf.set(this.fluxSampleBuffer, 0);
      buf.set(segment.samples, this.fluxSampleBuffer.length);
    }
    let offset = 0;
    while (buf.length - offset >= FRAME) {
      const frame = buf.subarray(offset, offset + FRAME);
      const out = new Int16Array(FRAME);
      out.set(frame);
      const rangeStart = this.fluxAccumulatorRangeStart! + offset;
      const frameCapturedAt = this.consumeCapturedAtQueue(FRAME);
      this.dispatchFrame({
        origin: 'captured',
        samples: out,
        recordingSessionId: segment.recordingSessionId,
        captureSampleRange: { start: rangeStart, end: rangeStart + FRAME },
        epochScope: this.fluxBatchScope,
        capturedAt: frameCapturedAt,
      });
      offset += FRAME;
    }
    // Retain the sub-frame remainder for the next block.
    if (offset < buf.length) {
      this.fluxSampleBuffer = buf.slice(offset);
      this.fluxAccumulatorRangeStart = this.fluxAccumulatorRangeStart! + offset;
    } else {
      this.fluxSampleBuffer = new Int16Array(0);
      this.fluxAccumulatorRangeStart = null;
    }
  }

  /** Consume `count` samples' worth of entries from the head of
   *  `fluxAccumulatorCapturedAtQueue`, returning the FIRST (oldest)
   *  entry's `capturedAt` — a full frame's `capturedAt` is defined as its
   *  earliest-captured constituent segment's timestamp (PLAN-E1B2 item 3).
   *  Production segments are AudioWorklet blocks far smaller than the
   *  1,280-sample frame (`mic-capture.ts`: "typically 128 samples"), so
   *  consuming one frame commonly dequeues SEVERAL entries in sequence —
   *  a single head check-or-reduce would desync the queue from the
   *  buffer's actual sample offsets the first time a frame spans more
   *  than one entry, which given the size mismatch is the common case,
   *  not an edge case. */
  private consumeCapturedAtQueue(count: number): number {
    const queue = this.fluxAccumulatorCapturedAtQueue;
    const firstCapturedAt = queue.length > 0 ? queue[0].capturedAt : performance.now();
    let remaining = count;
    while (remaining > 0 && queue.length > 0) {
      const head = queue[0];
      if (remaining >= head.sampleCount) {
        remaining -= head.sampleCount;
        queue.shift();
      } else {
        head.sampleCount -= remaining;
        remaining = 0;
      }
    }
    return firstCapturedAt;
  }

  /** Flush the Flux batching accumulator as its own (possibly short)
   *  tagged frame — used at a scope boundary so a batch never spans two
   *  scopes. */
  private flushFluxAccumulator(): void {
    if (
      this.fluxSampleBuffer.length === 0 ||
      this.fluxBatchScope === null ||
      this.fluxAccumulatorRangeStart === null
    ) {
      this.fluxSampleBuffer = new Int16Array(0);
      this.fluxAccumulatorRangeStart = null;
      this.fluxAccumulatorCapturedAtQueue = [];
      return;
    }
    const range: CaptureSampleRange = {
      start: this.fluxAccumulatorRangeStart,
      end: this.fluxAccumulatorRangeStart + this.fluxSampleBuffer.length,
    };
    // The flush consumes EVERYTHING the buffer holds — read the head the
    // same way, then clear the whole queue (a fully-drained queue and a
    // fully-drained buffer become empty at the same instant by
    // construction).
    const capturedAt = this.consumeCapturedAtQueue(this.fluxSampleBuffer.length);
    this.dispatchFrame({
      origin: 'captured',
      samples: this.fluxSampleBuffer,
      recordingSessionId: this.sessionContext.recordingSessionId,
      captureSampleRange: range,
      epochScope: this.fluxBatchScope,
      capturedAt,
    });
    this.fluxSampleBuffer = new Int16Array(0);
    this.fluxAccumulatorRangeStart = null;
    this.fluxAccumulatorCapturedAtQueue = [];
  }

  /** Send a RAW, UNTAGGED Int16 PCM block — tags it fresh (a new capture
   *  range off the shared clock, the CURRENT scope) as if it were just
   *  captured, then routes it through the same codec-aware sender as
   *  live audio (round-1 BLOCKER: no bypass of the sender for any binary
   *  path). Correct only for audio whose true capture moment IS now —
   *  NOT for replaying older buffered audio, which must preserve its
   *  ORIGINAL tag instead (see `sendTaggedAudio`; the ring-buffer replay
   *  path was moved off this method in the Codex review r1 BLOCKER fix
   *  — minting a fresh tag for genuinely-older audio double-advanced the
   *  capture clock and mislabeled gap-period audio under the wrong
   *  epoch). Retained for callers that only have raw, previously-untagged
   *  PCM to inject. */
  sendInt16PCM(samples: Int16Array): void {
    if (!this.ws || this.state !== 'connected' || samples.length === 0) return;
    this.lastAudioSendMs = performance.now();
    const copy = new Int16Array(samples.length);
    copy.set(samples);
    const captureSampleRange = this.sessionContext.captureClock.advance(copy.length);
    const epochScope = this.sessionContext.allocator.currentScope(this.currentEpoch);
    const segment: CapturedPcmSegment = {
      origin: 'captured',
      samples: copy,
      recordingSessionId: this.sessionContext.recordingSessionId,
      captureSampleRange,
      epochScope,
      // Genuinely fresh, never-before-tagged audio (per this method's own
      // doc comment) — no merge ambiguity, stamp from the same clock at
      // the point of injection.
      capturedAt: performance.now(),
    };
    if (this.sttModel === 'flux') {
      this.enqueueFluxFrames(segment);
      return;
    }
    this.dispatchFrame(segment);
  }

  /** Freeze live sample forwarding without closing the socket. The
   *  KeepAlive loop continues so the Deepgram session stays alive;
   *  calling `resume()` un-freezes with negligible latency. Pair with
   *  `AudioRingBuffer.writeFloat32()` during pause so `sendInt16PCM()`
   *  on resume can catch Deepgram up to the wake moment. */
  pause(): void {
    this.paused = true;
  }

  /** Inverse of `pause()`. A02D retired replay: this used to drain a
   *  caller-supplied ring-buffer replay through `sendTaggedAudio` (the doze
   *  wake path). No path re-sends ring audio to any socket now — audio no
   *  socket could take is charged and DISCLOSED through PLAN-E2's staged-loss
   *  seam by the provider instead. */
  resume(): void {
    this.paused = false;
  }

  /** Request a graceful stream close + tear the socket down. Cancels any
   *  pending auto-reconnect so a mid-backoff `stop()` doesn't leak a
   *  billable WS seconds later. */
  disconnect(): void {
    // A02D — invalidate admission SYNCHRONOUSLY, before anything else in
    // this method (the CloseStream grace below keeps `this.ws` alive for
    // 300 ms; a late final from it must never be admitted).
    this.admissionClosed = true;
    this.stopKeepAlive();
    this.paused = false;
    // PLAN-E1 (Codex review r1 IMPORTANT fix) — flush any partial Flux
    // batching tail (< one 80ms frame) through the SAME sender rather
    // than silently discarding it. The socket is still open/connected at
    // this point (CloseStream + the actual `ws.close()` happen later, in
    // `finishClose`), so this genuinely reaches Deepgram — a real
    // fraction of a word can sit in this accumulator, and dropping it
    // silently on every stop/pause would lose it with no telemetry at
    // all (unlike the Opus-encoder residue path below, which counts and
    // telemeters what it can't flush in time). For the opus codec this
    // enqueues into `pendingOpusInput` via `dispatchFrame`, so it's
    // covered by the bounded encoder flush further down, same as any
    // other in-flight segment.
    this.flushFluxAccumulator();
    // Reset remaining Flux batching + Configure state so nothing leaks
    // into the next session (an orphaned Configure resolver).
    this.fluxBatchScope = null;
    if (this.pendingConfigure) {
      clearTimeout(this.pendingConfigure.timer);
      this.pendingConfigure.resolve({ ok: false, reason: 'disconnected', rttMs: 0 });
      this.pendingConfigure = null;
    }
    // PLAN-E2 — mark the close OWNED (this is the client's only
    // `ws.close()` site) and tell the ledger directly too: with no live
    // socket there is no close event for the classifier to see, and an
    // owned close discards every unresolved entry either way.
    this.ownedCloseEpoch = this.currentEpoch;
    this.sessionContext.lossLedger?.onOwnedDisconnect(this.currentEpoch);
    // Kill auto-reconnect BEFORE anything else — prevents onclose below
    // from scheduling a fresh attempt on the way out, and short-circuits
    // any in-flight `openWithFreshKey` key-fetch.
    this.shouldReconnect = false;
    this.fetchKey = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.isReconnectScheduled = false;
    const ws = this.ws;
    if (!ws) {
      this.teardownOpusEncoder();
      this.setState('disconnected');
      return;
    }

    const finishClose = () => {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'CloseStream' }));
        }
      } catch {
        // ignore
      }
      // Give Deepgram ~300ms to flush any outstanding finals before we
      // yank the socket — matches iOS behaviour.
      setTimeout(() => {
        try {
          ws.close(1000);
        } catch {
          // ignore
        }
        this.ws = null;
        this.setState('disconnected');
      }, 300);
    };

    if (this.opusEncoder) {
      // PLAN-E1 graceful-stop scope: a BOUNDED flush drains any buffered
      // encoder/container tail before CloseStream. Residue that cannot
      // flush within the bound is COUNTED and telemetered — NOT charged
      // via `onUndispatchedLoss` (that seam is for UNEXPECTED teardown
      // only), and creates NO episode/token/clip/ledger entry this wave
      // (that disclosure work is out of scope — see PLAN-E2).
      const encoder = this.opusEncoder;
      const FLUSH_BOUND_MS = 500;
      Promise.race([
        encoder.flush(),
        new Promise<void>((resolve) => setTimeout(resolve, FLUSH_BOUND_MS)),
      ])
        .catch(() => {
          // Flush rejected — treat identically to a bound timeout below.
        })
        .finally(() => {
          chargeGracefulResidueTelemetry(this.pendingOpusInput.length);
          this.pendingOpusInput = [];
          this.teardownOpusEncoder();
          finishClose();
        });
      return;
    }
    finishClose();
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private setState(next: DeepgramConnectionState) {
    if (this.state === next) return;
    this.state = next;
    this.callbacks.onStateChange?.(next);
  }

  // PLAN-E1 — URL construction now lives in the pure `resolveUplinkURLConfig`
  // test seam (`uplink-url-config.ts`) so production and the {flux,nova3} ×
  // {linear16,opus} test matrix exercise the SAME code path. `openSocket()`
  // calls it directly; there is no `buildURL()` wrapper left to call.

  // ── PLAN-E1 sender internals ────────────────────────────────────────────

  /**
   * The ONE codec-aware sender. Every binary WebSocket send this service
   * makes — live capture, replay, AND keepalive silence — funnels through
   * here. Buffers upstream store RAW PCM; encoding happens HERE, at send
   * time.
   */
  private dispatchFrame(segment: TaggedPcmSegment): void {
    if (!this.ws || this.state !== 'connected') return;

    if (this.resolvedSenderCodec === 'linear16') {
      try {
        // Codex diff-review r2 IMPORTANT fix — send the EXACT byte range,
        // not the raw parent `.buffer`: if `segment.samples` is ever a
        // view over a larger buffer (e.g. `splitCapturedSegment`'s
        // halves), sending `.buffer` directly would transmit the WHOLE
        // parent buffer regardless of which slice this segment
        // represents. Every current caller happens to hand this a
        // full-buffer array, but the sender shouldn't depend on that.
        const { buffer, byteOffset, byteLength } = segment.samples;
        this.ws.send(buffer.slice(byteOffset, byteOffset + byteLength) as ArrayBuffer);
        const dispatchedStart = this.dispatchedSampleOffset;
        this.dispatchedSampleOffset += segment.samples.length;
        this.recordDispatchedCapture(segment, dispatchedStart);
      } catch {
        // WS backpressure — drop this frame (pre-existing accepted
        // behaviour, unchanged by E1). PLAN-E2 counts it as a known send
        // failure (entry variant a) — the frame never reached the socket.
        if (segment.origin === 'captured') this.chargeDroppedCapture(segment);
      }
      return;
    }

    // Opus path — async encoder output. Queue this segment so the
    // per-INPUT drain handler (`handleOpusInputDrained`, fired once per
    // `encode()` call regardless of output count) can pop it in FIFO
    // order.
    this.pendingOpusInput.push(segment);
    this.opusEncoder?.encode(segment.samples);
  }

  /** Encoder-output callback, bound to the generation that constructed
   *  it — output arriving after a NEWER generation has started (a
   *  reconnect/codec-change raced an in-flight encode) is discarded, not
   *  sent on a socket it no longer belongs to. Does NOT touch
   *  `pendingOpusInput` (Codex diff-review r1 BLOCKER fix): a single
   *  `encode()` call can legitimately emit MULTIPLE packets here (iOS's
   *  on-device E0 probe found 4 packets from one 80ms/1280-frame input;
   *  nothing suggests WebCodecs' Opus encoder differs) — popping the
   *  queue per PACKET desyncs after the very first multi-packet input,
   *  consuming segments pushed by LATER `encode()` calls before they've
   *  even drained. Sending is the only job left here; the pop moved to
   *  `handleOpusInputDrained`. */
  private handleOpusPacket(bytes: Uint8Array, generation: number): void {
    if (generation !== this.opusEncoderGeneration) return;
    if (!this.ws || this.state !== 'connected') return;
    try {
      // Same exact-byte-range send as the linear16 path — the production
      // WebCodecs encoder currently always allocates a full-buffer
      // `Uint8Array` per packet, but this must not rely on that.
      this.ws.send(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      );
    } catch {
      // WS backpressure — drop this packet (same accepted-loss bar as
      // the linear16 path); this is NOT an `onUndispatchedLoss` event —
      // that seam is for an unexpected TEARDOWN with residue still
      // queued, not an ordinary per-send failure. PLAN-E2 (Codex cycle-1
      // BLOCKER fix): it IS unresolved audio — the input that drains next
      // is charged as undispatched rather than recorded as dispatched, so
      // a later watermark can never retire audio whose packet never left.
      this.opusPacketSendFailedSinceDrain = true;
    }
  }

  /** The 1-input-in / 1-drain-out signal (`OpusEncoderFactory`'s
   *  `onInputDrained` — WebCodecs' `dequeue` event in production),
   *  decoupled from `onPacket`'s count. Pops exactly the oldest pending
   *  segment (FIFO — the encoder processes inputs strictly in submission
   *  order, never reordering) and advances `dispatchedSampleOffset` by
   *  its ORIGINAL sample count, regardless of how many output packets
   *  that input produced. */
  private handleOpusInputDrained(generation: number): void {
    if (generation !== this.opusEncoderGeneration) return;
    const segment = this.pendingOpusInput.shift();
    if (!segment) return;
    if (this.opusPacketSendFailedSinceDrain) {
      // ≥1 packet of this input never left the client: conservative
      // charge of the whole source segment (the packet→sample mapping is
      // not determinable for a short tail — PLAN-E1B2's probe finding).
      // Codex E2 cycle-2 fix: do NOT advance `dispatchedSampleOffset` — a
      // failed input's bytes never reached Deepgram, so its samples never
      // exist in the vendor's dispatched stream. Advancing would push every
      // later successful range ahead of the real watermark, so it could
      // never watermark-retire (a false unretired tail).
      this.opusPacketSendFailedSinceDrain = false;
      if (segment.origin === 'captured') this.chargeDroppedCapture(segment);
      return;
    }
    const dispatchedStart = this.dispatchedSampleOffset;
    this.dispatchedSampleOffset += segment.samples.length;
    // PLAN-E2 test 2k — the SAME source-sample dispatched range regardless
    // of codec/packetisation, so retirement is codec-independent.
    this.recordDispatchedCapture(segment, dispatchedStart);
  }

  /** PLAN-E2 entry variant (b) — a captured frame handed to the socket on
   *  the CURRENT epoch, recorded (if voiced) with its half-open SOURCE-
   *  SAMPLE dispatched range so the same epoch's watermark can retire it.
   *  Flux only: nova-3 has no pinned retirement signal, and an
   *  unretirable dispatched entry would fire a false disclosure on every
   *  nova-3 reconnect after any speech. Synthetic keepalive is never
   *  recorded (it advances the offset but is not inspector audio). */
  private recordDispatchedCapture(segment: TaggedPcmSegment, dispatchedStart: number): void {
    const ledger = this.sessionContext.lossLedger;
    if (!ledger || segment.origin !== 'captured') return;
    if (this.sttModel !== 'flux' || this.currentEpoch === null) return;
    ledger.recordDispatched({
      dispatchEpoch: this.currentEpoch,
      epochScope: segment.epochScope,
      captureSampleRange: segment.captureSampleRange,
      dispatchedSampleRange: {
        start: dispatchedStart,
        end: dispatchedStart + segment.samples.length,
      },
      voiced: classifyPcmEnergy(segment.samples),
    });
  }

  /** PLAN-E2 entry variant (a) — accepted from the tap, never handed to a
   *  socket. The ledger classifies the snapshot and retains NO PCM. */
  private chargeDroppedCapture(segment: CapturedPcmSegment): void {
    this.sessionContext.lossLedger?.recordDropped({
      epochScope: segment.epochScope,
      captureSampleRange: segment.captureSampleRange,
      samples: segment.samples,
    });
  }

  /** Bumps the encoder generation and tears down any prior encoder
   *  (defensive — the prior socket's `onclose` should already have run
   *  this, but a fresh generation id is guaranteed regardless). Called at
   *  the top of `openSocket()`, before the new encoder (if any) is
   *  constructed. */
  private resetOpusEncoderForNewGeneration(): void {
    this.teardownOpusEncoder();
    this.opusEncoderGeneration += 1;
    this.pendingOpusInput = [];
  }

  /** Returns true iff the encoder was actually constructed. Does NOT
   *  touch `resolvedSenderCodec` itself — the caller (`openSocket`) owns
   *  reconciling the codec decision with the URL it builds, since a
   *  construction failure must also change what the socket DECLARES,
   *  not just what the sender does internally (Codex review r1 BLOCKER —
   *  see `openSocket`'s comment). */
  private constructOpusEncoderForCurrentGeneration(): boolean {
    const generation = this.opusEncoderGeneration;
    try {
      this.opusEncoder = this.opusEncoderFactory(
        (bytes) => this.handleOpusPacket(bytes, generation),
        () => this.handleOpusInputDrained(generation)
      );
      return this.opusEncoder !== null;
    } catch {
      // WebCodecs unavailable at runtime despite the resolved codec
      // being opus (E0 gates this at the probe stage, so this should not
      // happen in practice) — fail SAFE to linear16 for this connection
      // rather than silently dropping all audio.
      this.opusEncoder = null;
      return false;
    }
  }

  private teardownOpusEncoder(): void {
    // Codex E2 cycle-2 fix — the send-failure latch is per encoder
    // generation: a packet that threw without draining before a
    // reconnect must not charge the SUCCESSOR generation's first drained
    // input as loss. Cleared here (called on every teardown/reset).
    this.opusPacketSendFailedSinceDrain = false;
    this.opusEncoder?.close();
    this.opusEncoder = null;
  }

  /** Charges any samples still queued inside the encoder pipeline as
   *  CONFIRMED local loss via `onUndispatchedLoss`, BEFORE the reset —
   *  called on an UNEXPECTED teardown only (a reconnectable close). Takes
   *  the dying socket's epoch as a PARAMETER rather than reading
   *  `this.currentEpoch` — the caller (`ws.onclose`) clears
   *  `this.currentEpoch` before calling this (round-1 BLOCKER fix: a
   *  stale currentEpoch must not leak into the NEXT capture attempt's
   *  scope resolution), so reading the instance field here would always
   *  see `null` and silently drop every loss report. Synthetic
   *  (keepalive) segments are NEVER loss-reported — a keepalive send
   *  failure neither mutates any captured segment's tags nor invokes
   *  this seam. */
  private chargeUndispatchedEncoderLoss(epoch: ConnectionEpoch): void {
    if (this.pendingOpusInput.length === 0) return;
    for (const segment of this.pendingOpusInput) {
      if (segment.origin !== 'captured') continue;
      this.onUndispatchedLoss({
        samples: segment.samples.slice(),
        recordingSessionId: segment.recordingSessionId,
        epoch,
        captureSampleRange: segment.captureSampleRange,
      });
    }
  }

  /** Charges a partial Flux sub-frame tail (< 80ms, not yet a complete
   *  frame the batcher would have dispatched) as CONFIRMED local loss —
   *  called on an UNEXPECTED teardown only (a reconnectable close), the
   *  Flux-batching sibling of `chargeUndispatchedEncoderLoss` (Codex
   *  diff-review r1 IMPORTANT fix: this tail sat outside ALL loss/flush
   *  accounting before this fix — `disconnect()`'s graceful path now
   *  flushes it through the sender, but an unexpected close never
   *  reached the sender at all). Clears the accumulator after charging,
   *  same as the graceful-flush path. */
  private chargeFluxTailLoss(epoch: ConnectionEpoch): void {
    if (this.fluxSampleBuffer.length === 0 || this.fluxAccumulatorRangeStart === null) return;
    this.onUndispatchedLoss({
      samples: this.fluxSampleBuffer.slice(),
      recordingSessionId: this.sessionContext.recordingSessionId,
      epoch,
      captureSampleRange: {
        start: this.fluxAccumulatorRangeStart,
        end: this.fluxAccumulatorRangeStart + this.fluxSampleBuffer.length,
      },
    });
    this.fluxSampleBuffer = new Int16Array(0);
    this.fluxAccumulatorRangeStart = null;
    // PLAN-E1B2 item 3 (self-audit + Codex r1 lens A) — this is the FOURTH
    // accumulator reset site, not among the three the plan cited. Leaving
    // the capturedAt FIFO populated here would hand the lost tail's stale
    // entries to the first post-reconnect frame and desync every frame
    // after it.
    this.fluxAccumulatorCapturedAtQueue = [];
  }

  /**
   * Snapshot of the most recent CCU photo analysis. When set, the next
   * `connect()` call augments the keyterm list with board-specific
   * vocabulary (manufacturer, OCPD types found, circuit labels, etc.)
   * — see `generateKeyterms` for the full set of derivations. Caller
   * (the recording context) sets this when CCU analysis lands and
   * before re-connecting Deepgram for the next recording session.
   */
  setCcuAnalysis(analysis: CcuAnalysisLite | null): void {
    this.ccuAnalysis = analysis;
  }

  private resampleTo16k(samples: Float32Array): Float32Array {
    const ratio = this.sourceSampleRate / 16000;
    const outLen = Math.floor(samples.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const srcIdx = i * ratio;
      const lo = Math.floor(srcIdx);
      const hi = Math.min(lo + 1, samples.length - 1);
      const frac = srcIdx - lo;
      out[i] = samples[lo] * (1 - frac) + samples[hi] * frac;
    }
    return out;
  }

  /** Keep Deepgram's idle timeout from closing the stream during silence
   *  (default is 10s). Send KeepAlive JSON + 500ms of silent PCM every 10s
   *  when no real audio has been sent in the last 8s. Matches iOS.
   *
   *  Skips the tick when `ws.bufferedAmount > 0` — i.e. real audio is
   *  still queued up waiting for the socket to drain. Dumping a JSON
   *  frame + 500 ms of silent PCM on top of a backpressured socket only
   *  makes the backpressure worse and Deepgram treats the arriving
   *  silence as real audio during a live utterance, degrading interim
   *  transcripts. The next scheduled tick (10 s later) re-evaluates, so
   *  once the buffer drains back to 0 the KeepAlive resumes normally. */
  private startKeepAlive() {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      if (!this.ws || this.state !== 'connected') return;
      // Flux rejects the nova-3 KeepAlive: `{type:'KeepAlive'}` is an
      // UNPARSABLE_CLIENT_MESSAGE on /v2/listen, and 500ms of silent PCM
      // zeros trigger a spurious EndOfTurn. So the JSON-KeepAlive + silent-PCM
      // idle-hold is nova-3-ONLY. On Flux an extended-silence idle-close is
      // handled by auto-reconnect (fetcher mode) / the sleep manager, exactly
      // as iOS does (it never KeepAlives on Flux). Matches
      // DeepgramService.swift's Flux idle handling.
      if (this.sttModel === 'flux') return;
      // Backpressure gate — skip this tick if the browser still has
      // bytes queued for the socket. See `WebSocketFactory` + the 4b
      // tests for how this gets exercised (mock-socket hardcodes
      // bufferedAmount=0 so the product-level test requires an injected
      // fake WS with a mutable bufferedAmount field).
      if (this.ws.bufferedAmount > 0) return;
      const idleMs = this.lastAudioSendMs ? performance.now() - this.lastAudioSendMs : Infinity;
      if (idleMs < 8000) return;
      try {
        this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
      } catch {
        // ignore
      }
      // PLAN-E1 round-2: keepalive silence is a SYNTHETIC segment — it
      // routes through the SAME sender as every other binary frame
      // (single-sender invariant), but carries no capture range and is
      // excluded from VAD/materiality/loss-source accounting. In
      // practice `resolvedSenderCodec` is always 'linear16' here (this
      // branch only runs for nova-3, which the safety invariant always
      // forces to linear16), so this is 500ms of silent PCM sent
      // raw — routed through `dispatchFrame` anyway for the single-
      // sender invariant and so the dispatched-audio-time offset stays
      // correct across synthetic and captured segments alike.
      this.dispatchFrame({
        origin: 'synthetic',
        samples: new Int16Array(8000), // 500ms silence @16k
        recordingSessionId: this.sessionContext.recordingSessionId,
        epochScope: this.sessionContext.allocator.currentScope(this.currentEpoch),
      });
    }, 10000);
  }

  private stopKeepAlive() {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  private handleMessage(
    data: unknown,
    socketContext?: { epoch: ConnectionEpoch | null; origin: number }
  ): void {
    let json: Record<string, unknown>;
    try {
      const text = typeof data === 'string' ? data : new TextDecoder().decode(data as ArrayBuffer);
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }

    if (this.sttModel === 'flux') {
      this.handleFluxMessage(json, socketContext);
      return;
    }

    const type = json.type as string | undefined;
    switch (type) {
      case 'Results': {
        const channel = json.channel as Record<string, unknown> | undefined;
        const alternatives = channel?.alternatives as Array<Record<string, unknown>> | undefined;
        const first = alternatives?.[0];
        if (!first) return;
        const transcript = (first.transcript as string | undefined) ?? '';
        if (!transcript) return;
        const confidence = (first.confidence as number | undefined) ?? 0;
        const isFinal = (json.is_final as boolean | undefined) ?? false;

        const words: DeepgramWord[] = [];
        const rawWords = first.words as Array<Record<string, unknown>> | undefined;
        if (rawWords) {
          for (const w of rawWords) {
            if (
              typeof w.word === 'string' &&
              typeof w.start === 'number' &&
              typeof w.end === 'number' &&
              typeof w.confidence === 'number'
            ) {
              words.push({
                word: w.word,
                start: w.start,
                end: w.end,
                confidence: w.confidence,
                punctuated_word: w.punctuated_word as string | undefined,
              });
            }
          }
        }

        if (isFinal) {
          pipelineLog('deepgram_final', {
            textLength: transcript.length,
            textPreview: transcript.slice(0, 40),
            confidence: Math.round(confidence * 1000) / 1000,
            wordCount: words.length,
          });
          this.callbacks.onFinalTranscript(transcript, confidence, words);
        } else {
          pipelineLog('deepgram_interim', {
            textLength: transcript.length,
            confidence: Math.round(confidence * 1000) / 1000,
          });
          this.callbacks.onInterimTranscript(transcript, confidence);
        }
        break;
      }
      case 'SpeechStarted':
        pipelineLog('deepgram_speech_started', {});
        this.callbacks.onSpeechStarted?.();
        break;
      case 'UtteranceEnd':
        pipelineLog('deepgram_utterance_end', {});
        this.callbacks.onUtteranceEnd?.();
        break;
      case 'Error': {
        const msg = (json.message as string | undefined) ?? 'Unknown Deepgram error';
        pipelineLog('deepgram_dg_error', {
          messageLength: msg.length,
          messagePreview: msg.slice(0, 80),
        });
        this.callbacks.onError?.(new Error(msg));
        break;
      }
      default:
      // Metadata + other housekeeping — ignored.
    }
  }

  /**
   * Flux `/v2/listen` message dispatch. Ports iOS's Flux handler
   * (`DeepgramService.swift` — Connected / ConfigureSuccess / ConfigureFailure
   * / TurnInfo / Error). Maps Flux turn events onto the SAME delegate API as
   * nova-3 so recording-context needs no Flux-awareness:
   *   - TurnInfo/Update      → onInterimTranscript
   *   - TurnInfo/StartOfTurn → onSpeechStarted
   *   - TurnInfo/EndOfTurn (transcript)  → onFinalTranscript + onUtteranceEnd
   *   - TurnInfo/EndOfTurn (empty)       → onUtteranceEnd (silence-driven close)
   *
   * "Dispatch ALL message types" (2026-05-15 mistake): Error AND
   * ConfigureFailure are surfaced, never silently dropped.
   */
  private handleFluxMessage(
    json: Record<string, unknown>,
    socketContext?: { epoch: ConnectionEpoch | null; origin: number }
  ): void {
    const type = json.type as string | undefined;
    switch (type) {
      case 'Connected': {
        pipelineLog('deepgram_flux_connected', {
          requestId: (json.request_id as string | undefined) ?? '?',
        });
        break;
      }
      case 'ConfigureSuccess':
        this.resolveConfigure(json, /*success*/ true);
        break;
      case 'ConfigureFailure':
        this.resolveConfigure(json, /*success*/ false);
        break;
      case 'TurnInfo':
        this.handleFluxTurnInfo(json, socketContext);
        break;
      case 'Error': {
        // Surface — never drop. Flux fatal errors arrive as {type:'Error'|'Fatal'}.
        const msg =
          (json.description as string | undefined) ??
          (json.message as string | undefined) ??
          'Unknown Deepgram Flux error';
        pipelineLog('deepgram_flux_error', {
          messagePreview: msg.slice(0, 80),
        });
        this.callbacks.onError?.(new Error(msg));
        break;
      }
      case 'Fatal': {
        const msg =
          (json.description as string | undefined) ??
          (json.message as string | undefined) ??
          'Deepgram Flux fatal';
        pipelineLog('deepgram_flux_fatal', { messagePreview: msg.slice(0, 80) });
        this.callbacks.onError?.(new Error(msg));
        break;
      }
      default:
      // Metadata / housekeeping — ignored.
    }
  }

  /**
   * Flux `TurnInfo` handler — the `event` discriminator carries the turn
   * sub-type. Ports iOS `handleFluxTurnInfo`. EagerEndOfTurn is ignored
   * (eager mode disabled — no `eager_eot_threshold` in the URL), matching iOS.
   */
  private handleFluxTurnInfo(
    json: Record<string, unknown>,
    socketContext?: { epoch: ConnectionEpoch | null; origin: number }
  ): void {
    const event = json.event as string | undefined;
    if (!event) return;
    const transcript = (json.transcript as string | undefined) ?? '';
    const confidence = (json.end_of_turn_confidence as number | undefined) ?? 0;
    // PLAN-E2 — the Deepgram-processed WATERMARK. `audio_window_end` is
    // SECONDS since this connection's stream began; convert through the
    // shared 16kHz helper (floor, finite/non-negative) and offset by this
    // epoch's dispatch origin so the ledger retires only SAME-epoch
    // dispatched ranges. Every TurnInfo event carries it, so retirement
    // advances on interims and silence-driven EndOfTurns alike.
    this.advanceProcessedWatermark(json.audio_window_end, socketContext);

    switch (event) {
      case 'Update': {
        if (!transcript) return;
        pipelineLog('deepgram_interim', {
          textLength: transcript.length,
          confidence: Math.round(confidence * 1000) / 1000,
        });
        // A02D — a NON-EMPTY interim confirms a pending onset (empty ones
        // returned above never reach here).
        this.noteProviderSpeechEvidence();
        this.callbacks.onInterimTranscript(transcript, confidence);
        break;
      }
      case 'StartOfTurn':
        pipelineLog('deepgram_speech_started', {});
        this.noteProviderSpeechEvidence();
        this.callbacks.onSpeechStarted?.();
        break;
      case 'EndOfTurn': {
        if (!transcript) {
          // Pure silence-driven turn close (Flux fires this every
          // eot_timeout_ms of silence). Map to utterance-end for the sleep
          // state machine; do NOT fire a final. Matches iOS.
          pipelineLog('deepgram_utterance_end', {});
          this.callbacks.onUtteranceEnd?.();
          return;
        }
        // Flux EndOfTurn is the trusted turn-end signal (no nova-3-style
        // speech_final gating). Build word timings from Flux's word array.
        const words: DeepgramWord[] = [];
        const rawWords = json.words as Array<Record<string, unknown>> | undefined;
        if (rawWords) {
          for (const w of rawWords) {
            if (
              typeof w.word === 'string' &&
              typeof w.start === 'number' &&
              typeof w.end === 'number' &&
              typeof w.confidence === 'number'
            ) {
              words.push({
                word: w.word,
                start: w.start,
                end: w.end,
                confidence: w.confidence,
                punctuated_word: w.punctuated_word as string | undefined,
              });
            }
          }
        }
        pipelineLog('deepgram_final', {
          textLength: transcript.length,
          textPreview: transcript.slice(0, 40),
          confidence: Math.round(confidence * 1000) / 1000,
          wordCount: words.length,
        });
        this.callbacks.onFinalTranscript(
          transcript,
          confidence,
          words,
          // A02D FinalWindowV1 — this final's transport record: the emitting
          // socket's epoch + admissibility, the confirmed onset (or null),
          // the EndOfTurn `audio_window_end` in this epoch's dispatched
          // domain, and the provider's turn identity (a duplicate delivery
          // of the same EndOfTurn reuses the client's record).
          this.finalMeta(
            socketContext,
            json.audio_window_end,
            undefined,
            this.providerFinalId(
              socketContext?.epoch ?? null,
              'flux',
              [json.turn_index, json.audio_window_end],
              transcript
            )
          )
        );
        // iOS canon (DeepgramService.swift handleFluxTurnInfo): EndOfTurn with
        // a transcript fires BOTH didReceiveFinalTranscript AND
        // didReceiveUtteranceEnd. Without the utterance-end,
        // isInspectorSpeaking sticks true after the first real utterance and
        // every FIFO confirmation defers forever (sess_mrbnds2d_jczh, A1).
        // Order matters: final first, then utterance-end, so the deferred
        // FIFO head drains after the final has been dispatched.
        pipelineLog('deepgram_utterance_end', {});
        this.callbacks.onUtteranceEnd?.();
        break;
      }
      case 'EagerEndOfTurn':
        // Eager mode disabled in v1 — log defensively, take no action.
        pipelineLog('deepgram_flux_eager_eot_ignored', {});
        break;
      case 'TurnResumed':
        pipelineLog('deepgram_flux_turn_resumed', {});
        break;
      default:
      // Unknown event — ignore.
    }
  }

  private advanceProcessedWatermark(
    rawWindowEnd: unknown,
    socketContext?: { epoch: ConnectionEpoch | null; origin: number }
  ): void {
    const ledger = this.sessionContext.lossLedger;
    // Codex E2 cycle-4 — advance the EMITTING socket's epoch/origin (bound at
    // construction), NOT ambient, so a valid final message from a just-closed
    // socket still retires its own epoch's evidence (a mid-stream drop can
    // never be retired regardless). The ledger's own per-epoch matching
    // ignores an advance for an epoch it holds no dispatched entries for.
    const epoch = socketContext?.epoch ?? this.currentEpoch;
    const origin = socketContext?.origin ?? this.epochDispatchOrigin;
    if (!ledger || epoch === null) return;
    if (typeof rawWindowEnd !== 'number' || !Number.isFinite(rawWindowEnd) || rawWindowEnd < 0) {
      return; // malformed vendor value — never a bogus retirement
    }
    ledger.advanceWatermark(epoch, origin + audioWindowEndToSampleOffset(rawWindowEnd));
  }

  /**
   * Send a Flux `Configure` control message and await its echo. Ports iOS
   * `sendConfigureMessage` echo-validation: `.ok` only if ConfigureSuccess
   * arrives within `timeoutMs` AND the echoed thresholds + keyterm count match
   * the request; ConfigureFailure or a mismatch or a timeout → `.ok:false`.
   * Also fires `onConfigureResult` (so the caller can log Configure success +
   * RTT — parent WS4 acceptance — and fail closed on failure).
   *
   * No-op-with-failure on the nova-3 path or when not connected. Used by the
   * focused-answer keyterm-narrowing path (equal-weight keyterms, plain
   * thresholds — the 2026-05-29 tightening rollback is canon).
   */
  sendConfigure(opts: {
    keyterms: string[];
    eotThreshold?: number;
    eotTimeoutMs?: number;
    timeoutMs?: number;
  }): Promise<ConfigureResult> {
    const eotThreshold = opts.eotThreshold ?? 0.7;
    const eotTimeoutMs = opts.eotTimeoutMs ?? 5000;
    const timeoutMs = opts.timeoutMs ?? 500;
    if (this.sttModel !== 'flux') {
      const r: ConfigureResult = { ok: false, reason: 'not_flux', rttMs: 0 };
      return Promise.resolve(r);
    }
    if (!this.ws || this.state !== 'connected') {
      const r: ConfigureResult = { ok: false, reason: 'not_connected', rttMs: 0 };
      return Promise.resolve(r);
    }
    // Only one Configure in flight — settle any prior as superseded.
    if (this.pendingConfigure) {
      clearTimeout(this.pendingConfigure.timer);
      this.pendingConfigure.resolve({ ok: false, reason: 'superseded', rttMs: 0 });
      this.pendingConfigure = null;
    }
    const message = {
      type: 'Configure',
      thresholds: { eot_threshold: eotThreshold, eot_timeout_ms: eotTimeoutMs },
      keyterms: opts.keyterms,
    };
    const sentAtMs = performance.now();
    return new Promise<ConfigureResult>((resolve) => {
      const settle = (r: ConfigureResult) => {
        if (this.pendingConfigure?.timer) clearTimeout(this.pendingConfigure.timer);
        this.pendingConfigure = null;
        this.callbacks.onConfigureResult?.(r);
        resolve(r);
      };
      const timer = setTimeout(() => {
        settle({ ok: false, reason: 'timeout', rttMs: Math.round(performance.now() - sentAtMs) });
      }, timeoutMs);
      this.pendingConfigure = {
        sentAtMs,
        expectedKeytermCount: opts.keyterms.length,
        eotThreshold,
        eotTimeoutMs,
        resolve: settle,
        timer,
      };
      try {
        this.ws!.send(JSON.stringify(message));
        pipelineLog('deepgram_flux_configure_sent', { keytermCount: opts.keyterms.length });
      } catch (err) {
        settle({ ok: false, reason: 'send_failed:' + String(err), rttMs: 0 });
      }
    });
  }

  /**
   * Resolve the pending Configure round-trip against a ConfigureSuccess /
   * ConfigureFailure message. On success, validate the echo (thresholds +
   * keyterm count) — a mismatch is treated as failure (fail closed), matching
   * iOS's echo-parity check.
   */
  private resolveConfigure(json: Record<string, unknown>, success: boolean): void {
    const pending = this.pendingConfigure;
    if (!pending) {
      // Unsolicited ack (e.g. Flux's initial config ack) — nothing to resolve.
      pipelineLog('deepgram_flux_configure_unsolicited', { success });
      return;
    }
    const rttMs = Math.round(performance.now() - pending.sentAtMs);
    if (!success) {
      const reason =
        (json.description as string | undefined) ??
        (json.message as string | undefined) ??
        'configure_failure';
      pending.resolve({ ok: false, reason, rttMs });
      return;
    }
    // Validate the echo. Flux echoes the applied `thresholds` + `keyterms`.
    const thresholds = json.thresholds as Record<string, unknown> | undefined;
    const echoedEot = thresholds?.eot_threshold as number | undefined;
    const echoedTimeoutRaw = thresholds?.eot_timeout_ms;
    const echoedTimeout = typeof echoedTimeoutRaw === 'number' ? echoedTimeoutRaw : undefined;
    const echoedKeyterms = json.keyterms as unknown[] | undefined;
    if (echoedEot !== undefined && Math.abs(echoedEot - pending.eotThreshold) > 1e-6) {
      pending.resolve({ ok: false, reason: 'echo_eot_threshold', rttMs });
      return;
    }
    if (echoedTimeout !== undefined && echoedTimeout !== pending.eotTimeoutMs) {
      pending.resolve({ ok: false, reason: 'echo_eot_timeout_ms', rttMs });
      return;
    }
    if (Array.isArray(echoedKeyterms) && echoedKeyterms.length !== pending.expectedKeytermCount) {
      pending.resolve({ ok: false, reason: 'echo_keyterm_count', rttMs });
      return;
    }
    pending.resolve({ ok: true, rttMs });
  }
}
