/**
 * PLAN-E1 (split-round-13 BLOCKER) — the TAGGED PCM SEGMENT carrier.
 *
 * Every PCM range that reaches the sender — live capture AND every replay
 * source — is tagged BEFORE it is queued, so range/scope attribution
 * survives batching, reconnect queuing, and replay. Buffers store RAW PCM;
 * encoding happens at SEND time inside the sender.
 *
 * The carrier's origin is discriminated (split-round-27 IMPORTANT): the
 * nova-3 500ms keepalive silence is SYNTHETIC PCM minted inside the
 * service with no tap-derived capture range — inventing one would corrupt
 * capture-vs-dispatched offset accounting. `captured` segments carry the
 * full tag set; `synthetic` segments carry recordingSessionId + epochScope
 * but NO capture range, are excluded from VAD/materiality/loss-source
 * accounting, and still advance the dispatched-stream offset.
 */

import type { EpochScope } from './uplink-scope-allocator';

/** Half-open 16kHz sample range `[start, end)` in the CAPTURE domain (the
 *  mic tap's own running sample count for this recording session — NOT
 *  the dispatched/vendor-time domain). */
export interface CaptureSampleRange {
  readonly start: number;
  readonly end: number;
}

export interface CapturedPcmSegment {
  readonly origin: 'captured';
  readonly samples: Int16Array;
  readonly recordingSessionId: string;
  readonly captureSampleRange: CaptureSampleRange;
  readonly epochScope: EpochScope;
}

/** Keepalive silence only. No capture range — this PCM was never captured. */
export interface SyntheticPcmSegment {
  readonly origin: 'synthetic';
  readonly samples: Int16Array;
  readonly recordingSessionId: string;
  readonly epochScope: EpochScope;
}

export type TaggedPcmSegment = CapturedPcmSegment | SyntheticPcmSegment;

export function captureRangeLength(range: CaptureSampleRange): number {
  return Math.max(0, range.end - range.start);
}

/**
 * Splits a tagged segment's underlying samples at absolute sample-count
 * boundaries within its OWN capture range. Used by batching logic that
 * must never fuse two different metadata scopes into one WS send —
 * batching SPLITS at metadata boundaries; a batch never spans two scopes.
 * No-op passthrough for synthetic segments (they are never split — a
 * keepalive send is a single fixed-size frame).
 */
export function splitCapturedSegment(
  segment: CapturedPcmSegment,
  atSampleOffset: number
): [CapturedPcmSegment, CapturedPcmSegment] {
  const localIdx = atSampleOffset - segment.captureSampleRange.start;
  if (localIdx <= 0 || localIdx >= segment.samples.length) {
    throw new RangeError('splitCapturedSegment: split point outside segment bounds');
  }
  const left: CapturedPcmSegment = {
    ...segment,
    samples: segment.samples.subarray(0, localIdx),
    captureSampleRange: { start: segment.captureSampleRange.start, end: atSampleOffset },
  };
  const right: CapturedPcmSegment = {
    ...segment,
    samples: segment.samples.subarray(localIdx),
    captureSampleRange: { start: atSampleOffset, end: segment.captureSampleRange.end },
  };
  return [left, right];
}
