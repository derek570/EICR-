// sleep-detector.ts
// Browser-based sleep detector — port of standalone transcript app.
// Uses RMS energy analysis instead of Silero VAD (no external dependency).
//
// State machine: Active → Dozing → Sleeping
// - Active → Dozing: No FINAL_TRANSCRIPT for 15s
// - Dozing → Sleeping: No wake within 30min of dozing
// - Dozing/Sleeping → Active: Sustained speech energy detected in sliding window

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SleepState = 'active' | 'dozing' | 'sleeping';

export interface SleepDetectorCallbacks {
  onEnterDozing: () => void;
  onEnterSleeping: () => void;
  onWake: (fromState: SleepState) => void;
  onLog: (event: string, detail: string) => void;
}

export interface SleepDetectorConfig {
  /** Seconds of no FINAL_TRANSCRIPT before entering doze (default: 15) */
  noTranscriptTimeout: number;
  /** Extended timeout after a question is asked (default: 20) */
  questionAnswerTimeout: number;
  /** Extended timeout after waking (Deepgram reconnect grace period) (default: 25) */
  postWakeGraceTimeout: number;
  /** Seconds in doze before entering sleep (default: 1800 = 30min) */
  dozingTimeout: number;
  /** RMS energy threshold for speech detection (default: 0.01) */
  energyWakeThreshold: number;
  /** Minimum RMS to even consider as potential speech (default: 0.005) */
  energyFloor: number;
  /** Sliding window size in frames (default: 30, ~960ms at 32ms/frame) */
  windowSize: number;
  /** Speech frames required in window to trigger wake (default: 12) */
  wakeFramesRequired: number;
  /** Cooldown frames after doze entry to skip (AGC propagation) (default: 63) */
  cooldownFrames: number;
}

const DEFAULT_CONFIG: SleepDetectorConfig = {
  noTranscriptTimeout: 15,
  questionAnswerTimeout: 20,
  postWakeGraceTimeout: 25,
  dozingTimeout: 1800,
  energyWakeThreshold: 0.01,
  energyFloor: 0.005,
  windowSize: 30,
  wakeFramesRequired: 12,
  cooldownFrames: 63,
};

// ---------------------------------------------------------------------------
// Ring Buffer — captures pre-wake audio for replay to Deepgram
// ---------------------------------------------------------------------------

export class AudioRingBuffer {
  private buffer: Float32Array;
  private writePos = 0;
  private filled = false;

  /** capacity in samples (default: 5s at 16kHz = 80000) */
  constructor(capacitySamples = 80000) {
    this.buffer = new Float32Array(capacitySamples);
  }

  get capacity(): number {
    return this.buffer.length;
  }

  write(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      this.buffer[this.writePos] = samples[i];
      this.writePos = (this.writePos + 1) % this.buffer.length;
      if (this.writePos === 0) this.filled = true;
    }
  }

  /**
   * Drain the buffer as Int16 PCM ArrayBuffer, oldest samples first.
   * Converts Float32 [-1, 1] to Int16 [-32767, 32767].
   * Resets the buffer after draining.
   */
  drain(): ArrayBuffer {
    if (!this.filled && this.writePos === 0) {
      return new ArrayBuffer(0);
    }

    let sampleCount: number;
    let startIndex: number;

    if (this.filled) {
      sampleCount = this.buffer.length;
      startIndex = this.writePos; // oldest sample is at writePos when full
    } else {
      sampleCount = this.writePos;
      startIndex = 0;
    }

    const int16 = new Int16Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      const idx = (startIndex + i) % this.buffer.length;
      const clamped = Math.max(-1, Math.min(1, this.buffer[idx]));
      int16[i] = Math.round(clamped * 32767);
    }

    this.reset();
    return int16.buffer;
  }

  reset(): void {
    this.writePos = 0;
    this.filled = false;
  }
}

// ---------------------------------------------------------------------------
// SleepDetector
// ---------------------------------------------------------------------------

export class SleepDetector {
  private callbacks: SleepDetectorCallbacks;
  private config: SleepDetectorConfig;

  private _state: SleepState = 'active';
  private noTranscriptTimerId: ReturnType<typeof setTimeout> | null = null;
  private dozingTimerId: ReturnType<typeof setTimeout> | null = null;

  // VAD sliding window (RMS energy based)
  private vadWindow: boolean[];
  private vadWindowIndex = 0;
  private vadSpeechCount = 0;
  private vadCooldownRemaining = 0;

  // State flags
  private isPostWakeGrace = false;
  private isQuestionAnswerFlow = false;
  private isTTSActive = false;
  private isStarted = false;

