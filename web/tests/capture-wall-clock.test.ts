/**
 * PLAN-E-TERM — the piecewise capture-sample → wall-clock map.
 *
 * A single session-start anchor would place a reading lost after a
 * ten-minute pause near the PRE-pause time; the map records a new anchor
 * at every capture discontinuity (detected from the data — pause,
 * interruption, TTS-excluded interval all look the same: wall-clock jumps
 * while the capture clock stands still).
 */
import { describe, expect, it } from 'vitest';
import { CaptureWallClock } from '@/lib/recording/capture-wall-clock';

const T0 = 1_700_000_000_000; // an epoch ms base
const BLOCK = 4096; // samples per mic block
const BLOCK_MS = (BLOCK * 1000) / 16000; // 256 ms

/** Feed `n` contiguous blocks starting at sample `from` / wall `at`. */
function feed(
  clock: CaptureWallClock,
  from: number,
  at: number,
  n: number
): { sample: number; wall: number } {
  let sample = from;
  let wall = at;
  for (let i = 0; i < n; i++) {
    clock.observe(sample, wall);
    sample += BLOCK;
    wall += BLOCK_MS;
  }
  return { sample, wall };
}

describe('CaptureWallClock — continuous capture', () => {
  it('records ONE anchor for a continuous stream and maps samples linearly', () => {
    const clock = new CaptureWallClock();
    feed(clock, 0, T0, 40);
    expect(clock.anchorCount).toBe(1);
    expect(clock.wallMsAt(16000)).toBe(T0 + 1000);
    expect(clock.windowOf({ start: 32000, end: 48000 })).toEqual({
      startMs: T0 + 2000,
      endMs: T0 + 3000,
    });
  });

  it('tolerates scheduler jitter within the tolerance without a new anchor', () => {
    const clock = new CaptureWallClock();
    clock.observe(0, T0);
    clock.observe(BLOCK, T0 + BLOCK_MS + 120); // +120 ms late
    clock.observe(2 * BLOCK, T0 + 2 * BLOCK_MS - 60); // early
    expect(clock.anchorCount).toBe(1);
  });

  it('returns null before any observation', () => {
    const clock = new CaptureWallClock();
    expect(clock.wallMsAt(0)).toBeNull();
    expect(clock.windowOf({ start: 0, end: 10 })).toBeNull();
  });
});

describe('CaptureWallClock — discontinuities (split-round-9)', () => {
  it('a ten-minute pause BEFORE the lost range yields the POST-pause window, not the pre-pause one', () => {
    const clock = new CaptureWallClock();
    const { sample, wall } = feed(clock, 0, T0, 10); // 2.56 s of capture
    const PAUSE_MS = 10 * 60 * 1000;
    // Capture clock stood still through the pause; wall-clock advanced.
    feed(clock, sample, wall + PAUSE_MS, 10);
    expect(clock.anchorCount).toBe(2);
    const lost = { start: sample + 16000, end: sample + 32000 }; // 1–2 s after resume
    const window = clock.windowOf(lost);
    expect(window).not.toBeNull();
    expect(window!.startMs).toBe(wall + PAUSE_MS + 1000);
    expect(window!.endMs).toBe(wall + PAUSE_MS + 2000);
    // The naive single-anchor answer would have been ~10 min earlier.
    expect(window!.startMs - (T0 + (lost.start * 1000) / 16000)).toBeGreaterThan(PAUSE_MS - 1000);
  });

  it('a TTS-excluded interval (capture clock stalls, wall advances 3 s) starts a new piece', () => {
    const clock = new CaptureWallClock();
    const { sample, wall } = feed(clock, 0, T0, 5);
    feed(clock, sample, wall + 3000, 5); // clip played for 3 s; no samples advanced
    expect(clock.anchorCount).toBe(2);
    expect(clock.wallMsAt(sample)).toBe(wall + 3000);
    // The sample just BEFORE the gap still maps through the first piece.
    expect(clock.wallMsAt(sample - BLOCK)).toBe(wall - BLOCK_MS);
  });

  it('a range straddling a discontinuity spans the real gap (each bound through its own piece)', () => {
    const clock = new CaptureWallClock();
    const { sample, wall } = feed(clock, 0, T0, 5);
    feed(clock, sample, wall + 60_000, 5);
    const window = clock.windowOf({ start: sample - BLOCK, end: sample + BLOCK });
    expect(window!.endMs - window!.startMs).toBeGreaterThan(60_000);
  });

  it('a delayed REPORT never changes the mapping — the window is capture time, not report time', () => {
    const clock = new CaptureWallClock();
    const { sample, wall } = feed(clock, 0, T0, 20);
    // The report of a loss at samples [16000, 32000) arrives "now", 30 s later —
    // the map is only ever fed capture observations, so the answer is unchanged.
    void sample;
    void wall;
    expect(clock.windowOf({ start: 16000, end: 32000 })).toEqual({
      startMs: T0 + 1000,
      endMs: T0 + 2000,
    });
  });

  it('ignores non-finite input and never rewinds', () => {
    const clock = new CaptureWallClock();
    expect(clock.observe(Number.NaN, T0)).toBe(false);
    clock.observe(BLOCK * 10, T0);
    expect(clock.observe(0, T0 + 5000)).toBe(false); // earlier sample: ignored
    expect(clock.anchorCount).toBe(1);
  });
});
