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
import { createWriteDispatcher } from '../extraction/stage6-dispatchers.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeSession(snapshot = { circuits: {} }) {
  return { sessionId: 's-reading', stateSnapshot: snapshot, extractedObservations: [] };
}

function toolCallRows(logger) {
  return logger.info.mock.calls
    .filter((c) => c[0] === 'stage6_tool_call')
    .map((c) => c[1]);
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
        input: { field: 'Ze_ohms', circuit: 3, value: '0.35', confidence: 0.9, source_turn_id: 't1' },
      },
      {},
    );

    // Envelope shape
    expect(result.tool_use_id).toBe('tu_1');
    expect(result.is_error).toBe(false);
    expect(JSON.parse(result.content)).toEqual({ ok: true });

    // Snapshot mutated via applyReadingToSnapshot atom
    expect(session.stateSnapshot.circuits[3].Ze_ohms).toBe('0.35');

    // perTurnWrites carries the entry with the MAJOR-1 locked shape
    expect(writes.readings.size).toBe(1);
    expect(writes.readings.get('Ze_ohms::3')).toEqual({
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
      input_summary: { field: 'Ze_ohms', circuit: 3 },
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
        input: { field: 'Ze_ohms', circuit: 5, value: '0.35', confidence: 1.0, source_turn_id: 't1' },
      },
      {},
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
      input_summary: { field: 'Ze_ohms', circuit: 5 },
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
        input: { field: 'Ze_ohms', circuit: 1, value: 'secret-0.35', confidence: 1.0, source_turn_id: 't1' },
      },
      {},
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
        input: { field: 'Ze_ohms', circuit: 3, value: '0.35', confidence: 0.9, source_turn_id: 't1' },
      },
      {},
    );
    await d(
      {
        tool_call_id: 'tu_2',
        name: 'record_reading',
        input: { field: 'Ze_ohms', circuit: 3, value: '0.42', confidence: 0.8, source_turn_id: 't1' },
      },
      {},
    );

    // applyReadingToSnapshot overwrote
    expect(session.stateSnapshot.circuits[3].Ze_ohms).toBe('0.42');

    // perTurnWrites has ONE entry (last-write-wins Map) with the MAJOR-1 locked shape.
    expect(writes.readings.size).toBe(1);
    const entry = writes.readings.get('Ze_ohms::3');
    expect(entry).toEqual({ value: '0.42', confidence: 0.8, source_turn_id: 't1' });
    // Shape lock: value object must NOT carry field/circuit.
    expect(entry).not.toHaveProperty('field');
    expect(entry).not.toHaveProperty('circuit');
  });

  test('round counter monotonically increments across three sequential calls (STO-01)', async () => {
    const session = makeSession({ circuits: { 1: {}, 2: {}, 3: {} } });
    const logger = mockLogger();
    const d = createWriteDispatcher(session, logger, 'turn-1', createPerTurnWrites());

    await d(
      {
        tool_call_id: 'tu_a',
        name: 'record_reading',
        input: { field: 'Ze_ohms', circuit: 1, value: '0.1', confidence: 1.0, source_turn_id: 't1' },
      },
      {},
    );
    await d(
      {
        tool_call_id: 'tu_b',
        name: 'record_reading',
        input: { field: 'Ze_ohms', circuit: 2, value: '0.2', confidence: 1.0, source_turn_id: 't1' },
      },
      {},
    );
    await d(
      {
        tool_call_id: 'tu_c',
        name: 'record_reading',
        input: { field: 'Ze_ohms', circuit: 3, value: '0.3', confidence: 1.0, source_turn_id: 't1' },
      },
      {},
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
        input: { field: 'Ze_ohms', circuit: 3, value: '0.35', source_turn_id: 't1' },
      },
      {},
    );

    expect(writes.readings.get('Ze_ohms::3')).toEqual({
      value: '0.35',
      confidence: 1.0,
      source_turn_id: 't1',
    });
  });
});

describe('dispatchClearReading', () => {
  test('happy path: circuit exists + field set → mutates snapshot + pushes to cleared[]', async () => {
    const session = makeSession({ circuits: { 3: { Ze_ohms: '0.35' } } });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_clr',
        name: 'clear_reading',
        input: { field: 'Ze_ohms', circuit: 3, reason: 'user_correction' },
      },
      {},
    );

    expect(result.is_error).toBe(false);
    expect(JSON.parse(result.content)).toEqual({ ok: true });

    // Snapshot: field removed, bucket remains.
    expect(session.stateSnapshot.circuits[3]).toEqual({});

    // perTurnWrites.cleared has one entry.
    expect(writes.cleared).toEqual([{ field: 'Ze_ohms', circuit: 3, reason: 'user_correction' }]);

    const rows = toolCallRows(logger);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tool: 'clear_reading',
      outcome: 'ok',
      is_error: false,
      validation_error: null,
      input_summary: { field: 'Ze_ohms', circuit: 3, reason: 'user_correction' },
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
        input: { field: 'Ze_ohms', circuit: 5, reason: 'misheard' },
      },
      {},
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
        input: { field: 'Ze_ohms', circuit: 3, reason: 'user_correction' },
      },
      {},
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
        input: { field: 'Ze_ohms', circuit: 3, value: '0.35', confidence: 1.0, source_turn_id: 't1' },
      },
      {},
    );
    await d(
      {
        tool_call_id: 'tu_b',
        name: 'clear_reading',
        input: { field: 'Ze_ohms', circuit: 3, reason: 'user_correction' },
      },
      {},
    );

    // readings entry was deleted by the clear path (same-turn dedup).
    expect(writes.readings.has('Ze_ohms::3')).toBe(false);
    // cleared has the single entry.
    expect(writes.cleared).toEqual([{ field: 'Ze_ohms', circuit: 3, reason: 'user_correction' }]);
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
        input: { field: 'Ze_ohms', circuit: 3, value: '0.35', confidence: 1.0, source_turn_id: 't1' },
      },
      {},
    );
    await d(
      {
        tool_call_id: 'tu_b',
        name: 'clear_reading',
        input: { field: 'Ze_ohms', circuit: 3, reason: 'misheard' },
      },
      {},
    );
    await d(
      {
        tool_call_id: 'tu_c',
        name: 'record_reading',
        input: { field: 'Ze_ohms', circuit: 3, value: '0.42', confidence: 0.95, source_turn_id: 't1' },
      },
      {},
    );

    expect(writes.readings.size).toBe(1);
    expect(writes.readings.get('Ze_ohms::3')).toEqual({
      value: '0.42',
      confidence: 0.95,
      source_turn_id: 't1',
    });
    expect(writes.cleared).toHaveLength(1);
    expect(writes.cleared[0]).toEqual({ field: 'Ze_ohms', circuit: 3, reason: 'misheard' });
    expect(session.stateSnapshot.circuits[3].Ze_ohms).toBe('0.42');
  });
});
