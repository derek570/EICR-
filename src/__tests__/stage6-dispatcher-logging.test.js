/**
 * Stage 6 Phase 2 Plan 02-02 — logToolCall() unit tests.
 *
 * WHAT: Locks the canonical stage6_tool_call log row shape per research §Q9
 * and STD-11 / STO-01. The logger is deliberately thin — it is a shape gate,
 * not a policy layer. PII discipline (omit raw transcripts from input_summary)
 * is enforced by the CALLERS (dispatchers in Plans 02-03/04), not by this
 * helper. We test that contract explicitly so a future refactor that tries to
 * add "defensive redaction" inside the logger is caught in review.
 *
 * WHY this exists as a dedicated module (not inlined in dispatchers): Plans
 * 02-03 + 02-04 implement six dispatchers across two sibling files. Logging
 * shape MUST be identical across all six — otherwise the Phase 7 analyzer's
 * tool-call histogram has to special-case parsing. Single source of truth.
 */

import { jest } from '@jest/globals';
import { logToolCall } from '../extraction/stage6-dispatcher-logger.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

describe('logToolCall()', () => {
  test('emits exactly one logger.info call tagged stage6_tool_call with every provided field echoed plus phase:2', () => {
    const logger = mockLogger();
    logToolCall(logger, {
      sessionId: 's1',
      turnId: 't1',
      tool_use_id: 'tu_123',
      tool: 'record_reading',
      round: 1,
      is_error: false,
      outcome: 'ok',
      validation_error: null,
      input_summary: { field: 'Ze_ohms', circuit: 3 },
    });

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      'stage6_tool_call',
      expect.objectContaining({
        sessionId: 's1',
        turnId: 't1',
        tool_use_id: 'tu_123',
        tool: 'record_reading',
        round: 1,
        phase: 2,
        is_error: false,
        outcome: 'ok',
        validation_error: null,
        input_summary: { field: 'Ze_ohms', circuit: 3 },
      }),
    );
  });

  test('defaults: is_error=false, validation_error=null, input_summary={} when omitted', () => {
    const logger = mockLogger();
    logToolCall(logger, {
      sessionId: 's1',
      turnId: 't1',
      tool_use_id: 'tu_1',
      tool: 'record_reading',
      round: 1,
      outcome: 'ok',
    });
    const row = logger.info.mock.calls[0][1];
    expect(row.is_error).toBe(false);
    expect(row.validation_error).toBeNull();
    expect(row.input_summary).toEqual({});
  });

  test('rejection row: validation_error populated, is_error=true explicitly supplied by caller', () => {
    const logger = mockLogger();
    logToolCall(logger, {
      sessionId: 's1',
      turnId: 't1',
      tool_use_id: 'tu_2',
      tool: 'record_reading',
      round: 1,
      is_error: true,
      outcome: 'rejected',
      validation_error: { code: 'circuit_not_found', field: 'circuit' },
      input_summary: { field: 'Ze_ohms', circuit: 99 },
    });
    const row = logger.info.mock.calls[0][1];
    expect(row.is_error).toBe(true);
    expect(row.outcome).toBe('rejected');
    expect(row.validation_error).toEqual({ code: 'circuit_not_found', field: 'circuit' });
  });

  test('contract: logger does NOT infer is_error from outcome — callers must pass it explicitly (no magic coupling)', () => {
    // If the caller accidentally says outcome:'rejected' but is_error:false, the logger must
    // NOT silently override. That is a caller bug we want to see in review, not a hidden fixup.
    const logger = mockLogger();
    logToolCall(logger, {
      sessionId: 's1', turnId: 't1', tool_use_id: 'tu_3',
      tool: 'record_reading', round: 1,
      is_error: false, outcome: 'rejected',
      validation_error: { code: 'circuit_not_found' },
    });
    const row = logger.info.mock.calls[0][1];
    expect(row.is_error).toBe(false); // passed through, not auto-escalated
    expect(row.outcome).toBe('rejected');
  });

  test('PII guard (caller contract): logger passes input_summary through verbatim — redaction is the DISPATCHER\'s job', () => {
    // This test locks the design decision that PII discipline lives at the call site.
    // If a future dev adds redaction inside logToolCall(), this test fails and forces a review.
    const logger = mockLogger();
    const summary = { field: 'Ze_ohms', circuit: 3, raw_text: 'derek said 0.35 ohms' };
    logToolCall(logger, {
      sessionId: 's1', turnId: 't1', tool_use_id: 'tu_4',
      tool: 'record_reading', round: 1,
      is_error: false, outcome: 'ok',
      validation_error: null,
      input_summary: summary,
    });
    const row = logger.info.mock.calls[0][1];
    // The logger does NOT strip raw_text — callers must not have put it there in the first place.
    expect(row.input_summary).toEqual(summary);
  });
});
