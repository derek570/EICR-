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
   * Drain the buffer as Float32Array, oldest samples first.
   * Returns raw Float32 samples so the caller can apply resampling
   * before converting to Int16 and sending to Deepgram.
   * Resets the buffer after draining.
   */
  drain(): Float32Array {
    if (!this.filled && this.writePos === 0) {
      return new Float32Array(0);
    }

    let result: Float32Array;
    if (this.filled) {
      // Buffer has wrapped — read from writePos to end, then start to writePos
      result = new Float32Array(this.buffer.length);
      const tail = this.buffer.length - this.writePos;
      result.set(this.buffer.subarray(this.writePos), 0);
      result.set(this.buffer.subarray(0, this.writePos), tail);
    } else {
      // Buffer hasn't wrapped yet
      result = this.buffer.slice(0, this.writePos);
    }

    this.reset();
    return result;
  }

  reset(): void {
    this.writePos = 0;
    this.filled = false;
  }
}
