/**
 * Stage 6 Phase 2 Plan 02-03 Task 1 — dispatchRecordReading + dispatchClearReading tests.
 *
 * WHAT: Locks the real-impl behaviour of the two reading-shape write dispatchers
 * (record_reading + clear_reading). Covers happy path, validation rejection, PII
 * discipline, same-turn correction (STT-09 preparation), and the clear-already-
 * clear noop path (Research §Q8). Invokes dispatchers through the public
 * `createWriteDispatcher` factory (not via the inner module functions directly)
 * so the round-counter + log shape are exercised end-to-end.
 *
 * WHY not import dispatchRecordReading directly: the round counter is owned by
 * the factory closure in the barrel (stage6-dispatchers.js line 64). Testing
 * through the factory gives us a single call site that exercises both the
 * circuit-sibling impl AND the barrel's closure semantics. If a future refactor
 * moves the round counter elsewhere, these tests still reflect the
 * end-user-facing contract.
 *
 * WHY no mocking of the mutators: Plan 02-01 mutator atoms already have their
 * own test file (stage6-snapshot-mutators.test.js). Here we use the REAL atoms
 * to prove end-to-end state writes — this is a dispatcher integration against
 * the mutator contract, not an isolated unit test.
 *
 * Requirements covered: STD-03 (record_reading writes slot), STD-04 (clear_reading
 * removes slot), STT-01 (per-dispatcher unit coverage), STT-09 preparation (same-
 * turn correction 3-call pattern).
 */

import { jest } from '@jest/globals';
import { createWriteDispatcher, createAutoResolveWriteHook } from '../extraction/stage6-dispatchers.js';
import { createPerTurnWrites, encodeReadingKey } from '../extraction/stage6-per-turn-writes.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeSession(snapshot = { circuits: {} }) {
  return { sessionId: 's-reading', stateSnapshot: snapshot, extractedObservations: [] };
}

function toolCallRows(logger) {
  return logger.info.mock.calls.filter((c) => c[0] === 'stage6_tool_call').map((c) => c[1]);
}

