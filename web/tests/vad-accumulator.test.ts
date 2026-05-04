/**
 * vad-accumulator unit tests — T20 Silero VAD plumbing.
 *
 * The accumulator is the seam between the mic capture pipeline (which
 * emits arbitrary 16kHz block sizes) and SileroVAD (which expects
 * exactly 512-sample chunks per `process()` call). Getting the seam
 * wrong has two failure modes that both look like "VAD just doesn't
 * fire":
 *   - Trailing samples discarded → speech ramps below threshold for
 *     ~32ms every chunk boundary; consecutive-frame counter never
 *     completes the wake.
 *   - Buffer aliased between dispatch and the next callback → the
 *     in-flight inference reads samples from after the dispatch
 *     instant; recurrent state corruption rolls forward and probability
 *     output drifts.
 *
 * These tests pin the contract: every input sample lands in exactly
 * one chunk, dispatched chunks aren't shared with the live buffer,
 * and the energy floor is applied after the chunk is captured.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  VAD_ENERGY_FLOOR_RMS,
  computeRms,
  createVadAccumulator,
  dispatchSamplesToVad,
  resetVadAccumulator,
  type VadProcessor,
  type VadSink,
} from '@/lib/recording/vad-accumulator';
import { SileroVAD } from '@/lib/recording/silero-vad';

const CHUNK = SileroVAD.CHUNK_SIZE;

function makeFilledChunk(value: number, length = CHUNK): Float32Array {
  const buf = new Float32Array(length);
  buf.fill(value);
  return buf;
}

function makeMockVad(scores: number[]): { vad: VadProcessor; calls: Float32Array[] } {
  const calls: Float32Array[] = [];
  const queue = [...scores];
  const vad: VadProcessor = {
    async process(chunk) {
      // Snapshot the chunk argument: the caller must hand us a buffer
      // that won't mutate before we read it. If the accumulator ever
      // re-uses the same backing buffer for a subsequent partial fill,
      // we'd see the post-dispatch contents here and the test below
      // (`dispatched chunks are not aliased to the live buffer`) would
      // fail.
      calls.push(new Float32Array(chunk));
      if (queue.length === 0) return 0;
      return queue.shift()!;
    },
  };
  return { vad, calls };
}

function makeSinkSpy(): { sink: VadSink; scores: number[] } {
  const scores: number[] = [];
  const sink: VadSink = {
    processVadFrame(score) {
      scores.push(score);
    },
  };
  return { sink, scores };
}

describe('computeRms', () => {
  it('returns 0 for an empty buffer', () => {
    expect(computeRms(new Float32Array(0))).toBe(0);
  });

  it('returns the amplitude for a constant signal', () => {
    // RMS of a constant a is |a|; rounding tolerance for FP precision.
    expect(computeRms(makeFilledChunk(0.5))).toBeCloseTo(0.5, 6);
  });

  it('treats sub-floor energy as below VAD_ENERGY_FLOOR_RMS', () => {
    // 0.001 < 0.002 — should be skipped by the dispatcher's energy check.
    expect(computeRms(makeFilledChunk(0.001))).toBeLessThan(VAD_ENERGY_FLOOR_RMS);
  });
});

describe('dispatchSamplesToVad', () => {
  it('dispatches exactly one chunk per CHUNK_SIZE samples', async () => {
    const acc = createVadAccumulator();
    const { vad, calls } = makeMockVad([0.5]);
    const { sink, scores } = makeSinkSpy();

    dispatchSamplesToVad(makeFilledChunk(0.1), vad, sink, acc);
    // Drain microtasks so the .then(processVadFrame) lands.
    await Promise.resolve();
    await Promise.resolve();

    expect(calls.length).toBe(1);
    expect(calls[0].length).toBe(CHUNK);
    expect(acc.offset).toBe(0);
    expect(scores).toEqual([0.5]);
  });

  it('preserves trailing samples across calls', async () => {
    const acc = createVadAccumulator();
    const { vad, calls } = makeMockVad([0.9]);
    const { sink, scores } = makeSinkSpy();

    // 200 samples — under one chunk. No dispatch yet.
    dispatchSamplesToVad(makeFilledChunk(0.1, 200), vad, sink, acc);
    expect(calls.length).toBe(0);
    expect(acc.offset).toBe(200);
    expect(scores).toEqual([]);

    // 312 more — completes the chunk to exactly 512.
    dispatchSamplesToVad(makeFilledChunk(0.1, 312), vad, sink, acc);
    await Promise.resolve();
    await Promise.resolve();

    expect(calls.length).toBe(1);
    expect(calls[0].length).toBe(CHUNK);
    expect(acc.offset).toBe(0);
    expect(scores).toEqual([0.9]);
  });

  it('dispatches multiple chunks when given a >CHUNK_SIZE input', async () => {
    const acc = createVadAccumulator();
    const { vad, calls } = makeMockVad([0.1, 0.2, 0.3]);
    const { sink, scores } = makeSinkSpy();

    // 1280 samples = 2 full chunks + 256 remainder.
    dispatchSamplesToVad(makeFilledChunk(0.1, CHUNK * 2 + 256), vad, sink, acc);
    await Promise.resolve();
    await Promise.resolve();

    expect(calls.length).toBe(2);
    expect(acc.offset).toBe(256);
    expect(scores).toEqual([0.1, 0.2]);
  });

  it('skips inference and feeds 0 when below the energy floor', async () => {
    const acc = createVadAccumulator();
    // process() should NEVER be called below the floor — start with an
    // empty score queue so an unexpected call would throw on the
    // `.shift()!` (queue.shift() returns undefined and `!` would coerce
    // — caught by the score expectation below).
    const { vad, calls } = makeMockVad([]);
    const { sink, scores } = makeSinkSpy();

    // Constant 0.001 — RMS = 0.001 < 0.002 floor.
    dispatchSamplesToVad(makeFilledChunk(0.001), vad, sink, acc);
    // No microtask drain needed — the floor branch is synchronous.

    expect(calls.length).toBe(0);
    expect(scores).toEqual([0]);
  });

  it('runs inference when the chunk is exactly at the floor', async () => {
    const acc = createVadAccumulator();
    const { vad, calls } = makeMockVad([0.5]);
    const { sink, scores } = makeSinkSpy();

    // Constant 0.002 — RMS exactly equals VAD_ENERGY_FLOOR_RMS. The
    // floor check is strict less-than so this path runs inference.
    dispatchSamplesToVad(makeFilledChunk(0.002), vad, sink, acc);
    await Promise.resolve();
    await Promise.resolve();

    expect(calls.length).toBe(1);
    expect(scores).toEqual([0.5]);
  });

  it('does not alias the dispatched chunk to the live buffer', async () => {
    const acc = createVadAccumulator();
    const captured: Float32Array[] = [];
    const vad: VadProcessor = {
      async process(chunk) {
        // Capture the LIVE reference (not a copy). If the accumulator
        // re-used the same backing buffer for the next chunk, the
        // first captured reference would later read as the second
        // chunk's contents.
        captured.push(chunk);
        return 0.5;
      },
    };
    const { sink } = makeSinkSpy();

    // First dispatch — fills + sends one chunk of 0.1s.
    dispatchSamplesToVad(makeFilledChunk(0.1), vad, sink, acc);

    // Second dispatch — fills the FRESH live buffer with 0.9s. If
    // the accumulator re-used the dispatched buffer, the first
    // captured reference would now contain 0.9s (or a partial mix).
    dispatchSamplesToVad(makeFilledChunk(0.9), vad, sink, acc);

    await Promise.resolve();
    await Promise.resolve();

    // Two distinct chunks captured — the first must STILL read as 0.1s
    // even after the second dispatch wrote 0.9s into the live buffer.
    expect(captured.length).toBe(2);
    for (let i = 0; i < CHUNK; i++) {
      expect(captured[0][i]).toBeCloseTo(0.1, 6);
      expect(captured[1][i]).toBeCloseTo(0.9, 6);
    }
    // And the references themselves must differ.
    expect(captured[0]).not.toBe(captured[1]);
  });

  it('forwards inference rejections to onError without throwing', async () => {
    const acc = createVadAccumulator();
    const vad: VadProcessor = {
      async process() {
        throw new Error('boom');
      },
    };
    const { sink, scores } = makeSinkSpy();
    const onError = vi.fn();

    expect(() => {
      dispatchSamplesToVad(makeFilledChunk(0.5), vad, sink, acc, onError);
    }).not.toThrow();

    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledOnce();
    // No score routed when inference fails — the SleepManager's
    // counter naturally resets on the next sub-threshold frame.
    expect(scores).toEqual([]);
  });
});

describe('resetVadAccumulator', () => {
  it('zeroes the buffer and offset in place', () => {
    const acc = createVadAccumulator();
    acc.buf = makeFilledChunk(0.7);
    acc.offset = 200;

    resetVadAccumulator(acc);

    expect(acc.offset).toBe(0);
    expect(acc.buf.length).toBe(CHUNK);
    // Confirm the new buffer is freshly zeroed (not the 0.7-filled one).
    expect(acc.buf[0]).toBe(0);
  });
});
