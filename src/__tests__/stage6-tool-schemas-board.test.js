/**
 * Stage 6 Phase 2 carryover (Bug C — 2026-04-26 production analysis) —
 * record_board_reading end-to-end coverage.
 *
 * WHAT: Locks the schema, dispatcher validation, state-mutation, and
 * bundler/comparator behaviour for the new 8th tool. Five test groups:
 *
 *   1. Schema shape — strict:true, no minimum/maximum on confidence,
 *      required-list lock, BOARD_FIELD_ENUM coverage of every supply /
 *      board / installation field key (excluding `_ui_*` metadata).
 *   2. Dispatcher validation — confidence bounds, off-enum field,
 *      malformed payloads.
 *   3. Dispatcher state mutation — happy path writes circuits[0],
 *      perTurnWrites tracking, PII discipline in log rows, same-turn
 *      overwrite (last-write-wins).
 *   4. End-to-end bundler integration — boardReadings populates
 *      `extracted_board_readings` slot when non-empty; omitted when empty.
 *   5. End-to-end comparator integration — legacy circuit-0 readings and
 *      tool-path extracted_board_readings compare on the same key shape
 *      (`board_reading:${field}`).
 *
 * WHY this file (not extending stage6-tool-schemas.test.js +
 * stage6-dispatchers-circuit.test.js + stage6-event-bundler.test.js +
 * stage6-shadow-comparator.test.js): the Bug C feature touches FIVE files
 * — keeping its tests co-located makes the regression coverage easy to
 * audit and easy to evolve as the surface grows. Each existing test file
 * still gets a targeted bump (tool count, dispatcher count, etc.) but the
 * deep behavioural lock lives here.
 */

import { jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TOOL_SCHEMAS,
  BOARD_FIELD_ENUM,
  getToolByName,
} from '../extraction/stage6-tool-schemas.js';
import { createWriteDispatcher } from '../extraction/stage6-dispatchers.js';
import { createPerTurnWrites } from '../extraction/stage6-per-turn-writes.js';
import { applyBoardReadingToSnapshot } from '../extraction/stage6-snapshot-mutators.js';
import { bundleToolCallsIntoResult } from '../extraction/stage6-event-bundler.js';
import { projectSlots, compareSlots } from '../extraction/stage6-slot-comparator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const fieldSchema = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'config', 'field_schema.json'), 'utf8')
);

function mockLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeSession(snapshot = { circuits: {} }) {
  return {
    sessionId: 's-board',
    stateSnapshot: snapshot,
    extractedObservations: [],
  };
}

function toolCallRows(logger) {
  return logger.info.mock.calls.filter((c) => c[0] === 'stage6_tool_call').map((c) => c[1]);
}

// ---------------------------------------------------------------------------
// Group 1 — Schema shape + enum coverage
// ---------------------------------------------------------------------------