  // Ring buffer for pre-wake audio replay
  readonly ringBuffer: AudioRingBuffer;

  constructor(callbacks: SleepDetectorCallbacks, config?: Partial<SleepDetectorConfig>) {
    this.callbacks = callbacks;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.vadWindow = new Array(this.config.windowSize).fill(false);
    this.ringBuffer = new AudioRingBuffer();
  }

  get state(): SleepState {
    return this._state;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  start(): void {
    this._state = 'active';
    this.isStarted = true;
    this.isPostWakeGrace = false;
    this.isQuestionAnswerFlow = false;
    this.isTTSActive = false;
    this.resetVADWindow();
    this.ringBuffer.reset();
    this.startNoTranscriptTimer();
    this.log(
      'STARTED',
      `noTranscriptTimeout=${this.config.noTranscriptTimeout}s, dozingTimeout=${this.config.dozingTimeout}s`
    );
  }

  stop(): void {
    this.isStarted = false;
    this.clearAllTimers();
    this._state = 'active';
    this.isPostWakeGrace = false;
    this.isQuestionAnswerFlow = false;
    this.isTTSActive = false;
    this.resetVADWindow();
    this.ringBuffer.reset();
    this.log('STOPPED', '');
  }

  // ---------------------------------------------------------------------------
  // Transcript Signal (doze entry trigger)
  // ---------------------------------------------------------------------------

  /** Called on each Deepgram FINAL_TRANSCRIPT. Resets the doze countdown. */
  onSpeechActivity(): void {
    if (this._state !== 'active') return;

    if (this.isPostWakeGrace) {
      this.isPostWakeGrace = false;
      this.log('GRACE_END', 'First transcript received after wake — reverting to normal timeout');
    }
    if (this.isQuestionAnswerFlow) {
      this.isQuestionAnswerFlow = false;
      this.log('QA_FLOW_END', 'User answered — reverting to normal timeout');
    }
    this.startNoTranscriptTimer();
  }

  // ---------------------------------------------------------------------------
  // TTS Awareness (prevents doze during artificial silence from TTS playback)
  // ---------------------------------------------------------------------------

  onTTSStarted(): void {
    this.isTTSActive = true;
    this.clearNoTranscriptTimer();
    this.log('TTS_STARTED', 'Doze timer suspended');
  }

  onTTSFinished(): void {
    this.isTTSActive = false;
    if (this._state === 'dozing' || this._state === 'sleeping') {
      this.log('TTS_WAKE', `TTS finished during ${this._state} — forcing wake`);
      this.wake();
    } else {
      this.startNoTranscriptTimer();
    }
  }

  // ---------------------------------------------------------------------------
  // Question Awareness
  // ---------------------------------------------------------------------------

  onQuestionAsked(): void {
    this.isQuestionAnswerFlow = true;
    if (this._state !== 'active') return;
    this.startNoTranscriptTimer();
    this.log('QUESTION_ASKED', `Using ${this.config.questionAnswerTimeout}s timeout for answer`);
  }

  /** Force-wake for incoming question delivery */
  wakeForQuestion(): void {
    if (this._state !== 'dozing' && this._state !== 'sleeping') return;
    this.log('WAKE_FOR_QUESTION', `Waking from ${this._state}`);
    this.wake();
  }

  // ---------------------------------------------------------------------------
  // Audio Chunk Processing (VAD via RMS energy)
  // ---------------------------------------------------------------------------

  /**
   * Process a chunk of audio samples for voice activity detection.
   * Call this continuously with PCM samples (Float32, any chunk size).
   * During doze/sleep, audio is also written to the ring buffer for replay.
   */
  processAudioChunk(samples: Float32Array): void {
    if (!this.isStarted) return;
    if (this._state !== 'dozing' && this._state !== 'sleeping') return;

    // Write to ring buffer for pre-wake replay
    this.ringBuffer.write(samples);

    // Cooldown period after doze entry (AGC propagation)
    if (this.vadCooldownRemaining > 0) {
      this.vadCooldownRemaining -= 1;
      return;
    }

    // Calculate RMS energy
    let sumSquares = 0;
    for (let i = 0; i < samples.length; i++) {
      sumSquares += samples[i] * samples[i];
    }
    const rms = Math.sqrt(sumSquares / samples.length);

    // Determine if this chunk is speech
    let isSpeech = false;
    if (rms > this.config.energyFloor) {
      isSpeech = rms >= this.config.energyWakeThreshold;
    }

    // Update sliding window
    if (this.vadWindow[this.vadWindowIndex]) {
      this.vadSpeechCount -= 1;
    }
    this.vadWindow[this.vadWindowIndex] = isSpeech;
    if (isSpeech) {
      this.vadSpeechCount += 1;
    }
    this.vadWindowIndex = (this.vadWindowIndex + 1) % this.config.windowSize;

    // Check wake condition
    if (this.vadSpeechCount >= this.config.wakeFramesRequired) {
      this.log(
        'VAD_WAKE',
        `${this.vadSpeechCount}/${this.config.windowSize} speech frames (${this.config.wakeFramesRequired} required), rms=${rms.toFixed(4)}`
      );
      this.wake();
    }
  }

  // ---------------------------------------------------------------------------
  // State Transitions
  // ---------------------------------------------------------------------------

  private enterDozing(): void {
    if (this._state !== 'active') return;
    if (this.isTTSActive) {
      this.log('DOZE_BLOCKED', 'TTS is active');
      return;
    }

    this._state = 'dozing';
    this.resetVADWindow();
    this.vadCooldownRemaining = this.config.cooldownFrames;
    this.clearNoTranscriptTimer();
    this.isPostWakeGrace = false;
    this.isQuestionAnswerFlow = false;

    const timeout = this.getCurrentTimeout();
    this.log(
      'ENTER_DOZING',
      `${timeout}s no transcript — pausing stream, cooldown=${this.config.cooldownFrames} frames`
    );

    // Start dozing timer → sleeping
    this.dozingTimerId = setTimeout(() => {
      this.dozingTimerId = null;
      this.enterSleeping();
    }, this.config.dozingTimeout * 1000);

    this.callbacks.onEnterDozing();
  }

  private enterSleeping(): void {
    if (this._state !== 'dozing') return;

    this._state = 'sleeping';
    this.clearDozingTimer();
    this.resetVADWindow();

    this.log(
      'ENTER_SLEEPING',
      `${this.config.dozingTimeout}s dozing elapsed — disconnecting Deepgram entirely`
    );
    this.callbacks.onEnterSleeping();
  }

  private wake(): void {
    const previousState = this._state;
    this._state = 'active';
    this.clearDozingTimer();
    this.isPostWakeGrace = true;

    this.log(
      'WAKE',
      `from ${previousState}, speechFrames=${this.vadSpeechCount}/${this.config.windowSize}, graceTimeout=${this.config.postWakeGraceTimeout}s`
    );

    this.resetVADWindow();
    this.startNoTranscriptTimer();
    this.callbacks.onWake(previousState);
  }

  // ---------------------------------------------------------------------------
  // Timers
  // ---------------------------------------------------------------------------

  private getCurrentTimeout(): number {
    if (this.isPostWakeGrace) return this.config.postWakeGraceTimeout;
    if (this.isQuestionAnswerFlow) return this.config.questionAnswerTimeout;
    return this.config.noTranscriptTimeout;
  }

  private startNoTranscriptTimer(): void {
    this.clearNoTranscriptTimer();
    const timeout = this.getCurrentTimeout();
    this.noTranscriptTimerId = setTimeout(() => {
      this.noTranscriptTimerId = null;
      this.enterDozing();
    }, timeout * 1000);
  }

  private clearNoTranscriptTimer(): void {
    if (this.noTranscriptTimerId !== null) {
      clearTimeout(this.noTranscriptTimerId);
      this.noTranscriptTimerId = null;
    }
  }

  private clearDozingTimer(): void {
    if (this.dozingTimerId !== null) {
      clearTimeout(this.dozingTimerId);
      this.dozingTimerId = null;
    }
  }

  private clearAllTimers(): void {
    this.clearNoTranscriptTimer();
    this.clearDozingTimer();
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private resetVADWindow(): void {
    this.vadWindow = new Array(this.config.windowSize).fill(false);
    this.vadWindowIndex = 0;
    this.vadSpeechCount = 0;
    this.vadCooldownRemaining = 0;
  }

  private log(event: string, detail: string): void {
    const ts = new Date().toISOString().slice(11, 23);
    const msg = detail
      ? `[SleepDetector ${ts}] ${event}: ${detail}`
      : `[SleepDetector ${ts}] ${event}`;
    console.log(msg);
    this.callbacks.onLog(event, detail);
  }

  /** Notify sleep detector that Deepgram disconnected (stay in doze, don't force sleep) */
  onDeepgramDisconnected(): void {
    if (this._state === 'dozing') {
      this.log(
        'DG_DISCONNECTED',
        'Deepgram disconnected during doze — staying in doze (reconnect on wake)'
      );
    }
  }
}
