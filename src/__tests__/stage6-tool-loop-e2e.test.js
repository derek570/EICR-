/**
 * Stage 6 Phase 2 Plan 02-06 Task 4 — STT-03 multi-round integration.
 *
 * Drives runShadowHarness end-to-end with a mocked Anthropic client that
 * emits TWO tool-use rounds followed by a terminal end_turn round. Proves
 * the shadow harness correctly:
 *   1. Runs legacy first.
 *   2. Dispatches all tool calls across rounds via WRITE_DISPATCHERS.
 *   3. Bundles perTurnWrites into the Phase 2 result shape once, post-loop.
 *   4. Runs compareSlots and emits a single stage6_divergence row.
 *   5. Returns LEGACY result (iOS wire unchanged).
 *
 * Scenario (aligned with dispatcher validation — C1 pre-exists in snapshot):
 *   Round 1 (tool_use): create_circuit(2, designation='Sockets')
 *                     + record_reading(volts, 1, '230')
 *   Round 2 (tool_use): record_observation(code='C2', text='RCD type AC', ...)
 *   Round 3 (end_turn): text-only "done"
 *
 * Expected:
 *   - mockAnthropic.messages.stream called 3x (one per round).
 *   - toolLoopOut.rounds = 3; toolLoopOut.aborted = false.
 *   - perTurnWrites observable shape via the divergence log:
 *       tool_slots.readings size = 1 (volts::1)
 *       tool_slots.observations size = 1 ('C2::RCD type AC')
 *       tool_slots.circuit_ops size = 1 ('create::2')
 *   - bundled result has extracted_readings.length=1, observations.length=1,
 *     circuit_updates.length=1. cleared_readings + observation_deletions
 *     absent (empty-array omission — Plan 02-05 contract).
 *
 * Also includes MINOR-2 guard: mode='live' throws and never invokes the
 * mocked client.
 */

import { jest } from '@jest/globals';

import { runShadowHarness } from '../extraction/stage6-shadow-harness.js';
import { mockClient } from './helpers/mockStream.js';

// ---------------------------------------------------------------------------
// Event fixtures — copy of Phase 1 stage6-tool-loop.test.js helpers.
// ---------------------------------------------------------------------------

function toolUseRound(toolCalls) {
  const events = [
    { type: 'message_start', message: { id: 'msg_tu', role: 'assistant', content: [] } },
  ];
  toolCalls.forEach((tc, i) => {
    events.push({
      type: 'content_block_start',
      index: i,
      content_block: { type: 'tool_use', id: tc.id, name: tc.name, input: {} },
    });
    events.push({
      type: 'content_block_delta',
      index: i,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(tc.input) },
    });
    events.push({ type: 'content_block_stop', index: i });
  });
  events.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' } });
  events.push({ type: 'message_stop' });
  return events;
}

