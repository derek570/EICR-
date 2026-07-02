'use client';

/**
 * Tour-local "sent for processing" chime — a sample-accurate port of
 * iOS `DeepgramRecordingViewModel.makeChimeWAVData()` (lines 209-230):
 * 960 Hz sine, 80 ms total, 10 ms linear attack ramp then
 * `exp(-(t - attack) * 20)` decay, amplitude 0.5, 22.05 kHz mono.
 * Tour v11's "conversational + tone" step teaches this exact sound
 * (iOS splices the real chime into the step's bundled MP3 — build 417).
 *
 * ⚠️ OWNERSHIP (parity program §4 rule a): this synthesis lives in the
 * tour module ON PURPOSE. `web/src/lib/recording/tones.ts` is owned by
 * WS3 this cycle, and WS3 item 7 adds the canonical
 * `playSentForProcessingChime()` there wired to the transcript
 * forward-gate. When WS3 lands, IT owns the switch: this file's synth
 * is deleted and the tour imports the tones.ts export instead — never
 * leave two copies of the chime synthesis in web/.
 *
 * Implementation note: unlike tones.ts's oscillator+gain approach,
 * this renders the exact PCM samples into an AudioBuffer, because the
 * iOS chime's envelope (linear attack + exponential decay with a
 * specific constant) is the thing being taught — "close by ear" isn't
 * good enough when the tour says "this is the sound".
 */

export const CHIME_SAMPLE_RATE = 22050;
export const CHIME_FREQUENCY_HZ = 960;
export const CHIME_DURATION_S = 0.08;
export const CHIME_ATTACK_S = 0.01;
export const CHIME_AMPLITUDE = 0.5;

/**
 * Pure synthesis of the chime waveform — mirrors the iOS sample loop
 * one-for-one (modulo Int16 quantisation, irrelevant at Float32).
 * Exported for tests so the envelope contract is pinned without an
 * AudioContext.
 */
export function synthesiseChimeSamples(sampleRate: number = CHIME_SAMPLE_RATE): Float32Array {
  const sampleCount = Math.floor(sampleRate * CHIME_DURATION_S);
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const t = i / sampleRate;
    const envelope = t < CHIME_ATTACK_S ? t / CHIME_ATTACK_S : Math.exp(-(t - CHIME_ATTACK_S) * 20);
    samples[i] = Math.sin(2 * Math.PI * CHIME_FREQUENCY_HZ * t) * CHIME_AMPLITUDE * envelope;
  }
  return samples;
}

let ctx: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (ctx) return ctx;
  const Ctor =
    (window as Window & { AudioContext?: typeof AudioContext }).AudioContext ??
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
    return ctx;
  } catch {
    return null;
  }
}

/**
 * Play the chime once. Fail-quiet like tones.ts — no AudioContext
 * (SSR, jsdom, pre-gesture iOS Safari) means silence, never a throw.
 * The tour is started by a tap, so the context is gesture-unlocked by
 * the time the tone step plays.
 */
export function playTourProcessingChime(): void {
  const context = getContext();
  if (!context) return;
  if (context.state === 'suspended') {
    void context.resume().catch(() => {});
  }
  try {
    const samples = synthesiseChimeSamples();
    const buffer = context.createBuffer(1, samples.length, CHIME_SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start();
  } catch {
    // Non-critical audio cue — swallow (matches tones.ts semantics).
  }
}

/** Test-only — drop the cached AudioContext between tests. */
export function __resetTourChimeForTests(): void {
  ctx = null;
}
