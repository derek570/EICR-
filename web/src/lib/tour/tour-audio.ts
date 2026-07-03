'use client';

/**
 * Pre-recorded tour narration playback.
 *
 * The guided tour narration is served as bundled static MP3s
 * (`/public/tour-audio/tour_step_1..11.mp3`) — the exact files iOS ships
 * in `Sources/Resources/TourAudio/`, generated ONCE from ElevenLabs
 * `eleven_v3` (the Archer voice) via `CertMateUnified/generate-tour-audio.sh`.
 *
 * WHY pre-recorded rather than live TTS:
 *  - COST: the tour narrates ~11 steps of long-form text. Synthesising
 *    that live through the ElevenLabs proxy on EVERY tour run would burn
 *    ElevenLabs characters for a script that never changes. Pre-baked
 *    audio is zero runtime TTS cost. This is the whole reason iOS bundles
 *    the files instead of calling `speakWithTTS` for the tour.
 *  - QUALITY: it's the real Archer voice, not the OS SpeechSynthesis voice
 *    (which the field described as "awful").
 *
 * Step 6 (`job-tone`) is special: iOS splices the real "sent for
 * processing" chime INTO `tour_step_6.mp3` (`build_step6` in the generate
 * script), so the bundled file already contains the tone. The caller must
 * therefore NOT also play `playSentForProcessingChime()` on the bundled
 * path (that's only for the SpeechSynthesis fallback, which can't splice).
 *
 * Fallback: any environment without HTMLAudioElement, or where `play()`
 * is blocked/rejects (autoplay policy on a first-run auto-start with no
 * gesture, jsdom in tests), routes through `onError` so the caller can
 * degrade to the existing Web Speech narration path. No behaviour is lost
 * relative to before — the MP3 is a strict upgrade when it can play.
 */

// Single reused element for the page lifetime — mirrors the shared-audio
// pattern in elevenlabs-tts.ts. Reusing one element means a gesture grant
// earned on an earlier step (manual "Start tour" tap, a Next tap) carries
// to later steps under iOS Safari's autoplay policy.
let tourAudio: HTMLAudioElement | null = null;

function getTourAudio(): HTMLAudioElement | null {
  if (typeof window === 'undefined' || typeof window.Audio !== 'function') return null;
  if (!tourAudio) {
    tourAudio = new Audio();
    tourAudio.preload = 'auto';
  }
  return tourAudio;
}

/**
 * Stop any in-flight tour narration audio and detach its listeners so a
 * teardown-triggered `error`/`ended` can't fire a stale callback (which
 * would spuriously start the Web Speech fallback on unmount). Idempotent.
 */
export function cancelTourAudio(): void {
  if (!tourAudio) return;
  try {
    tourAudio.onended = null;
    tourAudio.onerror = null;
    tourAudio.pause();
    tourAudio.removeAttribute('src');
    tourAudio.load();
  } catch {
    /* ignore — cancel is best-effort */
  }
}

/**
 * Play the bundled narration MP3 for `audioStep` (1-based, matching the
 * iOS `tour_step_<n>.mp3` numbering). Fires exactly one of `onEnd` (audio
 * finished naturally) or `onError` (no Audio element / load failure /
 * play() rejected/threw). The caller maps `onError` to the Web Speech
 * fallback.
 */
export function playTourAudio(
  audioStep: number,
  handlers: { onEnd: () => void; onError: () => void }
): void {
  const audio = getTourAudio();
  if (!audio) {
    handlers.onError();
    return;
  }

  let settled = false;
  const settle = (ok: boolean) => {
    if (settled) return;
    settled = true;
    audio.onended = null;
    audio.onerror = null;
    if (ok) handlers.onEnd();
    else handlers.onError();
  };

  audio.onended = () => settle(true);
  audio.onerror = () => settle(false);

  try {
    audio.src = `/tour-audio/tour_step_${audioStep}.mp3`;
    audio.currentTime = 0;
    audio.muted = false;
    audio.volume = 1.0;
    const p = audio.play();
    if (p && typeof p.catch === 'function') {
      p.catch(() => settle(false));
    }
  } catch {
    // jsdom / older browsers throw synchronously from play() or src set.
    settle(false);
  }
}

/** Test-only — reset the shared element so each test starts clean. */
export function __resetTourAudioForTests(): void {
  cancelTourAudio();
  tourAudio = null;
}
