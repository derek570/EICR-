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
import {
  logToolCall,
  logAskUser,
  ASK_USER_ANSWER_OUTCOMES,
} from '../extraction/stage6-dispatcher-logger.js';

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

/**
 * Stage 6 Phase 3 Plan 03-03 — logAskUser() unit tests.
 *
 * WHAT: Locks the canonical `stage6.ask_user` log row shape per STO-02 + Phase 3
 * enum expansion (6 → 12 `answer_outcome` values). Distinct log name from
 * `stage6_tool_call` keeps the CloudWatch query plane clean for the Phase 8
 * analyzer (STO-04) and the Phase 7 over-ask gate (STR-04).
 *
 * WHY the enum is 12 values (not STO-02's 6): Phase 3 resolves ROADMAP Open
 * Question #1 by adding `shadow_mode`, `validation_error`, and the three
 * session-termination reasons (`session_terminated`, `session_stopped`,
 * `session_reconnected`) plus `duplicate_tool_call_id` (Pitfall 7 guard).
 * This is expansion-for-completeness, ratified in Phase 3 REVIEW.md per STG-05.
 *
 * WHY truncation lives in the logger (and NOT in the dispatcher caller):
 * Unlike `input_summary` (which is a structured dict and whose PII is a caller
 * contract), `question` is always a raw user-facing sentence. A single place
 * to cap length prevents CloudWatch row-size blow-up; callers should not need
 * to know the cap. The TODO comment flags that Phase 8 STR-05 will add
 * retention-based redaction for `user_text` at the analyzer query layer, not
 * here.
 */

function validAskPayload(overrides = {}) {
  return {
    sessionId: 's1',
    turnId: 't1',
    tool_call_id: 'tu_ask_1',
    question: 'What is the Ze reading?',
    reason: 'ambiguous_reading',
    context_field: 'Ze_ohms',
    context_circuit: 3,
    answer_outcome: 'answered',
    wait_duration_ms: 1234,
    user_text: 'zero point three five',
    mode: 'live',
    ...overrides,
  };
}

