/**
 * Codex diff-review r4/r5 BLOCKER (PLAN-D) — `prepareElevenLabs()` calls
 * `cancelElevenLabs()` UNCONDITIONALLY at its own entry, before any fetch
 * and therefore before the confirmation queue's own `shouldDeferPlayback()`
 * last-mile gate is ever consulted. Enqueuing a confirmation (any
 * confirmation — including a PLAN-D mode-status cue, but this is shared
 * `playConfirmationHead` code, not something specific to it) into an
 * otherwise-idle queue while a direct `speak()` ask owns the ElevenLabs
 * audio channel would kill the ask's audio before it had any chance to be
 * deferred instead — the opposite of "defer behind an active ask rather
 * than dropping".
 *
 * `playConfirmationHead` now checks `isDirectAudioActive()` BEFORE calling
 * `prepareElevenLabs()`: if a direct ask owns the channel, it hands the
 * queue a LAZY prepared handle (nothing fetched yet) that only re-enters
 * `playConfirmationHead` on resume — the queue's own `shouldDeferPlayback()`
 * gate sees the identical `isDirectAudioActive()` state synchronously (no
 * fetch has happened in between) and parks it as an ordinary deferred head.
 *
 * This test drives the REAL production code path — `speak()`,
 * `speakConfirmation()`, `tts-queue.ts`'s pump/defer machinery, and
 * `elevenlabs-tts.ts`'s `prepareElevenLabs()` — through the same msw +
 * mocked-HTMLMediaElement harness `elevenlabs-tts.test.ts` uses, counting
 * actual fetches to `/api/proxy/elevenlabs-tts` issued rather than mocking
 * out the code under test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

import { __resetElevenLabsForTests, setActiveSessionId } from '@/lib/recording/elevenlabs-tts';
import {
  __resetModeStatusCuesForTests,
  __resetTtsWindowForTests,
  cancelSpeech,
  handleModeStatusCueDiscard,
  handleModeStatusCuePlaybackStarted,
  isDirectAudioActive,
  isTTSEcho,
  speak,
  speakConfirmation,
  speakConfirmationModeStatus,
  __resetTtsFingerprintsForTests,
} from '@/lib/recording/tts';
import {
  __resetForTests as __resetTtsQueueForTests,
  resumeIfDeferred,
  setOnDiscarded,
  setOnPlaybackStarted,
  setShouldDeferPlayback,
} from '@/lib/recording/tts-queue';

const API_BASE = 'http://localhost:3000';
const TOKEN_KEY = 'cm_token';

const server = setupServer();

/** Minimal SpeechSynthesis polyfill — needed so `isTtsAvailable()` returns
 *  true (`speak()`/`speakConfirmation()` early-return otherwise), and so the
 *  ElevenLabs-play()-rejects test below can assert on the native fallback
 *  it triggers. */
class UtteranceShim {
  constructor(public text: string) {}
  lang = 'en-GB';
  rate = 1;
  pitch = 1;
  volume = 1;
  voice: SpeechSynthesisVoice | null = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
}
class SynthShim {
  cancel = vi.fn();
  getVoices = vi.fn(() => [] as SpeechSynthesisVoice[]);
  spoken: UtteranceShim[] = [];
  speak = vi.fn((u: UtteranceShim) => {
    this.spoken.push(u);
  });
}

let shim: SynthShim;

