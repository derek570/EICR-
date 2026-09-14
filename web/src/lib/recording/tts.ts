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
  type DiscardReason,
  type QueuePlayControls,
} from './tts-queue';
import { clientDiagnostic } from './client-diagnostic';
import { getRecordingTestServices } from './test-services';
import {
  UplinkLossDisclosureLedger,
  UPLINK_LOSS_DISCLOSURE_TEXT,
  type DisclosureToken,
} from './uplink-loss-disclosure';
import type { LossSourceId } from './uplink-loss-ledger';
import {
  HeldFragmentClarificationLedger,
  renderHeldFragmentClarification,
  HELD_FRAGMENT_CLARIFICATION_NAMED_TEMPLATE,
  HELD_FRAGMENT_CLARIFICATION_MANY_TEXT,
  type ClarificationToken,
} from './held-fragment-clarification';

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
 *   - `speakConfirmation()` is the mandatory FIFO path for accepted
 *     readings, corrections, calculations and reassignments. The stored
 *     preference controls additional prompts only; it never suppresses a
 *     dictated outcome.
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
 * PLAN-D (feedback ids 122, 124) — one unified cue wording across BOTH
 * clients (iOS speaks the identical strings). Spoken on EVERY toggle
 * flip, in both directions — the prior web behaviour only spoke on
 * ON, which this replaces ("Confirmations on." is retired). Speaking on
 * the OFF-flip too is a deliberate reversal of this file's old
 * rationale ("jarring, contradicts the preference just set"): for a
 * hands-free product the OFF-flip is precisely the moment the inspector
 * must hear one last utterance, or an accidental tap becomes
 * indistinguishable from a silently broken pipeline (the id-122/124
 * mechanism this plan fixes).
 */
export const EXTRA_PROMPTS_OFF_CUE = 'Extra prompts off. Readings still spoken.';
export const EXTRA_PROMPTS_ON_CUE = 'Extra prompts on.';
/** Session-start one-shot warning — spoken once per physical session
 *  when the persisted preference is already off at start. */
export const EXTRA_PROMPTS_START_WARNING = 'Extra prompts are off. Readings still spoken.';

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
 * Read the persisted confirmation-mode preference. Defaults to `true`
 * when NEITHER storage key has ever been set — this NOW matches iOS's
 * own default (iOS registers `confirmationModeEnabled: true` at
 * `CertMateApp.swift:29-38` precisely so new users don't start silently
 * muted). The PRIOR version of this function defaulted to `false` while
 * a comment here claimed that "matches iOS" — that claim was FALSE
 * (PLAN-D, feedback ids 122/124 — an entire 9-minute field session ran
 * with confirmations off and no telemetry/cue surfaced it, and web's
 * absent-default made that the DEFAULT experience for every new
 * inspector, not an edge case). An EXPLICITLY stored `false` is always
 * preserved as-is — this only changes the never-set case, so no
 * deliberate user choice is discarded (that's the auto-revert
 * alternative this plan explicitly rejects).
 *
 * Migration: if the new key is unset and the legacy `cm-voice-feedback`
 * key has a value, lift it across once and rewrite under the new key.
 * That preserves the choice of any user who already toggled voice
 * feedback on under the old all-or-nothing semantics — the new
 * confirmation-only scope is strictly narrower so there's no surprise.
 */
export function getConfirmationModeEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const current = window.localStorage.getItem(STORAGE_KEY);
    if (current !== null) return current === 'true';
    const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy !== null) {
      window.localStorage.setItem(STORAGE_KEY, legacy);
      return legacy === 'true';
    }
    return true;
  } catch {
    return true;
  }
}

/**
 * Persist the confirmation-mode preference. Writes `"true"` / `"false"`
 * so the stored value round-trips through `JSON.parse` in any
 * diagnostic dashboard. Swallows storage errors (quota exceeded,
 * disabled cookies); Extra prompts then retain their fail-open default.
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

/** TEST SEAM (PLAN-C). Returns the currently registered observer so a mounted
 *  harness test can fire the REAL production callback.
 *
 *  `notifyTtsLifecycle` is called from inside `playConfirmationHead`'s
 *  ElevenLabs path, which an injected harness player replaces wholesale — so
 *  no harness test can reach the lifecycle observer through playback, and the
 *  TTS-start branch of `RecordingProvider`'s observer (mic gate, Deepgram
 *  pause, PLAN-C's probe discard) had no executable production coverage at
 *  all. This accessor changes no behaviour and is read-only. */
export function __ttsLifecycleObserverForTests(): ((event: 'start' | 'end') => void) | null {
  return ttsLifecycleObserver;
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
    const harnessDirect = getRecordingTestServices()?.ttsDirectSpeak;
    if (harnessDirect) dispatchHarnessDirect(trimmed, wrapped, harnessDirect);
    else if (elevenLabsAvailable && sessionId) dispatchElevenLabs(trimmed, wrapped);
    else dispatchNative(trimmed, wrapped);
    return;
  }

  {
    const harnessDirect = getRecordingTestServices()?.ttsDirectSpeak;
    if (harnessDirect) {
      dispatchHarnessDirect(trimmed, options, harnessDirect);
      return;
    }
  }
  if (elevenLabsAvailable && sessionId) {
    dispatchElevenLabs(trimmed, options);
    return;
  }
  dispatchNative(trimmed, options);
}

/**
 * B1 harness audio backend for the DIRECT path. Keeps the REAL ttsWindow /
 * lifecycle bookkeeping (mirroring dispatchNative) while delegating the
 * actual "audio" to the injected player — so `isWithinTtsWindow`, the
 * SleepManager TTS gate, and `isDirectAudioActive` all behave exactly as
 * production during a replay. The injected player MUST fire the callbacks
 * it is given (onStart, then exactly one of onEnd/onError).
 */
