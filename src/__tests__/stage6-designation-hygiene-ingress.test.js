/**
 * PLAN-B (feedback ids 128+131, 2026-08-23) — per-ingress dispatcher
 * assertions for circuit-designation hygiene (B1 ingresses 1-4).
 *
 * Locks:
 *   - create_circuit / rename_circuit canonicalise the AUTHORITATIVE
 *     input.designation (snapshot bucket + circuitOps.meta agree on the
 *     cleaned value) and REJECT a banned-token-only designation with
 *     `invalid_designation` (never store the bare word "Circuit" — and
 *     never blank it, which would flip the circuit to SPARE).
 *   - create's duplicate-designation guard compares TRIMMED,
 *     CASE-INSENSITIVE CANONICAL forms in BOTH orientations, preserving
 *     the Spare carve-out.
 *   - rename keeps today's no-duplicate-guard semantics (SWAP/REORDER
 *     contract): rename INTO an existing designation still succeeds, and
 *     a two-rename swap still completes. Locked deliberately — see the
 *     plan's cross-write collision follow-up.
 *   - record_reading(circuit_designation) canonicalises via the shared
 *     coercion helper and rejects banned-token-only.
 *   - set_field_for_all_circuits(circuit_designation) fans out the
 *     cleaned scalar (current board AND board_id '*') and rejects
 *     banned-token-only.
 *   - the Loaded Barrel speculator observes/speaks only the CLEANED
 *     designation for streamed writes and skips banned-token-only.
 */

import { jest } from '@jest/globals';
import { createWriteDispatcher } from '../extraction/stage6-dispatchers.js';
import { createPerTurnWrites, encodeReadingKey } from '../extraction/stage6-per-turn-writes.js';
import { createSpeculator } from '../extraction/loaded-barrel-speculator.js';
import { CostTracker } from '../extraction/cost-tracker.js';
import { _resetForTests as resetCache } from '../extraction/loaded-barrel-cache.js';

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeSession(snapshot = { circuits: {} }) {
  return { sessionId: 's-desig', stateSnapshot: snapshot, extractedObservations: [] };
}

const INVALID_DESIGNATION = 'invalid_designation';

