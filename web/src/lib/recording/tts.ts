'use client';

import {
  cancelElevenLabs,
  isElevenLabsAvailable,
  getActiveSessionId,
  primeAudioElement,
  prepareElevenLabs,
  speakElevenLabs,
  type ElevenLabsFailureReason,
} from './elevenlabs-tts';
import {
  enqueueConfirmation,
  preemptFlush as ttsQueuePreemptFlush,
  reset as ttsQueueReset,
  type QueuePlayControls,
} from './tts-queue';
import { clientDiagnostic } from './client-diagnostic';

/**
 * Text-to-speech wrapper — ElevenLabs primary, browser SpeechSynthesis
 * fallback. Mirrors the iOS `AlertManager` TTS model exactly:
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
 * Two paths, mirroring iOS AlertManager Phase 7.1 (`AlertManager.swift:236`):
 *   - `speakConfirmation()` — read-backs — are FIFO-QUEUED via `tts-queue.ts`
 *     so rapid back-to-back confirmations (a Sonnet turn can acknowledge
 *     several field fills at once) play IN ORDER, one at a time. iOS does NOT
 *     cancel between confirmations; it queues them. The earlier prose here
 *     claimed "iOS cancels … we mirror that for parity" — that was FACTUALLY
 *     WRONG and was the root of the field bug where a two-circuit turn read
 *     back only the last circuit (the first was aborted 5ms in). Audio-First
 *     invariant #1 ("every dictated reading read back, exactly once, never
 *     zero") requires the queue.
 *   - `speak()` — ask_user prompts / validation alerts / tour narration — stay
 *     on the DIRECT path (no FIFO), matching iOS's separate `speakWithTTS` +
 *     single `deferredTTS` slot. A direct prompt is more urgent than a queued
 *     read-back, so `speak()` PREEMPTS the confirmation queue (`preemptFlush()`)
 *     before dispatching. Routing an `ask_user` through the FIFO would make a
 *     "which circuit?" question wait behind up to 6 queued read-backs.
 *   - `cancelElevenLabs()` / `speechSynthesis.cancel()` are the low-level
 *     cancel-before-replace PRIMITIVES, still used by the queue's teardown
 *     paths and the direct `speak()` preempt/barge-in — not by a per-
 *     confirmation cancel.
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

export interface SpeakOptions {
  /** Bypass any internal preference check. Used by `speakConfirmation`
   *  for the ON-transition preview so the inspector hears their toggle
   *  work even though the new value hasn't been re-read yet. */
  force?: boolean;
  lang?: string;
  /** Confirmation dedupe key — forwarded into the FIFO so the queue can
   *  un-record it via `onDiscarded` if the confirmation is discarded before
   *  it ever plays (overflow / preempt / purge / reset). */
  dedupeKey?: string;
  /** Fired when real audio begins (ElevenLabs `playing` / native
   *  `utterance.onstart`). Load-bearing for the FIFO's `startedPlayback` flag
   *  and the direct-audio-owner tracking. */
  onStart?: () => void;
  onEnd?: () => void;
  /** Fired on a terminal error (`'aborted'` on supersede/preempt, native
   *  synth error, etc.). Threaded so the direct-prompt owner/ref can be
   *  cleared token-guarded on the abort path (which does NOT fire `onEnd`). */
  onError?: (reason?: unknown) => void;
}

/**
 * Which path owns the currently-live audio channel — the direct `speak()`
 * path or the confirmation FIFO. Token-guarded so a superseding dispatch's
 * synchronous prior-`onEnd` (fired by `cancelElevenLabs()`) can't null the
 * owner just set for the NEW prompt.
 *
 * - `dispatch()` is the SOLE place that sets `'direct'` (synchronously, at
 *   entry, when `caller === 'speak'`, before the fetch) so the flag is
 *   `'direct'` throughout the pre-audio fetch window — the window a fast
 *   `cancel_pending_tts` arrives in.
 * - The FIFO player sets `'queue'` from its playback `onStart`.
 * - Every clear is token-guarded (a terminal only clears if its token still
 *   matches); a full teardown (`cancelSpeech({resetQueue:true})`) clears
 *   unconditionally because it tears everything down synchronously.
 */
let activeAudioOwner: { owner: 'direct' | 'queue'; token: symbol } | null = null;

/** True iff a direct `speak()` prompt owns the audio channel (playing OR still
 *  fetching). Read live by recording-context's confirmation-deferral gate so a
 *  lower-priority confirmation doesn't cut off an in-flight ask_user prompt. */
export function isDirectAudioActive(): boolean {
  return activeAudioOwner?.owner === 'direct';
}

