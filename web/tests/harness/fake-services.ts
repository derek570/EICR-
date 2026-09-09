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
  type DeepgramSessionContext,
  type DeepgramStreamingKeyConfig,
  type SttModel,
} from '@/lib/recording/deepgram-service';
import type {
  DeepgramServiceLike,
  SonnetSessionLike,
  RecordingTestServices,
} from '@/lib/recording/test-services';
import type { CapturedPcmSegment } from '@/lib/recording/tagged-pcm-segment';
import { SonnetSession, type SonnetConnectionState } from '@/lib/recording/sonnet-session';
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
  /** PLAN-C (id 120) — counts `sendInt16PCM` calls. Superseded as the
   *  production replay signal by `sentTaggedAudioBlocks` below (PLAN-E1
   *  moved ring-buffer replay off `sendInt16PCM` to preserve original
   *  capture tags), kept for any caller still injecting raw PCM. */
  sentInt16PCMBlocks = 0;
  /** PLAN-E1 — counts `sendTaggedAudio` calls so C2a tests can assert the
   *  lighter-weight-pause resume path sends NO ring-buffer replay (only
   *  the automatic-timer full-sleep wake path replays). */
  sentTaggedAudioBlocks = 0;
  /** PLAN-E1B2 item 3 — the actual tagged segments handed to
   *  `sendTaggedAudio`, so a mounted-provider test can assert the
   *  `capturedAt` the production `onSamples` callback stamped (not just
   *  count the calls). */
  readonly sentTaggedSegments: CapturedPcmSegment[] = [];
  /** A02D FinalWindowV1 — the harness has no audio, so no session-VAD onset
   *  ever reaches the sender. By default the fake models the ordinary field
   *  case (a VAD onset immediately before Deepgram's first speech evidence,
   *  confirmed within the window) so every final is BOUNDED and prefills
   *  exactly as before. Set false to model finals with no confirmed onset
   *  (`unbounded`, client-regex-ineligible). */
  autoConfirmOnset = true;
  private onsetNotedForTurn = false;
  private nextTurnIndex = 1;
  private lastEndOfTurnFrame: Record<string, unknown> | null = null;

  /** A02D — when true, `connect()` uses the real service's FETCHER mode
   *  (auto-reconnect with backoff on an unowned close), and every captive
   *  socket opens itself on the next microtask. */
  readonly reconnectable: boolean;
  /** Every captive socket ever created, oldest first (a superseded one
   *  still answers `emitFrame` — that is the late-final case). */
  readonly sockets: CaptiveWS[] = [];

  constructor(
    callbacks: DeepgramCallbacks,
    model: SttModel,
    sessionContext?: DeepgramSessionContext,
    opts: { reconnectable?: boolean } = {}
  ) {
    this.model = model;
    this.reconnectable = opts.reconnectable ?? false;
    this.inner = new DeepgramService(
      callbacks,
      (url, protocols) => {
        this.ws = new CaptiveWS(url, protocols);
        this.sockets.push(this.ws);
        if (this.reconnectable) {
          const ws = this.ws;
          queueMicrotask(() => ws.open());
        }
        return this.ws as unknown as WebSocket;
      },
      model,
      // PLAN-E1 — EXERCISES the session context (does not ignore it): the
      // wrapped real service reads the SAME shared latch/allocator/clock,
      // so a pause/resume test that constructs a NEW FakeDeepgramService
      // with the caller's session context proves cross-instance sharing,
      // not just single-instance latching.
      { sessionContext }
    );
  }

  /** PLAN-E1 — delegates to the wrapped real service so a test can assert
   *  the SAME session context is being consulted across a
   *  pause/resume-constructed sibling. */
  get latchedUplinkCodec(): 'linear16' | 'opus' | null {
    return this.inner.latchedUplinkCodec;
  }

  /** PLAN-E1 — delegates to the wrapped real service so a test driving
   *  `onSamples` through the fake still resolves the correct epoch
   *  scope for ring-buffer segments. */
  get liveEpoch() {
    return this.inner.liveEpoch;
  }

  /** PLAN-E2 — delegates to the wrapped real service so a provider test
   *  can prove the tap owner's `captureActive` push reaches the classifier. */
  get captureActive(): boolean {
    return this.inner.captureActive;
  }
  set captureActive(value: boolean) {
    this.inner.captureActive = value;
  }

  connect(
    _keyOrFetcher: string | (() => Promise<DeepgramStreamingKeyConfig>),
    sourceSampleRate: number
  ): void {
    if (this.reconnectable) {
      // Fetcher mode: the real service awaits the (fake) key fetch, opens
      // the socket, and on a reconnectable close reopens it under a NEW
      // epoch after its own backoff — the unowned-reconnect case.
      this.inner.connect(async () => ({ key: 'harness-fetched-key' }), sourceSampleRate);
      return;
    }
    // Static-key mode constructs the socket synchronously (same recipe as
    // the flux unit tests); the production fetcher is ignored — no network.
    this.inner.connect('harness-static-key', sourceSampleRate);
    this.ws?.open();
  }
  /** A02D — the socket dies UNDER the client (code 1006, not a close the
   *  client owns). In reconnectable mode the real service reconnects. */
  emitUnownedClose(code = 1006): void {
    if (!this.ws) throw new Error('FakeDeepgramService: connect() has not run');
    this.ws.onclose?.({ code, wasClean: false, reason: 'harness: unowned close' });
  }
  /** A02D — emit a frame on a SUPERSEDED socket (index into `sockets`). */
  emitFrameOnSocket(index: number, frame: Record<string, unknown>): void {
    const ws = this.sockets[index];
    if (!ws) throw new Error(`FakeDeepgramService: no socket #${index}`);
    ws.emit(frame);
  }
  disconnect(): void {
    this.inner.disconnect();
  }
  pause(): void {
    this.inner.pause();
  }
  resume(): void {
    this.inner.resume();
  }
  sendSamples(samples: Float32Array, capturedAt?: number): CapturedPcmSegment | null {
    this.sentSampleBlocks += 1;
    // PLAN-E1B2 item 3 (round-9 finding) — forward `capturedAt` instead of
    // dropping it. An optional param is safe to omit under structural
    // typing (still passes `tsc`), but silently discarding it here
    // reproduces this item's exact bug INSIDE this harness, since the
    // wrapped real `DeepgramService` would then fall back to its own
    // later `performance.now()`.
    return this.inner.sendSamples(samples, capturedAt);
  }
  sendTaggedAudio(segment: CapturedPcmSegment): void {
    this.sentTaggedAudioBlocks += 1;
    this.sentTaggedSegments.push(segment);
    this.inner.sendTaggedAudio(segment);
  }
  sendInt16PCM(pcm: Int16Array): void {
    this.sentInt16PCMBlocks += 1;
    this.inner.sendInt16PCM(pcm);
  }
  get connectionState(): DeepgramConnectionState {
    return this.inner.connectionState;
  }

  // ── Raw Flux frame drivers — parsed by the REAL service ──
  emitFrame(frame: Record<string, unknown>): void {
    if (!this.ws) throw new Error('FakeDeepgramService: connect() has not run');
    if (frame.event === 'EndOfTurn' && frame.transcript) this.lastEndOfTurnFrame = frame;
    this.ws.emit(frame);
  }
  /** A02D — model the session VAD firing just before this provider event. */
  private noteOnsetBeforeProviderEvidence(): void {
    if (!this.autoConfirmOnset || this.onsetNotedForTurn) return;
    this.inner.noteLocalSpeechOnset(performance.now());
    this.onsetNotedForTurn = true;
  }
  /** A02D — explicitly model the session VAD onset at the CURRENT
   *  dispatched-stream position (what production forwards from the
   *  tagging boundary). */
  noteLocalSpeechOnset(atMs: number = performance.now()): void {
    this.inner.noteLocalSpeechOnset(atMs);
    this.onsetNotedForTurn = true;
  }
  noteLocalSilence(): void {
    this.inner.noteLocalSilence();
  }
  /** A02D — advance the REAL dispatched-stream position by `frames` exact
   *  80 ms Flux frames of SILENT audio through the real sender (the
   *  position a manual tap samples as its stream cutoff). */
  advanceDispatchedStream(frames: number): void {
    // SILENT frames: they advance the sender's dispatched position without
    // flipping the session VAD to "speaking" (which would park a
    // clarification/disclosure behind local speech).
    for (let i = 0; i < frames; i++) this.inner.sendSamples(new Float32Array(1280));
  }
  get dispatchedStreamOffset(): number {
    return this.inner.dispatchedStreamOffset;
  }
  emitSpeechStarted(): void {
    this.noteOnsetBeforeProviderEvidence();
    this.emitFrame({ type: 'TurnInfo', event: 'StartOfTurn' });
  }
  emitInterim(text: string, confidence = 0.5): void {
    if (text !== '') this.noteOnsetBeforeProviderEvidence();
    this.emitFrame({
      type: 'TurnInfo',
      event: 'Update',
      transcript: text,
      end_of_turn_confidence: confidence,
    });
  }
  /** Transcript-bearing EndOfTurn — the REAL mapping decides what fires
   *  (post-A1: final + utterance-end; pre-A1: final only). */
  emitEndOfTurn(
    text: string,
    confidence = 0.9,
    audioWindowEndSeconds = 1.0,
    opts: {
      /** A02D — Flux's `turn_index`; pass the SAME value twice to model a
       *  duplicate delivery of one provider final. Auto-incremented when
       *  omitted so distinct EndOfTurns never coincide. */
      turnIndex?: number;
    } = {}
  ): void {
    if (this.autoConfirmOnset && !this.onsetNotedForTurn) {
      // A direct EndOfTurn with no preceding StartOfTurn/interim in the
      // test: model onset + confirmation at this instant.
      const t = performance.now();
      this.inner.noteLocalSpeechOnset(t);
      this.inner.noteProviderSpeechEvidence(t);
    }
    this.onsetNotedForTurn = false;
    const turnIndex = opts.turnIndex ?? this.nextTurnIndex++;
    this.emitFrame({
      type: 'TurnInfo',
      event: 'EndOfTurn',
      transcript: text,
      end_of_turn_confidence: confidence,
      audio_window_end: audioWindowEndSeconds,
      turn_index: turnIndex,
      words: [],
    });
  }
  /** A02D — re-deliver the last EndOfTurn frame byte-for-byte (same
   *  `turn_index`, same `audio_window_end`, same transcript). */
  emitDuplicateOfLastEndOfTurn(): void {
    const last = this.lastEndOfTurnFrame;
    if (!last) throw new Error('FakeDeepgramService: no EndOfTurn to duplicate');
    this.emitFrame(last);
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
  /** A1 agentic-voice (2026-07-23) — voice_command_response frames carry the
   *  model's spoken answers; the PR-1 verification-gate scenario drives the
   *  REAL onVoiceCommandResponse → speakConfirmation({force:true}) path. */
  onVoiceCommandResponse?: (msg: unknown) => void;
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
  readonly sentAskAnswers: Array<{ toolCallId: string; text: string; utteranceId?: string }> = [];
  readonly sentAddressMirrorDeliveryAcks: string[] = [];
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
  sendAskUserAnswered(
    toolCallId: string,
    text: string,
    utteranceId?: string,
    _purpose?: string | null
  ): void {
    this.sentAskAnswers.push({ toolCallId, text, utteranceId });
  }
  sendAddressMirrorDeliveryAck(deliveryToken: string): void {
    this.sentAddressMirrorDeliveryAcks.push(deliveryToken);
  }
  sendCompactRequest(): void {}
  sendJobStateUpdate(): void {}
  peekInFlightToolCallId(): string | null {
    return this.inFlightToolCallId;
  }
  consumeInFlightToolCallId(expectedId?: string | null): string | null {
    const id = expectedId ?? this.inFlightToolCallId;
    if (this.inFlightToolCallId === id) this.inFlightToolCallId = null;
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
  emitFieldCorrected(msg: {
    circuit: number | null;
    field: string;
    board_id?: string | null;
    previous_value?: string | null;
  }): void {
    this.callbacks.onFieldCorrected?.(msg);
  }
  /** A1 agentic-voice — `voice_command_response` frame (spoken answers).
   *  Same decoded shape the real SonnetSession delivers
   *  (sonnet-session.ts voice_command_response case). */
  emitVoiceCommandResponse(msg: {
    understood: boolean;
    spoken_response: string;
    action?: unknown;
  }): void {
    this.callbacks.onVoiceCommandResponse?.({
      understood: msg.understood,
      spoken_response: msg.spoken_response,
      action: msg.action ?? null,
    });
  }
}

/**
 * A02D (Codex diff-review cycle 1, BLOCKER 0) — harness Sonnet session that
 * wraps a REAL `SonnetSession` around a captive fake WebSocket, so every
 * scripted backend frame runs through the REAL `handleMessage` decoder
 * before it reaches recording-context. `FakeSonnetSession` invokes the
 * provider callbacks with undecoded objects, which is exactly how a decoder
 * that dropped `utterance_id` stayed green: the fake handed the provider a
 * field the production decoder never produced.
 *
 * Same driver surface as `FakeSonnetSession` (`sentTranscripts`,
 * `sentAskAnswers`, `emitExtraction`, `emitFieldCorrected`, `emitQuestion`,
 * `emitVoiceCommandResponse`), so a mounted test can switch sessions
 * without rewriting its steps; the emit* drivers here build the WIRE frame
 * and push it through the captive socket.
 */
export class RealDecoderSonnetSession implements SonnetSessionLike {
  readonly inner: SonnetSession;
  readonly sentTranscripts: SentTranscript[] = [];
  readonly sentAskAnswers: Array<{ toolCallId: string; text: string; utteranceId?: string }> = [];
  readonly sentAddressMirrorDeliveryAcks: string[] = [];
  /** Every frame the REAL session wrote to the captive socket, decoded. */
  readonly wireFrames: Array<Record<string, unknown>> = [];
  private ws: CaptiveWS | null = null;
  /** Frames emitted before the socket exists are queued to `connect()`. */
  private readonly pendingFrames: unknown[] = [];

  constructor(callbacks: FakeSonnetCallbacks) {
    this.inner = new SonnetSession(
      callbacks as unknown as ConstructorParameters<typeof SonnetSession>[0],
      {
        createSocket: (url) => {
          this.ws = new CaptiveWS(url);
          return this.ws as unknown as WebSocket;
        },
        getToken: () => 'harness-token',
        // The 25 s ALB heartbeat would otherwise fire under fake timers and
        // pollute `wireFrames`; a harness run never needs it.
        heartbeatIntervalMs: 60 * 60 * 1000,
      }
    );
  }

  connect(options: unknown): void {
    this.inner.connect(options as Parameters<SonnetSession['connect']>[0]);
    if (!this.ws) throw new Error('RealDecoderSonnetSession: the real session opened no socket');
    this.ws.open();
    // The server's first ack (Wave 4c.5 shape) — through the real decoder.
    this.emitRaw({ type: 'session_ack', status: 'new', sessionId: 'fake-server-session' });
    for (const frame of this.pendingFrames.splice(0)) this.emitRaw(frame);
  }
  disconnect(): void {
    this.inner.disconnect();
  }
  pause(): void {
    this.inner.pause();
  }
  resume(): void {
    this.inner.resume();
  }
  sendTranscript(text: string, options?: unknown): void {
    this.sentTranscripts.push({ text, options });
    this.inner.sendTranscript(text, options as Parameters<SonnetSession['sendTranscript']>[1]);
  }
  sendAskUserAnswered(
    toolCallId: string,
    text: string,
    utteranceId?: string,
    purpose?: string | null
  ): void {
    this.sentAskAnswers.push({ toolCallId, text, utteranceId });
    this.inner.sendAskUserAnswered(toolCallId, text, utteranceId, purpose);
  }
  sendAddressMirrorDeliveryAck(deliveryToken: string): void {
    this.sentAddressMirrorDeliveryAcks.push(deliveryToken);
    this.inner.sendAddressMirrorDeliveryAck(deliveryToken);
  }
  sendCompactRequest(): void {
    this.inner.sendCompactRequest();
  }
  sendJobStateUpdate(job: unknown): void {
    this.inner.sendJobStateUpdate(job as Parameters<SonnetSession['sendJobStateUpdate']>[0]);
  }
  peekInFlightToolCallId(): string | null {
    return this.inner.peekInFlightToolCallId();
  }
  consumeInFlightToolCallId(expectedId?: string | null): string | null {
    return this.inner.consumeInFlightToolCallId(expectedId);
  }
  clearInFlightToolCallIdByPrefix(prefix: string): void {
    this.inner.clearInFlightToolCallIdByPrefix(prefix);
  }
  get connectionState(): SonnetConnectionState {
    return this.inner.connectionState;
  }
  sendClientDiagnostic(category: string, payload: Record<string, unknown> = {}): void {
    this.inner.sendClientDiagnostic(category, payload);
  }

  // ── harness drivers: WIRE frames through the REAL decoder ──
  /** Push one raw server frame through the captive socket (JSON-encoded,
   *  exactly as the ALB would deliver it). */
  emitRaw(frame: unknown): void {
    if (!this.ws) {
      this.pendingFrames.push(frame);
      return;
    }
    this.ws.emit(frame);
    this.collectSentFrames();
  }
  private collectSentFrames(): void {
    if (!this.ws) return;
    while (this.wireFrames.length < this.ws.sent.length) {
      const raw = this.ws.sent[this.wireFrames.length];
      this.wireFrames.push(typeof raw === 'string' ? JSON.parse(raw) : { binary: true });
    }
  }
  /** The `transcript` frames the real session actually put on the wire. */
  get wireTranscripts(): Array<Record<string, unknown>> {
    this.collectSentFrames();
    return this.wireFrames.filter((f) => f.type === 'transcript');
  }
  /** `extraction` envelope (the `result` object as the server sends it). */
  emitExtraction(result: unknown): void {
    this.emitRaw({ type: 'extraction', result });
  }
  /** A legacy `question` frame, or — when `tool_call_id` is present — the
   *  Stage 6 `ask_user_started` frame (the real session then owns the
   *  in-flight tool-call id exactly as production does). */
  emitQuestion(
    q: { question: string; question_type?: string; tool_call_id?: string } & Record<string, unknown>
  ): void {
    if (typeof q.tool_call_id === 'string' && q.tool_call_id) {
      const { question_type, tool_call_id, ...rest } = q;
      this.emitRaw({ type: 'ask_user_started', ...rest, tool_call_id, reason: question_type });
      return;
    }
    this.emitRaw({ type: 'question', ...q });
  }
  /** Stage 6 STI-05 standalone `field_corrected` frame. */
  emitFieldCorrected(msg: {
    circuit: number | null;
    field: string;
    board_id?: string | null;
    previous_value?: string | null;
    utterance_id?: string;
  }): void {
    this.emitRaw({ type: 'field_corrected', ...msg });
  }
  emitVoiceCommandResponse(msg: {
    understood: boolean;
    spoken_response: string;
    action?: unknown;
  }): void {
    this.emitRaw({ type: 'voice_command_response', ...msg });
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
  /** A02D — the NEXT started confirmation fails after `onStart` (the
   *  player's terminal `onError`), then the flag clears. */
  failNextPlayback = false;
  readonly failed: string[] = [];
  private pendingPlays: Array<() => void> = [];

  confirmationPlayer = (text: string, controls: QueuePlayControls): void => {
    const prepared: PreparedAudio = {
      play: () => {
        if (this.failNextPlayback) {
          this.failNextPlayback = false;
          this.failed.push(text);
          controls.onStart();
          controls.onError(new Error('harness: playback failed'));
          return;
        }
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

export interface HarnessBundle<S extends FakeSonnetSession | RealDecoderSonnetSession> {
  services: RecordingTestServices;
  refs: {
    deepgram: FakeDeepgramService | null;
    sonnet: S | null;
  };
  /** PLAN-C (id 120) C2a — construction counts, so a regression can prove
   *  EXACTLY one mic/Deepgram reopen rather than merely a non-null ref
   *  (a duplicate reopen from a racing double-resume would otherwise be
   *  invisible — the second construction just overwrites `refs`). */
  counts: {
    deepgramConstructed: number;
    sonnetConstructed: number;
    micStarted: number;
    micStopped: number;
  };
  tts: FakeTtsPlayers;
  chimes: { count: number };
  diagnostics: Array<{ category: string; payload: Record<string, unknown> }>;
  jobChanges: Array<{ source: string; changedKeys?: string[] }>;
}

/**
 * Build a complete RecordingTestServices bundle with capture hooks.
 * The returned `refs` fill in as the provider constructs services.
 *
 * `sonnet: 'real-decoder'` (A02D) wraps a REAL `SonnetSession` around a
 * captive socket so scripted frames run through the production decoder;
 * the default keeps the callback-invoking `FakeSonnetSession`.
 */
export function buildHarnessServices(opts: {
  sonnet: 'real-decoder';
  deepgram?: 'static' | 'reconnectable';
}): HarnessBundle<RealDecoderSonnetSession>;
// Declared LAST so `ReturnType<typeof buildHarnessServices>` (runner.tsx)
// resolves to the fake-session bundle the existing harness code expects.
export function buildHarnessServices(opts?: {
  sonnet?: 'fake';
  deepgram?: 'static' | 'reconnectable';
}): HarnessBundle<FakeSonnetSession>;
export function buildHarnessServices(
  opts: { sonnet?: 'fake' | 'real-decoder'; deepgram?: 'static' | 'reconnectable' } = {}
): HarnessBundle<FakeSonnetSession | RealDecoderSonnetSession> {
  const refs: {
    deepgram: FakeDeepgramService | null;
    sonnet: FakeSonnetSession | RealDecoderSonnetSession | null;
  } = {
    deepgram: null,
    sonnet: null,
  };
  const counts = { deepgramConstructed: 0, sonnetConstructed: 0, micStarted: 0, micStopped: 0 };
  const tts = new FakeTtsPlayers();
  const chimes = { count: 0 };
  const diagnostics: Array<{ category: string; payload: Record<string, unknown> }> = [];
  const jobChanges: Array<{ source: string; changedKeys?: string[] }> = [];
  const services: RecordingTestServices = {
    deepgramServiceFactory: (callbacks, model, sessionContext) => {
      counts.deepgramConstructed += 1;
      refs.deepgram = new FakeDeepgramService(callbacks, model, sessionContext, {
        reconnectable: opts.deepgram === 'reconnectable',
      });
      return refs.deepgram;
    },
    sonnetSessionFactory: (callbacks) => {
      counts.sonnetConstructed += 1;
      refs.sonnet =
        opts.sonnet === 'real-decoder'
          ? new RealDecoderSonnetSession(callbacks as FakeSonnetCallbacks)
          : new FakeSonnetSession(callbacks as FakeSonnetCallbacks);
      return refs.sonnet;
    },
    micCaptureFactory: async (opts) => {
      counts.micStarted += 1;
      const handle = await fakeMicCaptureFactory(opts);
      // PLAN-C (id 120) C2a, cycle-2 re-review — count stop() so a test
      // can prove pause() actually released the mic handle it was
      // given, not merely that a fresh one was requested later.
      return {
        ...handle,
        stop: () => {
          counts.micStopped += 1;
          handle.stop();
        },
      };
    },
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
  return { services, refs, counts, tts, chimes, diagnostics, jobChanges };
}
