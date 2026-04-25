/**
 * Stage 6 Phase 2 Plan 02-06 Task 5 — STT-09 same-turn correction.
 *
 * Exercises the core correction path the Phase 2 architecture was designed
 * for: Sonnet emits THREE tool calls in a SINGLE assistant response (one
 * round, one perTurnWrites accumulator) where the third call semantically
 * undoes the first two.
 *
 * Scenario:
 *   Call 1: record_reading(volts, C1, '230', turn='t1')
 *   Call 2: record_reading(volts, C1, '240', turn='t1')   ← corrects call 1
 *   Call 3: clear_reading (volts, C1, reason='user_correction') ← undoes both
 *
 * Why this matters (REQUIREMENTS.md STT-09): the real-world trigger is the
 * inspector saying "volts on circuit one is two thirty... sorry, two forty...
 * actually skip that, the test wasn't complete". Sonnet is instructed to emit
 * these as separate tool calls rather than a single "final value" reading so
 * the audit log captures every state change. BUT iOS must only see the NET
 * effect — no reading, plus a clear marker — otherwise the UI flashes 230,
 * then 240, then nothing.
 *
 * The mechanism is the Map-keyed readings accumulator (Plan 02-02):
 *   - Call 2's `readings.set('volts::1', {value:'240',...})` OVERWRITES
 *     call 1's entry (last-write-wins, Map semantics).
 *   - Call 3's `readings.delete('volts::1')` removes it entirely.
 *   - Call 3 pushes `{field, circuit, reason}` into `cleared[]`.
 *
 * Post-state guarantees tested:
 *   - perTurnWrites.readings.size === 0
 *   - perTurnWrites.cleared.length === 1 (only one clear ever happened)
 *   - bundleToolCallsIntoResult omits `extracted_readings` as an empty array
 *     BUT emits `cleared_readings` with the single clear entry (Plan 02-05
 *     omission rule: new slots omitted ONLY when empty; extracted_readings
 *     is a legacy slot so it's always present, empty or not).
 *   - session.stateSnapshot.circuits[1].volts is undefined (snapshot cleared)
 *
 * This is a direct dispatcher test — it does NOT go through runShadowHarness
 * or runToolLoop. The Phase 2 contract is:
 *   runToolLoop(call, ctx) → dispatches one call at a time, sequentially.
 *   perTurnWrites is SHARED across all calls in a turn.
 *   Three calls in one response ≡ three sequential dispatcher invocations
 *   against the same accumulator.
 *
 * Driving the dispatchers directly avoids coupling this test to
 * runToolLoop's event-stream mechanics (tested separately in
 * stage6-tool-loop.test.js) and to the shadow harness's wire format (tested
 * in stage6-shadow-harness.test.js + stage6-tool-loop-e2e.test.js).
 */

import { jest } from '@jest/globals';

import { createWriteDispatcher } from '../extraction/stage6-dispatchers.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';
import { bundleToolCallsIntoResult } from '../extraction/stage6-event-bundler.js';

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

/**
 * Build a session stub with C1 pre-populated (empty circuit object) so
 * record_reading passes validateRecordReading. No client, no streams — these
 * are dispatcher unit mechanics.
 */
function makeSession() {
  return {
    sessionId: 'sess-stt09',
    stateSnapshot: {
      circuits: { 1: {} },
      pending_readings: [],
      observations: [],
      validation_alerts: [],
    },
    extractedObservations: [],
  };
}