/**
 * TTS audio window — wall-clock { startMs, endMs } for the most-recent
 * utterance the wrapper dispatched. Mirrors iOS
 * `AlertManager.ttsAudioStartAt` / `ttsAudioEndAt`
 * (AlertManager.swift:113–119). The recording-context queries this via
 * `getTtsAudioWindow()` to discard final transcripts that arrived
 * while the device's own TTS was audible — without that gate the mic
 * picks up the spoken question/response and Deepgram emits a
 * transcript that loops back into Sonnet as if the inspector said it.
 *
 * Closed-window contract: while TTS is actively speaking the field is
 * `{ startMs, endMs: null }`. Once the utterance finishes (or the
 * synthesizer fires `onerror`/`onpause`) the field becomes
 * `{ startMs, endMs }` and stays that way until either the next
 * `dispatch()` overwrites it or `cancelSpeech()` clears it. The 300ms
 * post-end cooldown lives at the consumer because callers want to
 * decide their own grace policy (mirrors iOS AlertManager.swift:127
 * where the cooldown is also a consumer-side decision).
 */
let ttsWindow: { startMs: number; endMs: number | null } | null = null;

/**
 * Lifecycle observer — called with `'start'` when ttsWindow opens
 * (audio begins flowing) and `'end'` when it closes (utterance ended /
 * superseded / errored). Mirrors iOS where AlertManager.swift fires
 * `sessionCoordinator.sleepManager.onTTSStarted()` / `onTTSFinished()`
 * at exactly these moments (DeepgramRecordingViewModel.swift:813, 866)
 * so the no-transcript timer is suspended while the device's own
 * speaker is producing artificial silence on the mic. Without an
 * observer hook on web, the SleepManager kept its 60s timer running
 * through a 5-8s TTS question + the inspector's think-time, fired
 * sleep entry mid-conversation, and tore down Deepgram + Sonnet
 * exactly when the inspector started speaking their answer.
 *
 * Default: null (no observer wired — keeps the module unit-testable
 * in isolation and the tour controller can use TTS without a sleep
 * manager). Registered/cleared by recording-context.tsx at session
 * boundaries.
 */
let ttsLifecycleObserver: ((event: 'start' | 'end') => void) | null = null;

/**
 * Register a TTS lifecycle observer. Pass `null` to clear. Recording
 * sessions register an observer that forwards to
 * `sleepManager.setTtsActive(active)` so the no-transcript timer is
 * suspended while TTS plays. Idempotent — re-registering replaces the
 * previous observer rather than chaining (the recording session is
 * the sole expected consumer).
 */
export function setTtsLifecycleObserver(observer: ((event: 'start' | 'end') => void) | null): void {
  ttsLifecycleObserver = observer;
}

/**
 * Internal helper — fires the observer if any. Wrapped in try/catch so
 * a bad consumer can't blow up the TTS path (every call to this is
 * inside an audio-element / SpeechSynthesisUtterance lifecycle handler
 * where throwing would be a silent failure mode anyway).
 */
function notifyTtsLifecycle(event: 'start' | 'end'): void {
  try {
    ttsLifecycleObserver?.(event);
  } catch {
    /* swallow */
  }
}

/**
 * TTS fingerprint echo gate — port of iOS
 * `recentTTSFingerprints` + `isTTSEcho()`
 * (DeepgramRecordingViewModel.swift:156, 2776, 2823).
 *
 * Every dispatched TTS phrase registers a fingerprint (word Set) with a
 * 15-second expiry. `isTTSEcho(transcript)` then checks whether a
 * subsequently-arrived final transcript word-overlaps an active
 * fingerprint above the iOS-canonical threshold:
 *
 *   - Short fingerprints (≤2 words) OR short transcripts (≤2 words):
 *     exact subset match — every TTS word must appear in the
 *     transcript OR vice versa.
 *   - Otherwise: >70 % word-Set overlap of transcript against TTS,
 *     iOS line 2842 verbatim. The 70 % bound is calibrated so a
 *     natural answer like "that was for circuit three" replying to
 *     "which circuit was that reading for?" doesn't trip — the
 *     answer shares only "that", "was", "for", "circuit" with the
 *     fingerprint, falling under 70 %.
 *
 * Used by recording-context.tsx's onFinalTranscript handler AFTER the
 * wall-clock TTS-window gate so a self-feedback final that arrived
 * outside the wall-clock window (delayed by Deepgram processing) but
 * was inside the 15-second fingerprint window still gets dropped.
 * Without this, the user reported "the page keeps asking the same
 * question only about the very first part of an utterance" — the mic
 * picked up its own question through the speaker, Deepgram transcribed
 * fragments, and Sonnet treated those fragments as the inspector's
 * answer.
 */
interface TtsFingerprint {
  words: Set<string>;
  expiry: number;
}