function endTurnRound(text = 'done') {
  return [
    { type: 'message_start', message: { id: 'msg_end', role: 'assistant', content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ];
}

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

/**
 * Build a stub session with pre-populated stateSnapshot.circuits[1] so
 * record_reading(volts, 1, ...) passes validateRecordReading's
 * circuit-exists check.
 *
 * @param {any} streamResponses  Array of event arrays (one per stream call).
 * @param {any} legacyResult     What extractFromUtterance resolves to.
 */
function makeSession(streamResponses, legacyResult, mode = 'shadow') {
  return {
    sessionId: 'sess-e2e',
    turnCount: 0,
    toolCallsMode: mode,
    systemPrompt: 'TEST SYSTEM PROMPT',
    client: mockClient(streamResponses),
    stateSnapshot: {
      circuits: { 1: {} }, // C1 pre-exists so record_reading passes.
      pending_readings: [],
      observations: [],
      validation_alerts: [],
    },
    extractedObservations: [],
    // Plan 04-11 r5-#1 — runShadowHarness now calls session.buildSystemBlocks()
    // instead of hand-rolling a single-block array. Hand-rolled session
    // stubs must implement this method. Shape mirrors the real
    // EICRExtractionSession.buildSystemBlocks: 1 block off-mode (or when
    // the state snapshot is empty), 2 blocks non-off with a non-empty
    // snapshot. The e2e tests don't exercise the snapshot path, so 1
    // block is fine here.
    buildSystemBlocks() {
      return [
        {
          type: 'text',
          text: this.systemPrompt,
          cache_control: { type: 'ephemeral', ttl: '5m' },
        },
      ];
    },
    extractFromUtterance: jest.fn().mockImplementation(async function () {
      this.turnCount = (this.turnCount ?? 0) + 1;
      return legacyResult;
    }),
  };
}

describe('Stage 6 Phase 2 — STT-03 multi-round integration', () => {
  test('two tool-use rounds + end_turn → dispatchers fire, bundler projects, divergence logged', async () => {
    const logger = makeLogger();

    const streams = [
      toolUseRound([
        {
          id: 'toolu_1',
          name: 'create_circuit',
          input: { circuit_ref: 2, designation: 'Sockets' },
        },
        {
          id: 'toolu_2',
          name: 'record_reading',
          input: {
            field: 'volts',
            circuit: 1,
            value: '230',
            confidence: 1.0,
            source_turn_id: 't1',
          },
        },
      ]),
      toolUseRound([
        {
          id: 'toolu_3',
          name: 'record_observation',
          input: {
            code: 'C2',
            location: 'CU',
            text: 'RCD type AC',
            circuit: null,
            suggested_regulation: null,
          },
        },
      ]),
      endTurnRound('done'),
    ];

    // Legacy stub returns the SAME effective writes so the comparator reports
    // reason:'identical'. We pin legacy to reflect what a non-strict legacy
    // path would have produced for this transcript. circuit_updates is a
    // Phase-2 slot that legacy does not naturally emit, but the comparator
    // projects it when present — including it here is what makes the slots
    // structurally identical. (Without it, tool's create::2 op causes a
    // circuit_ops_diff divergence.)
    const legacyResult = {
      extracted_readings: [{ field: 'volts', circuit: 1, value: '230' }],
      observations: [{ id: 'legacy-uuid-1', code: 'C2', text: 'RCD type AC' }],
      circuit_updates: [{ op: 'create', circuit_ref: 2 }],
      questions: [],
    };

    const s = makeSession(streams, legacyResult, 'shadow');
    const result = await runShadowHarness(s, 'voltage on sockets is two thirty', [], { logger });

    // 1. iOS byte-identical: LEGACY is returned.
    expect(result).toBe(legacyResult);

    // 2. Three stream calls (one per round). rounds counter = 3 (Phase 1 loop
    //    semantics count rounds regardless of stop_reason — end_turn round
    //    increments rounds as well).
    expect(s.client._callCount).toBe(3);

    // 3. Legacy was invoked exactly once.
    expect(s.extractFromUtterance).toHaveBeenCalledTimes(1);

    // 4. Exactly one stage6_divergence row.
    const divRows = logger.info.mock.calls.filter((c) => c[0] === 'stage6_divergence');
    expect(divRows).toHaveLength(1);

    const payload = divRows[0][1];
    expect(payload.phase).toBe(2);
    expect(payload.bundler_phase).toBe(2);
    expect(payload.aborted).toBe(false);
    expect(payload.rounds).toBe(3);
    expect(payload.shadow_cost_usd).toBe(null);

    // 5. Bundler output shape observed via tool_slots projection.
    //    (serialised via Object.fromEntries + spread arrays)
    expect(payload.tool_slots.readings).toEqual({ 'volts::1': '230' });
    expect(payload.tool_slots.observations).toEqual(['C2::RCD type AC']);
    expect(payload.tool_slots.circuit_ops).toEqual(['create::2']);
    expect(payload.tool_slots.cleared).toEqual([]);
    expect(payload.tool_slots.observation_deletions).toEqual([]);

    // 6. With a legacy stub pinned to the same slots, reason === 'identical'.
    expect(payload.divergent).toBe(false);
    expect(payload.reason).toBe('identical');

    // 7. Codex Phase-2 review BLOCK #1 fix: shadow dispatchers run against an
    //    ISOLATED shadow session wrapper, NOT the live session. The live
    //    session's stateSnapshot + extractedObservations must be untouched —
    //    legacy is the only authoritative writer during Phase 2. Evidence that
    //    the dispatchers actually ran comes from (a) _callCount === 3 above,
    //    (b) the tool_slots projection observed in step 5, and (c) the
    //    divergence comparator's reason === 'identical'.
    expect(s.stateSnapshot.circuits[2]).toBeUndefined();
    expect(s.stateSnapshot.circuits[1].volts).toBeUndefined();
    expect(s.extractedObservations).toEqual([]);
  });

  test('SHADOW-OFF IDEMPOTENCY (success criterion #6): mode=off triggers ZERO mockAnthropic.stream calls', async () => {
    const logger = makeLogger();
    const streams = [endTurnRound('should not be reached')];
    const legacyResult = { extracted_readings: [], observations: [], questions: [] };

    const s = makeSession(streams, legacyResult, 'off');
    const result = await runShadowHarness(s, 'text', [], { logger });

    expect(result).toBe(legacyResult);
    expect(s.extractFromUtterance).toHaveBeenCalledTimes(1);
    // Critical: the shadow-off path MUST NOT invoke the Anthropic client.
    expect(s.client._callCount).toBe(0);
    // Critical: no divergence log emitted when shadow mode is off.
    expect(logger.info).not.toHaveBeenCalledWith('stage6_divergence', expect.anything());
  });

  test('MINOR-2 live-mode bypass: mode=live throws Phase-7 guard, does NOT call client or legacy', async () => {
    const logger = makeLogger();
    const streams = [endTurnRound('should not be reached')];
    const legacyResult = { extracted_readings: [], observations: [], questions: [] };

    const s = makeSession(streams, legacyResult, 'live');

    await expect(runShadowHarness(s, 'text', [], { logger })).rejects.toThrow(
      /not implemented until Phase 7/,
    );

    // Legacy NEVER runs in live mode (throw is the first observable effect).
    expect(s.extractFromUtterance).not.toHaveBeenCalled();
    // Anthropic client NEVER called — live mode is a gate, not a silent legacy.
    expect(s.client._callCount).toBe(0);
    // No divergence log.
    expect(logger.info).not.toHaveBeenCalledWith('stage6_divergence', expect.anything());
  });
});
