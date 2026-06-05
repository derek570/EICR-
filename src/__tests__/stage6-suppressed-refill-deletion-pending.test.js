/**
 * Stage 6 Phase 8 — Plan 08-01 SC #6 — `suppressed_refill_question` deletion-
 * pending warn-log.
 *
 * WHAT: Asserts that whenever filterQuestionsAgainstFilledSlots emits a
 * `suppressed_refill_question` info-log row, it ALSO emits a one-shot
 * WARN-level `stage6.suppressed_refill_question_deletion_pending` row
 * per sessionId. Subsequent emits in the same session are silent.
 *
 * WHY: Phase 8 ROADMAP §SC #6 — "suppressed_refill_question metric +
 * analyzer field fully removed (finishes STO-05)". Phase 7 STR-05
 * defers the actual deletion to T+4w post-live. Until then, the metric
 * is still emitted (it's still useful diagnostic for prompt regressions).
 * The deletion-pending warn next to the emit gives the operator a
 * "this surface is scheduled for deletion at T+4w" breadcrumb without
 * changing the metric's behaviour.
 *
 * WHY one-shot per session (not per emit): a long session that
 * suppresses 30 refill questions should NOT emit 30 deletion-pending
 * warnings. Same discipline as Phase 7's `legacy_path_invoked`
 * (logLegacyPathInvokedOnce in sonnet-stream.js:208) — one row per
 * session is the right resolution for a pre-deletion gate signal.
 *
 * WHY a NEW activeSessions entry (different sessionId) DOES warn
 * again: the deletion gate at T+4w needs to count distinct sessions
 * that touched this surface in trailing 14 days. Per-session one-shot
 * gives that count exactly.
 *
 * Pattern parallel: stage6-legacy-path-warn-log.test.js (Phase 7
 * Plan 07-02 Task 1, commit 64dcea2 RED → b6c77a5 GREEN).
 */

import { jest } from '@jest/globals';
import {
  filterQuestionsAgainstFilledSlots,
  __TEST_RESET_DELETION_PENDING_LOG_STATE,
} from '../extraction/filled-slots-filter.js';
import logger from '../logger.js';

describe('Plan 08-01 SC #6 — suppressed_refill_question deletion-pending warn-log', () => {
  beforeEach(() => {
    jest.spyOn(logger, 'info').mockImplementation(() => {});
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
    if (typeof __TEST_RESET_DELETION_PENDING_LOG_STATE === 'function') {
      __TEST_RESET_DELETION_PENDING_LOG_STATE();
    }
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // Common fixture — a slot is already filled, Sonnet asks a refill question.
  // Returns the filter's INPUT shape; the call site asserts emission.
  function commonInputs(sessionId, field = 'measured_zs_ohm', circuit = 1) {
    return {
      questions: [
        {
          field,
          circuit,
          type: 'circuit_disambiguation',
          question: `What is the ${field} for circuit ${circuit}?`,
        },
      ],
      stateSnapshot: {
        circuits: {
          [circuit]: {
            circuit_ref: circuit,
            [field]: '0.35',
          },
        },
      },
      resolvedFieldsThisTurn: new Set(),
      sessionId,
    };
  }

  test('first suppressed_refill_question emit ALSO emits deletion-pending warn (one-shot)', () => {
    const inputs = commonInputs('session-001');
    filterQuestionsAgainstFilledSlots(
      inputs.questions,
      inputs.stateSnapshot,
      inputs.resolvedFieldsThisTurn,
      inputs.sessionId
    );

    // The original info-log MUST still fire (we are NOT replacing the metric).
    expect(logger.info).toHaveBeenCalledWith(
      'suppressed_refill_question',
      expect.objectContaining({ sessionId: 'session-001' })
    );

    // The new deletion-pending warn MUST fire alongside it.
    const warnCalls = logger.warn.mock.calls.filter(
      (c) => c[0] === 'stage6.suppressed_refill_question_deletion_pending'
    );
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0][1]).toEqual(
      expect.objectContaining({
        sessionId: 'session-001',
        _deletion_target: expect.stringMatching(/T\+4w/i),
      })
    );
  });

  test('second emit on the SAME sessionId does NOT re-fire the deletion-pending warn', () => {
    const inputs = commonInputs('session-001');
    // First call — fires both info and warn.
    filterQuestionsAgainstFilledSlots(
      inputs.questions,
      inputs.stateSnapshot,
      inputs.resolvedFieldsThisTurn,
      inputs.sessionId
    );
    // Second call (same sessionId, different field but same suppression
    // path) — fires info but NOT the deletion-pending warn.
    const inputs2 = commonInputs('session-001', 'r1plusr2', 2);
    filterQuestionsAgainstFilledSlots(
      inputs2.questions,
      inputs2.stateSnapshot,
      inputs2.resolvedFieldsThisTurn,
      inputs2.sessionId
    );

    // info-log fires twice (one per suppression).
    const infoCalls = logger.info.mock.calls.filter((c) => c[0] === 'suppressed_refill_question');
    expect(infoCalls).toHaveLength(2);

    // Deletion-pending warn fires EXACTLY ONCE for the session.
    const warnCalls = logger.warn.mock.calls.filter(
      (c) => c[0] === 'stage6.suppressed_refill_question_deletion_pending'
    );
    expect(warnCalls).toHaveLength(1);
  });

  test('NEW sessionId DOES fire its own deletion-pending warn (per-session one-shot)', () => {
    // Session A — first emit fires the warn.
    const inputsA = commonInputs('session-A');
    filterQuestionsAgainstFilledSlots(
      inputsA.questions,
      inputsA.stateSnapshot,
      inputsA.resolvedFieldsThisTurn,
      inputsA.sessionId
    );
    // Session B (different sessionId) — first emit fires its own warn.
    const inputsB = commonInputs('session-B');
    filterQuestionsAgainstFilledSlots(
      inputsB.questions,
      inputsB.stateSnapshot,
      inputsB.resolvedFieldsThisTurn,
      inputsB.sessionId
    );

    const warnCalls = logger.warn.mock.calls.filter(
      (c) => c[0] === 'stage6.suppressed_refill_question_deletion_pending'
    );
    expect(warnCalls).toHaveLength(2);
    expect(warnCalls.map((c) => c[1].sessionId).sort()).toEqual(['session-A', 'session-B']);
  });
});