describe('dispatchRecordReading', () => {
  test('happy path: validates → writes to snapshot → tracks in perTurnWrites → logs ok', async () => {
    const session = makeSession({ circuits: { 3: {} } });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_1',
        name: 'record_reading',
        input: {
          field: 'measured_zs_ohm',
          circuit: 3,
          value: '0.35',
          confidence: 0.9,
          source_turn_id: 't1',
        },
      },
      {}
    );

    // Envelope shape
    expect(result.tool_use_id).toBe('tu_1');
    expect(result.is_error).toBe(false);
    expect(JSON.parse(result.content)).toEqual({ ok: true });

    // Snapshot mutated via applyReadingToSnapshot atom
    expect(session.stateSnapshot.circuits[3].measured_zs_ohm).toBe('0.35');

    // perTurnWrites carries the entry with the MAJOR-1 locked shape
    expect(writes.readings.size).toBe(1);
    expect(writes.readings.get(encodeReadingKey('measured_zs_ohm', 3))).toEqual({
      value: '0.35',
      confidence: 0.9,
      source_turn_id: 't1',
    });

    // Log row
    const rows = toolCallRows(logger);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tool: 'record_reading',
      outcome: 'ok',
      is_error: false,
      phase: 2,
      tool_use_id: 'tu_1',
      round: 1,
      validation_error: null,
      input_summary: { field: 'measured_zs_ohm', circuit: 3 },
    });
  });

  test('circuit_not_found: rejects, snapshot unchanged, perTurnWrites empty, logs rejected', async () => {
    const session = makeSession({ circuits: {} });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_bad',
        name: 'record_reading',
        input: {
          field: 'measured_zs_ohm',
          circuit: 5,
          value: '0.35',
          confidence: 1.0,
          source_turn_id: 't1',
        },
      },
      {}
    );

    expect(result.is_error).toBe(true);
    expect(result.tool_use_id).toBe('tu_bad');
    const body = JSON.parse(result.content);
    expect(body.ok).toBe(false);
    expect(body.error).toEqual({ code: 'circuit_not_found', field: 'circuit' });

    // No mutation, no per-turn write
    expect(session.stateSnapshot.circuits).toEqual({});
    expect(writes.readings.size).toBe(0);

    // Rejection row
    const rows = toolCallRows(logger);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tool: 'record_reading',
      outcome: 'rejected',
      is_error: true,
      validation_error: { code: 'circuit_not_found', field: 'circuit' },
      input_summary: { field: 'measured_zs_ohm', circuit: 5 },
    });
  });

  test('PII guard: input_summary never contains `value` (transcript PII risk)', async () => {
    const session = makeSession({ circuits: { 1: {} } });
    const logger = mockLogger();
    const d = createWriteDispatcher(session, logger, 'turn-1', createPerTurnWrites());

    await d(
      {
        tool_call_id: 'tu_pii',
        name: 'record_reading',
        input: {
          field: 'measured_zs_ohm',
          circuit: 1,
          value: 'secret-0.35',
          confidence: 1.0,
          source_turn_id: 't1',
        },
      },
      {}
    );

    const rows = toolCallRows(logger);
    expect(rows).toHaveLength(1);
    expect(rows[0].input_summary).not.toHaveProperty('value');
    // Defensive: also no confidence / source_turn_id in the summary.
    expect(rows[0].input_summary).not.toHaveProperty('confidence');
    expect(rows[0].input_summary).not.toHaveProperty('source_turn_id');
  });

  test('same-turn correction: second record_reading overwrites first in perTurnWrites + snapshot', async () => {
    const session = makeSession({ circuits: { 3: {} } });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    await d(
      {
        tool_call_id: 'tu_1',
        name: 'record_reading',
        input: {
          field: 'measured_zs_ohm',
          circuit: 3,
          value: '0.35',
          confidence: 0.9,
          source_turn_id: 't1',
        },
      },
      {}
    );
    await d(
      {
        tool_call_id: 'tu_2',
        name: 'record_reading',
        input: {
          field: 'measured_zs_ohm',
          circuit: 3,
          value: '0.42',
          confidence: 0.8,
          source_turn_id: 't1',
        },
      },
      {}
    );

    // applyReadingToSnapshot overwrote
    expect(session.stateSnapshot.circuits[3].measured_zs_ohm).toBe('0.42');

    // perTurnWrites has ONE entry (last-write-wins Map) with the MAJOR-1 locked shape.
    expect(writes.readings.size).toBe(1);
    const entry = writes.readings.get(encodeReadingKey('measured_zs_ohm', 3));
    expect(entry).toEqual({ value: '0.42', confidence: 0.8, source_turn_id: 't1' });
    // Shape lock: value object must NOT carry field/circuit.
    expect(entry).not.toHaveProperty('field');
    expect(entry).not.toHaveProperty('circuit');
  });

  // readback-correction-optionb §6 — PRE-APPLY rollout gate for the <0.5
  // read-back change. The capability is threaded via createWriteDispatcher's
  // extraCtx (5th arg → ctx.hasLowConfReadbackV1).
  describe('low_conf_readback_v1 PRE-APPLY gate (<0.5)', () => {
    function lowConfCall() {
      return {
        tool_call_id: 'tu_lc',
        name: 'record_reading',
        input: {
          field: 'measured_zs_ohm',
          circuit: 3,
          value: '0.62',
          confidence: 0.3,
          source_turn_id: 't1',
        },
      };
    }

    test('WITHOUT capability: <0.5 reading is SKIPPED — no mutation, no perTurnWrites, non-error envelope', async () => {
      const session = makeSession({ circuits: { 3: {} } });
      const logger = mockLogger();
      const writes = createPerTurnWrites();
      const d = createWriteDispatcher(session, logger, 'turn-1', writes); // no extraCtx → gate active

      const result = await d(lowConfCall(), {});

      // Non-error skipped envelope so the model does NOT retry/ask.
      expect(result.is_error).toBe(false);
      const body = JSON.parse(result.content);
      expect(body).toMatchObject({
        ok: true,
        skipped: true,
        reason: 'low_conf_readback_capability_missing',
      });
      // No snapshot mutation, no perTurnWrites entry.
      expect(session.stateSnapshot.circuits[3].measured_zs_ohm).toBeUndefined();
      expect(writes.readings.size).toBe(0);
      // Logged as a non-error skipped tool call.
      const rows = toolCallRows(logger);
      expect(rows[0]).toMatchObject({ outcome: 'skipped', is_error: false });
    });

    test('WITH capability: <0.5 reading APPLIES normally', async () => {
      const session = makeSession({ circuits: { 3: {} } });
      const logger = mockLogger();
      const writes = createPerTurnWrites();
      const d = createWriteDispatcher(session, logger, 'turn-1', writes, {
        hasLowConfReadbackV1: true,
      });

      const result = await d(lowConfCall(), {});

      expect(result.is_error).toBe(false);
      expect(JSON.parse(result.content).skipped).toBeUndefined();
      expect(session.stateSnapshot.circuits[3].measured_zs_ohm).toBe('0.62');
      expect(writes.readings.size).toBe(1);
    });

    test('0.5–0.8 reading applies identically with OR without the capability', async () => {
      for (const extra of [undefined, { hasLowConfReadbackV1: true }]) {
        const session = makeSession({ circuits: { 3: {} } });
        const writes = createPerTurnWrites();
        const d = createWriteDispatcher(session, mockLogger(), 'turn-1', writes, extra);
        await d(
          {
            tool_call_id: 'tu_mid',
            name: 'record_reading',
            input: {
              field: 'measured_zs_ohm',
              circuit: 3,
              value: '0.55',
              confidence: 0.6,
              source_turn_id: 't1',
            },
          },
          {}
        );
        expect(session.stateSnapshot.circuits[3].measured_zs_ohm).toBe('0.55');
        expect(writes.readings.size).toBe(1);
      }
    });

    test('a reading with NO numeric confidence applies normally even without the capability', async () => {
      const session = makeSession({ circuits: { 3: {} } });
      const writes = createPerTurnWrites();
      const d = createWriteDispatcher(session, mockLogger(), 'turn-1', writes);
      await d(
        {
          tool_call_id: 'tu_noc',
          name: 'record_reading',
          input: { field: 'measured_zs_ohm', circuit: 3, value: '0.62', source_turn_id: 't1' },
        },
        {}
      );
      expect(session.stateSnapshot.circuits[3].measured_zs_ohm).toBe('0.62');
      expect(writes.readings.size).toBe(1);
    });
  });

  // P3 Fix 8 — lim_ranged_write_v1 rollout gate.
  describe('lim_ranged_write_v1 gate (LIM on a capability-gated field)', () => {
    function limCall(field = 'measured_zs_ohm', value = 'LIM') {
      return {
        tool_call_id: 'tu_lim',
        name: 'record_reading',
        input: { field, circuit: 3, value, source_turn_id: 't1' },
      };
    }

    test('WITHOUT capability: LIM on measured_zs_ohm is DENIED (skipped, no mutation)', async () => {
      const session = makeSession({ circuits: { 3: {} } });
      const logger = mockLogger();
      const writes = createPerTurnWrites();
      const d = createWriteDispatcher(session, logger, 'turn-1', writes); // no capability
      const result = await d(limCall(), {});
      expect(result.is_error).toBe(false);
      expect(JSON.parse(result.content)).toMatchObject({
        ok: true,
        skipped: true,
        reason: 'lim_ranged_write_capability_missing',
      });
      expect(session.stateSnapshot.circuits[3].measured_zs_ohm).toBeUndefined();
      expect(writes.readings.size).toBe(0);
    });

    test('WITH capability: LIM on measured_zs_ohm APPLIES + reads back', async () => {
      const session = makeSession({ circuits: { 3: {} } });
      const writes = createPerTurnWrites();
      const d = createWriteDispatcher(session, mockLogger(), 'turn-1', writes, {
        hasLimRangedWriteV1: true,
      });
      const result = await d(limCall(), {});
      expect(result.is_error).toBe(false);
      expect(JSON.parse(result.content).skipped).toBeUndefined();
      expect(session.stateSnapshot.circuits[3].measured_zs_ohm).toBe('LIM');
      expect(writes.readings.size).toBe(1);
    });

    test('the four LIM garble forms are all denied without the capability', async () => {
      for (const form of ['lim', 'limb', 'limp', 'limitation']) {
        const session = makeSession({ circuits: { 3: {} } });
        const writes = createPerTurnWrites();
        const d = createWriteDispatcher(session, mockLogger(), 'turn-1', writes);
        const result = await d(limCall('measured_zs_ohm', form), {});
        expect(JSON.parse(result.content).reason).toBe('lim_ranged_write_capability_missing');
        expect(writes.readings.size).toBe(0);
      }
    });

    test('IR fields are NOT gated — LIM applies without the capability (pre-P3 behaviour)', async () => {
      const session = makeSession({ circuits: { 3: {} } });
      const writes = createPerTurnWrites();
      const d = createWriteDispatcher(session, mockLogger(), 'turn-1', writes); // no capability
      const result = await d(limCall('ir_live_live_mohm', 'limitation'), {});
      expect(JSON.parse(result.content).skipped).toBeUndefined();
      expect(session.stateSnapshot.circuits[3].ir_live_live_mohm).toBe('LIM');
    });

    test('a numeric write is unaffected by the gate', async () => {
      const session = makeSession({ circuits: { 3: {} } });
      const writes = createPerTurnWrites();
      const d = createWriteDispatcher(session, mockLogger(), 'turn-1', writes);
      await d(limCall('measured_zs_ohm', '0.35'), {});
      expect(session.stateSnapshot.circuits[3].measured_zs_ohm).toBe('0.35');
    });
  });

  test('round counter monotonically increments across three sequential calls (STO-01)', async () => {
    const session = makeSession({ circuits: { 1: {}, 2: {}, 3: {} } });
    const logger = mockLogger();
    const d = createWriteDispatcher(session, logger, 'turn-1', createPerTurnWrites());

    await d(
      {
        tool_call_id: 'tu_a',
        name: 'record_reading',
        input: {
          field: 'measured_zs_ohm',
          circuit: 1,
          value: '0.1',
          confidence: 1.0,
          source_turn_id: 't1',
        },
      },
      {}
    );
    await d(
      {
        tool_call_id: 'tu_b',
        name: 'record_reading',
        input: {
          field: 'measured_zs_ohm',
          circuit: 2,
          value: '0.2',
          confidence: 1.0,
          source_turn_id: 't1',
        },
      },
      {}
    );
    await d(
      {
        tool_call_id: 'tu_c',
        name: 'record_reading',
        input: {
          field: 'measured_zs_ohm',
          circuit: 3,
          value: '0.3',
          confidence: 1.0,
          source_turn_id: 't1',
        },
      },
      {}
    );

    const rounds = toolCallRows(logger).map((r) => r.round);
    expect(rounds).toEqual([1, 2, 3]);
  });

  test('missing confidence defaults to 1.0 in perTurnWrites (schema has it optional for the tool-result; legacy pass-through default)', async () => {
    const session = makeSession({ circuits: { 3: {} } });
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 'turn-1', writes);

    await d(
      {
        tool_call_id: 'tu_nc',
        name: 'record_reading',
        input: { field: 'measured_zs_ohm', circuit: 3, value: '0.35', source_turn_id: 't1' },
      },
      {}
    );

    expect(writes.readings.get(encodeReadingKey('measured_zs_ohm', 3))).toEqual({
      value: '0.35',
      confidence: 1.0,
      source_turn_id: 't1',
    });
  });
});

