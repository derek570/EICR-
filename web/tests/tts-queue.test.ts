/**
 * Confirmation-TTS FIFO queue unit tests (iOS AlertManager Phase 7.1 port).
 *
 * Drives the queue with an INJECTED play stub (a fake player) + an injected
 * `onDiscarded` spy — no ElevenLabs/DOM. Each enqueued item's `play` captures
 * its `QueuePlayControls` so the test drives the fetch/start/end/error/defer
 * lifecycle deterministically (the jsdom shim can't). Covers the Symptom-1
 * serial-play fix, the last-mile deferral gate, drop-oldest overflow, and every
 * teardown path's `onDiscarded` / `startedPlayback` contract (the Codex round-1
 * + round-2 BLOCKERs).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetForTests,
  __hasDeferredHeadForTests,
  enqueueConfirmation,
  preemptFlush,
  purge,
  reset,
  resumeIfDeferred,
  setOnDiscarded,
  setShouldDeferPlayback,
  type ConfirmationPlayFn,
  type QueuePlayControls,
} from '@/lib/recording/tts-queue';

/** One captured play() invocation — the test drives its lifecycle. */
interface Rec {
  text: string;
  dedupeKey?: string;
  controls: QueuePlayControls;
  playCount: number; // times the queue invoked prepared.play() (re-fetch check)
  discardCount: number;
  cancelled: boolean;
  started: boolean;
  ended: boolean;
}

let recs: Rec[] = [];

/** Injected player: records controls, registers a canceller, and exposes
 *  helpers to drive fetch-complete / start / end / error. */
const play: ConfirmationPlayFn = (text, controls) => {
  const rec: Rec = {
    text,
    controls,
    playCount: 0,
    discardCount: 0,
    cancelled: false,
    started: false,
    ended: false,
  };
  controls.registerCanceller(() => {
    rec.cancelled = true;
  });
  recs.push(rec);
};

/** Simulate fetch/decode completing. The queue then applies the last-mile gate
 *  (play now vs park). `prepared.play` fires `onStart`; `prepared.discard`
 *  counts a discard. */
function fetchDone(rec: Rec): void {
  rec.controls.ready({
    play: () => {
      rec.playCount += 1;
      rec.started = true;
      rec.controls.onStart();
    },
    discard: () => {
      rec.discardCount += 1;
    },
  });
}

function endHead(rec: Rec): void {
  rec.ended = true;
  rec.controls.onEnd();
}

function enq(text: string, opts?: { dedupeKey?: string; cancelKey?: string }) {
  return enqueueConfirmation({
    text,
    dedupeKey: opts?.dedupeKey,
    cancelKey: opts?.cancelKey,
    play,
  });
}

beforeEach(() => {
  recs = [];
  __resetForTests();
});
afterEach(() => {
  __resetForTests();
});

describe('serial play (Symptom 1 — the field bug)', () => {
  it('plays A, B, C in order with zero aborts', () => {
    enq('A');
    enq('B');
    enq('C');
    // Only A is pumped; B, C wait behind it.
    expect(recs.map((r) => r.text)).toEqual(['A']);
    fetchDone(recs[0]);
    expect(recs[0].started).toBe(true);
    endHead(recs[0]);
    // Now B pumps.
    expect(recs.map((r) => r.text)).toEqual(['A', 'B']);
    fetchDone(recs[1]);
    endHead(recs[1]);
    expect(recs.map((r) => r.text)).toEqual(['A', 'B', 'C']);
    fetchDone(recs[2]);
    endHead(recs[2]);
    expect(recs.every((r) => r.discardCount === 0 && !r.cancelled)).toBe(true);
    expect(recs.every((r) => r.started && r.ended)).toBe(true);
  });

  it('a second head does NOT start until the first ends (not concurrent)', () => {
    enq('A');
    enq('B');
    fetchDone(recs[0]);
    // B still not pumped — A is busy.
    expect(recs.map((r) => r.text)).toEqual(['A']);
    endHead(recs[0]);
    expect(recs.map((r) => r.text)).toEqual(['A', 'B']);
  });
});

