/**
 * SleepDetector — RMS-based silence/idle detector for Deepgram streaming.
 *
 * Monitors audio levels to detect sustained silence. After ~10 seconds of
 * continuous silence, signals the caller to stop sending full audio and switch
 * to keep-alive mode. Resumes immediately when speech is detected above
 * threshold.
 *
 * Includes a 3-second ring buffer to capture pre-wake audio so the first
 * words that break the silence aren't lost.
 *
 * Adapted from iOS SleepManager.swift / frontend SleepManager.ts, simplified
 * to use RMS energy detection instead of Silero VAD (avoids WASM/ONNX dep).
 */

export type SleepState = 'active' | 'dozing';

export interface SleepDetectorCallbacks {
  onEnterDozing: () => void;
  onWake: (bufferedAudio: ArrayBuffer) => void;
  onStateChange: (state: SleepState) => void;
}

// --- Configuration ---

/** Int16 RMS threshold below which audio is considered silence.
 *  With browser noiseSuppression enabled, room noise is typically < 100.
 *  Normal speech is 2000+. 300 provides a clean separation. */
const SILENCE_RMS_THRESHOLD = 300;

/** Milliseconds of continuous silence before entering doze mode.
 *  ~10 seconds as specified. */
const SILENCE_TIMEOUT_MS = 10_000;

/** Ring buffer duration. Captures audio during doze so pre-wake words
 *  aren't lost when speech resumes. Matches iOS (3s at 16kHz). */
const RING_BUFFER_CAPACITY = 3 * 16000; // 48000 Int16 samples

/** Consecutive above-threshold audio chunks required to trigger wake.
 *  Prevents false wakes from brief noise spikes.
 *  At ~128 samples per worklet chunk (8ms), 3 chunks = ~24ms. */
const WAKE_CHUNKS_REQUIRED = 3;

export class SleepDetector {
  private _state: SleepState = 'active';
  private callbacks: SleepDetectorCallbacks;

  // Silence tracking
  private silentSince: number | null = null;

  // Wake tracking
  private consecutiveLoudChunks = 0;

  // Ring buffer for pre-wake audio capture (Int16 PCM)
  private ringBuffer: Int16Array;
  private ringWriteIndex = 0;
  private ringIsFull = false;

  constructor(callbacks: SleepDetectorCallbacks) {
    this.callbacks = callbacks;
    this.ringBuffer = new Int16Array(RING_BUFFER_CAPACITY);
  }

  get state(): SleepState {
    return this._state;
  }

  /**
   * Process an audio chunk. Returns true if the audio should be sent to
   * Deepgram (active state), false if the detector is dozing and the audio
   * was captured in the ring buffer instead.
   */
  processAudio(pcmInt16: Int16Array): boolean {
    const rms = this.calculateRMS(pcmInt16);
    const isSilent = rms < SILENCE_RMS_THRESHOLD;

    if (this._state === 'active') {
      if (isSilent) {
        this.consecutiveLoudChunks = 0;
        if (this.silentSince === null) {
          this.silentSince = Date.now();
        } else if (Date.now() - this.silentSince >= SILENCE_TIMEOUT_MS) {
          this.enterDozing();
          this.writeRingBuffer(pcmInt16);
          return false;
        }
      } else {
        this.silentSince = null;
        this.consecutiveLoudChunks = 0;
      }
      return true;
    } else {
      // Dozing — capture in ring buffer
      this.writeRingBuffer(pcmInt16);

      if (!isSilent) {
        this.consecutiveLoudChunks++;
        if (this.consecutiveLoudChunks >= WAKE_CHUNKS_REQUIRED) {
          this.wake();
          return true;
        }
      } else {
        this.consecutiveLoudChunks = 0;
      }
      return false;
    }
  }

  /** Reset silence timer — call when a final transcript is received.
   *  Keeps the detector active as long as Deepgram is producing output. */
  onTranscriptReceived(): void {
    if (this._state === 'active') {
      this.silentSince = null;
    }
  }

  /** Full reset to active state. */
  reset(): void {
    this._state = 'active';
    this.silentSince = null;
    this.consecutiveLoudChunks = 0;
    this.resetRingBuffer();
  }

  // --- State transitions ---

  private enterDozing(): void {
    this._state = 'dozing';
    this.silentSince = null;
    this.consecutiveLoudChunks = 0;
    this.resetRingBuffer();
    console.log(`[SleepDetector] ENTER_DOZING — ${SILENCE_TIMEOUT_MS / 1000}s of silence detected`);
    this.callbacks.onStateChange('dozing');
    this.callbacks.onEnterDozing();
  }

  private wake(): void {
    const bufferedAudio = this.drainRingBuffer();
    this._state = 'active';
    this.silentSince = null;
    this.consecutiveLoudChunks = 0;
    console.log(
      `[SleepDetector] WAKE — speech detected, replaying ${bufferedAudio.byteLength} bytes`
    );
    this.callbacks.onStateChange('active');
    this.callbacks.onWake(bufferedAudio);
  }

  // --- RMS calculation ---

  private calculateRMS(samples: Int16Array): number {
    if (samples.length === 0) return 0;
    let sumSquares = 0;
    for (let i = 0; i < samples.length; i++) {
      sumSquares += samples[i] * samples[i];
    }
    return Math.sqrt(sumSquares / samples.length);
  }

  // --- Ring buffer ---

  private writeRingBuffer(pcmInt16: Int16Array): void {
    for (let i = 0; i < pcmInt16.length; i++) {
      this.ringBuffer[this.ringWriteIndex] = pcmInt16[i];
      this.ringWriteIndex++;
      if (this.ringWriteIndex >= RING_BUFFER_CAPACITY) {
        this.ringWriteIndex = 0;
        this.ringIsFull = true;
      }
    }
  }

  private drainRingBuffer(): ArrayBuffer {
    let sampleCount: number;
    let startIndex: number;

    if (this.ringIsFull) {
      sampleCount = RING_BUFFER_CAPACITY;
      startIndex = this.ringWriteIndex; // oldest sample when full
    } else {
      sampleCount = this.ringWriteIndex;
      startIndex = 0;
    }

    if (sampleCount === 0) return new ArrayBuffer(0);

    const result = new Int16Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      result[i] = this.ringBuffer[(startIndex + i) % RING_BUFFER_CAPACITY];
    }

    this.resetRingBuffer();
    return result.buffer;
  }

  private resetRingBuffer(): void {
    this.ringWriteIndex = 0;
    this.ringIsFull = false;
  }
}