describe('dispatchClearReading', () => {
  test('happy path: circuit exists + field set → mutates snapshot + pushes to cleared[]', async () => {
    const session = makeSession({ circuits: { 3: { measured_zs_ohm: '0.35' } } });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_clr',
        name: 'clear_reading',
        input: { field: 'measured_zs_ohm', circuit: 3, reason: 'user_correction' },
      },
      {}
    );

    expect(result.is_error).toBe(false);
    expect(JSON.parse(result.content)).toEqual({ ok: true });

    // Snapshot: field removed, bucket remains.
    expect(session.stateSnapshot.circuits[3]).toEqual({});

    // perTurnWrites.cleared has one entry.
    expect(writes.cleared).toEqual([
      { field: 'measured_zs_ohm', circuit: 3, reason: 'user_correction' },
    ]);

    const rows = toolCallRows(logger);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tool: 'clear_reading',
      outcome: 'ok',
      is_error: false,
      validation_error: null,
      input_summary: { field: 'measured_zs_ohm', circuit: 3, reason: 'user_correction' },
    });
  });

  test('circuit_not_found: rejects, snapshot unchanged', async () => {
    const session = makeSession({ circuits: {} });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_bad',
        name: 'clear_reading',
        input: { field: 'measured_zs_ohm', circuit: 5, reason: 'misheard' },
      },
      {}
    );

    expect(result.is_error).toBe(true);
    const body = JSON.parse(result.content);
    expect(body.error).toEqual({ code: 'circuit_not_found', field: 'circuit' });
    expect(session.stateSnapshot.circuits).toEqual({});
    expect(writes.cleared).toHaveLength(0);

    expect(toolCallRows(logger)[0]).toMatchObject({
      outcome: 'rejected',
      validation_error: { code: 'circuit_not_found', field: 'circuit' },
    });
  });

  test('noop path: field not currently set → {ok:true, noop:true, reason:"field_not_set"} + no cleared push', async () => {
    const session = makeSession({ circuits: { 3: {} } });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_noop',
        name: 'clear_reading',
        input: { field: 'measured_zs_ohm', circuit: 3, reason: 'user_correction' },
      },
      {}
    );

    expect(result.is_error).toBe(false);
    expect(JSON.parse(result.content)).toEqual({
      ok: true,
      noop: true,
      reason: 'field_not_set',
    });
    expect(writes.cleared).toHaveLength(0);

    expect(toolCallRows(logger)[0]).toMatchObject({
      outcome: 'noop',
      is_error: false,
      validation_error: null,
    });
  });

  test('same-turn correction (STT-09 prep): record_reading then clear_reading — readings entry REMOVED, cleared entry pushed', async () => {
    const session = makeSession({ circuits: { 3: {} } });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    await d(
      {
        tool_call_id: 'tu_a',
        name: 'record_reading',
        input: {
          field: 'measured_zs_ohm',
          circuit: 3,
          value: '0.35',
          confidence: 1.0,
          source_turn_id: 't1',
        },
      },
      {}
    );
    await d(
      {
        tool_call_id: 'tu_b',
        name: 'clear_reading',
        input: { field: 'measured_zs_ohm', circuit: 3, reason: 'user_correction' },
      },
      {}
    );

    // readings entry was deleted by the clear path (same-turn dedup).
    expect(writes.readings.has(encodeReadingKey('measured_zs_ohm', 3))).toBe(false);
    // cleared has the single entry.
    expect(writes.cleared).toEqual([
      { field: 'measured_zs_ohm', circuit: 3, reason: 'user_correction' },
    ]);
    // Snapshot bucket field was removed by clearReadingInSnapshot.
    expect(session.stateSnapshot.circuits[3]).toEqual({});
  });

  test('STT-09 three-call pattern: record → clear → record — readings HAS new entry, cleared has ONE entry', async () => {
    const session = makeSession({ circuits: { 3: {} } });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    await d(
      {
        tool_call_id: 'tu_a',
        name: 'record_reading',
        input: {
          field: 'measured_zs_ohm',
          circuit: 3,
          value: '0.35',
          confidence: 1.0,
          source_turn_id: 't1',
        },
      },
      {}
    );
    await d(
      {
        tool_call_id: 'tu_b',
        name: 'clear_reading',
        input: { field: 'measured_zs_ohm', circuit: 3, reason: 'misheard' },
      },
      {}
    );
    await d(
      {
        tool_call_id: 'tu_c',
        name: 'record_reading',
        input: {
          field: 'measured_zs_ohm',
          circuit: 3,
          value: '0.42',
          confidence: 0.95,
          source_turn_id: 't1',
        },
      },
      {}
    );

    expect(writes.readings.size).toBe(1);
    expect(writes.readings.get(encodeReadingKey('measured_zs_ohm', 3))).toEqual({
      value: '0.42',
      confidence: 0.95,
      source_turn_id: 't1',
    });
    expect(writes.cleared).toHaveLength(1);
    expect(writes.cleared[0]).toEqual({ field: 'measured_zs_ohm', circuit: 3, reason: 'misheard' });
    expect(session.stateSnapshot.circuits[3].measured_zs_ohm).toBe('0.42');
  });
});

