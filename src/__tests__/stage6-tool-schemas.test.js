/**
 * Tests for src/extraction/stage6-tool-schemas.js — Stage 6 agentic extraction
 * tool definitions.
 *
 * Coverage per Phase 1 Plan 01-01 success criteria:
 *  - 7 tools exported with exact expected names
 *  - every tool has strict: true on input_schema
 *  - every tool's input_schema is a strict JSON-Schema object
 *    (type:'object', additionalProperties:false, required:[])
 *  - record_reading.field enum matches Object.keys(field_schema.circuit_fields)
 *  - every other enum is sourced verbatim from stage6-enumerations.json
 *    (not hand-rolled in the module)
 *  - getToolByName('unknown') returns undefined
 *  - getToolByName('record_reading') returns the schema
 *  - no tool name starts with 'query_' (STS-09 — cached snapshot replaces reads)
 */

import { jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

// Load codegen inputs directly via fs so the test is independent of how the
// module chooses to import JSON (JSON import attributes vs createRequire).
const fieldSchema = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'config', 'field_schema.json'), 'utf8'),
);
const enumerations = JSON.parse(
  fs.readFileSync(
    path.join(repoRoot, 'config', 'stage6-enumerations.json'),
    'utf8',
  ),
);

const { TOOL_SCHEMAS, getToolByName } = await import(
  '../extraction/stage6-tool-schemas.js'
);

const EXPECTED_TOOL_NAMES = [
  'record_reading',
  'clear_reading',
  'create_circuit',
  'rename_circuit',
  'record_observation',
  'delete_observation',
  'ask_user',
];

const byName = (name) => TOOL_SCHEMAS.find((t) => t.name === name);