let recentTtsFingerprints: TtsFingerprint[] = [];

const TTS_FINGERPRINT_TTL_MS = 15_000;
const TTS_FINGERPRINT_OVERLAP_THRESHOLD = 0.7;

/** Lower-cases + word-splits the text and registers a fingerprint with
 *  the 15-second TTL. No-op for empty / whitespace-only text. iOS canon
 *  doesn't filter short phrases (line 2778 comment: "removed 3-word
 *  minimum") — even one-word confirmations like "Updated" register so
 *  a deepgram echo of just "Updated" gets caught. */
function registerTtsFingerprint(text: string): void {
  const trimmed = text?.trim().toLowerCase();
  if (!trimmed) return;
  const words = new Set(trimmed.split(/\s+/).filter(Boolean));
  if (words.size === 0) return;
  recentTtsFingerprints.push({ words, expiry: Date.now() + TTS_FINGERPRINT_TTL_MS });
}

function isSubsetOf(a: Set<string>, b: Set<string>): boolean {
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/**
 * Returns true iff `transcript` likely echoes a recently-dispatched
 * TTS phrase. Pruning of expired fingerprints happens lazily on every
 * call, so callers don't need to schedule cleanup separately. Mirrors
 * iOS isTTSEcho (DeepgramRecordingViewModel.swift:2823).
 */
export function isTTSEcho(transcript: string): boolean {
  const now = Date.now();
  if (recentTtsFingerprints.length > 0) {
    recentTtsFingerprints = recentTtsFingerprints.filter((fp) => fp.expiry >= now);
  }
  if (recentTtsFingerprints.length === 0) return false;
  const transcriptWords = new Set(transcript.toLowerCase().split(/\s+/).filter(Boolean));
  if (transcriptWords.size === 0) return false;
  for (const fp of recentTtsFingerprints) {
    if (fp.words.size <= 2 || transcriptWords.size <= 2) {
      if (isSubsetOf(fp.words, transcriptWords) || isSubsetOf(transcriptWords, fp.words)) {
        return true;
      }
      continue;
    }
    let overlap = 0;
    for (const w of transcriptWords) if (fp.words.has(w)) overlap++;
    const ratio = overlap / transcriptWords.size;
    if (ratio > TTS_FINGERPRINT_OVERLAP_THRESHOLD) return true;
  }
  return false;
}

/** Test-only — clear the fingerprint state between tests. */
export function __resetTtsFingerprintsForTests(): void {
  recentTtsFingerprints = [];
}

/** Test-only — register a fingerprint without going through dispatch().
 *  Production callers register via dispatch() automatically; tests use
 *  this so they can pin isTTSEcho behaviour without driving the full
 *  speechSynthesis polyfill. */
export function __registerTtsFingerprintForTests(text: string): void {
  registerTtsFingerprint(text);
}

/**
 * Read the TTS audio window. Returns null when no utterance has been
 * dispatched yet — equivalent to "TTS is silent, transcripts can flow
 * through unconditionally". Callers that want to detect "currently
 * speaking" check `endMs === null`; callers that want to gate on a
 * post-end cooldown compare `now - endMs < cooldownMs`.
 */
export function getTtsAudioWindow(): { startMs: number; endMs: number | null } | null {
  return ttsWindow;
}

/**
 * Returns true iff a transcript that arrived at `nowMs` (default
 * `Date.now()`) overlaps either the active TTS audio OR the
 * `cooldownMs` cooldown window after TTS finished. Default cooldown
 * is 300ms, matching iOS's `audioPlayer` 300ms cooldown
 * (AlertManager.swift:127). Used by recording-context's
 * `onFinalTranscript` handler to discard mic-self-feedback transcripts.
 */
export function isWithinTtsWindow(cooldownMs = 300, nowMs = Date.now()): boolean {
  if (!ttsWindow) return false;
  if (ttsWindow.endMs == null) return true; // currently speaking
  return nowMs - ttsWindow.endMs < cooldownMs;
}

/**
 * Internal: queue an utterance unconditionally. `speak` and
 * `speakConfirmation` both go through this; the only difference is the
 * preference gate on the confirmation entry point.
 *
 * Routing — ElevenLabs first, SpeechSynthesis fallback:
 * - When the recording-context has set an active sessionId AND the
 *   runtime supports HTMLAudioElement, we POST to
 *   /api/proxy/elevenlabs-tts and play the resulting Archer
 *   Conversational MP3. Mirrors iOS `speakWithTTS` (AlertManager.swift:
 *   1029) which has used ElevenLabs as primary since 2026-02 with a 12s
 *   timeout and Apple-native fallback.
 * - On any pre-playback failure (no session, no auth, fetch error,
 *   timeout, offline) we degrade to `dispatchNative` — the original
 *   SpeechSynthesis path with its closeWindow guard.
 * - Once ElevenLabs audio actually starts playing, mid-playback errors
 *   close the window and resolve the speech without re-speaking via
 *   native — falling back at that point would replay the entire
 *   utterance from the start, which is worse than just stopping.
 */
function dispatch(
  text: string,
  options?: SpeakOptions,
  caller: 'speak' | 'speakConfirmation' | 'unknown' = 'unknown'
): void {
  const trimmed = text?.trim();
  if (!trimmed) {
    clientDiagnostic('tts_dispatch_empty', { caller });
    options?.onEnd?.();
    return;
  }

  const elevenLabsAvailable = isElevenLabsAvailable();
  const sessionId = getActiveSessionId();
  clientDiagnostic('tts_dispatch', {
    caller,
    textLength: trimmed.length,
    textPreview: trimmed.slice(0, 80),
    elevenLabsAvailable,
    hasActiveSessionId: Boolean(sessionId),
    route: elevenLabsAvailable && sessionId ? 'elevenlabs' : 'native',
  });

  // Register the fingerprint BEFORE dispatch so a Deepgram transcript
  // that arrives microseconds after the speaker starts playing already
  // has the fingerprint available to match against. iOS registers at
  // exactly the same lifecycle point (DeepgramRecordingViewModel.swift:2776
  // call site is inside speakWithTTS, right before the synthesizer
  // starts).
  registerTtsFingerprint(trimmed);

  // Direct `speak()` path OWNS the audio channel. Set the owner SYNCHRONOUSLY
  // here (the SOLE `'direct'` set-site) — before the ElevenLabs/native
  // dispatch, so the flag is `'direct'` throughout the pre-audio fetch window
  // (when a fast `cancel_pending_tts` / barge-in arrives). Token-guarded so a
  // superseding dispatch's synchronous prior-onEnd can't null the new prompt's
  // owner. Cleared on the wrapped terminal (onEnd/onError, incl. the abort
  // path) below.
  if (caller === 'speak') {
    const token = Symbol('direct');
    activeAudioOwner = { owner: 'direct', token };
    const clearIfMine = () => {
      if (activeAudioOwner?.token === token) activeAudioOwner = null;
    };
    const wrapped: SpeakOptions = {
      force: options?.force,
      lang: options?.lang,
      dedupeKey: options?.dedupeKey,
      onStart: options?.onStart,
      onEnd: () => {
        clearIfMine();
        options?.onEnd?.();
      },
      onError: (reason) => {
        clearIfMine();
        options?.onError?.(reason);
      },
    };
    if (elevenLabsAvailable && sessionId) dispatchElevenLabs(trimmed, wrapped);
    else dispatchNative(trimmed, wrapped);
    return;
  }

  if (elevenLabsAvailable && sessionId) {
    dispatchElevenLabs(trimmed, options);
    return;
  }
  dispatchNative(trimmed, options);
}

/**
 * Speak via ElevenLabs proxy. Owns the same `ttsWindow` lifecycle the
 * native path manages, but the open-edge fires inside the audio
 * element's `playing` event (the iOS-aligned "actual audio is now
 * flowing" moment) rather than at dispatch time. The closeWindow guard
 * uses the same `myStartMs`-as-identity pattern as the native path,
 * so the same regression contract holds: a stale onEnd from a
 * superseded request can't corrupt a fresh window.
 */
function dispatchElevenLabs(text: string, options?: SpeakOptions): void {
  // Cancel any in-flight native utterance — concurrent native + ElevenLabs
  // would step on each other audibly. The matching cancel inside
  // speakElevenLabs() handles the prior ElevenLabs request.
  try {
    window.speechSynthesis.cancel();
  } catch {
    /* ignore */
  }

  let myStartMs: number | null = null;

  speakElevenLabs(text, {
    onStart: () => {
      // Audio element fired `playing` — open the window now so the
      // mic-feedback gate suppresses the speaker self-feedback.
      myStartMs = Date.now();
      ttsWindow = { startMs: myStartMs, endMs: null };
      notifyTtsLifecycle('start');
    },
    onEnd: () => {
      if (myStartMs != null && ttsWindow && ttsWindow.startMs === myStartMs) {
        ttsWindow = { startMs: myStartMs, endMs: Date.now() };
        notifyTtsLifecycle('end');
      }
      options?.onEnd?.();
    },
    onError: (reason: ElevenLabsFailureReason) => {
      if (myStartMs != null) {
        clientDiagnostic('tts_elevenlabs_mid_playback_error', { reason });
        // Mid-playback error — close the window and resolve. Don't
        // re-speak via native; the inspector heard the start of the
        // line and a second full read would just be confusing.
        if (ttsWindow && ttsWindow.startMs === myStartMs) {
          ttsWindow = { startMs: myStartMs, endMs: Date.now() };
          notifyTtsLifecycle('end');
        }
        options?.onEnd?.();
        return;
      }
      // Pre-playback failure — fall back to native so the inspector
      // still hears the line in the OS voice. `reason` is informational;
      // every reason except 'aborted' should fall back. Aborted means
      // a fresh dispatch superseded us, so the new dispatch will own
      // the window — calling dispatchNative here would race against it.
      if (reason === 'aborted') {
        clientDiagnostic('tts_elevenlabs_aborted', {});
        // Fire onError('aborted') so a direct-prompt owner/ref wrapper
        // (dispatch's `caller==='speak'` branch) clears — the abort path
        // otherwise returns WITHOUT any terminal, leaving a stale 'direct'
        // owner that would then swallow the NEXT prompt's cancel.
        options?.onError?.('aborted');
        return;
      }
      clientDiagnostic('tts_elevenlabs_fallback_to_native', {
        reason,
        textPreview: text.slice(0, 80),
      });
      dispatchNative(text, options);
    },
  });
}

/**
 * Speak via the browser's SpeechSynthesis. Used both as the primary
 * path when ElevenLabs isn't available (no session, SSR, missing
 * Audio element) and as the fallback when an ElevenLabs request fails
 * before audio playback begins.
 */
function dispatchNative(text: string, options?: SpeakOptions): void {
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

    // Open the TTS window. iOS opens it inside `markTTSStarted()` at the
    // moment audio actually plays; on web we approximate by stamping it
    // when `speak()` is dispatched and re-stamping inside `onstart` for
    // tighter alignment. The mic-feedback gate uses this START time as
    // the lower bound when discarding transcripts.
    //
    // Identity is tracked through `myStartMs` (a closure-captured number
    // that the closeWindow guard compares against `ttsWindow.startMs`).
    // We previously captured a single `openedAt` and used it as both the
    // identity AND the timestamp; once `onstart` re-stamped startMs to
    // the playback time, the guard `ttsWindow.startMs === openedAt`
    // failed forever and `endMs` never got set — so `isWithinTtsWindow()`
    // returned `true` until the next dispatch, which silently dropped
    // every subsequent final transcript at the recording-context gate.
    // Tracking myStartMs separately so it gets updated atomically with
    // the window keeps the guard correct across the onstart re-stamp.
    let myStartMs = Date.now();
    ttsWindow = { startMs: myStartMs, endMs: null };
    notifyTtsLifecycle('start');

    const closeWindow = () => {
      // Only close if we still own this window — a fresh dispatch will
      // have overwritten it with a new startMs already, in which case
      // overwriting endMs would corrupt the new window's "currently
      // speaking" signal.
      if (ttsWindow && ttsWindow.startMs === myStartMs) {
        ttsWindow = { startMs: myStartMs, endMs: Date.now() };
        notifyTtsLifecycle('end');
      }
    };

    utterance.onstart = () => {
      // Re-stamp startMs at the actual playback moment for tighter
      // alignment with iOS — synthesis can hold the utterance for tens
      // of ms before audio begins, especially on iOS Safari after a
      // voiceschanged event. Update both `myStartMs` and `ttsWindow`
      // together so the closeWindow guard still matches when `onend`
      // fires later.
      if (ttsWindow && ttsWindow.startMs === myStartMs && ttsWindow.endMs == null) {
        myStartMs = Date.now();
        ttsWindow = { startMs: myStartMs, endMs: null };
      }
      // Fire onStart AFTER the ttsWindow restamp. Load-bearing for the FIFO:
      // on iPhone/iPad Safari the native path is the DEFAULT until the
      // ElevenLabs gesture grant fires, so a native confirmation head must set
      // `startedPlayback` from THIS event or a heard confirmation is un-
      // recorded on teardown and double-read on re-emit.
      options?.onStart?.();
    };
    utterance.onend = () => {
      closeWindow();
      options?.onEnd?.();
    };
    // Some browsers fire `onerror` instead of `onend` on cancel; the
    // tour controller calls cancelSpeech() on every step change so a
    // missing end-event would stall auto-advance. When an explicit
    // `onError` is supplied (direct-prompt / FIFO wiring) fire that so the
    // owner/ref clears; otherwise fall back to `onEnd` (tour auto-advance).
    utterance.onerror = () => {
      closeWindow();
      if (options?.onError) options.onError('native-error');
      else options?.onEnd?.();
    };
    window.speechSynthesis.speak(utterance);
  } catch {
    // Swallow — TTS failures should never interrupt recording.
    options?.onEnd?.();
  }
}

