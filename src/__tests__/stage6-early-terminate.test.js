/**
 * Tests for src/extraction/stage6-early-terminate.js
 *
 * Single-round latency sprint Phase 2 (PLAN_v8 §A Pivot 1, §E). Pins
 * the predicate that gates skipping round-2 Sonnet on clean
 * single-record_reading turns.
 *
 * 2026-05-28 widening: predicate now also fires on:
 *   - record_board_reading (single bucket: perTurnWrites.boardReadings)
 *   - N≥1 records of the allowed set (was strict records.length===1)
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

  test('NO: perTurnWrites.boardReadings missing', () => {
    expect(
      shouldEarlyTerminate({
        records: [makeRecord()],
        toolResults: [],
        perTurnWrites: { readings: { size: 1 } },
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

  // Multi-board guards — record_reading branch only.

  test('NO: multi-board session with record_reading', () => {
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

  test('NO: record_reading + currentBoardId != main (multi-board)', () => {
    expect(
      shouldEarlyTerminate({
        records: [makeRecord()],
        toolResults: [],
        perTurnWrites: makePerTurnWrites(),
        session: makeSession({
          boards: [{ id: 'main' }, { id: 'sub-1' }],
          currentBoardId: 'sub-1',
        }),
      })
    ).toBe(false);
  });

  // Record-shape guards.

  test('NO: zero records', () => {
    expect(
      shouldEarlyTerminate({
        records: [],
        toolResults: [],
        perTurnWrites: makePerTurnWrites({ readingsSize: 0 }),
        session: makeSession(),
      })
    ).toBe(false);
  });

  test('YES: multiple record_readings, bucket matches count', () => {
    // 2026-05-28 widening: N≥1 same-class records OK.
    expect(
      shouldEarlyTerminate({
        records: [makeRecord(), makeRecord()],
        toolResults: [{ is_error: false }, { is_error: false }],
        perTurnWrites: makePerTurnWrites({ readingsSize: 2 }),
        session: makeSession(),
      })
    ).toBe(true);
  });

  test.each([
    'record_observation',
    'ask_user',
    'create_circuit',
    'rename_circuit',
    'delete_circuit',
    'clear_reading',
    'add_board',
    'select_board',
    'start_dialogue_script',
    'unknown_tool',
  ])('NO: single non-allowed tool (%s)', (toolName) => {
    expect(
      shouldEarlyTerminate({
        records: [makeRecord(toolName)],
        toolResults: [],
        perTurnWrites: makePerTurnWrites(),
        session: makeSession(),
      })
    ).toBe(false);
  });

  test('NO: mixed allowed + disallowed tool names', () => {
    expect(
      shouldEarlyTerminate({
        records: [makeRecord('record_reading'), makeRecord('clear_reading')],
        toolResults: [],
        perTurnWrites: makePerTurnWrites({
          readingsSize: 1,
          cleared: [{ field: 'x', circuit: 1 }],
        }),
        session: makeSession(),
      })
    ).toBe(false);
  });

  // perTurnWrites accumulator guards.

  test("NO: readings bucket size doesn't match record_reading count", () => {
    expect(
      shouldEarlyTerminate({
        records: [makeRecord()],
        toolResults: [],
        perTurnWrites: makePerTurnWrites({ readingsSize: 0 }),
        session: makeSession(),
      })
    ).toBe(false);
  });

  test('NO: readings bucket overshoots record count (impossible but defensive)', () => {
    expect(
      shouldEarlyTerminate({
        records: [makeRecord()],
        toolResults: [],
        perTurnWrites: makePerTurnWrites({ readingsSize: 2 }),
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

  test('NO: boardReadings non-empty but no record_board_reading streamed', () => {
    // Bucket size mismatch — record was record_reading but boardReadings has 1.
    expect(
      shouldEarlyTerminate({
        records: [makeRecord('record_reading')],
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

  test('YES: tool_result item null (predicate continues; clean otherwise)', () => {
    expect(
      shouldEarlyTerminate({
        records: [makeRecord()],
        toolResults: [null],
        perTurnWrites: makePerTurnWrites(),
        session: makeSession(),
      })
    ).toBe(true);
  });

  // === 2026-05-28 widening: record_board_reading ===

  test('YES: clean single record_board_reading on multi-board, current sub-board', () => {
    expect(
      shouldEarlyTerminate({
        records: [makeRecord('record_board_reading')],
        toolResults: [{ is_error: false }],
        perTurnWrites: makePerTurnWrites({ readingsSize: 0, boardReadingsSize: 1 }),
        session: makeSession({
          boards: [{ id: 'main' }, { id: 'sub-1' }],
          currentBoardId: 'sub-1',
        }),
      })
    ).toBe(true);
  });

  test('YES: clean single record_board_reading on single-board session', () => {
    // record_board_reading is uncommon on single-board sessions but still safe.
    expect(
      shouldEarlyTerminate({
        records: [makeRecord('record_board_reading')],
        toolResults: [],
        perTurnWrites: makePerTurnWrites({ readingsSize: 0, boardReadingsSize: 1 }),
        session: makeSession(),
      })
    ).toBe(true);
  });

  test('YES: multiple record_board_readings, bucket matches count', () => {
    expect(
      shouldEarlyTerminate({
        records: [makeRecord('record_board_reading'), makeRecord('record_board_reading')],
        toolResults: [{ is_error: false }, { is_error: false }],
        perTurnWrites: makePerTurnWrites({ readingsSize: 0, boardReadingsSize: 2 }),
        session: makeSession({
          boards: [{ id: 'main' }, { id: 'sub-1' }],
          currentBoardId: 'sub-1',
        }),
      })
    ).toBe(true);
  });

  test('YES: mixed record_reading + record_board_reading on single-board', () => {
    expect(
      shouldEarlyTerminate({
        records: [makeRecord('record_reading'), makeRecord('record_board_reading')],
        toolResults: [{ is_error: false }, { is_error: false }],
        perTurnWrites: makePerTurnWrites({ readingsSize: 1, boardReadingsSize: 1 }),
        session: makeSession(),
      })
    ).toBe(true);
  });

  test('NO: mixed record_reading + record_board_reading on multi-board sub-board', () => {
    // record_reading on sub-board still risks board-switch follow-up, gate kicks in.
    expect(
      shouldEarlyTerminate({
        records: [makeRecord('record_reading'), makeRecord('record_board_reading')],
        toolResults: [{ is_error: false }, { is_error: false }],
        perTurnWrites: makePerTurnWrites({ readingsSize: 1, boardReadingsSize: 1 }),
        session: makeSession({
          boards: [{ id: 'main' }, { id: 'sub-1' }],
          currentBoardId: 'sub-1',
        }),
      })
    ).toBe(false);
  });

  test("NO: record_board_reading streamed but boardReadings bucket didn't write", () => {
    expect(
      shouldEarlyTerminate({
        records: [makeRecord('record_board_reading')],
        toolResults: [],
        perTurnWrites: makePerTurnWrites({ readingsSize: 0, boardReadingsSize: 0 }),
        session: makeSession({
          boards: [{ id: 'main' }, { id: 'sub-1' }],
          currentBoardId: 'sub-1',
        }),
      })
    ).toBe(false);
  });

  test('NO: record_board_reading with errored tool_result', () => {
    expect(
      shouldEarlyTerminate({
        records: [makeRecord('record_board_reading')],
        toolResults: [{ is_error: true }],
        perTurnWrites: makePerTurnWrites({ readingsSize: 0, boardReadingsSize: 1 }),
        session: makeSession({
          boards: [{ id: 'main' }, { id: 'sub-1' }],
          currentBoardId: 'sub-1',
        }),
      })
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2026-06-12 — derived boardReadings entries (bonding-continuity mirror,
// stage6-dispatchers-board.js step 4b) carry no streamed tool call. The
// parity check must subtract them or every clean bonding-service PASS turn
// forfeits the round-1 early-terminate latency win.
// ---------------------------------------------------------------------------
describe('shouldEarlyTerminate — derived boardReadings entries', () => {
  function makeBoardReadingsMap(entries) {
    return new Map(entries);
  }

  test('YES: one streamed board write + one derived mirror entry still early-terminates', () => {
    const writes = makePerTurnWrites({ readingsSize: 0 });
    writes.boardReadings = makeBoardReadingsMap([
      ['bonding_water', { value: 'PASS' }],
      ['bonding_conductor_continuity', { value: 'PASS', auto_resolved: true, derived: true }],
    ]);
    expect(
      shouldEarlyTerminate({
        records: [makeRecord('record_board_reading')],
        toolResults: [{ is_error: false }],
        perTurnWrites: writes,
        session: makeSession(),
      })
    ).toBe(true);
  });

  test('NO: a non-derived surplus entry still blocks early-terminate', () => {
    const writes = makePerTurnWrites({ readingsSize: 0 });
    writes.boardReadings = makeBoardReadingsMap([
      ['bonding_water', { value: 'PASS' }],
      ['bonding_gas', { value: 'PASS' }],
    ]);
    expect(
      shouldEarlyTerminate({
        records: [makeRecord('record_board_reading')],
        toolResults: [{ is_error: false }],
        perTurnWrites: writes,
        session: makeSession(),
      })
    ).toBe(false);
  });

  test('YES: two streamed bonding writes + one derived entry', () => {
    const writes = makePerTurnWrites({ readingsSize: 0 });
    writes.boardReadings = makeBoardReadingsMap([
      ['bonding_water', { value: 'PASS' }],
      ['bonding_gas', { value: 'PASS' }],
      ['bonding_conductor_continuity', { value: 'PASS', auto_resolved: true, derived: true }],
    ]);
    expect(
      shouldEarlyTerminate({
        records: [makeRecord('record_board_reading'), makeRecord('record_board_reading')],
        toolResults: [{ is_error: false }, { is_error: false }],
        perTurnWrites: writes,
        session: makeSession(),
      })
    ).toBe(true);
  });
});
