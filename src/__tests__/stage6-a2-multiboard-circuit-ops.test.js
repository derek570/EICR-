/**
 * A2-multiboard item 3 (2026-07-28) — circuit-topology ops reach the clients
 * ADDRESSED to the board the server actually mutated, and LOSSLESSLY.
 *
 * Two defects are pinned here.
 *
 * 1. WRONG BOARD. `create_circuit` / `rename_circuit` / `delete_circuit` all
 *    take an OPTIONAL `board_id`, and the overwhelmingly common model call
 *    omits it — the scope comes from the session's `select_board` state. Every
 *    producer pushed the RAW `input.board_id` onto `circuitOps`, so a
 *    `select_board sub-b → delete circuit 2` turn mutated the sub-board
 *    server-side but reached both clients UNSCOPED, where they resolved it
 *    against their own default board and deleted MAIN's circuit 2.
 *
 * 2. LOST OPS. The wire carrier for create/rename is a fold of `op.meta` into
 *    `extracted_readings`, and the fold skips null meta values. A valid
 *    metadata-free `create_circuit` (only `circuit_ref`) therefore emitted
 *    NOTHING, and the subsequent strip of `result.circuit_updates` removed the
 *    only other carrier — the created row reached NEITHER client, so the next
 *    dictated reading for it had no row to land on. A `rename_circuit` that
 *    RENUMBERS likewise lost `from_ref`, so a client could only ADD a row at
 *    the new ref and left the old one behind as a duplicate.
 *
 * The fix stamps the EFFECTIVE board at dispatch (non-enumerable, so
 * `perTurnWrites` snapshots stay byte-identical) and projects it publicly at
 * the ONE wire seam, alongside a lossless create/rename projection.
 */

import { jest } from '@jest/globals';
import { runShadowHarness } from '../extraction/stage6-shadow-harness.js';
import { mockClient } from './helpers/mockStream.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

const MULTI_BOARD = [
  { id: 'main', designation: 'DB-1', board_type: 'main' },
  { id: 'sub-b', designation: 'DB-2', board_type: 'sub', parent_board_id: 'main' },
];

function toolUseRound(calls) {
  const events = [{ type: 'message_start', message: { usage: { input_tokens: 10 } } }];
  calls.forEach((c, i) => {
    events.push({
      type: 'content_block_start',
      index: i,
      content_block: { type: 'tool_use', id: c.id, name: c.name },
    });
    events.push({
      type: 'content_block_delta',
      index: i,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.input) },
    });
    events.push({ type: 'content_block_stop', index: i });
  });
  events.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' } });
  events.push({ type: 'message_stop' });
  return events;
}

function endTurnRound() {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ];
}

