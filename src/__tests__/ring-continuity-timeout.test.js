/**
 * Tests for src/extraction/ring-continuity-timeout.js — the per-turn
 * server-side detector that fires `ask_user` when a partial ring
 * continuity bucket has gone stale.
 *
 * Background — 2026-04-28: ring continuity is the only EICR test
 * family that legitimately spans multiple Flux turns. The agentic
 * prompt's RING CONTINUITY CARRYOVER section delegates the 60-second
 * timeout to the server because Sonnet cannot reliably track elapsed
 * time. Without this detector, a user who says "lives 0.47" then
 * forgets to dictate the other two values would lose the partial fill
 * silently (or worse, would have it picked up by an unrelated turn
 * three minutes later when "neutrals 0.47" arrives).
 */

import {
  RING_FIELDS,
  RING_CONTINUITY_TIMEOUT_MS,
  recordRingContinuityWrite,
  clearRingContinuityState,
  findExpiredPartial,
  buildAskForMissingRingValue,
} from '../extraction/ring-continuity-timeout.js';

const SESSION_ID = 'test-session';

/**
 * Build a minimal session-shaped object. We deliberately don't rely on
 * EICRExtractionSession's full constructor here — the timeout module
 * touches only `ringContinuityState` and `stateSnapshot.circuits`.
 * Decoupling keeps these tests fast and stable across upstream session
 * refactors.
 */
function buildSession(circuits = {}) {
  return {
    sessionId: SESSION_ID,
    stateSnapshot: { circuits },
  };
}

describe('ring-continuity-timeout — exports', () => {
  test('RING_FIELDS lists the three canonical ring continuity field names', () => {
    expect(RING_FIELDS).toEqual(['ring_r1_ohm', 'ring_rn_ohm', 'ring_r2_ohm']);
  });

  test('RING_CONTINUITY_TIMEOUT_MS is 60_000', () => {
    expect(RING_CONTINUITY_TIMEOUT_MS).toBe(60_000);
  });
});

describe('recordRingContinuityWrite + clearRingContinuityState', () => {
  test('first call lazily creates the Map; second call updates', () => {
    const session = buildSession();
    expect(session.ringContinuityState).toBeUndefined();

    recordRingContinuityWrite(session, 5, 1000);
    expect(session.ringContinuityState).toBeInstanceOf(Map);
    expect(session.ringContinuityState.get(5)).toBe(1000);

    recordRingContinuityWrite(session, 5, 2000);
    expect(session.ringContinuityState.get(5)).toBe(2000);
  });

  test('clearRingContinuityState removes a tracked circuit', () => {
    const session = buildSession();
    recordRingContinuityWrite(session, 3, 1000);
    recordRingContinuityWrite(session, 4, 1000);

    clearRingContinuityState(session, 3);
    expect(session.ringContinuityState.has(3)).toBe(false);
    expect(session.ringContinuityState.has(4)).toBe(true);
  });

  test('clearRingContinuityState on never-tracked circuit is a noop', () => {
    const session = buildSession();
    expect(() => clearRingContinuityState(session, 99)).not.toThrow();
  });

  test('passing null/undefined session does not throw', () => {
    expect(() => recordRingContinuityWrite(null, 1)).not.toThrow();
    expect(() => clearRingContinuityState(undefined, 1)).not.toThrow();
  });
});