function dispatchHarnessDirect(
  text: string,
  options: SpeakOptions | undefined,
  player: (text: string, options?: SpeakOptions) => void
): void {
  const myStartMs = Date.now();
  ttsWindow = { startMs: myStartMs, endMs: null };
  notifyTtsLifecycle('start');
  const closeWindow = () => {
    if (ttsWindow && ttsWindow.startMs === myStartMs) {
      ttsWindow = { startMs: myStartMs, endMs: Date.now() };
      notifyTtsLifecycle('end');
    }
  };
  try {
    player(text, {
      ...options,
      onStart: () => {
        options?.onStart?.();
      },
      onEnd: () => {
        closeWindow();
        options?.onEnd?.();
      },
      onError: (reason: unknown) => {
        closeWindow();
        if (options?.onError) options.onError(reason);
        else options?.onEnd?.();
      },
    });
  } catch {
    closeWindow();
    options?.onEnd?.();
  }
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
  // B1 harness seam: an injected direct player counts as "TTS available"
  // (jsdom has no SpeechSynthesis, and the harness must exercise the real
  // preempt/owner/window logic below).
  if (!isTtsAvailable() && !getRecordingTestServices()?.ttsDirectSpeak) {
    clientDiagnostic('tts_speak_skipped_unavailable', {});
    options?.onEnd?.();
    return;
  }
  // PLAN-E2 — once a loss-disclosure clip has STARTED playing, a new
  // direct prompt DEFERS until it completes (or until the token drops back
  // to `pending`, which releases every deferred prompt immediately —
  // before any replay). Preempting it would truncate the one clip that
  // tells a hands-free inspector audio was lost. Keyed on `playing`, not
  // on the token merely existing, so a barge-in loop can never defer
  // prompts indefinitely.
  if (uplinkLossDisclosureLedger.isPlaying) {
    deferredDirectPrompts.push({ text, options });
    clientDiagnostic('tts_speak_deferred_behind_uplink_loss_disclosure', {
      textPreview: text.slice(0, 80),
    });
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
 * them): (1) routes to ElevenLabs when available+session, else native; (2) on
 * a pre-playback ElevenLabs failure (reason !== 'aborted') falls back to
 * native; (3) registers the echo-suppression fingerprint at the actual
 * playback moment — inside the `play` callback handed to `controls.ready`,
 * not at fetch-dispatch time — so a head that ends up deferred (direct audio
 * active, or the last-mile `shouldDeferPlayback()` gate) is never marked
 * "just heard" before any audio has played. The last-mile deferral gate is
 * applied by the queue via `controls.ready(prepared)` — the player fetches,
 * hands back the prepared audio, and the queue decides play-now vs park.
 * Guarantees exactly one terminal (`onEnd` OR `onError`) per head so the pump
 * advances even when a head is aborted.
 */
function playConfirmationHead(text: string, controls: QueuePlayControls): void {
  const useElevenLabs = isElevenLabsAvailable() && Boolean(getActiveSessionId());
  if (!useElevenLabs) {
    playConfirmationNative(text, controls);
    return;
  }
  // Codex diff-review r4/r5 BLOCKER — `prepareElevenLabs()` calls
  // `cancelElevenLabs()` UNCONDITIONALLY at its own entry, before the fetch
  // and therefore before the queue's own `shouldDeferPlayback()` last-mile
  // gate (in `controls.ready`, below) ever runs. If a direct `speak()` ask
  // currently owns the channel (`isDirectAudioActive()`), calling
  // `prepareElevenLabs()` now would kill the ask's audio mid-play before
  // this head has any chance to be deferred instead — the opposite of "defer
  // behind an active ask rather than dropping". Hand the queue a LAZY
  // prepared handle that does nothing but re-enter this function on resume
  // — nothing is fetched yet, so nothing needs cancelling. The queue's own
  // `ready`-time gate sees the identical `isDirectAudioActive()` state
  // SYNCHRONOUSLY (no fetch has happened in between) and parks this as an
  // ordinary `deferredHead`, exactly like a real post-fetch deferral. When
  // `resumeIfDeferred()` later calls this lazy `play()`, the ask has ended,
  // so the recursive call falls through to the real fetch below — which
  // still gets its own last-mile check when THAT fetch completes.
  if (isDirectAudioActive()) {
    controls.ready({
      play: () => playConfirmationHead(text, controls),
      discard: () => {
        /* nothing fetched yet — no cleanup needed */
      },
    });
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
        // Codex diff-review r8 IMPORTANT — the old comment here claimed
        // "only a mid-playback error reaches here (pre-playback failures
        // come through the onPrepared(null, reason) path below)". That's
        // incomplete: a PREPARED clip whose `audio.play()` itself rejects
        // (e.g. the iOS Safari gesture grant expired between
        // isElevenLabsAvailable()'s check and this exact call) never fires
        // `onStart`, so it arrives HERE with `myStartMs` still null — a
        // genuine pre-playback failure discovered one tick later than the
        // onPrepared(null, reason) path, not a mid-playback one. Falling
        // through to `controls.onError(reason)` unconditionally silently
        // dropped the confirmation with no native fallback — a real "never
        // heard" gap. Mirror `dispatchElevenLabs`'s own onError, which
        // already makes exactly this `myStartMs`-null check and falls back
        // to native instead (Audio-First invariant #1 — never zero).
        if (myStartMs == null && reason !== 'aborted') {
          playConfirmationNative(text, controls);
          return;
        }
        // A genuine MID-PLAYBACK error (myStartMs set), or an abort/
        // supersede (reason === 'aborted', terminal regardless of
        // myStartMs — re-speaking after a supersede would fight whatever
        // superseded it). Close the window and terminate the head so the
        // pump advances.
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
        // Codex diff-review r6/r7 — register the echo-suppression fingerprint
        // right AT the actual playback moment (inside this wrapped `play`),
        // not at fetch-dispatch time above. `controls.ready`'s last-mile gate
        // (`shouldDeferPlayback()` — direct audio OR the inspector currently
        // speaking, in production) can still defer AFTER this fetch completes;
        // registering any earlier would mark the cue "just heard" for up to
        // several seconds before any audio actually plays, letting a
        // coincidentally-similar inspector utterance get wrongly suppressed
        // as an echo of something never spoken. `play` fires exactly once,
        // whether immediately or via a later `resumeIfDeferred()`.
        controls.ready({
          play: () => {
            registerTtsFingerprint(text);
            prepared.play();
          },
          discard: prepared.discard,
        });
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
 *  `startedPlayback` + the 'queue' owner — the iPhone/iPad-Safari default.
 *  Also serves as the ElevenLabs pre-playback-failure fallback (called
 *  directly from `playConfirmationHead`), so registering the echo-
 *  suppression fingerprint here — at the actual dispatch moment, inside
 *  `play` — covers both callers without a separate registration site. */
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
      registerTtsFingerprint(text);
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
 * Mandatory dictated-outcome speech path. The legacy `force` option is
 * retained for call-site compatibility, but accepted read-backs enqueue in
 * both preference states under DictatedReadbackPolicyV1.
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
  // B1 harness seam: an injected confirmation player counts as available.
  if (!isTtsAvailable() && !getRecordingTestServices()?.ttsConfirmationPlayer) {
    clientDiagnostic('tts_speak_confirmation_skipped_unavailable', {});
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
  // suppression + per-head ttsWindow), NOT bare `dispatch()`. B1 harness
  // seam: an injected confirmation player replaces ONLY the audio backend;
  // the queue (defer gate, overflow, dedupe un-record) and the
  // echo-suppression fingerprint stay real.
  const harnessPlayer = getRecordingTestServices()?.ttsConfirmationPlayer;
  return enqueueConfirmation({
    text: trimmed,
    dedupeKey: options?.dedupeKey,
    play: harnessPlayer
      ? (t, controls) => {
          registerTtsFingerprint(t);
          harnessPlayer(t, controls);
        }
      : playConfirmationHead,
    onEnd: options?.onEnd,
  });
}

// ── Confirmation-mode status cues (PLAN-D D2, feedback ids 122/124) ─────────
//
// A bare `speakConfirmation(text, {force:true})` call (this file's first
// cut) satisfies "bypasses dedupe" and "never resets the FIFO" — but NOT
// "defers behind an active ask rather than dropping": `speak()`'s
// `preemptFlush()` (a direct ask/alert taking the audio channel) and the
// queue's own overflow drop-oldest both fire `onDiscarded` unconditionally
// on every QUEUED item, and a bare `speakConfirmation` call passes no
// `dedupeKey`, so the discard is silent and the cue is gone for good — an
// inspector who flips the toggle right as the model asks a question would
// never hear the flip confirmed. This block closes that gap with the
// smallest mechanism that survives it: give the cue a dedupe key ONLY so
// the discard hook can recognise and re-enqueue it (never for true
// deduplication — each cue gets its own unique key, so back-to-back
// identical cues are never collapsed).
// ── Protected, re-parking outcome families ───────────────────────────────
//
// ONE mechanism (originally PLAN-D's mode-status cue block, generalised for
// A01P) for speech that must never be silently lost to a queue-lifecycle
// event: the item enters the ordinary confirmation FIFO with `protected:
// true` (exempt from `MAX_QUEUE_DEPTH` drop-oldest — overflow has no
// natural pacing, so a re-parked item re-evicted by the NEXT overflowing
// enqueue could thrash), carries a family-prefixed dedupe key ONLY so the
// discard hook can recognise it, and when `preemptFlush()` / `purge()` /
// overflow destroys it before it played, `handleDiscard` re-enqueues it
// from a MICROTASK (never synchronously — `preemptFlush()` and `reset()`
// fire `onDiscarded` inside a LIVE `for (const q of queue)` loop over the
// same array `enqueueConfirmation` pushes into; a synchronous re-enqueue
// re-enters that loop and cascades). `playback_error` (native AND
// ElevenLabs both failed before any audio) RETIRES instead of re-parking,
// or a broken synth backend would be retried forever. A session teardown
// (`cancelSpeech({resetQueue:true})`) clears the family's map AND bumps its
// generation BEFORE `reset()`, so neither the discard hook nor an
// already-scheduled re-park microtask (whose closure captured the text)
// resurrects the item into the next session. Playback start retires the
// tracking entry: the item was heard.
//
// Families: PLAN-D mode-status cues (fresh key per re-park, historical
// behaviour) and A01P local-command outcomes (the SAME key across re-parks
// so the caller's per-key bookkeeping — the latency stamp — survives).
type DiscardOutcome = 'reparked' | 'retired' | false;

interface ProtectedOutcomeFamily {
  readonly prefix: string;
  enqueue(text: string, dedupeKey?: string, beforeEnqueue?: (dedupeKey: string) => void): string;
  handleDiscard(dedupeKey: string, reason: DiscardReason): DiscardOutcome;
  handlePlaybackStarted(dedupeKey: string): boolean;
  has(dedupeKey: string): boolean;
  teardown(): void;
  resetForTests(): void;
}

function createProtectedOutcomeFamily(opts: {
  prefix: string;
  freshKeyOnRepark: boolean;
  abandonedEvent: string;
}): ProtectedOutcomeFamily {
  const texts = new Map<string, string>();
  let counter = 0;
  let generation = 0;
  const nextKey = (): string => {
    counter += 1;
    return `${opts.prefix}${counter}`;
  };
  const enqueue = (
    text: string,
    dedupeKey: string = nextKey(),
    beforeEnqueue?: (key: string) => void
  ): string => {
    texts.set(dedupeKey, text);
    // Caller bookkeeping keyed by this dedupe key must exist BEFORE the push:
    // a synchronous player can fire playback-start inside `enqueueConfirmation`.
    beforeEnqueue?.(dedupeKey);
    const harnessPlayer = getRecordingTestServices()?.ttsConfirmationPlayer;
    enqueueConfirmation({
      text,
      dedupeKey,
      protected: true,
      play: harnessPlayer
        ? (t, controls) => {
            registerTtsFingerprint(t);
            harnessPlayer(t, controls);
          }
        : playConfirmationHead,
    });
    return dedupeKey;
  };
  return {
    prefix: opts.prefix,
    enqueue,
    handleDiscard(dedupeKey, reason) {
      const text = texts.get(dedupeKey);
      if (text === undefined) return false;
      texts.delete(dedupeKey);
      if (reason === 'playback_error') {
        clientDiagnostic(opts.abandonedEvent, { reason, dedupeKey });
        return 'retired';
      }
      const generationAtDiscard = generation;
      queueMicrotask(() => {
        if (generation !== generationAtDiscard) return; // torn down meanwhile
        enqueue(text, opts.freshKeyOnRepark ? undefined : dedupeKey);
      });
      return 'reparked';
    },
    handlePlaybackStarted(dedupeKey) {
      return texts.delete(dedupeKey);
    },
    has(dedupeKey) {
      return texts.has(dedupeKey);
    },
    teardown() {
      texts.clear();
      generation += 1;
    },
    resetForTests() {
      texts.clear();
      counter = 0;
      generation += 1;
    },
  };
}

// ── Confirmation-mode status cues (PLAN-D D2, feedback ids 122/124) ─────────
//
// A bare `speakConfirmation(text, {force:true})` call satisfies "bypasses
// dedupe" and "never resets the FIFO" — but NOT "defers behind an active ask
// rather than dropping": `speak()`'s `preemptFlush()` and the queue's own
// overflow drop-oldest both fire `onDiscarded` unconditionally on every
// QUEUED item, and a bare call passes no `dedupeKey`, so the discard is
// silent and the cue is gone for good. The protected family above closes
// that gap; each cue gets its own unique key (never true deduplication —
// back-to-back identical cues are never collapsed).
const MODE_STATUS_DEDUPE_PREFIX = 'mode-status:';
const modeStatusCues = createProtectedOutcomeFamily({
  prefix: MODE_STATUS_DEDUPE_PREFIX,
  freshKeyOnRepark: true,
  abandonedEvent: 'tts_mode_status_cue_abandoned',
});

/**
 * Dedicated speech path for the confirmations-toggle cues ("Voice
 * read-backs on/off.") and the session-start warning. Contract, mirroring
 * iOS's own dedicated mode-status path (`AlertManager.swift`, which solves
 * the identical problem with its own park/flush mechanism):
 *   - Ignores the confirmation-mode toggle entirely (must be audible
 *     precisely when confirmations are OFF).
 *   - Bypasses the confirmation dedupe/TTL layer (a rapid off→on→off
 *     within 30s is heard three times, never collapsed).
 *   - DEFERS behind an active ask / in-progress inspector speech rather
 *     than dropping: enqueues via the same FIFO as ordinary confirmations
 *     (`shouldDeferPlayback` already gates on `isDirectAudioActive()`), and
 *     if a LATER ask's `preemptFlush()` or queue overflow destroys the
 *     still-waiting item, `handleModeStatusCueDiscard` (wired into
 *     recording-context's `onDiscarded` hook) re-enqueues it rather than
 *     letting it vanish — reason-gated: a genuine terminal playback
 *     failure retires the cue instead of retrying forever.
 *   - Never resets the FIFO itself (enqueues only; never calls
 *     `preemptFlush()`/`reset()`).
 */
export function speakConfirmationModeStatus(text: string): void {
  const trimmed = text?.trim();
  if (!trimmed) return;
  if (!isTtsAvailable() && !getRecordingTestServices()?.ttsConfirmationPlayer) return;
  clientDiagnostic('tts_speak_mode_status_called', { textPreview: trimmed.slice(0, 80) });
  modeStatusCues.enqueue(trimmed);
}

/**
 * Called from recording-context's `onDiscarded` hook. Returns true iff
 * `dedupeKey` belongs to a mode-status cue destroyed by a queue-lifecycle
 * event — the caller should not also treat it as an ordinary confirmation
 * reservation. Re-park vs retire and the microtask deferral are the shared
 * family's (see the block comment above).
 */
export function handleModeStatusCueDiscard(dedupeKey: string, reason: DiscardReason): boolean {
  return modeStatusCues.handleDiscard(dedupeKey, reason) !== false;
}

/** Called from recording-context's `onPlaybackStarted` hook — the cue was
 *  actually heard, so its re-park tracking entry is retired (nothing left
 *  to protect; a later flip speaks as a genuinely new cue via
 *  `speakConfirmationModeStatus`). Returns true iff this was a tracked
 *  mode-status key, so the caller can skip its own (irrelevant) handling. */
export function handleModeStatusCuePlaybackStarted(dedupeKey: string): boolean {
  return modeStatusCues.handlePlaybackStarted(dedupeKey);
}

// ── A01P (2026-09-08) — local-command outcomes ───────────────────────────
//
// A client-local Calculate has ALREADY mutated the job when its read-back
// is enqueued, and no server replay exists to restore local-only speech —
// so under DictatedReadbackPolicyV1 its outcome (the success line and the
// `ze_unreadable` / no-Ze policy line alike) gets exactly the protection an
// accepted read-back gets: forced audible, FIFO-ordered behind earlier
// read-backs, protected from overflow eviction, re-parked on preempt/purge,
// retired only by playback start or a terminal playback failure, abandoned
// only by session teardown. The SAME dedupe key survives a re-park so the
// caller's latency stamp resolves at the real playback start.
export const LOCAL_COMMAND_OUTCOME_DEDUPE_PREFIX = 'local_calc:';
const localCommandOutcomes = createProtectedOutcomeFamily({
  prefix: LOCAL_COMMAND_OUTCOME_DEDUPE_PREFIX,
  freshKeyOnRepark: false,
  abandonedEvent: 'tts_local_command_outcome_abandoned',
});

export function speakLocalCommandOutcome(
  text: string,
  options?: { beforeEnqueue?: (dedupeKey: string) => void }
): {
  enqueued: boolean;
  dedupeKey: string | null;
} {
  const trimmed = text?.trim();
  if (!trimmed) return { enqueued: false, dedupeKey: null };
  if (!isTtsAvailable() && !getRecordingTestServices()?.ttsConfirmationPlayer) {
    clientDiagnostic('tts_local_command_outcome_skipped_unavailable', {});
    return { enqueued: false, dedupeKey: null };
  }
  const dedupeKey = localCommandOutcomes.enqueue(trimmed, undefined, options?.beforeEnqueue);
  clientDiagnostic('tts_local_command_outcome_enqueued', {
    dedupeKey,
    textPreview: trimmed.slice(0, 80),
  });
  return { enqueued: true, dedupeKey };
}

/** `onDiscarded` hook: `'reparked'` (queue-lifecycle discard — it will play
 *  later), `'retired'` (terminal playback failure — the caller drops its
 *  per-key bookkeeping), or `false` (not a local-command outcome). */
export function handleLocalCommandOutcomeDiscard(
  dedupeKey: string,
  reason: DiscardReason
): DiscardOutcome {
  return localCommandOutcomes.handleDiscard(dedupeKey, reason);
}

/** `onPlaybackStarted` hook — heard; retire tracking. */
export function handleLocalCommandOutcomePlaybackStarted(dedupeKey: string): boolean {
  return localCommandOutcomes.handlePlaybackStarted(dedupeKey);
}

/** Test seam — whether a local-command outcome is still awaiting playback. */
export function __isLocalCommandOutcomePendingForTests(dedupeKey: string): boolean {
  return localCommandOutcomes.has(dedupeKey);
}

// ── PLAN-E1 E3 — poor-signal advisory ───────────────────────────────────────
//
// A DEDICATED API, backed by the EXISTING FIFO with no new queue. Pinned
// semantics (split-round-1/2): (1) respects the confirmations toggle — this
// is latency HONESTY, not a dictated-reading confirmation, and PLAN-D's
// sole documented exception set does not include it; (2) coalescing key =
// the advisory's own canonical string — a new arm while one is queued or
// playing is a no-op (NO ledger, NO operation token); (3) orders AFTER any
// backlog replay and NEVER interrupts an active question/clarification (the
// shared `shouldDeferPlayback` gate, unchanged, already gives every
// confirmation-class item this ordering); (4) discard-WITHOUT-re-park —
// unlike PLAN-D's mode-status cues, an evicted/preempted advisory is
// retired silently and can recur ONLY via a fresh median-over-threshold
// arming after cooldown; (5) never enters PLAN-E2's delivery ledger; (6) a
// STARTED-then-preempted head also releases the coalescing key (via
// `setOnStartedHeadTornDown`, `tts-queue.ts` — `onDiscarded` alone does not
// fire for an already-playing head that gets manually torn down).

export const POOR_SIGNAL_ADVISORY_TEXT =
  'Transcription is running slowly — confirmations may take a few seconds.';
// Codex diff-review r1 BLOCKER fix — the plan's own coalescing-key
// definition is "the advisory's CANONICAL STRING" (PLAN-E1-final.md E3),
// not an arbitrary identifier unrelated to what's actually spoken. Keying
// on the canonical text itself is what lets a live-inventory collision
// test (the `spoken_distinctness_union` fixture) detect a future
// byte-identical notice colliding with this one; an arbitrary literal
// key would be invisible to that check.
const POOR_SIGNAL_ADVISORY_DEDUPE_KEY = POOR_SIGNAL_ADVISORY_TEXT;

/** True from a successful enqueue until the head is heard to completion,
 *  discarded pre-start, or manually torn down mid-playback — the
 *  coalescing gate for `speakPoorSignalAdvisory()`. */
let poorSignalAdvisoryActive = false;

/**
 * Arms the poor-signal advisory. A no-op (coalesced, not re-queued) if one
 * is already queued or playing. Silent when confirmations are OFF — this
 * is the one deliberate parity with the confirmations-toggle rule; a
 * separate advisory-specific mute would be a second, undocumented
 * exception.
 */
export function speakPoorSignalAdvisory(): { enqueued: boolean } {
  if (poorSignalAdvisoryActive) {
    clientDiagnostic('tts_poor_signal_advisory_coalesced', {});
    return { enqueued: false };
  }
  if (!isTtsAvailable() && !getRecordingTestServices()?.ttsConfirmationPlayer) {
    return { enqueued: false };
  }
  if (!getConfirmationModeEnabled()) {
    clientDiagnostic('tts_poor_signal_advisory_skipped_muted', {});
    return { enqueued: false };
  }
  poorSignalAdvisoryActive = true;
  const harnessPlayer = getRecordingTestServices()?.ttsConfirmationPlayer;
  const result = enqueueConfirmation({
    text: POOR_SIGNAL_ADVISORY_TEXT,
    dedupeKey: POOR_SIGNAL_ADVISORY_DEDUPE_KEY,
    // Deliberately NOT `protected` — unlike a mode-status cue, an evicted
    // advisory retires silently by design (no re-park).
    play: harnessPlayer
      ? (t, controls) => {
          registerTtsFingerprint(t);
          harnessPlayer(t, controls);
        }
      : playConfirmationHead,
    // Natural completion releases the coalescing gate — this is the ONLY
    // terminal path `onDiscarded`/`onStartedHeadTornDown` don't cover.
    onEnd: releasePoorSignalAdvisoryGate,
  });
  if (!result.enqueued) {
    poorSignalAdvisoryActive = false;
  } else {
    clientDiagnostic('tts_poor_signal_advisory_armed', {});
  }
  return { enqueued: result.enqueued };
}

/** Called from recording-context's `onDiscarded` hook. Returns true iff
 *  `dedupeKey` belongs to the advisory — releases the coalescing gate
 *  WITHOUT re-parking (unlike `handleModeStatusCueDiscard`). */
export function handlePoorSignalAdvisoryDiscard(dedupeKey: string): boolean {
  if (dedupeKey !== POOR_SIGNAL_ADVISORY_DEDUPE_KEY) return false;
  poorSignalAdvisoryActive = false;
  return true;
}

/** Called from recording-context's `onStartedHeadTornDown` hook
 *  (`tts-queue.ts`) — a PLAYING advisory head was manually preempted.
 *  Releases the coalescing key with NO terminal callback (split-round-2:
 *  without this, a started-then-preempted advisory latches the gate
 *  forever and suppresses every later legitimate arm). Returns true iff
 *  this was the advisory's key. */
export function handlePoorSignalAdvisoryTornDown(dedupeKey: string): boolean {
  if (dedupeKey !== POOR_SIGNAL_ADVISORY_DEDUPE_KEY) return false;
  poorSignalAdvisoryActive = false;
  return true;
}

/** Fired by the queue's own `onEnd` (wired at enqueue time above) on
 *  NATURAL completion — the advisory was heard start-to-finish. Releases
 *  the coalescing gate; exported for tests. */
export function releasePoorSignalAdvisoryGate(): void {
  poorSignalAdvisoryActive = false;
}

/** Test-only — reset module state between test files. */
export function __resetPoorSignalAdvisoryForTests(): void {
  poorSignalAdvisoryActive = false;
}

// ── PLAN-E2 — uplink-loss DISCLOSURE (exactly-once, tokened) ─────────────────
//
// ONE cause-agnostic conditional line, spoken verbatim for a reconnect
// disclosure and a pre-open disclosure alike, delivered via THIS named API
// (never `speakPoorSignalAdvisory`, which is toggle-respecting, tokenless and
// discard-retired). Contract:
//   - FORCED: bypasses the confirmations toggle (this plan's documented
//     exception — "check and repeat only what's missing" is performable
//     with confirmations OFF too, by a glance at the grid).
//   - Immune to the 30s text dedupe: every disclosure is the SAME string;
//     the per-token dedupe key exists only so the queue's discard hooks can
//     recognise the item.
//   - Protected from overflow eviction; RE-PARKED after any pre-start
//     discard, preemption of a started head, or post-start playback
//     failure; retired ONLY on natural completion.
//   - Parked until debounced LOCAL silence (the session VAD) so a clip
//     released at open never starts over an inspector mid-reading.
//   - Session teardown (`reset` reason) ABANDONS the token — no replay.

export { UPLINK_LOSS_DISCLOSURE_TEXT };

const UPLINK_LOSS_DEDUPE_PREFIX = 'uplink-loss:';

function uplinkLossDedupeKey(token: DisclosureToken): string {
  return `${UPLINK_LOSS_DEDUPE_PREFIX}${token.id}`;
}

function tokenIdFromUplinkLossDedupeKey(dedupeKey: string): number | null {
  if (!dedupeKey.startsWith(UPLINK_LOSS_DEDUPE_PREFIX)) return null;
  const n = Number(dedupeKey.slice(UPLINK_LOSS_DEDUPE_PREFIX.length));
  return Number.isFinite(n) ? n : null;
}

/** The session VAD's debounced local-speaking state, registered by the
 *  provider at session start. `null` → never parks (tour/no-session). */
let uplinkLossLocalSpeakingGate: (() => boolean) | null = null;
/** A token released by the ledger but not yet enqueued — waiting for
 *  local silence or an interruption to end. */
let parkedUplinkLossToken: DisclosureToken | null = null;
const UPLINK_LOSS_TTS_UNAVAILABLE_RETRY_MS = 2000;
/** Direct prompts that arrived while a disclosure was PLAYING. */
let deferredDirectPrompts: Array<{ text: string; options?: SpeakOptions }> = [];
/** Bumped by session teardown / test reset so a scheduled re-park
 *  microtask from a previous session is a no-op. */
let uplinkLossGeneration = 0;

/** PLAN-E-TERM — the provider's durable-record binder for the CURRENT
 *  session, told each token's covered sources at NATURAL completion. The
 *  ledger is module-level (it outlives sessions); the observer is
 *  session-scoped and session-fences on `token.sessionId` itself. */
let uplinkLossCompletionObserver:
  | ((sessionId: string, coveredLossSourceIds: readonly LossSourceId[]) => void)
  | null = null;

function createUplinkLossDisclosureLedger(): UplinkLossDisclosureLedger {
  return new UplinkLossDisclosureLedger({
    onMint: (token) => speakUplinkLossDisclosure(token, token.coveredLossSourceIds),
    telemetry: (event, payload) => clientDiagnostic(event, payload),
    onCompleted: (token) =>
      uplinkLossCompletionObserver?.(token.sessionId, token.coveredLossSourceIds),
  });
}
let uplinkLossDisclosureLedger = createUplinkLossDisclosureLedger();

/** Provider wiring (PLAN-E-TERM): register/clear the completion observer. */
export function setUplinkLossDisclosureCompletionObserver(
  observer: ((sessionId: string, coveredLossSourceIds: readonly LossSourceId[]) => void) | null
): void {
  uplinkLossCompletionObserver = observer;
}

/** Provider wiring: the session VAD's `isLocalSpeaking` reader. */
export function setUplinkLossDisclosureLocalSpeakingGate(gate: (() => boolean) | null): void {
  uplinkLossLocalSpeakingGate = gate;
}

/** The loss ledger's disclosure moment: mint-or-join for `sourceIds` in the
 *  CURRENT TTS session. Emits `uplink_loss_episode_disclosed` per newly
 *  associated source. */
export function requestUplinkLossDisclosure(
  sourceIds: LossSourceId[],
  /** The ORIGINATING recording session (the loss ledger's own id). A
   *  release landing after that session ended — a hold released late, a
   *  parked moment surfacing after stop/start — is rejected here rather
   *  than adopted by whatever session is now active (Codex cycle-1). */
  expectedSessionId?: string
): void {
  if (sourceIds.length === 0) return;
  const sessionId = getActiveSessionId() ?? '';
  if (expectedSessionId !== undefined && expectedSessionId !== sessionId) {
    clientDiagnostic('tts_uplink_loss_disclosure_stale_session', {
      expected: expectedSessionId,
      active: sessionId,
      sources: sourceIds.length,
    });
    return;
  }
  const outcome = uplinkLossDisclosureLedger.request(sessionId, sourceIds);
  clientDiagnostic('tts_uplink_loss_disclosure_requested', {
    action: outcome.action,
    token: outcome.token.id,
    sources: sourceIds.length,
  });
}

/**
 * Deliver (or re-deliver) `token`. Parks behind local speech; otherwise
 * enqueues ONE protected, forced item carrying the token's dedupe key.
 * `coveredLossSourceIds` is carried on the token (this plan uses it only
 * for join semantics; PLAN-E-TERM iterates it at completion).
 */
export function speakUplinkLossDisclosure(
  token: DisclosureToken,
  coveredLossSourceIds: LossSourceId[]
): void {
  void coveredLossSourceIds;
  if (uplinkLossDisclosureLedger.outstandingToken?.id !== token.id) return; // stale
  if (token.sessionId !== (getActiveSessionId() ?? '')) return; // earlier session
  if (!isTtsAvailable() && !getRecordingTestServices()?.ttsConfirmationPlayer) {
    // TTS temporarily unavailable: NOT a terminal (the token stays
    // outstanding by contract). Park it and retry on a bounded timer so
    // the session's single slot is never held by a clip that was never
    // queued (Codex cycle-1 BLOCKER). Local silence also replays a park.
    parkedUplinkLossToken = token;
    const generation = uplinkLossGeneration;
    clientDiagnostic('tts_uplink_loss_disclosure_unavailable', { token: token.id });
    setTimeout(() => {
      if (generation !== uplinkLossGeneration) return;
      if (parkedUplinkLossToken !== token) return;
      parkedUplinkLossToken = null;
      speakUplinkLossDisclosure(token, token.coveredLossSourceIds);
    }, UPLINK_LOSS_TTS_UNAVAILABLE_RETRY_MS);
    return;
  }
  if (uplinkLossLocalSpeakingGate?.()) {
    parkedUplinkLossToken = token;
    clientDiagnostic('tts_uplink_loss_disclosure_parked', { token: token.id });
    return;
  }
  parkedUplinkLossToken = null;
  const harnessPlayer = getRecordingTestServices()?.ttsConfirmationPlayer;
  const result = enqueueConfirmation({
    text: UPLINK_LOSS_DISCLOSURE_TEXT,
    dedupeKey: uplinkLossDedupeKey(token),
    protected: true,
    play: harnessPlayer
      ? (t, controls) => {
          registerTtsFingerprint(t);
          harnessPlayer(t, controls);
        }
      : playConfirmationHead,
    onEnd: () => handleUplinkLossDisclosureNaturalCompletion(token.id),
    onPlaybackFailed: () => handleUplinkLossDisclosurePostStartFailure(token.id),
  });
  clientDiagnostic('tts_uplink_loss_disclosure_enqueued', {
    token: token.id,
    enqueued: result.enqueued,
  });
}

/** Provider wiring: the session VAD's debounced SILENCE transition. */
export function notifyUplinkLossLocalSilence(): void {
  const token = parkedUplinkLossToken;
  if (!token) return;
  parkedUplinkLossToken = null;
  speakUplinkLossDisclosure(token, token.coveredLossSourceIds);
}

/** Queue hook: the disclosure clip began real audio → `playing`. Returns
 *  true iff `dedupeKey` was a disclosure key. */
export function handleUplinkLossDisclosurePlaybackStarted(dedupeKey: string): boolean {
  const id = tokenIdFromUplinkLossDedupeKey(dedupeKey);
  if (id === null) return false;
  uplinkLossDisclosureLedger.onPlaybackStarted(id);
  return true;
}

/** Queue hook: a NEVER-started disclosure item was discarded. `reset` =
 *  session teardown → abandon; anything else → re-park the same token. */
export function handleUplinkLossDisclosureDiscard(
  dedupeKey: string,
  reason: DiscardReason
): boolean {
  const id = tokenIdFromUplinkLossDedupeKey(dedupeKey);
  if (id === null) return false;
  if (reason === 'reset') {
    abandonUplinkLossDisclosureForTeardown();
    return true;
  }
  reparkUplinkLossDisclosure(id, reason === 'playback_error' ? 1500 : 0);
  return true;
}

/** Queue hook: a STARTED disclosure head was manually torn down. Same
 *  split: `reset` abandons, preemption/purge re-parks. */
export function handleUplinkLossDisclosureTornDown(
  dedupeKey: string,
  reason: DiscardReason
): boolean {
  const id = tokenIdFromUplinkLossDedupeKey(dedupeKey);
  if (id === null) return false;
  if (reason === 'reset') {
    abandonUplinkLossDisclosureForTeardown();
    return true;
  }
  reparkUplinkLossDisclosure(id, 0);
  return true;
}

function handleUplinkLossDisclosureNaturalCompletion(tokenId: number): void {
  const successor = uplinkLossDisclosureLedger.onNaturalCompletion(tokenId);
  releaseDeferredDirectPrompts();
  // A successor (sources that awaited while this one played) was minted by
  // the ledger and already handed to `speakUplinkLossDisclosure` via onMint.
  void successor;
}

function handleUplinkLossDisclosurePostStartFailure(tokenId: number): void {
  reparkUplinkLossDisclosure(tokenId, 1500);
}

/** Atomically `playing`/`pending` → `pending`, release deferred prompts
 *  FIRST (before any replay), then replay after the parking gate. */
function reparkUplinkLossDisclosure(tokenId: number, delayMs: number): void {
  const token = uplinkLossDisclosureLedger.onNonNaturalTerminal(tokenId);
  if (!token) return;
  clientDiagnostic('tts_uplink_loss_disclosure_reparked', { token: token.id, delayMs });
  releaseDeferredDirectPrompts();
  const generation = uplinkLossGeneration;
  const replay = () => {
    if (uplinkLossGeneration !== generation) return; // torn down meanwhile
    speakUplinkLossDisclosure(token, token.coveredLossSourceIds);
  };
  // Deferred to a microtask (never synchronous) for the same reason the
  // mode-status re-park is: the queue's discard hooks fire from inside a
  // live iteration over the queue array.
  if (delayMs > 0) setTimeout(replay, delayMs);
  else queueMicrotask(replay);
}

function releaseDeferredDirectPrompts(): void {
  if (deferredDirectPrompts.length === 0) return;
  const prompts = deferredDirectPrompts;
  deferredDirectPrompts = [];
  for (const p of prompts) speak(p.text, p.options);
}

function abandonUplinkLossDisclosureForTeardown(): void {
  uplinkLossDisclosureLedger.abandonForSessionTeardown();
  parkedUplinkLossToken = null;
  deferredDirectPrompts = [];
  uplinkLossGeneration += 1;
}

/** Read-only introspection for tests. */
export function __uplinkLossDisclosureStateForTests(): {
  outstanding: DisclosureToken | null;
  parked: DisclosureToken | null;
  deferredPrompts: number;
  awaitingSources: number;
  completed: number;
} {
  return {
    outstanding: uplinkLossDisclosureLedger.outstandingToken,
    parked: parkedUplinkLossToken,
    deferredPrompts: deferredDirectPrompts.length,
    awaitingSources: uplinkLossDisclosureLedger.awaitingSourceCount,
    completed: uplinkLossDisclosureLedger.naturalCompletionCount,
  };
}

/** Test-only — wipe the disclosure delivery state between test files
 *  (a FRESH ledger, so token ids and counters restart). */
export function __resetUplinkLossDisclosureForTests(): void {
  abandonUplinkLossDisclosureForTeardown();
  uplinkLossDisclosureLedger = createUplinkLossDisclosureLedger();
  uplinkLossLocalSpeakingGate = null;
}

/** Test-only. */
export function __resetModeStatusCuesForTests(): void {
  modeStatusCues.resetForTests();
  localCommandOutcomes.resetForTests();
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
    if (resetQueue) {
      // PLAN-D — clear mode-status tracking BEFORE reset() fires discards,
      // so handleModeStatusCueDiscard sees no match and does not re-park a
      // cue into a session that's tearing down (see that function's
      // docblock for why re-parking here would hang the tab). Also bump
      // the generation so an ALREADY-SCHEDULED re-park microtask (from a
      // discard that fired before this teardown) is a no-op too — clearing
      // the map alone cannot cancel a microtask whose closure already
      // captured the cue's text.
      modeStatusCues.teardown();
      localCommandOutcomes.teardown();
      ttsQueueReset();
    }
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
    // PLAN-D — clear mode-status tracking + bump the generation BEFORE
    // reset() (see the no-isTtsAvailable() branch above for why ordering,
    // and why the generation bump, are both load-bearing).
    modeStatusCues.teardown();
    localCommandOutcomes.teardown();
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

// ── A02D — held-fragment clarification obligation ────────────────────────
//
// Distinct from PLAN-E2's disclosure token but built on the same delivery
// contract: ONE protected, forced item per token in the confirmation FIFO
// (never `speak()`, so it consumes no outstanding ask and is never blocked
// by awaiting-response state); parked behind local speech and TTS
// unavailability; re-parked on preemption/overflow/discard/playback
// failure; terminal only on natural completion; abandoned at teardown.
// Unlike E2, a direct prompt PREEMPTS a playing clarification (it re-parks
// and speaks once afterwards) — the plan's own lifecycle vector — so
// nothing here touches `speak()`'s E2 deferral branch.
//
// TEXT FREEZE: the wording is rendered exactly once, at `freezeText`, the
// moment the clip is prepared for the queue. A later held final can merge
// into the token only before that; afterwards it awaits a successor.

export { HELD_FRAGMENT_CLARIFICATION_NAMED_TEMPLATE, HELD_FRAGMENT_CLARIFICATION_MANY_TEXT };
export { renderHeldFragmentClarification };

const HELD_FRAGMENT_DEDUPE_PREFIX = 'held-fragment:';

function heldFragmentDedupeKey(token: ClarificationToken): string {
  return `${HELD_FRAGMENT_DEDUPE_PREFIX}${token.id}`;
}

function tokenIdFromHeldFragmentDedupeKey(dedupeKey: string): number | null {
  if (!dedupeKey.startsWith(HELD_FRAGMENT_DEDUPE_PREFIX)) return null;
  const n = Number(dedupeKey.slice(HELD_FRAGMENT_DEDUPE_PREFIX.length));
  return Number.isFinite(n) ? n : null;
}

let parkedHeldFragmentToken: ClarificationToken | null = null;
let heldFragmentGeneration = 0;
const HELD_FRAGMENT_TTS_UNAVAILABLE_RETRY_MS = 2000;

function createHeldFragmentClarificationLedger(): HeldFragmentClarificationLedger {
  return new HeldFragmentClarificationLedger({
    onMint: (token) => speakHeldFragmentClarification(token),
    telemetry: (event, payload) => clientDiagnostic(event, payload),
  });
}
let heldFragmentClarificationLedger = createHeldFragmentClarificationLedger();

/** The hold's ONE obligation for a held final: mint-or-merge-or-await a
 *  clarification token in the CURRENT TTS session. `expectedSessionId` is
 *  the originating recording session; a request landing after that session
 *  ended is rejected rather than adopted by the next one. */
export function requestHeldFragmentClarification(
  finalKey: string,
  destinations: readonly string[],
  expectedSessionId?: string
): void {
  const sessionId = getActiveSessionId() ?? '';
  if (expectedSessionId !== undefined && expectedSessionId !== sessionId) {
    clientDiagnostic('a02d_clarification_stale_session', {
      expected: expectedSessionId,
      active: sessionId,
    });
    return;
  }
  const outcome = heldFragmentClarificationLedger.request(sessionId, finalKey, destinations);
  clientDiagnostic('a02d_clarification_requested', {
    action: outcome.action,
    token: outcome.token?.id ?? null,
    destinations: destinations.length,
  });
}

/** Deliver (or re-deliver) `token`: park behind TTS unavailability and
 *  local speech, otherwise FREEZE the wording and enqueue ONE protected,
 *  forced item carrying the token's dedupe key. */
export function speakHeldFragmentClarification(token: ClarificationToken): void {
  if (heldFragmentClarificationLedger.outstandingToken?.id !== token.id) return; // stale
  if (token.sessionId !== (getActiveSessionId() ?? '')) return; // earlier session
  if (!isTtsAvailable() && !getRecordingTestServices()?.ttsConfirmationPlayer) {
    parkedHeldFragmentToken = token;
    const generation = heldFragmentGeneration;
    clientDiagnostic('a02d_clarification_unavailable', { token: token.id });
    setTimeout(() => {
      if (generation !== heldFragmentGeneration) return;
      if (parkedHeldFragmentToken !== token) return;
      parkedHeldFragmentToken = null;
      speakHeldFragmentClarification(token);
    }, HELD_FRAGMENT_TTS_UNAVAILABLE_RETRY_MS);
    return;
  }
  if (uplinkLossLocalSpeakingGate?.()) {
    parkedHeldFragmentToken = token;
    clientDiagnostic('a02d_clarification_parked', { token: token.id });
    return;
  }
  parkedHeldFragmentToken = null;
  // TEXT FREEZE — from here on a later held final awaits a successor.
  const text = heldFragmentClarificationLedger.freezeText(token.id);
  if (text === null) return;
  const harnessPlayer = getRecordingTestServices()?.ttsConfirmationPlayer;
  const result = enqueueConfirmation({
    text,
    dedupeKey: heldFragmentDedupeKey(token),
    protected: true,
    play: harnessPlayer
      ? (t, controls) => {
          registerTtsFingerprint(t);
          harnessPlayer(t, controls);
        }
      : playConfirmationHead,
    onEnd: () => handleHeldFragmentNaturalCompletion(token.id),
    onPlaybackFailed: () => reparkHeldFragmentClarification(token.id, 1500),
  });
  clientDiagnostic('a02d_clarification_enqueued', {
    token: token.id,
    enqueued: result.enqueued,
    textPreview: text.slice(0, 80),
  });
}

/** Provider wiring: the session VAD's debounced SILENCE releases a park. */
export function notifyHeldFragmentLocalSilence(): void {
  const token = parkedHeldFragmentToken;
  if (!token) return;
  parkedHeldFragmentToken = null;
  speakHeldFragmentClarification(token);
}

export function handleHeldFragmentClarificationPlaybackStarted(dedupeKey: string): boolean {
  const id = tokenIdFromHeldFragmentDedupeKey(dedupeKey);
  if (id === null) return false;
  heldFragmentClarificationLedger.onPlaybackStarted(id);
  return true;
}

/** Queue hook: a NEVER-started clarification item was discarded. `reset` =
 *  session teardown → abandon; anything else → re-park the same token. */
export function handleHeldFragmentClarificationDiscard(
  dedupeKey: string,
  reason: DiscardReason
): boolean {
  const id = tokenIdFromHeldFragmentDedupeKey(dedupeKey);
  if (id === null) return false;
  if (reason === 'reset') {
    abandonHeldFragmentClarificationForTeardown();
    return true;
  }
  reparkHeldFragmentClarification(id, reason === 'playback_error' ? 1500 : 0);
  return true;
}

/** Queue hook: a STARTED clarification head was torn down (preemption or
 *  purge re-parks; `reset` abandons). */
export function handleHeldFragmentClarificationTornDown(
  dedupeKey: string,
  reason: DiscardReason
): boolean {
  const id = tokenIdFromHeldFragmentDedupeKey(dedupeKey);
  if (id === null) return false;
  if (reason === 'reset') {
    abandonHeldFragmentClarificationForTeardown();
    return true;
  }
  reparkHeldFragmentClarification(id, 0);
  return true;
}

function handleHeldFragmentNaturalCompletion(tokenId: number): void {
  // A successor (finals that awaited while this one played) is minted by
  // the ledger and handed straight to `speakHeldFragmentClarification`.
  heldFragmentClarificationLedger.onNaturalCompletion(tokenId);
}

function reparkHeldFragmentClarification(tokenId: number, delayMs: number): void {
  const token = heldFragmentClarificationLedger.onNonNaturalTerminal(tokenId);
  if (!token) return;
  const generation = heldFragmentGeneration;
  const replay = () => {
    if (heldFragmentGeneration !== generation) return;
    speakHeldFragmentClarification(token);
  };
  // Deferred (never synchronous): the queue's discard hooks fire from
  // inside a live iteration over the queue array.
  if (delayMs > 0) setTimeout(replay, delayMs);
  else queueMicrotask(replay);
}

function abandonHeldFragmentClarificationForTeardown(): void {
  heldFragmentClarificationLedger.abandonForSessionTeardown();
  parkedHeldFragmentToken = null;
  heldFragmentGeneration += 1;
}

/** Session teardown (the provider's `stop()`): abandon any pending token so
 *  it is never spoken into the next session. */
export function abandonHeldFragmentClarificationForSessionTeardown(): void {
  abandonHeldFragmentClarificationForTeardown();
}

/** Read-only introspection for tests. */
export function __heldFragmentClarificationStateForTests(): {
  outstanding: ClarificationToken | null;
  parked: ClarificationToken | null;
  awaitingFinals: number;
  held: number;
  spoken: number;
} {
  return {
    outstanding: heldFragmentClarificationLedger.outstandingToken,
    parked: parkedHeldFragmentToken,
    awaitingFinals: heldFragmentClarificationLedger.awaitingFinalCount,
    held: heldFragmentClarificationLedger.heldFinalCount,
    spoken: heldFragmentClarificationLedger.spokenCount,
  };
}

/** Test-only — fresh ledger (token ids and counters restart). */
export function __resetHeldFragmentClarificationForTests(): void {
  abandonHeldFragmentClarificationForTeardown();
  heldFragmentClarificationLedger = createHeldFragmentClarificationLedger();
}