describe('logAskUser()', () => {
  test('happy path: full valid payload → logger.info called once with stage6.ask_user tag and full shape', () => {
    const logger = mockLogger();
    logAskUser(logger, validAskPayload());
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      'stage6.ask_user',
      expect.objectContaining({
        sessionId: 's1',
        turnId: 't1',
        phase: 3,
        mode: 'live',
        tool_call_id: 'tu_ask_1',
        question: 'What is the Ze reading?',
        reason: 'ambiguous_reading',
        context_field: 'Ze_ohms',
        context_circuit: 3,
        answer_outcome: 'answered',
        wait_duration_ms: 1234,
        user_text: 'zero point three five',
      }),
    );
  });

  test('happy path: answer_outcome=timeout with user_text absent → row omits user_text key', () => {
    const logger = mockLogger();
    const { user_text: _omitted, ...payload } = validAskPayload({ answer_outcome: 'timeout' });
    logAskUser(logger, payload);
    const row = logger.info.mock.calls[0][1];
    expect(row.answer_outcome).toBe('timeout');
    expect('user_text' in row).toBe(false);
  });

  test('happy path: answer_outcome=validation_error carries validation_error field', () => {
    const logger = mockLogger();
    logAskUser(
      logger,
      validAskPayload({ answer_outcome: 'validation_error', validation_error: 'invalid_question' }),
    );
    const row = logger.info.mock.calls[0][1];
    expect(row.answer_outcome).toBe('validation_error');
    expect(row.validation_error).toBe('invalid_question');
  });

  test('happy path: answer_outcome=shadow_mode with mode=shadow and wait_duration_ms=0', () => {
    const logger = mockLogger();
    logAskUser(
      logger,
      validAskPayload({ answer_outcome: 'shadow_mode', mode: 'shadow', wait_duration_ms: 0 }),
    );
    const row = logger.info.mock.calls[0][1];
    expect(row.answer_outcome).toBe('shadow_mode');
    expect(row.mode).toBe('shadow');
    expect(row.wait_duration_ms).toBe(0);
  });

  test('truncation: question length 200 emitted verbatim (no marker)', () => {
    const logger = mockLogger();
    const q = 'a'.repeat(200);
    logAskUser(logger, validAskPayload({ question: q }));
    const row = logger.info.mock.calls[0][1];
    expect(row.question).toBe(q);
    expect(row.question.length).toBe(200);
    expect(row.question.endsWith('…')).toBe(false);
  });

  test('truncation: question length 250 emitted as first 199 chars + "…" (total 200)', () => {
    const logger = mockLogger();
    const q = 'b'.repeat(250);
    logAskUser(logger, validAskPayload({ question: q }));
    const row = logger.info.mock.calls[0][1];
    expect(row.question.length).toBe(200);
    expect(row.question.endsWith('…')).toBe(true);
    expect(row.question.slice(0, 199)).toBe('b'.repeat(199));
  });

  test('enum enforcement: unknown answer_outcome → throws invalid_answer_outcome', () => {
    const logger = mockLogger();
    expect(() =>
      logAskUser(logger, validAskPayload({ answer_outcome: 'bogus_value' })),
    ).toThrow(/invalid_answer_outcome/);
    expect(logger.info).not.toHaveBeenCalled();
  });

  test('enum enforcement: missing answer_outcome → throws missing_required_field:answer_outcome', () => {
    const logger = mockLogger();
    const { answer_outcome: _omitted, ...payload } = validAskPayload();
    expect(() => logAskUser(logger, payload)).toThrow(/missing_required_field:answer_outcome/);
    expect(logger.info).not.toHaveBeenCalled();
  });

  test('enum enforcement: missing sessionId → throws missing_required_field:sessionId', () => {
    const logger = mockLogger();
    const { sessionId: _omitted, ...payload } = validAskPayload();
    expect(() => logAskUser(logger, payload)).toThrow(/missing_required_field:sessionId/);
    expect(logger.info).not.toHaveBeenCalled();
  });

  test('defaults: wait_duration_ms absent → emitted as 0', () => {
    const logger = mockLogger();
    const { wait_duration_ms: _omitted, ...payload } = validAskPayload();
    logAskUser(logger, payload);
    const row = logger.info.mock.calls[0][1];
    expect(row.wait_duration_ms).toBe(0);
  });

  test('defaults: mode absent → throws (required field)', () => {
    const logger = mockLogger();
    const { mode: _omitted, ...payload } = validAskPayload();
    expect(() => logAskUser(logger, payload)).toThrow(/missing_required_field:mode/);
    expect(logger.info).not.toHaveBeenCalled();
  });

  test('phase tag: every emitted payload includes phase:3 unconditionally', () => {
    const logger = mockLogger();
    logAskUser(logger, validAskPayload({ answer_outcome: 'user_moved_on' }));
    logAskUser(logger, validAskPayload({ answer_outcome: 'gated', mode: 'shadow' }));
    expect(logger.info.mock.calls.every((call) => call[1].phase === 3)).toBe(true);
  });

  test('null context_field and null context_circuit preserved in payload', () => {
    const logger = mockLogger();
    logAskUser(
      logger,
      validAskPayload({ context_field: null, context_circuit: null }),
    );
    const row = logger.info.mock.calls[0][1];
    expect(row.context_field).toBeNull();
    expect(row.context_circuit).toBeNull();
  });

  test('ASK_USER_ANSWER_OUTCOMES exports all 14 Phase 3 values (r10 added dispatcher_error)', () => {
    expect(ASK_USER_ANSWER_OUTCOMES).toEqual([
      'answered',
      'timeout',
      'user_moved_on',
      'restrained_mode',
      'ask_budget_exhausted',
      'gated',
      'shadow_mode',
      'validation_error',
      'session_terminated',
      'session_stopped',
      'session_reconnected',
      'duplicate_tool_call_id',
      // Plan 03-12 r8 BLOCK remediation: reverse-race reason must be a
      // recognised answer_outcome so dispatchAskUser's log call doesn't
      // throw invalid_answer_outcome on the reverse-race path.
      'transcript_already_extracted',
      // Plan 03-12 r10 MAJOR remediation: outer try/catch in dispatchAskUser
      // emits this when the live-path Promise setup/await throws unexpectedly.
      'dispatcher_error',
    ]);
  });

  // Plan 03-10 Task 2 — sanitisation sub-object threaded through logAskUser.
  // Kept narrow: the logger is still a dumb shape gate. When the caller
  // provides a sanitisation object (because Task 2 stripped / truncated the
  // user_text) the row must carry it verbatim so Phase 8 analysis can tell
  // sanitised-down-from-oversized answers apart from first-shot clean ones.
  // When the caller OMITS sanitisation (common case — clean user_text) the
  // row must NOT carry a sanitisation:null property; omission is cheaper in
  // CloudWatch than an explicit null across ~100 rows per session.
  test('sanitisation sub-object present when caller provides it', () => {
    const logger = mockLogger();
    logAskUser(
      logger,
      validAskPayload({
        sanitisation: { truncated: true, stripped: false },
      }),
    );
    const row = logger.info.mock.calls[0][1];
    expect(row.sanitisation).toEqual({ truncated: true, stripped: false });
  });

  test('sanitisation absent when caller omits it (common clean-path case)', () => {
    const logger = mockLogger();
    logAskUser(logger, validAskPayload());
    const row = logger.info.mock.calls[0][1];
    expect('sanitisation' in row).toBe(false);
  });
});
