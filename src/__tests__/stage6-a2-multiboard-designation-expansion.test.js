/**
 * A2-multiboard (2026-07-28) — the per-op designation READ-BACK expansion is
 * addressed to the EFFECTIVE board, not the raw `board_id` the model omitted.
 *
 * The expansion block (Codex r3-#2) turns N same-turn designation writes on one
 * circuit into N spoken read-backs, each with its own replay-stable
 * `dedupe_token`. Item 3 made its GROUPING and its confirmation LOOKUP
 * effective-board-aware, but the minted replacement entries still read the raw
 * nullable `op.boardId`. `rename_circuit` / `record_reading` omit `board_id` in
 * the common case, so a
 *
 *   select_board main → rename 1 → rename 1 → select_board sub-b → rename 1 → rename 1
 *
 * turn minted `desig_1_<turn>_ord0` / `_ord1` TWICE and emitted no `board_id`
 * at all: `applyConfirmationDebounce` swallowed the sub-board's pair as
 * duplicates, so its designations were written but never spoken (Audio-First #1
 * — the spoken-vs-written split this item exists to close), and the read-backs
 * that did survive were unroutable because the client is only told about a
 * board it can see.
 *
 * The existing §A1a r5-#2 tests cover this collision only when the model passes
 * an EXPLICIT `board_id` on every call, which is the uncommon shape. These pin
 * the omitted-`board_id` path that production actually emits.
 */

import { jest } from '@jest/globals';
import { bundleToolCallsIntoResult } from '../extraction/stage6-event-bundler.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';
import { dispatchRecordReading } from '../extraction/stage6-dispatchers-circuit.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

const MULTI_BOARD = [
  { id: 'main', designation: 'DB-1', board_type: 'main' },
  { id: 'sub-b', designation: 'DB-2', board_type: 'sub', parent_board_id: 'main' },
];

function session(boards, currentBoardId) {
  return {
    sessionId: 'a2mb-designation-expansion',
    stateSnapshot: {
      // Circuit 1 on BOTH boards — legacy bare-numeric key is main's, the
      // composite key is the sub-board's (the dual-shape convention).
      circuits: { 1: {}, 'sub-b::1': { board_id: 'sub-b', circuit: 1 } },
      boards,
      currentBoardId,
      pending_readings: [],
      observations: [],
      validation_alerts: [],
    },
  };
}

/** A rename with `board_id` OMITTED — the shape the model actually emits. */
function rename(s, p, callId, value) {
  return dispatchRecordReading(
    {
      tool_call_id: callId,
      name: 'record_reading',
      input: {
        field: 'circuit_designation',
        circuit: 1,
        value,
        confidence: 0.9,
        source_turn_id: 't1',
      },
    },
    { session: s, logger: mockLogger(), turnId: 't1', perTurnWrites: p, round: 0, callId }
  );
}

const bundle = (p) =>
  bundleToolCallsIntoResult(p, { questions: [] }, { confirmationsEnabled: true, turnId: 'turn-9' });

const desigsOf = (r) => r.confirmations.filter((c) => c.field === 'circuit_designation');

describe('A2-multiboard — designation read-back expansion is board-addressed', () => {
  test('DISCRIMINATING: two boards, `board_id` omitted on every call — four distinct tokens, each board-addressed', async () => {
    const s = session(MULTI_BOARD, 'main');
    const p = createPerTurnWrites();

    await rename(s, p, 'r1', 'Kitchen');
    await rename(s, p, 'r2', 'Kitchen sockets');
    // `select_board sub-b` — the dispatcher mutates `currentBoardId`, the only
    // input to the following calls' effective-board resolution.
    s.stateSnapshot.currentBoardId = 'sub-b';
    await rename(s, p, 'r3', 'Garage');
    await rename(s, p, 'r4', 'Garage sockets');

    const desigs = desigsOf(bundle(p));
    // Two ops per board, each expanded — all four must speak.
    expect(desigs).toHaveLength(4);

    const tokens = desigs.map((c) => c.dedupe_token);
    // Pre-fix these were ['desig_1_turn-9_ord0','desig_1_turn-9_ord1'] TWICE:
    // the client debounce swallowed the sub-board's pair outright.
    expect(new Set(tokens).size).toBe(4);
    expect([...tokens].sort()).toEqual([
      'desig_1_main_turn-9_ord0',
      'desig_1_main_turn-9_ord1',
      'desig_1_sub-b_turn-9_ord0',
      'desig_1_sub-b_turn-9_ord1',
    ]);

    // Each read-back is addressed to the board the server actually mutated —
    // pre-fix every entry was board-less and therefore unroutable.
    const byValue = Object.fromEntries(desigs.map((c) => [c.text, c.board_id]));
    for (const [text, boardId] of Object.entries(byValue)) {
      expect([text, boardId]).toEqual([text, /Garage/.test(text) ? 'sub-b' : 'main']);
    }
  });

  test('a single-board turn is byte-identical — no board suffix, no `board_id` key', async () => {
    const s = session([MULTI_BOARD[0]], 'main');
    const p = createPerTurnWrites();

    await rename(s, p, 'r1', 'Kitchen');
    await rename(s, p, 'r2', 'Kitchen sockets');

    const desigs = desigsOf(bundle(p));
    expect(desigs).toHaveLength(2);
    // The enrichment rule is cross-board-only for ordinary readings, so there
    // is no wire `board_id` and the token keeps its pre-A2 bytes — which is
    // what keeps the pinned iOS/web hash vectors valid.
    expect(desigs.map((c) => c.dedupe_token)).toEqual([
      'desig_1_turn-9_ord0',
      'desig_1_turn-9_ord1',
    ]);
    expect(desigs.every((c) => !Object.hasOwn(c, 'board_id'))).toBe(true);
  });
});
