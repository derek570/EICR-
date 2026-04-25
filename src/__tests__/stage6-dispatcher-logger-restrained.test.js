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
 *
 * --------------------------------------------------------------------------
 * Plan 05-05 EXTENSION — Phase 5 observability contract (STO-03 / STB-05).
 *
 * Schema-gate suite (Groups 1-4 below) locks Phase 5's CloudWatch Insights
 * query surface so any future drift in the log-row shapes / closed enums
 * trips a loud test failure rather than silently corrupting Phase 8
 * dashboards. Tests immediately GREEN on first run because the emitters
 * already exist (Phase 3 shipped logAskUser + ASK_USER_ANSWER_OUTCOMES;
 * Plan 05-04 shipped logRestrainedMode + RESTRAINED_MODE_EVENTS).
 *
 * Groups:
 *   1. ASK_USER_ANSWER_OUTCOMES — Object.freeze'd + strict-equality snapshot
 *      of the actual set + Phase 5 reserved-value sub-assertion (gated /
 *      ask_budget_exhausted / restrained_mode).
 *   2. RESTRAINED_MODE_EVENTS — Object.freeze'd + strict-equality lock
 *      ['activated', 'released'].
 *   3. stage6.ask_user row shape — minimal-payload emit asserts the 11
 *      required fields plus phase:3 land verbatim through logAskUser.
 *   4. stage6.restrained_mode row shape — emit-time field set lock for the
 *      Phase 8 dashboard contract (sessionId, turnId, phase:5, event,
 *      trigger_ask_count, window_turns, release_ms, emittedAt).
 *
 * NOTE on freeze: if a freeze assertion trips, the fix is to add
 * `Object.freeze(...)` at the constant declaration in stage6-dispatcher-logger.js
 * — NOT to relax this assertion. The freeze is the structural guarantee that
 * a future r-round cannot mutate the array via `.push(...)` and silently
 * widen the closed enum.
 */

import { jest } from '@jest/globals';
import {
  ASK_USER_ANSWER_OUTCOMES,
  ASK_USER_MODES,
  RESTRAINED_MODE_EVENTS,
  logAskUser,
  logRestrainedMode,
} from '../extraction/stage6-dispatcher-logger.js';

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

// ===========================================================================
// Plan 05-05 — Phase 5 observability contract schema-gate suite (STO-03 / STB-05).
// ===========================================================================

