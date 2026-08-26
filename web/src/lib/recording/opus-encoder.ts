/**
 * PLAN-E1 — the web Opus encoder. Per E0's outcome (bare-opus packets
 * accepted by Flux, live-probed 2026-08-25 — see
 * `scripts/deepgram-flux-encoding-probe.mjs`'s `flux-bare-opus` row),
 * WebCodecs `AudioEncoder('opus')` is configured to emit RAW Opus packets
 * with no container — no muxing step needed on send.
 *
 * ENCODER-INTERNAL PCM IS ACCOUNTED (round-13 BLOCKER): the sender owns
 * audio from raw-PCM acceptance through transport dispatch. WebCodecs
 * `encode()`/`output` is async, so samples accepted but not yet emitted
 * as an encoded packet are tracked by the CALLER (the sender in
 * `deepgram-service.ts`) via `pendingInputSamples` bookkeeping — this
 * module only wraps the encoder lifecycle itself.
 *
 * ASYNC ENCODER OUTPUTS ARE SOCKET/GENERATION-BOUND (round-8): every
 * encoder instance is created for exactly ONE connection generation and
 * closed on reconnect/codec change/teardown. The `generation` tag on each
 * encoded packet lets the caller discard output arriving after a newer
 * generation has already been published (this module does not do the
 * discarding itself — see `GenerationBoundOpusSender` in
 * `deepgram-service.ts`).
 *
 * Behind a factory seam (`OpusEncoderFactory`) so tests can inject a fake
 * encoder — `AudioEncoder`/`AudioData` (WebCodecs) are not implemented in
 * the Vitest/jsdom test environment.
 */

export interface OpusEncoderLike {
  /** Encode one frame of 16kHz mono Int16 PCM. Fire-and-forget — encoded
   *  output arrives later via the factory's `onPacket` callback. */
  encode(samples: Int16Array): void;
  /** Bounded flush — drains any buffered encoder/container tail before a
   *  graceful close. Resolves once flushed (or the underlying encoder has
   *  nothing pending). */
  flush(): Promise<void>;
  /** Tear down the encoder. Idempotent. No further `onPacket` calls after
   *  this resolves/returns. */
  close(): void;
}

export type OpusEncoderFactory = (onPacket: (bytes: Uint8Array) => void) => OpusEncoderLike;

/** Detects genuine WebCodecs Opus support at runtime (SSR/older Safari
 *  have no `AudioEncoder` global at all). */
export function webCodecsOpusAvailable(): boolean {
  return (
    typeof globalThis.AudioEncoder !== 'undefined' && typeof globalThis.AudioData !== 'undefined'
  );
}

/** The real production factory — WebCodecs `AudioEncoder`, opus codec,
 *  16kHz mono, ~28kbps VBR (matches iOS's `AVAudioConverter` target
 *  bitrate range so both clients' A/B arms use comparable encode
 *  quality). One instance per connection generation; callers create a
 *  fresh one per socket and `close()` it on teardown/reconnect/codec
 *  change — never reused across generations. */
export const realOpusEncoderFactory: OpusEncoderFactory = (onPacket) => {
  if (!webCodecsOpusAvailable()) {
    throw new Error('opus-encoder: WebCodecs AudioEncoder is not available in this environment');
  }
  let timestampUs = 0;
  let closed = false;
  const encoder = new AudioEncoder({
    output: (chunk) => {
      if (closed) return;
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      onPacket(bytes);
    },
    error: () => {
      // Encoder-level errors surface to the caller as a teardown trigger
      // via the normal socket-failure path (an encoder that errors stops
      // producing packets, which the sender's own health checks catch);
      // nothing to do here beyond not crashing.
    },
  });
  encoder.configure({
    codec: 'opus',
    sampleRate: 16000,
    numberOfChannels: 1,
    bitrate: 28000,
  });

  return {
    encode(samples: Int16Array) {
      if (closed) return;
      const frameDurationUs = Math.round((samples.length / 16000) * 1_000_000);
      const data = new AudioData({
        format: 's16',
        sampleRate: 16000,
        numberOfFrames: samples.length,
        numberOfChannels: 1,
        timestamp: timestampUs,
        data: samples.buffer.slice(
          samples.byteOffset,
          samples.byteOffset + samples.byteLength
        ) as ArrayBuffer,
      });
      timestampUs += frameDurationUs;
      try {
        encoder.encode(data);
      } finally {
        data.close();
      }
    },
    async flush() {
      if (closed) return;
      try {
        await encoder.flush();
      } catch {
        // Flush failure — the caller charges any un-flushed residue via
        // the loss-report seam; nothing further to do here.
      }
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        encoder.close();
      } catch {
        // Already closed/errored — ignore.
      }
    },
  };
};