beforeEach(() => {
  server.listen({ onUnhandledRequest: 'error' });
  window.localStorage.setItem(TOKEN_KEY, 'test-token');
  shim = new SynthShim();
  Object.defineProperty(window, 'speechSynthesis', {
    value: shim,
    writable: true,
    configurable: true,
  });
  (window as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance =
    UtteranceShim;

  // Same jsdom media no-op patch as elevenlabs-tts.test.ts — jsdom never
  // fires 'playing'/'ended', so `activeAudioOwner` only changes when this
  // test explicitly cancels it, which is exactly the control this test needs.
  const proto = HTMLMediaElement.prototype as unknown as {
    play: () => Promise<void>;
    pause: () => void;
    load: () => void;
  };
  proto.play = vi.fn(() => Promise.resolve());
  proto.pause = vi.fn();
  proto.load = vi.fn();

  __resetElevenLabsForTests();
  __resetTtsWindowForTests();
  __resetTtsQueueForTests();
  __resetModeStatusCuesForTests();
  __resetTtsFingerprintsForTests();
  // Mirror recording-context.tsx's production wiring: the queue's discard/
  // playback-started hooks consult the mode-status cue handlers FIRST.
  setOnDiscarded((dedupeKey, reason) => {
    handleModeStatusCueDiscard(dedupeKey, reason);
  });
  setOnPlaybackStarted((dedupeKey) => {
    handleModeStatusCuePlaybackStarted(dedupeKey);
  });
});

afterEach(() => {
  server.resetHandlers();
  server.close();
  window.localStorage.clear();
  __resetElevenLabsForTests();
  __resetTtsWindowForTests();
  __resetTtsQueueForTests();
  __resetModeStatusCuesForTests();
  __resetTtsFingerprintsForTests();
});

describe('confirmation FIFO — ElevenLabs path defers behind an active direct ask', () => {
  it('does not fetch (and does not cancel the ask) while the ask owns the channel; fetches + plays once resumed', async () => {
    setActiveSessionId('sess-guard-1');
    // Mirrors recording-context.tsx's production wiring exactly.
    setShouldDeferPlayback(() => isDirectAudioActive());

    let fetchCount = 0;
    server.use(
      http.post(`${API_BASE}/api/proxy/elevenlabs-tts`, async () => {
        fetchCount += 1;
        return new HttpResponse(new ArrayBuffer(8), {
          headers: { 'Content-Type': 'audio/mpeg' },
        });
      })
    );

    // Direct ask starts — activeAudioOwner is set to 'direct' SYNCHRONOUSLY
    // inside dispatch(), before its own fetch even resolves.
    speak('Which circuit is this?');
    expect(isDirectAudioActive()).toBe(true);
    await vi.waitFor(() => expect(fetchCount).toBe(1)); // the ask's own fetch

    // A confirmation arrives while the ask is still active. Pre-fix this
    // synchronously called prepareElevenLabs() -> cancelElevenLabs(),
    // killing the ask's audio before the defer gate ever ran.
    const { enqueued } = speakConfirmation('Voice read-backs off.');
    expect(enqueued).toBe(true);
    // Let any (incorrect) synchronous fetch have a chance to fire.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchCount).toBe(1); // no premature second fetch
    expect(isDirectAudioActive()).toBe(true); // the ask was NOT cancelled

    // End the ask (barge-in cancel — clears the direct owner without
    // touching the confirmation queue).
    cancelSpeech({ resetQueue: false });
    expect(isDirectAudioActive()).toBe(false);

    // The channel is now free — resume plays the deferred confirmation,
    // which re-enters playConfirmationHead and (this time) really fetches.
    resumeIfDeferred();
    await vi.waitFor(() => expect(fetchCount).toBe(2));
  });

  // Codex diff-review r6 BLOCKER — `preemptFlush()` used to discard the
  // waiting QUEUE before the CURRENT (deferred) head. `onDiscarded` for a
  // mode-status cue re-parks via a `queueMicrotask`, and microtasks run in
  // scheduling order — so firing the queue first meant a later-queued cue's
  // re-park microtask ran BEFORE the earlier head's, reversing playback
  // order once both resumed. Fixed by tearing down the head first.
  it('preempting a deferred head cue AND a queued cue re-parks them in original chronological order', async () => {
    setActiveSessionId('sess-order-1');
    setShouldDeferPlayback(() => isDirectAudioActive());

    const fetchedTexts: string[] = [];
    server.use(
      http.post(`${API_BASE}/api/proxy/elevenlabs-tts`, async ({ request }) => {
        const body = (await request.json()) as { text: string };
        fetchedTexts.push(body.text);
        return new HttpResponse(new ArrayBuffer(8), {
          headers: { 'Content-Type': 'audio/mpeg' },
        });
      })
    );

    // First ask owns the channel.
    speak('Which circuit is this?');
    await vi.waitFor(() => expect(fetchedTexts).toEqual(['Which circuit is this?']));

    // OFF becomes the deferred head; ON queues behind it. Neither has fetched.
    speakConfirmationModeStatus('Voice read-backs off.');
    speakConfirmationModeStatus('Voice read-backs on.');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchedTexts).toEqual(['Which circuit is this?']);

    // A SECOND ask preempts both mode-status cues before either ever plays.
    speak('Another question?');
    await vi.waitFor(() =>
      expect(fetchedTexts).toEqual(['Which circuit is this?', 'Another question?'])
    );

    // End the second ask.
    cancelSpeech({ resetQueue: false });
    expect(isDirectAudioActive()).toBe(false);

    // Resume — the FIRST thing to actually fetch after the round trip must
    // be OFF (it was chronologically first), not ON.
    resumeIfDeferred();
    await vi.waitFor(() => expect(fetchedTexts.length).toBe(3));
    expect(fetchedTexts[2]).toBe('Voice read-backs off.');
  });
});

