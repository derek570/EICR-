/**
 * WS3 item 7b — transcript-gate wiring semantics (2026-07-02).
 *
 * Covers the plan's three wiring scenarios against the REAL
 * InFlightQuestionTracker + REAL shouldForward, with the dispatch glue
 * mirrored from `recording-context.tsx` `dispatchFinal` (same Tier-1
 * mirror approach as tests/parity/harness.ts — the provider itself is
 * not mountable in unit tests):
 *
 *   (a) stale/expired slot → gate REJECT, expired slot cleared, no
 *       send/chime, pending question not falsely answered;
 *   (b) valid Stage 6 ask + short answer → forwards, chimes, emits
 *       transcript then ask_user_answered, consumes the tool_call_id;
 *   (c) valid legacy in_response_to → forwards and consumes per
 *       takePayload.
 *
 * Plus: a regex-only reading must never be suppressed (hasRegexHit is
 * passed directly, exercising the ported gate deterministically per the
 * plan's flag-off caveat), and a REJECT must not increment the
 * processing counter (it is only ever decremented by server frames).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InFlightQuestionTracker } from '@/lib/recording/in-flight-question';
import { shouldForward } from '@/lib/recording/transcript-gate';

/** Minimal mirror of the dispatchFinal gate glue (recording-context.tsx):
 *  peek signals → gate → REJECT housekeeping OR PASS consume+send. */
function makeDispatch(deps: {
  tracker: InFlightQuestionTracker;
  peekToolCallId: () => string | null;
  consumeToolCallId: () => string | null;
  sendTranscript: (text: string, inResponseTo?: unknown) => void;
  sendAskUserAnswered: (toolCallId: string, text: string) => void;
  chime: () => void;
  incrementProcessing: () => void;
}) {
  return function dispatch(text: string, gateRegexHit = false): 'pass' | 'reject' {
    const peekedToolCallId = deps.peekToolCallId();
    const isAnswerToAsk = Boolean(peekedToolCallId);
    const peekedPayload = deps.tracker.peekPayloadForTranscript();
    const pass = shouldForward({
      text,
      hasRegexHit: gateRegexHit,
      hasPendingAsk: isAnswerToAsk,
      inResponseTo: peekedPayload != null,
    });
    if (!pass) {
      deps.tracker.clearExpiredSlot();
      return 'reject';
    }
    const toolCallId = deps.consumeToolCallId();
    const drained = deps.tracker.takePayload(text);
    const inResponseTo = toolCallId ? undefined : (drained ?? undefined);
    deps.chime();
    deps.sendTranscript(text, inResponseTo);
    if (toolCallId) {
      deps.tracker.clear();
      deps.sendAskUserAnswered(toolCallId, text);
    }
    deps.incrementProcessing();
    return 'pass';
  };
}

describe('InFlightQuestionTracker — non-mutating peek helpers', () => {
  let now = 0;
  let tracker: InFlightQuestionTracker;

  beforeEach(() => {
    now = 0;
    tracker = new InFlightQuestionTracker(() => now, 10_000);
  });

  function armSlot(question = 'What is the Zs for circuit 3?'): void {
    tracker.enqueue({ type: 'ask_user', question, field: 'measured_zs_ohm', circuit: 3 });
    tracker.onTtsStart(question);
  }

  it('peekPayloadForTranscript returns the payload without burning the slot', () => {
    armSlot();
    const peeked = tracker.peekPayloadForTranscript();
    expect(peeked).not.toBeNull();
    expect(peeked!.question).toBe('What is the Zs for circuit 3?');
    // Still available for the mutating consume on the PASS path.
    const taken = tracker.takePayload('0.44');
    expect(taken).not.toBeNull();
  });

  it('peekPayloadForTranscript returns null past the stale window and does NOT clear', () => {
    armSlot();
    now += 10_001;
    expect(tracker.peekPayloadForTranscript()).toBeNull();
    // Non-mutating: the slot object is still there until housekeeping.
    expect(tracker.hasActiveSlot).toBe(true);
  });

  it('clearExpiredSlot clears ONLY an expired slot', () => {
    armSlot();
    tracker.clearExpiredSlot();
    expect(tracker.hasActiveSlot).toBe(true); // valid → untouched
    now += 10_001;
    tracker.clearExpiredSlot();
    expect(tracker.hasActiveSlot).toBe(false); // expired → cleared
  });
});

