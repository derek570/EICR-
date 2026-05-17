'use client';

/**
 * ElevenLabs TTS via the backend proxy.
 *
 * Mirrors iOS `AlertManager.speakWithTTS` (AlertManager.swift:1029-1134) so
 * the PWA hears the same Archer Conversational voice the inspector hears
 * on iPad — closing the parity gap that left the web client emitting
 * the OS SpeechSynthesis voice instead. The backend proxy at
 * `/api/proxy/elevenlabs-tts` (src/routes/keys.js:223) injects the API
 * key, voice ID, and model server-side and attributes the character
 * count to the active session's CostTracker when `sessionId` is sent.
 *
 * Strategy
 * - 12-second fetch timeout. Above that we abort and surface a fallback
 *   reason so the caller can degrade to SpeechSynthesis. iOS uses the
 *   identical 12s budget at AlertManager.swift:1085.
 * - Single shared `<audio>` element. Reusing the element is the iOS
 *   Safari workaround for the "audio.play() needs a user gesture" rule —
 *   once one play() has resolved inside a Start-tap handler (via
 *   `primeAudioElement()` from `tts.ts.primeTts`), every subsequent
 *   `src = blobUrl; play()` on that same element inherits the gesture
 *   grant. Creating a fresh `new Audio()` for each utterance would
 *   require a fresh gesture, which we never get mid-recording.
 * - Cancel-before-replace. Each `speakElevenLabs()` aborts the
 *   in-flight fetch (if any) and pauses the shared audio element
 *   before issuing the new request. iOS does the same at
 *   AlertManager.swift:1043-1054 — without it concurrent ElevenLabs
 *   round-trips race and the loser silently never closes its TTS
 *   window, so the mic-feedback gate suppresses transcripts forever
 *   (the same class of bug that the closeWindow guard fix in tts.ts
 *   addresses for the SpeechSynthesis path).
 *
 * Lifecycle callbacks — the caller (`tts.ts.dispatch`) passes onStart /
 * onEnd / onError handlers that own the public `ttsWindow` so this
 * module never has to know what the mic-feedback gate looks like.
 * `onStart` fires when the audio element's `play` event resolves AND
 * the first `playing` event lands (real audio is now flowing); `onEnd`
 * fires from the `ended` event; `onError` fires from `error`/network
 * failures/timeout/abort.
 *
 * Authentication mirrors `api-client.ts`: read the JWT from the local
 * auth helper, include cookies for the backend's dual-mode auth (Bearer
 * header OR cookie). The proxy route is `auth.requireAuth`, so an
 * unauthenticated client transparently falls back to SpeechSynthesis
 * via the 401 surface.
 *
 * Why not use the typed `request<T>` helper in api-client.ts: that
 * wrapper retries idempotent requests, parses JSON, and runs zod
 * adapters — none of which apply here. POSTs aren't retried by design,
 * the response is `audio/mpeg`, and there's no schema. A lean direct
 * fetch is clearer than fighting the wrapper.
 */

import { getToken } from '../auth';
import { clientDiagnostic } from './client-diagnostic';

/**
 * Tracks whether the shared `<audio>` element has been successfully
 * unlocked by a priming `play()` inside a user gesture. iPad Safari
 * (in a browser tab — NOT installed PWA) is the strictest case: even
 * the priming `play()` can reject silently if the gesture wasn't
 * properly rooted, in which case any later `audio.play()` (for a real
 * ElevenLabs payload) will also reject with NotAllowedError. By
 * flipping this to `false` when priming fails AND checking it before
 * routing to ElevenLabs, we degrade up-front to SpeechSynthesis
 * instead of paying for a fetch whose audio we can't play. Mirrors
 * iOS's `audioSessionReady` flag (RecordingSessionCoordinator.swift:151)
 * which only flips after .playAndRecord configures successfully.
 *
 * Defaults to `true` so the very first prime attempt is allowed to
 * proceed; flipped to `false` only on confirmed rejection. Reset
 * via `__resetElevenLabsForTests`.
 */
let audioGestureGranted = true;

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';
const FETCH_TIMEOUT_MS = 12_000;

