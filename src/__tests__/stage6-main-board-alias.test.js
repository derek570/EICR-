/**
 * The `"main"` BOARD-ALIAS canonicalisation (2026-08-06).
 *
 * Provenance — the first live Plan-00 field session, backend log turn-10 of
 * session 10A27714-B5F5-44EA-A75A-35EFAEA1577E:
 *
 *   record_reading  {field: measured_zs_ohm, circuit: 2, board_id: "main"}
 *     -> rejected  wrong_board  expected "8C436C74-EC77-47C0-8629-2D033C03F31F"
 *   select_board    {board_id: "8C436C74-EC77-47C0-8629-2D033C03F31F"}
 *     -> ok  (the board was ALREADY current — iOS logged
 *             board_op_select_board_noop)
 *
 * ...and that was the whole turn. The reading was never retried. A dictated Zs
 * was silently lost, and the only thing the inspector heard was "Switched
 * board" — which made a failed turn sound productive.
 *
 * `"main"` is a board TYPE, not a board id. On a CCU-derived job every board
 * carries a UUID, so a model saying `board_id: "main"` — meaning "the main
 * board" — is stating a CORRECT intention in an unaddressable spelling. The
 * rejection is a routing artefact, not a real cross-board write.
 *
 * The canonicalisation is deliberately narrow. It fires ONLY when the alias
 * provably denotes the board already selected, so its entire blast radius is
 * "converts a guaranteed rejection into the write the inspector asked for":
 *
 *   1. no board literally has id `'main'`  — on legacy/synthesised snapshots
 *      `'main'` IS a real id and the exact-match path already works. Never
 *      shadow a real id.
 *   2. the CANONICAL main board is the CURRENT board — if the inspector is
 *      standing at a sub-board, `board_id:'main'` is a genuine cross-board
 *      write and must still reject. Silently retargeting it at the sub-board
 *      would write one board's reading onto another's certificate.
 *   3. the dispatcher opted in by passing a snapshot — the three exempt
 *      board dispatchers pass none, so their reject-on-alias behaviour is
 *      unchanged (pinned at the bottom of this file).
 */

import { jest } from '@jest/globals';
import {
  normaliseBoardScopeInput,
  resolveCanonicalMainBoardId,
} from '../extraction/stage6-multi-board-shape.js';
import { dispatchRecordReading } from '../extraction/stage6-dispatchers-circuit.js';
import {
  dispatchSelectBoard,
  dispatchClearBoardReading,
  dispatchRecordBoardReading,
} from '../extraction/stage6-dispatchers-board.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

/** The field job's shape: every board a UUID, no board literally named 'main'. */
const MAIN_UUID = '8C436C74-EC77-47C0-8629-2D033C03F31F';
const SUB_UUID = 'B1E0A2D9-1111-4444-9999-2D033C03F31F';

function uuidBoards() {
  return [
    { id: MAIN_UUID, designation: 'DB-1', board_type: 'main' },
    {
      id: SUB_UUID,
      designation: 'DB-2',
      board_type: 'sub_distribution',
      parent_board_id: MAIN_UUID,
    },
  ];
}

function makeSession({ boards = uuidBoards(), currentBoardId = MAIN_UUID, circuits = {} } = {}) {
  return {
    sessionId: 'main-alias',
    certType: 'eicr',
    stateSnapshot: {
      circuits,
      boards,
      currentBoardId,
      pending_readings: [],
      observations: [],
      validation_alerts: [],
    },
    extractedObservations: [],
  };
}

function ctx(session, perTurnWrites, extra = {}) {
  return {
    session,
    logger: mockLogger(),
    turnId: 't1',
    perTurnWrites,
    round: 0,
    hasBoardClearV1: true,
    ...extra,
  };
}

const body = (env) => JSON.parse(env.content);

