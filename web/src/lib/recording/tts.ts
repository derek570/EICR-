'use client';

/**
 * Text-to-speech wrapper — thin shim over the browser's SpeechSynthesis
 * API. Mirrors the iOS `AlertManager` TTS model exactly:
 *
 *   - `speak()` is the always-on path. iOS speaks ask_user prompts,
 *     validation alerts, voice-command responses ("Got it, X", "Moved
 *     to circuit X"), critical notifications, and tour narration via
 *     `speakAlertMessage` / `speakResponse` / `speakCriticalNotification`
 *     / `speakTourNarration` — none of which are gated by any user
 *     toggle. Mute happens at the system volume, not in-app.
 *
 *   - `speakConfirmation()` is the only path the user can mute. iOS
 *     gates `speakBriefConfirmation()` ("Set Zs to 0.44 on circuit 3")
 *     behind `confirmationModeEnabled` (UserDefaults
 *     `confirmationModeEnabled`). The same flag is also sent to the
 *     backend as `confirmations_enabled: true|false` on every
 *     transcript so Sonnet only emits confirmation strings when the
 *     user wants them — see DeepgramRecordingViewModel.swift:1863.
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
 * until the browser has warmed the voices cache. Calling it on the
 * confirmation-toggle ON transition coaxes the `voiceschanged` event to
 * fire, after which a later speak() call produces audible output.
 *
 * Availability: guarded behind `isTtsAvailable()`. SSR + non-browser
 * contexts (jsdom without speechSynthesis polyfill) return false so the
 * caller can bail cleanly.
 *
 * Persistence: `getConfirmationModeEnabled` / `setConfirmationModeEnabled`
 * read/write `localStorage['cm-confirmation-mode']`. The key is
 * namespaced so parallel CertMate subsystems can't collide. A one-shot
 * migration on first read lifts any pre-existing value from the legacy
 * `cm-voice-feedback` key (which used to gate ALL speech, before this
 * file matched the iOS scope).
 */

const STORAGE_KEY = 'cm-confirmation-mode';
/** Pre-parity name. Read once on first access for users who toggled
 *  voice feedback on under the old all-or-nothing semantics; their
 *  preference still applies under the new (narrower) confirmation
 *  toggle. Removed in a future cleanup. */
const LEGACY_STORAGE_KEY = 'cm-voice-feedback';

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
 * Read the persisted confirmation-mode preference. Defaults to `false`
 * when storage has no entry — matches iOS where the toggle is off until
 * the inspector explicitly enables it.
 *
 * Migration: if the new key is unset and the legacy `cm-voice-feedback`
 * key has a value, lift it across once and rewrite under the new key.
 * That preserves the choice of any user who already toggled voice
 * feedback on under the old all-or-nothing semantics — the new
 * confirmation-only scope is strictly narrower so there's no surprise.
 */
export function getConfirmationModeEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const current = window.localStorage.getItem(STORAGE_KEY);
    if (current !== null) return current === 'true';
    const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy !== null) {
      window.localStorage.setItem(STORAGE_KEY, legacy);
      return legacy === 'true';
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Persist the confirmation-mode preference. Writes `"true"` / `"false"`
 * so the stored value round-trips through `JSON.parse` in any
 * diagnostic dashboard. Swallows storage errors (quota exceeded,
 * disabled cookies) since confirmation-off is a safe fallback.
 */
export function setConfirmationModeEnabled(enabled: boolean): void {
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

interface SpeakOptions {
  /** Bypass any internal preference check. Used by `speakConfirmation`
   *  for the ON-transition preview so the inspector hears their toggle
   *  work even though the new value hasn't been re-read yet. */
  force?: boolean;
  lang?: string;
  onEnd?: () => void;
}

/**
 * Internal: queue an utterance unconditionally. `speak` and
 * `speakConfirmation` both go through this; the only difference is the
 * preference gate on the confirmation entry point.
 */
function dispatch(text: string, options?: SpeakOptions): void {
  const trimmed = text?.trim();
  if (!trimmed) {
    options?.onEnd?.();
    return;
  }
  try {
    // Cancel whatever is speaking — keeps the speech current rather than
    // letting it backlog stale lines.
    window.speechSynthesis.cancel();
    const utterance = new window.SpeechSynthesisUtterance(trimmed);
    utterance.lang = options?.lang ?? 'en-GB';
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;
    const voice = pickVoice();
    if (voice) utterance.voice = voice;
    if (options?.onEnd) {
      utterance.onend = () => options.onEnd?.();
      // Some browsers fire `onerror` instead of `onend` on cancel; the
      // tour controller calls cancelSpeech() on every step change so a
      // missing end-event would stall auto-advance. `onerror` fallback.
      utterance.onerror = () => options.onEnd?.();
    }
    window.speechSynthesis.speak(utterance);
  } catch {
    // Swallow — TTS failures should never interrupt recording.
    options?.onEnd?.();
  }
}

/**
 * Always-on speech path. Speaks regardless of the confirmation-mode
 * toggle — used for ask_user prompts, validation alerts, voice-command
 * responses, and tour narration. Mirrors iOS `speakAlertMessage` /
 * `speakResponse` / `speakTourNarration` which run unconditionally
 * through `speakWithTTS`.
 *
 * Silently no-ops when TTS is unavailable (SSR, non-browser, or a
 * runtime without SpeechSynthesis). The `onEnd` callback fires
 * synchronously in that case so callers (the tour controller) don't
 * stall.
 */
export function speak(text: string, options?: SpeakOptions): void {
  if (!isTtsAvailable()) {
    options?.onEnd?.();
    return;
  }
  dispatch(text, options);
}

/**
 * Confirmation-mode-gated speech path. Only speaks when the inspector
 * has the confirmation-mode toggle ON (or the caller passes
 * `force: true` for the toggle preview). Mirrors iOS
 * `speakBriefConfirmation` which is the sole gated path on iOS.
 *
 * Server-side gating is paired with this client-side gating: the
 * matching `confirmations_enabled: true|false` flag is sent to the
 * backend on every `transcript` so Sonnet only emits confirmations the
 * client is willing to speak.
 */
export function speakConfirmation(text: string, options?: SpeakOptions): void {
  if (!isTtsAvailable()) {
    options?.onEnd?.();
    return;
  }
  const enabled = options?.force ? true : getConfirmationModeEnabled();
  if (!enabled) {
    // Muted — fire the end callback synchronously so any caller waiting
    // on speech end (none today, but symmetric with `speak`) doesn't
    // stall.
    options?.onEnd?.();
    return;
  }
  dispatch(text, options);
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
