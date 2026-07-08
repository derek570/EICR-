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

import {
  appendKeytermsToUrl,
  generateKeyterms,
  appendFluxKeytermsToUrl,
  generateFluxKeyterms,
  type CcuAnalysisLite,
} from './keyword-boosts';
import { pipelineLog } from '@/lib/diagnostics/pipeline-log';

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
  onFinalTranscript: (text: string, confidence: number, words: DeepgramWord[]) => void;
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
   * Consumers typically replay their `AudioRingBuffer` via `sendInt16PCM()`
   * here so words spoken during the WS downtime aren't lost — matching the
   * iOS wake path that replays a 3-second ring buffer on Deepgram reopen.
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
export type DeepgramKeySource = string | (() => Promise<string>);

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
  private fetchKey: (() => Promise<string>) | null = null;
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
    sttModel: SttModel = 'nova3'
  ) {
    this.callbacks = callbacks;
    // Default to the real global WebSocket. Tests pass a factory whose
    // sockets expose a mutable `bufferedAmount` so the KeepAlive gate
    // can be exercised deterministically. Kept as an optional second
    // arg so every existing call site keeps working unchanged.
    this.wsFactory = wsFactory ?? ((url, protocols) => new WebSocket(url, protocols));
    this.sttModel = sttModel;
  }

  /** The STT model this instance was constructed with (diagnostics/tests). */
  get model(): SttModel {
    return this.sttModel;
  }

  get connectionState(): DeepgramConnectionState {
    return this.state;
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
      key = await this.fetchKey();
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

    const url = this.buildURL();
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
    const ws = this.wsFactory(url, ['bearer', apiKey]);
    ws.binaryType = 'arraybuffer';

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
      this.handleMessage(event.data);
    };

    ws.onerror = () => {
      pipelineLog('deepgram_ws_error', {
        willDeferToClose: this.shouldReconnect,
      });
      // In fetcher mode, defer to onclose — it will schedule a
      // reconnect. Surfacing an error event here would double-fire
      // through the `errorEmitted` guard and, worse, flash an error
      // UI during every transient network blip.
      if (this.shouldReconnect) return;
      this.setState('error');
      this.emitError(new Error('Deepgram WebSocket error'));
    };

    ws.onclose = (event) => {
      this.stopKeepAlive();
      this.ws = null;
      const reconnectable = event.code !== 1000 && event.code !== 1005;
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
   *  if the service has been paused by the SleepManager. */
  sendSamples(samples: Float32Array): void {
    if (this.paused) return;
    if (!this.ws || this.state !== 'connected' || samples.length === 0) return;

    const resampled = this.sourceSampleRate === 16000 ? samples : this.resampleTo16k(samples);

    const int16 = new Int16Array(resampled.length);
    for (let i = 0; i < resampled.length; i++) {
      const clamped = Math.max(-1, Math.min(1, resampled[i]));
      int16[i] = Math.round(clamped * 32767);
    }

    this.lastAudioSendMs = performance.now();

    if (this.sttModel === 'flux') {
      this.enqueueFluxFrames(int16);
      return;
    }

    try {
      this.ws.send(int16.buffer);
    } catch {
      // WS buffer full — drop the block. Rare; surfaces as minor gap.
    }
  }

  /**
   * Flux 80ms chunk batcher. Accumulates Int16 samples and flushes exactly
   * 1280-sample (2560-byte) frames — the ~80ms cadence Flux ingests best, and
   * the iOS chunk-batcher size. A partial tail (< one frame) is held until the
   * next block completes it. Cleared on disconnect so a stale tail can't leak
   * into the next session. nova-3 never calls this (sends blocks as-is).
   */
  private enqueueFluxFrames(int16: Int16Array): void {
    const FRAME = DeepgramService.FLUX_FRAME_SAMPLES;
    // Append to the carry-over buffer.
    let buf: Int16Array;
    if (this.fluxSampleBuffer.length === 0) {
      buf = int16;
    } else {
      buf = new Int16Array(this.fluxSampleBuffer.length + int16.length);
      buf.set(this.fluxSampleBuffer, 0);
      buf.set(int16, this.fluxSampleBuffer.length);
    }
    let offset = 0;
    while (buf.length - offset >= FRAME) {
      const frame = buf.subarray(offset, offset + FRAME);
      try {
        // Copy the exact frame range into its own buffer before send.
        const out = new Int16Array(FRAME);
        out.set(frame);
        this.ws!.send(out.buffer);
      } catch {
        // WS backpressure — drop this frame; the next flush re-evaluates.
      }
      offset += FRAME;
    }
    // Retain the sub-frame remainder for the next block.
    this.fluxSampleBuffer = offset < buf.length ? buf.slice(offset) : new Int16Array(0);
  }

  /** Drop a pre-recorded Int16 PCM block straight into the WS. Used by
   *  the SleepManager to replay the 3-second AudioRingBuffer on wake so
   *  Deepgram can transcribe the words spoken _just before_ VAD fired. */
  sendInt16PCM(samples: Int16Array): void {
    if (!this.ws || this.state !== 'connected' || samples.length === 0) return;
    this.lastAudioSendMs = performance.now();
    try {
      // Copy into a fresh ArrayBuffer so we send only the valid range
      // (the caller may hand us a subarray view).
      const copy = new Int16Array(samples.length);
      copy.set(samples);
      this.ws.send(copy.buffer);
    } catch {
      // Rare: WS backpressure. Drop the replay; live audio will follow.
    }
  }

  /** Freeze live sample forwarding without closing the socket. The
   *  KeepAlive loop continues so the Deepgram session stays alive;
   *  calling `resume()` un-freezes with negligible latency. Pair with
   *  `AudioRingBuffer.writeFloat32()` during pause so `sendInt16PCM()`
   *  on resume can catch Deepgram up to the wake moment. */
  pause(): void {
    this.paused = true;
  }

  /** Inverse of `pause()`. Optionally drain a caller-supplied replay
   *  buffer (typically the 3-second AudioRingBuffer) before live
   *  samples resume flowing — matches the iOS wake path. */
  resume(replay?: Int16Array): void {
    this.paused = false;
    if (replay && replay.length > 0) {
      this.sendInt16PCM(replay);
    }
  }

  /** Request a graceful stream close + tear the socket down. Cancels any
   *  pending auto-reconnect so a mid-backoff `stop()` doesn't leak a
   *  billable WS seconds later. */
  disconnect(): void {
    this.stopKeepAlive();
    this.paused = false;
    // Reset Flux batching + Configure state so nothing leaks into the next
    // session (a stale sub-frame tail or an orphaned Configure resolver).
    this.fluxSampleBuffer = new Int16Array(0);
    if (this.pendingConfigure) {
      clearTimeout(this.pendingConfigure.timer);
      this.pendingConfigure.resolve({ ok: false, reason: 'disconnected', rttMs: 0 });
      this.pendingConfigure = null;
    }
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
      this.setState('disconnected');
      return;
    }
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'CloseStream' }));
      }
    } catch {
      // ignore
    }
    // Give Deepgram ~300ms to flush any outstanding finals before we yank
    // the socket — matches iOS behaviour.
    setTimeout(() => {
      try {
        ws.close(1000);
      } catch {
        // ignore
      }
      this.ws = null;
      this.setState('disconnected');
    }, 300);
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private setState(next: DeepgramConnectionState) {
    if (this.state === next) return;
    this.state = next;
    this.callbacks.onStateChange?.(next);
  }

  private buildURL(): string {
    return this.sttModel === 'flux' ? this.buildFluxURL() : this.buildNova3URL();
  }

  /**
   * Flux `/v2/listen` `flux-general-en` URL. Ports iOS `buildFluxURL`
   * (DeepgramService.swift): drops every nova-3 turn-detection knob
   * (interim_results/endpointing/utterance_end_ms/vad_events — Flux's
   * model-driven turn detector replaces all of them), keeps audio format
   * identical, and appends EQUAL-WEIGHT keyterms (no `:boost` suffix — Flux
   * strips it) up to the 2000-char Flux URL budget. `mip_opt_out=true` stays
   * on the connect URL (GDPR/DPIA — per-connection, must not regress).
   */
  private buildFluxURL(): string {
    const params = new URLSearchParams({
      model: 'flux-general-en',
      encoding: 'linear16',
      sample_rate: '16000',
      // Flux turn-detection defaults, stated explicitly (self-documenting
      // baseline; the 2026-05-29 threshold-tightening was rolled back —
      // plain thresholds are canon). eot_threshold 0.5–0.9 default 0.7;
      // eot_timeout_ms 500–10000 default 5000.
      eot_threshold: '0.7',
      eot_timeout_ms: '5000',
      // GDPR/DPIA M2.1 — opt out of Deepgram's Model Improvement Partnership.
      // Per-connection by design so an account-config change can't regress it.
      // Mirrors iOS DeepgramService.swift:1705 + the nova-3 branch below.
      mip_opt_out: 'true',
    });

    const baseUrl = 'wss://api.deepgram.com/v2/listen';
    const baseLength = baseUrl.length + '?'.length + params.toString().length;
    const keyterms = generateFluxKeyterms(this.ccuAnalysis);
    appendFluxKeytermsToUrl(params, keyterms, baseLength);

    return `${baseUrl}?${params.toString()}`;
  }

  private buildNova3URL(): string {
    const params = new URLSearchParams({
      model: 'nova-3',
      smart_format: 'true',
      punctuate: 'true',
      numerals: 'true',
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      language: 'en-GB',
      interim_results: 'true',
      // 2026-06-04: bumped 300→400 ms to match iOS slice §3.3 of the
      // field-test-fixes-session-60754e4d sprint. iOS picked option 2
      // (unconditional 400 ms) because option 1's script-state-aware
      // 250/400 split would require a Deepgram WS reconnect on every
      // dialogue-script entry, dropping accumulated keyterm context
      // (per `rules/mistakes.md`). Web mirrors that choice — `rules/
      // mistakes.md` is explicit that the web and iOS Deepgram configs
      // must stay in sync; `endpointing` is listed among the params
      // they specifically must not drift on.
      endpointing: '400',
      // utterance_end_ms 1000 (NOT the legacy 2000): mirrors iOS canon
      // (DeepgramService.swift:751). Lowered from 1500→1000 on
      // 2026-04-26 (Bug-H follow-up) because the inspector's
      // transcript bar would otherwise sit grey for the full
      // utterance_end_ms window in noisy rooms — speech_final
      // sometimes fails to fire and Deepgram falls back to this
      // silence timer. 1000ms is the production value live in iOS;
      // the rules/mistakes.md note "Keep web and iOS Deepgram
      // configs in sync" (utterance_end_ms is explicitly listed
      // there) is the load-bearing reason this constant lives in
      // both clients with the SAME value.
      utterance_end_ms: '1000',
      vad_events: 'true',
      // Opt out of Deepgram's Model Improvement Partnership Program (MIP).
      // Without this flag the default account allows Deepgram to retain
      // audio for model training, which would be a UK GDPR breach on every
      // session: incidental third-party voices captured during inspector
      // dictation would end up in an external training corpus with no
      // lawful basis. Set on every connection rather than account-wide so
      // it cannot be regressed by an account-config change. Mirrors iOS
      // (DeepgramService.swift); the rules/mistakes.md "keep configs in
      // sync" note applies here. Tracked in DPIA mitigation M2.1.
      mip_opt_out: 'true',
    });

    // Nova-3 keyterm prompting — port of iOS `KeywordBoostGenerator`.
    // The base electrical vocabulary (~89 keyterms) goes on every
    // connect; CCU-augmented keyterms (board manufacturer / OCPD types
    // / circuit labels) are layered on via `setCcuAnalysis()` before
    // the next `connect()`. Audit Phase 6 P0 closed by this branch.
    //
    // The URL-length budget (1800 chars) is enforced inside
    // `appendKeytermsToUrl`. Lower-budget operators (mobile carriers
    // doing in-flight HTTP rewriting) sometimes truncate WS-upgrade
    // URLs; iOS picked 1800 as the safe cap after a 2026-02-26 incident
    // where 95 keyterms produced URLs >2200 chars and Deepgram 400'd.
    const baseUrl = 'wss://api.deepgram.com/v1/listen';
    const baseLength = baseUrl.length + '?'.length + params.toString().length;
    const keyterms = generateKeyterms(this.ccuAnalysis);
    appendKeytermsToUrl(params, keyterms, baseLength);

    return `${baseUrl}?${params.toString()}`;
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
        this.ws.send(new Int16Array(8000).buffer); // 500ms silence @16k
      } catch {
        // ignore
      }
    }, 10000);
  }

  private stopKeepAlive() {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  private handleMessage(data: unknown): void {
    let json: Record<string, unknown>;
    try {
      const text = typeof data === 'string' ? data : new TextDecoder().decode(data as ArrayBuffer);
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }

    if (this.sttModel === 'flux') {
      this.handleFluxMessage(json);
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
  private handleFluxMessage(json: Record<string, unknown>): void {
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
        this.handleFluxTurnInfo(json);
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
  private handleFluxTurnInfo(json: Record<string, unknown>): void {
    const event = json.event as string | undefined;
    if (!event) return;
    const transcript = (json.transcript as string | undefined) ?? '';
    const confidence = (json.end_of_turn_confidence as number | undefined) ?? 0;

    switch (event) {
      case 'Update': {
        if (!transcript) return;
        pipelineLog('deepgram_interim', {
          textLength: transcript.length,
          confidence: Math.round(confidence * 1000) / 1000,
        });
        this.callbacks.onInterimTranscript(transcript, confidence);
        break;
      }
      case 'StartOfTurn':
        pipelineLog('deepgram_speech_started', {});
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
        this.callbacks.onFinalTranscript(transcript, confidence, words);
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