// ───────────────────────────────────────────────────────────────────────────
describe('normaliseBoardScopeInput — the "main" alias', () => {
  test('deletes the alias when the canonical main board IS the current board', () => {
    const snapshot = makeSession().stateSnapshot;
    expect(resolveCanonicalMainBoardId(snapshot.boards)).toBe(MAIN_UUID);

    const input = { field: 'measured_zs_ohm', circuit: 2, board_id: 'main' };
    const returned = normaliseBoardScopeInput(input, snapshot);

    // Identity preserved — dispatchRecordReading mutates call.input in place
    // (coercion, then the impedance clamp) so the snapshot write and the wire
    // mirror cannot hold different values.
    expect(returned).toBe(input);
    // Deleted, not rewritten to the UUID: "absent" is the one unscoped
    // spelling every downstream reader already agrees on.
    expect('board_id' in input).toBe(false);
  });

  test('PRESERVES the alias when a board literally has id "main"', () => {
    // Legacy / synthesised snapshot. Here 'main' is a REAL id and the ordinary
    // exact-match path already succeeds — canonicalising would shadow it.
    const snapshot = makeSession({
      boards: [{ id: 'main', designation: 'DB-1', board_type: 'main' }],
      currentBoardId: 'main',
    }).stateSnapshot;

    const input = { board_id: 'main' };
    normaliseBoardScopeInput(input, snapshot);
    expect(input.board_id).toBe('main');
  });

  test('PRESERVES the alias when the inspector is standing at a SUB board', () => {
    // This is a genuine cross-board write. Retargeting it at the sub-board
    // would put the main board's reading on the sub-board's certificate — far
    // worse than the rejection. It must still reject (audibly — see the
    // wrong_board partial-failure family).
    const snapshot = makeSession({ currentBoardId: SUB_UUID }).stateSnapshot;

    const input = { board_id: 'main' };
    normaliseBoardScopeInput(input, snapshot);
    expect(input.board_id).toBe('main');
  });

  test('PRESERVES the alias when no snapshot is passed (the exempt dispatchers)', () => {
    const input = { board_id: 'main' };
    normaliseBoardScopeInput(input);
    expect(input.board_id).toBe('main');
  });

  test('the empty-string rule is untouched, and other ids still pass through', () => {
    const snapshot = makeSession().stateSnapshot;

    const empty = { board_id: '' };
    normaliseBoardScopeInput(empty, snapshot);
    expect('board_id' in empty).toBe(false);

    // The broadcast sentinel is not a board id.
    const star = { board_id: '*' };
    expect(normaliseBoardScopeInput(star, snapshot).board_id).toBe('*');

    // A real sub-board id is a real scope.
    const sub = { board_id: SUB_UUID };
    expect(normaliseBoardScopeInput(sub, snapshot).board_id).toBe(SUB_UUID);

    // Non-objects pass through rather than throwing.
    expect(normaliseBoardScopeInput(null, snapshot)).toBeNull();
    expect(normaliseBoardScopeInput(undefined, snapshot)).toBeUndefined();
  });

  test('a snapshot with no boards array leaves the alias alone', () => {
    // Nothing to resolve against — fail closed rather than guess.
    const input = { board_id: 'main' };
    normaliseBoardScopeInput(input, { currentBoardId: MAIN_UUID });
    expect(input.board_id).toBe('main');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('record_reading — the exact field regression', () => {
  test('the lost Zs is now WRITTEN instead of rejected as wrong_board', async () => {
    const session = makeSession({ circuits: { 2: { circuit: 2, designation: 'Sockets' } } });
    const p = createPerTurnWrites();

    const env = await dispatchRecordReading(
      {
        tool_call_id: 'call_CsZQjG0pXVJpDrSXr4PGzCIU',
        name: 'record_reading',
        input: {
          field: 'measured_zs_ohm',
          circuit: 2,
          value: '0.42',
          confidence: 0.9,
          source_turn_id: 't1',
          board_id: 'main',
        },
      },
      ctx(session, p)
    );

    const out = body(env);
    expect(out.ok).toBe(true);
    // Landed on the board the inspector was actually standing at.
    expect(session.stateSnapshot.circuits[2].measured_zs_ohm).toBe('0.42');
    expect(p.readings.size).toBe(1);
  });

  test('the same call from a SUB board still rejects — nothing is written', async () => {
    const session = makeSession({
      currentBoardId: SUB_UUID,
      circuits: { [`${SUB_UUID}::2`]: { board_id: SUB_UUID, circuit: 2 } },
    });
    const p = createPerTurnWrites();

    const env = await dispatchRecordReading(
      {
        tool_call_id: 'w2',
        name: 'record_reading',
        input: {
          field: 'measured_zs_ohm',
          circuit: 2,
          value: '0.42',
          confidence: 0.9,
          source_turn_id: 't1',
          board_id: 'main',
        },
      },
      ctx(session, p)
    );

    const out = body(env);
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe('wrong_board');
    expect(session.stateSnapshot.circuits[`${SUB_UUID}::2`].measured_zs_ohm).toBeUndefined();
    expect(p.readings.size).toBe(0);

    // …but it is no longer SILENT. A genuine cross-board write must still be
    // refused, and the inspector must hear that it was refused — otherwise the
    // canonicalisation above has merely narrowed the silent-loss window rather
    // than closing it. The rejection stages a `wrong_board` partial-failure
    // notice (its own accumulator, per plan 2A §3.1's structural separation).
    expect(p.partialFailureNotices).toHaveLength(1);
    expect(p.partialFailureNotices[0]).toMatchObject({
      reason: 'wrong_board',
      producer: 'record_reading_wrong_board',
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('EXEMPT dispatchers — the alias must still REJECT', () => {
  // Same reasoning as the empty-string exemptions: these are identity,
  // destructive and authoritative writes. They pass no snapshot, so the
  // canonicalisation cannot reach them. Pins, not aspirations.

  test('select_board rejects "main" as board_not_found on a UUID job', async () => {
    // The field trace shows the model recovering with the real UUID, not the
    // alias — but if it ever sends the alias, an unresolvable SELECTION must
    // fail loudly rather than silently confirm a board change that never
    // happened.
    const session = makeSession();
    const p = createPerTurnWrites();
    const env = await dispatchSelectBoard(
      {
        tool_call_id: 's1',
        name: 'select_board',
        input: { board_id: 'main', source_turn_id: 't1' },
      },
      ctx(session, p)
    );
    const out = body(env);
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe('board_not_found');
    expect(session.stateSnapshot.currentBoardId).toBe(MAIN_UUID);
    expect(p.boardOps.length).toBe(0);
  });

  test('clear_board_reading rejects "main" — the destructive-clear contract holds', async () => {
    const session = makeSession();
    session.stateSnapshot.boards[0].ze = '0.35';
    const p = createPerTurnWrites();
    const env = await dispatchClearBoardReading(
      {
        tool_call_id: 'cb1',
        name: 'clear_board_reading',
        input: { field: 'ze', reason: 'wrong board', source_turn_id: 't1', board_id: 'main' },
      },
      ctx(session, p)
    );
    const out = body(env);
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe('wrong_board');
    expect(session.stateSnapshot.boards[0].ze).toBe('0.35');
  });

  test('record_board_reading rejects "main" — same reject-before-mutate guard', async () => {
    const session = makeSession();
    const p = createPerTurnWrites();
    const env = await dispatchRecordBoardReading(
      {
        tool_call_id: 'rb1',
        name: 'record_board_reading',
        input: {
          field: 'ze',
          value: '0.28',
          confidence: 0.9,
          source_turn_id: 't1',
          board_id: 'main',
        },
      },
      ctx(session, p)
    );
    const out = body(env);
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe('wrong_board');
    expect(session.stateSnapshot.boards[0].ze ?? null).toBeNull();
    expect(p.boardReadings.size).toBe(0);
  });
});