/**
 * Lifecycle hooks passed in by the caller. The contract is that `onStart`
 * fires exactly once before any `onEnd` / `onError`, and exactly one of
 * `onEnd` / `onError` resolves the speech regardless of the failure
 * mode. Symmetric with the SpeechSynthesisUtterance event model so
 * tts.ts can route both paths through the same window-management code.
 */
export interface ElevenLabsLifecycle {
  /** Audio is now actually playing — open the mic-feedback window. */
  onStart?: () => void;
  /** Audio finished naturally — close the window. */
  onEnd?: () => void;
  /**
   * Something failed. The reason is informational only; the caller
   * should fall back to native TTS regardless. Reasons:
   * - `'no-session'`: no sessionId was supplied (skipping ElevenLabs to
   *   avoid an unattributed cost path; also matches the "haven't started
   *   recording yet" case where no auth context is meaningful).
   * - `'no-token'`: getToken() returned null — user is logged out.
   * - `'fetch'`: HTTP error (5xx, 401, 400, body parse).
   * - `'timeout'`: 12s fetch budget exceeded.
   * - `'aborted'`: cancelSpeech() / new dispatch() superseded this one.
   * - `'play'`: audio element error (unsupported codec, stalled load).
   * - `'offline'`: `navigator.onLine === false` at dispatch time.
   */
  onError?: (reason: ElevenLabsFailureReason) => void;
}

export type ElevenLabsFailureReason =
  | 'no-session'
  | 'no-token'
  | 'fetch'
  | 'timeout'
  | 'aborted'
  | 'play'
  | 'offline';

/**
 * Module-level state — single in-flight ElevenLabs request and a single
 * shared audio element. Both are cancel-before-replace so a new
 * speakElevenLabs() call always supersedes the previous one.
 */
let activeAbortController: AbortController | null = null;
let activeBlobUrl: string | null = null;
let sharedAudio: HTMLAudioElement | null = null;
let activeSessionId: string | null = null;
// Module-scope pointer to the lifecycle of the currently-playing
// utterance. Set at the top of `speakElevenLabs` (after the initial
// `cancelElevenLabs` flushes any prior playback), cleared in `settle`
// once the utterance reaches its terminal state. `cancelElevenLabs`
// reads this to fire `onEnd` synchronously when a previously-playing
// utterance gets superseded by a new call — without this, the
// recording-context lifecycle observer never sees a matching `end`
// for the superseded playback, leaving consumer state (most
// importantly `ttsActiveRef` from commit 2bc8d90's PCM gate) stuck.
// Mirror of iOS `AlertManager.swift:1040-1052 markTTSFinished()`
// being explicitly called on supersede.
let activeLifecycle: ElevenLabsLifecycle | null = null;
// WeakSet of lifecycle objects whose terminal callback (onEnd OR onError)
// has already fired exactly once. Used by `settle()` to skip a redundant
// onError fire when `cancelElevenLabs()` has already fired onEnd on a
// superseded lifecycle — without this dedup the recording-context TTS
// lifecycle observer receives TWO `notifyTtsLifecycle('end')` calls
// for the same superseded utterance, each re-arming the 500ms
// resume timer and emitting a `tts_pcm_gate_released` event. Both fires
// are idempotent in terms of state mutations, but the redundant
// WS-send + audio-element churn contributes to the iPad Safari
// WebContent-process pressure we're tracking in sess_mp9qnay1_h1ik.
const terminalFiredLifecycles = new WeakSet<ElevenLabsLifecycle>();

/**
 * Set the sessionId that subsequent ElevenLabs requests will attribute
 * cost to. Call this from the recording-context when a session opens
 * (`sessionIdRef.current`) and clear it (pass `null`) when the session
 * stops. Mirrors iOS `AlertManager.sessionIdProvider` set by the
 * recording viewmodel at session boundaries.
 *
 * No sessionId means we skip ElevenLabs entirely and fall back to
 * SpeechSynthesis. This avoids an unattributed character cost on
 * out-of-session paths (tour narration before recording starts) and
 * matches iOS behavior — `proxyElevenLabsTTS` only fires from inside
 * an active `RecordingSessionCoordinator`.
 */
