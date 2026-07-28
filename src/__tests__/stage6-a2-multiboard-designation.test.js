/**
 * A2-multiboard (2026-07-28) — the confirmation-TTS designation map is keyed by
 * the PAIR `(effective_board_id, circuit_ref)`.
 *
 * The defect: circuit refs are PER BOARD, but the map was keyed by ref ALONE.
 * On a multi-board job a turn that renamed circuit 3 on board A and circuit 3
 * on board B left ONE entry, so BOTH boards' read-backs spoke the last
 * writer's name — the inspector hears "Shower, Zs 0.42" for a reading stored
 * against board A's cooker. A wrong name on a spoken read-back is undetectable
 * by ear, which is exactly the class Audio-First #1 exists to catch.
 *
 * Two halves are pinned here:
 *   1. the harness BUILD — the map carries pair keys (from the snapshot AND
 *      from same-turn `circuit_designation` writes, projected from the journal
 *      winners rather than the board-ambiguous raw Map);
 *   2. the bundler RESOLVE — both confirmation synthesisers try the pair first
 *      and fall back to the bare ref, so single-board traffic is unchanged.
 *
 * It also pins a second latent defect found while re-keying: the harness's
 * snapshot pass only iterated bare-numeric circuit keys, so SUB-BOARD circuits
 * (which live under `${board_id}::${ref}` composite buckets — see
 * stage6-multi-board-shape.js) were never in the map at all and a sub-board
 * circuit's name never reached the spoken read-back.
 */

import { jest } from '@jest/globals';
import { bundleToolCallsIntoResult } from '../extraction/stage6-event-bundler.js';
import {
  createPerTurnWrites,
  circuitDesignationKey,
} from '../extraction/stage6-per-turn-writes.js';
import {
  dispatchRecordReading,
  dispatchClearReading,
} from '../extraction/stage6-dispatchers-circuit.js';
import { runShadowHarness } from '../extraction/stage6-shadow-harness.js';
import { mockClient } from './helpers/mockStream.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

const MULTI_BOARD = [
  { id: 'main', designation: 'DB-1', board_type: 'main' },
  { id: 'sub-b', designation: 'DB-2', board_type: 'sub', parent_board_id: 'main' },
];

function ctx(session, perTurnWrites, callId) {
  return { session, logger: mockLogger(), turnId: 't1', perTurnWrites, round: 0, callId };
}

function bundle(perTurnWrites, circuitDesignations) {
  return bundleToolCallsIntoResult(perTurnWrites, null, {
    confirmationsEnabled: true,
    turnId: 't1',
    circuitDesignations,
  });
}

const textsOf = (r) => (r.confirmations ?? []).map((c) => c.text);

// ---------------------------------------------------------------------------
// 1. The bundler's resolver.
// ---------------------------------------------------------------------------