/**
 * Prime SpeechSynthesis from inside a user-gesture handler. iOS Safari
 * (and PWAs in standalone mode especially) refuses the first `speak()`
 * of a page lifecycle unless it lands inside a click/touchend/keydown
 * handler — without this, the FIRST `ask_user` question fires when
 * Sonnet asks something well after the user gesture window has closed,
 * iOS swallows it, and the inspector sees the question on screen with
 * no audio.
 *
 * This is the web analogue of iOS's `AudioSessionManager.setupSession()`
 * call at `RecordingSessionCoordinator.swift:149`, which configures
 * `.playAndRecord` at the same lifecycle moment (Start Recording tap)
 * to unlock the audio output path. Different mechanism, same intent:
 * unlock TTS at the user gesture that begins recording so the always-on
 * `speak()` path used for `ask_user` plays audibly without further
 * setup.
 *
 * Mechanism: `getVoices()` coaxes the `voiceschanged` event so
 * `pickVoice()` returns non-null on the first real `speak()`, AND a
 * silent (`volume=0`) one-space utterance satisfies the
 * autoplay-on-gesture rule. The utterance bypasses `dispatch()` so it
 * does NOT cancel any in-flight tour narration and does NOT open the
 * mic-feedback `ttsWindow` (which would otherwise suppress legitimate
 * transcripts during the priming fraction of a second).
 *
 * Safe to call repeatedly — subsequent priming calls are no-ops at the
 * audio level on iOS, and the silent utterance is dropped by every
 * browser within a few ms.
 *
 * MUST be called synchronously from a user-gesture handler (click,
 * touchend, keydown). The gesture grant does NOT survive across
 * `await` boundaries, so callers should invoke this BEFORE any async
 * work in the handler.
 */
