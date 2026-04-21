/**
 * Stage 6 Phase 2 Plan 02-03 Task 2 — dispatchCreateCircuit + dispatchRenameCircuit tests.
 *
 * WHAT: Locks the real-impl behaviour of the two structural circuit write
 * dispatchers (create_circuit + rename_circuit). Covers happy paths,
 * duplicate rejection, rename source-not-found, rename target-collision,
 * rename-to-same noop, rename-to-same WITH meta (not-noop), rename WITH meta
 * update, PII discipline (no designation in log), invalid numeric-meta types,
 * and the Phase-1-carryover disambiguation test that pins why
 * `rename_circuit` and `create_circuit` are DIFFERENT tools (the former
 * requires `from_ref`).
 *
 * WHY tests invoke through createWriteDispatcher: same rationale as Plan 02-03
 * Task 1 reading test — public-surface coverage exercises the barrel's
 * round-counter closure. `perTurnWrites` is wired through the factory so we
 * observe the accumulator mutations directly.
 *
 * Requirements covered: STD-05 (create_circuit duplicate rejection), STD-06
 * (rename_circuit updates key), STT-01 (per-dispatcher unit coverage), Phase
 * 1 carryover disambiguation (OPEN_QUESTIONS.md Q#3).
 */

import { jest } from '@jest/globals';
import { createWriteDispatcher } from '../extraction/stage6-dispatchers.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeSession(snapshot = { circuits: {} }) {
  return { sessionId: 's-circuit', stateSnapshot: snapshot, extractedObservations: [] };
}

function toolCallRows(logger) {
  return logger.info.mock.calls
    .filter((c) => c[0] === 'stage6_tool_call')
    .map((c) => c[1]);
}

describe('dispatchCreateCircuit', () => {
  test('happy path: snapshot gets new bucket with all meta; perTurnWrites.circuitOps gets {op:create}', async () => {
    const session = makeSession({ circuits: {} });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_cr',
        name: 'create_circuit',
        input: {
          circuit_ref: 5,
          designation: 'Ring final',
          phase: 'L1',
          rating_amps: 32,
          cable_csa_mm2: 2.5,
        },
      },
      {},
    );

    expect(result.is_error).toBe(false);
    expect(JSON.parse(result.content)).toEqual({ ok: true });

    // Snapshot: new bucket with all meta fields populated.
    expect(session.stateSnapshot.circuits[5]).toEqual({
      designation: 'Ring final',
      phase: 'L1',
      rating_amps: 32,
      cable_csa_mm2: 2.5,
    });

    // perTurnWrites.circuitOps: one create op.
    expect(writes.circuitOps).toHaveLength(1);
    expect(writes.circuitOps[0]).toEqual({
      op: 'create',
      circuit_ref: 5,
      meta: {
        designation: 'Ring final',
        phase: 'L1',
        rating_amps: 32,
        cable_csa_mm2: 2.5,
      },
    });

    const rows = toolCallRows(logger);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tool: 'create_circuit',
      outcome: 'ok',
      is_error: false,
      validation_error: null,
      input_summary: { circuit_ref: 5, phase: 'L1' },
    });
  });

  test('duplicate rejection: circuit_ref already exists → {code:"circuit_already_exists"}, snapshot unchanged', async () => {
    const session = makeSession({ circuits: { 5: { designation: 'existing' } } });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const before = JSON.stringify(session.stateSnapshot.circuits);

    const result = await d(
      { tool_call_id: 'tu_dup', name: 'create_circuit', input: { circuit_ref: 5 } },
      {},
    );

    expect(result.is_error).toBe(true);
    const body = JSON.parse(result.content);
    expect(body.ok).toBe(false);
    expect(body.error).toEqual({ code: 'circuit_already_exists', field: 'circuit_ref' });

    // Snapshot unchanged.
    expect(JSON.stringify(session.stateSnapshot.circuits)).toBe(before);
    expect(writes.circuitOps).toHaveLength(0);

    expect(toolCallRows(logger)[0]).toMatchObject({
      tool: 'create_circuit',
      outcome: 'rejected',
      validation_error: { code: 'circuit_already_exists', field: 'circuit_ref' },
    });
  });

  test('null meta: fields NOT written (upsertCircuitMeta null-skip contract)', async () => {
    const session = makeSession({ circuits: {} });
    const d = createWriteDispatcher(session, mockLogger(), 'turn-1', createPerTurnWrites());

    await d(
      {
        tool_call_id: 'tu_null',
        name: 'create_circuit',
        input: {
          circuit_ref: 5,
          designation: null,
          phase: null,
          rating_amps: null,
          cable_csa_mm2: null,
        },
      },
      {},
    );

    // Bucket exists but is empty — mutator skips null-valued keys.
    expect(session.stateSnapshot.circuits[5]).toEqual({});
  });

  test('invalid type rejection: rating_amps as string → {code:"invalid_type"}, snapshot unchanged', async () => {
    const session = makeSession({ circuits: {} });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_bad',
        name: 'create_circuit',
        input: { circuit_ref: 5, rating_amps: 'thirty' },
      },
      {},
    );

    expect(result.is_error).toBe(true);
    const body = JSON.parse(result.content);
    expect(body.error).toEqual({ code: 'invalid_type', field: 'rating_amps' });
    expect(session.stateSnapshot.circuits).toEqual({});
    expect(writes.circuitOps).toHaveLength(0);
  });

  test('PII guard: input_summary contains circuit_ref + phase only; never designation (free-text)', async () => {
    const session = makeSession({ circuits: {} });
    const logger = mockLogger();
    const d = createWriteDispatcher(session, logger, 'turn-1', createPerTurnWrites());

    await d(
      {
        tool_call_id: 'tu_pii',
        name: 'create_circuit',
        input: {
          circuit_ref: 5,
          designation: 'Mr Smith Kitchen',
          phase: 'L1',
          rating_amps: 32,
          cable_csa_mm2: 2.5,
        },
      },
      {},
    );

    const rows = toolCallRows(logger);
    expect(rows).toHaveLength(1);
    expect(rows[0].input_summary).not.toHaveProperty('designation');
    expect(rows[0].input_summary).not.toHaveProperty('rating_amps');
    expect(rows[0].input_summary).not.toHaveProperty('cable_csa_mm2');
    expect(rows[0].input_summary).toEqual({ circuit_ref: 5, phase: 'L1' });
  });
});

