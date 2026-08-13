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
  __resetTtsWindowForTests,
  cancelSpeech,
  isDirectAudioActive,
  speak,
  speakConfirmation,
} from '@/lib/recording/tts';
import {
  __resetForTests as __resetTtsQueueForTests,
  resumeIfDeferred,
  setShouldDeferPlayback,
} from '@/lib/recording/tts-queue';

const API_BASE = 'http://localhost:3000';
const TOKEN_KEY = 'cm_token';

const server = setupServer();

/** Minimal SpeechSynthesis polyfill — only needed so `isTtsAvailable()`
 *  returns true (`speak()`/`speakConfirmation()` early-return otherwise).
 *  Never actually invoked: the ask routes via ElevenLabs (session set,
 *  `dispatchElevenLabs` cancels any in-flight native utterance up front but
 *  never calls `speak()` on it), and the confirmation's ElevenLabs branch
 *  never falls back to native in this test. */
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
  speak = vi.fn();
}

beforeEach(() => {
  server.listen({ onUnhandledRequest: 'error' });
  window.localStorage.setItem(TOKEN_KEY, 'test-token');
  Object.defineProperty(window, 'speechSynthesis', {
    value: new SynthShim(),
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
});

afterEach(() => {
  server.resetHandlers();
  server.close();
  window.localStorage.clear();
  __resetElevenLabsForTests();
  __resetTtsWindowForTests();
  __resetTtsQueueForTests();
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
});
