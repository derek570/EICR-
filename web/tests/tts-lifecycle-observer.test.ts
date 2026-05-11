/**
 * Regression test for the TTS lifecycle observer pattern (Bug D, 2026-05-11).
 *
 * Pins the contract:
 *   - setTtsLifecycleObserver(fn) registers a callback
 *   - setTtsLifecycleObserver(null) clears it
 *   - speak() / speakConfirmation() fires 'start' when audio begins flowing
 *     and 'end' when the window closes (utterance ended OR cancelled)
 *   - cancelSpeech() fires 'end' if a window was open
 *   - registering replaces the previous observer (no chaining)
 *   - a thrown observer does not blow up the TTS path
 *
 * Tests use the native SpeechSynthesis path (the simpler of the two
 * dispatchers — ElevenLabs requires a live audio element + fetch mock).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetTtsFingerprintsForTests,
  cancelSpeech,
  setTtsLifecycleObserver,
  speak,
} from '@/lib/recording/tts';

interface FakeUtterance {
  text: string;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

let utterances: FakeUtterance[] = [];

beforeEach(() => {
  utterances = [];
  // Polyfill speechSynthesis + SpeechSynthesisUtterance for the test
  // environment. jsdom doesn't ship these by default. Each speak() call
  // pushes a FakeUtterance onto `utterances` so the test can manually
  // fire its onstart / onend / onerror.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).window = (globalThis as any).window ?? {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).SpeechSynthesisUtterance = class {
    text: string;
    lang = 'en-GB';
    rate = 1;
    pitch = 1;
    volume = 1;
    voice: unknown = null;
    onstart: (() => void) | null = null;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(text: string) {
      this.text = text;
    }
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).speechSynthesis = {
    speak: (u: FakeUtterance) => {
      utterances.push(u);
    },
    cancel: () => {
      utterances = [];
    },
    getVoices: () => [],
  };
  __resetTtsFingerprintsForTests();
});

afterEach(() => {
  setTtsLifecycleObserver(null);
  __resetTtsFingerprintsForTests();
  vi.clearAllMocks();
});

describe('TTS lifecycle observer', () => {
  it('fires start on speak() and end on utterance.onend', () => {
    const observer = vi.fn();
    setTtsLifecycleObserver(observer);

    speak('hello world');
    expect(utterances.length).toBe(1);

    // Native dispatch opens ttsWindow synchronously inside dispatchNative
    // — observer should already have been notified 'start'.
    expect(observer).toHaveBeenCalledWith('start');

    // Fire the utterance's end event
    utterances[0].onend?.();
    expect(observer).toHaveBeenCalledWith('end');
    expect(observer).toHaveBeenCalledTimes(2);
  });

  it('fires end on utterance.onerror as well', () => {
    const observer = vi.fn();
    setTtsLifecycleObserver(observer);

    speak('hello');
    expect(observer).toHaveBeenLastCalledWith('start');

    utterances[0].onerror?.();
    expect(observer).toHaveBeenLastCalledWith('end');
  });

  it('fires end when cancelSpeech() closes an open window', () => {
    const observer = vi.fn();
    setTtsLifecycleObserver(observer);

    speak('hello');
    expect(observer).toHaveBeenLastCalledWith('start');

    cancelSpeech();
    expect(observer).toHaveBeenLastCalledWith('end');
  });

  it('does NOT fire end on cancelSpeech() when no window is open', () => {
    const observer = vi.fn();
    setTtsLifecycleObserver(observer);

    cancelSpeech();
    expect(observer).not.toHaveBeenCalled();
  });

  it('passing null clears the observer', () => {
    const first = vi.fn();
    setTtsLifecycleObserver(first);
    setTtsLifecycleObserver(null);

    speak('hello');
    expect(first).not.toHaveBeenCalled();
  });

  it('registering a new observer replaces the previous one (no chaining)', () => {
    const first = vi.fn();
    const second = vi.fn();
    setTtsLifecycleObserver(first);
    setTtsLifecycleObserver(second);

    speak('hello');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('start');
  });

  it('a throwing observer does not blow up the dispatch', () => {
    const observer = vi.fn(() => {
      throw new Error('observer is broken');
    });
    setTtsLifecycleObserver(observer);

    // speak() should still complete and queue the utterance, even though
    // the observer threw. Mirrors iOS where TTS failures never abort the
    // recording session.
    expect(() => speak('hello')).not.toThrow();
    expect(utterances.length).toBe(1);
  });
});
