/**
 * PLAN-E1 E3 — the poor-signal advisory's delivery semantics: coalescing
 * (fixed key, no double-enqueue), confirmations-toggle gating,
 * discard-WITHOUT-re-park (unlike PLAN-D's mode-status cues), and the
 * started-then-preempted release path (split-round-2) — modelled after
 * `confirmation-mode-status-cue-durability.test.ts`'s harness pattern.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetTtsWindowForTests,
  __resetPoorSignalAdvisoryForTests,
  handlePoorSignalAdvisoryDiscard,
  handlePoorSignalAdvisoryTornDown,
  setConfirmationModeEnabled,
  speak,
  speakConfirmation,
  speakPoorSignalAdvisory,
  POOR_SIGNAL_ADVISORY_TEXT,
} from '@/lib/recording/tts';
import {
  __resetForTests as __resetTtsQueueForTests,
  setOnDiscarded,
  setOnStartedHeadTornDown,
} from '@/lib/recording/tts-queue';

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
  cancel = () => {};
  getVoices = () => [] as SpeechSynthesisVoice[];
  spoken: UtteranceShim[] = [];
  speak = (u: UtteranceShim) => {
    this.spoken.push(u);
  };
  completeLast(): void {
    const u = this.spoken[this.spoken.length - 1];
    u?.onstart?.();
    u?.onend?.();
  }
  startLast(): void {
    this.spoken[this.spoken.length - 1]?.onstart?.();
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
  __resetTtsWindowForTests();
  __resetTtsQueueForTests();
  __resetPoorSignalAdvisoryForTests();
  setConfirmationModeEnabled(true);
  // Mirror recording-context.tsx's production wiring.
  setOnDiscarded((dedupeKey) => {
    handlePoorSignalAdvisoryDiscard(dedupeKey);
  });
  setOnStartedHeadTornDown((dedupeKey) => {
    handlePoorSignalAdvisoryTornDown(dedupeKey);
  });
});

afterEach(() => {
  __resetTtsWindowForTests();
  __resetTtsQueueForTests();
  __resetPoorSignalAdvisoryForTests();
});

describe('speakPoorSignalAdvisory — coalescing + confirmations toggle', () => {
  it('speaks the canonical causally-neutral advisory text', () => {
    const result = speakPoorSignalAdvisory();
    expect(result.enqueued).toBe(true);
    expect(shim.spoken[0]?.text).toBe(POOR_SIGNAL_ADVISORY_TEXT);
  });

  it('a second arm while one is queued/playing is a no-op (coalesced)', () => {
    speakPoorSignalAdvisory();
    expect(shim.spoken.length).toBe(1);
    const second = speakPoorSignalAdvisory();
    expect(second.enqueued).toBe(false);
    expect(shim.spoken.length).toBe(1);
  });

  it('is silent when confirmations are OFF', () => {
    setConfirmationModeEnabled(false);
    const result = speakPoorSignalAdvisory();
    expect(result.enqueued).toBe(false);
    expect(shim.spoken.length).toBe(0);
  });

  it('can re-arm after natural completion', () => {
    speakPoorSignalAdvisory();
    shim.completeLast();
    const second = speakPoorSignalAdvisory();
    expect(second.enqueued).toBe(true);
    expect(shim.spoken.length).toBe(2);
  });
});

describe('speakPoorSignalAdvisory — discard-WITHOUT-re-park', () => {
  it('overflow/preempt eviction before playback starts retires it silently — no re-enqueue', async () => {
    // Occupy the head with an ordinary confirmation so the advisory sits
    // QUEUED, not yet dispatched.
    speakConfirmation('Circuit 1 is now Kitchen Ring.');
    expect(shim.spoken.length).toBe(1);
    speakPoorSignalAdvisory();
    expect(shim.spoken.length).toBe(1); // still queued, not dispatched

    // A direct ask preempts the whole FIFO.
    speak('Which circuit is this?');
    await Promise.resolve(); // flush any microtask (there should be none for the advisory)
    // The advisory must NOT reappear — unlike PLAN-D's mode-status cue.
    expect(shim.spoken.map((u) => u.text)).not.toContain(POOR_SIGNAL_ADVISORY_TEXT);

    // And it can be armed fresh afterward (gate was released, not stuck).
    const rearmed = speakPoorSignalAdvisory();
    expect(rearmed.enqueued).toBe(true);
  });

  it('a direct-prompt preemption (pre-start) discards without replay', () => {
    speakPoorSignalAdvisory();
    expect(shim.spoken.length).toBe(1);
    // Preempt BEFORE it ever starts playing.
    speak('Which circuit is this?');
    expect(shim.spoken[shim.spoken.length - 1].text).toBe('Which circuit is this?');
    expect(shim.spoken.map((u) => u.text)).not.toContain(
      // the advisory should not be re-spoken after this preemption
      POOR_SIGNAL_ADVISORY_TEXT + ' (replay)'
    );
    const rearmed = speakPoorSignalAdvisory();
    expect(rearmed.enqueued).toBe(true);
  });
});

describe('speakPoorSignalAdvisory — started-then-preempted release (split-round-2)', () => {
  it('a STARTED advisory head manually torn down releases the coalescing key', () => {
    speakPoorSignalAdvisory();
    expect(shim.spoken[0]?.text).toBe(POOR_SIGNAL_ADVISORY_TEXT);
    // Mark it as having STARTED (real audio began) without completing it.
    shim.startLast();

    // A direct ask preempts the PLAYING head.
    speak('Which circuit is this?');
    expect(shim.spoken[shim.spoken.length - 1].text).toBe('Which circuit is this?');

    // Without the onStartedHeadTornDown hook, this would be coalesced
    // forever. With it, a fresh arm must succeed.
    const rearmed = speakPoorSignalAdvisory();
    expect(rearmed.enqueued).toBe(true);
  });

  it('enqueue → playback start → preemption → cooldown-irrelevant fresh arm enqueues exactly once', () => {
    speakPoorSignalAdvisory();
    shim.startLast();
    speak('Which circuit is this?');
    speakPoorSignalAdvisory();
    // Exactly one NEW advisory enqueue after the preemption (plus the
    // original + the interrupting direct prompt).
    const advisoryCount = shim.spoken.filter((u) => u.text === POOR_SIGNAL_ADVISORY_TEXT).length;
    expect(advisoryCount).toBe(2);
  });
});