describe('confirmation FIFO — ElevenLabs deferral does not register a premature echo fingerprint', () => {
  // Codex diff-review r6 NIT — `registerTtsFingerprint(text)` used to fire
  // unconditionally at the TOP of `playConfirmationHead`, including on the
  // LAZY (not-yet-fetched) pass. That marked the cue's text as "just heard"
  // up to several seconds before any audio actually played, so a genuinely
  // spoken inspector utterance that happened to resemble the pending cue's
  // text could be wrongly suppressed as an echo of something never heard.
  it('a mode-status cue deferred behind an active ask is NOT fingerprinted until it actually resumes', async () => {
    setActiveSessionId('sess-fingerprint-1');
    setShouldDeferPlayback(() => isDirectAudioActive());

    server.use(
      http.post(`${API_BASE}/api/proxy/elevenlabs-tts`, async () =>
        new HttpResponse(new ArrayBuffer(8), { headers: { 'Content-Type': 'audio/mpeg' } })
      )
    );

    speak('Which circuit is this?');
    speakConfirmationModeStatus('Voice read-backs off.');
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Deferred, never fetched yet — must not be recognised as an echo of
    // something that was never actually spoken.
    expect(isTTSEcho('Voice read-backs off.')).toBe(false);

    cancelSpeech({ resetQueue: false });
    resumeIfDeferred();

    // Now the real dispatch has fired — the fingerprint registers exactly
    // at this point, not before.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(isTTSEcho('Voice read-backs off.')).toBe(true);
  });

  // Codex diff-review r7 NIT — r6's fix only moved registration out of the
  // `isDirectAudioActive()` LAZY branch (pre-fetch). It still registered
  // right before `prepareElevenLabs()` starts the fetch — which is BEFORE
  // the queue's own last-mile `shouldDeferPlayback()` gate (in
  // `controls.ready`, checked once the fetch completes) has a chance to
  // defer for an UNRELATED reason (in production: the inspector currently
  // speaking, not a direct ask). This proves that residual case is closed
  // too — using a generic `shouldDeferPlayback` override, not
  // `isDirectAudioActive()`, so the fix is verified to be general rather
  // than tied to the one specific defer trigger r6 already covered.
  it('a confirmation deferred by the last-mile gate for an UNRELATED reason (fetch already completed) is not fingerprinted until it resumes', async () => {
    setActiveSessionId('sess-fingerprint-2');
    let deferring = false;
    setShouldDeferPlayback(() => deferring);

    server.use(
      http.post(`${API_BASE}/api/proxy/elevenlabs-tts`, async () =>
        new HttpResponse(new ArrayBuffer(8), { headers: { 'Content-Type': 'audio/mpeg' } })
      )
    );

    // Gate is already true when the confirmation is enqueued — no direct
    // ask involved, so `isDirectAudioActive()` stays false throughout; this
    // exercises the POST-fetch last-mile gate, not the pre-fetch lazy branch.
    deferring = true;
    speakConfirmation('Circuit 2 is now Kitchen Ring.');
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Fetched and parked as deferredHead — must not be fingerprinted yet.
    expect(isTTSEcho('Circuit 2 is now Kitchen Ring.')).toBe(false);

    deferring = false;
    resumeIfDeferred();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(isTTSEcho('Circuit 2 is now Kitchen Ring.')).toBe(true);
  });
});

// Codex diff-review r8 IMPORTANT — a PREPARED ElevenLabs clip whose
// `audio.play()` itself rejects (e.g. an expired iOS Safari gesture grant,
// discovered one tick after a successful fetch) arrives at
// `playConfirmationHead`'s ElevenLabs `onError` with `myStartMs` still
// null — a genuine pre-playback failure, not a mid-playback one, but the
// old code treated every `onError` reaching this handler as terminal with
// no fallback, silently dropping the confirmation.
describe('confirmation FIFO — a post-prepare play() rejection falls back to native, not silence', () => {
  it('does not drop the confirmation when audio.play() rejects before "playing" ever fires', async () => {
    setActiveSessionId('sess-play-reject-1');
    setShouldDeferPlayback(() => false);

    server.use(
      http.post(`${API_BASE}/api/proxy/elevenlabs-tts`, async () =>
        new HttpResponse(new ArrayBuffer(8), { headers: { 'Content-Type': 'audio/mpeg' } })
      )
    );

    // Override play() for this test only — rejects, simulating the fetch
    // succeeding but the browser refusing the actual play() call.
    const proto = HTMLMediaElement.prototype as unknown as { play: () => Promise<void> };
    proto.play = vi.fn(() => Promise.reject(new Error('NotAllowedError')));

    const { enqueued } = speakConfirmation('Circuit 4 is now Landing Light.');
    expect(enqueued).toBe(true);

    // Native fallback must have spoken it — never silently dropped.
    await vi.waitFor(() => expect(shim.speak).toHaveBeenCalledTimes(1));
    expect(shim.spoken[0].text).toBe('Circuit 4 is now Landing Light.');
  });
});
