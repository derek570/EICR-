import { createHash, type BinaryLike } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PoorSignalLatencyProbe,
  type PoorSignalProbeConfig,
} from '@/lib/recording/poor-signal-probe';

/**
 * PLAN-C — the poor-signal advisory must not fire on a healthy link.
 *
 * The fixture is the cross-platform contract: `config/poor-signal-probe-vectors.json`
 * here, a byte-identical copy at
 * `CertMateUnified/Tests/CertMateUnifiedTests/Fixtures/poor-signal-probe-vectors.json`,
 * with the same digest pinned on both sides and
 * `scripts/check-poor-signal-fixture-sync.sh` byte-comparing them.
 *
 * It is SYNTHETIC and says so in its own `$comment`. It is not a session
 * replay and must never be described as one: the backend strips every client
 * timestamp before logging, so the reported session's CloudWatch rows cannot
 * carry the intervals or the pause overlap a replay would need.
 */

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, '..', '..', 'config', 'poor-signal-probe-vectors.json');

type ProbeEvent = {
  kind: 'onset' | 'interim' | 'reset' | 'pause' | 'resume';
  t_ms: number;
  during_pause?: boolean;
};

type Fixture = {
  synthetic: true;
  not_a_session_replay: true;
  config: PoorSignalProbeConfig;
  clusters: { fast_ms: number[]; slow_ms: number[] };
  expected: {
    arm_transitions_after_fix: number;
    arm_transitions_before_fix: { ios: number; web: number };
  };
  events: ProbeEvent[];
};

const fixture = require('../../config/poor-signal-probe-vectors.json') as Fixture;

/** A settable virtual clock. The probe reads `nowFn()` for both elapsed
 *  time and the cooldown, so the harness pins it to each event's own
 *  timestamp before making the call. */
function makeClock(): { now: () => number; set: (ms: number) => void } {
  let current = 0;
  return {
    now: () => current,
    set: (ms: number) => {
      current = ms;
    },
  };
}

/**
 * Replay the fixture through web's REAL wiring.
 *
 * Two platform facts are modelled, and both are the recorded divergence
 * from iOS rather than a convenience:
 *  - `pause` maps to `discardPendingOnset()`, which is what the TTS-start
 *    handler in `recording-context.tsx` now calls before `pause()`.
 *  - onsets marked `during_pause` are SKIPPED, because web's shared VAD
 *    receives no samples while TTS plays, so the detector cannot observe
 *    the speaker echo at all.
 */
function replayWeb(events: readonly ProbeEvent[], config: PoorSignalProbeConfig): number {
  const clock = makeClock();
  const probe = new PoorSignalLatencyProbe(config, clock.now);
  let armTransitions = 0;
  for (const event of events) {
    if (event.kind === 'onset' && event.during_pause) continue;
    clock.set(event.t_ms);
    switch (event.kind) {
      case 'pause':
        probe.discardPendingOnset();
        break;
      case 'resume':
        break;
      case 'onset':
        probe.onOnset(event.t_ms);
        break;
      case 'interim':
        if (probe.onInterimReceived() && probe.isArmed) armTransitions += 1;
        break;
      case 'reset':
        if (probe.onResetWithoutInterim() && probe.isArmed) armTransitions += 1;
        break;
    }
  }
  return armTransitions;
}

describe('poor-signal probe fixture — cross-platform pins', () => {
  /** The iOS repo carries a byte-identical COPY whose XCTest asserts the
   *  SAME hex constant; changing either file alone fails one side. When the
   *  fixture legitimately changes: edit it, run
   *  `shasum -a 256 config/poor-signal-probe-vectors.json`, and update BOTH
   *  constants in the same coordinated change. */
  it('fixture bytes match the pinned cross-platform digest', () => {
    const digest = createHash('sha256')
      .update(readFileSync(FIXTURE_PATH) as unknown as BinaryLike)
      .digest('hex');
    expect(digest).toBe('5f00ba2af43f79dcf1a3921812f16e4475fab39f4f243021be8e49002b51c8da');
  });

  it('declares itself synthetic, so no reader mistakes it for a session replay', () => {
    expect(fixture.synthetic).toBe(true);
    expect(fixture.not_a_session_replay).toBe(true);
    expect(String((fixture as unknown as { $comment: string }).$comment)).toContain(
      'NOT A SESSION REPLAY'
    );
  });

  it('reproduces the observed bimodal split', () => {
    expect(Math.min(...fixture.clusters.fast_ms)).toBe(3);
    expect(Math.max(...fixture.clusters.fast_ms)).toBe(124);
    expect(Math.min(...fixture.clusters.slow_ms)).toBe(2630);
    expect(Math.max(...fixture.clusters.slow_ms)).toBe(13878);
  });
});

describe('PLAN-C — the advisory never arms on the fixture', () => {
  /** THE headline acceptance. The same sequence armed three times on the
   *  shipped code (recorded as red-on-base proof in the execution log);
   *  it must now arm zero times, at the PRODUCTION thresholds the fixture
   *  carries. */
  it('arms zero times across the whole session', () => {
    expect(replayWeb(fixture.events, fixture.config)).toBe(
      fixture.expected.arm_transitions_after_fix
    );
  });

  it('the fixture would have armed three times before the fix', () => {
    expect(fixture.expected.arm_transitions_before_fix.web).toBe(3);
    expect(fixture.expected.arm_transitions_before_fix.ios).toBe(3);
  });
});

