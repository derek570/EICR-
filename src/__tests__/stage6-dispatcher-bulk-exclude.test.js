/**
 * PLAN-backend-final.md Phase 8.5 — dispatcher tests for
 * exclude_circuits on set_field_for_all_circuits.
 *
 * excluded_count semantics (Phase 8.2): count of inspector intent
 * (deduped validated input), INDEPENDENT of scope. applied_count
 * is the post-exclude post-scope total; skipped_count continues to
 * count scope-rule drops only.
 *
 * Schema tests live in stage6-tool-schemas-board.test.js / -circuit
 * tests; the prompt regression for the few-shot wording lives in
 * stage6-agentic-prompt.test.js. This file owns the dispatcher
 * contract only.
 */

import { jest } from '@jest/globals';
import { dispatchSetFieldForAllCircuits } from '../extraction/stage6-dispatchers-circuit.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function buildSnapshot(circuitMap = {}) {
  // The dispatcher uses flag-aware bucket lookup; under flag-off the
  // legacy numeric-key namespace is used. Both shapes are supported
  // simultaneously to make these tests robust against flag flips.
  const buckets = {};
  for (const [ref, fields] of Object.entries(circuitMap)) {
    buckets[String(ref)] = { ...fields };
  }
  return { circuits: buckets, boards: [{ id: 'main', is_current: true }] };
}

function makeSession(snapshot) {
  return { sessionId: 's_bulk_exclude', stateSnapshot: snapshot };
}

function makeCall(input) {
  return { tool_call_id: 'tu_bulk', name: 'set_field_for_all_circuits', input };
}

function parseEnvelope(envelope) {
  const body = JSON.parse(envelope.content);
  return body;
}

const ELEVEN_CIRCUITS_NO_SPARE = {
  1: { circuit_designation: 'kitchen sockets' },
  2: { circuit_designation: 'lights' },
  3: { circuit_designation: 'cooker' },
  4: { circuit_designation: 'shower' },
  5: { circuit_designation: 'immersion' },
  6: { circuit_designation: 'boiler' },
  7: { circuit_designation: 'garage' },
  8: { circuit_designation: 'study' },
  9: { circuit_designation: 'bedroom' },
  10: { circuit_designation: 'bathroom' },
  11: { circuit_designation: 'outside lights' },
};

