/**
 * PLAN-E1 — the shared `VoicedActivityDetector`. E1 owns and hooks it at
 * the capture loop; PLAN-E2 consumes exactly this contract for its
 * materiality gate and parked-playback gate (merge order E1 → E2 makes it
 * exist before E2 needs it). E1's own poor-signal latency probe (E3) is
 * its first consumer.
 *
 * Contract (fixed at split round 4 — this is an EXECUTABLE INTERFACE, not
 * just a module location):
 *  - INPUTS: 16k mono PCM frames tagged with (captureSampleRange,
 *    recordingSessionId, epochScope).
 *  - OUTPUTS: (i) per-capture-range VOICED classification (the
 *    materiality primitive), (ii) debounced LOCAL-SPEAKING transitions
 *    (onset/silence — the parking primitive and E3's own probe onset),
 *    (iii) a synchronous `classifySnapshot(pcm)` for loss-report
 *    snapshots.
 *  - RULES: voiced/local-speaking STATE is RECORDING-SESSION-scoped and
 *    CONTINUOUS across socket epochs (an epoch reset would clear the
 *    debounced speaking state exactly when a reconnect-triggered
 *    disclosure releases, letting a clip start over an inspector who
 *    began speaking before the open) — the detector resets ONLY at
 *    session boundaries, while ledger ATTRIBUTION still rotates per epoch
 *    via the range tags carried alongside each classification; receives
 *    NO samples while TTS is active (the capture-loop caller is
 *    responsible for that early-return — the detector is blind during
 *    playback and must gate on the LAST pre-playback transition);
 *    thresholds/debounce constants live in ONE place (below).
 */

import type { EpochScope } from './uplink-scope-allocator';
import type { CaptureSampleRange } from './tagged-pcm-segment';

export const VAD_SAMPLE_RATE_HZ = 16000;
/** RMS (int16 magnitude) above which a frame is classified voiced. Tuned
 *  generously low so genuine speech at typical mic gain is never
 *  misclassified as silence — false negatives here would silently exclude
 *  real dictation from materiality/parking accounting. */
export const VAD_ENERGY_RMS_THRESHOLD = 350;
/** Debounce: local-speaking flips to silence only after this much
 *  continuous sub-threshold audio, so a brief pause mid-sentence doesn't
 *  toggle the parking primitive. */
export const VAD_SILENCE_HOLD_MS = 500;
export const VAD_SILENCE_HOLD_SAMPLES = Math.round(
  (VAD_SILENCE_HOLD_MS / 1000) * VAD_SAMPLE_RATE_HZ
);

export interface VoicedRangeClassification {
  readonly captureSampleRange: CaptureSampleRange;
  readonly epochScope: EpochScope;
  readonly voiced: boolean;
}

export type LocalSpeakingTransition =
  | { readonly kind: 'onset'; readonly atSampleOffset: number }
  | { readonly kind: 'silence'; readonly atSampleOffset: number };

/** Pure, stateless RMS-energy classifier — also the synchronous
 *  `classifySnapshot` implementation, exported standalone so a
 *  loss-report snapshot can be classified without touching detector
 *  state. */
export function classifyPcmEnergy(samples: Int16Array): boolean {
  if (samples.length === 0) return false;
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    sumSquares += s * s;
  }
  const rms = Math.sqrt(sumSquares / samples.length);
  return rms >= VAD_ENERGY_RMS_THRESHOLD;
}

export class VoicedActivityDetector {
  private speaking = false;
  // Running capture-domain sample offset of the end of the most recent
  // voiced frame. -Infinity until the first voiced frame arrives so an
  // all-silence session never spuriously debounces into "speaking".
  private lastVoicedEndOffset = -Infinity;

  constructor(private readonly onTransition: (t: LocalSpeakingTransition) => void) {}

  /**
   * Feed one CAPTURED frame (never call with a synthetic/keepalive
   * segment — those carry no capture range and are excluded from
   * materiality accounting by construction). Returns this range's voiced
   * classification and may synchronously emit a debounced onset/silence
   * transition via the constructor callback.
   */
  processFrame(
    samples: Int16Array,
    captureSampleRange: CaptureSampleRange,
    epochScope: EpochScope
  ): VoicedRangeClassification {
    const voiced = classifyPcmEnergy(samples);
    if (voiced) {
      this.lastVoicedEndOffset = captureSampleRange.end;
      if (!this.speaking) {
        this.speaking = true;
        this.onTransition({ kind: 'onset', atSampleOffset: captureSampleRange.start });
      }
    } else if (this.speaking) {
      const silenceSamples = captureSampleRange.end - this.lastVoicedEndOffset;
      if (silenceSamples >= VAD_SILENCE_HOLD_SAMPLES) {
        this.speaking = false;
        this.onTransition({ kind: 'silence', atSampleOffset: captureSampleRange.end });
      }
    }
    return { captureSampleRange, epochScope, voiced };
  }

  /** The debounced local-speaking state — the parking primitive PLAN-E2's
   *  gate reads, and E3's own probe-onset consumer. */
  get isLocalSpeaking(): boolean {
    return this.speaking;
  }

  /** Synchronous, stateless classification for a loss-report snapshot —
   *  does not mutate detector state or affect debouncing. */
  classifySnapshot(samples: Int16Array): boolean {
    return classifyPcmEnergy(samples);
  }

  /** Reset ONLY at recording-session boundaries — never on an epoch
   *  rotation (reconnect), which would wrongly clear speaking state that
   *  must survive the socket change. */
  reset(): void {
    this.speaking = false;
    this.lastVoicedEndOffset = -Infinity;
  }
}
