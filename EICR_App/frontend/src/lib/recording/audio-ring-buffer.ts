/**
 * Circular buffer storing Float32 PCM samples.
 * Port of iOS AudioRingBuffer.swift.
 * Default: 3 seconds at 16kHz = 48000 samples.
 */
export class AudioRingBuffer {
  private buffer: Float32Array;
  private writeIndex = 0;
  private isFull = false;
  readonly capacity: number;

  constructor(durationSeconds = 3.0, sampleRate = 16000) {
    this.capacity = Math.floor(durationSeconds * sampleRate);
    this.buffer = new Float32Array(this.capacity);
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
   * Drain the buffer as Int16 PCM, oldest samples first.
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

    const int16 = new Int16Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      const idx = (startIndex + i) % this.capacity;
      const clamped = Math.max(-1, Math.min(1, this.buffer[idx]));
      int16[i] = Math.round(clamped * 32767);
    }

    this.reset();
    return int16.buffer;
  }

  reset(): void {
    this.writeIndex = 0;
    this.isFull = false;
  }
}
