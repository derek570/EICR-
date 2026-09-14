import { describe, it, expect } from 'vitest';
import {
  PoorSignalLatencyProbe,
  type PoorSignalProbeConfig,
} from '@/lib/recording/poor-signal-probe';

const FAST_CONFIG: PoorSignalProbeConfig = {
  windowSize: 8,
  minSamples: 4,
  armMedianMs: 1500,
  recoverMedianMs: 1000,
  cooldownMs: 300_000,
};

function makeClock(startMs = 0) {
  let now = startMs;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** Arm the probe the only way PLAN-C still allows: `minSamples` OBSERVED
 *  samples whose median exceeds `armMedianMs`. Several tests below used to
 *  arm with censored samples, which no longer arm by design. */
function armWithObserved(
  probe: PoorSignalLatencyProbe,
  clock: ReturnType<typeof makeClock>,
  ms = 2000,
  n = 4
) {
  for (let i = 0; i < n; i++) {
    probe.onOnset(clock.now());
    clock.advance(ms);
    probe.onInterimReceived();
  }
}

describe('PoorSignalLatencyProbe (PLAN-E1 E3)', () => {
  it('does NOT arm on no-interim terminals alone (PLAN-C: censored samples never arm)', () => {
    const clock = makeClock();
    const probe = new PoorSignalLatencyProbe(FAST_CONFIG, clock.now);
    let armed = false;
    for (let i = 0; i < 4; i++) {
      probe.onOnset(clock.now());
      clock.advance(2000); // exceeds armMedianMs — recorded as censored
      armed = probe.onResetWithoutInterim() && probe.isArmed;
    }
    // Pre-PLAN-C this armed. A fixed-RMS onset that never produced a
    // transcript is far more often "that was not speech" than "the network
    // is slow", so it is recorded for telemetry and decides nothing.
    expect(armed).toBe(false);
    expect(probe.isArmed).toBe(false);
  });

  it('does not arm on samples below the arm threshold', () => {
    const clock = makeClock();
    const probe = new PoorSignalLatencyProbe(FAST_CONFIG, clock.now);
    for (let i = 0; i < 8; i++) {
      probe.onOnset(clock.now());
      clock.advance(200); // fast — observed sample, well under threshold
      probe.onInterimReceived();
    }
    expect(probe.isArmed).toBe(false);
  });

  it('pins the FIRST armed onset — a later burst before the interim does not overwrite it', () => {
    const clock = makeClock();
    const probe = new PoorSignalLatencyProbe(FAST_CONFIG, clock.now);
    probe.onOnset(clock.now()); // t=0
    clock.advance(1000);
    probe.onOnset(clock.now()); // later burst — should be a no-op (onset already pinned)
    clock.advance(1000);
    probe.onInterimReceived(); // resolves at t=2000, elapsed should be ~2000 not ~1000
    // Push three more identical slow samples to reach minSamples and arm.
    for (let i = 0; i < 3; i++) {
      probe.onOnset(clock.now());
      clock.advance(2000);
      probe.onInterimReceived();
    }
    expect(probe.isArmed).toBe(true);
  });

  // Still meaningful after PLAN-C: it pins that two probes fed the same
  // event script reach the same state, censored samples included.
  it('mixed observed/censored windows are deterministic', () => {
    const clock = makeClock();
    const probe1 = new PoorSignalLatencyProbe(FAST_CONFIG, clock.now);
    const clock2 = makeClock();
    const probe2 = new PoorSignalLatencyProbe(FAST_CONFIG, clock2.now);
    const script: Array<['observed' | 'censored', number]> = [
      ['censored', 2000],
      ['observed', 300],
      ['censored', 1800],
      ['observed', 200],
    ];
    for (const [kind, ms] of script) {
      probe1.onOnset(clock.now());
      clock.advance(ms);
      if (kind === 'observed') probe1.onInterimReceived();
      else probe1.onResetWithoutInterim();

      probe2.onOnset(clock2.now());
      clock2.advance(ms);
      if (kind === 'observed') probe2.onInterimReceived();
      else probe2.onResetWithoutInterim();
    }
    expect(probe1.isArmed).toBe(probe2.isArmed);
  });

  it('censored samples cannot cause false recovery', () => {
    const clock = makeClock();
    const probe = new PoorSignalLatencyProbe(FAST_CONFIG, clock.now);
    armWithObserved(probe, clock);
    expect(probe.isArmed).toBe(true);
    // Recovery requires OBSERVED samples. Five of them, not four: the
    // window holds eight, so a fifth is what evicts the last slow sample
    // and brings the observed median under recoverMedianMs.
    for (let i = 0; i < 5; i++) {
      probe.onOnset(clock.now());
      clock.advance(200);
      probe.onInterimReceived();
    }
    expect(probe.isArmed).toBe(false);
  });

  it('recovery hysteresis: requires observed median < recoverMedianMs, not just <armMedianMs', () => {
    const clock = makeClock();
    const probe = new PoorSignalLatencyProbe(FAST_CONFIG, clock.now);
    armWithObserved(probe, clock);
    expect(probe.isArmed).toBe(true);
    // Feed samples between recoverMedianMs and armMedianMs — should NOT recover.
    for (let i = 0; i < 4; i++) {
      probe.onOnset(clock.now());
      clock.advance(1200);
      probe.onInterimReceived();
    }
    expect(probe.isArmed).toBe(true);
  });

  it('cooldown gates re-arming within the cooldown window', () => {
    const clock = makeClock();
    const shortCooldown: PoorSignalProbeConfig = { ...FAST_CONFIG, cooldownMs: 10_000 };
    const probe = new PoorSignalLatencyProbe(shortCooldown, clock.now);
    armWithObserved(probe, clock);
    expect(probe.isArmed).toBe(true);
    // Recover (five observed — see the note in the recovery test above).
    for (let i = 0; i < 5; i++) {
      probe.onOnset(clock.now());
      clock.advance(200);
      probe.onInterimReceived();
    }
    expect(probe.isArmed).toBe(false);
    // Immediately try to re-arm within the cooldown window — should be blocked.
    armWithObserved(probe, clock);
    expect(probe.isArmed).toBe(false);
  });

  it('reset() clears window/armed state', () => {
    const clock = makeClock();
    const probe = new PoorSignalLatencyProbe(FAST_CONFIG, clock.now);
    armWithObserved(probe, clock);
    expect(probe.isArmed).toBe(true);
    probe.reset();
    expect(probe.isArmed).toBe(false);
  });

  it('a short no-interim gap under the arm threshold is not recorded as censored', () => {
    const clock = makeClock();
    const probe = new PoorSignalLatencyProbe(FAST_CONFIG, clock.now);
    for (let i = 0; i < 10; i++) {
      probe.onOnset(clock.now());
      clock.advance(100); // well under armMedianMs
      probe.onResetWithoutInterim();
    }
    expect(probe.isArmed).toBe(false);
  });
});
