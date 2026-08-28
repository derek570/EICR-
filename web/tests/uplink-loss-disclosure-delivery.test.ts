/**
 * PLAN-E2 — disclosure DELIVERY through the real TTS layer (`tts.ts` +
 * `tts-queue.ts`): the canonical line byte-for-byte, forced past the
 * confirmations toggle, token-keyed (immune to the 30s text dedupe),
 * protected from overflow, re-parked on pre-start discard / preemption /
 * post-start failure, parked behind local speech, deferring direct prompts
 * while PLAYING, and ABANDONED by session teardown.
 *
 * Drives the REAL queue + tts wiring through the B1 harness seams
 * (`ttsConfirmationPlayer` / `ttsDirectSpeak`) so no synth backend is
 * involved: with a TTS session id set, jsdom reports ElevenLabs available
 * and the FIFO's ElevenLabs branch would otherwise be exercised.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetModeStatusCuesForTests,
  __resetTtsWindowForTests,
  __resetUplinkLossDisclosureForTests,
  __uplinkLossDisclosureStateForTests,
  cancelSpeech,
  handleUplinkLossDisclosureDiscard,
  handleUplinkLossDisclosurePlaybackStarted,
  handleUplinkLossDisclosureTornDown,
  isDirectAudioActive,
  notifyUplinkLossLocalSilence,
  requestUplinkLossDisclosure,
  setConfirmationModeEnabled,
  setUplinkLossDisclosureLocalSpeakingGate,
  speak,
  speakConfirmation,
  UPLINK_LOSS_DISCLOSURE_TEXT,
} from '@/lib/recording/tts';
import { setActiveSessionId as setTtsSessionId } from '@/lib/recording/elevenlabs-tts';
import { __setRecordingTestServices } from '@/lib/recording/test-services';
import {
  __resetForTests as __resetTtsQueueForTests,
  __queueDepthForTests,
  MAX_QUEUE_DEPTH,
  resumeIfDeferred,
  setOnDiscarded,
  setOnPlaybackStarted,
  setOnStartedHeadTornDown,
  setShouldDeferPlayback,
  type QueuePlayControls,
} from '@/lib/recording/tts-queue';
import type { SpeakOptions } from '@/lib/recording/tts';
import type { LossSourceId } from '@/lib/recording/uplink-loss-ledger';

const episode = (id: number): LossSourceId => ({ kind: 'episode', id });

/** Fake FIFO player: hands the queue a prepared handle immediately, then
 *  lets the test drive start / natural end / failure per played item. */
class FakeFifoPlayer {
  played: Array<{ text: string; controls: QueuePlayControls; playRequested: boolean }> = [];
  play = (text: string, controls: QueuePlayControls) => {
    const entry = { text, controls, playRequested: false };
    this.played.push(entry);
    controls.registerCanceller(() => {});
    controls.ready({
      play: () => {
        entry.playRequested = true;
      },
      discard: () => {},
    });
  };
  disclosures() {
    return this.played.filter((p) => p.text === UPLINK_LOSS_DISCLOSURE_TEXT);
  }
  last() {
    return this.played[this.played.length - 1];
  }
  start(entry = this.last()) {
    entry.controls.onStart();
  }
  end(entry = this.last()) {
    entry.controls.onEnd();
  }
  fail(entry = this.last()) {
    entry.controls.onError('synthesis-failed');
  }
  complete(entry = this.last()) {
    this.start(entry);
    this.end(entry);
  }
}

/** Fake direct speaker: records prompts; the test ends them explicitly. */
class FakeDirectSpeaker {
  prompts: Array<{ text: string; options?: SpeakOptions }> = [];
  speak = (text: string, options?: SpeakOptions) => {
    this.prompts.push({ text, options });
    options?.onStart?.();
  };
  endLast() {
    this.prompts[this.prompts.length - 1]?.options?.onEnd?.();
  }
  texts() {
    return this.prompts.map((p) => p.text);
  }
}