describe('findExpiredPartial — basic behaviour', () => {
  test('returns null when no circuits are tracked', () => {
    const session = buildSession();
    expect(findExpiredPartial(session)).toBeNull();
  });

  test('full bucket (3 of 3) is pruned and returns null', () => {
    const session = buildSession({
      5: { ring_r1_ohm: '0.47', ring_rn_ohm: '0.47', ring_r2_ohm: '0.74' },
    });
    recordRingContinuityWrite(session, 5, 0);
    // Fast-forward past the timeout window.
    expect(findExpiredPartial(session, RING_CONTINUITY_TIMEOUT_MS + 1000)).toBeNull();
    // Pruned — state cleared as a side effect.
    expect(session.ringContinuityState.has(5)).toBe(false);
  });

  test('empty bucket (0 of 3) is pruned and returns null', () => {
    const session = buildSession({ 5: {} });
    recordRingContinuityWrite(session, 5, 0);
    expect(findExpiredPartial(session, RING_CONTINUITY_TIMEOUT_MS + 1000)).toBeNull();
    expect(session.ringContinuityState.has(5)).toBe(false);
  });

  test('partial fill within the timeout window returns null', () => {
    const session = buildSession({ 5: { ring_r1_ohm: '0.47' } });
    recordRingContinuityWrite(session, 5, 0);
    // 30s later — well within 60s window.
    expect(findExpiredPartial(session, 30_000)).toBeNull();
    // Tracking state preserved.
    expect(session.ringContinuityState.has(5)).toBe(true);
  });

  test('partial fill beyond timeout returns the missing field (1 filled, 2 missing)', () => {
    const session = buildSession({ 5: { ring_r1_ohm: '0.47' } });
    recordRingContinuityWrite(session, 5, 0);
    const result = findExpiredPartial(session, RING_CONTINUITY_TIMEOUT_MS + 1);
    // Canonical order — first missing field is ring_rn_ohm.
    expect(result).toEqual({
      circuit_ref: 5,
      missing_field: 'ring_rn_ohm',
      last_write_ms: 0,
    });
  });

  test('partial fill with 2 of 3 returns the single missing field', () => {
    const session = buildSession({
      5: { ring_r1_ohm: '0.47', ring_r2_ohm: '0.74' },
    });
    recordRingContinuityWrite(session, 5, 0);
    const result = findExpiredPartial(session, RING_CONTINUITY_TIMEOUT_MS + 1);
    expect(result).toEqual({
      circuit_ref: 5,
      missing_field: 'ring_rn_ohm',
      last_write_ms: 0,
    });
  });
});

describe('findExpiredPartial — multiple circuits', () => {
  test('returns the OLDEST partial when several have expired', () => {
    const session = buildSession({
      3: { ring_r1_ohm: '0.40' },
      5: { ring_r1_ohm: '0.47', ring_rn_ohm: '0.47' },
      7: { ring_r1_ohm: '0.55' },
    });
    // Circuit 3 is the oldest write.
    recordRingContinuityWrite(session, 3, 1000);
    recordRingContinuityWrite(session, 5, 5000);
    recordRingContinuityWrite(session, 7, 9000);

    const result = findExpiredPartial(session, 1000 + RING_CONTINUITY_TIMEOUT_MS + 1);
    // Circuit 7's write was 9000ms after the others — still within window
    // at the test time. Circuit 3 has been waiting longest.
    expect(result.circuit_ref).toBe(3);
  });

  test('skips not-yet-expired partials even when older ones exist', () => {
    const session = buildSession({
      3: { ring_r1_ohm: '0.40' },
      5: { ring_r1_ohm: '0.47' },
    });
    recordRingContinuityWrite(session, 3, 0);
    recordRingContinuityWrite(session, 5, 30_000);

    // At t=61_000, circuit 3 is expired (61s old) but circuit 5 is not (31s old).
    const result = findExpiredPartial(session, RING_CONTINUITY_TIMEOUT_MS + 1000);
    expect(result.circuit_ref).toBe(3);
  });
});

