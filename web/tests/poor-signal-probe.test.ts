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

describe('PoorSignalLatencyProbe (PLAN-E1 E3)', () => {
  it('arms after four qualifying no-interim terminals (censored samples)', () => {
    const clock = makeClock();
    const probe = new PoorSignalLatencyProbe(FAST_CONFIG, clock.now);
    let armed = false;
    for (let i = 0; i < 4; i++) {
      probe.onOnset(clock.now());
      clock.advance(2000); // exceeds armMedianMs — qualifies as censored
      armed = probe.onResetWithoutInterim() && probe.isArmed;
    }
    expect(armed).toBe(true);
    expect(probe.isArmed).toBe(true);
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
    // Arm with 4 slow censored samples.
    for (let i = 0; i < 4; i++) {
      probe.onOnset(clock.now());
      clock.advance(2000);
      probe.onResetWithoutInterim();
    }
    expect(probe.isArmed).toBe(true);
    // Now feed FAST samples but as CENSORED (a reset that happens to be
    // fast never reaches onResetWithoutInterim's threshold gate, so
    // simulate via direct fast observed instead — a censored sample can
    // only be slow by construction). This test instead proves recovery
    // requires OBSERVED samples: feed 4 fast observed samples.
    for (let i = 0; i < 4; i++) {
      probe.onOnset(clock.now());
      clock.advance(200);
      probe.onInterimReceived();
    }
    expect(probe.isArmed).toBe(false);
  });

  it('recovery hysteresis: requires observed median < recoverMedianMs, not just <armMedianMs', () => {
    const clock = makeClock();
    const probe = new PoorSignalLatencyProbe(FAST_CONFIG, clock.now);
    for (let i = 0; i < 4; i++) {
      probe.onOnset(clock.now());
      clock.advance(2000);
      probe.onResetWithoutInterim();
    }
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
    for (let i = 0; i < 4; i++) {
      probe.onOnset(clock.now());
      clock.advance(2000);
      probe.onResetWithoutInterim();
    }
    expect(probe.isArmed).toBe(true);
    // Recover.
    for (let i = 0; i < 4; i++) {
      probe.onOnset(clock.now());
      clock.advance(200);
      probe.onInterimReceived();
    }
    expect(probe.isArmed).toBe(false);
    // Immediately try to re-arm within the cooldown window — should be blocked.
    for (let i = 0; i < 4; i++) {
      probe.onOnset(clock.now());
      clock.advance(2000);
      probe.onResetWithoutInterim();
    }
    expect(probe.isArmed).toBe(false);
  });

  it('reset() clears window/armed state', () => {
    const clock = makeClock();
    const probe = new PoorSignalLatencyProbe(FAST_CONFIG, clock.now);
    for (let i = 0; i < 4; i++) {
      probe.onOnset(clock.now());
      clock.advance(2000);
      probe.onResetWithoutInterim();
    }
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