export function setActiveSessionId(sessionId: string | null): void {
  activeSessionId = sessionId;
}

export function getActiveSessionId(): string | null {
  return activeSessionId;
}

/**
 * Lazily create (or return) the shared `<audio>` element. Used both by
 * priming (silent unlock at Start tap) and the playback path. iOS
 * Safari's autoplay policy requires the FIRST `play()` on a fresh
 * element to land inside a user gesture; subsequent `play()` calls on
 * the SAME element inherit the grant. By keeping a single element
 * around for the page lifetime we only need one gesture-bound prime.
 */
function getSharedAudio(): HTMLAudioElement | null {
  if (typeof window === 'undefined') return null;
  if (!sharedAudio) {
    sharedAudio = new Audio();
    // Prevents the element from showing up in any media-session UI;
    // we own the lifecycle.
    sharedAudio.preload = 'auto';
  }
  return sharedAudio;
}

/**
 * Prime the shared audio element with a silent data URI so iOS Safari
 * grants autoplay permission for the rest of the page lifecycle.
 * Called by `tts.ts.primeTts()` from inside the Start-tap user gesture
 * — without this, the FIRST ElevenLabs payload arrives well after the
 * gesture window has closed, `audio.play()` rejects with a
 * `NotAllowedError`, and we silently degrade to SpeechSynthesis on every
 * utterance even though ElevenLabs delivered audio cleanly.
 *
 * The data URI is a 44-byte WAV header with zero samples — universally
 * decodable, plays for ~0ms, and never makes a network round-trip.
 *
 * Best-effort: any failure is swallowed because priming is non-essential
 * (worst case we fall back to SpeechSynthesis on the first utterance).
 */
export function primeAudioElement(): void {
  const audio = getSharedAudio();
  if (!audio) {
    audioGestureGranted = false;
    clientDiagnostic('prime_audio_element_no_audio', {});
    return;
  }
  try {
    audio.src =
      'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
    audio.muted = true;
    const promise = audio.play();
    if (promise && typeof promise.then === 'function') {
      promise
        .then(() => {
          audioGestureGranted = true;
          clientDiagnostic('prime_audio_element_succeeded', {});
          try {
            audio.pause();
            audio.currentTime = 0;
          } catch {
            /* ignore */
          }
        })
        .catch((err: unknown) => {
          const name = err instanceof Error ? err.name : 'unknown';
          const message = err instanceof Error ? err.message.slice(0, 120) : '';
          // AbortError means the prime was *cancelled* mid-flight, NOT
          // that the autoplay policy refused us. The most common cause
          // is a real `speakElevenLabs()` call landing before the
          // prime's play() promise resolves — it calls
          // `cancelElevenLabs()` at the top, which `audio.pause()`'s
          // the shared element, and the still-pending prime play()
          // promise rejects with AbortError. In that case the browser
          // HAS recorded the gesture grant (the play() began before
          // the pause), so leaving the flag at its optimistic default
          // keeps ElevenLabs available. Only NotAllowedError (and
          // other non-abort failures) actually mean the autoplay
          // policy refused us — those flip the flag false so the
          // next speak() routes to SpeechSynthesis.
          if (name === 'AbortError') {
            clientDiagnostic('prime_audio_element_aborted_superseded', {
              errorName: name,
              message,
            });
            return;
          }
          // Promise rejection means iPad Safari (or another browser
          // with an autoplay policy) refused the gesture grant. Flip
          // the flag so isElevenLabsAvailable() returns false and the
          // next `speak()` routes straight to SpeechSynthesis — which
          // ALSO needs a gesture grant, but the prime SpeechSynthesis
          // utterance ran inside the same Start tap and has a better
          // chance of being warmed.
          audioGestureGranted = false;
          clientDiagnostic('prime_audio_element_rejected', { errorName: name, message });
        });
    } else {
      // Sync play() return value (very old browsers). Assume success.
      audioGestureGranted = true;
      clientDiagnostic('prime_audio_element_sync_ok', {});
    }
  } catch (err) {
    audioGestureGranted = false;
    const message = err instanceof Error ? err.message.slice(0, 120) : '';
    clientDiagnostic('prime_audio_element_threw', { message });
  }
}

