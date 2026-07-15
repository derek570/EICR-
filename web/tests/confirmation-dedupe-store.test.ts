/**
 * §A1(b) field-feedback-2026-07-14 — confirmation-dedupe store twin tests.
 *
 * iOS canon: DeepgramRecordingViewModel `isConfirmationKeyLive` /
 * `reserveConfirmationKey` / `confirmationKeyPlaybackDidStart` /
 * `forgetConfirmationKey` / `resetConfirmationDedupeStores` (commit
 * 856ac1a). Field session 6B6FE011 F7/F10: two identical field-nil
 * apologies 11+ minutes apart — the second was swallowed by the
 * session-lifetime dedupe set (beep-then-silence). Derek-decided fix:
 * 30 s TTL for field-nil confirmations, from audible playback START,
 * with AGELESS reservations while queued (reservation ≠ TTL entry —
 * an apology deferred past 30 s in the queue must not expire unheard
 * and duplicate).
 *
 * The second describe block drives the REAL tts-queue so the
 * store↔queue wiring contract (reserve → onPlaybackStarted convert /
 * onDiscarded forget) is pinned end-to-end, not just store-unit.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ConfirmationDedupeStore,
  FIELD_NIL_CONFIRMATION_TTL_MS,
} from '@/lib/recording/confirmation-dedupe-store';
import {
  enqueueConfirmation,
  setOnDiscarded,
  setOnPlaybackStarted,
  setShouldDeferPlayback,
  resumeIfDeferred,
  preemptFlush,
  reset as resetQueue,
  __resetForTests,
  type QueuePlayControls,
  type PreparedAudio,
} from '@/lib/recording/tts-queue';

describe('ConfirmationDedupeStore — three-store semantics (iOS A1(b) canon)', () => {
  let now: number;
  let store: ConfirmationDedupeStore;

  beforeEach(() => {
    now = 1_000_000;
    store = new ConfirmationDedupeStore(() => now);
  });

  it('field read-back keys keep session-permanent Set semantics', () => {
    store.reserve('measured_zs_ohm_3', false);
    expect(store.isLive('measured_zs_ohm_3', false)).toBe(true);
    store.markPlaybackStarted('measured_zs_ohm_3');
    now += FIELD_NIL_CONFIRMATION_TTL_MS * 10;
    expect(store.isLive('measured_zs_ohm_3', false)).toBe(true); // never expires
  });

  it('field-nil apology: suppressed within 30 s of being HEARD, speaks again after', () => {
    const key = 'unknown_6825101542993742196'; // the real F7/F10 colliding key shape
    store.reserve(key, true);
    store.markPlaybackStarted(key); // heard now
    now += FIELD_NIL_CONFIRMATION_TTL_MS - 1;
    expect(store.isLive(key, true)).toBe(true); // 29.999s — still suppressed
    now += 2;
    expect(store.isLive(key, true)).toBe(false); // 30s+ — re-speaks (F7/F10 fix)
  });

  it('field-nil TTL starts at playback START, not at reserve (reservation ≠ TTL entry)', () => {
    const key = 'unknown_apology';
    store.reserve(key, true);
    // Deferred in the queue well past the TTL — the AGELESS reservation
    // keeps it live so a re-emit can't enqueue a duplicate while the
    // first copy is still waiting to play.
    now += FIELD_NIL_CONFIRMATION_TTL_MS * 3;
    expect(store.isLive(key, true)).toBe(true);
    store.markPlaybackStarted(key);
    now += FIELD_NIL_CONFIRMATION_TTL_MS - 1;
    expect(store.isLive(key, true)).toBe(true); // TTL measured from START
    now += 2;
    expect(store.isLive(key, true)).toBe(false);
  });

  it('forget() clears ALL stores — a discarded field-nil confirmation is immediately speakable again', () => {
    store.reserve('unknown_apology', true);
    store.forget('unknown_apology');
    expect(store.isLive('unknown_apology', true)).toBe(false);
    // Also un-records a HEARD stamp and a permanent field key.
    store.reserve('unknown_apology', true);
    store.markPlaybackStarted('unknown_apology');
    store.forget('unknown_apology');
    expect(store.isLive('unknown_apology', true)).toBe(false);
    store.reserve('measured_zs_ohm_1', false);
    store.forget('measured_zs_ohm_1');
    expect(store.isLive('measured_zs_ohm_1', false)).toBe(false);
  });

  it('reset() clears permanent + TTL + reservations together (new session speaks its first apology)', () => {
    store.reserve('measured_zs_ohm_1', false);
    store.reserve('unknown_apology', true);
    store.markPlaybackStarted('unknown_apology');
    store.reserve('unknown_queued', true);
    store.reset();
    expect(store.isLive('measured_zs_ohm_1', false)).toBe(false);
    expect(store.isLive('unknown_apology', true)).toBe(false);
    expect(store.isLive('unknown_queued', true)).toBe(false);
  });

  it('expired TTL stamps are dropped on read (map stays bounded)', () => {
    store.reserve('unknown_apology', true);
    store.markPlaybackStarted('unknown_apology');
    now += FIELD_NIL_CONFIRMATION_TTL_MS + 1;
    expect(store.isLive('unknown_apology', true)).toBe(false);
    // Second read still false (stamp was deleted, not re-evaluated).
    expect(store.isLive('unknown_apology', true)).toBe(false);
  });
});

describe('store ↔ tts-queue wiring (reserve → playback-start convert / discard forget)', () => {
  let now: number;
  let store: ConfirmationDedupeStore;
  /** Instant player mirroring FakeTtsPlayers: prepared/ready contract so
   *  the real last-mile defer gate runs. */
  const instantPlay = (text: string, controls: QueuePlayControls): void => {
    const prepared: PreparedAudio = {
      play: () => {
        controls.onStart();
        controls.onEnd();
      },
      discard: () => {},
    };
    controls.ready(prepared);
  };

  beforeEach(() => {
    now = 5_000_000;
    store = new ConfirmationDedupeStore(() => now);
    __resetForTests();
    setOnDiscarded((key) => store.forget(key));
    setOnPlaybackStarted((key) => store.markPlaybackStarted(key));
  });

  afterEach(() => {
    resetQueue();
    __resetForTests();
    vi.restoreAllMocks();
  });

  /** The recording-context enqueue recipe: dedupe-check → reserve → enqueue. */
  function speakOnce(key: string, fieldIsNil: boolean, text: string): boolean {
    if (store.isLive(key, fieldIsNil)) return false;
    store.reserve(key, fieldIsNil);
    enqueueConfirmation({ text, dedupeKey: key, play: instantPlay });
    return true;
  }

  it('played field-nil apology → suppressed within 30 s, speaks again after (end-to-end)', () => {
    expect(speakOnce('unknown_apology', true, 'Sorry, I missed that.')).toBe(true); // plays
    expect(speakOnce('unknown_apology', true, 'Sorry, I missed that.')).toBe(false); // <30s → deduped
    now += FIELD_NIL_CONFIRMATION_TTL_MS + 1;
    expect(speakOnce('unknown_apology', true, 'Sorry, I missed that.')).toBe(true); // >30s → re-speaks
  });

  it('preempt-flushed (never-played) field-nil apology is immediately speakable again', () => {
    // Defer the head so it never reaches playback.
    setShouldDeferPlayback(() => true);
    expect(speakOnce('unknown_apology', true, 'Sorry, I missed that.')).toBe(true);
    // While queued: the ageless reservation blocks a duplicate even past the TTL.
    now += FIELD_NIL_CONFIRMATION_TTL_MS * 2;
    expect(speakOnce('unknown_apology', true, 'Sorry, I missed that.')).toBe(false);
    // Direct speak() preempts the FIFO — head discarded before playback.
    preemptFlush();
    expect(store.isLive('unknown_apology', true)).toBe(false);
    // Immediately re-speakable (never a permanent zero read-back).
    setShouldDeferPlayback(() => false);
    expect(speakOnce('unknown_apology', true, 'Sorry, I missed that.')).toBe(true);
  });

  it('deferred-then-resumed head converts at REAL playback start (TTL from resume, not enqueue)', () => {
    let deferring = true;
    setShouldDeferPlayback(() => deferring);
    speakOnce('unknown_apology', true, 'Sorry, I missed that.');
    now += FIELD_NIL_CONFIRMATION_TTL_MS * 2; // long inspector monologue
    deferring = false;
    resumeIfDeferred(); // plays now → TTL stamp = now
    now += FIELD_NIL_CONFIRMATION_TTL_MS - 1;
    expect(store.isLive('unknown_apology', true)).toBe(true); // still inside TTL from START
    now += 2;
    expect(store.isLive('unknown_apology', true)).toBe(false);
  });

  it('field read-back keys stay permanently deduped after playback (unchanged D6 semantics)', () => {
    expect(speakOnce('measured_zs_ohm_3', false, 'Circuit 3, Zs 0.44 ohms')).toBe(true);
    now += FIELD_NIL_CONFIRMATION_TTL_MS * 10;
    expect(speakOnce('measured_zs_ohm_3', false, 'Circuit 3, Zs 0.44 ohms')).toBe(false);
  });
});
