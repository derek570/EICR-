/**
 * SpeechSynthesis wrapper tests — covers the iOS-parity split between
 * the always-on `speak()` path (ask_user prompts, validation alerts,
 * voice-command responses) and the toggle-gated `speakConfirmation()`
 * path (only "Set Zs to 0.44 on circuit 3" style brief reading
 * confirmations).
 *
 * Storage key migration: pre-parity the wrapper used a single
 * `cm-voice-feedback` boolean to gate every speak() call. The new
 * `cm-confirmation-mode` key is read first; if absent, the legacy key
 * is migrated across once so users who already toggled voice feedback
 * on under the old semantics keep their preference (the new scope is
 * strictly narrower so the lift is safe).
 *
 * The SpeechSynthesis shim mirrors the Web Speech API closely enough
 * for the wrapper to round-trip without jsdom's missing implementation
 * tripping the call. We track `cancel` and `speak` invocations so each
 * test can assert the queue-clear step happened before the new
 * utterance was dispatched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelSpeech,
  confirmationToSentence,
  getConfirmationModeEnabled,
  isTtsAvailable,
  setConfirmationModeEnabled,
  speak,
  speakConfirmation,
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

describe('confirmation-mode persistence', () => {
  it('defaults to false when storage is empty', () => {
    expect(getConfirmationModeEnabled()).toBe(false);
  });

  it('persists the toggle through localStorage[cm-confirmation-mode]', () => {
    setConfirmationModeEnabled(true);
    expect(window.localStorage.getItem('cm-confirmation-mode')).toBe('true');
    expect(getConfirmationModeEnabled()).toBe(true);
    setConfirmationModeEnabled(false);
    expect(getConfirmationModeEnabled()).toBe(false);
  });

  it('pre-warms voices on enable (works around iOS Safari empty-voices quirk)', () => {
    setConfirmationModeEnabled(true);
    expect(shim.getVoices).toHaveBeenCalled();
  });

  it('migrates the legacy cm-voice-feedback key on first read', () => {
    // Simulate a user who toggled the pre-parity all-or-nothing
    // voice-feedback flag on. The new confirmation-only scope is
    // strictly narrower, so we lift their preference to the new key
    // without surprising them.
    window.localStorage.setItem('cm-voice-feedback', 'true');
    expect(getConfirmationModeEnabled()).toBe(true);
    // Migration writes through so subsequent reads stay consistent
    // even after the legacy key is later cleared.
    expect(window.localStorage.getItem('cm-confirmation-mode')).toBe('true');
  });

  it('legacy migration is one-shot — explicit new value wins', () => {
    window.localStorage.setItem('cm-voice-feedback', 'true');
    window.localStorage.setItem('cm-confirmation-mode', 'false');
    expect(getConfirmationModeEnabled()).toBe(false);
  });
});

describe('speak() — always-on path', () => {
  it('speaks regardless of the confirmation toggle (matches iOS speakAlertMessage)', () => {
    setConfirmationModeEnabled(false);
    speak('Should the cooker circuit be assigned to circuit 1?');
    expect(shim.speak).toHaveBeenCalledTimes(1);
    expect(shim.spoken[0].text).toBe('Should the cooker circuit be assigned to circuit 1?');
  });

  it('cancels in-flight speech before queueing a new utterance', () => {
    speak('first ask_user');
    speak('second, later ask_user');
    expect(shim.cancel).toHaveBeenCalledTimes(2);
    expect(shim.speak).toHaveBeenCalledTimes(2);
    expect(shim.spoken[1].text).toBe('second, later ask_user');
  });

  it('skips empty strings but still fires onEnd so callers do not stall', () => {
    const onEnd = vi.fn();
    speak('   ', { onEnd });
    expect(shim.speak).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});

describe('speakConfirmation() — gated path', () => {
  it('is silent when the confirmation toggle is off (matches iOS speakBriefConfirmation)', () => {
    setConfirmationModeEnabled(false);
    speakConfirmation('Set Zs to 0.44 on circuit 3.');
    expect(shim.speak).not.toHaveBeenCalled();
  });

  it('speaks when the confirmation toggle is on', () => {
    setConfirmationModeEnabled(true);
    speakConfirmation('Set Zs to 0.44 on circuit 3.');
    expect(shim.speak).toHaveBeenCalledTimes(1);
  });

  it('force=true speaks even when the toggle is off (toggle-on preview)', () => {
    setConfirmationModeEnabled(false);
    speakConfirmation('Confirmations on.', { force: true });
    expect(shim.speak).toHaveBeenCalledTimes(1);
  });

  it('cancels in-flight speech only when actually speaking', () => {
    setConfirmationModeEnabled(false);
    speakConfirmation('muted, should not cancel either');
    expect(shim.cancel).not.toHaveBeenCalled();
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