describe('record_board_reading schema', () => {
  test('exists in TOOL_SCHEMAS at index 7 (preserves existing tool indices)', () => {
    // Original 7 tools (record_reading…ask_user) must keep their indices
    // because logging / metric tagging in Phase 5+ relies on stable order.
    // record_board_reading is appended at 7; start_dialogue_script at 8
    // (2026-04-30 Silvertown follow-up).
    expect(TOOL_SCHEMAS).toHaveLength(9);
    expect(TOOL_SCHEMAS[7]).toBeDefined();
    expect(TOOL_SCHEMAS[7].name).toBe('record_board_reading');
    expect(TOOL_SCHEMAS[8].name).toBe('start_dialogue_script');
    expect(TOOL_SCHEMAS[0].name).toBe('record_reading'); // unchanged
  });

  test('additionalProperties:false; strict undefined post-Bug-E', () => {
    // Bug-E fix (2026-04-26): strict:true removed across all tools — see
    // stage6-tool-schemas.js makeTool() comment for rationale.
    const tool = getToolByName('record_board_reading');
    expect(tool).toBeDefined();
    expect(tool.strict).toBeUndefined();
    expect(tool.input_schema.type).toBe('object');
    expect(tool.input_schema.additionalProperties).toBe(false);
  });

  test('required list is exactly [field, value, confidence, source_turn_id]', () => {
    const tool = getToolByName('record_board_reading');
    expect(tool.input_schema.required.sort()).toEqual(
      ['confidence', 'field', 'source_turn_id', 'value'].sort()
    );
  });

  test('confidence has no minimum/maximum (Anthropic strict-mode rejects them)', () => {
    // Production CloudWatch shows the Anthropic API rejects strict-mode
    // tools that declare numerical constraints on number/integer types.
    // Bounds are enforced server-side in dispatchRecordBoardReading.
    // This regression-locks the absence so a future edit re-adding either
    // keyword fails CI before the request 400s in production.
    const tool = getToolByName('record_board_reading');
    const confidence = tool.input_schema.properties.confidence;
    expect(confidence.type).toBe('number');
    expect(confidence.minimum).toBeUndefined();
    expect(confidence.maximum).toBeUndefined();
  });

  test('field enum is exactly the union of supply + board + installation field keys (sorted, deduped, _ui_* filtered)', () => {
    const tool = getToolByName('record_board_reading');
    const declared = tool.input_schema.properties.field.enum;
    expect(Array.isArray(declared)).toBe(true);
    expect(declared).toEqual(BOARD_FIELD_ENUM);

    const filterMeta = (k) => !k.startsWith('_ui_');
    const expected = [
      ...new Set([
        ...Object.keys(fieldSchema.supply_characteristics_fields).filter(filterMeta),
        ...Object.keys(fieldSchema.board_fields).filter(filterMeta),
        ...Object.keys(fieldSchema.installation_details_fields).filter(filterMeta),
      ]),
    ].sort();
    expect(declared).toEqual(expected);
  });

  test('field enum covers the legacy KNOWN_FIELDS canonical surface (Ze, address, earthing arrangement, main fuse)', () => {
    // Sanity: the production Bug C analysis named these specific fields
    // as silently dropped on the agentic path. Without them in the enum
    // the model has no surface to fix the dropouts.
    const enumSet = new Set(BOARD_FIELD_ENUM);
    expect(enumSet.has('earth_loop_impedance_ze')).toBe(true);
    expect(enumSet.has('earthing_arrangement')).toBe(true);
    expect(enumSet.has('main_switch_bs_en')).toBe(true);
    expect(enumSet.has('main_switch_current')).toBe(true);
    expect(enumSet.has('earthing_conductor_csa')).toBe(true);
    expect(enumSet.has('address')).toBe(true);
    expect(enumSet.has('postcode')).toBe(true);
    expect(enumSet.has('town')).toBe(true);
    expect(enumSet.has('client_name')).toBe(true);
    expect(enumSet.has('date_of_inspection')).toBe(true);
  });

  test('field enum does NOT contain _ui_* metadata keys (filter contract)', () => {
    // The supply / installation / board sections in field_schema.json
    // each carry _ui_tab + _ui_description meta keys that describe the UI
    // tab. They are not extractable values; the codegen filters them out.
    expect(BOARD_FIELD_ENUM).not.toContain('_ui_tab');
    expect(BOARD_FIELD_ENUM).not.toContain('_ui_description');
  });

  test('field enum does NOT contain any circuit_fields key (mutual exclusion with record_reading)', () => {
    // record_reading and record_board_reading are mutually exclusive at
    // the prompt level. A circuit_fields key leaking into the board enum
    // would let Sonnet write circuit-scoped readings via the wrong tool
    // and blow up the divergence comparison.
    const circuitKeys = new Set(Object.keys(fieldSchema.circuit_fields));
    const overlap = BOARD_FIELD_ENUM.filter((k) => circuitKeys.has(k));
    expect(overlap).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Group 2 — Dispatcher validation
// ---------------------------------------------------------------------------

describe('dispatchRecordBoardReading validation', () => {
  const validInput = {
    field: 'earth_loop_impedance_ze',
    value: '0.86',
    confidence: 0.95,
    source_turn_id: 't1',
  };

  test('rejects confidence < 0 with confidence_out_of_range', async () => {
    const session = makeSession();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 't1', writes);
    const res = await d(
      {
        tool_call_id: 'tu_lo',
        name: 'record_board_reading',
        input: { ...validInput, confidence: -0.01 },
      },
      {}
    );
    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content).error).toEqual({
      code: 'confidence_out_of_range',
      field: 'confidence',
    });
    // Snapshot must be unchanged.
    expect(session.stateSnapshot.circuits[0]).toBeUndefined();
    expect(writes.boardReadings.size).toBe(0);
  });

  test('rejects confidence > 1 with confidence_out_of_range', async () => {
    const session = makeSession();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 't1', writes);
    const res = await d(
      {
        tool_call_id: 'tu_hi',
        name: 'record_board_reading',
        input: { ...validInput, confidence: 1.01 },
      },
      {}
    );
    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content).error.code).toBe('confidence_out_of_range');
    expect(writes.boardReadings.size).toBe(0);
  });

  test('rejects non-finite confidence (NaN, Infinity)', async () => {
    const session = makeSession();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 't1', writes);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const res = await d(
        {
          tool_call_id: `tu_${bad}`,
          name: 'record_board_reading',
          input: { ...validInput, confidence: bad },
        },
        {}
      );
      expect(res.is_error).toBe(true);
      expect(JSON.parse(res.content).error.code).toBe('confidence_out_of_range');
    }
    expect(writes.boardReadings.size).toBe(0);
  });

  test('rejects missing or non-numeric confidence', async () => {
    const session = makeSession();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 't1', writes);
    const res = await d(
      {
        tool_call_id: 'tu_str',
        name: 'record_board_reading',
        input: {
          field: 'earth_loop_impedance_ze',
          value: '0.86',
          confidence: 'high',
          source_turn_id: 't1',
        },
      },
      {}
    );
    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content).error.code).toBe('confidence_out_of_range');
  });

  test('rejects off-enum field with invalid_field (defence in depth — strict:true should catch first)', async () => {
    const session = makeSession();
    const writes = createPerTurnWrites();
    const logger = mockLogger();
    const d = createWriteDispatcher(session, logger, 't1', writes);
    const res = await d(
      {
        tool_call_id: 'tu_bad',
        name: 'record_board_reading',
        input: { ...validInput, field: 'not_a_real_field' },
      },
      {}
    );
    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content).error).toEqual({
      code: 'invalid_field',
      field: 'field',
    });
    // Snapshot unchanged.
    expect(session.stateSnapshot.circuits[0]).toBeUndefined();
    expect(writes.boardReadings.size).toBe(0);
    // Log row carries the reject outcome.
    const rows = toolCallRows(logger);
    expect(rows[0]).toMatchObject({
      tool: 'record_board_reading',
      outcome: 'rejected',
      validation_error: { code: 'invalid_field', field: 'field' },
    });
  });

  test('rejects circuit_fields keys (mutual exclusion with record_reading)', async () => {
    // A circuit-scoped field name (like measured_zs_ohm) routed through
    // record_board_reading is a model bug — record_reading is the right
    // tool. The dispatcher rejects with invalid_field rather than writing
    // it into circuits[0].
    const session = makeSession();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 't1', writes);
    const res = await d(
      {
        tool_call_id: 'tu_xfield',
        name: 'record_board_reading',
        input: { ...validInput, field: 'measured_zs_ohm' },
      },
      {}
    );
    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content).error.code).toBe('invalid_field');
  });
});

