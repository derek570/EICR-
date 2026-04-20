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
      // A field-less question ("What was that?") now SURVIVES field-keyed
      // resolution because there's no `field` to check against. Old code
      // coerced `q.field || 'unknown'` and matched a synthetic
      // `unknown:unknown` key — but no real reading ever carries that key,
      // so the coincidence test was locking in undefined behaviour.
      // Post-2026-04-20 wildcard-guard: field-less questions aren't in
      // INSTALLATION_FIELDS and fall through to "keep" (correct — Sonnet
      // asked something without a field hook, we can't auto-resolve it).
      gate.enqueue([{ question: 'What was that?' }, { field: 'zs', circuit: 1 }]);

      gate.resolveByFields(new Set(['unknown:unknown']));

      jest.advanceTimersByTime(2500);

      expect(sendCallback).toHaveBeenCalledWith([
        { question: 'What was that?' },
        { field: 'zs', circuit: 1 },
      ]);
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

    // Regression guard for codex review finding (2026-04-20). The first cut of
    // the null-circuit fix wildcard-resolved EVERY null-circuit question,
    // which meant an orphan reading prompt like `{field: zs, circuit: null}`
    // — "I heard a Zs reading but don't know which circuit" — would be
    // silently dropped by any `zs:<N>` reading on a different circuit.
    // Wildcard must be gated to a whitelist of install-level fields only.
    test('null-circuit orphan on circuit-specific field is NOT wildcard-resolved', () => {
      gate.enqueue([{ type: 'unclear', field: 'zs', circuit: null, heard_value: '0.42' }]);

      // An unrelated zs:1 reading arrives — the orphan is about a DIFFERENT
      // reading whose circuit is still unknown. It must survive so the
      // inspector is eventually asked to assign it.
      gate.resolveByFields(new Set(['zs:1']));

      jest.advanceTimersByTime(2500);
      expect(sendCallback).toHaveBeenCalledTimes(1);
      expect(sendCallback.mock.calls[0][0]).toEqual([
        { type: 'unclear', field: 'zs', circuit: null, heard_value: '0.42' },
      ]);
    });

    test('null-circuit orphan on circuit-specific field survives even same-circuit reading', () => {
      // Stronger guarantee: even a `zs:1` reading does not clear a null-circuit
      // zs orphan, because the orphan is semantically "which circuit?" and
      // cannot be answered by a reading on any specific circuit — only by an
      // explicit user reply.
      gate.enqueue([{ type: 'unclear', field: 'r1_plus_r2', circuit: null }]);

      gate.resolveByFields(new Set(['r1_plus_r2:3']));

      jest.advanceTimersByTime(2500);
      expect(sendCallback).toHaveBeenCalledTimes(1);
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
