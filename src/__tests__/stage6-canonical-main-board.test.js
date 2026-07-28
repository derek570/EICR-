/**
 * A2-multiboard (2026-07-28) scope item 5 — CANONICAL-MAIN ATTRIBUTION.
 *
 * "Which board record IS the main board?" was answered by three hand-rolled
 * copies of `!board_type || board_type === 'main'` plus, at the seams that
 * wanted an id, by `getMainBoardId` — whose `boards[0].id` fallthrough answers
 * a DIFFERENT question (which board owns the legacy bare-numeric circuit
 * namespace) and will happily name a SUB-board.
 *
 * These tests pin the shared rule so it cannot drift from its web/iOS mirrors:
 *   1. usable = plain record with a truthy `id` (an id-less record cannot be
 *      an attribution target — nothing can address a write to it);
 *   2. the FIRST usable entry with `board_type` absent or `'main'`;
 *   3. otherwise null / the synthesised default `'main'` identity — never the
 *      first sub-board, never a parent-pointer walk.
 *
 * The backend half is a behaviour-preserving consolidation: every shape that
 * reaches production today resolves identically before and after. The value is
 * the LOCK — these cases are what a future edit to either the helper or a
 * caller has to keep true — plus one deliberate tightening noted below. The
 * behavioural half of item 5 is on web (`board_info` derived from the
 * canonical main rather than array index 0).
 */

import {
  DEFAULT_MAIN_BOARD_ID,
  findCanonicalMainBoard,
  getMainBoardId,
  resolveCanonicalMainBoardId,
} from '../extraction/stage6-multi-board-shape.js';
import { EICRExtractionSession } from '../extraction/eicr-extraction-session.js';

const MAIN = { id: 'main', designation: 'CU-A', board_type: 'main' };
const SUB = { id: 'sub-1', designation: 'Loft DB', board_type: 'sub_distribution' };
const OFF_PEAK = { id: 'op-1', designation: 'Off-Peak Board', board_type: 'off_peak' };

const liveSessions = [];
afterEach(() => {
  for (const s of liveSessions.splice(0)) {
    try {
      s.stop();
    } catch {
      /* teardown only */
    }
  }
});

function makeSession() {
  const s = new EICRExtractionSession('test-key', `canonmain-${Math.random()}`, 'eicr', {});
  liveSessions.push(s);
  return s;
}

describe('findCanonicalMainBoard — the shared rule', () => {
  test('a REORDERED [sub, main] resolves to the main record, not to index 0', () => {
    // The Board tab lets the inspector move boards around, so array order
    // carries no identity. This is the case the web index-0 bug got wrong.
    expect(findCanonicalMainBoard([SUB, MAIN])).toBe(MAIN);
    expect(resolveCanonicalMainBoardId([SUB, MAIN])).toBe('main');
  });

  test('board_type ABSENT counts as main — legacy rows predate the field', () => {
    const legacy = { id: 'db-1', designation: 'DB1' };
    expect(findCanonicalMainBoard([legacy])).toBe(legacy);
    expect(resolveCanonicalMainBoardId([legacy])).toBe('db-1');
  });

  test('[sub, off_peak] has NO main — never crown the first sub-board', () => {
    // Two siblings, neither of which is the main board. `getMainBoardId`
    // answers 'sub-1' here (correctly, for namespace routing); attribution
    // must not.
    expect(findCanonicalMainBoard([SUB, OFF_PEAK])).toBeNull();
    expect(resolveCanonicalMainBoardId([SUB, OFF_PEAK])).toBe(DEFAULT_MAIN_BOARD_ID);
    expect(getMainBoardId({ boards: [SUB, OFF_PEAK] })).toBe('sub-1');
  });

  test('an ID-LESS main-shaped record is not usable — nothing can address a write to it', () => {
    // The deliberate tightening: `{}` reads as "board_type absent ⇒ main", but
    // it has no id, so naming it as the attribution target produces a board no
    // reading can ever be scoped to.
    expect(findCanonicalMainBoard([{}, SUB])).toBeNull();
    expect(findCanonicalMainBoard([{ board_type: 'main' }, SUB])).toBeNull();
    expect(resolveCanonicalMainBoardId([{}, SUB])).toBe(DEFAULT_MAIN_BOARD_ID);
  });

  test('junk entries are skipped rather than short-circuiting the search', () => {
    expect(findCanonicalMainBoard([null, 'junk', 7, [], MAIN])).toBe(MAIN);
  });

  test('a non-array / absent boards list resolves to the default identity', () => {
    for (const bad of [null, undefined, 'main', 7, {}]) {
      expect(findCanonicalMainBoard(bad)).toBeNull();
      expect(resolveCanonicalMainBoardId(bad)).toBe(DEFAULT_MAIN_BOARD_ID);
    }
  });

  test('the empty list resolves to the default identity, not to undefined', () => {
    // The dispatcher/enrichment stamp `'main'` on a boardless job; hydration
    // synthesises the same identity. All three must agree or a client cannot
    // resolve an enriched write on a legacy flat job.
    expect(resolveCanonicalMainBoardId([])).toBe('main');
  });
});

describe('hydration guarantees a canonical main sits at the head of boards[]', () => {
  test('[sub, off_peak] gets the default main identity prepended, and focus lands on it', () => {
    const s = makeSession();
    s.start({
      circuits: [
        { ref: 1, designation: 'Main Cooker' },
        { ref: 1, board_id: 'sub-1', designation: 'Loft Lights' },
      ],
      boards: [SUB, OFF_PEAK],
    });

    expect(findCanonicalMainBoard(s.stateSnapshot.boards)?.id).toBe('main');
    expect(s.stateSnapshot.boards[0].id).toBe('main');
    expect(s.stateSnapshot.currentBoardId).toBe('main');
    // …and because a main record now exists, the namespace router agrees, so
    // the sub-board's circuit 1 keeps its composite key instead of collapsing
    // onto (and overwriting) main's bare-numeric circuit 1.
    expect(getMainBoardId(s.stateSnapshot)).toBe('main');
    expect(s.stateSnapshot.circuits[1].circuit_designation).toBe('Main Cooker');
    expect(s.stateSnapshot.circuits['sub-1::1'].circuit_designation).toBe('Loft Lights');
  });

  test('a REORDERED [sub, main] payload keeps focus on the real main board', () => {
    const s = makeSession();
    s.start({ circuits: [{ ref: 1 }], boards: [SUB, MAIN] });

    expect(s.stateSnapshot.currentBoardId).toBe('main');
    // The payload's order is preserved (web owns board ordering) — only the
    // ATTRIBUTION ignores it.
    expect(s.stateSnapshot.boards.map((b) => b.id)).toEqual(['sub-1', 'main']);
  });

  test('a junk-plus-sub payload keeps the synthesised main identity', () => {
    const s = makeSession();
    s.start({ circuits: [{ ref: 1 }], boards: [{}, SUB] });

    expect(s.stateSnapshot.currentBoardId).toBe('main');
    expect(s.stateSnapshot.boards[0]).toEqual({
      id: 'main',
      designation: 'DB-1',
      board_type: 'main',
    });
    expect(s.stateSnapshot.boards.some((b) => !b || !b.id)).toBe(false);
  });

  test('a sole main-typed payload is hydrated as-is — no phantom board prepended', () => {
    const s = makeSession();
    s.start({ circuits: [{ ref: 1 }], boards: [MAIN] });

    expect(s.stateSnapshot.boards).toHaveLength(1);
    expect(s.stateSnapshot.currentBoardId).toBe('main');
  });
});
