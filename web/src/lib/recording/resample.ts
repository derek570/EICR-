/**
 * Linear-interpolation resampler to 16kHz mono Float32.
 *
 * Extracted out of `DeepgramService` so the ring buffer, Deepgram
 * streaming, and any future consumer can share the same conversion.
 *
 * Why this lives at the edge of the recording pipeline: AudioContext
 * creation asks for 16kHz (`new AudioContext({ sampleRate: 16000 })`)
 * but the browser is free to ignore the hint. On many Macs the context
 * actually runs at 44.1kHz; on most iOS Safari builds 48kHz. The ring
 * buffer was sized for 16kHz, so without this resample step the 3-second
 * wake-replay buffer was silently capturing only ~1 second of true
 * audio at the wrong claimed rate, and Deepgram received bytes
 * labelled 16kHz that were actually playback-rate — transcripts came
 * back garbled and early finals were missed entirely.
 *
 * Linear interpolation is the same approach iOS uses and is audibly
 * indistinguishable from a higher-order resampler for speech at the
 * 16kHz target; more importantly it runs in O(n) with no allocations
 * per block beyond the output buffer. A polyphase FIR would be nicer
 * for music but would blow the audio callback budget on low-end iPhones.
 */

export function resampleTo16k(samples: Float32Array, sourceSampleRate: number): Float32Array {
  // Fast path — already 16kHz. Return the input directly so callers
  // that pass through can skip the per-block allocation entirely.
  if (sourceSampleRate === 16000) return samples;
  const ratio = sourceSampleRate / 16000;
  const outLen = Math.max(0, Math.floor(samples.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcIdx = i * ratio;
    const lo = Math.floor(srcIdx);
    const hi = Math.min(lo + 1, samples.length - 1);
    const frac = srcIdx - lo;
    out[i] = samples[lo] * (1 - frac) + samples[hi] * frac;
  }
  return out;
}
