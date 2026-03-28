/**
 * Circular buffer storing Float32 PCM samples.
 * Port of iOS AudioRingBuffer.swift.
 * Default: 3 seconds at 16kHz = 48000 samples.
 *
 * Supports resampling on drain — if the actual AudioContext sample rate
 * differs from Deepgram's expected 16kHz, drain() resamples so replayed
 * audio matches what Deepgram expects.
 */
export class AudioRingBuffer {
  private buffer: Float32Array;
  private writeIndex = 0;
  private isFull = false;
  readonly capacity: number;

  /** The actual sample rate of audio being written (may differ from 16kHz on mobile). */
  private _inputSampleRate: number;
  /** The target sample rate for drain output (Deepgram expects 16kHz). */
  private static readonly TARGET_SAMPLE_RATE = 16000;

  constructor(durationSeconds = 3.0, sampleRate = 16000) {
    this._inputSampleRate = sampleRate;
    this.capacity = Math.floor(durationSeconds * sampleRate);
    this.buffer = new Float32Array(this.capacity);
  }

  /** Update the input sample rate (call when AudioContext sample rate is known). */
  setInputSampleRate(rate: number): void {
    if (rate !== this._inputSampleRate) {
      // Resize buffer to hold the same duration at the new rate
      const durationSeconds = this.capacity / this._inputSampleRate;
      this._inputSampleRate = rate;
      const newCapacity = Math.floor(durationSeconds * rate);
      if (newCapacity !== this.capacity) {
        (this as { capacity: number }).capacity = newCapacity;
        this.buffer = new Float32Array(newCapacity);
        this.writeIndex = 0;
        this.isFull = false;
      }
    }
  }

  write(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      this.buffer[this.writeIndex] = samples[i];
      this.writeIndex++;
      if (this.writeIndex >= this.capacity) {
        this.writeIndex = 0;
        this.isFull = true;
      }
    }
  }

  /**
   * Drain the buffer as Int16 PCM at 16kHz, oldest samples first.
   * If the input sample rate differs from 16kHz, resamples via linear interpolation.
   * Converts Float32 [-1, 1] to Int16 [-32767, 32767].
   * Resets the buffer after draining.
   */
  drain(): ArrayBuffer {
    let sampleCount: number;
    let startIndex: number;

    if (this.isFull) {
      sampleCount = this.capacity;
      startIndex = this.writeIndex; // oldest sample is at writeIndex when full
    } else {
      sampleCount = this.writeIndex;
      startIndex = 0;
    }

    if (sampleCount === 0) {
      this.reset();
      return new ArrayBuffer(0);
    }

    // Extract Float32 samples in order (oldest first)
    const float32 = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      const idx = (startIndex + i) % this.capacity;
      float32[i] = this.buffer[idx];
    }

    // Resample if needed (e.g., 48kHz → 16kHz)
    let resampled: Float32Array = float32;
    if (this._inputSampleRate !== AudioRingBuffer.TARGET_SAMPLE_RATE) {
      resampled = this.resample(float32, this._inputSampleRate, AudioRingBuffer.TARGET_SAMPLE_RATE);
    }

    // Convert Float32 → Int16 PCM
    const int16 = new Int16Array(resampled.length);
    for (let i = 0; i < resampled.length; i++) {
      const clamped = Math.max(-1, Math.min(1, resampled[i]));
      int16[i] = Math.round(clamped * 32767);
    }

    this.reset();
    return int16.buffer;
  }

  reset(): void {
    this.writeIndex = 0;
    this.isFull = false;
  }

  /** Linear-interpolation resample (same algorithm as DeepgramService). */
  private resample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
    const ratio = fromRate / toRate;
    const newLength = Math.round(samples.length / ratio);
    const result = new Float32Array(newLength);

    for (let i = 0; i < newLength; i++) {
      const srcIndex = i * ratio;
      const low = Math.floor(srcIndex);
      const high = Math.min(low + 1, samples.length - 1);
      const frac = srcIndex - low;
      result[i] = samples[low] * (1 - frac) + samples[high] * frac;
    }

    return result;
  }
}
