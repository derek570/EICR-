/**
 * Direct-to-Deepgram Nova-3 WebSocket client.
 *
 * Mirrors the iOS `DeepgramService.swift` protocol so the two clients
 * behave identically — same URL parameters (nova-3 / linear16 / 16kHz /
 * en-GB / interim_results / endpointing=300 / utterance_end_ms=1500 /
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

  constructor(callbacks: DeepgramCallbacks, wsFactory?: WebSocketFactory) {
    this.callbacks = callbacks;
    // Default to the real global WebSocket. Tests pass a factory whose
    // sockets expose a mutable `bufferedAmount` so the KeepAlive gate
    // can be exercised deterministically. Kept as an optional second
    // arg so every existing call site keeps working unchanged.
    this.wsFactory = wsFactory ?? ((url, protocols) => new WebSocket(url, protocols));
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

    try {
      this.ws.send(int16.buffer);
    } catch {
      // WS buffer full — drop the block. Rare; surfaces as minor gap.
    }
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
      endpointing: '300',
      // utterance_end_ms 1500 — match iOS DeepgramService.swift after the
      // 2026-04-20 voice-quality-sprint Stage 1 tuning. iOS history (per
      // its inline comment): 2000 → 1200 shortened TTS latency (8-12s →
      // ~3s); 1200 → 1500 trades 300ms for fewer mid-utterance
      // truncations when the inspector pauses mid-reading ("R1 plus R2
      // is ... zero point six four"). speech_final remains the primary
      // turn-end signal; UtteranceEnd is the silence-timeout fallback.
      // Project rule (`~/.claude/rules/mistakes.md`): keep web and iOS
      // Deepgram configs in sync. Audit Phase 6 P0 flagged this drift.
      utterance_end_ms: '1500',
      vad_events: 'true',
    });
    return `wss://api.deepgram.com/v1/listen?${params.toString()}`;
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
          this.callbacks.onFinalTranscript(transcript, confidence, words);
        } else {
          this.callbacks.onInterimTranscript(transcript, confidence);
        }
        break;
      }
      case 'SpeechStarted':
        this.callbacks.onSpeechStarted?.();
        break;
      case 'UtteranceEnd':
        this.callbacks.onUtteranceEnd?.();
        break;
      case 'Error': {
        const msg = (json.message as string | undefined) ?? 'Unknown Deepgram error';
        this.callbacks.onError?.(new Error(msg));
        break;
      }
      default:
      // Metadata + other housekeeping — ignored.
    }
  }
}
