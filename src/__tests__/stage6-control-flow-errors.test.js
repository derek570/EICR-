/**
 * stage6-control-flow-errors.test.js — F7 Item 3. The shared fatal
 * control-flow discriminator + the throwIfStage6Cancelled guard (all three
 * branches).
 */

import {
  ExtractionCancelledError,
  AskRegistrationHookError,
  isStage6FatalControlFlowError,
  throwIfStage6Cancelled,
} from '../extraction/stage6-control-flow-errors.js';

describe('isStage6FatalControlFlowError', () => {
  test('recognises both fatal types (instanceof and brand)', () => {
    expect(isStage6FatalControlFlowError(new ExtractionCancelledError())).toBe(true);
    expect(isStage6FatalControlFlowError(new AskRegistrationHookError())).toBe(true);
    // A branded copy across a module boundary is still recognised.
    expect(isStage6FatalControlFlowError({ isStage6FatalControlFlow: true })).toBe(true);
  });

  test('rejects ordinary errors + falsy values', () => {
    expect(isStage6FatalControlFlowError(new Error('boom'))).toBe(false);
    expect(isStage6FatalControlFlowError(null)).toBe(false);
    expect(isStage6FatalControlFlowError(undefined)).toBe(false);
  });

  test('the cause is preserved on both types', () => {
    const root = new Error('root');
    expect(new ExtractionCancelledError('x', { cause: root }).cause).toBe(root);
    expect(new AskRegistrationHookError('y', { cause: root }).cause).toBe(root);
  });
});

describe('throwIfStage6Cancelled', () => {
  test('branch 1: absent / not-aborted signal → returns (no throw)', () => {
    expect(() => throwIfStage6Cancelled(null)).not.toThrow();
    expect(() => throwIfStage6Cancelled(undefined)).not.toThrow();
    const ac = new AbortController();
    expect(() => throwIfStage6Cancelled(ac.signal)).not.toThrow();
  });

  test('branch 2: signal.reason already an ExtractionCancelledError → rethrown UNCHANGED', () => {
    const original = new ExtractionCancelledError('ceiling');
    const ac = new AbortController();
    ac.abort(original);
    try {
      throwIfStage6Cancelled(ac.signal);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBe(original); // same instance, not a re-wrap
    }
  });

  test('branch 3: aborted with a non-cancellation reason → NEW ExtractionCancelledError with reason as cause', () => {
    const root = new Error('some other reason');
    const ac = new AbortController();
    ac.abort(root);
    try {
      throwIfStage6Cancelled(ac.signal);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ExtractionCancelledError);
      expect(e.cause).toBe(root);
    }
  });
});
