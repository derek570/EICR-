/**
 * Phase 5.3 — STAGE6_MULTI_BOARD flag-routing regression suite.
 *
 * Two responsibilities:
 *
 *   (1) Pin the flag-off path as byte-identical to the legacy behaviour.
 *       Every existing dispatcher test exercises flag-off implicitly (the
 *       env var is unset by default), so this file's flag-off coverage
 *       is intentionally sparse — it just verifies the new wrappers route
 *       to the legacy mutators when the flag is unset.
 *
 *   (2) Pin the flag-on path so that record_reading / clear_reading /
 *       create_circuit / rename_circuit / delete_circuit / record_reading-
 *       in-set_field_for_all_circuits all write to the composite key shape
 *       AND the validators check existence via the composite key. Slice 5.4
 *       migrates the readers (event-bundler etc.) so a flag-on session is
 *       not yet end-to-end functional, but the write side is locked here.
 *
 * Setup / teardown: every test that enables the flag does so in a
 * `beforeEach` and unsets it in `afterEach` so a leak (test exits with
 * the var still set) cannot poison the rest of the suite.
 */

import { jest } from '@jest/globals';
import { createWriteDispatcher } from '../extraction/stage6-dispatchers.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';
import {
  applyReadingFlagAware,
  clearReadingFlagAware,
  upsertCircuitMetaFlagAware,
  renameCircuitFlagAware,
  deleteCircuitFlagAware,
} from '../extraction/stage6-snapshot-mutators.js';
import {
  ensureMultiBoardShape,
  isMultiBoardFlagOn,
  circuitExistsInSnapshot,
} from '../extraction/stage6-multi-board-shape.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeMultiBoardSession(circuitSeeds = {}) {
  // Construct a session-shaped object with the multi-board snapshot shape
  // (boards + currentBoardId) AND any pre-seeded circuit buckets keyed by
  // composite key. Mimics the post-Phase-5.1 constructor state.
  const snapshot = {
    circuits: { ...circuitSeeds },
    pending_readings: [],
    observations: [],
    validation_alerts: [],
  };
  ensureMultiBoardShape(snapshot);
  return { sessionId: 's-flag', stateSnapshot: snapshot, extractedObservations: [] };
}

function makeLegacySession(circuitSeeds = {}) {
  const snapshot = {
    circuits: { ...circuitSeeds },
    pending_readings: [],
    observations: [],
    validation_alerts: [],
    boards: [{ id: 'main', designation: 'DB-1', board_type: 'main' }],
    currentBoardId: 'main',
  };
  return { sessionId: 's-legacy', stateSnapshot: snapshot, extractedObservations: [] };
}