function harnessSession(circuits, streams, currentBoardId = 'main') {
  return {
    sessionId: 'a2mb-ops',
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

const run = (session, text) =>
  runShadowHarness(session, text, [], {
    logger: mockLogger(),
    confirmationsEnabled: true,
    utteranceId: `utt-${text.slice(0, 8)}`,
  });

// ---------------------------------------------------------------------------
// 1. Effective-board addressing on every projection.
// ---------------------------------------------------------------------------

describe('A2-multiboard item 3 — circuit ops are addressed to the EFFECTIVE board', () => {
  test('a board_id-less delete after select_board reaches the wire scoped to that board', async () => {
    const session = harnessSession(
      {
        2: { circuit_designation: 'Main sockets' },
        'sub-b::2': { board_id: 'sub-b', circuit: 2, circuit_designation: 'Shed sockets' },
      },
      [
        toolUseRound([
          { id: 'toolu_sel', name: 'select_board', input: { board_id: 'sub-b' } },
          // The model omits board_id — scope comes from select_board. Pre-fix
          // this reached the clients unscoped and deleted MAIN's circuit 2.
          { id: 'toolu_del', name: 'delete_circuit', input: { circuit_ref: 2 } },
        ]),
        endTurnRound(),
      ],
      'main'
    );

    const result = await run(session, 'delete circuit two');
    const deletes = (result.circuit_updates ?? []).filter((u) => u.action === 'delete');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toMatchObject({ circuit: 2, action: 'delete', board_id: 'sub-b' });
  });

  test('a board_id-less create after select_board folds its designation onto that board', async () => {
    const session = harnessSession({}, [
      toolUseRound([
        { id: 'toolu_sel', name: 'select_board', input: { board_id: 'sub-b' } },
        {
          id: 'toolu_new',
          name: 'create_circuit',
          input: { circuit_ref: 4, designation: 'Cooker' },
        },
      ]),
      endTurnRound(),
    ]);

    const result = await run(session, 'circuit four is the cooker');
    const desig = (result.extracted_readings ?? []).find(
      (r) => r.field === 'designation' && r.circuit === 4
    );
    expect(desig).toBeDefined();
    expect(desig.board_id).toBe('sub-b');
  });
});

// ---------------------------------------------------------------------------
// 2. Lossless projection.
// ---------------------------------------------------------------------------

describe('A2-multiboard item 3 — create/rename projections are lossless', () => {
  test('a metadata-free create reaches the wire (pre-fix it reached NEITHER client)', async () => {
    const session = harnessSession({}, [
      toolUseRound([{ id: 'toolu_new', name: 'create_circuit', input: { circuit_ref: 6 } }]),
      endTurnRound(),
    ]);

    const result = await run(session, 'add circuit six');
    // The meta fold emits nothing (every meta value is null) — the ONLY
    // carrier is the legacy-shape circuit_updates projection.
    expect(result.extracted_readings ?? []).toHaveLength(0);
    const creates = (result.circuit_updates ?? []).filter((u) => u.action === 'create');
    expect(creates).toHaveLength(1);
    expect(creates[0]).toEqual({ circuit: 6, designation: '', action: 'create', board_id: 'main' });
  });

  test('a RENUMBERING rename carries from_ref so the client can re-key the old row', async () => {
    const session = harnessSession(
      { 2: { circuit_designation: 'Cooker' } },
      [
        toolUseRound([
          {
            id: 'toolu_ren',
            name: 'rename_circuit',
            input: { from_ref: 2, circuit_ref: 5, designation: 'Cooker' },
          },
        ]),
        endTurnRound(),
      ],
      'main'
    );

    const result = await run(session, 'circuit two is actually circuit five');
    const renames = (result.circuit_updates ?? []).filter((u) => u.action === 'rename');
    expect(renames).toHaveLength(1);
    expect(renames[0]).toMatchObject({
      circuit: 5,
      from_ref: 2,
      action: 'rename',
      designation: 'Cooker',
      board_id: 'main',
    });
  });

  test('a create the meta fold ALREADY represents is not duplicated into circuit_updates', async () => {
    const session = harnessSession({}, [
      toolUseRound([
        {
          id: 'toolu_new',
          name: 'create_circuit',
          input: { circuit_ref: 7, designation: 'Immersion' },
        },
      ]),
      endTurnRound(),
    ]);

    const result = await run(session, 'circuit seven is the immersion');
    // The fold's designation reading already creates the row on both clients;
    // a second carrier would risk a double read-back.
    expect(
      (result.extracted_readings ?? []).some((r) => r.field === 'designation' && r.circuit === 7)
    ).toBe(true);
    expect(result.circuit_updates).toBeUndefined();
  });

  test('the projected designation is always a String (iOS Codable declares it non-optional)', async () => {
    const session = harnessSession({}, [
      toolUseRound([
        { id: 'toolu_a', name: 'create_circuit', input: { circuit_ref: 8 } },
        { id: 'toolu_b', name: 'delete_circuit', input: { circuit_ref: 99 } },
      ]),
      endTurnRound(),
    ]);

    const result = await run(session, 'add eight and drop ninety nine');
    for (const u of result.circuit_updates ?? []) {
      expect(typeof u.designation).toBe('string');
      expect(typeof u.action).toBe('string');
      expect(Number.isInteger(u.circuit)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. The state-change dedupe is board-aware.
// ---------------------------------------------------------------------------

describe('A2-multiboard item 3 — a designation read-back only suppresses its OWN board', () => {
  test("board A's designation reading does not silence board B's create at the same ref", async () => {
    const session = harnessSession({ 3: { circuit_designation: null } }, [
      toolUseRound([
        {
          id: 'toolu_desig_main',
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
        // The dispatchers reject an explicit board_id that differs from the
        // selected board (`wrong_board`), so a cross-board turn ALWAYS looks
        // like this: select, then an unscoped op. That is precisely why the
        // effective board has to be stamped at dispatch.
        { id: 'toolu_sel_sub', name: 'select_board', input: { board_id: 'sub-b' } },
        { id: 'toolu_new_sub', name: 'create_circuit', input: { circuit_ref: 3 } },
      ]),
      endTurnRound(),
    ]);

    const result = await run(session, 'three is the cooker and add three on the sub board');
    const texts = (result.confirmations ?? []).map((c) => c.text);
    // Pre-fix the bare-ref skip Set swallowed the sub-board create entirely —
    // a real state change went unspoken (Audio-First #1).
    expect(texts.some((t) => t.includes('Circuit 3 created'))).toBe(true);
    expect(texts.some((t) => t.includes('Cooker'))).toBe(true);
  });
});
