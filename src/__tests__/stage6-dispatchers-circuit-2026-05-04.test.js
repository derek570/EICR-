/**
 * Stage 6 — behavioural tests for the three tools added 2026-05-04
 * (delete_circuit, calculate_zs, calculate_r1_plus_r2). Each surfaced from
 * the field test 07635782 (08:24 BST) where:
 *   - "delete circuit 2" said twice was silently dropped (no tool existed)
 *   - "calculate the Zs for ..." produced 3 empty turns (no tool existed)
 *
 * Test contract: this file owns the per-tool semantics. The dispatcher-barrel
 * test (stage6-dispatcher-barrel.test.js) covers wiring; this file covers the
 * actual outcomes — never-overwrite, idempotent delete, ring-vs-radial method
 * selection, and the structured `skipped[]` envelope Sonnet uses to decide
 * what to read back.
 */

import { jest } from '@jest/globals';
import {
  dispatchDeleteCircuit,
  dispatchCalculateZs,
  dispatchCalculateR1PlusR2,
} from '../extraction/stage6-dispatchers-circuit.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeCtx({ circuits = {}, observations = [] } = {}) {
  const session = {
    sessionId: 's_test',
    stateSnapshot: { circuits },
    extractedObservations: observations,
  };
  return {
    session,
    logger: mockLogger(),
    turnId: 't1',
    perTurnWrites: createPerTurnWrites(),
    round: 1,
  };
}

function parseEnv(env) {
  return JSON.parse(env.content);
}

// ===========================================================================
// delete_circuit
// ===========================================================================

describe('dispatchDeleteCircuit', () => {
  test('removes an existing circuit from the snapshot', async () => {
    const ctx = makeCtx({
      circuits: {
        1: { designation: 'Cooker' },
        2: { designation: 'Upstairs lighting' },
      },
    });
    const env = await dispatchDeleteCircuit(
      { tool_call_id: 'tu1', name: 'delete_circuit', input: { circuit_ref: 2 } },
      ctx
    );
    expect(env.is_error).toBe(false);
    expect(parseEnv(env)).toEqual({ ok: true, deleted: true });
    expect(ctx.session.stateSnapshot.circuits[2]).toBeUndefined();
    expect(ctx.session.stateSnapshot.circuits[1]).toBeDefined();
    // perTurnWrites carries the op so the iOS translation layer can re-emit
    // it in the legacy {circuit, designation, action} shape.
    expect(ctx.perTurnWrites.circuitOps).toEqual([{ op: 'delete', circuit_ref: 2 }]);
  });

  test('idempotent — deleting an absent circuit returns deleted:false (no error)', async () => {
    const ctx = makeCtx({ circuits: { 1: {} } });
    const env = await dispatchDeleteCircuit(
      { tool_call_id: 'tu1', name: 'delete_circuit', input: { circuit_ref: 99 } },
      ctx
    );
    expect(env.is_error).toBe(false);
    expect(parseEnv(env)).toEqual({ ok: true, deleted: false });
    // Op still pushed so iOS can confirm the second of a "delete... delete..."
    // voice retry (the user's exact pattern in session 07635782).
    expect(ctx.perTurnWrites.circuitOps).toEqual([{ op: 'delete', circuit_ref: 99 }]);
  });

  test('rejects circuit_ref < 1 (the supply bucket at index 0 is protected)', async () => {
    const ctx = makeCtx({ circuits: { 0: { earth_loop_impedance_ze: '0.35' } } });
    const env = await dispatchDeleteCircuit(
      { tool_call_id: 'tu1', name: 'delete_circuit', input: { circuit_ref: 0 } },
      ctx
    );
    expect(env.is_error).toBe(true);
    const body = parseEnv(env);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('invalid_circuit_ref');
    // Supply bucket survives the rejected call.
    expect(ctx.session.stateSnapshot.circuits[0]).toBeDefined();
    expect(ctx.perTurnWrites.circuitOps).toEqual([]);
  });

  test('rejects non-integer circuit_ref', async () => {
    const ctx = makeCtx({ circuits: {} });
    const env = await dispatchDeleteCircuit(
      { tool_call_id: 'tu1', name: 'delete_circuit', input: { circuit_ref: 'two' } },
      ctx
    );
    expect(env.is_error).toBe(true);
    expect(parseEnv(env).error.code).toBe('invalid_circuit_ref');
  });
});

