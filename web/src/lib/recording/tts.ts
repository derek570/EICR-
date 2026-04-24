'use client';

/**
 * Text-to-speech wrapper — thin shim over the browser's SpeechSynthesis
 * API. Mirrors the iOS `AlertManager` TTS hook: short confirmations
 * ("Set polarity to pass on circuit 3") + Sonnet question read-aloud
 * (e.g. "Ring continuity on circuit 3?") during recording.
 *
 * Why a singleton + cancel-before-queue:
 *   - The inspector may produce rapid-fire confirmations (each Sonnet
 *     turn can acknowledge several field fills at once). Queueing each
 *     into the browser's utterance queue would backlog speech behind
 *     stale news. The iOS TTS cancels the current utterance before
 *     speaking a new one — we mirror that for parity.
 *   - A shared utterance object keeps voice/rate/pitch consistent across
 *     calls; constructing a fresh one per speak() would also work but
 *     this keeps diffing trivial in tests.
 *
 * iOS Safari quirk: `speechSynthesis.getVoices()` returns an empty list
 * until the browser has warmed the voices cache. Calling it on first
 * enable coaxes the `voiceschanged` event to fire, after which a later
 * speak() call produces audible output. Without the preload, the first
 * confirmation is silent on iOS.
 *
 * Availability: guarded behind `isTtsAvailable()`. SSR + non-browser
 * contexts (jsdom without speechSynthesis polyfill) return false so the
 * caller can bail cleanly.
 *
 * Persistence: `getVoiceFeedbackEnabled` / `setVoiceFeedbackEnabled`
 * read/write `localStorage['cm-voice-feedback']`. The key is namespaced
 * so parallel CertMate subsystems can't collide with a plain "tts" flag.
 */

const STORAGE_KEY = 'cm-voice-feedback';

/**
 * Returns true iff the runtime has the SpeechSynthesis API. Used by
 * callers that want to short-circuit (e.g. the Voice button in the
 * recording chrome hides itself when TTS is unavailable so inspectors
 * don't tap a dead control).
 */
export function isTtsAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as Window & { SpeechSynthesisUtterance?: unknown };
  return 'speechSynthesis' in window && typeof w.SpeechSynthesisUtterance === 'function';
}

/**
 * Read the persisted voice-feedback preference. Defaults to `false` when
 * storage has no entry — matches iOS where the toggle is off until the
 * inspector explicitly enables it.
 */
export function getVoiceFeedbackEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * Persist the voice-feedback preference. Writes `"true"` / `"false"` so
 * the stored value round-trips through `JSON.parse` in any diagnostic
 * dashboard. Swallows storage errors (quota exceeded, disabled cookies)
 * since TTS-off is a safe fallback.
 */
export function setVoiceFeedbackEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false');
    if (enabled) {
      // Warm the voices cache on enable — fixes the silent-first-speak
      // quirk on iOS Safari (getVoices returns [] until after the
      // `voiceschanged` event fires once).
      try {
        window.speechSynthesis.getVoices();
      } catch {
        // ignore — non-critical preload
      }
    }
  } catch {
    // ignore
  }
}

/**
 * Preferred voice for English-language confirmations. Uses the
 * browser's default if it can't find an en-GB voice (the iOS Siri
 * voices on Safari include "Daniel" under en-GB).
 */
function pickVoice(): SpeechSynthesisVoice | null {
  if (!isTtsAvailable()) return null;
  try {
    const voices = window.speechSynthesis.getVoices();
    if (voices.length === 0) return null;
    // Prefer en-GB, fall back to en-US, then any en-*, then the first.
    return (
      voices.find((v) => v.lang === 'en-GB') ??
      voices.find((v) => v.lang === 'en-US') ??
      voices.find((v) => v.lang.startsWith('en')) ??
      voices[0]
    );
  } catch {
    return null;
  }
}

/**
 * Speak a short confirmation. Cancels any in-flight utterance so rapid
 * confirmations don't stack — matches iOS behaviour where a later Sonnet
 * turn's confirmation replaces the previous one in the TTS queue.
 *
 * Silently no-ops when TTS is unavailable or disabled — callers can
 * dispatch without guarding and trust this to do the right thing.
 *
 * The `force` flag overrides the "enabled" preference — used for the
 * one-shot preview when the user first taps the Voice toggle ON so they
 * get audible feedback that it's working.
 */
export function speak(text: string, options?: { force?: boolean; lang?: string }): void {
  if (!isTtsAvailable()) return;
  const enabled = options?.force ? true : getVoiceFeedbackEnabled();
  if (!enabled) return;
  const trimmed = text?.trim();
  if (!trimmed) return;
  try {
    // Cancel whatever is speaking — keeps the speech current rather than
    // letting it backlog stale confirmations behind fresh ones.
    window.speechSynthesis.cancel();
    const utterance = new window.SpeechSynthesisUtterance(trimmed);
    utterance.lang = options?.lang ?? 'en-GB';
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;
    const voice = pickVoice();
    if (voice) utterance.voice = voice;
    window.speechSynthesis.speak(utterance);
  } catch {
    // Swallow — TTS failures should never interrupt recording.
  }
}

/**
 * Cancel any in-flight speech. Called on recording stop so the last
 * confirmation doesn't trail on after the inspector has ended the
 * session.
 */
export function cancelSpeech(): void {
  if (!isTtsAvailable()) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    // ignore
  }
}

/**
 * Build a human-readable confirmation line from a Sonnet extraction
 * Confirmation payload. The server sends `{text, field?, circuit?}`;
 * when `text` is empty we synthesise a line like "Set Zs to 0.44 on
 * circuit 3" from the field + circuit + value.
 *
 * Exported so tests can pin the exact wording independent of the
 * speak() plumbing.
 */
export function confirmationToSentence(payload: {
  text?: string;
  field?: string | null;
  circuit?: number | null;
  value?: string | number | boolean;
}): string {
  if (payload.text && payload.text.trim().length > 0) return payload.text.trim();
  const field = payload.field ? humaniseField(payload.field) : null;
  const value = payload.value != null ? String(payload.value) : null;
  if (!field || !value) return '';
  const circuit = payload.circuit && payload.circuit >= 1 ? ` on circuit ${payload.circuit}` : '';
  return `Set ${field} to ${value}${circuit}.`;
}

/**
 * Turn a snake_case or kebab-case field name into a speakable phrase.
 * Keeps the implementation obvious rather than pulling a humanizer
 * library — the field set is small and we own the vocabulary.
 */
function humaniseField(field: string): string {
  const specials: Record<string, string> = {
    zs: 'Zs',
    ze: 'Ze',
    pfc: 'PFC',
    r1_r2: 'R1 plus R2',
    r1r2: 'R1 plus R2',
    r2: 'R2',
    ir_live_earth: 'insulation resistance live-earth',
    ir_live_live: 'insulation resistance live-live',
    rcd_trip_time: 'RCD trip time',
    rcd_time: 'RCD time',
    ocpd_rating: 'OCPD rating',
    ocpd_type: 'OCPD type',
    polarity: 'polarity',
    earthing_arrangement: 'earthing arrangement',
  };
  const lower = field.toLowerCase();
  if (lower in specials) return specials[lower];
  return lower.replace(/_/g, ' ');
}
