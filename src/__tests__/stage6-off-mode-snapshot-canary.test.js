/**
 * Stage 6 Phase 4 Plan 04-14 r8-#2 — PERMANENT OFF-MODE CANARY.
 *
 * This is a STANDING regression guard, not a one-off finding lock.
 *
 * History of off-mode regressions from remediations:
 *   - Plan 04-08 r2 added ASKED QUESTIONS + EXTRACTED OBSERVATIONS
 *     digests to buildStateSnapshotMessage unconditionally. Codex
 *     r4 caught the leak — off-mode emitted duplicates. Plan 04-10
 *     r4-#1 gated them behind `this.toolCallsMode !== 'off'`.
 *   - Plan 04-13 r7 added SNAPSHOT_TRUST_BOUNDARY_PREAMBLE + USER_TEXT
 *     marker wraps unconditionally. Codex r8 caught the leak — off-mode
 *     snapshot no longer byte-identical to pre-Phase-4. Plan 04-14
 *     r8-#2 gated them.
 *
 * Pattern: every time a non-off-only feature is added to
 * `buildStateSnapshotMessage`, forgetting the mode gate leaks it to
 * off-mode and breaks SC #7 (off-mode byte-identical rollback).
 *
 * This canary pins off-mode `buildStateSnapshotMessage` output
 * BYTE-FOR-BYTE against a fixed input pair. Any future non-off-only
 * addition that forgets the gate fails THIS test with a clear diff
 * showing the leaked content.
 *
 * The canary is deliberately SMALL (one schedule + one observation +
 * one circuit with a string field + one pending reading) — not a
 * reproduction of every snapshot shape, just enough to exercise every
 * surface that has historically been at risk.
 *
 * IMPORTANT FOR FUTURE EDITORS:
 *   If you're adding a feature to buildStateSnapshotMessage that should
 *   apply in off-mode too (e.g. tightening a safety sanitiser like the
 *   r7 C0-strip did), you MUST update the frozen expected strings below
 *   accordingly. That's deliberate — the test forces you to
 *   acknowledge the change applies to off-mode.
 *
 *   If you're adding a NON-off-only feature (new framing, new digest
 *   section, new diagnostic), gate it behind
 *   `this.toolCallsMode !== 'off'` and the canary will pass unchanged.
 *
 * Three tests:
 *   r8-2a (PERMANENT CANARY — byte-identical) — off-mode snapshot with
 *        Input A matches frozen expected string EXACTLY.
 *   r8-2b (PERMANENT CANARY — null snapshot) — off-mode snapshot with
 *        Input B (empty session) returns null.
 *   r8-2c (compare-and-contrast) — off-mode snapshot is clean of
 *        framing; non-off snapshot on the SAME input carries framing.
 */

import { jest } from '@jest/globals';

const mockCreate = jest.fn();

jest.unstable_mockModule('@anthropic-ai/sdk', () => ({
  default: jest.fn(() => ({
    messages: { create: mockCreate },
  })),
}));

const { EICRExtractionSession } = await import('../extraction/eicr-extraction-session.js');

/**
 * Input A — minimal but exercises every user-derived surface the
 * snapshot can emit:
 *   - circuitSchedule (OCR-derived text)
 *   - a circuit with both numeric and string-typed fields
 *   - an observation (from updateStateSnapshot)
 *   - a pending reading (user-derived value + unit)
 *
 * Kept tiny so the canary's expected string stays readable and diff-
 * friendly. Bigger surfaces would inflate the expected string without
 * testing anything the smaller form misses.
 */
function seedInputA(session) {
  session.circuitSchedule = 'Circuit 1: kitchen sockets [Ring, 32A]';
  session.stateSnapshot.circuits[1] = {
    circuit_designation: 'kitchen sockets',
    measured_zs_ohm: 0.35,
  };
  session.recentCircuitOrder = [1];
  session.stateSnapshot.observations = ['loose neutral in kitchen'];
  session.stateSnapshot.pending_readings = [
    { field: 'zs', value: '1.23', unit: 'ohm' },
  ];
}

