/**
 * Silero VAD v5 wrapper — port of iOS `SileroVAD.swift`.
 *
 * iOS uses OnnxRuntimeBindings (Objective-C bridge) against the same
 * silero_vad.onnx (v5, 2.2MB, SHA256 starting `1a153a22…`). The web
 * port runs the same model through `onnxruntime-web` so the two
 * platforms agree to the float on every speech-probability decision.
 *
 * V5 wire shapes (different from v3 — keeping these notes here so the
 * next person doesn't bisect ORT versions chasing a "wrong shape" panic):
 *   - input:  float32[1, 576]   (64 prior-context samples + 512 new samples)
 *   - state:  float32[2, 1, 128]  (combined recurrent state, replaced
 *                                  v3's separate h0/c0 [2, 1, 64])
 *   - sr:     int64 scalar         (16000 — added in v5; v3 inferred SR)
 *   - output: float32[1, 1]        (speech probability)
 *   - stateN: float32[2, 1, 128]   (next state, replaces v3's hn/cn)
 *
 * Per-call protocol mirrors iOS line 42:
 *   1. Lock — single-flight serialization of inference. ONNX Runtime's
 *      session is stateful via the `state` tensor, so two overlapping
 *      `process()` calls would race on read+write and corrupt the
 *      stream of probabilities. iOS uses `NSLock`; we use an in-flight
 *      Promise chain.
 *   2. Build input = [...context (last 64 of prior chunk), ...chunk].
 *   3. Run session.
 *   4. Save output[0] as the probability.
 *   5. Update `state` from `stateN` for the next call.
 *   6. Save the trailing 64 samples of `chunk` as the next call's
 *      context.
 *
 * `reset()` zeros both `state` and `context`. The recording context
 * calls this on every session start — a long-running app instance
 * (a tab kept open across multiple inspections) must not carry
 * inter-session VAD memory.
 *
 * `onnxruntime-web` is dynamic-imported the first time `load()` is
 * called so the main JS bundle stays unaffected — only inspectors who
 * actually start a recording pay the ~3MB ORT cost, and Serwist's
 * runtime cache makes subsequent loads instant.
 */

// `onnxruntime-web`'s default entrypoint (dist/ort.bundle.min.mjs) bundles
// the WASM inline as a base64 blob, so we don't host the .wasm file
// separately. That trades ~3MB of one-time JS parse for zero CORS / COEP
// configuration — the right call when the alternative is asking every
// inspector device to prove SharedArrayBuffer + cross-origin isolation.
import type * as ortNs from 'onnxruntime-web';

type OrtModule = typeof ortNs;

let ortModulePromise: Promise<OrtModule> | null = null;

/** Lazily load `onnxruntime-web` once per page lifetime. Subsequent
 *  callers re-await the same Promise so two SileroVAD instances on a
 *  page don't double-cost the WASM init. */
function loadOrtModule(): Promise<OrtModule> {
  if (!ortModulePromise) {
    ortModulePromise = import('onnxruntime-web');
  }
  return ortModulePromise;
}

export class SileroVAD {
  /** ORT session, populated by `load()`. Process() throws if called before. */
  private session: ortNs.InferenceSession | null = null;
  /** Recurrent state — float32[2, 1, 128]. Mutated in place across calls
   *  so iOS-canon stream behaviour is preserved. */
  private state: Float32Array;
  /** Last 64 samples from the prior chunk, prepended to the current chunk.
   *  Zero-initialised so the very first chunk starts from a defined point. */
  private context: Float32Array;
  /** Captured `ort` module reference so process() doesn't await import on
   *  every call. Set during load(). */
  private ort: OrtModule | null = null;
  /** Single-flight queue. Each process() call appends to the chain so
   *  inferences serialise in arrival order, matching iOS NSLock semantics
   *  without the synchronous-blocking part. Errors don't break the chain
   *  (the catch swallows them so a single failed inference doesn't poison
   *  every subsequent caller). */
  private queue: Promise<void> = Promise.resolve();

  static readonly STATE_SIZE = 2 * 1 * 128;
  static readonly CONTEXT_SIZE = 64;
  /** Silero v5 fixed chunk size at 16kHz — 512 samples = 32ms. Caller
   *  must accumulate to exactly this before calling process(). */
  static readonly CHUNK_SIZE = 512;

  constructor() {
    this.state = new Float32Array(SileroVAD.STATE_SIZE);
    this.context = new Float32Array(SileroVAD.CONTEXT_SIZE);
  }