describe('Phase 8.2 — exclude_circuits dispatcher behaviour', () => {
  test('all circuits except 1 → applied=10, excluded_count=1, skipped=0', async () => {
    const session = makeSession(buildSnapshot(ELEVEN_CIRCUITS_NO_SPARE));
    const writes = createPerTurnWrites();
    const env = await dispatchSetFieldForAllCircuits(
      makeCall({
        field: 'rcd_time_ms',
        value: '25',
        scope: 'non_spare',
        exclude_circuits: [1],
        confidence: 0.95,
        source_turn_id: 't1',
      }),
      { session, logger: mockLogger(), turnId: 't1', perTurnWrites: writes, round: 1 }
    );
    const body = parseEnvelope(env);
    expect(body.ok).toBe(true);
    expect(body.applied.length).toBe(10);
    expect(body.applied.find((a) => a.circuit === 1)).toBeUndefined();
    expect(body.skipped.length).toBe(0);
    expect(body.excluded_count).toBe(1);
  });

  test('every circuit except spares + circuit 3 → applied lower, excluded=1, skipped=spare count', async () => {
    const snapshot = buildSnapshot({
      1: { circuit_designation: 'kitchen sockets' },
      2: { circuit_designation: 'lights' },
      3: { circuit_designation: 'cooker' },
      4: { circuit_designation: 'spare' },
      5: { circuit_designation: 'spare' },
      6: { circuit_designation: '' }, // blank → also spare per scope rule
      7: { circuit_designation: 'garage' },
    });
    const writes = createPerTurnWrites();
    const env = await dispatchSetFieldForAllCircuits(
      makeCall({
        field: 'rcd_time_ms',
        value: '25',
        scope: 'non_spare',
        exclude_circuits: [3],
        confidence: 0.95,
        source_turn_id: 't1',
      }),
      { session: makeSession(snapshot), logger: mockLogger(), turnId: 't1', perTurnWrites: writes, round: 1 }
    );
    const body = parseEnvelope(env);
    expect(body.ok).toBe(true);
    // Refs 1, 2, 7 are non-spare and not excluded → 3 applied
    expect(body.applied.map((a) => a.circuit).sort((a, b) => a - b)).toEqual([1, 2, 7]);
    // Spares 4, 5, 6 (4+5 explicit, 6 blank) → 3 skipped
    expect(body.skipped.length).toBe(3);
    expect(body.skipped.every((s) => s.reason === 'spare_circuit')).toBe(true);
    expect(body.excluded_count).toBe(1);
  });

  test('scope:rcd_protected_only + exclude_circuits:[3] where 3 has no RCD → excluded_count still 1', async () => {
    // Inspector intent counts independent of scope. Even though circuit 3
    // would have been excluded BY SCOPE anyway (no RCD field set),
    // excluded_count surfaces the inspector's explicit ask.
    const snapshot = buildSnapshot({
      1: { circuit_designation: 'kitchen sockets', rcd_bs_en: 'BS EN 61009' },
      2: { circuit_designation: 'lights', rcd_bs_en: 'BS EN 61009' },
      3: { circuit_designation: 'cooker' }, // no RCD
      4: { circuit_designation: 'shower', rcd_bs_en: 'BS EN 61009' },
    });
    const writes = createPerTurnWrites();
    const env = await dispatchSetFieldForAllCircuits(
      makeCall({
        field: 'rcd_time_ms',
        value: '25',
        scope: 'rcd_protected_only',
        exclude_circuits: [3],
        confidence: 0.95,
        source_turn_id: 't1',
      }),
      { session: makeSession(snapshot), logger: mockLogger(), turnId: 't1', perTurnWrites: writes, round: 1 }
    );
    const body = parseEnvelope(env);
    expect(body.ok).toBe(true);
    // Refs 1, 2, 4 have RCD; 3 is excluded by intent AND would've been
    // dropped by scope. Applied = 3.
    expect(body.applied.map((a) => a.circuit).sort((a, b) => a - b)).toEqual([1, 2, 4]);
    // skipped should NOT carry an entry for ref 3 — the exclude filter
    // ran BEFORE the scope check, so it never reached the no_rcd branch.
    expect(body.skipped.length).toBe(0);
    // excluded_count = inspector intent count, scope-orthogonal.
    expect(body.excluded_count).toBe(1);
  });

  test('exclude_circuits dedup → duplicate refs counted once', async () => {
    const writes = createPerTurnWrites();
    const env = await dispatchSetFieldForAllCircuits(
      makeCall({
        field: 'rcd_time_ms',
        value: '25',
        scope: 'non_spare',
        exclude_circuits: [1, 1, 2, 2, 2],
        confidence: 0.95,
        source_turn_id: 't1',
      }),
      {
        session: makeSession(buildSnapshot(ELEVEN_CIRCUITS_NO_SPARE)),
        logger: mockLogger(),
        turnId: 't1',
        perTurnWrites: writes,
        round: 1,
      }
    );
    const body = parseEnvelope(env);
    expect(body.excluded_count).toBe(2);
    expect(body.applied.length).toBe(9);
  });

  test('exclude_circuits invalid entries (non-int, negative, zero) silently dropped', async () => {
    const writes = createPerTurnWrites();
    const env = await dispatchSetFieldForAllCircuits(
      makeCall({
        field: 'rcd_time_ms',
        value: '25',
        scope: 'non_spare',
        exclude_circuits: [1, 'two', -3, 0, 2.5, null, 4],
        confidence: 0.95,
        source_turn_id: 't1',
      }),
      {
        session: makeSession(buildSnapshot(ELEVEN_CIRCUITS_NO_SPARE)),
        logger: mockLogger(),
        turnId: 't1',
        perTurnWrites: writes,
        round: 1,
      }
    );
    const body = parseEnvelope(env);
    // Only 1 + 4 are valid positive integers
    expect(body.excluded_count).toBe(2);
    expect(body.applied.find((a) => a.circuit === 1)).toBeUndefined();
    expect(body.applied.find((a) => a.circuit === 4)).toBeUndefined();
    expect(body.applied.length).toBe(9);
  });

  test('omitted exclude_circuits preserves the original baseline (excluded_count=0)', async () => {
    const writes = createPerTurnWrites();
    const env = await dispatchSetFieldForAllCircuits(
      makeCall({
        field: 'rcd_time_ms',
        value: '25',
        scope: 'non_spare',
        confidence: 0.95,
        source_turn_id: 't1',
      }),
      {
        session: makeSession(buildSnapshot(ELEVEN_CIRCUITS_NO_SPARE)),
        logger: mockLogger(),
        turnId: 't1',
        perTurnWrites: writes,
        round: 1,
      }
    );
    const body = parseEnvelope(env);
    expect(body.applied.length).toBe(11);
    expect(body.excluded_count).toBe(0);
  });
});