/**
 * Returns true iff the shared audio element's priming `play()` has
 * confirmed a gesture grant. Used by `isElevenLabsAvailable()` so
 * that on iPad Safari browser tab — where priming silently fails —
 * we skip the ElevenLabs fetch (whose audio we cannot play) and go
 * straight to SpeechSynthesis. iOS canon doesn't have this
 * complication; it's web-specific.
 */
export function hasAudioGestureGrant(): boolean {
  return audioGestureGranted;
}

/**
 * Cancel any in-flight ElevenLabs request AND stop playback on the
 * shared audio element. Idempotent — safe to call when nothing is in
 * flight. Called by `tts.ts.cancelSpeech()` and at the top of every
 * new speakElevenLabs() call.
 *
 * Note: blob URL cleanup happens here so the next dispatch starts with
 * no stale references. iOS Safari has been observed to leak blob URLs
 * across navigations if not explicitly revoked.
 */
export function cancelElevenLabs(): void {
  // Fire the SUPERSEDED utterance's onEnd synchronously so the
  // recording-context TTS lifecycle observer (commit 2bc8d90) sees a
  // matching `end` event. Without this, a B-supersedes-A scenario
  // leaves `ttsActiveRef = true` from A's start with no corresponding
  // end fire — the PCM gate would stay engaged indefinitely on a
  // failed-B-fetch path. The fire is wrapped in try/catch because the
  // observer is consumer-supplied and must never crash the cancel
  // path. Cleared BEFORE the abort so a callback that re-enters
  // `cancelElevenLabs` synchronously doesn't recurse.
  const prevLifecycle = activeLifecycle;
  activeLifecycle = null;
  if (prevLifecycle?.onEnd) {
    try {
      // Mark BEFORE the call so a re-entrant cancelElevenLabs from
      // inside onEnd doesn't observe the lifecycle as un-fired.
      terminalFiredLifecycles.add(prevLifecycle);
      prevLifecycle.onEnd();
    } catch {
      /* swallow — observer must never tear down the cancel path */
    }
  }
  if (activeAbortController) {
    activeAbortController.abort();
    activeAbortController = null;
  }
  if (sharedAudio) {
    try {
      sharedAudio.pause();
      sharedAudio.removeAttribute('src');
      sharedAudio.load();
    } catch {
      /* ignore */
    }
  }
  if (activeBlobUrl) {
    try {
      URL.revokeObjectURL(activeBlobUrl);
    } catch {
      /* ignore */
    }
    activeBlobUrl = null;
  }
}

/**
 * Returns true iff this runtime can use ElevenLabs (browser context with
 * Audio + fetch). Allows callers to decide between this path and the
 * SpeechSynthesis fallback at speak() time without a probe round-trip.
 */
export function isElevenLabsAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.fetch !== 'function') return false;
  if (typeof window.Audio !== 'function') return false;
  // iPad Safari browser-tab specific: if primeAudioElement() confirmed
  // a rejection, the gesture grant is missing and any subsequent
  // audio.play() will reject. Skip ElevenLabs so we don't burn a fetch
  // whose payload we can't play — fall back to SpeechSynthesis up-front.
  if (!audioGestureGranted) return false;
  return true;
}

/**
 * Speak `text` via ElevenLabs. Returns a promise that resolves when
 * the lifecycle settles (either onEnd or onError fired). The boolean
 * indicates whether playback completed successfully — callers use this
 * to decide whether to fall back to SpeechSynthesis.
 *
 * Lifecycle:
 *   1. Cancel any in-flight request + stop the shared audio.
 *   2. Validate sessionId / online state — short-circuit to onError
 *      with the appropriate reason if the precondition fails.
 *   3. Fetch /api/proxy/elevenlabs-tts with a 12s AbortController
 *      timeout. AbortController is shared with `cancelElevenLabs()`
 *      so a Stop-tap or supersede also aborts the fetch.
 *   4. Decode the audio blob, set it on the shared element, call
 *      play(). The `playing` event opens the TTS window via onStart;
 *      `ended` closes it via onEnd; `error` falls back via onError.
 *
 * The text is the SAME text that goes to SpeechSynthesis — no
 * client-side expansion. The proxy route does no rewrites either; iOS
 * `expandForTTS` (AlertManager.swift:1031) is only relevant on iOS
 * (it expands "Zs" → "zee-ess" etc. for Apple's TTS that mispronounces
 * abbreviations). ElevenLabs handles those abbreviations natively and
 * iOS doesn't expand the ElevenLabs text either — it expands BEFORE
 * the round-trip and ElevenLabs is happy with both forms.
 */
