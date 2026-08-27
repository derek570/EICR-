/**
 * PLAN-E1 (Codex diff-review r1 BLOCKER fix) — single source of truth for
 * tagging a captured Float32 mic block into a `CapturedPcmSegment`.
 *
 * Previously this logic lived ONLY inside `DeepgramService.sendSamples`,
 * so it only ran while a live `DeepgramService` instance existed. The
 * ring buffer must keep recording during periods with NO live service —
 * full sleep tears Deepgram down but leaves the mic running — so its
 * writes were untagged, and a later replay derived a FRESH tag at DRAIN
 * time instead: double-advancing the shared capture clock for
 * physically-identical audio and mislabeling gap-period audio as live
 * under the post-reconnect epoch. That is exactly the "no restamping"
 * violation this plan's own scope-allocator doc calls out — a `preOpen`
 * range must never be relabeled with an epoch minted later.
 *
 * Hoisting tagging to the mic-capture callsite (`recording-context.tsx`'s
 * `onSamples`), which owns the session context independently of any one
 * `DeepgramService` instance's lifecycle, lets every captured block get
 * exactly one immutable tag at the moment it was actually captured,
 * whether or not a socket happens to be open right now. `DeepgramService
 * .sendSamples` and `recording-context.tsx` both call this helper so the
 * two never drift.
 */
import type { DeepgramSessionContext } from './deepgram-service';
import type { ConnectionEpoch } from './uplink-scope-allocator';
import type { CapturedPcmSegment } from './tagged-pcm-segment';

/** Clamp-and-scale Float32 -> Int16, matching Deepgram's expected PCM
 *  format. Shared so the ring buffer and the live-send path never
 *  produce diverging sample values for the same physical audio. */
export function floatToInt16Pcm(samples: Float32Array): Int16Array {
  const int16 = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    int16[i] = Math.round(clamped * 32767);
  }
  return int16;
}

/**
 * Tag an already-16kHz Float32 block: convert to Int16, reserve its
 * capture-domain sample range off the session's shared clock, resolve
 * its epoch scope (live epoch if a socket is open, else `preOpen`), and
 * feed the session's shared VAD (if any) — matching the prior
 * `sendSamples` behaviour of feeding VAD for every accepted frame
 * regardless of connection state.
 *
 * `capturedAt` (PLAN-E1B2 item 3) is stamped by the CALLER, at the true
 * capture-ingress boundary (`recording-context.tsx`'s `onSamples`,
 * immediately after the TTS-discard guard and before resampling) — never
 * computed here, which would already be after resampling has run.
 */
export function tagCapturedFloat32(
  samples16k: Float32Array,
  ctx: DeepgramSessionContext,
  liveEpoch: ConnectionEpoch | null,
  capturedAt: number
): CapturedPcmSegment {
  const int16 = floatToInt16Pcm(samples16k);
  const captureSampleRange = ctx.captureClock.advance(int16.length);
  const epochScope = ctx.allocator.currentScope(liveEpoch);
  const segment: CapturedPcmSegment = {
    origin: 'captured',
    samples: int16,
    recordingSessionId: ctx.recordingSessionId,
    captureSampleRange,
    epochScope,
    capturedAt,
  };
  ctx.vad?.processFrame(segment);
  return segment;
}
