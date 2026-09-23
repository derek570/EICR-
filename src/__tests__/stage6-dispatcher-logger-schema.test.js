/**
 * Stage 6 dispatcher-logger schema locks (Plan 05-05 observability contract,
 * STO-03 / STB-05).
 *
 * Locks the CloudWatch Insights query surface so any future drift in the
 * log-row shapes / closed enums trips a loud test failure rather than
 * silently corrupting Phase 8 dashboards.
 *
 * Groups:
 *   1. ASK_USER_ANSWER_OUTCOMES — Object.freeze'd + strict-equality snapshot.
 *   3. stage6.ask_user row shape — minimal-payload emit asserts the 11
 *      required fields plus phase:3 land verbatim through logAskUser.
 *   5. stage6_reading_field_guessed_from_value row shape.
 *
 * This file was `stage6-dispatcher-logger-restrained.test.js`. PLAN-B
 * (feedback-2026-09-17, Decision 3) deleted restrained mode and the ask
 * budget, so the `logRestrainedMode` cases and Groups 2 and 4
 * (RESTRAINED_MODE_EVENTS and the `stage6.restrained_mode` row) went with
 * them. The remaining groups keep their numbers so history stays greppable.
 *
 * NOTE on freeze: if a freeze assertion trips, the fix is to add
 * `Object.freeze(...)` at the constant declaration in stage6-dispatcher-logger.js
 * — NOT to relax this assertion.
 */

