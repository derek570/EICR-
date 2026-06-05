/**
 * Stage 6 Phase 5 Plan 05-02 — filled-slots-shadow unit tests.
 *
 * WHAT: Locks the contract for the side-effect-only adapter that wraps
 * `filterQuestionsAgainstFilledSlots` (the unmodified Stage 5 backstop).
 * The adapter is consumed PRE-WRAPPER by Plan 05-01's gate composer on
 * EVERY ask_user the model emits — its purpose is to log how often the
 * legacy filter WOULD have suppressed an ask on the tool-call path,
 * without actually suppressing. Phase 7 retirement analysis joins these
 * `stage6.filled_slots_would_suppress` rows on (sessionId, tool_call_id)
 * with the dispatcher's `stage6.ask_user` rows to decide whether the
 * legacy filter has any residual signal worth retaining.
 *
 * WHY these tests ARE the gate (RED step of the Plan 05-02 TDD pair):
 *   - STB-03 contract anchor — "filled-slots filter runs in shadow mode
 *     on the tool-call path: logs when it would have suppressed an ask
 *     but does NOT actually suppress". Group 3 locks the would-suppress
 *     emission shape; Group 4 locks the safety contract that shadow
 *     logging never tears down dispatch.
 *   - STB-05 anchor — "no existing guard weakened". The adapter only
 *     IMPORTS filterQuestionsAgainstFilledSlots; it does not mutate it.
 *     The Codex grep target documented in the plan
 *     (`git diff stage6-phase4-base -- src/extraction/filled-slots-filter.js`)
 *     remains empty.
 *   - Pitfall 6 (observation_confirmation bypass) — Group 1 + Group 2
 *     lock that ask_user.reason='observation_confirmation' maps to the
 *     legacy type 'observation_confirmation' (NOT 'unclear'). Since
 *     'observation_confirmation' is NOT in REFILL_QUESTION_TYPES the
 *     filter passes it through regardless of filled state — confirmation
 *     asks must NEVER be flagged as would-suppress.
 *
 * Fake-timer pattern: standard Stage 6 frozen pattern (Decision 03-09).
 * No timers fire in this module under test, but the surrounding test
 * suite relies on the same setup so we mirror it for consistency.
 *
 * REQUIREMENTS covered: STB-03, STB-05.
 */

import { jest } from '@jest/globals';
import {
  createFilledSlotsShadowLogger,
  ASK_REASON_TO_LEGACY_TYPE,
} from '../extraction/stage6-filled-slots-shadow.js';

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'Promise', 'nextTick'] });
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

/**
 * Mirror the real session.stateSnapshot shape that
 * filterQuestionsAgainstFilledSlots reads:
 *   stateSnapshot.circuits = { [circuitNum]: { [field]: value } }
 *
 * Per filled-slots-filter.js:97-128, the filter looks up
 * `circuits[circuit][field]` and treats null/undefined/'' as unfilled.
 */
function makeSession({ circuits = {} } = {}) {
  return { sessionId: 'sess-1', stateSnapshot: { circuits } };
}

function makeCall(
  id,
  { reason = 'ambiguous_circuit', field = 'measured_zs_ohm', circuit = 0 } = {}
) {
  return {
    id,
    name: 'ask_user',
    input: {
      question: 'Q?',
      reason,
      context_field: field,
      context_circuit: circuit,
      expected_answer_shape: 'free_text',
    },
  };
}

function makeCtx() {
  return { sessionId: 'sess-1', turnId: 'sess-1-turn-1' };
}

// ---------------------------------------------------------------------------
// Group 1: ASK_REASON_TO_LEGACY_TYPE mapping table
// ---------------------------------------------------------------------------

