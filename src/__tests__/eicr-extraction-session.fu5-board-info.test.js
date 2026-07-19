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
import { dispatchRecordBoardReading } from '../extraction/stage6-dispatchers-board.js';
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
  test('identity → main record (designation overrides the DB-1 scaffold); FIELDS → circuits[0] (the record_board_reading bucket)', () => {
    const s = makeSession();
    s.start({
      circuits: [{ ref: 1, designation: 'Cooker' }],
      board_info: { designation: 'Garage CU', ze: '0.30', main_switch_bs_en: 'EN 60947-3' },
    });
    const main = mainRecordOf(s);
    expect(main.designation).toBe('Garage CU'); // fact overwrites synth 'DB-1'
    expect('board_info' in main).toBe(false);
    // Codex r1 BLOCKER — fields must land at circuits[0] (where dictation
    // writes and the serialiser reads), NOT on the boards[] record (where a
    // seeded ze would shadow a later dictated correction in the resolver).
    expect('ze' in main).toBe(false);
    expect('main_switch_bs_en' in main).toBe(false);
    expect(s.stateSnapshot.circuits[0].ze).toBe('0.30');
    expect(s.stateSnapshot.circuits[0].main_switch_bs_en).toBe('EN 60947-3');
  });

  test('THE CONSEQUENCE: a board_info-seeded board Ze is visible to calculate_zs (board-aware chain, circuits[0] source)', async () => {
    const s = makeSession();
    s.start({
      circuits: [{ ref: 4, designation: 'Upstairs Sockets', r1R2Ohm: '0.86' }],
      board_info: { ze: '0.35' },
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

  test('Codex r1 BLOCKER pin: when the SAME payload carries boards[], the board_info mirror is NOT applied', () => {
    // Web mirrors boards[0] — the PRIMARY board, which after a reorder may
    // be a SUB-board — into board_info. boards[] is authoritative; the
    // mirror must never stamp a sub-board's identity/readings onto main.
    const s = makeSession();
    s.start({
      circuits: [{ ref: 1 }],
      boards: [
        { id: 'sub-1', board_type: 'sub_distribution', designation: 'Loft DB', ze: '0.55' },
        { id: 'main', board_type: 'main', designation: 'CU-A' },
      ],
      board_info: { designation: 'Loft DB', ze: '0.55' }, // stale mirror of boards[0] (a SUB-board)
    });
    const main = mainRecordOf(s);
    expect(main.id).toBe('main');
    expect(main.designation).toBe('CU-A'); // NOT 'Loft DB'
    expect(s.stateSnapshot.circuits[0]?.ze).toBeUndefined(); // sub-board Ze never lands on main's bucket
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
      expect('0' in (s.stateSnapshot.circuits[0] ?? {})).toBe(false);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('F/U-5 updateJobState — mid-recording web board edits reach the snapshot', () => {
  test('top-level board_info fields fill empty circuits[0] cells; facts land too (the job_state_update path)', () => {
    const s = makeSession();
    s.start({ circuits: [{ ref: 1 }] });
    // Real Board-tab keys (board/page.tsx patchActive): zs_at_db is a
    // measurement, rated_current a device property.
    s.updateJobState({ board_info: { zs_at_db: '0.31', rated_current: '100' } });
    expect(s.stateSnapshot.circuits[0].zs_at_db).toBe('0.31');
    expect(s.stateSnapshot.circuits[0].rated_current).toBe('100');
  });

  test('DICTATED-WINS end-to-end: record_board_reading ze → stale board_info replay → calculate_zs uses the DICTATED value', async () => {
    // The exact shadow scenario the r1 bucket fix exists for: had board_info
    // fields landed on the boards[] record, the stale seeded ze would have
    // outranked the dictated circuits[0] correction in the board-aware
    // resolver (record checked first).
    const s = makeSession();
    s.start({
      circuits: [{ ref: 4, r1R2Ohm: '0.80' }],
      board_info: { ze: '0.35' },
    });
    // Inspector dictates a corrected board Ze mid-session.
    const ptw1 = createPerTurnWrites();
    const dictated = await dispatchRecordBoardReading(
      {
        tool_call_id: 'tu_rbr',
        name: 'record_board_reading',
        input: { field: 'ze', value: '0.20', confidence: 1.0, source_turn_id: 't1' },
      },
      { session: s, logger: mockLogger(), turnId: 't1', perTurnWrites: ptw1, round: 0 }
    );
    expect(dictated.is_error).toBe(false);
    // A stale web job_state_update replays the OLD board_info.
    s.updateJobState({ board_info: { ze: '0.35' } });
    expect(s.stateSnapshot.circuits[0].ze).toBe('0.20'); // fill-only: dictated survives
    const ptw2 = createPerTurnWrites();
    const res = await dispatchCalculateZs(
      { tool_call_id: 'tu_calc', name: 'calculate_zs', input: { circuit_ref: 4, all: false } },
      { session: s, logger: mockLogger(), turnId: 't2', perTurnWrites: ptw2, round: 0 }
    );
    const body = JSON.parse(res.content);
    expect(body.computed).toEqual([
      { circuit_ref: 4, field: 'measured_zs_ohm', value: '1.00' }, // 0.20 + 0.80, NOT 1.15
    ]);
  });

  test('a populated device-property FACT is refreshed by a web edit (Codex r1 IMPORTANT — real Board-tab keys)', () => {
    const s = makeSession();
    s.start({ circuits: [{ ref: 1 }], board_info: { rated_current: '80', manufacturer: 'Hager' } });
    expect(s.stateSnapshot.circuits[0].rated_current).toBe('80');
    // Mid-recording the inspector corrects the device rating on the web form.
    s.updateJobState({ board_info: { rated_current: '100', manufacturer: 'Hager' } });
    expect(s.stateSnapshot.circuits[0].rated_current).toBe('100'); // fact: client-authoritative
    expect(s.stateSnapshot.circuits[0].manufacturer).toBe('Hager');
  });

  test('updater skip pin: board_info is ignored when the sole boards[] entry is a SUB-board mirror', () => {
    const s = makeSession();
    s.start({ circuits: [{ ref: 1 }] });
    s.updateJobState({
      boards: [{ id: 'sub-1', board_type: 'sub_distribution', designation: 'Loft DB' }],
      board_info: { designation: 'Loft DB', ze: '0.55' }, // mirror of a non-main primary
    });
    expect(s.stateSnapshot.circuits[0]?.ze).toBeUndefined();
    expect(mainRecordOf(s).designation).toBe('DB-1'); // untouched
  });

  test('Codex r2 IMPORTANT pin: a sole MAIN board does NOT suppress board_info fields (the regex-apply shape)', () => {
    // The web regex layer writes voice board fields to board_info ONLY —
    // boards[] rides along stale in the same job_state_update. A job whose
    // Board tab has ever been used carries a sole main-typed boards[0]
    // (with a synthesised UUID id) forever, so a blanket boards-present
    // skip would drop every subsequent regex board write.
    const s = makeSession();
    s.start({ circuits: [{ ref: 1 }] });
    s.updateJobState({
      boards: [{ id: 'board-abc123', board_type: 'main', designation: 'Garage CU' }],
      board_info: { designation: 'Garage CU', ze: '0.35', rated_current: '100' },
    });
    // Fields land at circuits[0]…
    expect(s.stateSnapshot.circuits[0].ze).toBe('0.35');
    expect(s.stateSnapshot.circuits[0].rated_current).toBe('100');
    // …but identity stays with the authoritative boards[] record (no mirror
    // overwrite of the record designation via the board_info branch).
    const uuidRecord = s.stateSnapshot.boards.find((b) => b.id === 'board-abc123');
    expect(uuidRecord.designation).toBe('Garage CU');
  });

  test('Codex r2: sole-main fields still respect fill-only — a dictated ze survives the stale sole-main mirror', () => {
    const s = makeSession();
    s.start({ circuits: [{ ref: 1 }], board_info: { ze: '0.35' } });
    s.stateSnapshot.circuits[0].ze = '0.20'; // dictated correction
    s.updateJobState({
      boards: [{ id: 'board-abc123', board_type: 'main' }],
      board_info: { ze: '0.35' }, // stale mirror
    });
    expect(s.stateSnapshot.circuits[0].ze).toBe('0.20');
  });

  test('Codex r2: a boards[] array with NO usable (id-bearing) entries does not suppress full consumption', () => {
    const s = makeSession();
    s.start({ circuits: [{ ref: 1 }] });
    s.updateJobState({
      boards: [null, 'junk', { designation: 'no id here' }],
      board_info: { designation: 'Garage CU', ze: '0.35' },
    });
    expect(s.stateSnapshot.circuits[0].ze).toBe('0.35');
    expect(mainRecordOf(s).designation).toBe('Garage CU'); // identity applied (no authoritative record)
  });

  test('Codex r2: TWO usable boards → genuinely multi-board → board_info skipped entirely', () => {
    const s = makeSession();
    s.start({ circuits: [{ ref: 1 }] });
    s.updateJobState({
      boards: [
        { id: 'sub-1', board_type: 'sub_distribution', designation: 'Loft DB' },
        { id: 'main', board_type: 'main', designation: 'CU-A' },
      ],
      board_info: { designation: 'Loft DB', ze: '0.55' },
    });
    expect(s.stateSnapshot.circuits[0]?.ze).toBeUndefined();
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
    expect(s.stateSnapshot.circuits[0].ze_at_db).toBe('0.30');
  });
});