describe('Plan 04-14 r8-#2 — off-mode snapshot PERMANENT CANARY (byte-identical regression guard)', () => {
  beforeEach(() => mockCreate.mockReset());

  test('r8-2a PERMANENT CANARY — off-mode buildStateSnapshotMessage with Input A matches frozen expected string byte-for-byte', () => {
    // The off-mode snapshot shape MUST stay byte-identical to
    // pre-Phase-4 for SC #7 (STR-01 rollback). This test pins it.
    // If you're modifying buildStateSnapshotMessage and this fails:
    //   - Off-mode-visible change? Update the expected string below
    //     and explain why in the commit message.
    //   - Non-off-only change? Gate it behind `this.toolCallsMode !== 'off'`
    //     and the test will pass unchanged.
    const session = new EICRExtractionSession('k', 'canary-A', 'eicr', {
      toolCallsMode: 'off',
    });
    seedInputA(session);
    const actual = session.buildStateSnapshotMessage();

    // Frozen expected output. This is the PRE-r7 / POST-r8 off-mode
    // shape — NO preamble, NO USER_TEXT markers around any surface.
    // `sanitiseSnapshotField` still runs (C0-strip + length-cap is a
    // safety fix, not a shape change) — so if raw content had
    // contained NUL etc., it'd be stripped before landing here. The
    // canary inputs are all clean, so there's no visible difference.
    //
    // Newlines and spacing are significant. Use \n explicitly.
    const expected = [
      'CIRCUIT SCHEDULE (confirmed values — do NOT question these):',
      'Circuit 1: kitchen sockets [Ring, 32A]',
      '',
      'EXTRACTED (field IDs per system prompt — do NOT re-emit identical values, but DO output corrections with DIFFERENT values):',
      '1:{"1":"kitchen sockets","measured_zs_ohm":0.35}',
      'pending:[{"field":"zs","value":"1.23","unit":"ohm"}]',
      '',
      'OBSERVATIONS ALREADY RECORDED (1 total, do NOT re-extract):',
      '1. loose neutral in kitchen',
    ].join('\n');

    expect(actual).toBe(expected);
  });

  test('r8-2b PERMANENT CANARY — off-mode buildStateSnapshotMessage with empty session returns null', () => {
    // The null-gate invariant — no user content on any surface → null
    // return → upstream buildMessageWindow emits NO snapshot pair at
    // all, not an orphan preamble. Before r4 (off-mode) and post-r8
    // off-mode gate: null. Pinning this prevents a future widening
    // of the null-gate criteria from silently changing off-mode.
    const session = new EICRExtractionSession('k', 'canary-B', 'eicr', {
      toolCallsMode: 'off',
    });
    expect(session.buildStateSnapshotMessage()).toBeNull();
  });

  test('r8-2c compare-and-contrast — off-mode snapshot is FREE of framing; non-off snapshot on SAME input CARRIES framing', () => {
    // The single most-actionable regression lens: given the SAME user
    // content, off-mode output must NOT contain the framing surfaces,
    // non-off output MUST contain them. If any framing token appears
    // in off-mode, the gate has been breached.
    const offSession = new EICRExtractionSession('k', 'canary-C-off', 'eicr', {
      toolCallsMode: 'off',
    });
    const shadowSession = new EICRExtractionSession('k', 'canary-C-shadow', 'eicr', {
      toolCallsMode: 'shadow',
    });
    seedInputA(offSession);
    seedInputA(shadowSession);

    const offSnapshot = offSession.buildStateSnapshotMessage();
    const shadowSnapshot = shadowSession.buildStateSnapshotMessage();

    // OFF-MODE INVARIANT — no framing leaks.
    expect(offSnapshot).not.toContain('SNAPSHOT TRUST BOUNDARY');
    expect(offSnapshot).not.toContain('<<<USER_TEXT>>>');
    expect(offSnapshot).not.toContain('<<<END_USER_TEXT>>>');

    // NON-OFF INVARIANT — framing present on every user-derived
    // surface. If either of these flips to missing, non-off security
    // regressed.
    expect(shadowSnapshot).toContain('SNAPSHOT TRUST BOUNDARY');
    expect(shadowSnapshot).toContain('<<<USER_TEXT>>>');
    expect(shadowSnapshot).toContain('<<<END_USER_TEXT>>>');
  });
});
