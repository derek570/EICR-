/**
 * Fixed-size Int16 PCM ring buffer. Port of iOS `AudioRingBuffer.swift`.
 *
 * Captures the last ~3 seconds of 16kHz mono mic audio so that when the
 * `SleepManager` wakes the stream, the words spoken _just before_ VAD
 * detected speech can be replayed to Deepgram — otherwise the first
 * sentence after wake is always half-missing.
 *
 * The buffer stores Int16 samples (post-PCM conversion) rather than
 * Float32 so `drain()` can hand the chunk straight to
 * `DeepgramService.sendInt16PCM()` without an extra copy. Writes from
 * Float32 use the same clamp-and-scale as `deepgram-service.ts`.
 */

export class AudioRingBuffer {
  readonly capacity: number;
  private buffer: Int16Array;
  private writeIndex = 0;
  private isFull = false;

  constructor(durationSec: number = 3, sampleRate: number = 16000) {
    this.capacity = Math.floor(durationSec * sampleRate);
    this.buffer = new Int16Array(this.capacity);
  }

  /** Append Float32 samples, converting to Int16. Older samples are
   *  overwritten once the buffer is full. */
  writeFloat32(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      const clamped = Math.max(-1, Math.min(1, samples[i]));
      this.buffer[this.writeIndex] = Math.round(clamped * 32767);
      this.writeIndex++;
      if (this.writeIndex >= this.capacity) {
        this.writeIndex = 0;
        this.isFull = true;
      }
    }
  }

  /** Snapshot the entire buffer as a single Int16Array, oldest first,
   *  and reset. Returns a new array (safe to transfer/send). */
  drain(): Int16Array {
    const out = this.isFull ? new Int16Array(this.capacity) : new Int16Array(this.writeIndex);
    if (this.isFull) {
      // Oldest samples live from writeIndex to end, then 0 to writeIndex.
      out.set(this.buffer.subarray(this.writeIndex, this.capacity), 0);
      out.set(this.buffer.subarray(0, this.writeIndex), this.capacity - this.writeIndex);
    } else {
      out.set(this.buffer.subarray(0, this.writeIndex), 0);
    }
    this.writeIndex = 0;
    this.isFull = false;
    return out;
  }

  reset(): void {
    this.writeIndex = 0;
    this.isFull = false;
  }

  get size(): number {
    return this.isFull ? this.capacity : this.writeIndex;
  }
}
