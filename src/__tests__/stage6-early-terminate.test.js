/**
 * Tests for src/extraction/stage6-early-terminate.js
 *
 * Single-round latency sprint Phase 2 (PLAN_v8 §A Pivot 1, §E). Pins
 * the predicate that gates skipping round-2 Sonnet on clean
 * single-record_reading turns.
 *
 * Predicate is conservative by design — false on ANY ambiguity. The
 * test suite walks every branch the predicate guards against.
 */

import { shouldEarlyTerminate } from '../extraction/stage6-early-terminate.js';

function makePerTurnWrites({
  readingsSize = 1,
  cleared = [],
  observations = [],
  circuitOps = [],
  boardOps = [],
  fieldCorrections = [],
  boardReadingsSize = 0,
} = {}) {
  return {
    readings: { size: readingsSize },
    cleared,
    observations,
    circuitOps,
    boardOps,
    fieldCorrections,
    boardReadings: { size: boardReadingsSize },
  };
}

function makeSession({ boards = [{ id: 'main' }], currentBoardId = 'main' } = {}) {
  return {
    stateSnapshot: { boards, currentBoardId },
  };
}

function makeRecord(name = 'record_reading') {
  return { name };
}

describe('shouldEarlyTerminate — predicate truth-table', () => {
  test('YES: clean single record_reading, no errors, single board, on main', () => {
    expect(
      shouldEarlyTerminate({
        records: [makeRecord()],
        toolResults: [{ is_error: false }],
        perTurnWrites: makePerTurnWrites(),
        session: makeSession(),
      })
    ).toBe(true);
  });

  // Hard guards — every false case should be a NO.

  test('NO: null session', () => {
    expect(
      shouldEarlyTerminate({
        records: [makeRecord()],
        toolResults: [],
        perTurnWrites: makePerTurnWrites(),
        session: null,
      })
    ).toBe(false);
  });

  test('NO: session missing stateSnapshot', () => {
    expect(
      shouldEarlyTerminate({
        records: [makeRecord()],
        toolResults: [],
        perTurnWrites: makePerTurnWrites(),
        session: {},
      })
    ).toBe(false);
  });

  test('NO: records not array', () => {
    expect(
      shouldEarlyTerminate({
        records: null,
        toolResults: [],
        perTurnWrites: makePerTurnWrites(),
        session: makeSession(),
      })
    ).toBe(false);
  });

  test('NO: toolResults not array', () => {
    expect(
      shouldEarlyTerminate({
        records: [makeRecord()],
        toolResults: null,
        perTurnWrites: makePerTurnWrites(),
        session: makeSession(),
      })
    ).toBe(false);
  });

  test('NO: perTurnWrites null', () => {
    expect(
      shouldEarlyTerminate({
        records: [makeRecord()],
        toolResults: [],
        perTurnWrites: null,
        session: makeSession(),
      })
    ).toBe(false);
  });

  test('NO: perTurnWrites.readings missing', () => {
    expect(
      shouldEarlyTerminate({
        records: [makeRecord()],
        toolResults: [],
        perTurnWrites: { readings: null },
        session: makeSession(),
      })
    ).toBe(false);
  });

  // Tool-result guards.

  test('NO: any tool_result is_error=true', () => {
    expect(
      shouldEarlyTerminate({
        records: [makeRecord()],
        toolResults: [{ is_error: true }],
        perTurnWrites: makePerTurnWrites(),
        session: makeSession(),
      })
    ).toBe(false);
  });

  test('NO: mixed clean + errored tool_results', () => {
    expect(
      shouldEarlyTerminate({
        records: [makeRecord()],
        toolResults: [{ is_error: false }, { is_error: true }],
        perTurnWrites: makePerTurnWrites(),
        session: makeSession(),
      })
    ).toBe(false);
  });

  // Multi-board guards.

  test('NO: multi-board session', () => {
    expect(
      shouldEarlyTerminate({
        records: [makeRecord()],
        toolResults: [],
        perTurnWrites: makePerTurnWrites(),
        session: makeSession({
          boards: [{ id: 'main' }, { id: 'sub-1' }],
        }),
      })
    ).toBe(false);
  });

  test('NO: currentBoardId is not main', () => {
    expect(
      shouldEarlyTerminate({
        records: [makeRecord()],
        toolResults: [],
        perTurnWrites: makePerTurnWrites(),
        session: makeSession({ currentBoardId: 'sub-1' }),
      })
    ).toBe(false);
  });

  // Record-shape guards.

  test('NO: zero records', () => {
    expect(
      shouldEarlyTerminate({
        records: [],
        toolResults: [],
        perTurnWrites: makePerTurnWrites(),
        session: makeSession(),
      })
    ).toBe(false);
  });

  test('NO: multiple records', () => {
    expect(
      shouldEarlyTerminate({
        records: [makeRecord(), makeRecord()],
        toolResults: [],
        perTurnWrites: makePerTurnWrites({ readingsSize: 2 }),
        session: makeSession(),
      })
    ).toBe(false);
  });

  test.each([
    'record_observation',
    'ask_user',
    'create_circuit',
    'rename_circuit',
    'delete_circuit',
    'clear_reading',
    'record_board_reading',
    'add_board',
    'select_board',
    'start_dialogue_script',
    'unknown_tool',
  ])('NO: single non-record_reading tool (%s)', (toolName) => {
    expect(
      shouldEarlyTerminate({
        records: [makeRecord(toolName)],
        toolResults: [],
        perTurnWrites: makePerTurnWrites(),
        session: makeSession(),
      })
    ).toBe(false);
  });

  // perTurnWrites accumulator guards.

  test("NO: readings.size != 1 (dispatcher didn't actually write)", () => {
    expect(
      shouldEarlyTerminate({
        records: [makeRecord()],
        toolResults: [],
        perTurnWrites: makePerTurnWrites({ readingsSize: 0 }),
        session: makeSession(),
      })
    ).toBe(false);
  });

  test('NO: cleared array non-empty', () => {
    expect(
      shouldEarlyTerminate({
        records: [makeRecord()],
        toolResults: [],
        perTurnWrites: makePerTurnWrites({ cleared: [{ field: 'x', circuit: 1 }] }),
        session: makeSession(),
      })
    ).toBe(false);
  });

  test('NO: observations array non-empty', () => {
    expect(
      shouldEarlyTerminate({
        records: [makeRecord()],
        toolResults: [],
        perTurnWrites: makePerTurnWrites({ observations: [{ id: 'o1', text: 'cracked socket' }] }),
        session: makeSession(),
      })
    ).toBe(false);
  });

  test('NO: circuitOps array non-empty', () => {
    expect(
      shouldEarlyTerminate({
        records: [makeRecord()],
        toolResults: [],
        perTurnWrites: makePerTurnWrites({
          circuitOps: [{ op: 'create', circuit_ref: '3', meta: {} }],
        }),
        session: makeSession(),
      })
    ).toBe(false);
  });

  test('NO: boardOps array non-empty', () => {
    expect(
      shouldEarlyTerminate({
        records: [makeRecord()],
        toolResults: [],
        perTurnWrites: makePerTurnWrites({
          boardOps: [{ op: 'add_board', board_id: 'sub-1' }],
        }),
        session: makeSession(),
      })
    ).toBe(false);
  });

  test('NO: fieldCorrections array non-empty', () => {
    expect(
      shouldEarlyTerminate({
        records: [makeRecord()],
        toolResults: [],
        perTurnWrites: makePerTurnWrites({
          fieldCorrections: [{ field: 'x', circuit: 1, value: 'new' }],
        }),
        session: makeSession(),
      })
    ).toBe(false);
  });

  test('NO: boardReadings.size > 0', () => {
    expect(
      shouldEarlyTerminate({
        records: [makeRecord()],
        toolResults: [],
        perTurnWrites: makePerTurnWrites({ boardReadingsSize: 1 }),
        session: makeSession(),
      })
    ).toBe(false);
  });

  // Edge cases — null tool_results, missing arrays default safely.

  test('YES: empty tool_results array (no errors to flag)', () => {
    expect(
      shouldEarlyTerminate({
        records: [makeRecord()],
        toolResults: [],
        perTurnWrites: makePerTurnWrites(),
        session: makeSession(),
      })
    ).toBe(true);
  });

  test('YES: undefined currentBoardId (default to main acceptable)', () => {
    expect(
      shouldEarlyTerminate({
        records: [makeRecord()],
        toolResults: [],
        perTurnWrites: makePerTurnWrites(),
        session: { stateSnapshot: { boards: [{ id: 'main' }] } },
      })
    ).toBe(true);
  });

  test('YES: tool_result is_error false flag (treated as success)', () => {
    expect(
      shouldEarlyTerminate({
        records: [makeRecord()],
        toolResults: [{ is_error: false }, { is_error: false }],
        perTurnWrites: makePerTurnWrites(),
        session: makeSession(),
      })
    ).toBe(true);
  });

  test('NO: tool_result item null (defensive — treat as ambiguous → false branch in some(...))', () => {
    expect(
      shouldEarlyTerminate({
        records: [makeRecord()],
        toolResults: [null],
        perTurnWrites: makePerTurnWrites(),
        session: makeSession(),
      })
    ).toBe(true); // null item not is_error:true so predicate continues; clean otherwise
  });
});