// ===========================================================================
// calculate_zs
// ===========================================================================

describe('dispatchCalculateZs', () => {
  test('happy path: writes Zs = Ze + r1+r2 for a single circuit, never overwrites', async () => {
    const ctx = makeCtx({
      circuits: {
        0: { earth_loop_impedance_ze: '0.35' },
        1: { r1_r2_ohm: '0.22' },
      },
    });
    const env = await dispatchCalculateZs(
      { tool_call_id: 'tu1', name: 'calculate_zs', input: { circuit_ref: 1, all: false } },
      ctx
    );
    expect(env.is_error).toBe(false);
    const body = parseEnv(env);
    expect(body.ok).toBe(true);
    expect(body.computed).toEqual([{ circuit_ref: 1, field: 'measured_zs_ohm', value: '0.57' }]);
    expect(body.skipped).toEqual([]);
    expect(ctx.session.stateSnapshot.circuits[1].measured_zs_ohm).toBe('0.57');
    // Reading flows through the standard extracted_readings path.
    expect(ctx.perTurnWrites.readings.has('measured_zs_ohm::1')).toBe(true);
  });

  test('NEVER overwrites an existing measured Zs', async () => {
    const ctx = makeCtx({
      circuits: {
        0: { earth_loop_impedance_ze: '0.35' },
        1: { r1_r2_ohm: '0.22', measured_zs_ohm: '0.51' }, // already measured by meter
      },
    });
    const env = await dispatchCalculateZs(
      { tool_call_id: 'tu1', name: 'calculate_zs', input: { all: true } },
      ctx
    );
    const body = parseEnv(env);
    expect(body.ok).toBe(true);
    expect(body.computed).toEqual([]);
    expect(body.skipped).toEqual([{ circuit_ref: 1, reason: 'already_set' }]);
    expect(ctx.session.stateSnapshot.circuits[1].measured_zs_ohm).toBe('0.51');
  });

  test('skips circuits missing r1_r2_ohm or Ze, computes the rest', async () => {
    const ctx = makeCtx({
      circuits: {
        0: { earth_loop_impedance_ze: '0.4' },
        1: { r1_r2_ohm: '0.3' }, // ok → 0.70
        2: {}, // skip: no_r1_r2
        3: { r1_r2_ohm: '0.5', measured_zs_ohm: '0.9' }, // skip: already_set
      },
    });
    const env = await dispatchCalculateZs(
      { tool_call_id: 'tu1', name: 'calculate_zs', input: { all: true } },
      ctx
    );
    const body = parseEnv(env);
    expect(body.computed).toEqual([{ circuit_ref: 1, field: 'measured_zs_ohm', value: '0.70' }]);
    expect(body.skipped).toEqual([
      { circuit_ref: 2, reason: 'no_r1_r2' },
      { circuit_ref: 3, reason: 'already_set' },
    ]);
  });

  test('skips every circuit with no_ze when board Ze is missing', async () => {
    const ctx = makeCtx({
      circuits: {
        1: { r1_r2_ohm: '0.3' },
        2: { r1_r2_ohm: '0.4' },
      },
    });
    const env = await dispatchCalculateZs(
      { tool_call_id: 'tu1', name: 'calculate_zs', input: { all: true } },
      ctx
    );
    expect(parseEnv(env).computed).toEqual([]);
    expect(parseEnv(env).skipped).toEqual([
      { circuit_ref: 1, reason: 'no_ze' },
      { circuit_ref: 2, reason: 'no_ze' },
    ]);
  });

  test('circuit_refs batch — sorted, deduped, mixed outcomes', async () => {
    const ctx = makeCtx({
      circuits: {
        0: { earth_loop_impedance_ze: '0.35' },
        1: { r1_r2_ohm: '0.22' },
        3: { r1_r2_ohm: '0.40' },
      },
    });
    const env = await dispatchCalculateZs(
      {
        tool_call_id: 'tu1',
        name: 'calculate_zs',
        input: { circuit_refs: [3, 1, 1, 5] }, // dupes + missing
      },
      ctx
    );
    const body = parseEnv(env);
    // computed sorted by walk order (selectorRefs sorts asc)
    expect(body.computed.map((c) => c.circuit_ref)).toEqual([1, 3]);
    expect(body.skipped).toEqual([{ circuit_ref: 5, reason: 'circuit_missing' }]);
  });

  test('rejects calls with no selector', async () => {
    const ctx = makeCtx({ circuits: {} });
    const env = await dispatchCalculateZs(
      { tool_call_id: 'tu1', name: 'calculate_zs', input: {} },
      ctx
    );
    expect(env.is_error).toBe(true);
    expect(parseEnv(env).error.code).toBe('missing_selector');
  });

  test('rejects calls with conflicting selectors', async () => {
    const ctx = makeCtx({ circuits: { 1: {} } });
    const env = await dispatchCalculateZs(
      {
        tool_call_id: 'tu1',
        name: 'calculate_zs',
        input: { circuit_ref: 1, all: true },
      },
      ctx
    );
    expect(env.is_error).toBe(true);
    expect(parseEnv(env).error.code).toBe('conflicting_selector');
  });

  test('rounds to 2dp (matches multifunction tester precision)', async () => {
    const ctx = makeCtx({
      circuits: {
        0: { earth_loop_impedance_ze: '0.333' }, // 3dp
        1: { r1_r2_ohm: '0.222' }, // 3dp → 0.555 → "0.56"
      },
    });
    const env = await dispatchCalculateZs(
      { tool_call_id: 'tu1', name: 'calculate_zs', input: { circuit_ref: 1, all: false } },
      ctx
    );
    expect(parseEnv(env).computed[0].value).toBe('0.56');
  });
});