describe('findExpiredPartial — schema variants', () => {
  test('handles circuits as an Array<{circuit_ref, ...fields}>', () => {
    const session = {
      sessionId: SESSION_ID,
      stateSnapshot: {
        circuits: [
          { circuit_ref: 5, ring_r1_ohm: '0.47' },
          { circuit_ref: 6, ring_r1_ohm: '0.50', ring_rn_ohm: '0.50', ring_r2_ohm: '0.80' },
        ],
      },
    };
    recordRingContinuityWrite(session, 5, 0);
    recordRingContinuityWrite(session, 6, 0);

    const result = findExpiredPartial(session, RING_CONTINUITY_TIMEOUT_MS + 1);
    // Circuit 6 is full — pruned. Circuit 5 is the partial.
    expect(result?.circuit_ref).toBe(5);
    expect(session.ringContinuityState.has(6)).toBe(false);
  });

  test('handles circuit_ref keyed as string in Object<>', () => {
    const session = {
      sessionId: SESSION_ID,
      stateSnapshot: { circuits: { 5: { ring_r1_ohm: '0.47' } } },
    };
    recordRingContinuityWrite(session, 5, 0);
    const result = findExpiredPartial(session, RING_CONTINUITY_TIMEOUT_MS + 1);
    expect(result?.circuit_ref).toBe(5);
  });

  test('treats empty-string ring values as not filled', () => {
    const session = buildSession({
      5: { ring_r1_ohm: '0.47', ring_rn_ohm: '', ring_r2_ohm: null },
    });
    recordRingContinuityWrite(session, 5, 0);
    const result = findExpiredPartial(session, RING_CONTINUITY_TIMEOUT_MS + 1);
    // ring_r1_ohm is the only one filled; missing field is ring_rn_ohm
    // (canonical order).
    expect(result?.missing_field).toBe('ring_rn_ohm');
  });
});

describe('buildAskForMissingRingValue', () => {
  test('returns the canonical ask_user shape with context_field + context_circuit', () => {
    const ask = buildAskForMissingRingValue(
      { circuit_ref: 5, missing_field: 'ring_r2_ohm' },
      SESSION_ID,
      1234
    );
    expect(ask).toEqual({
      tool_call_id: `srv-ring-${SESSION_ID}-5-1234`,
      question:
        "I seem to have missed a ring continuity value — what's the R2 (earths) for circuit 5?",
      reason: 'missing_value',
      context_field: 'ring_r2_ohm',
      context_circuit: 5,
      expected_answer_shape: 'value',
      server_emitted: true,
    });
  });

  test('field labels read naturally for each ring field', () => {
    const r1 = buildAskForMissingRingValue(
      { circuit_ref: 1, missing_field: 'ring_r1_ohm' },
      SESSION_ID,
      0
    );
    const rn = buildAskForMissingRingValue(
      { circuit_ref: 1, missing_field: 'ring_rn_ohm' },
      SESSION_ID,
      0
    );
    const r2 = buildAskForMissingRingValue(
      { circuit_ref: 1, missing_field: 'ring_r2_ohm' },
      SESSION_ID,
      0
    );
    expect(r1.question).toContain('R1 (lives)');
    expect(rn.question).toContain('Rn (neutrals)');
    expect(r2.question).toContain('R2 (earths)');
  });

  test('synthetic tool_call_id is unique per (circuit, time) pair', () => {
    const a = buildAskForMissingRingValue(
      { circuit_ref: 5, missing_field: 'ring_rn_ohm' },
      SESSION_ID,
      1000
    );
    const b = buildAskForMissingRingValue(
      { circuit_ref: 5, missing_field: 'ring_rn_ohm' },
      SESSION_ID,
      2000
    );
    expect(a.tool_call_id).not.toBe(b.tool_call_id);
  });
});

describe('integration — partial fill, write completes, state clears', () => {
  test('1 → 2 → 3 of 3 progression: state pruned at completion', () => {
    const session = buildSession({ 5: {} });

    // First write — r1 lands.
    session.stateSnapshot.circuits[5].ring_r1_ohm = '0.47';
    recordRingContinuityWrite(session, 5, 1000);
    expect(session.ringContinuityState.has(5)).toBe(true);

    // 30s later — second write, rn lands.
    session.stateSnapshot.circuits[5].ring_rn_ohm = '0.47';
    recordRingContinuityWrite(session, 5, 31_000);

    // 30s later — third write, r2 lands. Bucket complete.
    session.stateSnapshot.circuits[5].ring_r2_ohm = '0.74';
    recordRingContinuityWrite(session, 5, 61_000);

    // Now check at t = 122_000 (> 60s after the last write). The bucket
    // is full, so findExpiredPartial returns null AND prunes the state.
    expect(findExpiredPartial(session, 122_000)).toBeNull();
    expect(session.ringContinuityState.has(5)).toBe(false);
  });
});