export function primeTts(): void {
  if (!isTtsAvailable()) {
    clientDiagnostic('primeTts_skipped_unavailable', {});
    return;
  }
  let synthesisOk = false;
  try {
    // Coax the voices cache to populate (iOS Safari returns [] until
    // after the first `voiceschanged` event fires).
    window.speechSynthesis.getVoices();
    // Silent utterance — text=' ' because empty strings are rejected by
    // some browsers; volume=0 so even if the engine produces audio it's
    // inaudible. The gesture grant transfers to subsequent speak()
    // calls within this page lifecycle.
    const utterance = new window.SpeechSynthesisUtterance(' ');
    utterance.volume = 0;
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    window.speechSynthesis.speak(utterance);
    synthesisOk = true;
  } catch {
    // Swallow — priming is best-effort, never block recording start.
  }
  clientDiagnostic('primeTts', { synthesisOk });
  // Also prime the shared `<audio>` element. iOS Safari requires the
  // first `play()` on each element to land inside a user-gesture
  // handler; without this, the FIRST ElevenLabs payload arrives well
  // after the gesture window has closed and `audio.play()` rejects
  // with NotAllowedError. The element is reused for every subsequent
  // ElevenLabs utterance, so a single prime per Start tap unlocks the
  // whole session.
  primeAudioElement();
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
  clientDiagnostic('tts_speak_called', {
    textLength: typeof text === 'string' ? text.length : 0,
    textPreview: typeof text === 'string' ? text.slice(0, 80) : '',
  });
  if (!isTtsAvailable()) {
    clientDiagnostic('tts_speak_skipped_unavailable', {});
    options?.onEnd?.();
    return;
  }
  // A direct prompt is more urgent than a queued read-back — PREEMPT the
  // confirmation FIFO before dispatching so the question plays with nothing
  // racing behind it. preemptFlush() empties the queue deterministically and
  // un-records (via onDiscarded) any still-unplayed confirmations so the
  // backend can re-speak them on a later re-emit. This runs BEFORE dispatch()
  // sets the 'direct' owner (preemptFlush touches queue state only). In a
  // mixed apply+ask turn the flushed confirmations are dropped unless the
  // backend re-emits — iOS-canonical (resetQueueAfterInterrupt) but NOT an
  // absolute "never zero read-back" guarantee; the count is surfaced so the
  // drop is monitorable in CloudWatch.
  const discardedCount = ttsQueuePreemptFlush();
  if (discardedCount > 0) {
    clientDiagnostic('tts_speak_preempted_confirmation', { discarded_count: discardedCount });
  }
  dispatch(text, options, 'speak');
}

