/**
 * Stage 6 Phase 2 Plan 02-02 → Plan 02-03/04 — Dispatcher scaffold tests.
 *
 * WHAT: Locks the Phase 1 runToolLoop dispatcher contract for the six write
 * tools PLUS the unknown_tool path. Tests the barrel's WRITE_DISPATCHERS
 * table shape, the factory's closure behaviour, and the round counter.
 *
 * WHY these tests are the gate for Wave 2 landing:
 *   - If Plans 02-03/04 break the envelope shape or log-row schema, this
 *     file fails BEFORE the dispatcher-specific tests in those plans — a
 *     cheap canary that catches contract drift early.
 *   - The integration test at the bottom (Task 5) uses a real mockClient +
 *     runToolLoop invocation to prove the scaffold is actually compatible
 *     with Phase 1 infrastructure, not just shape-compatible on paper.
 *
 * WAVE-2 UPDATE (Plan 02-03 landing): the NOOP-era assertions that passed
 * `input: {}` and expected `ok: true` have been replaced with minimal
 * VALID inputs + stateSnapshot. The REAL-impl dispatchers (Plan 02-03 for
 * circuits, Plan 02-04 for observations) validate their inputs — an empty
 * input now REJECTS. The tests below assert the envelope + log-row
 * SHAPE (not the NOOP ok:true behaviour) so the canary still covers:
 *   - WRITE_DISPATCHERS has exactly six async functions
 *   - createWriteDispatcher returns a valid closure with arity 2
 *   - known-tool dispatch produces a well-formed envelope (ok:true under
 *     valid input; this is the scaffold's end-to-end shape canary)
 *   - unknown_tool path emits the rejection envelope + log row
 *   - round counter increments monotonically across sequential calls
 *   - integration test drives a 2-round loop via runToolLoop
 */

import { jest } from '@jest/globals';
import { WRITE_DISPATCHERS, createWriteDispatcher } from '../extraction/stage6-dispatchers.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';
import { runToolLoop } from '../extraction/stage6-tool-loop.js';
import { mockClient } from './helpers/mockStream.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