describe('stage6-tool-schemas', () => {
  test('exports exactly 7 tools with the expected names', () => {
    expect(Array.isArray(TOOL_SCHEMAS)).toBe(true);
    expect(TOOL_SCHEMAS).toHaveLength(7);
    const names = TOOL_SCHEMAS.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOL_NAMES].sort());
  });

  test('every tool has strict: true on its input_schema', () => {
    for (const tool of TOOL_SCHEMAS) {
      expect(tool.strict).toBe(true);
    }
  });

  test('every tool input_schema is a strict JSON-Schema object', () => {
    for (const tool of TOOL_SCHEMAS) {
      expect(tool.input_schema).toBeDefined();
      expect(tool.input_schema.type).toBe('object');
      expect(tool.input_schema.additionalProperties).toBe(false);
      expect(Array.isArray(tool.input_schema.required)).toBe(true);
      expect(typeof tool.input_schema.properties).toBe('object');
      expect(tool.input_schema.properties).not.toBeNull();
    }
  });

  test('every tool has a non-empty description (LLM-facing)', () => {
    for (const tool of TOOL_SCHEMAS) {
      expect(typeof tool.description).toBe('string');
      expect(tool.description.trim().length).toBeGreaterThan(10);
    }
  });

  test('record_reading.field enum matches Object.keys(field_schema.circuit_fields)', () => {
    const recordReading = byName('record_reading');
    expect(recordReading).toBeDefined();
    const fieldProp = recordReading.input_schema.properties.field;
    expect(fieldProp).toBeDefined();
    expect(fieldProp.type).toBe('string');
    expect(Array.isArray(fieldProp.enum)).toBe(true);
    expect(fieldProp.enum).toEqual(Object.keys(fieldSchema.circuit_fields));
  });

  test('record_reading requires all 5 fields per REQUIREMENTS STS-01', () => {
    const recordReading = byName('record_reading');
    expect(recordReading.input_schema.required.sort()).toEqual(
      ['field', 'circuit', 'value', 'confidence', 'source_turn_id'].sort(),
    );
  });

  test('clear_reading.reason enum sourced from stage6-enumerations.json', () => {
    const clearReading = byName('clear_reading');
    expect(clearReading.input_schema.properties.reason.enum).toEqual(
      enumerations.clear_reading_reason,
    );
  });

  test('create_circuit.phase enum sourced from stage6-enumerations.json + null (STS-03 permits phase | null)', () => {
    const createCircuit = byName('create_circuit');
    // Under strict-mode JSON Schema, enum matches the VALUE not the type. For
    // a nullable enum field the enum array MUST include null, else a valid
    // `phase: null` payload (explicitly permitted by STS-03) is rejected.
    expect(createCircuit.input_schema.properties.phase.enum).toEqual([
      ...enumerations.circuit_phase,
      null,
    ]);
    expect(createCircuit.input_schema.properties.phase.type).toEqual([
      'string',
      'null',
    ]);
    // create_circuit requires only circuit_ref (STS-03)
    expect(createCircuit.input_schema.required).toEqual(['circuit_ref']);
  });

  test('rename_circuit.phase enum sourced from stage6-enumerations.json + null (STS-04 permits phase | null)', () => {
    const renameCircuit = byName('rename_circuit');
    expect(renameCircuit.input_schema.properties.phase.enum).toEqual([
      ...enumerations.circuit_phase,
      null,
    ]);
    expect(renameCircuit.input_schema.properties.phase.type).toEqual([
      'string',
      'null',
    ]);
    expect(renameCircuit.input_schema.required).toEqual(['circuit_ref']);
  });

  test('non-nullable enums (clear_reading.reason, observation_code, ask_user.reason, expected_answer_shape) do NOT include null', () => {
    // These fields are REQUIRED per REQUIREMENTS — null is not a valid value
    // and must not appear in the enum array.
    expect(byName('clear_reading').input_schema.properties.reason.enum).not.toContain(
      null,
    );
    expect(
      byName('record_observation').input_schema.properties.code.enum,
    ).not.toContain(null);
    expect(
      byName('delete_observation').input_schema.properties.reason.enum,
    ).not.toContain(null);
    expect(byName('ask_user').input_schema.properties.reason.enum).not.toContain(
      null,
    );
    expect(
      byName('ask_user').input_schema.properties.expected_answer_shape.enum,
    ).not.toContain(null);
  });

  test('record_observation.code enum sourced from stage6-enumerations.json', () => {
    const recordObs = byName('record_observation');
    expect(recordObs.input_schema.properties.code.enum).toEqual(
      enumerations.observation_code,
    );
  });

  test('delete_observation.reason enum sourced from stage6-enumerations.json', () => {
    const deleteObs = byName('delete_observation');
    expect(deleteObs.input_schema.properties.reason.enum).toEqual(
      enumerations.delete_observation_reason,
    );
    expect(deleteObs.input_schema.required.sort()).toEqual(
      ['observation_id', 'reason'].sort(),
    );
  });

  test('ask_user.reason and expected_answer_shape enums sourced from enumerations.json', () => {
    const askUser = byName('ask_user');
    expect(askUser.input_schema.properties.reason.enum).toEqual(
      enumerations.ask_user_reason,
    );
    expect(askUser.input_schema.properties.expected_answer_shape.enum).toEqual(
      enumerations.expected_answer_shape,
    );
  });

  test('ask_user.context_field enum = circuit_fields keys + null (Codex early-review MAJOR — stable keys for STA-06 ask budget and STO-03 analytics)', () => {
    const askUser = byName('ask_user');
    const contextField = askUser.input_schema.properties.context_field;
    // Must permit null (question may not be scoped to any field) and must
    // share the SAME key-space as record_reading.field / clear_reading.field
    // so Phase 5 per-(context_field, context_circuit) budgets key stably.
    expect(contextField.type).toEqual(['string', 'null']);
    expect(contextField.enum).toEqual([
      ...Object.keys(fieldSchema.circuit_fields),
      null,
    ]);
  });

  test('getToolByName returns the tool for a known name', () => {
    const t = getToolByName('record_reading');
    expect(t).toBeDefined();
    expect(t.name).toBe('record_reading');
  });

  test('getToolByName returns undefined for an unknown name', () => {
    expect(getToolByName('does_not_exist')).toBeUndefined();
    expect(getToolByName('query_circuits')).toBeUndefined();
    expect(getToolByName('')).toBeUndefined();
  });

  test('no tool name begins with query_ (STS-09 — cached snapshot replaces read tools)', () => {
    for (const tool of TOOL_SCHEMAS) {
      expect(tool.name.startsWith('query_')).toBe(false);
    }
  });
});