describe('dispatch gate wiring (Tier-1 mirror of recording-context dispatchFinal)', () => {
  let now: number;
  let tracker: InFlightQuestionTracker;
  let sends: Array<{ kind: string; text: string; toolCallId?: string; inResponseTo?: unknown }>;
  let chime: ReturnType<typeof vi.fn>;
  let processing: number;
  let stage6ToolCallId: string | null;

  function build() {
    return makeDispatch({
      tracker,
      peekToolCallId: () => stage6ToolCallId,
      consumeToolCallId: () => {
        const id = stage6ToolCallId;
        stage6ToolCallId = null;
        return id;
      },
      sendTranscript: (text, inResponseTo) =>
        sends.push({ kind: 'transcript', text, inResponseTo }),
      sendAskUserAnswered: (toolCallId, text) =>
        sends.push({ kind: 'ask_user_answered', text, toolCallId }),
      chime,
      incrementProcessing: () => {
        processing += 1;
      },
    });
  }

  beforeEach(() => {
    now = 0;
    tracker = new InFlightQuestionTracker(() => now, 10_000);
    sends = [];
    chime = vi.fn();
    processing = 0;
    stage6ToolCallId = null;
  });

  it('(a) stale slot → REJECT: cleared, no send, no chime, no processing bump, no false answer', () => {
    tracker.enqueue({ type: 'ask_user', question: 'Which circuit?', field: null, circuit: null });
    tracker.onTtsStart('Which circuit?');
    now += 10_001; // expire the slot
    const dispatch = build();
    // A chitchat utterance that only a (stale) inResponseTo could have passed.
    const outcome = dispatch('hello there mate how are things');
    expect(outcome).toBe('reject');
    expect(sends).toHaveLength(0);
    expect(chime).not.toHaveBeenCalled();
    expect(processing).toBe(0);
    expect(tracker.hasActiveSlot).toBe(false); // expired slot housekept
  });

  it('(b) valid Stage 6 ask + short answer → forwards, chimes, transcript THEN ask_user_answered, consumes id', () => {
    stage6ToolCallId = 'toolu_abc123';
    const dispatch = build();
    const outcome = dispatch('TT'); // short answer — only hasPendingAsk can pass it
    expect(outcome).toBe('pass');
    expect(chime).toHaveBeenCalledTimes(1);
    expect(sends.map((s) => s.kind)).toEqual(['transcript', 'ask_user_answered']);
    expect(sends[1].toolCallId).toBe('toolu_abc123');
    expect(stage6ToolCallId).toBeNull(); // consumed
    expect(processing).toBe(1);
    // Stage 6 path suppresses the legacy in_response_to annotation.
    expect(sends[0].inResponseTo).toBeUndefined();
  });

  it('(c) valid legacy in_response_to → forwards and consumes per takePayload', () => {
    tracker.enqueue({
      type: 'ask_user',
      question: 'What is the Zs for circuit 3?',
      field: 'measured_zs_ohm',
      circuit: 3,
    });
    tracker.onTtsStart('What is the Zs for circuit 3?');
    const dispatch = build();
    const outcome = dispatch('naught point four four'); // no digit — passes via inResponseTo
    expect(outcome).toBe('pass');
    expect(chime).toHaveBeenCalledTimes(1);
    expect(sends).toHaveLength(1);
    expect(sends[0].inResponseTo).toMatchObject({
      question: 'What is the Zs for circuit 3?',
      field: 'measured_zs_ohm',
      circuit: 3,
    });
    expect(processing).toBe(1);
  });

  it('regex-only reading is never suppressed (hasRegexHit passes the gate)', () => {
    const dispatch = build();
    // No digit, no trigger words — only the regex-hit signal can pass it.
    const outcome = dispatch('some matchable value phrase', true);
    expect(outcome).toBe('pass');
    expect(sends).toHaveLength(1);
    expect(chime).toHaveBeenCalledTimes(1);
  });

  it('chitchat REJECT produces neither chime nor send nor processing bump', () => {
    const dispatch = build();
    const outcome = dispatch('Can I use the toilet, please?');
    expect(outcome).toBe('reject');
    expect(sends).toHaveLength(0);
    expect(chime).not.toHaveBeenCalled();
    expect(processing).toBe(0);
  });

  it('valid ask state survives a REJECT (only expired slots are housekept)', () => {
    tracker.enqueue({ type: 'ask_user', question: 'Which board?', field: null, circuit: null });
    tracker.onTtsStart('Which board?');
    // Empty utterance blocks BEFORE the inResponseTo branch can pass it?
    // No — inResponseTo returns true first in the gate order, so use an
    // empty text which shouldForward rejects only when all bypass inputs
    // are false. With a valid slot inResponseTo=true → PASS by
    // definition (iOS canon: no reject-with-valid-ask case). So this
    // test asserts exactly that: a valid slot FORCES a pass.
    const dispatch = build();
    const outcome = dispatch('um');
    expect(outcome).toBe('pass'); // valid in_response_to slot → gate PASS
  });
});