describe('create_circuit designation hygiene (ingress 1)', () => {
  test('trailing "circuit" stripped: snapshot bucket AND circuitOps.meta carry the cleaned value', async () => {
    const session = makeSession({ circuits: {} });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_c1',
        name: 'create_circuit',
        input: { circuit_ref: 2, designation: 'Upstairs lighting circuit' },
      },
      {}
    );

    expect(result.is_error).toBe(false);
    expect(session.stateSnapshot.circuits[2].circuit_designation).toBe('Upstairs lighting');
    expect(writes.circuitOps[0].meta.designation).toBe('Upstairs lighting');
  });

  test('banned-token-only designation → invalid_designation reject, snapshot untouched, AUDIBLE notice staged', async () => {
    const session = makeSession({ circuits: {} });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_c2',
        name: 'create_circuit',
        input: { circuit_ref: 3, designation: 'Circuit' },
      },
      {}
    );

    expect(result.is_error).toBe(true);
    const body = JSON.parse(result.content);
    expect(body.error.code).toBe(INVALID_DESIGNATION);
    expect(session.stateSnapshot.circuits[3]).toBeUndefined();
    expect(writes.circuitOps).toHaveLength(0);
    // Codex-review sanctioned deviation (Audio-First): the rejection stages
    // a partial-failure notice so a MIXED turn (sibling success standing the
    // catch-all down) can never leave this rejection silent.
    expect(writes.partialFailureNotices).toHaveLength(1);
    expect(writes.partialFailureNotices[0].reason).toBe(INVALID_DESIGNATION);
  });

  test("null / empty / whitespace designation keeps today's semantics (no reject)", async () => {
    const session = makeSession({ circuits: {} });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const r1 = await d(
      { tool_call_id: 'tu_c3', name: 'create_circuit', input: { circuit_ref: 4 } },
      {}
    );
    expect(r1.is_error).toBe(false);

    const r2 = await d(
      { tool_call_id: 'tu_c4', name: 'create_circuit', input: { circuit_ref: 5, designation: '' } },
      {}
    );
    expect(r2.is_error).toBe(false);
  });

  describe('duplicate guard compares canonical forms — both orientations', () => {
    test('existing dirty "Upstairs Lighting Circuit" + new clean "Upstairs Lighting" → duplicate_designation', async () => {
      const session = makeSession({
        circuits: { 1: { circuit_designation: 'Upstairs Lighting Circuit' } },
      });
      const logger = mockLogger();
      const writes = createPerTurnWrites();
      const d = createWriteDispatcher(session, logger, 'turn-1', writes);

      const result = await d(
        {
          tool_call_id: 'tu_dup1',
          name: 'create_circuit',
          input: { circuit_ref: 2, designation: 'Upstairs Lighting' },
        },
        {}
      );
      expect(result.is_error).toBe(true);
      expect(JSON.parse(result.content).error.code).toBe('duplicate_designation');
    });

    test('existing clean "Upstairs Lighting" + new dirty "  upstairs lighting circuit " → duplicate_designation (case + whitespace folded)', async () => {
      const session = makeSession({
        circuits: { 1: { circuit_designation: 'Upstairs Lighting' } },
      });
      const logger = mockLogger();
      const writes = createPerTurnWrites();
      const d = createWriteDispatcher(session, logger, 'turn-1', writes);

      const result = await d(
        {
          tool_call_id: 'tu_dup2',
          name: 'create_circuit',
          input: { circuit_ref: 2, designation: '  upstairs lighting circuit ' },
        },
        {}
      );
      expect(result.is_error).toBe(true);
      expect(JSON.parse(result.content).error.code).toBe('duplicate_designation');
    });

    test('Spare carve-out preserved: repeated "Spare" ways still allowed', async () => {
      const session = makeSession({ circuits: { 1: { circuit_designation: 'Spare' } } });
      const logger = mockLogger();
      const writes = createPerTurnWrites();
      const d = createWriteDispatcher(session, logger, 'turn-1', writes);

      const result = await d(
        {
          tool_call_id: 'tu_sp',
          name: 'create_circuit',
          input: { circuit_ref: 2, designation: 'Spare' },
        },
        {}
      );
      expect(result.is_error).toBe(false);
    });

    test('stored bare-"Circuit" row (canonical-empty) never blocks a new create', async () => {
      const session = makeSession({ circuits: { 1: { circuit_designation: 'Circuit' } } });
      const logger = mockLogger();
      const writes = createPerTurnWrites();
      const d = createWriteDispatcher(session, logger, 'turn-1', writes);

      const result = await d(
        {
          tool_call_id: 'tu_ce',
          name: 'create_circuit',
          input: { circuit_ref: 2, designation: 'Kitchen sockets' },
        },
        {}
      );
      expect(result.is_error).toBe(false);
    });
  });
});

