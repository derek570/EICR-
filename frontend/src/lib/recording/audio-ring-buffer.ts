/**
 * Circular buffer storing Float32 PCM samples.
 * Port of standalone transcript app's AudioRingBuffer.
 * Default: 5 seconds at 16kHz = 80,000 samples.
 */
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