// P3 Codex-r4 F2 — the auto-resolve write hook (a LIM/value answer to an
// ask_user / pending-value question) dispatches through record_reading, so it
// must carry the same capability context: a capable client's LIM answer applies;
// a capability-absent client's is denied (not falsely reported as written).
describe('createAutoResolveWriteHook — lim_ranged_write_v1 capability threading', () => {
  function limWrite() {
    return {
      tool: 'record_reading',
      field: 'measured_zs_ohm',
      circuit: 3,
      value: 'LIM',
      source_turn_id: 't1',
    };
  }

  test('WITH capability: a LIM ask-answer APPLIES to the snapshot', async () => {
    const session = makeSession({ circuits: { 3: {} } });
    const writes = createPerTurnWrites();
    const hook = createAutoResolveWriteHook(session, mockLogger(), 't1', writes, {
      hasLimRangedWriteV1: true,
    });
    const res = await hook(limWrite(), { toolCallId: 'ask-1' });
    expect(res.ok).toBe(true);
    expect(session.stateSnapshot.circuits[3].measured_zs_ohm).toBe('LIM');
    expect(writes.readings.size).toBe(1);
  });

  test('WITHOUT capability: a LIM ask-answer is DENIED (skipped, no snapshot write)', async () => {
    const session = makeSession({ circuits: { 3: {} } });
    const writes = createPerTurnWrites();
    const hook = createAutoResolveWriteHook(session, mockLogger(), 't1', writes); // no capability
    const res = await hook(limWrite(), { toolCallId: 'ask-1' });
    // The dispatcher returns a non-error skip; the snapshot is NOT mutated.
    expect(session.stateSnapshot.circuits[3].measured_zs_ohm).toBeUndefined();
    expect(writes.readings.size).toBe(0);
    expect(res.body?.skipped).toBe(true);
  });
});
