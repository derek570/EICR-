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
 * be larger). They are still recorded, and since PLAN-C they no longer
 * take part in EITHER decision (see `reevaluate`).
 *
 * PLAN-C (2026-09-14) — the advisory fired three times in a 25-minute
 * session on home Wi-Fi while transcription was fast, because of what the
 * state machine was fed rather than how it decided. Two changes:
 *
 *  1. Censored samples no longer arm. A lower-bound median above the
 *     threshold is sound arithmetic about a quantity nobody measured: the
 *     detector is a fixed RMS threshold, so "an onset with no transcript
 *     after 1.5 s" far more often means "that was not speech" than "the
 *     network is slow". Arm and recover are now symmetric — both decide on
 *     observed samples only, and both need `minSamples` of them.
 *  2. `discardPendingOnset()` lets a caller invalidate a pending window
 *     while pushing NOTHING. Web's TTS-start handler uses it: it pauses the
 *     uplink, and an onset armed just before that pause would otherwise
 *     resolve against an interim on the far side and carry the whole pause
 *     duration as network latency.
 *
 * Both clients correlate a pending onset with the SOCKET it was armed
 * under. The PAUSE half of iOS's scope is the one thing web omits: its
 * shared VAD is starved of samples while TTS plays (`voiced-activity.ts`,
 * `recording-context.tsx`'s `onSamples` gate), so no onset can be armed
 * DURING a pause here and there is no pause to straddle that the discard
 * does not already remove. That one difference is the recorded deliberate
 * divergence — see the `recording/poor-signal-probe` parity-ledger row.
 */

import type { ConnectionEpoch } from './uplink-scope-allocator';

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

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export class PoorSignalLatencyProbe {
  /** The DECISION window: OBSERVED samples only.
   *
   *  Review found the first cut of this fix could silence a genuine
   *  warning. Censored entries shared these `windowSize` slots while being
   *  excluded from both decisions, so on a bad link — where onsets that
   *  never produce a transcript are COMMON — they evicted the observed
   *  evidence and `observed.length >= minSamples` was never reached. A
   *  steady one-observed-to-two-censored stream left at most three observed
   *  samples in any window of eight, and a genuinely slow link never armed;
   *  the same eviction could strand an already armed probe, unable to
   *  recover. Censored entries therefore no longer live here at all. */
  private window: number[] = [];
  /** Censored lower bounds, kept for telemetry ONLY and never consulted by
   *  `reevaluate`. Bounded by the same `windowSize`. */
  private censoredWindow: number[] = [];
  private armedOnsetAtMs: number | null = null;
  /** PLAN-C — the epoch of the socket the pending onset was armed under.
   *  Web has no pause generation (its VAD is starved during TTS, so no onset
   *  can be armed inside a pause), but it DOES need socket identity: this
   *  probe is session-scoped while `DeepgramService` instances are not, and
   *  `disconnect()` deliberately keeps the outgoing socket alive for 300 ms.
   *  A trailing interim from the outgoing service could otherwise resolve an
   *  onset armed under its replacement. */
  private armedOnsetEpoch: ConnectionEpoch | null = null;
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
  onOnset(capturedAt: number, epoch: ConnectionEpoch | null = null): void {
    if (this.armedOnsetAtMs === null) {
      this.armedOnsetAtMs = capturedAt;
      this.armedOnsetEpoch = epoch;
    }
  }

  /** The first interim (or final) transcript arrived. Resolves the
   *  pending sample as OBSERVED. Returns true iff the armed state
   *  CHANGED (arm↔recover) this call. */
  onInterimReceived(epoch: ConnectionEpoch | null = null): boolean {
    if (this.armedOnsetAtMs === null) return false;
    const onsetAtMs = this.armedOnsetAtMs;
    const onsetEpoch = this.armedOnsetEpoch;
    this.armedOnsetAtMs = null;
    this.armedOnsetEpoch = null;
    // PLAN-C — an interim delivered by a DIFFERENT socket than the one the
    // onset was armed under does not measure that onset. Drop it; push
    // nothing, for the same reason a straddling window is dropped rather
    // than censored.
    if (epoch !== onsetEpoch) return false;
    const elapsedMs = this.nowFn() - onsetAtMs;
    // A negative interval is not a measurement.
    if (elapsedMs < 0) return false;
    return this.pushObservedAndReevaluate(elapsedMs);
  }

  /** Utterance-end / reconnect / pause fired with NO interim received
   *  since the last onset. A CENSORED sample is recorded only if the
   *  armed age already exceeds the arm threshold (a short, unremarkable
   *  gap is not evidence of anything). Returns true iff the armed state
   *  changed this call.
   *
   *  PLAN-C — still recorded, and no longer able to arm. */
  onResetWithoutInterim(): boolean {
    if (this.armedOnsetAtMs === null) return false;
    const ageMs = this.nowFn() - this.armedOnsetAtMs;
    this.armedOnsetAtMs = null;
    this.armedOnsetEpoch = null;
    if (ageMs < this.config.armMedianMs) return false;
    this.censoredWindow.push(ageMs);
    if (this.censoredWindow.length > this.config.windowSize) this.censoredWindow.shift();
    // Always false since PLAN-C: a censored sample takes no part in either
    // decision, so it can never change the armed state.
    return false;
  }

  /** PLAN-C — clear the pending onset and push NOTHING: the drop-only
   *  counterpart to `onResetWithoutInterim`, for a caller that knows the
   *  pending window is about to be invalidated and must not leave a
   *  censored stand-in behind. Censoring would not do: the arm decision
   *  medians across the window, so a stand-in carries the same poison it
   *  was meant to remove. */
  discardPendingOnset(): void {
    this.armedOnsetAtMs = null;
    this.armedOnsetEpoch = null;
  }

  /** Test/diagnostic visibility into the decision window's real occupancy,
   *  so a test can distinguish "nothing was pushed" from "something was
   *  pushed that the filter happens to ignore". */
  get observedSampleCount(): number {
    return this.window.length;
  }

  get censoredSampleCount(): number {
    return this.censoredWindow.length;
  }

  private pushObservedAndReevaluate(ms: number): boolean {
    this.window.push(ms);
    if (this.window.length > this.config.windowSize) this.window.shift();
    return this.reevaluate();
  }

  /** PLAN-C — arm and recover are SYMMETRIC: both decide on OBSERVED
   *  samples only, and both need `minSamples` of them.
   *
   *  The count gate moved with the decision. It used to require
   *  `minSamples` samples of ANY kind before computing the arm median, so
   *  excluding censored samples from the median alone would have left a
   *  window of four censored samples able to satisfy the gate and then
   *  median nothing. */
  private reevaluate(): boolean {
    const wasArmed = this.armed;
    if (this.window.length < this.config.minSamples) return false;
    const observedMedian = median(this.window);

    if (!this.armed) {
      if (observedMedian > this.config.armMedianMs) {
        const now = this.nowFn();
        if (now - this.lastArmedAtMs >= this.config.cooldownMs) {
          this.armed = true;
          this.lastArmedAtMs = now;
        }
      }
    } else if (observedMedian < this.config.recoverMedianMs) {
      this.armed = false;
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
    this.censoredWindow = [];
    this.armedOnsetAtMs = null;
    this.armedOnsetEpoch = null;
    this.armed = false;
    this.lastArmedAtMs = -Infinity;
  }
}
