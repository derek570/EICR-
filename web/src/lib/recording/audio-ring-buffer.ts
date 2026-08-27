/**
 * Rolling ~3-second window of TAGGED captured PCM. Port of iOS
 * `AudioRingBuffer.swift`, widened for PLAN-E1.
 *
 * Captures the last ~3 seconds of 16kHz mono mic audio so that when the
 * `SleepManager` wakes the stream (or a reconnect completes), the words
 * spoken _just before_ can be replayed to Deepgram — otherwise the first
 * sentence after wake/reconnect is always half-missing.
 *
 * PLAN-E1 (Codex diff-review r1 BLOCKER fix): this buffer now stores
 * ALREADY-TAGGED `CapturedPcmSegment`s rather than raw Int16 samples.
 * The prior raw-Int16 design forced `drain()`'s caller to mint a FRESH
 * capture range + epoch scope at replay time — but that range/scope is
 * genuinely WRONG for audio that was captured earlier (possibly under a
 * dead epoch, or before any epoch existed at all): it double-advances
 * the shared capture clock for physically-identical audio and mislabels
 * gap-period audio as live under whatever epoch happens to be current
 * at replay time. Storing the ORIGINAL tag — assigned once, at genuine
 * capture time, by `capture-tagging.ts` — and handing it back unchanged
 * on drain is what the "no restamping" invariant requires. Eviction is
 * by total sample count across the queued segments rather than a
 * physical circular byte array, since segment sizes vary with the
 * mic's actual block size.
 */
import type { CapturedPcmSegment } from './tagged-pcm-segment';

export class AudioRingBuffer {
  readonly capacitySamples: number;
  private segments: CapturedPcmSegment[] = [];
  private totalSamples = 0;

  constructor(durationSec: number = 3, sampleRate: number = 16000) {
    this.capacitySamples = Math.floor(durationSec * sampleRate);
  }

  /** Append an already-tagged segment. Older segments are evicted (whole
   *  segments, oldest first) once the rolling window's total sample
   *  count exceeds capacity. A single segment larger than capacity is
   *  still retained in full (never split) rather than losing its tag. */
  writeTagged(segment: CapturedPcmSegment): void {
    if (segment.samples.length === 0) return;
    this.segments.push(segment);
    this.totalSamples += segment.samples.length;
    while (this.totalSamples > this.capacitySamples && this.segments.length > 1) {
      const dropped = this.segments.shift();
      if (dropped) this.totalSamples -= dropped.samples.length;
    }
  }

  /** Snapshot + clear the rolling window, oldest first, WITHOUT altering
   *  any segment's original tag. */
  drainTagged(): CapturedPcmSegment[] {
    const out = this.segments;
    this.segments = [];
    this.totalSamples = 0;
    return out;
  }

  reset(): void {
    this.segments = [];
    this.totalSamples = 0;
  }

  /** Total sample count currently held across all queued segments. */
  get size(): number {
    return this.totalSamples;
  }
}
