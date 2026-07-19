/**
 * F/U-5 (marker-② follow-up, 2026-07-19) — the backend must CONSUME the PWA
 * `board_info` containers in job-state ingestion.
 *
 * The bug (found + deferred in the F/U-4 Codex review): board-level fields
 * from the web went STALE in the snapshot because
 *   (a) the TOP-LEVEL `board_info` container — the PRIMARY carrier for
 *       single-board PWA jobs (`boards: null`, the Board tab + regex apply
 *       layer both write it) and iOS's legacy single-board bag — was never
 *       read by `_seedStateFromJobState` OR `_mergeIncomingJobStateIntoSnapshot`;
 *   (b) a nested `boards[].board_info` (the documented PWA JobDetail shape,
 *       web/src/lib/types.ts) rode the shallow board copy into the snapshot
 *       as an unreadable sub-object — the board-local Ze resolver and prompt
 *       rendering read FLAT board keys only.
 *
 * Fix under lock: `flattenBoardRecord` (flat-wins hoist, addressing/proto
 * keys never hoist, the nested key stripped even when malformed) applied at
 * both boards[] ingestion sites + explicit top-level `board_info` → MAIN
 * board record merges with the shared fact-vs-reading precedence.
 * Backend-only; no wire change.
 */

import { jest } from '@jest/globals';
import {
  EICRExtractionSession,
  flattenBoardRecord,
} from '../extraction/eicr-extraction-session.js';
import { dispatchCalculateZs } from '../extraction/stage6-dispatchers-circuit.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';

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

function makeSession(opts = {}) {
  const s = new EICRExtractionSession('test-key', `fu5-${Math.random()}`, 'eicr', opts);
  liveSessions.push(s);
  return s;
}

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function mainRecordOf(s) {
  return (s.stateSnapshot.boards ?? []).find((b) => b && b.id === s.stateSnapshot.currentBoardId);
}

