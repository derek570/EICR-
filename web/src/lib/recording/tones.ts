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

/**
 * Test-only — drop the cached AudioContext so a fresh test starts
 * without state from a prior test. The audio API itself is mocked at
 * the test-harness level; this just ensures the lazy-init path runs.
 */
export function __resetTonesForTests(): void {
  ctx = null;
}
