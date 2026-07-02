'use client';

/**
 * Audio cues — synthesises iOS's `AudioServicesPlaySystemSound` tones
 * via Web Audio API so the PWA produces the same audible feedback
 * iOS does at the same moments. Web doesn't have access to the iOS
 * system sound bank, so we approximate with short envelope-shaped
 * oscillator bursts. Pitch + envelope chosen by ear to match the
 * acoustic feel of the iOS tones (subjective — adjust the constants
 * here if a build feels off):
 *
 *   • playAttentionTone()      — iOS system sound 1007 ("Tock"). A
 *     subtle, non-intrusive attention getter played BEFORE TTS reads
 *     a validation alert / ask_user prompt. Mirrors AlertManager.
 *     swift:1424.
 *   • playConfirmationChime()  — iOS system sound 1025. A positive
 *     two-note chime played AFTER the user resolves an alert via tap
 *     or voice correction. Mirrors AlertManager.swift:1430. Used at
 *     iOS lines 552 (resolveWithCorrection), 580 / 590
 *     (resolveWithCircuitMove), and 784 (handleTapResponse on
 *     accept).
 *
 * Reuses a single AudioContext per session — Safari and Chromium both
 * cap concurrent contexts and the cost of holding one open is
 * negligible. The context is created lazily on first use so SSR
 * (and pages that never play a tone) don't pay the construction
 * cost.
 *
 * iOS Safari quirk: AudioContext starts SUSPENDED on iOS until a
 * user gesture has been observed by the page. The recording flow
 * already requires a tap-to-start gesture before any tone could
 * play, so we don't fight the suspension here. Tones called before
 * a gesture are silently ignored — same fail-quiet semantics the
 * speak() wrapper has.
 */

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

interface ToneStep {
  /** Frequency in Hz at the start of the step. */
  startFreq: number;
  /** Frequency at the end of the step (linear glide). Equal to
   *  `startFreq` for a flat note. */
  endFreq: number;
  /** Duration in seconds. */
  duration: number;
  /** Peak gain (0–1). The envelope opens to this value over a 5ms
   *  attack and decays exponentially to 0.0001 over the step's
   *  duration so successive notes don't click. */
  peakGain: number;
  /** Oscillator type. iOS Tock has a hint of triangle; the
   *  confirmation chime is a clean sine. */
  type?: OscillatorType;
}

function playSequence(steps: ToneStep[]): void {
  const context = getContext();
  if (!context) return;
  // Some browsers (iOS Safari) suspend the context after a period of
  // silence. resume() is a no-op when running and an idempotent kick
  // when suspended; failures are non-critical.
  if (context.state === 'suspended') {
    void context.resume().catch(() => {});
  }
  let when = context.currentTime;
  for (const step of steps) {
    const osc = context.createOscillator();
    osc.type = step.type ?? 'sine';
    osc.frequency.setValueAtTime(step.startFreq, when);
    if (step.endFreq !== step.startFreq) {
      osc.frequency.linearRampToValueAtTime(step.endFreq, when + step.duration);
    }
    const gain = context.createGain();
    // 5ms attack to avoid the audible click an instant ramp produces.
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(step.peakGain, when + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + step.duration);
    osc.connect(gain).connect(context.destination);
    osc.start(when);
    osc.stop(when + step.duration + 0.01);
    when += step.duration;
  }
}

/**
 * Subtle attention "tock" — short, mid-frequency, woody. Played
 * BEFORE TTS reads a validation alert / ask_user. Mirrors iOS system
 * sound 1007 (AlertManager.swift:1424).
 */
export function playAttentionTone(): void {
  // Single ~80ms triangle burst at 720Hz with a quick decay — sounds
  // like a soft wooden tock without being percussive.
  playSequence([
    { startFreq: 720, endFreq: 720, duration: 0.08, peakGain: 0.18, type: 'triangle' },
  ]);
}

/**
 * Two-note positive chime — bright, ascending, ~150ms total. Played
 * AFTER an alert resolves via tap-accept or voice correction.
 * Mirrors iOS system sound 1025 (AlertManager.swift:1430).
 */
export function playConfirmationChime(): void {
  playSequence([
    { startFreq: 1320, endFreq: 1320, duration: 0.07, peakGain: 0.16, type: 'sine' },
    { startFreq: 1760, endFreq: 1760, duration: 0.09, peakGain: 0.18, type: 'sine' },
  ]);
}

// ────────────────────────────────────────────────────────────────────────
// "Sent for processing" chime — WS3 item 7 (2026-07-02).
//
// Sample-accurate port of iOS `DeepgramRecordingViewModel.makeChimeWAVData()`
// (:209-232): 960 Hz sine, 80 ms total, 10 ms linear attack ramp then
// `exp(-(t - attack) * 20)` decay, amplitude 0.5, 22.05 kHz mono. Chosen by
// Derek 2026-06-01 (Issue 3): 960 Hz is the iPhone tri-tone send anchor —
// warmer than 880 Hz in ambient CU-cupboard environments; the 80 ms decay
// confirms "received and processing" without lingering past the inspector's
// next syllable.
//
// Played ONLY when a transcript passes the forward-gate
// (transcript-gate.ts) and is sent to the backend — the audible contract
// is "chime = we committed to processing; silence = heard but won't
// extract". Also reused by the tour's "conversational + tone" step, which
// teaches this exact sound (absorbed from WS6's interim
// web/src/lib/tour/tour-chime.ts local synth — WS3 item 7 owns the switch;
// never two copies of the synthesis in web/).
//
// Implementation note: unlike the oscillator+gain approach above, this
// renders exact PCM samples into an AudioBuffer — the iOS envelope (linear
// attack + exponential decay with a specific constant) is the thing being
// taught, and "close by ear" isn't good enough when the tour says "this is
// the sound". Do NOT refactor onto playSequence(); the pinned waveform
// tests will fail.
// ────────────────────────────────────────────────────────────────────────

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

/**
 * Play the "sent for processing" chime once. Fail-quiet like the other
 * tones — no AudioContext (SSR, jsdom, pre-gesture iOS Safari) means
 * silence, never a throw. Recording starts with a tap, so the context is
 * gesture-unlocked by the time a gate-pass can occur.
 */
export function playSentForProcessingChime(): void {
  const context = getContext();
  if (!context) return;
  if (context.state === 'suspended') {
    void context.resume().catch(() => {});
  }
  try {
    const samples = synthesiseChimeSamples();
    const buffer = context.createBuffer(1, samples.length, CHIME_SAMPLE_RATE);
    // `.set` instead of `copyToChannel` — TS 5.7's generic TypedArrays
    // type the latter's parameter as Float32Array<ArrayBuffer> which a
    // plain `new Float32Array(n)` no longer satisfies structurally.
    buffer.getChannelData(0).set(samples);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start();
  } catch {
    // Non-critical audio cue — swallow (same semantics as playSequence).
  }
}

/**
 * Test-only — drop the cached AudioContext so a fresh test starts
 * without state from a prior test. The audio API itself is mocked at
 * the test-harness level; this just ensures the lazy-init path runs.
 * Covers ALL tones in this module including playSentForProcessingChime.
 */
export function __resetTonesForTests(): void {
  ctx = null;
}
