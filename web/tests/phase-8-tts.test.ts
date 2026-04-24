/**
 * Phase 8 — SpeechSynthesis wrapper tests.
 *
 * Covers:
 *   - The enabled flag persists through localStorage['cm-voice-feedback'].
 *   - `speak()` is a no-op when TTS is disabled (the default) and a
 *     cancel-then-speak when enabled — mirrors iOS where a fresh
 *     confirmation evicts whatever the previous turn was saying.
 *   - `confirmationToSentence()` composes "Set {label} to {value} on
 *     circuit {N}." from the server's structured confirmation payload.
 *   - `force: true` lets the one-shot preview speak even when the
 *     persisted preference is off.
 *
 * The SpeechSynthesis shim installed below mirrors the Web Speech API
 * closely enough for the wrapper to round-trip without jsdom's missing
 * implementation tripping the call. We track `cancel` and `speak`
 * invocations on the shim so the test can assert the queue-clear step
 * happened before the new utterance was dispatched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelSpeech,
  confirmationToSentence,
  getVoiceFeedbackEnabled,
  isTtsAvailable,
  setVoiceFeedbackEnabled,
  speak,
} from '@/lib/recording/tts';

type ShimUtterance = {
  text: string;
  lang?: string;
  voice?: SpeechSynthesisVoice | null;
};

class SpeechSynthesisUtteranceShim {
  text: string;
  lang = 'en-GB';
  rate = 1;
  pitch = 1;
  volume = 1;
  voice: SpeechSynthesisVoice | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

class SpeechSynthesisShim {
  cancel = vi.fn();
  getVoices = vi.fn(() => [] as SpeechSynthesisVoice[]);
  speak = vi.fn((u: ShimUtterance) => {
    this.spoken.push(u);
  });
  spoken: ShimUtterance[] = [];
}

let shim: SpeechSynthesisShim;

beforeEach(() => {
  shim = new SpeechSynthesisShim();
  Object.defineProperty(window, 'speechSynthesis', {
    value: shim,
    writable: true,
    configurable: true,
  });
  (window as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance =
    SpeechSynthesisUtteranceShim;
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('isTtsAvailable', () => {
  it('returns true when SpeechSynthesis is present on window', () => {
    expect(isTtsAvailable()).toBe(true);
  });
});

describe('voice-feedback persistence', () => {
  it('defaults to false when storage is empty', () => {
    expect(getVoiceFeedbackEnabled()).toBe(false);
  });

  it('persists the toggle through localStorage', () => {
    setVoiceFeedbackEnabled(true);
    expect(window.localStorage.getItem('cm-voice-feedback')).toBe('true');
    expect(getVoiceFeedbackEnabled()).toBe(true);
    setVoiceFeedbackEnabled(false);
    expect(getVoiceFeedbackEnabled()).toBe(false);
  });

  it('pre-warms voices on enable (works around iOS Safari empty-voices quirk)', () => {
    setVoiceFeedbackEnabled(true);
    expect(shim.getVoices).toHaveBeenCalled();
  });
});

describe('speak()', () => {
  it('is a no-op when the toggle is off', () => {
    setVoiceFeedbackEnabled(false);
    speak('should not speak');
    expect(shim.speak).not.toHaveBeenCalled();
  });

  it('cancels any in-flight utterance before queueing a new one', () => {
    setVoiceFeedbackEnabled(true);
    speak('first confirmation');
    speak('second, later confirmation');
    // cancel() should fire every time speak() does — that's the guard
    // against stale confirmations piling up in the browser's utterance
    // queue.
    expect(shim.cancel).toHaveBeenCalledTimes(2);
    expect(shim.speak).toHaveBeenCalledTimes(2);
    expect(shim.spoken[1].text).toBe('second, later confirmation');
  });

  it('force=true speaks even when the toggle is off (toggle-on preview)', () => {
    setVoiceFeedbackEnabled(false);
    speak('Voice feedback on.', { force: true });
    expect(shim.speak).toHaveBeenCalledTimes(1);
  });

  it('skips empty strings', () => {
    setVoiceFeedbackEnabled(true);
    speak('   ');
    expect(shim.speak).not.toHaveBeenCalled();
  });
});

describe('cancelSpeech', () => {
  it('delegates to speechSynthesis.cancel', () => {
    cancelSpeech();
    expect(shim.cancel).toHaveBeenCalledTimes(1);
  });
});

describe('confirmationToSentence', () => {
  it('prefers an explicit text payload', () => {
    expect(
      confirmationToSentence({ text: 'Polarity confirmed on circuit 3', field: null, circuit: 3 })
    ).toBe('Polarity confirmed on circuit 3');
  });

  it('synthesises "Set {label} to {value} on circuit {N}" when text is empty', () => {
    expect(confirmationToSentence({ field: 'zs', value: 0.44, circuit: 3 })).toBe(
      'Set Zs to 0.44 on circuit 3.'
    );
  });

  it('omits the circuit suffix for circuit-0 (supply) readings', () => {
    expect(confirmationToSentence({ field: 'ze', value: '0.35', circuit: 0 })).toBe(
      'Set Ze to 0.35.'
    );
  });

  it('returns an empty string when neither text nor field+value are set', () => {
    expect(confirmationToSentence({})).toBe('');
  });
});