const CONFIG: PoorSignalProbeConfig = {
  windowSize: 8,
  minSamples: 4,
  armMedianMs: 1500,
  recoverMedianMs: 1000,
  cooldownMs: 300_000,
};

function makeAdvancingClock(startMs = 0) {
  let now = startMs;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('PLAN-C — sample admission on web', () => {
  it('an onset armed before a TTS pause is DROPPED, not carried across it', () => {
    const clock = makeAdvancingClock();
    const probe = new PoorSignalLatencyProbe(CONFIG, clock.now);
    // Four clean fast samples first, so the window is already populated and
    // any admitted poison would be visible in the median.
    for (let i = 0; i < 4; i++) {
      probe.onOnset(clock.now());
      clock.advance(50);
      probe.onInterimReceived();
      clock.advance(1000);
    }
    // Now the reported shape: speech onset, then TTS starts and pauses the
    // uplink, then a long read-back, then the interim lands.
    probe.onOnset(clock.now());
    clock.advance(1700);
    probe.discardPendingOnset(); // what the TTS-start handler now does
    clock.advance(12000); // read-back + pause + think time
    expect(probe.onInterimReceived()).toBe(false);
    expect(probe.isArmed).toBe(false);
  });

  it('without the discard the same window WOULD arm — the guard is load-bearing', () => {
    const clock = makeAdvancingClock();
    const probe = new PoorSignalLatencyProbe(CONFIG, clock.now);
    for (let i = 0; i < 4; i++) {
      probe.onOnset(clock.now());
      clock.advance(12000); // the pause-inflated window, left un-discarded
      probe.onInterimReceived();
    }
    expect(probe.isArmed).toBe(true);
  });

  it('a genuinely slow link still arms — the fix must not silence a real warning', () => {
    const clock = makeAdvancingClock();
    const probe = new PoorSignalLatencyProbe(CONFIG, clock.now);
    for (let i = 0; i < 4; i++) {
      probe.onOnset(clock.now());
      clock.advance(2400); // slow, but no pause anywhere near it
      probe.onInterimReceived();
      clock.advance(500);
    }
    expect(probe.isArmed).toBe(true);
  });

  it('discardPendingOnset pushes no sample at all', () => {
    const clock = makeAdvancingClock();
    const probe = new PoorSignalLatencyProbe(CONFIG, clock.now);
    // Four discarded windows cannot reach minSamples, so nothing can arm
    // and nothing can recover — the window is still empty.
    for (let i = 0; i < 4; i++) {
      probe.onOnset(clock.now());
      clock.advance(9000);
      probe.discardPendingOnset();
    }
    expect(probe.isArmed).toBe(false);
    // Prove emptiness rather than assuming it: four fast observed samples
    // now arrive, and a window still holding the four discards would need
    // more than four to reach minSamples.
    for (let i = 0; i < 4; i++) {
      probe.onOnset(clock.now());
      clock.advance(2000);
      probe.onInterimReceived();
    }
    expect(probe.isArmed).toBe(true);
  });

  it('discarding when nothing is pending is a no-op', () => {
    const clock = makeAdvancingClock();
    const probe = new PoorSignalLatencyProbe(CONFIG, clock.now);
    expect(() => probe.discardPendingOnset()).not.toThrow();
    expect(probe.isArmed).toBe(false);
  });
});

describe('PLAN-C — censored samples are excluded from the arm decision', () => {
  it('censored samples alone never arm, however many arrive', () => {
    const clock = makeAdvancingClock();
    const probe = new PoorSignalLatencyProbe(CONFIG, clock.now);
    for (let i = 0; i < 12; i++) {
      probe.onOnset(clock.now());
      clock.advance(9000); // far above armMedianMs — qualifies as censored
      probe.onResetWithoutInterim();
    }
    expect(probe.isArmed).toBe(false);
  });

  it('a mostly-censored window cannot arm on its few observed samples', () => {
    const clock = makeAdvancingClock();
    const probe = new PoorSignalLatencyProbe(CONFIG, clock.now);
    // Six censored + three slow observed: the old TOTAL-count gate would be
    // satisfied at four samples of any kind. The arm path now needs four
    // OBSERVED, and three is not four.
    for (let i = 0; i < 6; i++) {
      probe.onOnset(clock.now());
      clock.advance(9000);
      probe.onResetWithoutInterim();
    }
    for (let i = 0; i < 3; i++) {
      probe.onOnset(clock.now());
      clock.advance(2000);
      probe.onInterimReceived();
    }
    expect(probe.isArmed).toBe(false);
    // The fourth observed sample completes the gate honestly, and it arms.
    probe.onOnset(clock.now());
    clock.advance(2000);
    probe.onInterimReceived();
    expect(probe.isArmed).toBe(true);
  });
});
