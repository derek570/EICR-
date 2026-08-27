/**
 * PLAN-E1 E3 — the client-local poor-signal LATENCY probe. Web's
 * equivalent of iOS's `NETWORK_LATENCY_PROBE` wrap: measures onset→first-
 * interim latency via the shared `VoicedActivityDetector`'s onset
 * transition (E1's own first consumer of that primitive) and arms/
 * disarms a spoken advisory off a rolling median.
 *
 * Onset semantics (round-10 IMPORTANT): the FIRST armed onset is pinned
 * until the first interim arrives or an explicit terminal fires (never
 * overwritten by a later voiced burst while still awaiting the interim) —
 * under exactly the degraded conditions being detected, overwriting would
 * pair a delayed interim with a LATER onset and under-report latency.
 *
 * Censored samples (round-11): when a reset (utterance-end / reconnect /
 * pause) fires with NO interim received and the armed age exceeds the arm
 * threshold, a CENSORED sample is recorded — its value is a conservative
 * LOWER BOUND (the true latency, had the interim ever arrived, could only
 * be larger). The rolling median used to ARM uses lower-bound values for
 * every sample (a lower-bound median above the threshold still proves the
 * true median is above it); the median used to RECOVER uses ONLY observed
 * samples (a lower bound can never prove recovery — the true value might
 * still be arbitrarily large).
 */

export type ProbeSample =
  | { readonly kind: 'observed'; readonly ms: number }
  | { readonly kind: 'censored'; readonly lowerBoundMs: number };

export interface PoorSignalProbeConfig {
  readonly windowSize: number;
  readonly minSamples: number;
  readonly armMedianMs: number;
  readonly recoverMedianMs: number;
  readonly cooldownMs: number;
}

export const DEFAULT_POOR_SIGNAL_PROBE_CONFIG: PoorSignalProbeConfig = {
  windowSize: 8,
  minSamples: 4,
  armMedianMs: 1500,
  recoverMedianMs: 1000,
  cooldownMs: 5 * 60 * 1000,
};

function sampleLowerBound(s: ProbeSample): number {
  return s.kind === 'observed' ? s.ms : s.lowerBoundMs;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export class PoorSignalLatencyProbe {
  private window: ProbeSample[] = [];
  private armedOnsetAtMs: number | null = null;
  private armed = false;
  private lastArmedAtMs = -Infinity;

  constructor(
    private readonly config: PoorSignalProbeConfig = DEFAULT_POOR_SIGNAL_PROBE_CONFIG,
    private readonly nowFn: () => number = () => performance.now()
  ) {}

  /** The shared VAD's onset transition. Pins the FIRST onset since the
   *  last interim/terminal — a later burst before an interim arrives is a
   *  no-op.
   *
   *  `capturedAt` (PLAN-E1B2 item 3) is the transition's OWN ingress
   *  timestamp — the same clock (`performance.now()`, via this probe's
   *  injectable `nowFn`) stamped by the caller at the frame's true capture
   *  instant, never a later time read at the moment `onOnset` happens to
   *  be invoked (a queue hop between capture and VAD processing must not
   *  be misread as capture latency). */
  onOnset(capturedAt: number): void {
    if (this.armedOnsetAtMs === null) {
      this.armedOnsetAtMs = capturedAt;
    }
  }

  /** The first interim (or final) transcript arrived. Resolves the
   *  pending sample as OBSERVED. Returns true iff the armed state
   *  CHANGED (arm↔recover) this call. */
  onInterimReceived(): boolean {
    if (this.armedOnsetAtMs === null) return false;
    const elapsedMs = this.nowFn() - this.armedOnsetAtMs;
    this.armedOnsetAtMs = null;
    return this.pushAndReevaluate({ kind: 'observed', ms: elapsedMs });
  }

  /** Utterance-end / reconnect / pause fired with NO interim received
   *  since the last onset. A CENSORED sample is recorded only if the
   *  armed age already exceeds the arm threshold (a short, unremarkable
   *  gap is not evidence of anything). Returns true iff the armed state
   *  changed this call. */
  onResetWithoutInterim(): boolean {
    if (this.armedOnsetAtMs === null) return false;
    const ageMs = this.nowFn() - this.armedOnsetAtMs;
    this.armedOnsetAtMs = null;
    if (ageMs < this.config.armMedianMs) return false;
    return this.pushAndReevaluate({ kind: 'censored', lowerBoundMs: ageMs });
  }

  private pushAndReevaluate(sample: ProbeSample): boolean {
    this.window.push(sample);
    if (this.window.length > this.config.windowSize) this.window.shift();
    return this.reevaluate();
  }

  private reevaluate(): boolean {
    if (this.window.length < this.config.minSamples) return false;
    const wasArmed = this.armed;

    if (!this.armed) {
      const lowerBoundMedian = median(this.window.map(sampleLowerBound));
      if (lowerBoundMedian > this.config.armMedianMs) {
        const now = this.nowFn();
        if (now - this.lastArmedAtMs >= this.config.cooldownMs) {
          this.armed = true;
          this.lastArmedAtMs = now;
        }
      }
    } else {
      // Recovery hysteresis: censored samples never count — recompute
      // using ONLY observed samples.
      const observed = this.window.filter(
        (s): s is Extract<ProbeSample, { kind: 'observed' }> => s.kind === 'observed'
      );
      if (observed.length >= this.config.minSamples) {
        const observedMedian = median(observed.map((s) => s.ms));
        if (observedMedian < this.config.recoverMedianMs) {
          this.armed = false;
        }
      }
    }
    return this.armed !== wasArmed;
  }

  get isArmed(): boolean {
    return this.armed;
  }

  /** Reset ONLY at recording-session boundaries (mirrors the VAD/allocator
   *  reset discipline) — never on a reconnect, which is one of the reset
   *  TRIGGERS this probe listens for, not a probe-state boundary. */
  reset(): void {
    this.window = [];
    this.armedOnsetAtMs = null;
    this.armed = false;
    this.lastArmedAtMs = -Infinity;
  }
}