/**
 * The injected FIFO player for a confirmation head. Replicates `dispatch()`'s
 * responsibilities so echo-suppression + ElevenLabs-primary/native-fallback +
 * the mic-feedback ttsWindow stay intact (bypassing `dispatch()` would drop
 * them): (1) registers the echo-suppression fingerprint; (2) routes to
 * ElevenLabs when available+session, else native; (3) on a pre-playback
 * ElevenLabs failure (reason !== 'aborted') falls back to native. The last-mile
 * deferral gate is applied by the queue via `controls.ready(prepared)` — the
 * player fetches, hands back the prepared audio, and the queue decides
 * play-now vs park. Guarantees exactly one terminal (`onEnd` OR `onError`) per
 * head so the pump advances even when a head is aborted.
 */
function playConfirmationHead(text: string, controls: QueuePlayControls): void {
  registerTtsFingerprint(text);
  const useElevenLabs = isElevenLabsAvailable() && Boolean(getActiveSessionId());
  if (!useElevenLabs) {
    playConfirmationNative(text, controls);
    return;
  }
  // Canceller hard-aborts the in-flight fetch / stops playing ElevenLabs audio.
  controls.registerCanceller(() => {
    cancelElevenLabs();
  });
  const myToken = Symbol('queue');
  let myStartMs: number | null = null;
  prepareElevenLabs(
    text,
    {
      onStart: () => {
        // Real audio began — open the mic-feedback window PER HEAD (R1) and
        // claim the 'queue' owner from the playback moment (queue heads are
        // never targeted by cancel_pending_tts/barge-in during their fetch,
        // so onStart timing is safe here).
        myStartMs = Date.now();
        ttsWindow = { startMs: myStartMs, endMs: null };
        notifyTtsLifecycle('start');
        activeAudioOwner = { owner: 'queue', token: myToken };
        controls.onStart();
      },
      onEnd: () => {
        if (myStartMs != null && ttsWindow && ttsWindow.startMs === myStartMs) {
          ttsWindow = { startMs: myStartMs, endMs: Date.now() };
          notifyTtsLifecycle('end');
        }
        if (activeAudioOwner?.token === myToken) activeAudioOwner = null;
        controls.onEnd();
      },
      onError: (reason) => {
        // Only a MID-PLAYBACK error reaches here (pre-playback failures come
        // through the onPrepared(null, reason) path below). Close the window
        // and terminate the head so the pump advances.
        if (ttsWindow && myStartMs != null && ttsWindow.startMs === myStartMs) {
          ttsWindow = { startMs: myStartMs, endMs: Date.now() };
          notifyTtsLifecycle('end');
        }
        if (activeAudioOwner?.token === myToken) activeAudioOwner = null;
        controls.onError(reason);
      },
    },
    (prepared, reason) => {
      if (prepared) {
        controls.ready({ play: prepared.play, discard: prepared.discard });
        return;
      }
      if (reason && reason !== 'aborted') {
        // Pre-playback ElevenLabs failure → native fallback (mirror dispatch).
        playConfirmationNative(text, controls);
        return;
      }
      // Superseded/preempted before audio — terminal so the pump advances.
      controls.onError('aborted');
    }
  );
}