describe('dispatchRenameCircuit', () => {
  test('happy path: rekeys bucket, preserves nested readings, pushes {op:rename}', async () => {
    const session = makeSession({ circuits: { 3: { Ze_ohms: '0.35' } } });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_rn',
        name: 'rename_circuit',
        input: { from_ref: 3, circuit_ref: 7 },
      },
      {},
    );

    expect(result.is_error).toBe(false);
    expect(JSON.parse(result.content)).toEqual({ ok: true });

    // Snapshot: old key deleted, new key carries old readings.
    expect(session.stateSnapshot.circuits[3]).toBeUndefined();
    expect(session.stateSnapshot.circuits[7]).toEqual({ Ze_ohms: '0.35' });

    // circuitOps: one rename op.
    expect(writes.circuitOps).toHaveLength(1);
    expect(writes.circuitOps[0]).toMatchObject({
      op: 'rename',
      from_ref: 3,
      circuit_ref: 7,
    });

    expect(toolCallRows(logger)[0]).toMatchObject({
      tool: 'rename_circuit',
      outcome: 'ok',
      is_error: false,
      input_summary: { from_ref: 3, circuit_ref: 7 },
    });
  });

  test('source_not_found: from_ref absent → {code:"source_not_found"}, snapshot unchanged', async () => {
    const session = makeSession({ circuits: {} });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      { tool_call_id: 'tu_snf', name: 'rename_circuit', input: { from_ref: 3, circuit_ref: 7 } },
      {},
    );

    expect(result.is_error).toBe(true);
    const body = JSON.parse(result.content);
    expect(body.error).toEqual({ code: 'source_not_found', field: 'from_ref' });
    expect(session.stateSnapshot.circuits).toEqual({});
    expect(writes.circuitOps).toHaveLength(0);

    expect(toolCallRows(logger)[0]).toMatchObject({
      outcome: 'rejected',
      validation_error: { code: 'source_not_found', field: 'from_ref' },
    });
  });

  test('target_exists: circuit_ref collides with existing bucket → {code:"target_exists"}, NO destructive merge', async () => {
    const session = makeSession({
      circuits: { 3: { Ze_ohms: '0.35' }, 7: { Ze_ohms: '0.99' } },
    });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      { tool_call_id: 'tu_te', name: 'rename_circuit', input: { from_ref: 3, circuit_ref: 7 } },
      {},
    );

    expect(result.is_error).toBe(true);
    const body = JSON.parse(result.content);
    expect(body.error).toEqual({ code: 'target_exists', field: 'circuit_ref' });

    // Snapshot UNCHANGED — both buckets preserved as-is.
    expect(session.stateSnapshot.circuits[3]).toEqual({ Ze_ohms: '0.35' });
    expect(session.stateSnapshot.circuits[7]).toEqual({ Ze_ohms: '0.99' });
    expect(writes.circuitOps).toHaveLength(0);
  });

  test('rename-to-same NOOP: from_ref === circuit_ref with no meta → {ok:true, noop:true, reason:"rename_to_same"}', async () => {
    const session = makeSession({ circuits: { 3: {} } });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_nop',
        name: 'rename_circuit',
        input: { from_ref: 3, circuit_ref: 3 },
      },
      {},
    );

    expect(result.is_error).toBe(false);
    expect(JSON.parse(result.content)).toEqual({
      ok: true,
      noop: true,
      reason: 'rename_to_same',
    });
    expect(writes.circuitOps).toHaveLength(0);

    expect(toolCallRows(logger)[0]).toMatchObject({
      tool: 'rename_circuit',
      outcome: 'noop',
      is_error: false,
    });
  });

  test('rename-to-same WITH meta: meta-only update runs upsert, emits {op:rename} (NOT noop)', async () => {
    const session = makeSession({ circuits: { 3: {} } });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_mu',
        name: 'rename_circuit',
        input: { from_ref: 3, circuit_ref: 3, designation: 'New name' },
      },
      {},
    );

    expect(result.is_error).toBe(false);
    expect(JSON.parse(result.content)).toEqual({ ok: true });
    expect(session.stateSnapshot.circuits[3]).toEqual({ designation: 'New name' });
    expect(writes.circuitOps).toHaveLength(1);
    expect(writes.circuitOps[0]).toMatchObject({
      op: 'rename',
      from_ref: 3,
      circuit_ref: 3,
      meta: expect.objectContaining({ designation: 'New name' }),
    });

    expect(toolCallRows(logger)[0]).toMatchObject({
      tool: 'rename_circuit',
      outcome: 'ok',
    });
  });

  test('rename WITH meta: rekey + meta update on the NEW bucket', async () => {
    const session = makeSession({ circuits: { 3: { Ze_ohms: '0.35' } } });
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_rwm',
        name: 'rename_circuit',
        input: {
          from_ref: 3,
          circuit_ref: 7,
          designation: 'Upstairs sockets',
          phase: 'L2',
        },
      },
      {},
    );

    expect(result.is_error).toBe(false);
    expect(session.stateSnapshot.circuits[3]).toBeUndefined();
    expect(session.stateSnapshot.circuits[7]).toEqual({
      Ze_ohms: '0.35', // rekeyed readings preserved
      designation: 'Upstairs sockets',
      phase: 'L2',
    });
    expect(writes.circuitOps[0]).toMatchObject({
      op: 'rename',
      from_ref: 3,
      circuit_ref: 7,
      meta: expect.objectContaining({
        designation: 'Upstairs sockets',
        phase: 'L2',
      }),
    });
  });

  test('Phase-1-carryover disambiguation: create_circuit(7) on existing 7 rejects; rename_circuit(from:3,to:7) with both existing rejects target_exists', async () => {
    // This pins the contract that `create_circuit` and `rename_circuit` are
    // TWO DIFFERENT TOOLS with DIFFERENT required-fields (rename_circuit
    // requires from_ref). Plan 02-01 Task 2 closed the schema gap; Plan 02-03
    // here pins the behaviour.
    const session = makeSession({ circuits: { 3: { Ze_ohms: '0.35' }, 7: {} } });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    // Attempt 1: create_circuit on existing circuit_ref → circuit_already_exists.
    const createRes = await d(
      { tool_call_id: 'tu_c1', name: 'create_circuit', input: { circuit_ref: 7 } },
      {},
    );
    expect(createRes.is_error).toBe(true);
    expect(JSON.parse(createRes.content).error).toEqual({
      code: 'circuit_already_exists',
      field: 'circuit_ref',
    });

    // Attempt 2: rename_circuit(from_ref:3, circuit_ref:7) → target_exists.
    const renameRes = await d(
      {
        tool_call_id: 'tu_r1',
        name: 'rename_circuit',
        input: { from_ref: 3, circuit_ref: 7 },
      },
      {},
    );
    expect(renameRes.is_error).toBe(true);
    expect(JSON.parse(renameRes.content).error).toEqual({
      code: 'target_exists',
      field: 'circuit_ref',
    });

    // Both attempts produce rejection rows with DIFFERENT validation_error codes.
    const rows = toolCallRows(logger);
    expect(rows).toHaveLength(2);
    expect(rows[0].validation_error.code).toBe('circuit_already_exists');
    expect(rows[1].validation_error.code).toBe('target_exists');
    // Snapshot completely unchanged.
    expect(session.stateSnapshot.circuits[3]).toEqual({ Ze_ohms: '0.35' });
    expect(session.stateSnapshot.circuits[7]).toEqual({});
  });

  test('invalid numeric meta: rating_amps as string → {code:"invalid_type"}, no mutation', async () => {
    const session = makeSession({ circuits: { 3: {} } });
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_it',
        name: 'rename_circuit',
        input: { from_ref: 3, circuit_ref: 7, rating_amps: 'thirty' },
      },
      {},
    );

    expect(result.is_error).toBe(true);
    expect(JSON.parse(result.content).error).toEqual({
      code: 'invalid_type',
      field: 'rating_amps',
    });
    // Snapshot unchanged — validator fires BEFORE rename atom.
    expect(session.stateSnapshot.circuits[3]).toEqual({});
    expect(session.stateSnapshot.circuits[7]).toBeUndefined();
    expect(writes.circuitOps).toHaveLength(0);
  });
});
