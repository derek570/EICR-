/**
 * Tests for QuestionGate — holds Sonnet questions for 2s before sending to iOS.
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

    test('should send after 2 second delay', () => {
      const questions = [{ field: 'zs', circuit: 1, question: 'Which circuit?' }];
      gate.enqueue(questions);

      jest.advanceTimersByTime(2000);

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

      jest.advanceTimersByTime(2000);

      expect(sendCallback).toHaveBeenCalledTimes(1);
      expect(sendCallback).toHaveBeenCalledWith([
        { field: 'zs', circuit: 1 },
        { field: 'r1_plus_r2', circuit: 2 }
      ]);
    });

    test('should clear pending questions after flush', () => {
      gate.enqueue([{ field: 'zs', circuit: 1 }]);
      jest.advanceTimersByTime(2000);
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

      // New utterance resets the 2s timer
      gate.onNewUtterance();

      // 1.5s after reset — still not flushed
      jest.advanceTimersByTime(1500);
      expect(sendCallback).not.toHaveBeenCalled();

      // 2s total after reset — now flushed
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
        { field: 'r1_plus_r2', circuit: 2 }
      ]);

      gate.resolveByFields(new Set(['zs:1']));

      jest.advanceTimersByTime(2000);

      expect(sendCallback).toHaveBeenCalledWith([
        { field: 'r1_plus_r2', circuit: 2 }
      ]);
    });

    test('should cancel timer when all questions resolved', () => {
      gate.enqueue([{ field: 'zs', circuit: 1 }]);

      gate.resolveByFields(new Set(['zs:1']));

      jest.advanceTimersByTime(5000);
      expect(sendCallback).not.toHaveBeenCalled();
    });

    test('should handle questions with undefined field/circuit', () => {
      gate.enqueue([
        { question: 'What was that?' },
        { field: 'zs', circuit: 1 }
      ]);

      gate.resolveByFields(new Set(['unknown:unknown']));

      jest.advanceTimersByTime(2000);

      // The question with undefined field/circuit matches 'unknown:unknown'
      expect(sendCallback).toHaveBeenCalledWith([
        { field: 'zs', circuit: 1 }
      ]);
    });

    test('should not remove questions for non-matching fields', () => {
      gate.enqueue([{ field: 'zs', circuit: 1 }]);

      gate.resolveByFields(new Set(['r1_plus_r2:1']));

      jest.advanceTimersByTime(2000);

      expect(sendCallback).toHaveBeenCalledWith([{ field: 'zs', circuit: 1 }]);
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