describe('ASK_REASON_TO_LEGACY_TYPE — frozen mapping table', () => {
  test('all five documented ask_user reasons map to the expected legacy types', () => {
    expect(ASK_REASON_TO_LEGACY_TYPE).toEqual({
      out_of_range_circuit: 'circuit_disambiguation',
      ambiguous_circuit: 'circuit_disambiguation',
      contradiction: 'unclear',
      missing_context: 'unclear',
      observation_confirmation: 'observation_confirmation',
    });
  });

  test('observation_confirmation maps to "observation_confirmation" (NOT "unclear") — Pitfall 6 anchor', () => {
    // Locks the single most-load-bearing entry. If a future edit
    // accidentally routes confirmations through 'unclear', the legacy
    // filter would suppress them once the slot fills — exactly the
    // regression Pitfall 6 protects against.
    expect(ASK_REASON_TO_LEGACY_TYPE.observation_confirmation).toBe('observation_confirmation');
    expect(ASK_REASON_TO_LEGACY_TYPE.observation_confirmation).not.toBe('unclear');
  });

  test('table is frozen (defensive — table edits should be intentional commits)', () => {
    expect(Object.isFrozen(ASK_REASON_TO_LEGACY_TYPE)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group 2: observation_confirmation bypass invariant
// ---------------------------------------------------------------------------

describe('shadowCheck — observation_confirmation bypass (Pitfall 6)', () => {
  test('observation_confirmation reason with matching filled slot returns wouldHaveSuppressed=false', () => {
    // Real filter: 'observation_confirmation' is NOT in
    // REFILL_QUESTION_TYPES (filled-slots-filter.js:42-46). The filter
    // therefore returns the question unchanged regardless of filled state.
    const logger = makeLogger();
    const session = makeSession({
      circuits: { 0: { measured_zs_ohm: '1.23' } },
    });
    const shadowCheck = createFilledSlotsShadowLogger({
      sessionGetter: () => session,
      logger,
    });
    const result = shadowCheck(
      makeCall('toolu_01', {
        reason: 'observation_confirmation',
        field: 'measured_zs_ohm',
        circuit: 0,
      }),
      makeCtx()
    );
    expect(result).toEqual({
      wouldHaveSuppressed: false,
      legacyType: 'observation_confirmation',
    });
    // The would-suppress log row must NOT have fired.
    const suppressionInfoCalls = logger.info.mock.calls.filter(
      ([event]) => event === 'stage6.filled_slots_would_suppress'
    );
    expect(suppressionInfoCalls).toHaveLength(0);
  });

  test('existingFilter is invoked with type="observation_confirmation" (not "unclear")', () => {
    // Spy on the filter to confirm the translation table doesn't quietly
    // collapse the reason to a refill-style type.
    const logger = makeLogger();
    const session = makeSession({
      circuits: { 0: { measured_zs_ohm: '1.23' } },
    });
    const filterSpy = jest.fn((questions /* , snap, set, sid */) => {
      // Real filter passes through observation_confirmation.
      return questions;
    });
    const shadowCheck = createFilledSlotsShadowLogger({
      sessionGetter: () => session,
      logger,
      existingFilter: filterSpy,
    });
    shadowCheck(
      makeCall('toolu_02', {
        reason: 'observation_confirmation',
        field: 'measured_zs_ohm',
        circuit: 0,
      }),
      makeCtx()
    );
    expect(filterSpy).toHaveBeenCalledTimes(1);
    const passedQuestions = filterSpy.mock.calls[0][0];
    expect(Array.isArray(passedQuestions)).toBe(true);
    expect(passedQuestions[0].type).toBe('observation_confirmation');
    expect(passedQuestions[0].type).not.toBe('unclear');
  });
});

// ---------------------------------------------------------------------------
// Group 3: would-suppress emission
// ---------------------------------------------------------------------------

describe('shadowCheck — would-suppress emission (STB-03)', () => {
  test('out_of_range_circuit + matching filled slot → wouldHaveSuppressed=true, log row emitted', () => {
    const logger = makeLogger();
    const session = makeSession({
      circuits: { 0: { measured_zs_ohm: '1.23' } },
    });
    const shadowCheck = createFilledSlotsShadowLogger({
      sessionGetter: () => session,
      logger,
    });
    const call = makeCall('toolu_03', {
      reason: 'out_of_range_circuit',
      field: 'measured_zs_ohm',
      circuit: 0,
    });
    const ctx = makeCtx();
    const result = shadowCheck(call, ctx);
    expect(result).toEqual({
      wouldHaveSuppressed: true,
      legacyType: 'circuit_disambiguation',
    });
    // Exactly one would-suppress row.
    const suppressionInfoCalls = logger.info.mock.calls.filter(
      ([event]) => event === 'stage6.filled_slots_would_suppress'
    );
    expect(suppressionInfoCalls).toHaveLength(1);
    const [, payload] = suppressionInfoCalls[0];
    expect(payload).toEqual(
      expect.objectContaining({
        sessionId: 'sess-1',
        turnId: 'sess-1-turn-1',
        phase: 5,
        tool_call_id: 'toolu_03',
        context_field: 'measured_zs_ohm',
        context_circuit: 0,
        reason: 'out_of_range_circuit',
        legacy_type_mapped: 'circuit_disambiguation',
      })
    );
    // emittedAt is an ISO string.
    expect(typeof payload.emittedAt).toBe('string');
    expect(payload.emittedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('out_of_range_circuit with EMPTY filled slots → wouldHaveSuppressed=false, no log row', () => {
    const logger = makeLogger();
    const session = makeSession({ circuits: {} });
    const shadowCheck = createFilledSlotsShadowLogger({
      sessionGetter: () => session,
      logger,
    });
    const result = shadowCheck(
      makeCall('toolu_04', {
        reason: 'out_of_range_circuit',
        field: 'measured_zs_ohm',
        circuit: 0,
      }),
      makeCtx()
    );
    expect(result).toEqual({
      wouldHaveSuppressed: false,
      legacyType: 'circuit_disambiguation',
    });
    const suppressionInfoCalls = logger.info.mock.calls.filter(
      ([event]) => event === 'stage6.filled_slots_would_suppress'
    );
    expect(suppressionInfoCalls).toHaveLength(0);
  });

  test('contradiction reason (maps to "unclear") with matching filled slot → wouldHaveSuppressed=true, legacy_type_mapped="unclear"', () => {
    const logger = makeLogger();
    const session = makeSession({
      circuits: { 2: { r1_r2: '0.64' } },
    });
    const shadowCheck = createFilledSlotsShadowLogger({
      sessionGetter: () => session,
      logger,
    });
    const result = shadowCheck(
      makeCall('toolu_05', {
        reason: 'contradiction',
        field: 'r1_r2',
        circuit: 2,
      }),
      makeCtx()
    );
    expect(result.wouldHaveSuppressed).toBe(true);
    expect(result.legacyType).toBe('unclear');
    const suppressionInfoCalls = logger.info.mock.calls.filter(
      ([event]) => event === 'stage6.filled_slots_would_suppress'
    );
    expect(suppressionInfoCalls).toHaveLength(1);
    expect(suppressionInfoCalls[0][1]).toEqual(
      expect.objectContaining({ legacy_type_mapped: 'unclear', reason: 'contradiction' })
    );
  });

  test('unknown reason value → maps to defensive default "unclear"', () => {
    // Defensive: any future addition to ask_user_reason that hasn't been
    // mirrored into ASK_REASON_TO_LEGACY_TYPE falls through as 'unclear'.
    // Better to over-flag (extra shadow row) than under-flag (missed signal).
    const logger = makeLogger();
    const session = makeSession({
      circuits: { 0: { measured_zs_ohm: '1.23' } },
    });
    const shadowCheck = createFilledSlotsShadowLogger({
      sessionGetter: () => session,
      logger,
    });
    const result = shadowCheck(
      makeCall('toolu_06', {
        reason: 'some_future_reason_we_have_not_mapped',
        field: 'measured_zs_ohm',
        circuit: 0,
      }),
      makeCtx()
    );
    expect(result.legacyType).toBe('unclear');
    expect(result.wouldHaveSuppressed).toBe(true);
  });

  test('shadowCheck invoked multiple times per session with different calls — independent results', () => {
    const logger = makeLogger();
    const session = makeSession({
      circuits: { 0: { measured_zs_ohm: '1.23' } },
    });
    const shadowCheck = createFilledSlotsShadowLogger({
      sessionGetter: () => session,
      logger,
    });
    // Call 1 — would suppress.
    const r1 = shadowCheck(
      makeCall('toolu_a', {
        reason: 'out_of_range_circuit',
        field: 'measured_zs_ohm',
        circuit: 0,
      }),
      makeCtx()
    );
    // Call 2 — would NOT suppress (different field, not filled).
    const r2 = shadowCheck(
      makeCall('toolu_b', {
        reason: 'out_of_range_circuit',
        field: 'r1_r2',
        circuit: 0,
      }),
      makeCtx()
    );
    expect(r1.wouldHaveSuppressed).toBe(true);
    expect(r2.wouldHaveSuppressed).toBe(false);
    const suppressionInfoCalls = logger.info.mock.calls.filter(
      ([event]) => event === 'stage6.filled_slots_would_suppress'
    );
    expect(suppressionInfoCalls).toHaveLength(1);
    expect(suppressionInfoCalls[0][1].tool_call_id).toBe('toolu_a');
  });

  test('snapshot immutability — shadowCheck must NEVER mutate session.stateSnapshot', () => {
    const logger = makeLogger();
    const session = makeSession({
      circuits: { 0: { measured_zs_ohm: '1.23' } },
    });
    const before = JSON.stringify(session.stateSnapshot);
    const shadowCheck = createFilledSlotsShadowLogger({
      sessionGetter: () => session,
      logger,
    });
    shadowCheck(
      makeCall('toolu_07', {
        reason: 'out_of_range_circuit',
        field: 'measured_zs_ohm',
        circuit: 0,
      }),
      makeCtx()
    );
    expect(JSON.stringify(session.stateSnapshot)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Group 4: safety — sessionGetter & filter exception handling
// ---------------------------------------------------------------------------

describe('shadowCheck — safety contract (never tear down dispatch)', () => {
  test('sessionGetter returns undefined → wouldHaveSuppressed=false, legacyType=null, warn logged once', () => {
    const logger = makeLogger();
    const shadowCheck = createFilledSlotsShadowLogger({
      sessionGetter: () => undefined,
      logger,
    });
    const result = shadowCheck(
      makeCall('toolu_08', {
        reason: 'out_of_range_circuit',
        field: 'measured_zs_ohm',
        circuit: 0,
      }),
      makeCtx()
    );
    expect(result).toEqual({ wouldHaveSuppressed: false, legacyType: null });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    // No would-suppress info row — it never reached the filter.
    const suppressionInfoCalls = logger.info.mock.calls.filter(
      ([event]) => event === 'stage6.filled_slots_would_suppress'
    );
    expect(suppressionInfoCalls).toHaveLength(0);
  });

  test('sessionGetter throws → caught, wouldHaveSuppressed=false, warn logged, NEVER propagates', () => {
    const logger = makeLogger();
    const shadowCheck = createFilledSlotsShadowLogger({
      sessionGetter: () => {
        throw new Error('boom');
      },
      logger,
    });
    let result;
    expect(() => {
      result = shadowCheck(
        makeCall('toolu_09', {
          reason: 'out_of_range_circuit',
          field: 'measured_zs_ohm',
          circuit: 0,
        }),
        makeCtx()
      );
    }).not.toThrow();
    expect(result).toEqual({ wouldHaveSuppressed: false, legacyType: null });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test('existingFilter throws → caught, wouldHaveSuppressed=false, warn logged, NEVER propagates', () => {
    const logger = makeLogger();
    const session = makeSession({
      circuits: { 0: { measured_zs_ohm: '1.23' } },
    });
    const filterSpy = jest.fn(() => {
      throw new Error('filter boom');
    });
    const shadowCheck = createFilledSlotsShadowLogger({
      sessionGetter: () => session,
      logger,
      existingFilter: filterSpy,
    });
    let result;
    expect(() => {
      result = shadowCheck(
        makeCall('toolu_10', {
          reason: 'out_of_range_circuit',
          field: 'measured_zs_ohm',
          circuit: 0,
        }),
        makeCtx()
      );
    }).not.toThrow();
    expect(result.wouldHaveSuppressed).toBe(false);
    // legacyType is preserved (the mapping is independent of the filter call).
    expect(result.legacyType).toBe('circuit_disambiguation');
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