// ===========================================================================
// calculate_r1_plus_r2
// ===========================================================================

describe('dispatchCalculateR1PlusR2', () => {
  test('zs_minus_ze: writes r1_r2 = Zs - Ze for a single circuit', async () => {
    const ctx = makeCtx({
      circuits: {
        0: { earth_loop_impedance_ze: '0.40' },
        1: { measured_zs_ohm: '0.62' },
      },
    });
    const env = await dispatchCalculateR1PlusR2(
      {
        tool_call_id: 'tu1',
        name: 'calculate_r1_plus_r2',
        input: { method: 'zs_minus_ze', circuit_ref: 1, all: false },
      },
      ctx
    );
    const body = parseEnv(env);
    expect(body.computed).toEqual([
      { circuit_ref: 1, field: 'r1_r2_ohm', value: '0.22', method: 'zs_minus_ze' },
    ]);
    expect(ctx.session.stateSnapshot.circuits[1].r1_r2_ohm).toBe('0.22');
  });

  test('zs_minus_ze: clamps physically-impossible negative result with zs_below_ze', async () => {
    // A meter typo (Zs less than Ze) shouldn't silently land "0.00" on the
    // certificate — that would imply zero CPC resistance, which is a
    // dangerous result worth flagging back to the inspector.
    const ctx = makeCtx({
      circuits: {
        0: { earth_loop_impedance_ze: '0.50' },
        1: { measured_zs_ohm: '0.30' },
      },
    });
    const env = await dispatchCalculateR1PlusR2(
      {
        tool_call_id: 'tu1',
        name: 'calculate_r1_plus_r2',
        input: { method: 'zs_minus_ze', circuit_ref: 1, all: false },
      },
      ctx
    );
    const body = parseEnv(env);
    expect(body.computed).toEqual([]);
    expect(body.skipped).toEqual([{ circuit_ref: 1, reason: 'zs_below_ze' }]);
    expect(ctx.session.stateSnapshot.circuits[1].r1_r2_ohm).toBeUndefined();
  });

  test('ring_continuity: writes r1_r2 = (R1 + R2)/4', async () => {
    const ctx = makeCtx({
      circuits: {
        0: { earth_loop_impedance_ze: '0.35' },
        // Typical ring R1=0.32, R2=0.52 → (0.32+0.52)/4 = 0.21
        1: { ring_r1_ohm: '0.32', ring_r2_ohm: '0.52' },
      },
    });
    const env = await dispatchCalculateR1PlusR2(
      {
        tool_call_id: 'tu1',
        name: 'calculate_r1_plus_r2',
        input: { method: 'ring_continuity', circuit_ref: 1, all: false },
      },
      ctx
    );
    const body = parseEnv(env);
    expect(body.computed).toEqual([
      { circuit_ref: 1, field: 'r1_r2_ohm', value: '0.21', method: 'ring_continuity' },
    ]);
    expect(ctx.session.stateSnapshot.circuits[1].r1_r2_ohm).toBe('0.21');
  });

  test('NEVER overwrites an existing r1_r2_ohm regardless of method', async () => {
    const ctx = makeCtx({
      circuits: {
        0: { earth_loop_impedance_ze: '0.35' },
        1: { measured_zs_ohm: '0.60', r1_r2_ohm: '0.18' }, // already set
      },
    });
    const env = await dispatchCalculateR1PlusR2(
      {
        tool_call_id: 'tu1',
        name: 'calculate_r1_plus_r2',
        input: { method: 'zs_minus_ze', all: true },
      },
      ctx
    );
    expect(parseEnv(env).computed).toEqual([]);
    expect(parseEnv(env).skipped).toEqual([{ circuit_ref: 1, reason: 'already_set' }]);
    expect(ctx.session.stateSnapshot.circuits[1].r1_r2_ohm).toBe('0.18');
  });

  test('zs_minus_ze: skips circuits missing measured_zs_ohm with no_zs', async () => {
    const ctx = makeCtx({
      circuits: {
        0: { earth_loop_impedance_ze: '0.35' },
        1: {}, // no Zs
      },
    });
    const env = await dispatchCalculateR1PlusR2(
      {
        tool_call_id: 'tu1',
        name: 'calculate_r1_plus_r2',
        input: { method: 'zs_minus_ze', all: true },
      },
      ctx
    );
    expect(parseEnv(env).skipped).toEqual([{ circuit_ref: 1, reason: 'no_zs' }]);
  });

  test('ring_continuity: skips circuits missing ring values with no_ring_r1 / no_ring_r2', async () => {
    const ctx = makeCtx({
      circuits: {
        1: { ring_r2_ohm: '0.52' }, // no_ring_r1
        2: { ring_r1_ohm: '0.32' }, // no_ring_r2
        3: { ring_r1_ohm: '0.30', ring_r2_ohm: '0.50' }, // ok → 0.20
      },
    });
    const env = await dispatchCalculateR1PlusR2(
      {
        tool_call_id: 'tu1',
        name: 'calculate_r1_plus_r2',
        input: { method: 'ring_continuity', all: true },
      },
      ctx
    );
    const body = parseEnv(env);
    expect(body.computed).toEqual([
      { circuit_ref: 3, field: 'r1_r2_ohm', value: '0.20', method: 'ring_continuity' },
    ]);
    expect(body.skipped).toEqual([
      { circuit_ref: 1, reason: 'no_ring_r1' },
      { circuit_ref: 2, reason: 'no_ring_r2' },
    ]);
  });

  test('rejects invalid method enum', async () => {
    const ctx = makeCtx({ circuits: { 1: {} } });
    const env = await dispatchCalculateR1PlusR2(
      {
        tool_call_id: 'tu1',
        name: 'calculate_r1_plus_r2',
        input: { method: 'magic', circuit_ref: 1, all: false },
      },
      ctx
    );
    expect(env.is_error).toBe(true);
    expect(parseEnv(env).error.code).toBe('invalid_method');
  });

  test('rejects calls with no selector', async () => {
    const ctx = makeCtx({ circuits: { 1: {} } });
    const env = await dispatchCalculateR1PlusR2(
      {
        tool_call_id: 'tu1',
        name: 'calculate_r1_plus_r2',
        input: { method: 'zs_minus_ze' },
      },
      ctx
    );
    expect(env.is_error).toBe(true);
    expect(parseEnv(env).error.code).toBe('missing_selector');
  });
});
