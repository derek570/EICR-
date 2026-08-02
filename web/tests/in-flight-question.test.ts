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
  buildQuestionTapDispatch,
  InFlightQuestionTracker,
  isServerOwnedAddressMirrorQuestion,
  shouldDiscardTtsEchoForQuestion,
  transcriptConsumesInFlight,
  DEFAULT_STALE_WINDOW_MS,
  PENDING_FIFO_MAX,
} from '@/lib/recording/in-flight-question';

describe('buildQuestionTapDispatch', () => {
  it.each([true, false])('routes live mirror taps through transcript then ask (%s)', (accepted) => {
    expect(
      buildQuestionTapDispatch(
        {
          question: 'Use the site address for the client?',
          question_type: 'ask_user',
          tool_call_id: 'ask-live-1',
          purpose: 'address_mirror',
        },
        accepted
      )
    ).toEqual({
      transcript: accepted ? 'yes' : 'no',
      askUserAnswered: { toolCallId: 'ask-live-1', purpose: 'address_mirror' },
      serverOwnsTerminalSpeech: true,
    });
  });

  it.each([true, false])('routes rollback mirror taps through in_response_to (%s)', (accepted) => {
    expect(
      buildQuestionTapDispatch(
        {
          question: 'Use the site address for the client?',
          question_type: 'address_mirror',
          purpose: 'address_mirror',
          field: 'client_address',
        },
        accepted
      )
    ).toEqual({
      transcript: accepted ? 'yes' : 'no',
      inResponseTo: {
        type: 'address_mirror',
        question: 'Use the site address for the client?',
        purpose: 'address_mirror',
        field: 'client_address',
      },
      serverOwnsTerminalSpeech: true,
    });
  });

  it.each([true, false])(
    'routes direct taps with the exact direct question id (%s)',
    (accepted) => {
      expect(
        buildQuestionTapDispatch(
          {
            question: 'The client address differs. Replace it?',
            question_type: 'address_mirror_direct',
            tool_call_id: 'address-mirror-direct-op-7',
          },
          accepted
        )
      ).toEqual({
        transcript: accepted ? 'yes' : 'no',
        inResponseTo: {
          type: 'address_mirror_direct',
          question: 'The client address differs. Replace it?',
          tool_call_id: 'address-mirror-direct-op-7',
        },
        serverOwnsTerminalSpeech: true,
      });
    }
  );
});

describe('address mirror prompt echo arbitration', () => {
  it('keeps a supported overlapping answer for live and rollback address asks', () => {
    const live = {
      type: 'ask_user',
      question: 'Should I use this same address for the client?',
      purpose: 'address_mirror',
      tool_call_id: 'ask-address-1',
    };
    const rollback = {
      type: 'address_mirror',
      question: 'Should I use this same address for the client?',
    };

    // isTTSEcho("use the same") is true for these prompt words. The exact
    // server-owned address identity must nevertheless let the answer route.
    expect(shouldDiscardTtsEchoForQuestion('use the same', true, live)).toBe(false);
    expect(shouldDiscardTtsEchoForQuestion('same as site', true, rollback)).toBe(false);
    expect(shouldDiscardTtsEchoForQuestion('different', true, rollback)).toBe(false);
  });

  it('still rejects the spoken address prompt and unsupported prompt fragments', () => {
    const question = {
      type: 'ask_user',
      question: 'Should I use this same address for the client?',
      purpose: 'address_mirror',
    };

    expect(
      shouldDiscardTtsEchoForQuestion(
        'Should I use this same address for the client?',
        true,
        question
      )
    ).toBe(true);
    expect(shouldDiscardTtsEchoForQuestion('use this same address', true, question)).toBe(true);
  });

  it('retains generic echo rejection for ordinary questions', () => {
    expect(
      shouldDiscardTtsEchoForQuestion('Which circuit was that for?', true, {
        type: 'unclear',
        question: 'Which circuit was that for?',
      })
    ).toBe(true);
    expect(shouldDiscardTtsEchoForQuestion('anything', false, null)).toBe(false);
  });
});

describe('tap consumption', () => {
  it('clears only the exact tapped generation and preserves a newer identical ask', () => {
    const tracker = new InFlightQuestionTracker(() => 1_000);
    tracker.enqueue({
      type: 'stage6_ask_user',
      question: 'Use this address?',
      toolCallId: 'ask-a',
    });
    tracker.enqueue({
      type: 'stage6_ask_user',
      question: 'Use this address?',
      toolCallId: 'ask-b',
    });
    expect(tracker.onTtsStart('Use this address?')).toBe(true);

    tracker.consumeMatchingQuestion('Use this address?', 'ask-a');
    expect(tracker.peekPayloadForTranscript()).toBeNull();
    expect(tracker.onTtsStart('Use this address?')).toBe(true);
    expect(tracker.peekPayloadForTranscript()?.tool_call_id).toBe('ask-b');
  });
});

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

  it('round-trips the server-owned address mirror purpose', () => {
    const t = new InFlightQuestionTracker();
    t.enqueue({
      type: 'address_mirror',
      question: 'Use the site address for the client?',
      purpose: 'address_mirror',
      toolCallId: 'ask-address-1',
    });
    t.onTtsStart('Use the site address for the client?');
    expect(t.takePayload('yes')).toMatchObject({
      type: 'address_mirror',
      purpose: 'address_mirror',
      tool_call_id: 'ask-address-1',
    });
  });

  it('preserves direct question identity and leaves terminal speech to the server', () => {
    const t = new InFlightQuestionTracker();
    t.enqueue({
      type: 'address_mirror_direct',
      question: 'The client address is already different. Should I replace it?',
      toolCallId: 'address-mirror-direct-operation-2',
    });
    t.onTtsStart('The client address is already different. Should I replace it?');
    expect(t.takePayload('yes')).toMatchObject({
      type: 'address_mirror_direct',
      tool_call_id: 'address-mirror-direct-operation-2',
    });
    expect(isServerOwnedAddressMirrorQuestion({ question_type: 'address_mirror_direct' })).toBe(
      true
    );
    expect(isServerOwnedAddressMirrorQuestion({ purpose: 'address_mirror' })).toBe(true);
    expect(isServerOwnedAddressMirrorQuestion({ question_type: 'unclear' })).toBe(false);
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
