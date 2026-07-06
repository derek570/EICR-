/**
 * Unit tests for the in-flight TTS question tracker.
 *
 * The tracker is pure (`now` injectable, no DOM, no React). These tests
 * pin the iOS-canon semantics:
 *  - 10s stale window from TTS-end re-anchor
 *  - attach-but-don't-burn on short transcripts
 *  - burn on substantive transcripts (whitelist / 10+ chars / 3+ tokens /
 *    circuit-shape / single-token ≥4 chars)
 *  - FIFO match-by-text from `onQuestion` → `onTtsStart`
 */
import { describe, it, expect } from 'vitest';
import {
  InFlightQuestionTracker,
  transcriptConsumesInFlight,
  DEFAULT_STALE_WINDOW_MS,
  PENDING_FIFO_MAX,
} from '@/lib/recording/in-flight-question';

function makeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

describe('transcriptConsumesInFlight', () => {
  it.each([
    // Whitelist hits
    ['yes', true],
    ['Yes.', true],
    ['NO!', true],
    ['code 2', true],
    ['Code 2', true],
    ['ok', true],
    ['nope', true],
    // 10-char threshold
    ['this is long enough', true],
    ['exactly10!', true],
    // 3-token threshold
    ['one two three', true],
    // Circuit-shape
    ['circuit 1', true],
    ['Circuit one', true],
    ['second 1', true],
    ['third two', true],
    // Single-token ≥4 chars
    ['cooker', true],
    ['shower', true],
    ['lights', true],
    // Negatives — short noise
    ['uh', false],
    ['the', false],
    ['and', false],
    ['hob', false], // 3 chars, single token
    ['', false],
    ['   ', false],
  ])('%j → %j', (input, expected) => {
    expect(transcriptConsumesInFlight(input)).toBe(expected);
  });
});