// ---------------------------------------------------------------------------
// Group 3 — Dispatcher state mutation + perTurnWrites + logging
// ---------------------------------------------------------------------------

describe('dispatchRecordBoardReading state mutation', () => {
  test('happy path: writes circuits[0][field], pushes to perTurnWrites.boardReadings, logs ok', async () => {
    const session = makeSession({ circuits: {} });
    const logger = mockLogger();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, logger, 't1', writes);

    const res = await d(
      {
        tool_call_id: 'tu_ok',
        name: 'record_board_reading',
        input: {
          field: 'earth_loop_impedance_ze',
          value: '0.86',
          confidence: 0.95,
          source_turn_id: 't1',
        },
      },
      {}
    );

    expect(res.is_error).toBe(false);
    expect(JSON.parse(res.content)).toEqual({ ok: true });

    // State: circuits[0] gets the new entry without disturbing other
    // circuits.
    expect(session.stateSnapshot.circuits[0]).toEqual({
      earth_loop_impedance_ze: '0.86',
    });

    // perTurnWrites tracks the entry under the field-only key (no `::`).
    expect(writes.boardReadings.size).toBe(1);
    expect(writes.boardReadings.get('earth_loop_impedance_ze')).toEqual({
      value: '0.86',
      confidence: 0.95,
      source_turn_id: 't1',
    });

    // Log row.
    const rows = toolCallRows(logger);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tool: 'record_board_reading',
      outcome: 'ok',
      is_error: false,
      validation_error: null,
      input_summary: { field: 'earth_loop_impedance_ze' },
    });
  });

  test('does not clobber pre-existing fields on circuits[0] (e.g. seeded supply data)', async () => {
    // _seedStateFromJobState writes seed values like `pfc` to circuits[0]
    // before any tool calls. A subsequent record_board_reading on Ze must
    // not erase those seeds.
    const session = makeSession({ circuits: { 0: { pfc: '1.5' } } });
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 't1', writes);
    await d(
      {
        tool_call_id: 'tu_keep',
        name: 'record_board_reading',
        input: {
          field: 'earth_loop_impedance_ze',
          value: '0.86',
          confidence: 0.9,
          source_turn_id: 't1',
        },
      },
      {}
    );
    expect(session.stateSnapshot.circuits[0]).toEqual({
      pfc: '1.5',
      earth_loop_impedance_ze: '0.86',
    });
  });

  test('same-turn correction: second record_board_reading for same field overwrites the Map entry', async () => {
    // Mirrors the readings Map's last-write-wins contract — STT-09
    // applied to board readings.
    const session = makeSession();
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 't1', writes);
    await d(
      {
        tool_call_id: 'tu_a',
        name: 'record_board_reading',
        input: {
          field: 'earth_loop_impedance_ze',
          value: '0.86',
          confidence: 0.9,
          source_turn_id: 't1',
        },
      },
      {}
    );
    await d(
      {
        tool_call_id: 'tu_b',
        name: 'record_board_reading',
        input: {
          field: 'earth_loop_impedance_ze',
          value: '0.91',
          confidence: 0.95,
          source_turn_id: 't1',
        },
      },
      {}
    );
    expect(writes.boardReadings.size).toBe(1);
    expect(writes.boardReadings.get('earth_loop_impedance_ze')).toEqual({
      value: '0.91',
      confidence: 0.95,
      source_turn_id: 't1',
    });
    expect(session.stateSnapshot.circuits[0].earth_loop_impedance_ze).toBe('0.91');
  });

  test('PII guard: log input_summary contains field name only, never value', async () => {
    // Board fields can carry PII (address / postcode / client_name etc.).
    // The dispatcher must NEVER put `value` into input_summary regardless
    // of what field is being written.
    const session = makeSession();
    const logger = mockLogger();
    const d = createWriteDispatcher(session, logger, 't1', createPerTurnWrites());
    await d(
      {
        tool_call_id: 'tu_pii',
        name: 'record_board_reading',
        input: {
          field: 'address',
          value: '12 Acacia Avenue',
          confidence: 0.95,
          source_turn_id: 't1',
        },
      },
      {}
    );
    const rows = toolCallRows(logger);
    expect(rows[0].input_summary).toEqual({ field: 'address' });
    expect(rows[0].input_summary).not.toHaveProperty('value');
    expect(rows[0].input_summary).not.toHaveProperty('source_turn_id');
  });

  test('applyBoardReadingToSnapshot pure atom: writes to circuits[0] and auto-creates the bucket', () => {
    // Direct atom test — the dispatcher delegates to this. Ensures the
    // shared mutator stays in sync with what the dispatcher expects.
    const snap = { circuits: {} };
    applyBoardReadingToSnapshot(snap, { field: 'address', value: '12 Acacia' });
    expect(snap.circuits[0]).toEqual({ address: '12 Acacia' });

    // Idempotent on existing bucket.
    applyBoardReadingToSnapshot(snap, { field: 'postcode', value: 'AA1 1AA' });
    expect(snap.circuits[0]).toEqual({
      address: '12 Acacia',
      postcode: 'AA1 1AA',
    });
  });
});

