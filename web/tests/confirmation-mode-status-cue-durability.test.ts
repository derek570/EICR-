/**
 * PLAN-D web companion — Codex diff review r1 (2/3 lenses, BLOCKER) found
 * that a bare `speakConfirmation(text, {force:true})` call (this file's
 * first cut) satisfies "bypasses dedupe" and "never resets the FIFO" but
 * NOT "defers behind an active ask rather than dropping": `speak()`'s
 * `preemptFlush()` and the queue's own overflow drop-oldest both destroy a
 * still-queued item unconditionally, and a bare `speakConfirmation` call
 * passes no `dedupeKey`, so the discard was silent and the cue was lost.
 *
 * This file proves the fix: `speakConfirmationModeStatus` + the
 * `handleModeStatusCueDiscard`/`handleModeStatusCuePlaybackStarted` hooks
 * (wired into `tts-queue`'s `onDiscarded`/`onPlaybackStarted`, mirroring
 * exactly how `recording-context.tsx` wires them in production) re-enqueue
 * a cue destroyed by a queue-lifecycle event instead of losing it, while
 * still never resurrecting a cue across a full session teardown.
 *
 * Uses the CONTROLLABLE SpeechSynthesis shim from
 * tts-fifo-confirmation.test.ts (utterances do not auto-complete) so the
 * test can hold the channel busy and drive preemption at will.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetTtsWindowForTests,
  cancelSpeech,
  handleModeStatusCueDiscard,
  handleModeStatusCuePlaybackStarted,
  setConfirmationModeEnabled,
  speak,
  speakConfirmation,
  speakConfirmationModeStatus,
} from '@/lib/recording/tts';
import {
  __resetForTests as __resetTtsQueueForTests,
  setOnDiscarded,
  setOnPlaybackStarted,
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
  setConfirmationModeEnabled(true);
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
  window.localStorage.clear();
  __resetTtsWindowForTests();
  __resetTtsQueueForTests();
});

describe('speakConfirmationModeStatus — survives preemptFlush (Codex r1 BLOCKER)', () => {
  it('a QUEUED (not-yet-playing) cue destroyed by a direct speak() ask is re-parked and plays after', async () => {
    setConfirmationModeEnabled(true);
    // Occupy the head with an ordinary confirmation so the mode-status cue
    // sits in `queue`, not yet dispatched.
    speakConfirmation('Circuit 1 is now Kitchen Ring.');
    expect(shim.speak).toHaveBeenCalledTimes(1);
    speakConfirmationModeStatus('Voice read-backs off.');
    // Still only the head has been dispatched — the cue is QUEUED.
    expect(shim.speak).toHaveBeenCalledTimes(1);

    // A direct ask arrives — preempts the whole confirmation FIFO.
    speak('Which circuit is this?');
    // speak() dispatches immediately via the direct path.
    expect(shim.spoken[shim.spoken.length - 1].text).toBe('Which circuit is this?');
    // The re-enqueue is deferred to a microtask (see handleModeStatusCueDiscard's
    // docblock — a synchronous re-enqueue from inside preemptFlush()'s live
    // iteration would cascade). Flush microtasks before asserting.
    await Promise.resolve();
    // Nothing else is busy, so the re-parked cue should already be the new
    // head and have been dispatched.
    expect(shim.spoken[shim.spoken.length - 1].text).toBe('Voice read-backs off.');
    shim.completeLast();

    const spokenTexts = shim.spoken.map((u) => u.text);
    expect(spokenTexts).toContain('Voice read-backs off.');
  });

  it('a cue that IS the current head when preempted is also re-parked', async () => {
    setConfirmationModeEnabled(true);
    speakConfirmationModeStatus('Voice read-backs off.');
    expect(shim.speak).toHaveBeenCalledTimes(1);
    expect(shim.spoken[0].text).toBe('Voice read-backs off.');

    // Preempted before it ever completes.
    speak('Which circuit is this?');
    await Promise.resolve(); // flush the deferred re-enqueue
    shim.completeLast(); // completes "Which circuit is this?"

    // Re-parked and re-enqueued — plays again once the channel is free.
    const spokenTexts = shim.spoken.map((u) => u.text);
    expect(spokenTexts.filter((t) => t === 'Voice read-backs off.').length).toBeGreaterThanOrEqual(
      1
    );
  });

  it('a rapid off→on→off (3 flips) is heard three times — dedupe bypass survives re-park too', () => {
    setConfirmationModeEnabled(true);
    speakConfirmationModeStatus('Voice read-backs off.');
    speakConfirmationModeStatus('Voice read-backs on.');
    speakConfirmationModeStatus('Voice read-backs off.');
    // Drain the FIFO fully.
    while (shim.spoken.length < 3 || shim.spoken[shim.spoken.length - 1].onstart) {
      const before = shim.spoken.length;
      shim.completeLast();
      if (shim.spoken.length === before) break; // nothing new dispatched — drained
    }
    expect(shim.speak).toHaveBeenCalledTimes(3);
    expect(shim.spoken.map((u) => u.text)).toEqual([
      'Voice read-backs off.',
      'Voice read-backs on.',
      'Voice read-backs off.',
    ]);
  });
});

describe('speakConfirmationModeStatus — never resurrected across a session teardown', () => {
  it('cancelSpeech({resetQueue:true}) drops a still-queued cue permanently (no infinite loop, no cross-session leak)', () => {
    setConfirmationModeEnabled(true);
    speakConfirmation('Circuit 1 is now Kitchen Ring.');
    speakConfirmationModeStatus('Voice read-backs off.');
    expect(shim.speak).toHaveBeenCalledTimes(1);

    // Full teardown — must terminate (this is the infinite-loop hazard
    // handleModeStatusCueDiscard's docblock describes) and must NOT
    // re-enqueue the cue.
    expect(() => cancelSpeech({ resetQueue: true })).not.toThrow();

    // Start a brand-new "session" — nothing should be waiting to play.
    speakConfirmation('Circuit 2 is now Hallway Lighting.');
    expect(shim.spoken[shim.spoken.length - 1].text).toBe('Circuit 2 is now Hallway Lighting.');
    expect(shim.spoken.some((u) => u.text === 'Voice read-backs off.')).toBe(false);
  });

  // Codex diff-review r2 BLOCKER — modeStatusCueTexts.clear() alone cannot
  // cancel a re-park microtask that was ALREADY SCHEDULED (its closure
  // already captured the cue's text) before the teardown ran.
  // modeStatusGeneration closes this gap.
  it('a re-park microtask ALREADY SCHEDULED before teardown does not resurrect the cue either', async () => {
    setConfirmationModeEnabled(true);
    speakConfirmation('Circuit 1 is now Kitchen Ring.');
    speakConfirmationModeStatus('Voice read-backs off.');
    expect(shim.speak).toHaveBeenCalledTimes(1);

    // Preempt — this is what SCHEDULES the re-park microtask (synchronously,
    // inside preemptFlush()'s discard loop).
    speak('Which circuit is this?');

    // Teardown happens BEFORE the microtask has a chance to run.
    expect(() => cancelSpeech({ resetQueue: true })).not.toThrow();

    // NOW flush microtasks — the already-scheduled re-park callback fires,
    // but must see the bumped generation and no-op.
    await Promise.resolve();

    speakConfirmation('Circuit 2 is now Hallway Lighting.');
    expect(shim.spoken[shim.spoken.length - 1].text).toBe('Circuit 2 is now Hallway Lighting.');
    expect(shim.spoken.some((u) => u.text === 'Voice read-backs off.')).toBe(false);
  });
});

// Codex diff-review r2 BLOCKER — queue-overflow eviction has no natural
// pacing (unlike preemptFlush(), which fires once per genuine ask), so a
// re-parked cue re-evicted by the NEXT overflow-triggering enqueue could
// thrash indefinitely under sustained queue pressure. Mode-status cues are
// now `protected` and exempt from overflow eviction entirely.
describe('speakConfirmationModeStatus — exempt from queue-overflow eviction', () => {
  it('a mode-status cue survives overflow pressure that would evict an ordinary confirmation', () => {
    setConfirmationModeEnabled(true);
    // Occupy the head so everything else queues.
    speakConfirmation('Head confirmation.');
    expect(shim.speak).toHaveBeenCalledTimes(1);

    speakConfirmationModeStatus('Voice read-backs off.');
    // Fill the queue to MAX_QUEUE_DEPTH (6) with ordinary confirmations —
    // depth = head(1) + queued items.
    speakConfirmation('Confirmation A.');
    speakConfirmation('Confirmation B.');
    speakConfirmation('Confirmation C.');
    speakConfirmation('Confirmation D.');
    // This 6th enqueue (depth would be 7) triggers overflow — the mode-
    // status cue must NOT be the one dropped.
    speakConfirmation('Confirmation E.');

    // Drain everything and collect what actually got spoken.
    const spokenTexts: string[] = [];
    for (let i = 0; i < 10; i++) {
      const before = shim.spoken.length;
      shim.completeLast();
      if (shim.spoken.length === before) break;
    }
    for (const u of shim.spoken) spokenTexts.push(u.text);
    expect(spokenTexts).toContain('Voice read-backs off.');
  });
});

// Codex diff-review r3 BLOCKER — re-parking unconditionally on EVERY
// discard (including a genuine terminal playback failure — native AND
// ElevenLabs both fail before any audio plays) retries forever against a
// persistently broken synth backend. Only a queue-lifecycle discard
// (preempt/overflow/purge/reset) is safe to retry; `playback_error` must
// retire instead.
describe('speakConfirmationModeStatus — retires (never retries) on a genuine playback failure', () => {
  it('a native synth error before onstart retires the cue instead of re-parking it forever', () => {
    setConfirmationModeEnabled(true);
    speakConfirmationModeStatus('Voice read-backs off.');
    expect(shim.speak).toHaveBeenCalledTimes(1);

    // Native synth fails before any audio plays — onerror, never onstart.
    shim.spoken[0].onerror?.();

    // Retired, not re-parked: nothing further gets auto-dispatched for it.
    expect(shim.speak).toHaveBeenCalledTimes(1);

    // A fresh cue/confirmation afterwards is unaffected — no stale tracking
    // blocks it, and the failed cue is not silently resurrected alongside it.
    speakConfirmation('Circuit 2 is now Hallway Lighting.');
    expect(shim.spoken[shim.spoken.length - 1].text).toBe('Circuit 2 is now Hallway Lighting.');
    expect(shim.spoken.filter((u) => u.text === 'Voice read-backs off.').length).toBe(1);
  });
});