describe('WRITE_DISPATCHERS dispatch table', () => {
  test('has exactly eleven keys matching REQUIREMENTS STS-01..06 + record_board_reading + start_dialogue_script + delete_circuit + calculate_zs + calculate_r1_plus_r2', () => {
    expect(Object.keys(WRITE_DISPATCHERS).sort()).toEqual(
      [
        'clear_reading',
        'create_circuit',
        'delete_observation',
        // record_board_reading was added in the Bug C fix from the
        // 2026-04-26 production analysis — supply / installation / board
        // writes had no tool surface before this.
        'record_board_reading',
        'record_observation',
        'record_reading',
        'rename_circuit',
        // start_dialogue_script (2026-04-30 Silvertown follow-up) — Sonnet-
        // driven entry to the dialogue engine for structured walk-throughs
        // the engine's regex missed (Deepgram garbles, paraphrases).
        'start_dialogue_script',
        // 2026-05-04 (field test 07635782): three tools in one batch.
        // delete_circuit closes the gap that left "delete circuit 2"
        // silently dropped; calculate_zs / calculate_r1_plus_r2 close the
        // gap where "calculate the Zs" produced empty turns.
        'delete_circuit',
        'calculate_zs',
        'calculate_r1_plus_r2',
      ].sort()
    );
  });

  test('every entry is an async function', () => {
    // WHY NO INVOCATION: after Plan 02-03/04 real-impls landed, invoking each
    // dispatcher with `input: {}` triggers validation (record_reading ⇒
    // circuit_not_found, create_circuit ⇒ circuit_already_exists on undefined
    // circuit_ref, etc.) — one of which crashes on an empty stateSnapshot.
    // We only need to prove each entry IS an async function; use constructor
    // name so we do not accidentally exercise the validator.
    for (const [name, fn] of Object.entries(WRITE_DISPATCHERS)) {
      expect(typeof fn).toBe('function');
      expect(fn.constructor.name).toBe('AsyncFunction');
      // Tool names are snake_case + may carry digits (e.g. calculate_r1_plus_r2,
      // record_board_reading). The regex was originally `[a-z_]+` only;
      // 2026-05-04 added calculate_r1_plus_r2 which fails that. Allow digits
      // but keep the no-uppercase / no-special-char floor to catch typos.
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe('createWriteDispatcher()', () => {
  test('returns a function of arity 2 (Phase 1 runToolLoop dispatcher contract)', () => {
    const d = createWriteDispatcher({ sessionId: 's1' }, mockLogger(), 't1', createPerTurnWrites());
    expect(typeof d).toBe('function');
    expect(d.length).toBe(2);
  });

  test('known tool: returns well-formed envelope and logs one stage6_tool_call row with outcome=ok', async () => {
    // WAVE-2 UPDATE: supply VALID input + stateSnapshot so the real-impl
    // dispatcher (Plan 02-03) reaches the success path. The NOOP era accepted
    // any input; real impl validates.
    const logger = mockLogger();
    const session = { sessionId: 's1', stateSnapshot: { circuits: { 3: {} } } };
    const d = createWriteDispatcher(session, logger, 't1', createPerTurnWrites());
    const result = await d(
      {
        tool_call_id: 'tu_x',
        name: 'record_reading',
        input: {
          field: 'Ze_ohms',
          circuit: 3,
          value: '0.35',
          confidence: 1.0,
          source_turn_id: 't1',
        },
      },
      {}
    );
    expect(result.tool_use_id).toBe('tu_x');
    expect(result.is_error).toBe(false);
    expect(typeof result.content).toBe('string');
    expect(JSON.parse(result.content)).toMatchObject({ ok: true });

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      'stage6_tool_call',
      expect.objectContaining({
        tool: 'record_reading',
        outcome: 'ok',
        is_error: false,
        phase: 2,
        tool_use_id: 'tu_x',
        round: 1,
      })
    );
  });

  test('unknown tool: returns is_error envelope with unknown_tool content and logs rejected row', async () => {
    const logger = mockLogger();
    const d = createWriteDispatcher({ sessionId: 's1' }, logger, 't1', createPerTurnWrites());
    const result = await d({ tool_call_id: 'tu_y', name: 'write_stuff', input: {} }, {});
    expect(result.is_error).toBe(true);
    expect(result.tool_use_id).toBe('tu_y');
    expect(result.content).toContain('unknown_tool');

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      'stage6_tool_call',
      expect.objectContaining({
        tool: 'write_stuff',
        outcome: 'rejected',
        is_error: true,
        validation_error: { code: 'unknown_tool' },
      })
    );
  });

  test('round counter increments monotonically across calls (STO-01)', async () => {
    // WAVE-2 UPDATE: real-impl dispatchers validate inputs; round counter is
    // incremented by the barrel factory BEFORE the dispatcher runs, so even
    // validation-rejection rows must still increment monotonically. We use
    // VALID inputs so each dispatch logs outcome:'ok' — that keeps the
    // mock.calls array exactly three rows (one per dispatch).
    const logger = mockLogger();
    const session = {
      sessionId: 's1',
      stateSnapshot: { circuits: { 3: { Ze_ohms: '0.1' } } },
      extractedObservations: [],
    };
    const d = createWriteDispatcher(session, logger, 't1', createPerTurnWrites());
    await d(
      {
        tool_call_id: 'tu_1',
        name: 'record_reading',
        input: {
          field: 'Zs_ohms',
          circuit: 3,
          value: '0.5',
          confidence: 1.0,
          source_turn_id: 't1',
        },
      },
      {}
    );
    await d(
      {
        tool_call_id: 'tu_2',
        name: 'clear_reading',
        input: { field: 'Ze_ohms', circuit: 3, reason: 'user_correction' },
      },
      {}
    );
    await d({ tool_call_id: 'tu_3', name: 'create_circuit', input: { circuit_ref: 7 } }, {});
    const rounds = logger.info.mock.calls.map((c) => c[1].round);
    expect(rounds).toEqual([1, 2, 3]);
  });
});

describe('scaffold integrates with Phase 1 runToolLoop (canary)', () => {
  /**
   * INTEGRATION (scaffold-level): proves createWriteDispatcher is usable as
   * runToolLoop's dispatcher arg. Locks Phase 1 contract compatibility BEFORE
   * Plans 02-03/04/06 land. If this test breaks, the scaffold envelope shape
   * has diverged from what Phase 1's loop expects and the fix is here — not
   * downstream.
   *
   * Two rounds:
   *   Round 1 emits a single record_reading tool_use with VALID input
   *           (circuit 3 exists in stateSnapshot). Plan 02-03 real-impl
   *           dispatcher returns {ok: true}.
   *   Round 2 ends the turn with stop_reason: 'end_turn'.
   *
   * The loop accepts the dispatcher envelope as a valid tool_result and
   * proceeds to round 2 cleanly.
   */
  test('createWriteDispatcher drives a 2-round loop and STO-01 row is emitted', async () => {
    const events1 = [
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tu_a', name: 'record_reading' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json:
            '{"field":"Ze_ohms","circuit":3,"value":"0.35","confidence":1.0,"source_turn_id":"t1"}',
        },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ];
    const events2 = [
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ];

    const client = mockClient([events1, events2]);
    const logger = mockLogger();
    const session = {
      sessionId: 's1',
      stateSnapshot: { circuits: { 3: {} } },
      extractedObservations: [],
    };
    const dispatcher = createWriteDispatcher(session, logger, 'turn-1', createPerTurnWrites());

    const result = await runToolLoop({
      client,
      model: 'claude-sonnet-4-6',
      system: 'test',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      dispatcher,
      ctx: { sessionId: 's1', turnId: 'turn-1' },
      logger,
    });

    expect(result.rounds).toBe(2);
    expect(result.stop_reason).toBe('end_turn');
    // STO-01: exactly one 'stage6_tool_call' row from the scaffold NOOP.
    const scaffoldRows = logger.info.mock.calls.filter((c) => c[0] === 'stage6_tool_call');
    expect(scaffoldRows.length).toBe(1);
    expect(scaffoldRows[0][1]).toMatchObject({
      tool: 'record_reading',
      outcome: 'ok',
      is_error: false,
      phase: 2,
      tool_use_id: 'tu_a',
    });
  });
});
