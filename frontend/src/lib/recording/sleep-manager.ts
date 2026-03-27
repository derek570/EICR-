import { AudioRingBuffer } from './audio-ring-buffer';

export type SleepState = 'active' | 'dozing' | 'sleeping';
export type VadState = 'idle' | 'listening' | 'speaking' | 'trailing';

export interface SleepManagerCallbacks {
  onEnterDozing: () => void;
  onEnterSleeping: () => void;
  onWake: (fromState: SleepState) => void;
  onVadStateChange?: (state: VadState) => void;
}

// --- Configuration: aligned with iOS SleepManager.swift ---

/** Seconds of no FINAL_TRANSCRIPT before entering doze.
 *  10s gives inspectors time for brief pauses between readings while
 *  still catching idle sessions quickly. With reliable VAD wake,
 *  aggressive doze is safe because waking is fast and accurate.
 *  (iOS: noTranscriptTimeout = 10.0) */
const NO_TRANSCRIPT_TIMEOUT = 10_000;

/** Dozing → Sleeping timeout. 30 minutes matches iOS dozingTimeout.
 *  Sleeping disconnects Deepgram entirely; dozing just pauses the stream.
 *  (iOS: dozingTimeout = 1800.0) */
const DOZING_TIMEOUT = 1_800_000;

/** Sliding window size in frames. The @ricky0123/vad-web library fires
 *  onSpeechStart/onSpeechEnd callbacks per "speech segment", which we
 *  treat as individual frames in the window. 30 frames provides ~960ms
 *  of analysis at 32ms/frame equivalent.
 *  (iOS: vadWindowSize = 30) */
const VAD_WINDOW_SIZE = 30;

/** Speech frames required within the sliding window to trigger wake.
 *  12 out of 30 = need ~384ms of sustained speech within any ~960ms window.
 *  Filters noise bursts while catching normal conversational speech.
 *  (iOS: vadWakeFramesRequired = 12) */
const VAD_WAKE_FRAMES_REQUIRED = 12;

/** VAD probability threshold for speech detection.
 *  With AGC effects reduced during doze, room noise reads 0.01-0.20
 *  and speech reads 0.80+. 0.80 catches quieter/distant speech.
 *  Configured via @ricky0123/vad-web positiveSpeechThreshold.
 *  (iOS: vadWakeThreshold = 0.80) */
const VAD_WAKE_THRESHOLD = 0.8;

/** Number of VAD callbacks to skip after entering doze.
 *  When entering doze, the audio pipeline may still have AGC-boosted
 *  frames in flight. Processing these causes immediate false wakes.
 *  Skipping ~63 callbacks gives the pipeline time to settle.
 *  (iOS: vadCooldownFrames = 63) */
const VAD_COOLDOWN_FRAMES = 63;

export class SleepManager {
  private _state: SleepState = 'active';
  private _vadState: VadState = 'idle';
  private callbacks: SleepManagerCallbacks;

  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private dozingTimer: ReturnType<typeof setTimeout> | null = null;

  // Sliding window VAD state (matches iOS implementation)
  private vadWindow: boolean[];
  private vadWindowIndex = 0;
  private vadSpeechCount = 0;
  private vadCooldownRemaining = 0;

  // VAD instance from @ricky0123/vad-web (loaded dynamically)
  private micVAD: {
    start: () => Promise<void>;
    pause: () => Promise<void>;
    destroy: () => void;
  } | null = null;
  private vadInitializing = false;

  readonly ringBuffer = new AudioRingBuffer();

  get state(): SleepState {
    return this._state;
  }

  get vadState(): VadState {
    return this._vadState;
  }

  constructor(callbacks: SleepManagerCallbacks) {
    this.callbacks = callbacks;
    this.vadWindow = new Array(VAD_WINDOW_SIZE).fill(false);
  }

  /** Max time (ms) to wait for VAD WASM/ONNX to load before giving up.
   *  On low-memory mobile devices, WASM compilation can stall indefinitely. */
  private static readonly VAD_INIT_TIMEOUT_MS = 10_000;

