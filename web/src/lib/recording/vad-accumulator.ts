/**
 * VAD chunk accumulator — feeds 16kHz mono Float32 samples into the
 * Silero VAD wrapper at the wrapper's required cadence (one
 * 512-sample chunk per call ≈ 32ms @ 16kHz).
 *
 * Mic capture emits arbitrary block sizes (worklet blocks are 128
 * samples; `resampleTo16k` may emit slightly more or fewer samples
 * post ratio-conversion). The accumulator buffers leftover samples
 * across callbacks, dispatches whenever a full chunk is available,
 * and applies an energy floor below which inference is skipped (a
 * silent chunk feeds 0 to the SleepManager directly without burning
 * the WASM cycles).
 *
 * Extracted from `recording-context.tsx` so unit tests can drive the
 * accumulator without a full recording-provider mount.
 */

import { SileroVAD } from './silero-vad';

/** Energy floor below which a chunk is treated as non-speech without
 *  running inference. iOS canon — `Sources/Audio/SileroVAD.swift` line
 *  16 (`energyFloor = 0.002`). Roughly -54 dBFS; conservative enough
 *  that any plausible speech sits comfortably above it, low enough
 *  that breath / fan / passive-cabinet hum doesn't constantly pay
 *  inference. Frames below the floor still feed the SleepManager
 *  (with score 0) so the consecutive-speech-frame counter resets the
 *  same way it would for a sub-threshold inference result. */
export const VAD_ENERGY_FLOOR_RMS = 0.002;

export type VadAccumulator = {
  /** Active 512-sample buffer being filled. Replaced (not slice'd) on
   *  every dispatch so the in-flight VAD inference owns its argument
   *  exclusively while the next callback writes into a fresh buffer. */
  buf: Float32Array;
  /** Write offset within `buf`. Reaches CHUNK_SIZE → dispatch + reset. */
  offset: number;
};

/** Build a fresh accumulator. The returned object is mutated in place
 *  by `dispatchSamplesToVad` — keep a stable reference (e.g. a useRef
 *  payload) for the lifetime of the recording session. */
export function createVadAccumulator(): VadAccumulator {
  return { buf: new Float32Array(SileroVAD.CHUNK_SIZE), offset: 0 };
}

/** Reset the accumulator in place — used at session teardown so a
 *  subsequent session doesn't carry the previous session's tail. */
export function resetVadAccumulator(acc: VadAccumulator): void {
  acc.buf = new Float32Array(SileroVAD.CHUNK_SIZE);
  acc.offset = 0;
}

export function computeRms(buf: Float32Array): number {
  if (buf.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    sumSquares += v * v;
  }
  return Math.sqrt(sumSquares / buf.length);
}

/** Minimal VAD interface — accepts a 512-sample chunk, returns the
 *  speech probability. Lets tests substitute a scripted mock without
 *  loading the real ONNX model. */
export interface VadProcessor {
  process(chunk: Float32Array): Promise<number>;
}

/** Minimal SleepManager interface — only the VAD-frame entrypoint.
 *  Lets tests assert on the score sequence without instantiating a
 *  real timer-driven SleepManager. */
export interface VadSink {
  processVadFrame(score: number): void;
}

/** Push freshly-resampled 16kHz Float32 samples through the
 *  accumulator. When a chunk completes, fire-and-forget VAD inference
 *  and route the resolved probability to the sink. Samples larger
 *  than one chunk loop and dispatch as many chunks as fit; the
 *  remainder stays in the accumulator for the next callback.
 *
 *  Returns nothing — the caller has no useful synchronous knowledge
 *  about pending inferences. The optional `onError` is invoked on
 *  rejected `process()` calls so a wrapper can log without each
 *  caller open-coding an error path. Errors swallowed by default
 *  (no-throw) so a single bad inference doesn't poison the chain. */
export function dispatchSamplesToVad(
  samples16k: Float32Array,
  vad: VadProcessor,
  sink: VadSink,
  acc: VadAccumulator,
  onError?: (err: unknown) => void
): void {
  let cursor = 0;
  while (cursor < samples16k.length) {
    const remaining = SileroVAD.CHUNK_SIZE - acc.offset;
    const take = Math.min(remaining, samples16k.length - cursor);
    acc.buf.set(samples16k.subarray(cursor, cursor + take), acc.offset);
    acc.offset += take;
    cursor += take;
    if (acc.offset < SileroVAD.CHUNK_SIZE) return;

    // Hand the full chunk off; immediately replace the accumulator so
    // the next callback writes into a fresh buffer.
    const chunk = acc.buf;
    acc.buf = new Float32Array(SileroVAD.CHUNK_SIZE);
    acc.offset = 0;

    const rms = computeRms(chunk);
    if (rms < VAD_ENERGY_FLOOR_RMS) {
      sink.processVadFrame(0);
      continue;
    }
    void vad
      .process(chunk)
      .then((prob) => sink.processVadFrame(prob))
      .catch((err) => onError?.(err));
  }
}