  /** Load the ONNX model. Must complete before the first process() call.
   *  Throws on fetch failure (network, 404, CORS) or session creation
   *  failure (corrupt model, ORT init failure on this device). */
  async load(modelUrl = '/models/silero_vad.onnx'): Promise<void> {
    const ort = await loadOrtModule();
    this.ort = ort;
    const res = await fetch(modelUrl);
    if (!res.ok) {
      throw new Error(
        `SileroVAD: model fetch failed ${res.status} ${res.statusText} (${modelUrl})`
      );
    }
    const buf = await res.arrayBuffer();
    this.session = await ort.InferenceSession.create(buf, {
      // Single-thread mode dodges the SharedArrayBuffer / COEP requirement
      // entirely. 32ms VAD frames take well under 2ms inference on a
      // mid-tier iPhone — there's no headroom argument for multi-thread.
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
      executionMode: 'sequential',
    });
  }

  /** Has this VAD instance loaded its model? Useful when the bootstrap
   *  caller wants to fall back to RMS while the model is still in flight
   *  (or never arrived because of an offline + uncached cold start). */
  get loaded(): boolean {
    return this.session !== null;
  }

  /**
   * Run inference on a 512-sample chunk @ 16kHz mono float32. Returns
   * the speech probability in [0, 1]. Throws if `load()` hasn't run or
   * if the chunk is the wrong size — both are programming errors that
   * should crash loudly in dev rather than silently degrade in prod.
   *
   * Calls serialise via `this.queue` even if the caller fires multiple
   * processes back-to-back without awaiting. Callers should still await
   * the returned Promise to know the actual probability — fire-and-forget
   * is fine when the only consumer is `SleepManager.processVadFrame`,
   * which tolerates a few-frame jitter on the wake decision.
   */
  process(chunk: Float32Array): Promise<number> {
    if (!this.session || !this.ort) {
      return Promise.reject(new Error('SileroVAD: session not loaded'));
    }
    if (chunk.length !== SileroVAD.CHUNK_SIZE) {
      return Promise.reject(
        new Error(`SileroVAD: expected ${SileroVAD.CHUNK_SIZE} samples, got ${chunk.length}`)
      );
    }
    // Snapshot the chunk into a private copy so a caller mutating the
    // backing buffer between enqueue and dequeue can't change what the
    // model sees. The accumulator in recording-context.tsx already
    // hands out fresh Float32Arrays per call, but defensiveness here
    // costs ~512 floats and avoids a future caller introducing a bug
    // we'd never spot in review.
    const chunkCopy = new Float32Array(chunk);
    const result = this.queue.then(() => this.runInference(chunkCopy));
    // Don't break the chain on failure; subsequent callers should still
    // get a clean shot. Mapping to undefined keeps the chain's type as
    // Promise<void> regardless of result.
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async runInference(chunk: Float32Array): Promise<number> {
    const ort = this.ort!;
    const session = this.session!;

    // Build [1, 576] input = 64 context + 512 chunk.
    const input = new Float32Array(SileroVAD.CONTEXT_SIZE + SileroVAD.CHUNK_SIZE);
    input.set(this.context, 0);
    input.set(chunk, SileroVAD.CONTEXT_SIZE);

    const inputTensor = new ort.Tensor('float32', input, [1, input.length]);
    const stateTensor = new ort.Tensor('float32', this.state, [2, 1, 128]);
    // BigInt() rather than the `16000n` literal — tsconfig targets ES2017,
    // and BigInt literal syntax is gated to ES2020+. The runtime BigInt
    // call works on every Safari that runs this PWA (Safari 14+).
    const srTensor = new ort.Tensor('int64', BigInt64Array.from([BigInt(16000)]), []);

    const outputs = await session.run({
      input: inputTensor,
      state: stateTensor,
      sr: srTensor,
    });

    const outputData = outputs.output.data as Float32Array;
    const probability = outputData[0];

    // Capture next-state into a fresh buffer. ORT's tensor data is a
    // view into the WASM heap and may be invalidated on the next run();
    // copying out is the documented contract.
    const stateNData = outputs.stateN.data as Float32Array;
    this.state = new Float32Array(stateNData);

    // Save trailing 64 samples of THIS chunk as next call's context.
    // Mirrors iOS line 101 verbatim. Using the source chunk (not the
    // 576-sample concatenated input) so context is samples-only, no
    // prior-context leakage.
    this.context = chunk.slice(SileroVAD.CHUNK_SIZE - SileroVAD.CONTEXT_SIZE);

    return probability;
  }

  /** Reset state + context to zero. iOS calls this on session start so
   *  per-session VAD behaviour is reproducible regardless of how long
   *  the page has been open. */
  reset(): void {
    // Wait for any in-flight inference to drain before zeroing — otherwise
    // the in-flight runInference would write its stateN over our reset.
    this.queue = this.queue.then(() => {
      this.state = new Float32Array(SileroVAD.STATE_SIZE);
      this.context = new Float32Array(SileroVAD.CONTEXT_SIZE);
    });
  }
}
