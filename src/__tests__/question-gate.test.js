/**
 * Tests for QuestionGate — holds Sonnet questions for 2.5s before sending to iOS.
 */

import { jest } from '@jest/globals';
import { QuestionGate } from '../extraction/question-gate.js';

describe('QuestionGate', () => {
  let sendCallback;
  let gate;

  beforeEach(() => {
    jest.useFakeTimers();
    sendCallback = jest.fn();
    gate = new QuestionGate(sendCallback);
  });

  afterEach(() => {
    gate.destroy();
    jest.useRealTimers();
  });

  describe('enqueue', () => {
    test('should not send immediately on enqueue', () => {
      gate.enqueue([{ field: 'zs', circuit: 1, question: 'Which circuit?' }]);
      expect(sendCallback).not.toHaveBeenCalled();
    });

    test('should send after 2.5 second delay', () => {
      const questions = [{ field: 'zs', circuit: 1, question: 'Which circuit?' }];
      gate.enqueue(questions);

      jest.advanceTimersByTime(2500);

      expect(sendCallback).toHaveBeenCalledTimes(1);
      expect(sendCallback).toHaveBeenCalledWith(questions);
    });

    test('should ignore empty questions array', () => {
      gate.enqueue([]);
      jest.advanceTimersByTime(3000);
      expect(sendCallback).not.toHaveBeenCalled();
    });

    test('should ignore null questions', () => {
      gate.enqueue(null);
      jest.advanceTimersByTime(3000);
      expect(sendCallback).not.toHaveBeenCalled();
    });

    test('should ignore undefined questions', () => {
      gate.enqueue(undefined);
      jest.advanceTimersByTime(3000);
      expect(sendCallback).not.toHaveBeenCalled();
    });

    test('should accumulate questions from multiple enqueues', () => {
      gate.enqueue([{ field: 'zs', circuit: 1 }]);
      jest.advanceTimersByTime(500);
      gate.enqueue([{ field: 'r1_plus_r2', circuit: 2 }]);

      jest.advanceTimersByTime(2500);

      expect(sendCallback).toHaveBeenCalledTimes(1);
      expect(sendCallback).toHaveBeenCalledWith([
        { field: 'zs', circuit: 1 },
        { field: 'r1_plus_r2', circuit: 2 },
      ]);
    });

    test('should clear pending questions after flush', () => {
      gate.enqueue([{ field: 'zs', circuit: 1 }]);
      jest.advanceTimersByTime(2500);
      expect(sendCallback).toHaveBeenCalledTimes(1);

      // After flush, no more sends even if we wait
      jest.advanceTimersByTime(5000);
      expect(sendCallback).toHaveBeenCalledTimes(1);
    });
  });

  describe('onNewUtterance', () => {
    test('should reset timer when questions are pending', () => {
      gate.enqueue([{ field: 'zs', circuit: 1 }]);

      // Advance 1.5s (not yet flushed)
      jest.advanceTimersByTime(1500);
      expect(sendCallback).not.toHaveBeenCalled();

      // New utterance resets the 2.5s timer
      gate.onNewUtterance();

      // 2s after reset — still not flushed
      jest.advanceTimersByTime(2000);
      expect(sendCallback).not.toHaveBeenCalled();

      // 2.5s total after reset — now flushed
      jest.advanceTimersByTime(500);
      expect(sendCallback).toHaveBeenCalledTimes(1);
    });

    test('should not reset timer when no questions are pending', () => {
      gate.onNewUtterance();
      jest.advanceTimersByTime(5000);
      expect(sendCallback).not.toHaveBeenCalled();
    });
  });

  describe('resolveByFields', () => {
    test('should remove questions matching resolved fields', () => {
      gate.enqueue([
        { field: 'zs', circuit: 1 },
        { field: 'r1_plus_r2', circuit: 2 },
      ]);

      gate.resolveByFields(new Set(['zs:1']));

      jest.advanceTimersByTime(2500);

      expect(sendCallback).toHaveBeenCalledWith([{ field: 'r1_plus_r2', circuit: 2 }]);
    });

    test('should cancel timer when all questions resolved', () => {
      gate.enqueue([{ field: 'zs', circuit: 1 }]);

      gate.resolveByFields(new Set(['zs:1']));

      jest.advanceTimersByTime(5000);
      expect(sendCallback).not.toHaveBeenCalled();
    });

    test('should handle questions with undefined field/circuit', () => {
      gate.enqueue([{ question: 'What was that?' }, { field: 'zs', circuit: 1 }]);

      gate.resolveByFields(new Set(['unknown:unknown']));

      jest.advanceTimersByTime(2500);

      // The question with undefined field/circuit matches 'unknown:unknown'
      expect(sendCallback).toHaveBeenCalledWith([{ field: 'zs', circuit: 1 }]);
    });

    test('should not remove questions for non-matching fields', () => {
      gate.enqueue([{ field: 'zs', circuit: 1 }]);

      gate.resolveByFields(new Set(['r1_plus_r2:1']));

      jest.advanceTimersByTime(2500);

      expect(sendCallback).toHaveBeenCalledWith([{ field: 'zs', circuit: 1 }]);
    });

    // Regression for 14 Chichester Road postcode double-ask (session EE0A697A,
    // 2026-04-20). Sonnet emitted {type:"unclear", field:"postcode", circuit:null}
    // but readings for installation fields land at circuit 0 → old code built
    // resolveKey "postcode:unknown" vs reading key "postcode:0" → miss →
    // pending question survived into the 2.5s flush → duplicate TTS ask.
    test('null-circuit question resolves against any circuit reading for same field', () => {
      gate.enqueue([{ type: 'unclear', field: 'postcode', circuit: null }]);

      gate.resolveByFields(new Set(['postcode:0']));

      jest.advanceTimersByTime(2500);
      expect(sendCallback).not.toHaveBeenCalled();
    });

    test('undefined-circuit question also resolves against any circuit reading', () => {
      gate.enqueue([{ type: 'unclear', field: 'postcode' }]); // circuit undefined

      gate.resolveByFields(new Set(['postcode:0']));

      jest.advanceTimersByTime(2500);
      expect(sendCallback).not.toHaveBeenCalled();
    });

    test('specific-circuit question is NOT resolved by a different circuit', () => {
      // Regression guard: null-circuit wildcard must not leak into
      // specific-circuit questions. A question about Zs on circuit 1 must
      // survive when only Zs on circuit 2 was resolved.
      gate.enqueue([{ field: 'zs', circuit: 1 }]);

      gate.resolveByFields(new Set(['zs:2']));

      jest.advanceTimersByTime(2500);
      expect(sendCallback).toHaveBeenCalledWith([{ field: 'zs', circuit: 1 }]);
    });

    test('circuit:0 question resolves against circuit 0 reading (latent 0-falsy bug)', () => {
      // Old code built key `${field}:${circuit || 'unknown'}` — 0 is falsy in
      // JS so circuit:0 coerced to "unknown". Fixed by explicit null/undefined
      // check.
      gate.enqueue([{ field: 'address', circuit: 0 }]);

      gate.resolveByFields(new Set(['address:0']));

      jest.advanceTimersByTime(2500);
      expect(sendCallback).not.toHaveBeenCalled();
    });
  });

  describe('de-dupe within TTL', () => {
    test('suppresses identical question re-enqueued while pending', () => {
      const q = { type: 'unclear', field: 'postcode', heard_value: 'RG' };
      gate.enqueue([q]);
      gate.enqueue([{ ...q }]); // identical signature

      jest.advanceTimersByTime(2500);
      expect(sendCallback).toHaveBeenCalledTimes(1);
      expect(sendCallback.mock.calls[0][0]).toHaveLength(1);
    });

    test('suppresses identical question re-enqueued shortly after flush', () => {
      const q = { type: 'unclear', field: 'postcode', heard_value: 'RG' };
      gate.enqueue([q]);
      jest.advanceTimersByTime(2500);
      expect(sendCallback).toHaveBeenCalledTimes(1);

      // Sonnet re-emits the same question 3s later (turn N+1)
      jest.advanceTimersByTime(3000);
      gate.enqueue([{ ...q }]);
      jest.advanceTimersByTime(2500);
      // Should NOT have fired a second time — dupe suppressed
      expect(sendCallback).toHaveBeenCalledTimes(1);
    });

    test('allows re-ask after DEDUPE_TTL_MS window expires', () => {
      const q = { type: 'unclear', field: 'postcode', heard_value: 'RG' };
      gate.enqueue([q]);
      jest.advanceTimersByTime(2500);
      expect(sendCallback).toHaveBeenCalledTimes(1);

      // Jump past the 15s TTL — a legitimately repeated ask should fire
      jest.advanceTimersByTime(16000);
      gate.enqueue([{ ...q }]);
      jest.advanceTimersByTime(2500);
      expect(sendCallback).toHaveBeenCalledTimes(2);
    });

    test('different heard_value is treated as a distinct question', () => {
      gate.enqueue([{ type: 'unclear', field: 'postcode', heard_value: 'RG' }]);
      jest.advanceTimersByTime(2500);
      gate.enqueue([{ type: 'unclear', field: 'postcode', heard_value: 'SW1' }]);
      jest.advanceTimersByTime(2500);
      expect(sendCallback).toHaveBeenCalledTimes(2);
    });
  });

  describe('destroy', () => {
    test('should cancel pending timer', () => {
      gate.enqueue([{ field: 'zs', circuit: 1 }]);
      gate.destroy();

      jest.advanceTimersByTime(5000);
      expect(sendCallback).not.toHaveBeenCalled();
    });

    test('should clear pending questions', () => {
      gate.enqueue([{ field: 'zs', circuit: 1 }]);
      gate.destroy();

      expect(gate.pendingQuestions).toEqual([]);
      expect(gate.gateTimer).toBeNull();
    });
  });

  describe('flush', () => {
    test('should not call callback when no pending questions', () => {
      gate.flush();
      expect(sendCallback).not.toHaveBeenCalled();
    });

    test('should send and clear pending questions', () => {
      gate.enqueue([{ field: 'zs', circuit: 1 }]);
      gate.flush();

      expect(sendCallback).toHaveBeenCalledWith([{ field: 'zs', circuit: 1 }]);
      expect(gate.pendingQuestions).toEqual([]);
    });
  });
});