let fifo: FakeFifoPlayer;
let direct: FakeDirectSpeaker;
let localSpeaking = false;

beforeEach(() => {
  fifo = new FakeFifoPlayer();
  direct = new FakeDirectSpeaker();
  __setRecordingTestServices({ ttsConfirmationPlayer: fifo.play, ttsDirectSpeak: direct.speak });
  // The toggle flip enqueues a PLAN-D mode-status cue; set it FIRST and then
  // wipe the queue + cue tracking so no cue occupies the FIFO head.
  setConfirmationModeEnabled(true);
  __resetTtsWindowForTests();
  __resetTtsQueueForTests();
  __resetModeStatusCuesForTests();
  __resetUplinkLossDisclosureForTests();
  setTtsSessionId('sess-A');
  localSpeaking = false;
  setUplinkLossDisclosureLocalSpeakingGate(() => localSpeaking);
  // Mirror recording-context.tsx's production wiring (the defer gate is
  // load-bearing: a queued head must park while a direct prompt owns audio).
  setShouldDeferPlayback(() => isDirectAudioActive());
  setOnDiscarded((key, reason) => {
    handleUplinkLossDisclosureDiscard(key, reason);
  });
  setOnStartedHeadTornDown((key, reason) => {
    handleUplinkLossDisclosureTornDown(key, reason);
  });
  setOnPlaybackStarted((key) => {
    handleUplinkLossDisclosurePlaybackStarted(key);
  });
});

afterEach(() => {
  __resetTtsWindowForTests();
  __resetTtsQueueForTests();
  __resetModeStatusCuesForTests();
  __resetUplinkLossDisclosureForTests();
  __setRecordingTestServices(null);
  setTtsSessionId(null);
  vi.useRealTimers();
});

const flushMicrotasks = () => new Promise<void>((r) => queueMicrotask(r));

describe('speakUplinkLossDisclosure — canonical line, forced, tokened', () => {
  it('speaks the ONE canonical cause-agnostic line byte-for-byte', () => {
    requestUplinkLossDisclosure([episode(1)]);
    expect(fifo.disclosures()).toHaveLength(1);
    expect(fifo.last().text).toBe(
      "Some recent audio may not have been transcribed. Check your recent readings and repeat only anything that's missing."
    );
    expect(fifo.last().playRequested).toBe(true);
  });

  it('is FORCED — delivered with confirmations OFF (the documented exception)', () => {
    setConfirmationModeEnabled(false);
    __resetTtsQueueForTests();
    __resetModeStatusCuesForTests();
    requestUplinkLossDisclosure([episode(1)]);
    expect(fifo.disclosures()).toHaveLength(1);
    // Contrast: an ordinary confirmation is muted.
    expect(speakConfirmation('Zs point five').enqueued).toBe(false);
  });

  it('two successive outages after natural completion → the identical string spoken TWICE (immune to the 30s text dedupe)', () => {
    requestUplinkLossDisclosure([episode(1)]);
    fifo.complete();
    requestUplinkLossDisclosure([episode(2)]);
    expect(fifo.disclosures()).toHaveLength(2);
    expect(__uplinkLossDisclosureStateForTests().completed).toBe(1);
  });

  it('a single disclosure moment never emits two clips (window + episode coalesced)', () => {
    requestUplinkLossDisclosure([{ kind: 'preOpenWindow', id: 1 }, episode(1)]);
    expect(fifo.disclosures()).toHaveLength(1);
  });

  it('a token from an earlier session never occupies the slot: session B mints its OWN token (queued behind whatever is still playing)', () => {
    requestUplinkLossDisclosure([episode(1)]);
    fifo.start(); // still playing when the session id rotates
    setTtsSessionId('sess-B');
    requestUplinkLossDisclosure([episode(2)]);
    const s = __uplinkLossDisclosureStateForTests();
    expect(s.outstanding?.id).toBe(2);
    expect(s.outstanding?.sessionId).toBe('sess-B');
    expect(s.outstanding?.coveredLossSourceIds).toEqual([episode(2)]);
    expect(__queueDepthForTests()).toBe(1); // B's clip is enqueued, not suppressed
  });
});