  /**
   * Initialize Silero VAD. Must be called once after construction.
   * Uses dynamic import to avoid SSR issues with WASM/ONNX.
   * Configured with 0.80 threshold matching iOS vadWakeThreshold.
   *
   * This method NEVER rejects — if VAD fails or times out, recording
   * continues without VAD wake capability (doze/sleep still works via
   * transcript-based timers, but cannot wake on speech).
   */
  async initVAD(): Promise<void> {
    if (this.micVAD || this.vadInitializing) return;
    this.vadInitializing = true;

    try {
      // Race the VAD init against a timeout to prevent blocking recording startup
      const vadPromise = this.initVADInternal();
      const timeoutPromise = new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), SleepManager.VAD_INIT_TIMEOUT_MS)
      );

      const result = await Promise.race([vadPromise, timeoutPromise]);
      if (result === 'timeout') {
        console.error(
          `[SleepManager] VAD init timed out after ${SleepManager.VAD_INIT_TIMEOUT_MS}ms — continuing without VAD`
        );
      }
    } catch (err) {
      console.error('[SleepManager] Failed to initialize Silero VAD:', err);
      // Continue without VAD — recording still works, just no speech-wake from doze
    } finally {
      this.vadInitializing = false;
    }
  }

  private async initVADInternal(): Promise<void> {
    try {
      // Dynamic import to avoid SSR — vad-web requires browser APIs
      const { MicVAD } = await import('@ricky0123/vad-web');

      this.micVAD = await MicVAD.new({
        baseAssetPath: '/vad/',
        onnxWASMBasePath: '/vad/',
        model: 'v5',
        startOnLoad: false,
        // Match iOS vadWakeThreshold = 0.80 (default was 0.50)
        positiveSpeechThreshold: VAD_WAKE_THRESHOLD,

        onSpeechStart: () => {
          this.setVadState('speaking');
          this.onSpeechFrame(true);
        },

        onSpeechRealStart: () => {
          // Real speech confirmed (past minSpeechFrames threshold)
          this.setVadState('speaking');
        },

        onSpeechEnd: () => {
          this.setVadState('trailing');
          this.onSpeechFrame(false);
          // After trailing period, go back to listening
          setTimeout(() => {
            if (this._vadState === 'trailing') {
              this.setVadState(
                this._state === 'dozing' || this._state === 'sleeping' ? 'listening' : 'idle'
              );
            }
          }, 500);
        },

        onVADMisfire: () => {
          // Brief sound that wasn't real speech — mark as non-speech frame
          this.onSpeechFrame(false);
        },
      });
      console.log('[SleepManager] VAD initialized successfully');
    } catch (err) {
      console.error('[SleepManager] VAD internal init failed:', err);
      // Don't rethrow — let the caller handle gracefully
    }
  }

  start(): void {
    this._state = 'active';
    this.resetVADWindow();
    this.ringBuffer.reset();
    this.clearAllTimers();
    this.startSilenceTimer();
    this.setVadState('idle');
  }

  stop(): void {
    this.clearAllTimers();
    this._state = 'active';
    this.resetVADWindow();
    this.ringBuffer.reset();
    this.stopVAD();
    this.setVadState('idle');
  }

  destroy(): void {
    this.stop();
    if (this.micVAD) {
      this.micVAD.destroy();
      this.micVAD = null;
    }
  }

  onTranscriptReceived(): void {
    if (this._state === 'active') {
      this.resetSilenceTimer();
    }
  }

  processChunk(samples: Float32Array): void {
    if (this._state === 'dozing' || this._state === 'sleeping') {
      this.ringBuffer.write(samples);
    }
  }

  // --- Sliding window VAD (matches iOS SleepManager.processChunk) ---

  private resetVADWindow(): void {
    this.vadWindow = new Array(VAD_WINDOW_SIZE).fill(false);
    this.vadWindowIndex = 0;
    this.vadSpeechCount = 0;
    this.vadCooldownRemaining = 0;
  }

  private setVadState(state: VadState): void {
    if (this._vadState !== state) {
      this._vadState = state;
      this.callbacks.onVadStateChange?.(state);
    }
  }

  /**
   * Process a VAD callback as a frame in the sliding window.
   * The @ricky0123/vad-web library handles raw audio → Silero inference
   * internally and fires onSpeechStart/onSpeechEnd callbacks. We map
   * those into a sliding window identical to iOS's frame-by-frame approach.
   *
   * On iOS, processChunk() is called per 32ms audio chunk and runs Silero
   * inference directly. On web, the vad-web library batches this internally
   * and fires the callbacks, which we treat as equivalent frames.
   */
  private onSpeechFrame(isSpeech: boolean): void {
    if (this._state !== 'dozing' && this._state !== 'sleeping') return;

    // Cooldown: skip VAD processing for first N frames after doze entry.
    // The audio pipeline may still have AGC-boosted frames in flight,
    // causing immediate false wakes. Let them drain first.
    if (this.vadCooldownRemaining > 0) {
      this.vadCooldownRemaining--;
      return;
    }

    // Slide the window: remove the oldest frame's contribution
    if (this.vadWindow[this.vadWindowIndex]) {
      this.vadSpeechCount--;
    }

    // Insert the new frame
    this.vadWindow[this.vadWindowIndex] = isSpeech;
    if (isSpeech) {
      this.vadSpeechCount++;
    }
    this.vadWindowIndex = (this.vadWindowIndex + 1) % VAD_WINDOW_SIZE;

    // Check wake condition: enough speech frames in the window
    if (this.vadSpeechCount >= VAD_WAKE_FRAMES_REQUIRED) {
      console.log(
        `[SleepManager] VAD wake triggered: ${this.vadSpeechCount}/${VAD_WINDOW_SIZE} speech frames (${VAD_WAKE_FRAMES_REQUIRED} required)`
      );
      this.wake();
    }
  }

  // --- State transitions ---

  private enterDozing(): void {
    this._state = 'dozing';
    this.resetVADWindow();
    // Start cooldown — skip VAD callbacks for the first ~2s after doze entry.
    // Matches iOS vadCooldownFrames = 63 (~2s at 32ms/frame).
    this.vadCooldownRemaining = VAD_COOLDOWN_FRAMES;
    this.ringBuffer.reset();
    this.startVAD();
    this.startDozingTimer();
    console.log(
      `[SleepManager] ENTER_DOZING — ${NO_TRANSCRIPT_TIMEOUT / 1000}s no transcript, cooldown=${VAD_COOLDOWN_FRAMES} frames`
    );
    this.callbacks.onEnterDozing();
  }

  private enterSleeping(): void {
    this._state = 'sleeping';
    this.resetVADWindow();
    // VAD continues from dozing state
    console.log(
      `[SleepManager] ENTER_SLEEPING — ${DOZING_TIMEOUT / 1000}s dozing elapsed, disconnecting Deepgram entirely`
    );
    this.callbacks.onEnterSleeping();
  }

  private wake(): void {
    const fromState = this._state;
    this._state = 'active';
    this.resetVADWindow();
    this.stopVAD();
    this.clearDozingTimer();
    this.startSilenceTimer();
    this.setVadState('idle');
    console.log(
      `[SleepManager] WAKE — from ${fromState}, speechFrames=${this.vadSpeechCount}/${VAD_WINDOW_SIZE}`
    );
    this.callbacks.onWake(fromState);
  }

  // --- VAD start/stop ---

  private async startVAD(): Promise<void> {
    this.setVadState('listening');
    try {
      await this.micVAD?.start();
    } catch (err) {
      console.error('[SleepManager] Failed to start VAD:', err);
    }
  }

  private async stopVAD(): Promise<void> {
    try {
      await this.micVAD?.pause();
    } catch (err) {
      console.error('[SleepManager] Failed to pause VAD:', err);
    }
  }

  // --- No-transcript timer (active state → dozing) ---

  private startSilenceTimer(): void {
    this.clearSilenceTimer();
    this.silenceTimer = setTimeout(() => {
      if (this._state === 'active') {
        this.enterDozing();
      }
    }, NO_TRANSCRIPT_TIMEOUT);
  }

  private resetSilenceTimer(): void {
    this.startSilenceTimer();
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  // --- Dozing timer (dozing → sleeping) ---

  private startDozingTimer(): void {
    this.clearDozingTimer();
    this.dozingTimer = setTimeout(() => {
      if (this._state === 'dozing') {
        this.enterSleeping();
      }
    }, DOZING_TIMEOUT);
  }

  private clearDozingTimer(): void {
    if (this.dozingTimer !== null) {
      clearTimeout(this.dozingTimer);
      this.dozingTimer = null;
    }
  }

  // --- Cleanup ---

  private clearAllTimers(): void {
    this.clearSilenceTimer();
    this.clearDozingTimer();
  }

  /**
   * Called when Deepgram disconnects during doze. Stays in doze rather than
   * forcing sleeping — Deepgram's KeepAlive connection is unreliable (~20s
   * timeout), so this prevents premature sleeping. On wake, reconnect handles
   * the connection regardless of previous state.
   * (Matches iOS onDeepgramDisconnected behaviour)
   */
  onDeepgramDisconnected(): void {
    if (this._state === 'dozing') {
      console.log(
        '[SleepManager] Deepgram disconnected during doze — staying in doze (reconnect on wake)'
      );
    }
  }
}