// ---------------------------------------------------------------------------
// isMultiBoardFlagOn — environment plumbing
// ---------------------------------------------------------------------------
describe('isMultiBoardFlagOn', () => {
  const originalFlag = process.env.STAGE6_MULTI_BOARD;
  afterEach(() => {
    if (originalFlag === undefined) delete process.env.STAGE6_MULTI_BOARD;
    else process.env.STAGE6_MULTI_BOARD = originalFlag;
  });

  test('returns false when env var is unset (production default)', () => {
    delete process.env.STAGE6_MULTI_BOARD;
    expect(isMultiBoardFlagOn()).toBe(false);
  });

  test('returns false for any truthy-looking string other than "true"', () => {
    for (const v of ['1', 'yes', 'TRUE', 'on', 'enabled']) {
      process.env.STAGE6_MULTI_BOARD = v;
      expect(isMultiBoardFlagOn()).toBe(false);
    }
  });

  test('returns true ONLY for the literal string "true"', () => {
    process.env.STAGE6_MULTI_BOARD = 'true';
    expect(isMultiBoardFlagOn()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// circuitExistsInSnapshot — flag-aware existence check
// ---------------------------------------------------------------------------
describe('circuitExistsInSnapshot', () => {
  const originalFlag = process.env.STAGE6_MULTI_BOARD;
  afterEach(() => {
    if (originalFlag === undefined) delete process.env.STAGE6_MULTI_BOARD;
    else process.env.STAGE6_MULTI_BOARD = originalFlag;
  });

  test('flag-off: checks legacy flat key', () => {
    delete process.env.STAGE6_MULTI_BOARD;
    const snapshot = makeLegacySession({ 3: { ze: '0.42' } }).stateSnapshot;
    expect(circuitExistsInSnapshot(snapshot, 3)).toBe(true);
    expect(circuitExistsInSnapshot(snapshot, 99)).toBe(false);
  });

  test('flag-off: ignores boardId argument and ignores composite buckets', () => {
    delete process.env.STAGE6_MULTI_BOARD;
    const snapshot = makeLegacySession({
      'main::3': { circuit: 3, board_id: 'main' },
    }).stateSnapshot;
    // Composite-only bucket; no legacy flat key. Flag-off says "doesn't exist".
    expect(circuitExistsInSnapshot(snapshot, 3, 'main')).toBe(false);
  });

  test('flag-on: checks composite key with currentBoardId fallback', () => {
    process.env.STAGE6_MULTI_BOARD = 'true';
    const snapshot = makeMultiBoardSession({
      'main::3': { circuit: 3, board_id: 'main' },
    }).stateSnapshot;
    expect(circuitExistsInSnapshot(snapshot, 3)).toBe(true);
    expect(circuitExistsInSnapshot(snapshot, 99)).toBe(false);
  });

  test('flag-on: explicit boardId scopes the lookup', () => {
    process.env.STAGE6_MULTI_BOARD = 'true';
    const snapshot = makeMultiBoardSession({
      'main::3': { circuit: 3, board_id: 'main' },
      'sub-1::3': { circuit: 3, board_id: 'sub-1' },
    }).stateSnapshot;
    expect(circuitExistsInSnapshot(snapshot, 3, 'main')).toBe(true);
    expect(circuitExistsInSnapshot(snapshot, 3, 'sub-1')).toBe(true);
    expect(circuitExistsInSnapshot(snapshot, 3, 'sub-2')).toBe(false);
  });

  test('flag-on: ignores legacy flat keys (3 in circuits but 3 NOT in main::3)', () => {
    process.env.STAGE6_MULTI_BOARD = 'true';
    // Snapshot has legacy bucket but NO composite bucket — under flag-on,
    // record_reading should treat this circuit as nonexistent (the migration
    // is already in flight for fresh sessions; legacy buckets only survive
    // here from pre-flag-on state).
    const snapshot = makeMultiBoardSession({ 3: { ze: '0.42' } }).stateSnapshot;
    expect(circuitExistsInSnapshot(snapshot, 3)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Mutator wrappers — flag-aware routing
// ---------------------------------------------------------------------------
describe('flag-aware mutator wrappers', () => {
  const originalFlag = process.env.STAGE6_MULTI_BOARD;
  afterEach(() => {
    if (originalFlag === undefined) delete process.env.STAGE6_MULTI_BOARD;
    else process.env.STAGE6_MULTI_BOARD = originalFlag;
  });

  test('flag-off: applyReadingFlagAware writes to legacy flat key', () => {
    delete process.env.STAGE6_MULTI_BOARD;
    const snapshot = makeLegacySession().stateSnapshot;
    applyReadingFlagAware(snapshot, { circuit: 3, field: 'ze', value: '0.42' });
    expect(snapshot.circuits[3]).toEqual({ ze: '0.42' });
    expect(snapshot.circuits['main::3']).toBeUndefined();
  });

  test('flag-on: applyReadingFlagAware writes to composite key with currentBoardId', () => {
    process.env.STAGE6_MULTI_BOARD = 'true';
    const snapshot = makeMultiBoardSession().stateSnapshot;
    applyReadingFlagAware(snapshot, { circuit: 3, field: 'ze', value: '0.42' });
    expect(snapshot.circuits['main::3']).toEqual({ circuit: 3, board_id: 'main', ze: '0.42' });
    expect(snapshot.circuits[3]).toBeUndefined();
  });

  test('flag-on: applyReadingFlagAware honours explicit boardId from input', () => {
    process.env.STAGE6_MULTI_BOARD = 'true';
    const snapshot = makeMultiBoardSession().stateSnapshot;
    snapshot.boards.push({ id: 'sub-1', designation: 'DB-2', board_type: 'sub-distribution' });
    applyReadingFlagAware(snapshot, { circuit: 3, field: 'ze', value: '0.18', boardId: 'sub-1' });
    expect(snapshot.circuits['sub-1::3']).toEqual({ circuit: 3, board_id: 'sub-1', ze: '0.18' });
  });

  test('flag-on: clearReadingFlagAware removes composite-key field', () => {
    process.env.STAGE6_MULTI_BOARD = 'true';
    const snapshot = makeMultiBoardSession({
      'main::3': { circuit: 3, board_id: 'main', ze: '0.42', pfc: '1.5' },
    }).stateSnapshot;
    const r = clearReadingFlagAware(snapshot, { circuit: 3, field: 'ze' });
    expect(r).toEqual({ cleared: true });
    expect(snapshot.circuits['main::3'].ze).toBeUndefined();
    expect(snapshot.circuits['main::3'].pfc).toBe('1.5');
  });

  test('flag-on: upsertCircuitMetaFlagAware creates composite-key bucket', () => {
    process.env.STAGE6_MULTI_BOARD = 'true';
    const snapshot = makeMultiBoardSession().stateSnapshot;
    upsertCircuitMetaFlagAware(snapshot, { circuit_ref: 7, designation: 'Cooker' });
    expect(snapshot.circuits['main::7']).toEqual({
      circuit: 7,
      board_id: 'main',
      designation: 'Cooker',
    });
  });

  test('flag-on: renameCircuitFlagAware rekeys composite key only', () => {
    process.env.STAGE6_MULTI_BOARD = 'true';
    const snapshot = makeMultiBoardSession({
      'main::3': { circuit: 3, board_id: 'main', ze: '0.42' },
    }).stateSnapshot;
    const r = renameCircuitFlagAware(snapshot, { from_ref: 3, circuit_ref: 5 });
    expect(r).toEqual({ ok: true });
    expect(snapshot.circuits['main::3']).toBeUndefined();
    expect(snapshot.circuits['main::5']).toEqual({ circuit: 5, board_id: 'main', ze: '0.42' });
  });

  test('flag-on: deleteCircuitFlagAware removes composite-key bucket', () => {
    process.env.STAGE6_MULTI_BOARD = 'true';
    const snapshot = makeMultiBoardSession({
      'main::3': { circuit: 3, board_id: 'main' },
    }).stateSnapshot;
    const r = deleteCircuitFlagAware(snapshot, { circuit_ref: 3 });
    expect(r).toEqual({ ok: true, deleted: true });
    expect(snapshot.circuits['main::3']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// End-to-end dispatcher invocation under flag-on. Exercises the full pipeline
// (validator → mutator → perTurnWrites → log) so a regression in any of
// validation, mutation, or wrapping surfaces here.
// ---------------------------------------------------------------------------
describe('dispatchers under STAGE6_MULTI_BOARD=true', () => {
  const originalFlag = process.env.STAGE6_MULTI_BOARD;
  beforeEach(() => {
    process.env.STAGE6_MULTI_BOARD = 'true';
  });
  afterEach(() => {
    if (originalFlag === undefined) delete process.env.STAGE6_MULTI_BOARD;
    else process.env.STAGE6_MULTI_BOARD = originalFlag;
  });

  test('record_reading writes via composite-key + validator accepts composite-key existence', async () => {
    const session = makeMultiBoardSession({
      'main::3': { circuit: 3, board_id: 'main' }, // pre-existing bucket so validator accepts
    });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_1',
        name: 'record_reading',
        input: {
          field: 'earth_loop_impedance_ze',
          circuit: 3,
          value: '0.42',
          confidence: 0.9,
          source_turn_id: 't1',
        },
      },
      {}
    );

    expect(result.is_error).toBe(false);
    expect(session.stateSnapshot.circuits['main::3']).toMatchObject({
      circuit: 3,
      board_id: 'main',
      earth_loop_impedance_ze: '0.42',
    });
  });

  test('record_reading is rejected when circuit absent from composite namespace', async () => {
    // Snapshot has the LEGACY bucket but no composite bucket. Flag-on
    // validator looks at composite, says "doesn't exist", dispatcher
    // rejects — strict-mode behaviour is preserved.
    const session = makeMultiBoardSession({ 3: { ze: '0.42' } });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_2',
        name: 'record_reading',
        input: {
          field: 'earth_loop_impedance_ze',
          circuit: 3,
          value: '0.42',
          confidence: 0.9,
          source_turn_id: 't1',
        },
      },
      {}
    );

    expect(result.is_error).toBe(true);
    const body = JSON.parse(result.content);
    expect(body.error.code).toBe('circuit_not_found');
  });

  test('create_circuit writes composite-key bucket', async () => {
    const session = makeMultiBoardSession();
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_3',
        name: 'create_circuit',
        input: {
          circuit_ref: 7,
          designation: 'Cooker',
          phase: 'L1',
          rating_amps: 32,
          cable_csa_mm2: 6,
        },
      },
      {}
    );

    expect(result.is_error).toBe(false);
    expect(session.stateSnapshot.circuits['main::7']).toEqual({
      circuit: 7,
      board_id: 'main',
      designation: 'Cooker',
      phase: 'L1',
      rating_amps: 32,
      cable_csa_mm2: 6,
    });
  });

  test('create_circuit refuses duplicate composite-key bucket', async () => {
    const session = makeMultiBoardSession({
      'main::7': { circuit: 7, board_id: 'main' },
    });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_4',
        name: 'create_circuit',
        input: { circuit_ref: 7 },
      },
      {}
    );

    expect(result.is_error).toBe(true);
    const body = JSON.parse(result.content);
    expect(body.error.code).toBe('circuit_already_exists');
  });

  test('clear_reading clears composite-key field', async () => {
    const session = makeMultiBoardSession({
      'main::3': { circuit: 3, board_id: 'main', earth_loop_impedance_ze: '0.42' },
    });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_5',
        name: 'clear_reading',
        input: { field: 'earth_loop_impedance_ze', circuit: 3, reason: 'cleared by inspector' },
      },
      {}
    );

    expect(result.is_error).toBe(false);
    expect(session.stateSnapshot.circuits['main::3'].earth_loop_impedance_ze).toBeUndefined();
  });

  test('rename_circuit rekeys within the composite namespace', async () => {
    const session = makeMultiBoardSession({
      'main::3': { circuit: 3, board_id: 'main', designation: 'Cooker' },
    });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_6',
        name: 'rename_circuit',
        input: { from_ref: 3, circuit_ref: 5 },
      },
      {}
    );

    expect(result.is_error).toBe(false);
    expect(session.stateSnapshot.circuits['main::3']).toBeUndefined();
    expect(session.stateSnapshot.circuits['main::5']).toMatchObject({
      circuit: 5,
      board_id: 'main',
      designation: 'Cooker',
    });
  });

  test('delete_circuit removes composite-key bucket', async () => {
    const session = makeMultiBoardSession({
      'main::3': { circuit: 3, board_id: 'main' },
    });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_7',
        name: 'delete_circuit',
        input: { circuit_ref: 3 },
      },
      {}
    );

    expect(result.is_error).toBe(false);
    const body = JSON.parse(result.content);
    expect(body.deleted).toBe(true);
    expect(session.stateSnapshot.circuits['main::3']).toBeUndefined();
  });
});