describe('speakUplinkLossDisclosure — protection + re-park lifecycle', () => {
  it('is never evicted by overflow: MAX_QUEUE_DEPTH confirmations behind a busy head cannot drop it', () => {
    speakConfirmation('head'); // busy head
    requestUplinkLossDisclosure([episode(1)]);
    for (let i = 0; i < MAX_QUEUE_DEPTH + 2; i++) speakConfirmation(`c${i}`);
    expect(__uplinkLossDisclosureStateForTests().outstanding?.state).toBe('pending');
    // Drain heads until the disclosure plays.
    for (let guard = 0; guard < 20 && fifo.disclosures().length === 0; guard++) fifo.complete();
    expect(fifo.disclosures()).toHaveLength(1);
  });

  it('a direct prompt BEFORE playback start preempts the queued item → the SAME token re-parks and replays', async () => {
    speakConfirmation('head');
    requestUplinkLossDisclosure([episode(1)]);
    expect(__queueDepthForTests()).toBe(1);
    speak('Which circuit?'); // preemptFlush → onDiscarded('preempt') for the queued token
    await flushMicrotasks();
    const state = __uplinkLossDisclosureStateForTests();
    expect(state.outstanding?.id).toBe(1);
    expect(state.outstanding?.state).toBe('pending');
    // Re-enqueued behind the question: it sits deferred while the direct
    // prompt owns audio; the prompt ends → the deferred head is released.
    direct.endLast();
    resumeIfDeferred();
    expect(fifo.disclosures()).toHaveLength(1);
  });

  it('a started head torn down by preemption → atomically playing → pending, deferred prompts released BEFORE the replay', async () => {
    requestUplinkLossDisclosure([episode(1)]);
    fifo.start(); // playing
    expect(__uplinkLossDisclosureStateForTests().outstanding?.state).toBe('playing');
    speak('Deferred question'); // deferred while playing
    expect(__uplinkLossDisclosureStateForTests().deferredPrompts).toBe(1);
    expect(direct.texts()).toEqual([]);
    // A purge/preempt tears the started head down mid-clip.
    handleUplinkLossDisclosureTornDown('uplink-loss:1', 'preempt');
    // Deferred prompt released synchronously at the transition…
    expect(direct.texts()).toEqual(['Deferred question']);
    expect(__uplinkLossDisclosureStateForTests().outstanding?.state).toBe('pending');
    await flushMicrotasks();
    // …and the disclosure replays once the prompt ends.
    direct.endLast();
    resumeIfDeferred();
    expect(fifo.disclosures().length).toBeGreaterThanOrEqual(2);
  });

  it('post-start playback failure → token re-parks (NOT retired), completion counter NOT incremented, replays later', () => {
    vi.useFakeTimers();
    requestUplinkLossDisclosure([episode(1)]);
    fifo.start();
    fifo.fail(); // onError after onStart → onPlaybackFailed, never onEnd
    const s = __uplinkLossDisclosureStateForTests();
    expect(s.completed).toBe(0);
    expect(s.outstanding?.state).toBe('pending');
    vi.advanceTimersByTime(2000);
    expect(fifo.disclosures()).toHaveLength(2);
  });

  it('a pre-start playback error re-parks with a backoff instead of retiring', () => {
    vi.useFakeTimers();
    requestUplinkLossDisclosure([episode(1)]);
    fifo.fail(); // never started → onDiscarded('playback_error')
    expect(__uplinkLossDisclosureStateForTests().outstanding?.state).toBe('pending');
    vi.advanceTimersByTime(2000);
    expect(fifo.disclosures()).toHaveLength(2);
  });

  it('a direct prompt arriving AFTER playback start DEFERS until natural completion', () => {
    requestUplinkLossDisclosure([episode(1)]);
    fifo.start();
    speak('Which circuit?');
    expect(direct.texts()).toEqual([]);
    fifo.end(); // natural completion
    expect(direct.texts()).toEqual(['Which circuit?']);
    expect(__uplinkLossDisclosureStateForTests().outstanding).toBeNull();
  });

  it('a source arriving mid-playback is disclosed by a SUCCESSOR clip after completion', () => {
    requestUplinkLossDisclosure([episode(1)]);
    fifo.start();
    requestUplinkLossDisclosure([episode(2)]);
    expect(fifo.disclosures()).toHaveLength(1);
    fifo.end();
    expect(fifo.disclosures()).toHaveLength(2);
    expect(__uplinkLossDisclosureStateForTests().outstanding?.coveredLossSourceIds).toEqual([
      episode(2),
    ]);
  });
});