// ---------------------------------------------------------------------------
// Group 4 — Bundler integration
// ---------------------------------------------------------------------------

describe('bundleToolCallsIntoResult — extracted_board_readings slot', () => {
  test('omits the slot when boardReadings is empty (iOS regression guard)', () => {
    const writes = createPerTurnWrites();
    const result = bundleToolCallsIntoResult(writes, { questions: [] });
    expect('extracted_board_readings' in result).toBe(false);
  });

  test('emits the slot when boardReadings is non-empty, with field/value/confidence/source', () => {
    const writes = createPerTurnWrites();
    writes.boardReadings.set('earth_loop_impedance_ze', {
      value: '0.86',
      confidence: 0.95,
      source_turn_id: 't1',
    });
    writes.boardReadings.set('address', {
      value: '12 Acacia Avenue',
      confidence: 0.92,
      source_turn_id: 't1',
    });
    const result = bundleToolCallsIntoResult(writes, { questions: [] });
    expect(Array.isArray(result.extracted_board_readings)).toBe(true);
    expect(result.extracted_board_readings).toEqual([
      {
        field: 'earth_loop_impedance_ze',
        value: '0.86',
        confidence: 0.95,
        source: 'tool_call',
      },
      {
        field: 'address',
        value: '12 Acacia Avenue',
        confidence: 0.92,
        source: 'tool_call',
      },
    ]);
  });

  test('preserves boardReadings Map insertion order (mirrors readings ordering)', () => {
    const writes = createPerTurnWrites();
    writes.boardReadings.set('postcode', { value: 'AA1', confidence: 1.0 });
    writes.boardReadings.set('address', { value: '12', confidence: 1.0 });
    writes.boardReadings.set('client_name', { value: 'Smith', confidence: 1.0 });
    const result = bundleToolCallsIntoResult(writes, { questions: [] });
    expect(result.extracted_board_readings.map((e) => e.field)).toEqual([
      'postcode',
      'address',
      'client_name',
    ]);
  });

  test('legacy callers without boardReadings on perTurnWrites still bundle (no throw, slot absent)', () => {
    // Older fixtures that build perTurnWrites by hand may not set the
    // boardReadings Map — bundler must defend.
    const legacyShape = {
      readings: new Map(),
      cleared: [],
      observations: [],
      deletedObservations: [],
      circuitOps: [],
      // boardReadings INTENTIONALLY absent
    };
    const result = bundleToolCallsIntoResult(legacyShape, { questions: [] });
    expect('extracted_board_readings' in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Group 5 — Comparator integration
// ---------------------------------------------------------------------------

describe('slot comparator — board_readings folding', () => {
  test('projectSlots: legacy circuit:0 reading lands in board_readings (peeled out of readings)', () => {
    const legacy = {
      extracted_readings: [
        { field: 'earth_loop_impedance_ze', circuit: 0, value: '0.86' },
        { field: 'measured_zs_ohm', circuit: 3, value: '0.35' },
      ],
      observations: [],
      questions: [],
    };
    const slots = projectSlots(legacy);
    expect(slots.readings.size).toBe(1); // only circuit-3
    expect(slots.readings.get('measured_zs_ohm::3')).toBe('0.35');
    expect(slots.board_readings.size).toBe(1);
    expect(slots.board_readings.get('board_reading:earth_loop_impedance_ze')).toBe('0.86');
  });

  test('projectSlots: bundler extracted_board_readings lands in board_readings', () => {
    const tool = {
      extracted_readings: [],
      extracted_board_readings: [
        {
          field: 'earth_loop_impedance_ze',
          value: '0.86',
          confidence: 0.95,
          source: 'tool_call',
        },
      ],
      observations: [],
      questions: [],
    };
    const slots = projectSlots(tool);
    expect(slots.board_readings.size).toBe(1);
    expect(slots.board_readings.get('board_reading:earth_loop_impedance_ze')).toBe('0.86');
  });

  test('compareSlots: legacy circuit:0 + tool extracted_board_readings on the SAME field/value → identical', () => {
    // The whole point of folding both shapes into the same `board_reading:`
    // key: a successful round trip on Ze should look like NO divergence.
    const legacy = {
      extracted_readings: [{ field: 'earth_loop_impedance_ze', circuit: 0, value: '0.86' }],
      observations: [],
      questions: [],
    };
    const tool = {
      extracted_readings: [],
      extracted_board_readings: [
        { field: 'earth_loop_impedance_ze', value: '0.86', source: 'tool_call' },
      ],
      observations: [],
      questions: [],
    };
    const r = compareSlots(legacy, tool);
    expect(r.any).toBe(false);
    expect(r.reason).toBe('identical');
  });

  test('compareSlots: legacy wrote address but tool path wrote nothing → dispatcher_strict_mode (Bug-C divergence reason)', () => {
    // Pre-Bug-C-fix shape: legacy parser routed address through KNOWN_FIELDS
    // and emitted it on circuit:0; the agentic path had no tool to write
    // it and therefore produced an empty result. The comparator must
    // classify this as `dispatcher_strict_mode` (not `value_mismatch`)
    // so Phase 7's analyzer can filter it out during the rollout window.
    const legacy = {
      extracted_readings: [{ field: 'address', circuit: 0, value: '12 Acacia' }],
      observations: [],
      questions: [],
    };
    const tool = { extracted_readings: [], observations: [], questions: [] };
    const r = compareSlots(legacy, tool);
    expect(r.any).toBe(true);
    expect(r.reason).toBe('dispatcher_strict_mode');
    expect(r.details.board_readings_only_legacy).toContain('board_reading:address');
  });

  test('compareSlots: same field, different values → value_mismatch (folds across both reading kinds)', () => {
    const legacy = {
      extracted_readings: [{ field: 'earth_loop_impedance_ze', circuit: 0, value: '0.86' }],
      observations: [],
      questions: [],
    };
    const tool = {
      extracted_readings: [],
      extracted_board_readings: [
        { field: 'earth_loop_impedance_ze', value: '0.91', source: 'tool_call' },
      ],
      observations: [],
      questions: [],
    };
    const r = compareSlots(legacy, tool);
    expect(r.any).toBe(true);
    expect(r.reason).toBe('value_mismatch');
    expect(r.details.board_readings_value_mismatch).toEqual([
      {
        key: 'board_reading:earth_loop_impedance_ze',
        legacy_value: '0.86',
        tool_value: '0.91',
      },
    ]);
  });

  test('compareSlots: tool path wrote a board reading legacy did not → extra_in_tool', () => {
    const legacy = { extracted_readings: [], observations: [], questions: [] };
    const tool = {
      extracted_readings: [],
      extracted_board_readings: [
        { field: 'earth_loop_impedance_ze', value: '0.86', source: 'tool_call' },
      ],
      observations: [],
      questions: [],
    };
    const r = compareSlots(legacy, tool);
    expect(r.any).toBe(true);
    expect(r.reason).toBe('extra_in_tool');
    expect(r.details.board_readings_only_tool).toContain('board_reading:earth_loop_impedance_ze');
  });
});

// ---------------------------------------------------------------------------
// Group 6 — Full pipeline integration (dispatcher → bundler → comparator)
// ---------------------------------------------------------------------------

describe('end-to-end: dispatcher → bundler → comparator', () => {
  test('successful board write → bundler emits the slot → comparator sees identical against legacy circuit:0', async () => {
    const session = makeSession({ circuits: {} });
    const writes = createPerTurnWrites();
    const d = createWriteDispatcher(session, mockLogger(), 't1', writes);

    await d(
      {
        tool_call_id: 'tu_e2e',
        name: 'record_board_reading',
        input: {
          field: 'earth_loop_impedance_ze',
          value: '0.86',
          confidence: 0.95,
          source_turn_id: 't1',
        },
      },
      {}
    );

    // Bundle the per-turn writes — one board reading should produce one
    // entry in extracted_board_readings.
    const bundled = bundleToolCallsIntoResult(writes, { questions: [] });
    expect(bundled.extracted_board_readings).toHaveLength(1);
    expect(bundled.extracted_board_readings[0].field).toBe('earth_loop_impedance_ze');

    // Synthetic "legacy" shape that emits the same reading at circuit:0.
    const legacy = {
      extracted_readings: [{ field: 'earth_loop_impedance_ze', circuit: 0, value: '0.86' }],
      observations: [],
      questions: [],
    };
    const cmp = compareSlots(legacy, bundled);
    expect(cmp.any).toBe(false);
    expect(cmp.reason).toBe('identical');
  });
});