/** Native (SpeechSynthesis) branch of the FIFO player. No async fetch, so the
 *  last-mile gate is expressed by delaying `dispatchNative` until the queue
 *  calls `prepared.play()`. `onStart` (from `utterance.onstart`) sets
 *  `startedPlayback` + the 'queue' owner — the iPhone/iPad-Safari default. */
function playConfirmationNative(text: string, controls: QueuePlayControls): void {
  controls.registerCanceller(() => {
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
  });
  const myToken = Symbol('queue');
  controls.ready({
    play: () => {
      dispatchNative(text, {
        onStart: () => {
          activeAudioOwner = { owner: 'queue', token: myToken };
          controls.onStart();
        },
        onEnd: () => {
          if (activeAudioOwner?.token === myToken) activeAudioOwner = null;
          controls.onEnd();
        },
        onError: (reason) => {
          if (activeAudioOwner?.token === myToken) activeAudioOwner = null;
          controls.onError(reason);
        },
      });
    },
    discard: () => {
      /* nothing allocated before play() on the native path */
    },
  });
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
export function speakConfirmation(
  text: string,
  options?: SpeakOptions
): { enqueued: boolean; discardedCount: number } {
  clientDiagnostic('tts_speak_confirmation_called', {
    textLength: typeof text === 'string' ? text.length : 0,
    textPreview: typeof text === 'string' ? text.slice(0, 80) : '',
    forced: Boolean(options?.force),
  });
  // Suppressed cases are dropped BEFORE enqueue so they never occupy a queue
  // slot — `{ enqueued: false }` is honest. The dedupe key (recorded by the
  // caller) STAYS recorded for a client-suppressed confirmation by design (a
  // muted confirmation the inspector chose not to hear should not re-prompt);
  // `onDiscarded` fires ONLY for queue-side discards.
  if (!isTtsAvailable()) {
    clientDiagnostic('tts_speak_confirmation_skipped_unavailable', {});
    options?.onEnd?.();
    return { enqueued: false, discardedCount: 0 };
  }
  const enabled = options?.force ? true : getConfirmationModeEnabled();
  if (!enabled) {
    clientDiagnostic('tts_speak_confirmation_skipped_muted', {});
    // Muted — fire the end callback synchronously so any caller waiting
    // on speech end (none today, but symmetric with `speak`) doesn't stall.
    options?.onEnd?.();
    return { enqueued: false, discardedCount: 0 };
  }
  const trimmed = text?.trim();
  if (!trimmed) {
    clientDiagnostic('tts_speak_confirmation_skipped_empty', {});
    options?.onEnd?.();
    return { enqueued: false, discardedCount: 0 };
  }
  // FIFO-queue the confirmation — the pump plays one head at a time so
  // back-to-back read-backs no longer clobber each other. The injected player
  // is the thin wrapper above (ElevenLabs-primary + native-fallback + echo
  // suppression + per-head ttsWindow), NOT bare `dispatch()`.
  return enqueueConfirmation({
    text: trimmed,
    dedupeKey: options?.dedupeKey,
    play: playConfirmationHead,
    onEnd: options?.onEnd,
  });
}

/**
 * Test-only — wipe the TTS audio window so a fresh test reads `null`
 * from `getTtsAudioWindow()`. Production callers don't need this; the
 * window is naturally overwritten by each `dispatch()` call. Kept
 * underscore-prefixed to discourage accidental production use.
 */
export function __resetTtsWindowForTests(): void {
  ttsWindow = null;
  activeAudioOwner = null;
}

/**
 * Cancel in-flight speech. Two modes:
 *
 * - `resetQueue: true` (DEFAULT — stop / provider-unmount / tour step-change):
 *   a synchronous FULL teardown. Runs `ttsQueue.reset()` FIRST (it nulls
 *   `currentHeadId`/`head`/`busy` so a stray synchronous `onEnd` from the
 *   cancel below no-ops via the pump's id-guard — reset-first is REQUIRED: if
 *   a queue head is playing and we cancel BEFORE reset, its `onEnd` advances
 *   the pump and the NEXT head's fetch starts and plays AFTER stop, the exact
 *   post-stop stray-audio regression this exists to prevent), THEN cancels the
 *   direct path (`speechSynthesis.cancel()` + `cancelElevenLabs()`) and clears
 *   the owner. Not token-guarded — a full teardown tears everything down.
 *
 * - `resetQueue: false` (barge-in — `recording-context.tsx:1876`): cancel ONLY
 *   the DIRECT audio, and ONLY when the direct path owns it
 *   (`activeAudioOwner?.owner === 'direct'`). Leaves the confirmation FIFO
 *   intact — flushing it here would nuke read-backs still queued from a prior
 *   turn (zero read-back). When the QUEUE owns the audio this is a no-op
 *   against the confirmation (it finishes + advances naturally). Owner-gates
 *   BOTH backends: a direct native prompt (iPhone/iPad-Safari default) needs
 *   `speechSynthesis.cancel()`, and a queue-owned native confirmation must NOT
 *   be cut, so `owner === 'direct'` cancels both and `owner === 'queue'`
 *   cancels neither.
 */
export function cancelSpeech(opts?: { resetQueue?: boolean }): void {
  const resetQueue = opts?.resetQueue ?? true;
  if (!isTtsAvailable()) {
    // Still flush the queue on a full teardown so a stuck `busy` can't survive
    // into the next session (queue is normally empty in the SSR/no-synth case).
    if (resetQueue) ttsQueueReset();
    return;
  }
  const closeWindow = () => {
    if (ttsWindow && ttsWindow.endMs == null) {
      ttsWindow = { startMs: ttsWindow.startMs, endMs: Date.now() };
      notifyTtsLifecycle('end');
    }
  };
  if (resetQueue) {
    // FULL teardown — reset the queue FIRST (see docblock), then cancel direct.
    ttsQueueReset();
    try {
      window.speechSynthesis.cancel();
      closeWindow();
    } catch {
      // ignore
    }
    cancelElevenLabs();
    activeAudioOwner = null;
    return;
  }
  // Selective cancel (barge-in) — only when the DIRECT path owns the audio.
  if (activeAudioOwner?.owner === 'direct') {
    try {
      window.speechSynthesis.cancel();
      closeWindow();
    } catch {
      // ignore
    }
    // cancelElevenLabs fires the direct prompt's synchronous onEnd, which the
    // dispatch() wrapper uses to clear the owner + (via recording-context's
    // onEnd) the direct-prompt tool-call ref.
    cancelElevenLabs();
    activeAudioOwner = null;
  }
  // owner === 'queue' | null → no-op against the confirmation FIFO.
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