describe('speakUplinkLossDisclosure — local-speech parking', () => {
  it('stays PARKED while the inspector is locally speaking; plays exactly once after debounced silence', () => {
    localSpeaking = true;
    requestUplinkLossDisclosure([episode(1)]);
    expect(fifo.disclosures()).toHaveLength(0);
    expect(__uplinkLossDisclosureStateForTests().parked?.id).toBe(1);
    localSpeaking = false;
    notifyUplinkLossLocalSilence();
    notifyUplinkLossLocalSilence(); // idempotent
    expect(fifo.disclosures()).toHaveLength(1);
  });
});

describe('speakUplinkLossDisclosure — session teardown', () => {
  it('Stop mid-playback → zero post-Stop speech, no stale queued item, slot usable in the next session', () => {
    requestUplinkLossDisclosure([episode(1)]);
    fifo.start();
    cancelSpeech(); // resetQueue:true → reset() → onStartedHeadTornDown(key, 'reset')
    expect(__uplinkLossDisclosureStateForTests().outstanding).toBeNull();
    expect(__queueDepthForTests()).toBe(0);
    // The queue reset also clears the harness's registered hooks — re-wire
    // exactly as a new session's start() would.
    setShouldDeferPlayback(() => isDirectAudioActive());
    setOnDiscarded((key, reason) => {
      handleUplinkLossDisclosureDiscard(key, reason);
    });
    setOnStartedHeadTornDown((key, reason) => {
      handleUplinkLossDisclosureTornDown(key, reason);
    });
    setOnPlaybackStarted((key) => {
      handleUplinkLossDisclosurePlaybackStarted(key);
    });
    setTtsSessionId('sess-B');
    requestUplinkLossDisclosure([episode(7)]);
    expect(fifo.disclosures()).toHaveLength(2);
    expect(__uplinkLossDisclosureStateForTests().outstanding?.sessionId).toBe('sess-B');
  });

  it('a QUEUED (never-started) disclosure at Stop is abandoned, not re-parked into the next session', async () => {
    speakConfirmation('head');
    requestUplinkLossDisclosure([episode(1)]);
    cancelSpeech();
    await flushMicrotasks();
    expect(__uplinkLossDisclosureStateForTests().outstanding).toBeNull();
    expect(fifo.disclosures()).toHaveLength(0);
  });

  it('a PARKED (not yet enqueued) token from session A never speaks into session B', () => {
    localSpeaking = true;
    requestUplinkLossDisclosure([episode(1)]);
    setTtsSessionId('sess-B');
    localSpeaking = false;
    notifyUplinkLossLocalSilence();
    expect(fifo.disclosures()).toHaveLength(0);
  });
});

describe('uplink-loss disclosure delivery — Codex cycle-1 regressions', () => {
  it('a release stamped with a session that is no longer active is rejected, never adopted by the current one', () => {
    setTtsSessionId('sess-B');
    requestUplinkLossDisclosure([episode(1)], 'sess-A');
    expect(__uplinkLossDisclosureStateForTests().outstanding).toBeNull();
    requestUplinkLossDisclosure([episode(1)], 'sess-B');
    expect(__uplinkLossDisclosureStateForTests().outstanding?.sessionId).toBe('sess-B');
  });
});
