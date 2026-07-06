/**
 * End-to-end FIFO behaviour THROUGH the real `speakConfirmation()` +
 * `speak()` public API (native SpeechSynthesis path — no ElevenLabs session).
 *
 * Uses a CONTROLLABLE SpeechSynthesis shim: utterances do NOT auto-complete,
 * so the test drives `onstart`/`onend` manually and can prove that a second
 * confirmation is QUEUED (not spoken concurrently) while the first is busy —
 * the Symptom-1 field bug. Plus the §3.5 tour regression: `speak()`'s `onEnd`
 * still fires across a `cancelSpeech()` step-change.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetTtsWindowForTests,
  cancelSpeech,
  setConfirmationModeEnabled,
  speak,
  speakConfirmation,
} from '@/lib/recording/tts';
import { __resetForTests as __resetTtsQueueForTests } from '@/lib/recording/tts-queue';

class UtteranceShim {
  text: string;
  lang = 'en-GB';
  rate = 1;
  pitch = 1;
  volume = 1;
  voice: SpeechSynthesisVoice | null = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

class SynthShim {
  cancel = vi.fn();
  getVoices = vi.fn(() => [] as SpeechSynthesisVoice[]);
  spoken: UtteranceShim[] = [];
  speak = vi.fn((u: UtteranceShim) => {
    this.spoken.push(u);
  });
  /** Fire the most-recent utterance's start+end (natural completion). */
  completeLast(): void {
    const u = this.spoken[this.spoken.length - 1];
    u?.onstart?.();
    u?.onend?.();
  }
}

let shim: SynthShim;

beforeEach(() => {
  shim = new SynthShim();
  Object.defineProperty(window, 'speechSynthesis', {
    value: shim,
    writable: true,
    configurable: true,
  });
  (window as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance =
    UtteranceShim;
  window.localStorage.clear();
  __resetTtsWindowForTests();
  __resetTtsQueueForTests();
});

afterEach(() => {
  window.localStorage.clear();
  __resetTtsWindowForTests();
  __resetTtsQueueForTests();
});

describe('speakConfirmation FIFO (Symptom 1 regression)', () => {
  it('two confirmations in one turn play SERIALLY, not concurrently', () => {
    setConfirmationModeEnabled(true);
    speakConfirmation('Circuit 2 is now the Upstairs Lighting.');
    speakConfirmation('Circuit 3 is now the Downstairs Lighting.');
    // Only the FIRST has been dispatched to the synth — the second is QUEUED.
    // Pre-fix, the second aborted the first and only ONE was heard.
    expect(shim.speak).toHaveBeenCalledTimes(1);
    expect(shim.spoken[0].text).toBe('Circuit 2 is now the Upstairs Lighting.');
    // Complete the first → the second now dispatches, IN ORDER.
    shim.completeLast();
    expect(shim.speak).toHaveBeenCalledTimes(2);
    expect(shim.spoken[1].text).toBe('Circuit 3 is now the Downstairs Lighting.');
  });

  it('muted confirmations are dropped before enqueue (never occupy a slot)', () => {
    setConfirmationModeEnabled(false);
    speakConfirmation('Set Zs to 0.6 on circuit 2.');
    expect(shim.speak).not.toHaveBeenCalled();
  });
});

describe('tour regression (§3.5 — direct speak path across cancelSpeech)', () => {
  it('speak step N → cancelSpeech() → speak step N+1: N+1 plays and its onEnd fires', () => {
    const onEndN = vi.fn();
    const onEndN1 = vi.fn();
    speak('Step N narration.', { onEnd: onEndN });
    expect(shim.spoken[shim.spoken.length - 1].text).toBe('Step N narration.');
    shim.completeLast();
    expect(onEndN).toHaveBeenCalledTimes(1);
    // Step change cancels (default resetQueue:true — resets the FIFO too).
    cancelSpeech();
    speak('Step N+1 narration.', { onEnd: onEndN1 });
    expect(shim.spoken[shim.spoken.length - 1].text).toBe('Step N+1 narration.');
    shim.completeLast();
    expect(onEndN1).toHaveBeenCalledTimes(1);
  });
});