export function speakElevenLabs(
  text: string,
  lifecycle: ElevenLabsLifecycle = {}
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    cancelElevenLabs();
    // Register THIS lifecycle as the supersede target — a future
    // `cancelElevenLabs()` (from a new speakElevenLabs, an explicit
    // Stop, or a `disconnect()`) will fire onEnd on this lifecycle
    // before clearing. Set AFTER the initial cancel above so we
    // don't double-fire the previous lifecycle's onEnd.
    activeLifecycle = lifecycle;

    clientDiagnostic('elevenlabs_speak_entered', {
      textLength: text.length,
      textPreview: text.slice(0, 80),
      hasActiveSessionId: Boolean(activeSessionId),
    });

    if (!isElevenLabsAvailable()) {
      clientDiagnostic('elevenlabs_speak_short_circuit', { reason: 'unavailable' });
      lifecycle.onError?.('offline');
      resolve(false);
      return;
    }

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      clientDiagnostic('elevenlabs_speak_short_circuit', { reason: 'offline' });
      lifecycle.onError?.('offline');
      resolve(false);
      return;
    }

    if (!activeSessionId) {
      clientDiagnostic('elevenlabs_speak_short_circuit', { reason: 'no-session' });
      lifecycle.onError?.('no-session');
      resolve(false);
      return;
    }

    const token = getToken();
    if (!token) {
      clientDiagnostic('elevenlabs_speak_short_circuit', { reason: 'no-token' });
      lifecycle.onError?.('no-token');
      resolve(false);
      return;
    }

    const audio = getSharedAudio();
    if (!audio) {
      clientDiagnostic('elevenlabs_speak_short_circuit', { reason: 'no-audio-element' });
      lifecycle.onError?.('play');
      resolve(false);
      return;
    }

    const controller = new AbortController();
    activeAbortController = controller;

    // Track which side fired the abort so the catch handler can
    // distinguish a 12s timeout from an external cancel (Stop tap or
    // a fresh dispatch superseding this one). Without this flag both
    // paths look identical to the catch — `controller.signal.aborted`
    // is true in both cases — and we'd misclassify cancels as timeouts.
    let timeoutFired = false;
    const timeoutId = window.setTimeout(() => {
      timeoutFired = true;
      controller.abort();
    }, FETCH_TIMEOUT_MS);

    let settled = false;
    const settle = (ok: boolean, reason?: ElevenLabsFailureReason) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      // Clear the supersede target so a subsequent `cancelElevenLabs`
      // doesn't fire onEnd a second time for THIS utterance — the
      // natural-end path below already fires it via `lifecycle.onEnd`.
      // (If activeLifecycle has been re-assigned to a newer utterance
      // already, leave it alone — that's the supersede-mid-settle race
      // and the new owner has its own end semantics.)
      if (activeLifecycle === lifecycle) {
        activeLifecycle = null;
      }
      // If `cancelElevenLabs()` already fired this lifecycle's onEnd
      // (the supersede / explicit-stop path), DO NOT fire onError on
      // top — that double-fires `notifyTtsLifecycle('end')` to the
      // recording-context observer, which re-arms the 500ms resume
      // timer and emits an extra `tts_pcm_gate_released`. The audit
      // of sess_mp9qnay1_h1ik (2026-05-17) tied this redundant churn
      // to the iPad Safari WebContent-process reap; eliminating the
      // duplicate keeps the supersede path tight. Once the WeakSet
      // marks the lifecycle as terminal-fired we treat the natural
      // settle as a no-op for terminal callbacks while still running
      // the listener-detach + blob-URL cleanup below.
      const alreadyTerminal = terminalFiredLifecycles.has(lifecycle);
      if (!alreadyTerminal) {
        terminalFiredLifecycles.add(lifecycle);
        if (!ok && reason) lifecycle.onError?.(reason);
        else if (ok) lifecycle.onEnd?.();
      }
      // Detach element listeners so a later play() (e.g. priming or a
      // fresh dispatch) doesn't trigger this resolved promise's hooks.
      audio.removeEventListener('playing', onPlaying);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onAudioError);
      // Clean up the blob URL only AFTER playback is fully settled
      // so the audio element doesn't yank its own source mid-decode.
      if (activeAbortController === controller) {
        activeAbortController = null;
      }
      if (activeBlobUrl) {
        try {
          URL.revokeObjectURL(activeBlobUrl);
        } catch {
          /* ignore */
        }
        activeBlobUrl = null;
      }
      resolve(ok);
    };

    const onPlaying = () => {
      clientDiagnostic('elevenlabs_audio_playing', {});
      lifecycle.onStart?.();
    };
    const onEnded = () => {
      clientDiagnostic('elevenlabs_audio_ended', {});
      settle(true);
    };
    const onAudioError = () => {
      clientDiagnostic('elevenlabs_audio_error_event', {});
      settle(false, 'play');
    };
    audio.addEventListener('playing', onPlaying, { once: true });
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onAudioError);

    clientDiagnostic('elevenlabs_fetch_start', {});
    fetch(`${API_BASE_URL}/api/proxy/elevenlabs-tts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({ text, sessionId: activeSessionId }),
      signal: controller.signal,
    })
      .then(async (res) => {
        if (controller.signal.aborted) {
          clientDiagnostic('elevenlabs_fetch_aborted_post_response', {});
          settle(false, 'aborted');
          return;
        }
        if (!res.ok) {
          clientDiagnostic('elevenlabs_fetch_not_ok', { status: res.status });
          settle(false, 'fetch');
          return;
        }
        const blob = await res.blob();
        if (controller.signal.aborted) {
          settle(false, 'aborted');
          return;
        }
        clientDiagnostic('elevenlabs_fetch_ok', { blobSize: blob.size });
        const url = URL.createObjectURL(blob);
        activeBlobUrl = url;
        audio.muted = false;
        audio.volume = 1.0;
        audio.src = url;
        const playPromise = audio.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch((err: unknown) => {
            // iOS Safari rejects play() with NotAllowedError when the
            // gesture grant has expired (e.g. the priming utterance
            // never landed inside a real Start tap). Falling back to
            // SpeechSynthesis here is the safest path — the inspector
            // still hears the question, just in the OS voice.
            const name = err instanceof Error ? err.name : 'unknown';
            const message = err instanceof Error ? err.message.slice(0, 120) : '';
            clientDiagnostic('elevenlabs_play_rejected', { errorName: name, message });
            settle(false, 'play');
          });
        }
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) {
          // Distinguish a 12s budget timeout from an external cancel —
          // `timeoutFired` is set only by the timer's own callback, so
          // a cancel from cancelElevenLabs() leaves it false.
          clientDiagnostic('elevenlabs_fetch_aborted', {
            kind: timeoutFired ? 'timeout' : 'external',
          });
          settle(false, timeoutFired ? 'timeout' : 'aborted');
          return;
        }
        const message = err instanceof Error ? err.message : 'fetch failed';
        clientDiagnostic('elevenlabs_fetch_threw', { message: message.slice(0, 120) });
        if (message.includes('aborted') || message.includes('AbortError')) {
          settle(false, 'aborted');
        } else {
          settle(false, 'fetch');
        }
      });
  });
}

/** Test-only: clear all module state so each test starts clean. */
export function __resetElevenLabsForTests(): void {
  cancelElevenLabs();
  sharedAudio = null;
  activeSessionId = null;
  audioGestureGranted = true;
}