describe('Phase 5 observability contract (Plan 05-05 — STO-03)', () => {
  // -----------------------------------------------------------------------
  // Group 1: ASK_USER_ANSWER_OUTCOMES completeness + freeze.
  //
  // Snapshot captured at Plan 05-05 run-time from
  // src/extraction/stage6-dispatcher-logger.js lines 121-146 (post Plan 04-26
  // Layer 2 prompt-leak addition). The list reflects the ACTUAL contents of
  // the constant — NOT the speculative list in Plan 05-05's <behavior>
  // section, which is now stale (it predicted `session_closed` /
  // `dispatcher_threw`; the actual set has `session_stopped`,
  // `transcript_already_extracted`, `prompt_leak_blocked`). Per Plan 05-05
  // §truths "Executor MUST read [the file] first ... If the actual set
  // differs from the list above, the test asserts the ACTUAL set verbatim".
  //
  // Future drift this trips:
  //   - removing a value (renames, deletions during refactor)
  //   - adding a value WITHOUT updating this test (caller drift)
  //   - mutating the array via .push at runtime (closed-enum violation)
  // -----------------------------------------------------------------------
  describe('Group 1 — ASK_USER_ANSWER_OUTCOMES closed-enum snapshot', () => {
    test("is Object.freeze'd so runtime .push/.pop cannot widen the enum", () => {
      // Structural lock. If this trips, add `Object.freeze(...)` to the
      // constant declaration in stage6-dispatcher-logger.js — DO NOT relax
      // this assertion. The closed-enum discipline depends on freeze: a
      // typo'd caller invariant means a typo'd Phase 8 query.
      expect(Object.isFrozen(ASK_USER_ANSWER_OUTCOMES)).toBe(true);
    });

    test('contains exactly the 17 expected values (strict-equality snapshot — Plan 05-13 r7 split)', () => {
      // Strict equality — order-sensitive. Order is part of the contract
      // because the source file groups values by Phase + remediation round,
      // and rearranging the order signals an intentional refactor that
      // requires reviewer eyeballs on this test.
      //
      // Plan 05-13 r7: the legacy `dispatcher_error` (added Plan 03-12 r10)
      // stays in the enum for back-compat with archived log rows but moves
      // to ambiguous-legacy classification (no active emit site; isRealFire
      // fallthrough = fire). Two NEW lifecycle-keyed values
      // (`dispatcher_error_pre_emit` / `dispatcher_error_post_emit`) appended
      // at the end so the active emission name encodes lifecycle position
      // structurally — closing the r5↔r6 same-name toggle problem.
      expect([...ASK_USER_ANSWER_OUTCOMES]).toEqual([
        // STO-02 original 6 + Phase 5 reserved (rev'd into the original 6 group):
        'answered',
        'timeout',
        'user_moved_on',
        'restrained_mode',
        'ask_budget_exhausted',
        'gated',
        // Phase 3 expansion:
        'shadow_mode',
        'validation_error',
        'session_terminated',
        'session_stopped',
        'session_reconnected',
        'duplicate_tool_call_id',
        // Plan 03-12 r8:
        'transcript_already_extracted',
        // Plan 03-12 r10 (legacy at r7 — back-compat only, no active emit):
        'dispatcher_error',
        // Plan 04-26 Layer 2:
        'prompt_leak_blocked',
        // Plan 05-13 r7 — lifecycle-keyed split of `dispatcher_error`:
        'dispatcher_error_pre_emit',
        'dispatcher_error_post_emit',
      ]);
    });

    test('contains the three Phase 5 reserved values (gated / ask_budget_exhausted / restrained_mode)', () => {
      // Explicit assertion — even if the strict-equality snapshot above
      // were ever loosened (e.g. converted to a "contains all of" check),
      // this guard would still trip on a Phase 5 reserved-value drift.
      // Locks the contract that Plan 05-01 / 05-03 / 05-04 outcome
      // emitters depend on.
      expect(ASK_USER_ANSWER_OUTCOMES).toContain('gated');
      expect(ASK_USER_ANSWER_OUTCOMES).toContain('ask_budget_exhausted');
      expect(ASK_USER_ANSWER_OUTCOMES).toContain('restrained_mode');
    });
  });

  // -----------------------------------------------------------------------
  // Group 2: RESTRAINED_MODE_EVENTS strict-equality snapshot.
  //
  // The constant is already Object.freeze'd at the source (line 268).
  // This group confirms both freeze AND the exact two-value contract
  // ['activated', 'released']. A third event would correctly fail —
  // Plan 05-04 §Group 5 explicitly disallows a destroy() emission.
  // -----------------------------------------------------------------------
  describe('Group 2 — RESTRAINED_MODE_EVENTS closed-enum snapshot', () => {
    test("is Object.freeze'd (already shipped in Plan 05-04)", () => {
      expect(Object.isFrozen(RESTRAINED_MODE_EVENTS)).toBe(true);
    });

    test("equals exactly ['activated', 'released'] (no destroy / expired / unlocked)", () => {
      expect([...RESTRAINED_MODE_EVENTS]).toEqual(['activated', 'released']);
    });
  });

  // -----------------------------------------------------------------------
  // Group 3: stage6.ask_user row shape lock.
  //
  // Phase 8 CloudWatch Insights query contract — `stats percentile(...) by
  // sessionId` over rows where answer_outcome='answered'. Required-field
  // drift would silently make percentile queries return zero rows or NaN.
  //
  // Asserts:
  //   - log name is exactly 'stage6.ask_user' (NOT 'stage6_ask_user' —
  //     the dot-vs-underscore convention split between Phase 2's tool_call
  //     and Phase 3's ask_user is an established quirk; locking it here
  //     prevents an over-eager refactor from "normalising" the names).
  //   - phase: 3 ships unchanged (Phase 5 does NOT bump this — only the
  //     restrained_mode row carries phase: 5).
  //   - all 11 required fields are present with provided values verbatim.
  // -----------------------------------------------------------------------
  describe('Group 3 — stage6.ask_user row shape', () => {
    test('logAskUser emits exactly one stage6.ask_user row with the 11 required fields + phase:3', () => {
      const logger = mockLogger();
      logAskUser(logger, {
        sessionId: 's-grp3',
        turnId: 's-grp3-turn-1',
        mode: 'live',
        tool_call_id: 'toolu_grp3',
        question: 'what is the cable size for circuit 1?',
        reason: 'cable_size_missing',
        context_field: 'cable_size',
        context_circuit: '1',
        answer_outcome: 'answered',
        wait_duration_ms: 4321,
      });

      expect(logger.info).toHaveBeenCalledTimes(1);
      const [name, row] = logger.info.mock.calls[0];
      expect(name).toBe('stage6.ask_user');
      expect(row).toMatchObject({
        sessionId: 's-grp3',
        turnId: 's-grp3-turn-1',
        phase: 3,
        mode: 'live',
        tool_call_id: 'toolu_grp3',
        question: 'what is the cable size for circuit 1?',
        reason: 'cable_size_missing',
        context_field: 'cable_size',
        context_circuit: '1',
        answer_outcome: 'answered',
        wait_duration_ms: 4321,
      });
      // Optional fields (user_text / validation_error / sanitisation /
      // dispatcher_error) MUST be absent when not supplied — Phase 8
      // queries use `filter ispresent(user_text)` as shorthand for "real
      // answer captured", so writing undefined-as-null would corrupt
      // the filter.
      expect(row).not.toHaveProperty('user_text');
      expect(row).not.toHaveProperty('validation_error');
      expect(row).not.toHaveProperty('sanitisation');
      expect(row).not.toHaveProperty('dispatcher_error');
    });

    test('logAskUser accepts every value in ASK_USER_ANSWER_OUTCOMES + every value in ASK_USER_MODES (closed-enum echo)', () => {
      // Round-trip guard: every value the closed enum advertises must
      // pass the helper's gate. If a Phase 8 dashboard query references
      // an outcome string the helper rejects, that's a worse failure
      // mode than just a missing row — the dispatcher's outer catch
      // re-throws and tears down the session.
      for (const outcome of ASK_USER_ANSWER_OUTCOMES) {
        for (const mode of ASK_USER_MODES) {
          const logger = mockLogger();
          expect(() =>
            logAskUser(logger, {
              sessionId: 's-roundtrip',
              turnId: 's-roundtrip-turn-1',
              mode,
              tool_call_id: 'toolu_roundtrip',
              answer_outcome: outcome,
            })
          ).not.toThrow();
          expect(logger.info).toHaveBeenCalledTimes(1);
        }
      }
    });
  });

  // -----------------------------------------------------------------------
  // Group 4: stage6.restrained_mode row shape lock — distinct from the
  // Plan 05-04 cases above which assert the activated/released branches.
  // This case asserts the FULL field set as a single shape contract,
  // mirroring Group 3's discipline. Phase 8 dashboards split on `event`
  // and aggregate on (sessionId, event); a missing field anywhere in this
  // shape would make `count_distinct(sessionId)` return wrong cardinality
  // and silently bias `restrained_mode_rate` toward zero.
  // -----------------------------------------------------------------------
  describe('Group 4 — stage6.restrained_mode row shape', () => {
    test('logRestrainedMode emits the full 8-field row shape required by Phase 8 Insights queries', () => {
      const logger = mockLogger();
      logRestrainedMode(logger, {
        sessionId: 's-grp4',
        turnId: 's-grp4-turn-3',
        event: 'activated',
        triggerAskCount: 3,
        windowTurns: 5,
        releaseMs: 60000,
      });

      expect(logger.info).toHaveBeenCalledTimes(1);
      const [name, row] = logger.info.mock.calls[0];
      expect(name).toBe('stage6.restrained_mode');
      // Exact key set — extra keys would also trip this. Locks the row
      // shape so a future caller cannot quietly add fields that Phase 8
      // queries are unaware of.
      expect(Object.keys(row).sort()).toEqual(
        [
          'emittedAt',
          'event',
          'phase',
          'release_ms',
          'sessionId',
          'trigger_ask_count',
          'turnId',
          'window_turns',
        ].sort()
      );
      expect(row).toMatchObject({
        sessionId: 's-grp4',
        turnId: 's-grp4-turn-3',
        phase: 5,
        event: 'activated',
        trigger_ask_count: 3,
        window_turns: 5,
        release_ms: 60000,
      });
      // emittedAt is ISO-8601 with timezone — Phase 8 timestamp parsers
      // assume Date.parse() succeeds. Tighten the regex from the Plan
      // 05-04 case to require the trailing Z (UTC) which Date#toISOString
      // always emits.
      expect(row.emittedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });
});
