/**
 * Stage 6 Phase 5 Plan 05-04 — `logRestrainedMode` unit tests (STA-05 / STO-03).
 *
 * WHAT: Locks the canonical `stage6.restrained_mode` log row shape — emitted
 * by the activeSessions entry's onActivate + onRelease callbacks in
 * sonnet-stream.js when the rolling-5-turn-window state machine flips state.
 *
 * WHY a SEPARATE test file (not extending stage6-dispatcher-logging.test.js):
 * the parent file is owned by recent r-rounds (last touched in Plan 04-26
 * r28, commit 2069605). Adding cases there would clash with concurrent edits
 * in 04-2x and force a merge resolution that hides this plan's changes in a
 * larger diff. A dedicated file co-locates the new helper's contract with
 * its own commit, parallels Plan 02-02's split between logToolCall and
 * logAskUser tests inside one file (which only worked there because both
 * helpers shipped in the same commit window), and keeps the Phase 5 deltas
 * legible to STG.
 *
 * WHY 3 cases (matches plan §Task 3 specification):
 *   1. valid 'activated' event → exact row shape, every field echoed.
 *   2. valid 'released' event → trigger_ask_count default null when omitted.
 *   3. invalid event → throws `invalid_restrained_mode_event:<value>` —
 *      mirrors the closed-enum discipline applied to ASK_USER_ANSWER_OUTCOMES
 *      / ASK_USER_MODES (Phase 3 r19 MINOR remediation). A typo at any
 *      caller would silently corrupt CloudWatch Insights queries that split
 *      logs by `event` if the gate were soft.
 *
 * Requirements: STA-05 (the activation event), STO-03 (this log name —
 * `stage6.restrained_mode_rate` is the dashboard metric derived from these
 * rows in Phase 8).
 */

import { jest } from '@jest/globals';
import { logRestrainedMode } from '../extraction/stage6-dispatcher-logger.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

describe('logRestrainedMode()', () => {
  test('valid `activated` event → emits exactly one logger.info call tagged stage6.restrained_mode with every provided field echoed plus phase:5', () => {
    const logger = mockLogger();
    logRestrainedMode(logger, {
      sessionId: 's1',
      turnId: null,
      event: 'activated',
      triggerAskCount: 3,
      windowTurns: 5,
      releaseMs: 60000,
    });

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      'stage6.restrained_mode',
      expect.objectContaining({
        sessionId: 's1',
        turnId: null,
        phase: 5,
        event: 'activated',
        trigger_ask_count: 3,
        window_turns: 5,
        release_ms: 60000,
      })
    );
    // Sanity: emittedAt is ISO-8601-ish (not asserting exact value — just that
    // it's a string with timezone marker, so Phase 8 timestamp parsers don't
    // need to special-case it).
    const row = logger.info.mock.calls[0][1];
    expect(typeof row.emittedAt).toBe('string');
    expect(row.emittedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('valid `released` event → trigger_ask_count defaults to null when omitted', () => {
    const logger = mockLogger();
    // Release-path calls don't supply triggerAskCount — the count is only
    // meaningful on activation. The helper must emit null (not undefined,
    // not omit the field) so CloudWatch Insights queries can use
    // `filter ispresent(trigger_ask_count)` to isolate activation rows.
    logRestrainedMode(logger, {
      sessionId: 's2',
      turnId: null,
      event: 'released',
      windowTurns: 5,
      releaseMs: 60000,
    });

    expect(logger.info).toHaveBeenCalledTimes(1);
    const row = logger.info.mock.calls[0][1];
    expect(row).toMatchObject({
      sessionId: 's2',
      phase: 5,
      event: 'released',
      trigger_ask_count: null,
      window_turns: 5,
      release_ms: 60000,
    });
  });

  test('invalid event → throws `invalid_restrained_mode_event:<value>` — closed-enum gate', () => {
    const logger = mockLogger();
    expect(() =>
      logRestrainedMode(logger, {
        sessionId: 's3',
        turnId: null,
        event: 'foo',
        windowTurns: 5,
        releaseMs: 60000,
      })
    ).toThrow('invalid_restrained_mode_event:foo');
    // No emit on the failure path — the gate trips BEFORE logger.info.
    expect(logger.info).not.toHaveBeenCalled();
  });
});