describe('Stage 6 Phase 2 — STT-09 same-turn correction', () => {
  test('record → record → clear in one response collapses to zero readings + one clear', async () => {
    const session = makeSession();
    const logger = makeLogger();
    const perTurnWrites = createPerTurnWrites();
    const dispatch = createWriteDispatcher(session, logger, 't1', perTurnWrites);

    // Call 1: record_reading(volts, C1, 230). Populates Map + snapshot.
    const out1 = await dispatch(
      {
        tool_call_id: 'toolu_1',
        name: 'record_reading',
        input: {
          field: 'volts',
          circuit: 1,
          value: '230',
          confidence: 1.0,
          source_turn_id: 't1',
        },
      },
      {},
    );
    expect(out1.is_error).toBe(false);
    expect(perTurnWrites.readings.size).toBe(1);
    expect(perTurnWrites.readings.get('volts::1').value).toBe('230');
    expect(session.stateSnapshot.circuits[1].volts).toBe('230');

    // Call 2: record_reading(volts, C1, 240). OVERWRITES call 1 on the Map
    // (last-write-wins), snapshot also updated.
    const out2 = await dispatch(
      {
        tool_call_id: 'toolu_2',
        name: 'record_reading',
        input: {
          field: 'volts',
          circuit: 1,
          value: '240',
          confidence: 1.0,
          source_turn_id: 't1',
        },
      },
      {},
    );
    expect(out2.is_error).toBe(false);
    expect(perTurnWrites.readings.size).toBe(1); // still 1 — same key, overwritten
    expect(perTurnWrites.readings.get('volts::1').value).toBe('240');
    expect(session.stateSnapshot.circuits[1].volts).toBe('240');

    // Call 3: clear_reading(volts, C1). Removes from Map + snapshot, pushes to
    // cleared[]. No extracted_readings should survive into the bundler.
    const out3 = await dispatch(
      {
        tool_call_id: 'toolu_3',
        name: 'clear_reading',
        input: {
          field: 'volts',
          circuit: 1,
          reason: 'user_correction',
        },
      },
      {},
    );
    expect(out3.is_error).toBe(false);

    // Per-turn accumulator: zero readings, one clear.
    expect(perTurnWrites.readings.size).toBe(0);
    expect(perTurnWrites.cleared).toHaveLength(1);
    expect(perTurnWrites.cleared[0]).toEqual({
      field: 'volts',
      circuit: 1,
      reason: 'user_correction',
    });

    // Session snapshot: volts field cleared.
    expect(session.stateSnapshot.circuits[1].volts).toBeUndefined();

    // Bundler output (Plan 02-05): extracted_readings is a LEGACY slot so it's
    // present but empty; cleared_readings is a new Phase 2 slot emitted ONLY
    // when non-empty — so here it IS emitted with one entry.
    const bundled = bundleToolCallsIntoResult(perTurnWrites, { questions: [] });
    expect(bundled.extracted_readings).toEqual([]);
    expect(bundled.cleared_readings).toEqual([
      { field: 'volts', circuit: 1, reason: 'user_correction' },
    ]);
    expect(bundled.observations).toEqual([]);
    expect(bundled.questions).toEqual([]);

    // circuit_updates + observation_deletions are omitted (empty — Plan 02-05
    // omission rule for new Phase 2 slots).
    expect(bundled).not.toHaveProperty('circuit_updates');
    expect(bundled).not.toHaveProperty('observation_deletions');

    // All three log rows emitted with correct outcomes.
    const logCalls = logger.info.mock.calls.filter(
      (c) => c[0] === 'stage6_tool_call',
    );
    expect(logCalls).toHaveLength(3);
    expect(logCalls[0][1]).toMatchObject({ tool: 'record_reading', outcome: 'ok', round: 1 });
    expect(logCalls[1][1]).toMatchObject({ tool: 'record_reading', outcome: 'ok', round: 2 });
    expect(logCalls[2][1]).toMatchObject({ tool: 'clear_reading', outcome: 'ok', round: 3 });
  });

  test('Map insertion-order preservation: record-different-slot + correction leaves the other slot intact', async () => {
    // Guard against a refactor that swaps Map for an object or non-ordered
    // structure: clearing volts::1 must not touch amps::1.
    const session = makeSession();
    const logger = makeLogger();
    const perTurnWrites = createPerTurnWrites();
    const dispatch = createWriteDispatcher(session, logger, 't2', perTurnWrites);

    await dispatch(
      {
        tool_call_id: 'toolu_a',
        name: 'record_reading',
        input: { field: 'amps', circuit: 1, value: '10', confidence: 1.0, source_turn_id: 't2' },
      },
      {},
    );
    await dispatch(
      {
        tool_call_id: 'toolu_b',
        name: 'record_reading',
        input: { field: 'volts', circuit: 1, value: '230', confidence: 1.0, source_turn_id: 't2' },
      },
      {},
    );
    await dispatch(
      {
        tool_call_id: 'toolu_c',
        name: 'clear_reading',
        input: { field: 'volts', circuit: 1, reason: 'retest_needed' },
      },
      {},
    );

    expect(perTurnWrites.readings.size).toBe(1);
    expect(perTurnWrites.readings.has('amps::1')).toBe(true);
    expect(perTurnWrites.readings.has('volts::1')).toBe(false);
    expect(perTurnWrites.cleared).toHaveLength(1);

    const bundled = bundleToolCallsIntoResult(perTurnWrites, { questions: [] });
    expect(bundled.extracted_readings).toHaveLength(1);
    expect(bundled.extracted_readings[0]).toMatchObject({
      field: 'amps',
      // Codex Phase-2 review MAJOR #2 fix: bundler now round-trips integer
      // circuit_refs back to Number (was a string side-effect of the Map key).
      circuit: 1,
      value: '10',
      source: 'tool_call',
    });
    expect(bundled.cleared_readings).toEqual([
      { field: 'volts', circuit: 1, reason: 'retest_needed' },
    ]);
  });
});