describe('rename_circuit designation hygiene (ingress 2)', () => {
  test('designation cleaned on rename; snapshot + circuitOps.meta agree', async () => {
    const session = makeSession({ circuits: { 2: { circuit_designation: 'old' } } });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_r1',
        name: 'rename_circuit',
        input: { from_ref: 2, circuit_ref: 2, designation: 'Ring final circuit' },
      },
      {}
    );

    expect(result.is_error).toBe(false);
    expect(session.stateSnapshot.circuits[2].circuit_designation).toBe('Ring final');
    expect(writes.circuitOps[0].meta.designation).toBe('Ring final');
  });

  test('banned-token-only rename designation → invalid_designation reject, designation unchanged', async () => {
    const session = makeSession({ circuits: { 2: { circuit_designation: 'Cooker' } } });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_r2',
        name: 'rename_circuit',
        input: { from_ref: 2, circuit_ref: 2, designation: 'circuits' },
      },
      {}
    );

    expect(result.is_error).toBe(true);
    expect(JSON.parse(result.content).error.code).toBe(INVALID_DESIGNATION);
    expect(session.stateSnapshot.circuits[2].circuit_designation).toBe('Cooker');
  });

  test("LOCKED (today's semantics): rename INTO an existing designation still succeeds", async () => {
    // rename_circuit has NO duplicate-designation guard in production
    // (validateRenameCircuit checks only target_exists). Adding one would
    // break the SWAP/REORDER contract; duplicates resolve through the
    // matcher's ambiguity handling. Deliberately locked — cross-write
    // collision framework is a recorded follow-up, not this wave.
    const session = makeSession({
      circuits: { 1: { circuit_designation: 'Lighting' }, 2: { circuit_designation: 'Cooker' } },
    });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_r3',
        name: 'rename_circuit',
        input: { from_ref: 2, circuit_ref: 2, designation: 'Lighting' },
      },
      {}
    );

    expect(result.is_error).toBe(false);
    expect(session.stateSnapshot.circuits[2].circuit_designation).toBe('Lighting');
  });

  test("LOCKED (today's semantics): two-rename swap still completes exactly as today", async () => {
    const session = makeSession({
      circuits: { 1: { circuit_designation: 'Lighting' }, 2: { circuit_designation: 'Cooker' } },
    });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const r1 = await d(
      {
        tool_call_id: 'tu_s1',
        name: 'rename_circuit',
        input: { from_ref: 1, circuit_ref: 1, designation: 'Cooker' },
      },
      {}
    );
    const r2 = await d(
      {
        tool_call_id: 'tu_s2',
        name: 'rename_circuit',
        input: { from_ref: 2, circuit_ref: 2, designation: 'Lighting' },
      },
      {}
    );

    expect(r1.is_error).toBe(false);
    expect(r2.is_error).toBe(false);
    expect(session.stateSnapshot.circuits[1].circuit_designation).toBe('Cooker');
    expect(session.stateSnapshot.circuits[2].circuit_designation).toBe('Lighting');
  });
});

describe('record_reading(circuit_designation) hygiene (ingress 3, coercion layer)', () => {
  const readingInput = (value) => ({
    field: 'circuit_designation',
    circuit: 2,
    value,
    confidence: 0.9,
    source_turn_id: 't1',
  });

  test('cleaned value reaches snapshot and the per-turn readings map identically', async () => {
    const session = makeSession({ circuits: { 2: { circuit_designation: 'old' } } });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_rr1',
        name: 'record_reading',
        input: readingInput('Upstairs lighting circuit'),
      },
      {}
    );

    expect(result.is_error).toBe(false);
    expect(session.stateSnapshot.circuits[2].circuit_designation).toBe('Upstairs lighting');
    expect(writes.readings.get(encodeReadingKey('circuit_designation', 2)).value).toBe(
      'Upstairs lighting'
    );
  });

  test('banned-token-only value → invalid_designation reject, no write', async () => {
    const session = makeSession({ circuits: { 2: { circuit_designation: 'Cooker' } } });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      { tool_call_id: 'tu_rr2', name: 'record_reading', input: readingInput('Circuit.') },
      {}
    );

    expect(result.is_error).toBe(true);
    expect(JSON.parse(result.content).error.code).toBe(INVALID_DESIGNATION);
    expect(session.stateSnapshot.circuits[2].circuit_designation).toBe('Cooker');
    expect(writes.readings.size).toBe(0);
    expect(writes.partialFailureNotices).toHaveLength(1);
    expect(writes.partialFailureNotices[0].reason).toBe(INVALID_DESIGNATION);
  });
});