describe('A2-multiboard — the bundler resolves designations by (board, ref)', () => {
  function twoBoardSameRefWrites() {
    const session = {
      sessionId: 'a2mb',
      stateSnapshot: {
        circuits: {
          3: { measured_zs_ohm: null },
          'sub-b::3': { board_id: 'sub-b', circuit: 3, measured_zs_ohm: null },
        },
        boards: MULTI_BOARD,
        currentBoardId: 'main',
        pending_readings: [],
        observations: [],
        validation_alerts: [],
      },
    };
    return { session, p: createPerTurnWrites() };
  }

  test('the same circuit ref on two boards speaks each board OWN name', async () => {
    const { session, p } = twoBoardSameRefWrites();
    await dispatchRecordReading(
      {
        tool_call_id: 'w1',
        name: 'record_reading',
        input: {
          field: 'measured_zs_ohm',
          circuit: 3,
          value: '0.42',
          confidence: 0.9,
          source_turn_id: 't1',
          board_id: 'main',
        },
      },
      ctx(session, p, 'w1')
    );
    // `record_reading` rejects a board_id other than the current one, so a
    // real cross-board turn interleaves `select_board`. Model that by flipping
    // the snapshot's current board between the two writes.
    session.stateSnapshot.currentBoardId = 'sub-b';
    await dispatchRecordReading(
      {
        tool_call_id: 'w2',
        name: 'record_reading',
        input: {
          field: 'measured_zs_ohm',
          circuit: 3,
          value: '0.55',
          confidence: 0.9,
          source_turn_id: 't1',
          board_id: 'sub-b',
        },
      },
      ctx(session, p, 'w2')
    );

    const designations = new Map([
      [circuitDesignationKey('main', 3), 'Cooker'],
      [circuitDesignationKey('sub-b', 3), 'Shower'],
      // The legacy bare-ref entry is deliberately the WRONG one for board B —
      // if the resolver ever fell back to it, this test fails loudly.
      [3, 'Cooker'],
    ]);
    const r = bundle(p, designations);
    const texts = textsOf(r);

    expect(texts.some((t) => t.includes('Cooker') && t.includes('0.42'))).toBe(true);
    expect(texts.some((t) => t.includes('Shower') && t.includes('0.55'))).toBe(true);
    // The cross-board leak: board B's read-back must never carry board A's name.
    expect(texts.some((t) => t.includes('Cooker') && t.includes('0.55'))).toBe(false);
  });

  test('a reading with NO board id still resolves through the bare ref (single-board unchanged)', async () => {
    const { session, p } = twoBoardSameRefWrites();
    await dispatchRecordReading(
      {
        tool_call_id: 'w1',
        name: 'record_reading',
        input: {
          field: 'measured_zs_ohm',
          circuit: 3,
          value: '0.42',
          confidence: 0.9,
          source_turn_id: 't1',
        },
      },
      ctx(session, p, 'w1')
    );
    const r = bundle(p, new Map([[3, 'Cooker']]));
    expect(textsOf(r).some((t) => t.includes('Cooker'))).toBe(true);
  });

  test('a plain-object designation map keeps its ref-only semantics (legacy callers)', async () => {
    const { session, p } = twoBoardSameRefWrites();
    await dispatchRecordReading(
      {
        tool_call_id: 'w1',
        name: 'record_reading',
        input: {
          field: 'measured_zs_ohm',
          circuit: 3,
          value: '0.42',
          confidence: 0.9,
          source_turn_id: 't1',
          board_id: 'main',
        },
      },
      ctx(session, p, 'w1')
    );
    const r = bundle(p, { 3: 'Cooker' });
    expect(textsOf(r).some((t) => t.includes('Cooker'))).toBe(true);
  });

  test('the CLEARED confirmation resolves on the clear own effective board', async () => {
    const session = {
      sessionId: 'a2mb-clear',
      stateSnapshot: {
        circuits: {
          3: { measured_zs_ohm: '1.50' },
          'sub-b::3': { board_id: 'sub-b', circuit: 3, measured_zs_ohm: '2.50' },
        },
        boards: MULTI_BOARD,
        // The inspector is working on the sub-board (`select_board sub-b`).
        currentBoardId: 'sub-b',
        pending_readings: [],
        observations: [],
        validation_alerts: [],
      },
    };
    const p = createPerTurnWrites();
    await dispatchClearReading(
      {
        tool_call_id: 'c1',
        name: 'clear_reading',
        input: {
          field: 'measured_zs_ohm',
          circuit: 3,
          reason: 'user_correction',
          board_id: 'sub-b',
        },
      },
      ctx(session, p, 'c1')
    );
    const r = bundle(
      p,
      new Map([
        [circuitDesignationKey('main', 3), 'Cooker'],
        [circuitDesignationKey('sub-b', 3), 'Shower'],
        [3, 'Cooker'],
      ])
    );
    const texts = textsOf(r);
    expect(texts.some((t) => t.includes('Shower'))).toBe(true);
    expect(texts.some((t) => t.includes('Cooker'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. The harness BUILD — driven end-to-end through the real live lane.
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
    { type: 'message_start', message: { id: 'msg_et', role: 'assistant', content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ];
}

function harnessSession(circuits, streams, currentBoardId = 'main') {
  return {
    sessionId: 'a2mb-live',
    turnCount: 0,
    toolCallsMode: 'live',
    systemPrompt: 'TEST SYSTEM PROMPT',
    client: mockClient(streams),
    stateSnapshot: {
      circuits,
      boards: MULTI_BOARD,
      currentBoardId,
      pending_readings: [],
      observations: [],
      validation_alerts: [],
    },
    extractedObservations: [],
    buildSystemBlocks() {
      return [{ type: 'text', text: this.systemPrompt }];
    },
    extractFromUtterance: jest.fn(async () => ({
      extracted_readings: [],
      observations: [],
      questions: [],
    })),
  };
}

describe('A2-multiboard — the harness builds a board-keyed designation map', () => {
  test('a SUB-BOARD circuit name from the snapshot reaches the read-back', async () => {
    // Pre-A2-multiboard the composite `sub-b::3` bucket was skipped entirely
    // (`Number('sub-b::3')` is NaN), so this circuit had no name at all.
    const session = harnessSession(
      {
        3: { circuit_designation: 'Cooker', measured_zs_ohm: null },
        'sub-b::3': {
          board_id: 'sub-b',
          circuit: 3,
          circuit_designation: 'Shower',
          measured_zs_ohm: null,
        },
      },
      [
        toolUseRound([
          {
            id: 'toolu_zs_sub',
            name: 'record_reading',
            input: {
              field: 'measured_zs_ohm',
              circuit: 3,
              value: '0.55',
              confidence: 0.9,
              source_turn_id: 't1',
              board_id: 'sub-b',
            },
          },
        ]),
        endTurnRound(),
      ],
      // The inspector already selected the sub-board.
      'sub-b'
    );

    const result = await runShadowHarness(session, 'zs on circuit three is nought five five', [], {
      logger: mockLogger(),
      confirmationsEnabled: true,
      utteranceId: 'utt-a2mb-1',
    });

    const texts = (result.confirmations ?? []).map((c) => c.text);
    expect(texts.some((t) => t.includes('Shower'))).toBe(true);
    expect(texts.some((t) => t.includes('Cooker'))).toBe(false);
  });

  test('same-turn renames on TWO boards do not collapse onto one name', async () => {
    const session = harnessSession(
      {
        3: { measured_zs_ohm: null },
        'sub-b::3': { board_id: 'sub-b', circuit: 3, measured_zs_ohm: null },
      },
      [
        toolUseRound([
          { id: 'toolu_sel_main', name: 'select_board', input: { board_id: 'main' } },
          {
            id: 'toolu_d_main',
            name: 'record_reading',
            input: {
              field: 'circuit_designation',
              circuit: 3,
              value: 'Cooker',
              confidence: 0.9,
              source_turn_id: 't1',
              board_id: 'main',
            },
          },
          {
            id: 'toolu_zs_main',
            name: 'record_reading',
            input: {
              field: 'measured_zs_ohm',
              circuit: 3,
              value: '0.42',
              confidence: 0.9,
              source_turn_id: 't1',
              board_id: 'main',
            },
          },
          { id: 'toolu_sel_sub', name: 'select_board', input: { board_id: 'sub-b' } },
          {
            id: 'toolu_d_sub',
            name: 'record_reading',
            input: {
              field: 'circuit_designation',
              circuit: 3,
              value: 'Shower',
              confidence: 0.9,
              source_turn_id: 't1',
              board_id: 'sub-b',
            },
          },
          {
            id: 'toolu_zs_sub',
            name: 'record_reading',
            input: {
              field: 'measured_zs_ohm',
              circuit: 3,
              value: '0.55',
              confidence: 0.9,
              source_turn_id: 't1',
              board_id: 'sub-b',
            },
          },
        ]),
        endTurnRound(),
      ]
    );

    const result = await runShadowHarness(session, 'rename both threes and record zs', [], {
      logger: mockLogger(),
      confirmationsEnabled: true,
      utteranceId: 'utt-a2mb-2',
    });

    const texts = (result.confirmations ?? []).map((c) => c.text);
    // Each board's Zs read-back carries its OWN circuit-3 name. Pre-fix the raw
    // Map key (`circuit_designation::3<NUL>__board__<NUL>…`) still differed, but
    // the OVERLAY was keyed by ref alone so the last writer won for both.
    expect(texts.some((t) => t.includes('Cooker') && t.includes('0.42'))).toBe(true);
    expect(texts.some((t) => t.includes('Shower') && t.includes('0.55'))).toBe(true);
    expect(texts.some((t) => t.includes('Shower') && t.includes('0.42'))).toBe(false);
  });
});