describe('last-mile deferral gate (iOS playOrDeferQueueHead)', () => {
  it('parks a head when the gate is true at head-start; resume plays it', () => {
    let deferring = true;
    setShouldDeferPlayback(() => deferring);
    enq('A');
    fetchDone(recs[0]);
    // Gate true → parked, NOT played.
    expect(recs[0].started).toBe(false);
    expect(__hasDeferredHeadForTests()).toBe(true);
    deferring = false;
    resumeIfDeferred();
    expect(recs[0].started).toBe(true);
    expect(recs[0].playCount).toBe(1);
  });

  it('defers at the LAST mile when the gate flips DURING the fetch (no re-fetch on resume)', () => {
    let deferring = false;
    setShouldDeferPlayback(() => deferring);
    enq('A');
    // Pump picked the head; fetch is "in flight". Inspector starts speaking.
    deferring = true;
    fetchDone(recs[0]);
    // Post-fetch gate is now true → parked with prepared audio held.
    expect(recs[0].started).toBe(false);
    expect(recs[0].playCount).toBe(0);
    expect(__hasDeferredHeadForTests()).toBe(true);
    // Inspector stops → resume plays the ALREADY-PREPARED audio (playCount 1,
    // no second fetchDone needed).
    deferring = false;
    resumeIfDeferred();
    expect(recs[0].playCount).toBe(1);
    expect(recs[0].started).toBe(true);
  });

  it('default gate (no registration) plays immediately, never defers', () => {
    // __resetForTests already restored the () => false default.
    enq('A');
    fetchDone(recs[0]);
    expect(recs[0].started).toBe(true);
    expect(__hasDeferredHeadForTests()).toBe(false);
  });
});

describe('drop-oldest overflow (iOS AlertManager.swift:352-354)', () => {
  it('enqueue 7 drops the OLDEST queued item, keeps the 7th, un-records its key', () => {
    const onDiscarded = vi.fn();
    setOnDiscarded(onDiscarded);
    // Item 1 becomes the (never-completed) head; 2..7 queue behind it.
    for (let i = 1; i <= 6; i++) enq(`c${i}`, { dedupeKey: `k${i}` });
    fetchDone(recs[0]); // head starts so it isn't the dropped one
    const seventh = enq('c7', { dedupeKey: 'k7' });
    // The 7th enqueue drops the OLDEST QUEUED item (c2 → k2), NOT the newest.
    expect(seventh).toEqual({ enqueued: true, discardedCount: 1 });
    expect(onDiscarded).toHaveBeenCalledTimes(1);
    expect(onDiscarded).toHaveBeenCalledWith('k2');
  });
});

describe('teardown fires onDiscarded only for never-played items', () => {
  it('current head torn down MID-FETCH (startedPlayback false) fires onDiscarded (Codex R1 BLOCKER)', () => {
    const onDiscarded = vi.fn();
    setOnDiscarded(onDiscarded);
    enq('A', { dedupeKey: 'kA' });
    // No fetchDone → still fetching, never heard.
    preemptFlush();
    expect(onDiscarded).toHaveBeenCalledWith('kA');
    expect(recs[0].cancelled).toBe(true); // hard-abort the fetch
  });

  it('current head torn down AFTER onStart (startedPlayback true) does NOT fire onDiscarded (heard)', () => {
    const onDiscarded = vi.fn();
    setOnDiscarded(onDiscarded);
    enq('A', { dedupeKey: 'kA' });
    fetchDone(recs[0]); // onStart fired → heard
    preemptFlush();
    expect(onDiscarded).not.toHaveBeenCalled();
    expect(recs[0].cancelled).toBe(true); // still hard-stopped
  });

  it('native-branch startedPlayback (round-2 BLOCKER): onStart-then-teardown keeps the key', () => {
    // Mirrors the iPhone/iPad-Safari native default: onStart fires from
    // utterance.onstart, so a torn-down-after-onStart head is NOT re-recorded.
    const onDiscarded = vi.fn();
    setOnDiscarded(onDiscarded);
    enq('A', { dedupeKey: 'kA' });
    fetchDone(recs[0]);
    expect(recs[0].started).toBe(true);
    reset();
    expect(onDiscarded).not.toHaveBeenCalled();
  });

  it('a deferred head torn down fires onDiscarded ONCE and discards (not hard-cancel)', () => {
    const onDiscarded = vi.fn();
    setOnDiscarded(onDiscarded);
    setShouldDeferPlayback(() => true);
    enq('A', { dedupeKey: 'kA' });
    fetchDone(recs[0]); // parked (never played)
    expect(__hasDeferredHeadForTests()).toBe(true);
    preemptFlush();
    expect(onDiscarded).toHaveBeenCalledTimes(1);
    expect(onDiscarded).toHaveBeenCalledWith('kA');
    expect(recs[0].discardCount).toBe(1); // prepared.discard(), NOT a hard audio cancel
  });
});