// ───────────────────────────────────────────────────────────────────────────
describe('flattenBoardRecord — pure helper', () => {
  test('hoists nested board_info fields flat and strips the container key', () => {
    const out = flattenBoardRecord({
      id: 'main',
      board_info: { designation: 'Garage CU', ze_at_db: '0.30' },
    });
    expect(out).toEqual({ id: 'main', designation: 'Garage CU', ze_at_db: '0.30' });
  });

  test('FLAT keys always win over nested duplicates', () => {
    const out = flattenBoardRecord({
      id: 'main',
      ze_at_db: '0.28',
      board_info: { ze_at_db: '0.99', designation: 'CU' },
    });
    expect(out.ze_at_db).toBe('0.28');
    expect(out.designation).toBe('CU');
  });

  test('addressing + prototype-dangerous keys never hoist out of the nested blob', () => {
    const nested = JSON.parse(
      '{"id":"evil","board_id":"evil","__proto__":{"polluted":true},"designation":"OK"}'
    );
    const out = flattenBoardRecord({ id: 'main', board_info: nested });
    expect(out.id).toBe('main');
    expect('board_id' in out).toBe(false);
    expect(out.designation).toBe('OK');
    expect({}.polluted).toBeUndefined();
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });

  test('a MALFORMED nested board_info (string / array / null) is stripped, never written through', () => {
    for (const bad of ['junk', ['0.3'], null, 42]) {
      const out = flattenBoardRecord({ id: 'main', designation: 'CU', board_info: bad });
      expect(out).toEqual({ id: 'main', designation: 'CU' });
    }
  });

  test('non-record input and records without board_info pass through untouched', () => {
    expect(flattenBoardRecord(null)).toBe(null);
    expect(flattenBoardRecord('x')).toBe('x');
    const plain = { id: 'main', designation: 'CU' };
    expect(flattenBoardRecord(plain)).toBe(plain);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('F/U-5 seeder — single-board PWA job (boards:null, top-level board_info)', () => {
  test('board_info fields land FLAT on the synth main record; designation overrides the DB-1 scaffold', () => {
    const s = makeSession();
    s.start({
      circuits: [{ ref: 1, designation: 'Cooker' }],
      board_info: { designation: 'Garage CU', ze_at_db: '0.30', main_switch_bs_en: 'EN 60947-3' },
    });
    const main = mainRecordOf(s);
    expect(main.designation).toBe('Garage CU'); // fact overwrites synth 'DB-1'
    expect(main.ze_at_db).toBe('0.30');
    expect(main.main_switch_bs_en).toBe('EN 60947-3');
    expect('board_info' in main).toBe(false);
  });

  test('THE CONSEQUENCE: a board_info-seeded Ze-at-DB is visible to calculate_zs (board-aware chain)', async () => {
    const s = makeSession();
    s.start({
      circuits: [{ ref: 4, designation: 'Upstairs Sockets', r1R2Ohm: '0.86' }],
      board_info: { ze_at_db: '0.35' },
    });
    const perTurnWrites = createPerTurnWrites();
    const res = await dispatchCalculateZs(
      { tool_call_id: 'tu_fu5', name: 'calculate_zs', input: { circuit_ref: 4, all: false } },
      { session: s, logger: mockLogger(), turnId: 't1', perTurnWrites, round: 0 }
    );
    expect(res.is_error).toBe(false);
    const body = JSON.parse(res.content);
    // Pre-fix: board_info was never read → no_ze skip.
    expect(body.skipped).toEqual([]);
    expect(body.computed).toEqual([
      { circuit_ref: 4, field: 'measured_zs_ohm', value: '1.21' }, // 0.35 + 0.86
    ]);
  });

  test('explicit boards[] main-record reading is NOT clobbered by its board_info mirror (fill-only)', () => {
    const s = makeSession();
    s.start({
      circuits: [{ ref: 1 }],
      boards: [{ id: 'main', board_type: 'main', designation: 'CU-A', ze_at_db: '0.25' }],
      board_info: { designation: 'CU-A', ze_at_db: '0.99' },
    });
    const main = mainRecordOf(s);
    expect(main.ze_at_db).toBe('0.25'); // reading: first (authoritative) writer wins
    expect(main.designation).toBe('CU-A');
  });

  test('boards[] entries with NESTED board_info (documented PWA shape) are flattened at seed', () => {
    const s = makeSession();
    s.start({
      circuits: [{ ref: 1 }],
      boards: [
        { id: 'main', board_type: 'main', board_info: { designation: 'CU-A', ze_at_db: '0.25' } },
        { id: 'sub-1', board_type: 'sub-distribution', board_info: { ze: '0.40' } },
      ],
    });
    const main = s.stateSnapshot.boards.find((b) => b.id === 'main');
    const sub = s.stateSnapshot.boards.find((b) => b.id === 'sub-1');
    expect(main.ze_at_db).toBe('0.25');
    expect(main.designation).toBe('CU-A');
    expect('board_info' in main).toBe(false);
    expect(sub.ze).toBe('0.40');
    expect('board_info' in sub).toBe(false);
  });

  test('malformed top-level board_info (array / string / null) is ignored without throwing', () => {
    for (const bad of [['x'], 'junk', null, 7]) {
      const s = makeSession();
      s.start({ circuits: [{ ref: 1 }], board_info: bad });
      const main = mainRecordOf(s);
      expect(main.designation).toBe('DB-1'); // synth scaffold untouched
      expect('0' in main).toBe(false); // no index-spread pollution
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('F/U-5 updateJobState — mid-recording web board edits reach the snapshot', () => {
  test('top-level board_info fills empty cells on the main record (the job_state_update path)', () => {
    const s = makeSession();
    s.start({ circuits: [{ ref: 1 }] });
    s.updateJobState({ board_info: { ze_at_db: '0.31', main_switch_rating_a: '100' } });
    const main = mainRecordOf(s);
    expect(main.ze_at_db).toBe('0.31');
    expect(main.main_switch_rating_a).toBe('100');
  });

  test('a dictated (Sonnet-written) board READING survives a stale board_info mirror; a FACT is refreshed', () => {
    const s = makeSession();
    s.start({ circuits: [{ ref: 1 }] });
    const main = mainRecordOf(s);
    main.ze_at_db = '0.22'; // dictated mid-session
    s.updateJobState({ board_info: { ze_at_db: '0.99', designation: 'Renamed CU' } });
    expect(main.ze_at_db).toBe('0.22'); // reading: fill-only, never clobbered
    expect(main.designation).toBe('Renamed CU'); // fact: client-authoritative
  });

  test('boards[] entries with nested board_info are flattened through the shared precedence merge', () => {
    const s = makeSession();
    s.start({
      circuits: [{ ref: 1 }],
      boards: [{ id: 'sub-1', board_type: 'sub-distribution' }],
    });
    s.updateJobState({
      boards: [{ id: 'sub-1', board_info: { ze: '0.44', designation: 'Loft DB' } }],
    });
    const sub = s.stateSnapshot.boards.find((b) => b.id === 'sub-1');
    expect(sub.ze).toBe('0.44');
    expect(sub.designation).toBe('Loft DB');
    expect('board_info' in sub).toBe(false);
  });

  test('the nested blob NEVER lands on a snapshot board record via the generic field merge (skip-key guard)', () => {
    const s = makeSession();
    s.start({ circuits: [{ ref: 1 }] });
    // Even a hypothetical path that reaches the generic merge with
    // board_info attached must drop the container rather than write it.
    s.updateJobState({ boards: [{ id: 'main', board_info: { ze_at_db: '0.30' } }] });
    const main = mainRecordOf(s);
    expect('board_info' in main).toBe(false);
    expect(main.ze_at_db).toBe('0.30');
  });

  test('malformed board_info shapes are ignored on update without disturbing existing state', () => {
    const s = makeSession();
    s.start({ circuits: [{ ref: 1 }], board_info: { ze_at_db: '0.30' } });
    for (const bad of [['x'], 'junk', 7]) {
      s.updateJobState({ board_info: bad });
    }
    expect(mainRecordOf(s).ze_at_db).toBe('0.30');
  });
});