describe('set_field_for_all_circuits(circuit_designation) hygiene (ingress 4)', () => {
  const bulkInput = (value, overrides = {}) => ({
    field: 'circuit_designation',
    value,
    confidence: 0.9,
    source_turn_id: 't1',
    scope: 'all',
    ...overrides,
  });

  test('cleaned scalar fans out to every circuit on the current board', async () => {
    const session = makeSession({
      circuits: {
        1: { circuit_designation: 'a' },
        2: { circuit_designation: 'b' },
      },
    });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_b1',
        name: 'set_field_for_all_circuits',
        input: bulkInput('Garage supply circuit'),
      },
      {}
    );

    expect(result.is_error).toBe(false);
    expect(session.stateSnapshot.circuits[1].circuit_designation).toBe('Garage supply');
    expect(session.stateSnapshot.circuits[2].circuit_designation).toBe('Garage supply');
    expect(writes.readings.get(encodeReadingKey('circuit_designation', 1)).value).toBe(
      'Garage supply'
    );
  });

  test("board_id '*' broadcast also carries the cleaned scalar", async () => {
    // '*' iterates snapshot.boards — the broadcast test needs a board list.
    const session = makeSession({
      boards: [{ id: 'main', designation: 'DB-1' }],
      currentBoardId: 'main',
      circuits: {
        1: { circuit_designation: 'a' },
        2: { circuit_designation: 'b' },
      },
    });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_b2',
        name: 'set_field_for_all_circuits',
        input: bulkInput('Garage supply circuit', { board_id: '*' }),
      },
      {}
    );

    expect(result.is_error).toBe(false);
    expect(session.stateSnapshot.circuits[1].circuit_designation).toBe('Garage supply');
    expect(session.stateSnapshot.circuits[2].circuit_designation).toBe('Garage supply');
  });

  test('banned-token-only bulk value → invalid_designation reject, no fan-out', async () => {
    const session = makeSession({
      circuits: { 1: { circuit_designation: 'a' }, 2: { circuit_designation: 'b' } },
    });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 'turn-1', writes);

    const result = await d(
      {
        tool_call_id: 'tu_b3',
        name: 'set_field_for_all_circuits',
        input: bulkInput('Circuit circuits'),
      },
      {}
    );

    expect(result.is_error).toBe(true);
    expect(JSON.parse(result.content).error.code).toBe(INVALID_DESIGNATION);
    expect(session.stateSnapshot.circuits[1].circuit_designation).toBe('a');
    expect(session.stateSnapshot.circuits[2].circuit_designation).toBe('b');
    expect(writes.readings.size).toBe(0);
    // Scope-level notice (whole fan-out refused before iteration).
    expect(writes.partialFailureNotices).toHaveLength(1);
    expect(writes.partialFailureNotices[0].reason).toBe(INVALID_DESIGNATION);
  });
});

describe('Loaded Barrel speculator — streamed designation hygiene', () => {
  beforeEach(() => resetCache());
  afterEach(() => resetCache());

  async function flush() {
    await new Promise((r) => setImmediate(r));
  }

  function makeMockClientFactory() {
    const synths = [];
    const factory = jest.fn(() => ({
      synth: jest.fn((text, opts) => {
        synths.push({ text, opts });
        return new Promise(() => {});
      }),
      close: jest.fn(),
    }));
    return { factory, synths };
  }

  function makeSpec(factory) {
    return createSpeculator({
      sessionId: 'S',
      apiKey: 'test-key',
      costTracker: new CostTracker(),
      clientFactory: factory,
      initialDesignations: new Map(),
    });
  }

  function streamedDesignation(value) {
    return {
      record: {
        index: 0,
        tool_call_id: 'tc_d1',
        name: 'record_reading',
        input: {
          field: 'circuit_designation',
          circuit: 2,
          value,
          confidence: 1.0,
          source_turn_id: 'T1',
        },
      },
      ctx: { sessionId: 'S', turnId: 'T1', roundIdx: 1 },
    };
  }

  test('streamed "Upstairs lighting circuit" yields ONLY the cleaned speculative text', async () => {
    const { factory, synths } = makeMockClientFactory();
    const spec = makeSpec(factory);

    spec.onToolUseStreamed(streamedDesignation('Upstairs lighting circuit'));
    await flush();

    expect(synths.length).toBeGreaterThan(0);
    for (const s of synths) {
      expect(s.text).toContain('Upstairs lighting');
      expect(s.text.toLowerCase()).not.toContain('lighting circuit');
    }
  });

  test('banned-token-only streamed designation yields NO speculative output', async () => {
    const { factory, synths } = makeMockClientFactory();
    const spec = makeSpec(factory);

    spec.onToolUseStreamed(streamedDesignation('Circuit'));
    await flush();

    expect(synths).toHaveLength(0);
    expect(factory).not.toHaveBeenCalled();
  });
});
