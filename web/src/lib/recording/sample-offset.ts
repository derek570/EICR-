/**
 * PLAN-E1 (split-round-30 BLOCKER) — the shared 16kHz sample-domain offset
 * conversion. Deepgram's `audio_window_end` is reported in SECONDS, and
 * Opus is VBR/container-framed, so an encoded-BYTE offset cannot map
 * monotonically to vendor audio time — a byte coordinate could falsely
 * retire genuinely-lost speech. Every dispatched-range statement in this
 * plan family is therefore expressed in SOURCE 16kHz SAMPLES, never bytes.
 *
 * This helper must have IDENTICAL semantics to its Swift twin
 * (`DeepgramService.swift` — `audioWindowEndToSampleOffset(seconds:)`):
 * both are 16kHz, both floor-round, both validate finite/non-negative
 * input. A shared parity fixture (`config/sample-offset-parity-vectors.json`)
 * asserts the two implementations agree on the same input vectors — see
 * `web/tests/sample-offset-parity.test.ts` and the iOS twin.
 */

export const UPLINK_SAMPLE_RATE_HZ = 16000;

/**
 * Convert a Deepgram `audio_window_end` value (seconds, vendor-reported)
 * into a 16kHz sample-domain offset. Floor-rounds (a partial sample at the
 * boundary is not yet "arrived"). Throws on non-finite or negative input —
 * a malformed vendor value must never silently produce a bogus offset that
 * could misalign dispatched-range accounting.
 */
export function audioWindowEndToSampleOffset(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new RangeError(
      `audioWindowEndToSampleOffset: seconds must be a finite, non-negative number (got ${seconds})`
    );
  }
  return Math.floor(seconds * UPLINK_SAMPLE_RATE_HZ);
}