describe('InFlightQuestionTracker', () => {
  it('returns null when no slot exists', () => {
    const t = new InFlightQuestionTracker();
    expect(t.takePayload('yes')).toBeNull();
    expect(t.hasActiveSlot).toBe(false);
  });

  it('enqueue → onTtsStart promotes pending into active slot', () => {
    const clock = makeClock();
    const t = new InFlightQuestionTracker(clock.now);
    t.enqueue({ type: 'unclear', question: 'What is Zs?' });
    expect(t.pendingCount).toBe(1);
    expect(t.hasActiveSlot).toBe(false);

    const matched = t.onTtsStart('What is Zs?');
    expect(matched).toBe(true);
    expect(t.pendingCount).toBe(0);
    expect(t.hasActiveSlot).toBe(true);
  });

  it('onTtsStart with no matching pending entry returns false', () => {
    const t = new InFlightQuestionTracker();
    t.enqueue({ type: 'unclear', question: 'A' });
    expect(t.onTtsStart('B')).toBe(false);
    expect(t.pendingCount).toBe(1);
    expect(t.hasActiveSlot).toBe(false);
  });

  it('takePayload attaches context but does NOT burn on a short/noise transcript', () => {
    const t = new InFlightQuestionTracker();
    t.enqueue({ type: 'unclear', question: 'Q?' });
    t.onTtsStart('Q?');

    const payload = t.takePayload('uh');
    expect(payload).toEqual({ type: 'unclear', question: 'Q?' });
    expect(t.hasActiveSlot).toBe(true); // slot still alive — noise didn't burn
  });

  it('takePayload burns the slot on a substantive transcript', () => {
    const t = new InFlightQuestionTracker();
    t.enqueue({ type: 'observation_confirmation', question: 'Log it?' });
    t.onTtsStart('Log it?');

    const payload = t.takePayload('yes');
    expect(payload).toEqual({
      type: 'observation_confirmation',
      question: 'Log it?',
    });
    expect(t.hasActiveSlot).toBe(false);
  });

  it('passes field + circuit through to the payload when set', () => {
    const t = new InFlightQuestionTracker();
    t.enqueue({
      type: 'unclear',
      question: 'Which circuit?',
      field: 'measured_zs_ohm',
      circuit: 5,
    });
    t.onTtsStart('Which circuit?');

    const payload = t.takePayload('cooker');
    expect(payload).toEqual({
      type: 'unclear',
      question: 'Which circuit?',
      field: 'measured_zs_ohm',
      circuit: 5,
    });
  });

  it('omits field/circuit when not provided', () => {
    const t = new InFlightQuestionTracker();
    t.enqueue({ type: 'unclear', question: 'Q?' });
    t.onTtsStart('Q?');
    const payload = t.takePayload('yes');
    expect(payload).toEqual({ type: 'unclear', question: 'Q?' });
    expect(payload).not.toHaveProperty('field');
    expect(payload).not.toHaveProperty('circuit');
  });

  it('returns null and clears slot when transcript arrives past the stale window', () => {
    const clock = makeClock();
    const t = new InFlightQuestionTracker(clock.now);
    t.enqueue({ type: 'unclear', question: 'Q?' });
    t.onTtsStart('Q?');

    clock.advance(DEFAULT_STALE_WINDOW_MS + 1);
    expect(t.takePayload('yes')).toBeNull();
    expect(t.hasActiveSlot).toBe(false);
  });

  it('onTtsEnd re-anchors askedAt so reply window starts at TTS-end', () => {
    const clock = makeClock();
    const t = new InFlightQuestionTracker(clock.now);
    t.enqueue({ type: 'unclear', question: 'Q?' });
    t.onTtsStart('Q?'); // askedAt = T0

    // Simulate 6s of TTS playback — would have burned 60% of window.
    clock.advance(6_000);
    t.onTtsEnd('Q?'); // askedAt re-anchored to T0+6s

    // 8s after re-anchor (14s after onTtsStart) — would be past window
    // without re-anchor, comfortably inside it after.
    clock.advance(8_000);
    const payload = t.takePayload('yes');
    expect(payload).not.toBeNull();
  });

  it('onTtsEnd ignored when slot is for a different question', () => {
    const clock = makeClock();
    const t = new InFlightQuestionTracker(clock.now);
    t.enqueue({ type: 'unclear', question: 'A?' });
    t.onTtsStart('A?');
    const snapshotBefore = t.peekSlot()!.askedAt;

    clock.advance(1000);
    t.onTtsEnd('B?'); // different question — no-op
    const snapshotAfter = t.peekSlot()!.askedAt;
    expect(snapshotAfter).toBe(snapshotBefore);
  });

  it('clear() force-drops the slot', () => {
    const t = new InFlightQuestionTracker();
    t.enqueue({ type: 'unclear', question: 'Q?' });
    t.onTtsStart('Q?');
    expect(t.hasActiveSlot).toBe(true);
    t.clear();
    expect(t.hasActiveSlot).toBe(false);
    expect(t.takePayload('yes')).toBeNull();
  });

  it('FIFO is capped at PENDING_FIFO_MAX', () => {
    const t = new InFlightQuestionTracker();
    for (let i = 0; i < PENDING_FIFO_MAX + 3; i++) {
      t.enqueue({ type: 'unclear', question: `Q${i}` });
    }
    expect(t.pendingCount).toBe(PENDING_FIFO_MAX);
  });

  it('two pending questions resolve in FIFO order by text match', () => {
    const t = new InFlightQuestionTracker();
    t.enqueue({ type: 'a', question: 'First?' });
    t.enqueue({ type: 'b', question: 'Second?' });

    t.onTtsStart('Second?');
    let payload = t.takePayload('yes');
    expect(payload?.type).toBe('b');

    // First is still pending, not promoted until its own TTS-start fires.
    expect(t.pendingCount).toBe(1);
    t.onTtsStart('First?');
    payload = t.takePayload('yes');
    expect(payload?.type).toBe('a');
  });
});

describe('removeByToolCallIdPrefix (cancel_pending_tts state-clear)', () => {
  it('drops matching PENDING entries, keeps non-matching', () => {
    const t = new InFlightQuestionTracker();
    t.enqueue({ type: 'a', question: 'BS number?', toolCallId: 'srv-bs-1' });
    t.enqueue({ type: 'b', question: 'Other?', toolCallId: 'other-2' });
    t.removeByToolCallIdPrefix('srv-bs-');
    expect(t.pendingCount).toBe(1);
    // The surviving one promotes + attaches.
    t.onTtsStart('Other?');
    expect(t.takePayload('yes')?.type).toBe('b');
  });

  it('clears the ACTIVE slot when its toolCallId matches the prefix', () => {
    const t = new InFlightQuestionTracker();
    t.enqueue({ type: 'a', question: 'BS number?', toolCallId: 'srv-bs-1' });
    t.onTtsStart('BS number?');
    expect(t.hasActiveSlot).toBe(true);
    t.removeByToolCallIdPrefix('srv-bs-');
    expect(t.hasActiveSlot).toBe(false);
  });

  it('leaves the slot when the toolCallId does NOT match', () => {
    const t = new InFlightQuestionTracker();
    t.enqueue({ type: 'a', question: 'BS number?', toolCallId: 'srv-bs-1' });
    t.onTtsStart('BS number?');
    t.removeByToolCallIdPrefix('srv-ir-');
    expect(t.hasActiveSlot).toBe(true);
  });

  it('an empty prefix is a no-op', () => {
    const t = new InFlightQuestionTracker();
    t.enqueue({ type: 'a', question: 'Q?', toolCallId: 'srv-bs-1' });
    t.removeByToolCallIdPrefix('');
    expect(t.pendingCount).toBe(1);
  });
});