describe('purge(prefix)', () => {
  it('removes matching queued items + a matching head; fires onDiscarded for never-played', () => {
    const onDiscarded = vi.fn();
    setOnDiscarded(onDiscarded);
    enq('A', { dedupeKey: 'kA', cancelKey: 'srv-x-1' }); // head (mid-fetch)
    enq('B', { dedupeKey: 'kB', cancelKey: 'srv-x-2' }); // queued, matches
    enq('C', { dedupeKey: 'kC', cancelKey: 'srv-y-1' }); // queued, does NOT match
    purge('srv-x-');
    // A (head, mid-fetch) + B (queued) discarded; C survives.
    expect(onDiscarded).toHaveBeenCalledWith('kA');
    expect(onDiscarded).toHaveBeenCalledWith('kB');
    expect(onDiscarded).not.toHaveBeenCalledWith('kC');
    // C now pumps (non-matching item remained).
    expect(recs.some((r) => r.text === 'C')).toBe(true);
  });
});

describe('reset()', () => {
  it('flushes queued + mid-fetch head via onDiscarded, then restores gate default + clears onDiscarded', () => {
    const onDiscarded = vi.fn();
    setOnDiscarded(onDiscarded);
    setShouldDeferPlayback(() => true);
    enq('A', { dedupeKey: 'kA' });
    enq('B', { dedupeKey: 'kB' });
    reset();
    expect(onDiscarded).toHaveBeenCalledWith('kA');
    expect(onDiscarded).toHaveBeenCalledWith('kB');
    // Gate restored to default: a fresh enqueue plays immediately (never defers)
    // AND onDiscarded is cleared (no more callbacks).
    onDiscarded.mockClear();
    enq('C', { dedupeKey: 'kC' });
    fetchDone(recs[recs.length - 1]);
    expect(recs[recs.length - 1].started).toBe(true);
    preemptFlush(); // would fire onDiscarded if still registered — but it's cleared
    expect(onDiscarded).not.toHaveBeenCalled();
  });
});

describe('pump advances on terminal onEnd OR onError', () => {
  it('an aborted head (onError, never onEnd) still advances the pump', () => {
    enq('A');
    enq('B');
    fetchDone(recs[0]);
    // Simulate an abort: the player fires onError (NOT onEnd).
    recs[0].controls.onError('aborted');
    // B must still pump.
    expect(recs.map((r) => r.text)).toEqual(['A', 'B']);
  });
});

describe('preemptFlush returns the never-played discarded count', () => {
  it('counts queued + a mid-fetch head', () => {
    enq('A', { dedupeKey: 'kA' }); // head, mid-fetch (never played)
    enq('B', { dedupeKey: 'kB' }); // queued
    enq('C', { dedupeKey: 'kC' }); // queued
    const n = preemptFlush();
    expect(n).toBe(3);
  });

  it('does NOT count a head that already started playing', () => {
    enq('A', { dedupeKey: 'kA' });
    enq('B', { dedupeKey: 'kB' });
    fetchDone(recs[0]); // A started
    const n = preemptFlush();
    // B (queued, never played) counts; A (heard) does not.
    expect(n).toBe(1);
  });
});

describe('discard-then-re-enqueue keeps a re-played key (no double read-back)', () => {
  it('a dropped item fires onDiscarded once; a later same-key item that plays does not', () => {
    const onDiscarded = vi.fn();
    setOnDiscarded(onDiscarded);
    // Fill so a 7th enqueue drops the oldest queued (k2).
    for (let i = 1; i <= 6; i++) enq(`c${i}`, { dedupeKey: `k${i}` });
    fetchDone(recs[0]);
    enq('c7', { dedupeKey: 'k7' }); // drops k2
    expect(onDiscarded).toHaveBeenCalledTimes(1);
    expect(onDiscarded).toHaveBeenCalledWith('k2');
    // Re-enqueue a same-key item and let it play to natural end — no further
    // onDiscarded (its key stays recorded → not re-spoken again).
    onDiscarded.mockClear();
    // drain the current head so the re-enqueue can eventually play
    endHead(recs[0]);
    // pump the remaining queue to empty quickly
    while (recs.some((r) => !r.ended)) {
      const pending = recs.find((r) => !r.ended && !r.started);
      if (!pending) break;
      fetchDone(pending);
      endHead(pending);
    }
    const before = recs.length;
    enq('c2-again', { dedupeKey: 'k2' });
    fetchDone(recs[before]);
    endHead(recs[before]);
    expect(onDiscarded).not.toHaveBeenCalled();
  });
});