import { jest } from '@jest/globals';
import {
  ASK_USER_ANSWER_OUTCOMES,
  ASK_USER_MODES,
  logAskUser,
  logReadingFieldGuessedFromValue,
} from '../extraction/stage6-dispatcher-logger.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

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

    test('contains exactly the 14 expected values (strict-equality snapshot)', () => {
      // Strict equality — order-sensitive. Order is part of the contract
      // because the source file groups values by Phase + remediation round,
      // and rearranging the order signals an intentional refactor that
      // requires reviewer eyeballs on this test.
      //
      // Plan 05-14 r8-#2 REVERTS Plan 05-13 r7's lifecycle-keyed split.
      // r7 introduced a BREAKING wire-schema change — the active emit
      // site at stage6-dispatcher-ask.js:341 was renamed from
      // `'dispatcher_error'` to `'dispatcher_error_pre_emit'`, and two
      // new enum values were appended (`_pre_emit`, `_post_emit`).
      // Downstream consumers (CloudWatch Insights queries, future
      // analyzer expansions) filtering on `answer_outcome =
      // 'dispatcher_error'` would silently match nothing post-r7. r8-#2
      // restores the wire-schema name as the single canonical value and
      // layers lifecycle position as a SEPARATE optional log-row field
      // (additive, no break — same idiom as r10's `dispatcher_error`
      // diagnostic field).
      //
      // The legacy `dispatcher_error` (added Plan 03-12 r10) is the
      // active emit site post-r8 — preserved verbatim from Plan 03-12
      // r10 through r6, then renamed at r7, then reverted at r8.
      expect([...ASK_USER_ANSWER_OUTCOMES]).toEqual([
        // STO-02 original values (PLAN-B removed restrained_mode and
        // ask_budget_exhausted with their mechanisms):
        'answered',
        'timeout',
        'user_moved_on',
        'gated',
        // PLAN-B (feedback-2026-09-17) — the AFDD chain guard's own reason:
        'afdd_flow_violation',
        // Phase 3 expansion:
        'shadow_mode',
        'validation_error',
        'session_terminated',
        'session_stopped',
        'session_reconnected',
        'duplicate_tool_call_id',
        // Plan 03-12 r8:
        'transcript_already_extracted',
        // Plan 03-12 r10 — single canonical value (active emit site).
        // r7's lifecycle-keyed split was reverted at r8-#2 to preserve
        // the wire schema; lifecycle is now carried as an optional
        // separate field at the log-row layer.
        'dispatcher_error',
        // Plan 04-26 Layer 2:
        'prompt_leak_blocked',
      ]);
    });

    test('PLAN-B: the retired budget / restrained-mode outcomes are gone and afdd_flow_violation is present', () => {
      expect(ASK_USER_ANSWER_OUTCOMES).toContain('gated');
      expect(ASK_USER_ANSWER_OUTCOMES).toContain('afdd_flow_violation');
      expect(ASK_USER_ANSWER_OUTCOMES).not.toContain('ask_budget_exhausted');
      expect(ASK_USER_ANSWER_OUTCOMES).not.toContain('restrained_mode');
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
  //     retired restrained_mode row ever carried phase: 5).
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

    test('Plan 05-14 r8-#2: lifecycle field forwarded when caller provides it; omitted when undefined', () => {
      // r8-#2 closure lock. Layered the lifecycle position as an
      // optional pass-through metadata field at the log-row level so
      // downstream analyzer queries can split on lifecycle without
      // breaking the closed-enum wire schema. Same idiom as r10's
      // `dispatcher_error` diagnostic field, r19's `validation_error`
      // sub-object, and Plan 03-10 Task 2's `sanitisation` sub-object —
      // all optional pass-throughs that surface in the row only when
      // the caller provides them.
      //
      // Phase 8 dashboards split on `lifecycle` would otherwise need
      // to read `answer_outcome` AND infer lifecycle position from
      // surrounding context (which is exactly the r5↔r6 toggle
      // problem r7 was trying to fix). The separate field carries the
      // audit conclusion as a first-class metadata attribute without
      // disturbing the closed-enum wire schema.
      //
      // Present-case: caller provides lifecycle:'pre_emit' → row carries
      // lifecycle:'pre_emit'. The dispatcher's outer catch at
      // stage6-dispatcher-ask.js line 361 emits with this lifecycle value
      // post-r8-#2.
      const presentLogger = mockLogger();
      logAskUser(presentLogger, {
        sessionId: 's-r8-2-present',
        turnId: 's-r8-2-present-turn-1',
        mode: 'live',
        tool_call_id: 'toolu_lifecycle_present',
        answer_outcome: 'dispatcher_error',
        lifecycle: 'pre_emit',
      });
      const presentRow = presentLogger.info.mock.calls[0][1];
      expect(presentRow.lifecycle).toBe('pre_emit');

      // Omission-case: caller does NOT provide lifecycle → row MUST NOT
      // carry a `lifecycle:undefined` (or any null sentinel). Phase 8
      // queries use `filter ispresent(lifecycle)` as shorthand for
      // "row carries explicit lifecycle metadata"; a null fallback
      // would corrupt that filter.
      const omittedLogger = mockLogger();
      logAskUser(omittedLogger, {
        sessionId: 's-r8-2-omitted',
        turnId: 's-r8-2-omitted-turn-1',
        mode: 'live',
        tool_call_id: 'toolu_lifecycle_omitted',
        answer_outcome: 'answered',
      });
      const omittedRow = omittedLogger.info.mock.calls[0][1];
      expect(omittedRow).not.toHaveProperty('lifecycle');
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

  describe('Group 5 — stage6_reading_field_guessed_from_value row shape', () => {
    test('logReadingFieldGuessedFromValue emits the full 7-field row shape required by Phase 8 Insights queries', () => {
      const logger = mockLogger();
      logReadingFieldGuessedFromValue(logger, {
        sessionId: 's-grp5',
        field: 'r1_r2_ohm',
        circuit: 4,
        value: '0.6',
        transcript_preview: 'upstairs sockets number 0.6',
      });

      expect(logger.info).toHaveBeenCalledTimes(1);
      const [name, row] = logger.info.mock.calls[0];
      expect(name).toBe('stage6_reading_field_guessed_from_value');
      expect(Object.keys(row).sort()).toEqual(
        [
          'circuit',
          'emittedAt',
          'field',
          'phase',
          'sessionId',
          'transcript_preview',
          'value',
        ].sort()
      );
      expect(row).toMatchObject({
        sessionId: 's-grp5',
        field: 'r1_r2_ohm',
        circuit: 4,
        value: '0.6',
        transcript_preview: 'upstairs sockets number 0.6',
        phase: 6,
      });
      expect(row.emittedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });
});
