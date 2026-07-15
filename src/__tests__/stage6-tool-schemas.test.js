/**
 * Tests for src/extraction/stage6-tool-schemas.js — Stage 6 agentic extraction
 * tool definitions.
 *
 * Coverage per Phase 1 Plan 01-01 success criteria (tool count grown to 16
 * across the multi-board + calc-tool sprints; strict:true removed globally by
 * the Bug-E fix 2026-04-26 — assertions below pin both):
 *  - 16 tools exported with exact expected names
 *  - no tool has strict: true on input_schema (server-side validation instead)
 *  - every tool's input_schema is a JSON-Schema object
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
  fs.readFileSync(path.join(repoRoot, 'config', 'field_schema.json'), 'utf8')
);
const enumerations = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'config', 'stage6-enumerations.json'), 'utf8')
);
const contextKeys = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'config', 'stage6-context-keys.json'), 'utf8')
);

const { TOOL_SCHEMAS, getToolByName } = await import('../extraction/stage6-tool-schemas.js');

const EXPECTED_TOOL_NAMES = [
  'record_reading',
  'clear_reading',
  'create_circuit',
  'rename_circuit',
  'record_observation',
  'delete_observation',
  'ask_user',
  // STS-08: record_board_reading was appended in the Bug C fix from the
  // 2026-04-26 production analysis — supply / installation / board-level
  // writes (Ze, address, main fuse, etc.) had no tool surface before this.
  'record_board_reading',
  // 2026-04-30 Silvertown follow-up: Sonnet-driven entry to the dialogue
  // engine for structured walk-throughs the engine's regex missed
  // (Deepgram garbles, paraphrases). Initialises session.dialogueScriptState
  // and emits the first slot ask. See stage6-dispatchers-script.js.
  'start_dialogue_script',
  // 2026-05-04 (field test 07635782): three tools added in one batch.
  // delete_circuit closed the gap that left "delete circuit 2" silently
  // dropped; calculate_zs / calculate_r1_plus_r2 closed the gap where
  // "calculate the Zs" produced empty turns.
  'delete_circuit',
  'calculate_zs',
  'calculate_r1_plus_r2',
  // 2026-05-06 (session DC946608, 8 Branagh Court): bulk-set tool. Replaces
  // the model's 14-tool-call burst pattern (Sonnet truncated to 7 in prod)
  // with one server-iterated call.
  'set_field_for_all_circuits',
  // 2026-05-07 multi-board sprint Phase 6.1: add_board appends a NEW
  // consumer unit / sub-distribution board / sub-main and emits onto the
  // boardOps wire channel landed in Phase 6.0.
  'add_board',
  // 2026-05-07 multi-board sprint Phase 6.2: select_board (id-only) flips
  // currentBoardId to a previously-added board.
  'select_board',
  // 2026-05-07 multi-board sprint Phase 6.3: mark_distribution_circuit
  // flags a circuit as feeding another board (sub-main). STOP-SLICE: no
  // forward-ref ask_user — Sonnet must call add_board FIRST.
  'mark_distribution_circuit',
];

const byName = (name) => TOOL_SCHEMAS.find((t) => t.name === name);

describe('stage6-tool-schemas', () => {
  test('exports exactly 16 tools with the expected names', () => {
    expect(Array.isArray(TOOL_SCHEMAS)).toBe(true);
    expect(TOOL_SCHEMAS).toHaveLength(16);
    const names = TOOL_SCHEMAS.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOL_NAMES].sort());
  });

  test('no tool sets strict:true (Bug-E fix — Anthropic 503s on grammar compilation)', () => {
    // Bug-E fix (2026-04-26): strict:true was removed from every tool. Across
    // the tool set (now 16 tools) whose enums total ~150+ values, Anthropic's
    // grammar-compilation step intermittently returns
    // `503 overloaded_error: "Grammar compilation is temporarily unavailable"`
    // — the call hangs ~30s then 503s. Data integrity is protected server-side
    // instead: dispatchers hand-pick the fields they consume and the
    // dispatch-validation layer (stage6-dispatch-validation.js) range/enum-
    // checks the fields it validates, returning structured validation_error
    // tool_results the model can self-correct on (tool-specific, not a blanket
    // check of every property).
    for (const tool of TOOL_SCHEMAS) {
      expect(tool.strict).toBeUndefined();
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
      ['field', 'circuit', 'value', 'confidence', 'source_turn_id'].sort()
    );
  });

  test('record_reading.confidence has no minimum/maximum (Anthropic strict-mode rejects them)', () => {
    // The Anthropic API rejects `minimum`/`maximum` on number/integer types
    // with `tools.0.custom: For 'number' type, properties maximum, minimum
    // are not supported` — confirmed in production CloudWatch traffic. Bounds
    // are enforced by validateRecordReading (stage6-dispatch-validation.js)
    // instead. This test pins the absence so a regression that re-adds either
    // keyword fails CI rather than every shadow turn 400-ing in production.
    const confidence = byName('record_reading').input_schema.properties.confidence;
    expect(confidence.type).toBe('number');
    expect(confidence.minimum).toBeUndefined();
    expect(confidence.maximum).toBeUndefined();
    expect(typeof confidence.description).toBe('string');
  });

  test('clear_reading.reason enum sourced from stage6-enumerations.json', () => {
    const clearReading = byName('clear_reading');
    expect(clearReading.input_schema.properties.reason.enum).toEqual(
      enumerations.clear_reading_reason
    );
  });

  test('create_circuit.phase uses anyOf with enum on string branch + null branch (STS-03 permits phase | null)', () => {
    // Bug-D fix (2026-04-26): Anthropic strict-mode rejects type-array+enum
    // combos (`tools.N.custom: Invalid schema: Enum value 'L1' does not match
    // declared type '['string','null']'`). Switched to anyOf so the enum
    // lives on the typed string branch and null is its own branch. STS-03
    // semantics preserved — phase: null is still a valid payload.
    const createCircuit = byName('create_circuit');
    const phase = createCircuit.input_schema.properties.phase;
    expect(phase.type).toBeUndefined();
    expect(Array.isArray(phase.anyOf)).toBe(true);
    expect(phase.anyOf).toEqual([
      { type: 'string', enum: enumerations.circuit_phase },
      { type: 'null' },
    ]);
    // create_circuit requires only circuit_ref (STS-03)
    expect(createCircuit.input_schema.required).toEqual(['circuit_ref']);
  });

  test('rename_circuit.phase uses anyOf with enum on string branch + null branch (STS-04)', () => {
    const renameCircuit = byName('rename_circuit');
    const phase = renameCircuit.input_schema.properties.phase;
    expect(phase.type).toBeUndefined();
    expect(phase.anyOf).toEqual([
      { type: 'string', enum: enumerations.circuit_phase },
      { type: 'null' },
    ]);
    expect(renameCircuit.input_schema.required.sort()).toEqual(['circuit_ref', 'from_ref'].sort());
  });

  test('non-nullable enums (clear_reading.reason, observation_code, ask_user.reason, expected_answer_shape) do NOT include null', () => {
    // These fields are REQUIRED per REQUIREMENTS — null is not a valid value
    // and must not appear in the enum array.
    expect(byName('clear_reading').input_schema.properties.reason.enum).not.toContain(null);
    expect(byName('record_observation').input_schema.properties.code.enum).not.toContain(null);
    expect(byName('delete_observation').input_schema.properties.reason.enum).not.toContain(null);
    expect(byName('ask_user').input_schema.properties.reason.enum).not.toContain(null);
    expect(byName('ask_user').input_schema.properties.expected_answer_shape.enum).not.toContain(
      null
    );
  });

  test('ask_user has an optional nullable context_board_id (readback-correction-optionb §6)', () => {
    const askUser = byName('ask_user');
    const prop = askUser.input_schema.properties.context_board_id;
    expect(prop).toBeDefined();
    // anyOf [string, null] — optional board scope; NOT in required.
    expect(prop.anyOf).toEqual([{ type: 'string' }, { type: 'null' }]);
    expect(askUser.input_schema.required).not.toContain('context_board_id');
  });

  test('record_observation.code enum sourced from stage6-enumerations.json', () => {
    const recordObs = byName('record_observation');
    expect(recordObs.input_schema.properties.code.enum).toEqual(enumerations.observation_code);
  });

  test('record_observation requires all 8 STS-05 fields (Codex round-4 STG MAJOR — nullables must be required; additionalProperties:false, not strict:true)', () => {
    // The tool is NOT strict:true (Bug-E fix 2026-04-26 removed strict mode)
    // but additionalProperties:false is preserved, so a nullable field like
    // `circuit: integer | null` or `suggested_regulation: string | null` that
    // the dispatcher needs to interpret unambiguously MUST be required, with
    // null as a valid value for "not applicable" — otherwise "installation-
    // wide" (explicit null) and "model forgot" (key absent) collapse into the
    // same undefined-key state.
    // schedule_item added 2026-05-01 with the same nullable-but-required
    // contract — null when no Schedule of Inspection section applies.
    // rationale added 2026-06-23 (Plan obs-#51) — same nullable-but-required
    // contract; null when the observation text alone explains the coding.
    // clarification_chain_id added 2026-07-15 (D2 chain-correlation) — same
    // nullable-but-required contract; null for a direct/unclarified observation.
    const recordObs = byName('record_observation');
    expect(recordObs.input_schema.required.sort()).toEqual(
      [
        'code',
        'location',
        'text',
        'circuit',
        'suggested_regulation',
        'schedule_item',
        'rationale',
        'clarification_chain_id',
      ].sort()
    );
  });

  test('record_observation.schedule_item is nullable string (BS7671 SoI section number)', () => {
    const recordObs = byName('record_observation');
    const prop = recordObs.input_schema.properties.schedule_item;
    expect(prop).toBeDefined();
    // anyOf: [{type:'string'}, {type:'null'}] — same shape as suggested_regulation.
    expect(prop.anyOf).toEqual([{ type: 'string' }, { type: 'null' }]);
  });

  // Test-matrix item 10 (D2 chain-correlation) — the new
  // record_observation.clarification_chain_id field + all THREE model-facing
  // descriptions carrying the mutation-echo instruction, plus the conditional
  // tool-result shape documented on the ask_user tool description.
  test('record_observation.clarification_chain_id is nullable string, in required, additionalProperties intact (D2)', () => {
    const recordObs = byName('record_observation');
    const prop = recordObs.input_schema.properties.clarification_chain_id;
    expect(prop).toBeDefined();
    expect(prop.anyOf).toEqual([{ type: 'string' }, { type: 'null' }]);
    expect(recordObs.input_schema.required).toContain('clarification_chain_id');
    expect(recordObs.input_schema.additionalProperties).toBe(false);
  });

  test('all three model-facing chain-id descriptions mention the mutation echo and drop "and nowhere else" (D2)', () => {
    const askUser = byName('ask_user');
    const recordObs = byName('record_observation');
    const askToolDesc = askUser.description;
    const askProp = askUser.input_schema.properties.clarification_chain_id.description;
    const recProp = recordObs.input_schema.properties.clarification_chain_id.description;

    // Mutation echo present on all three.
    expect(askToolDesc).toMatch(/record_observation/);
    expect(askProp).toMatch(/record_observation/);
    expect(recProp).toMatch(/observation_clarify/);

    // All three carry the "never on an unrelated observation" prohibition — a
    // reused id would falsely qualify a chain whose observation was dropped.
    expect(askToolDesc).toMatch(/unrelated observation/);
    expect(askProp).toMatch(/unrelated observation/);
    expect(recProp).toMatch(/unrelated observation/);

    // The stale "and nowhere else" confinement is gone from the property
    // description (it contradicted the new mutation echo).
    expect(askProp).not.toContain('and nowhere else');

    // ask_user tool description documents the conditional result shape carrying
    // the chain id (present for observation_clarify asks).
    expect(askToolDesc).toContain('clarification_chain_id?:string');
  });

  test('delete_observation.reason enum sourced from stage6-enumerations.json', () => {
    const deleteObs = byName('delete_observation');
    expect(deleteObs.input_schema.properties.reason.enum).toEqual(
      enumerations.delete_observation_reason
    );
    expect(deleteObs.input_schema.required.sort()).toEqual(['observation_id', 'reason'].sort());
  });

  test('ask_user.reason and expected_answer_shape enums sourced from enumerations.json', () => {
    const askUser = byName('ask_user');
    expect(askUser.input_schema.properties.reason.enum).toEqual(enumerations.ask_user_reason);
    expect(askUser.input_schema.properties.expected_answer_shape.enum).toEqual(
      enumerations.expected_answer_shape
    );
  });

  test('ask_user.context_field uses anyOf with codegenned enum on string branch + null branch (Bug-D fix)', () => {
    const askUser = byName('ask_user');
    const contextField = askUser.input_schema.properties.context_field;
    // Bug-D fix (2026-04-26): switched from type-array+enum to anyOf.
    expect(contextField.type).toBeUndefined();
    expect(Array.isArray(contextField.anyOf)).toBe(true);
    expect(contextField.anyOf).toHaveLength(2);
    const stringBranch = contextField.anyOf[0];
    const nullBranch = contextField.anyOf[1];
    expect(stringBranch.type).toBe('string');
    expect(nullBranch.type).toBe('null');

    // 2026-05-09 widening: enum is now circuit_fields ∪ board_fields ∪
    // supply_characteristics_fields ∪ installation_details_fields ∪ sentinels
    // (deduped). The four field buckets overlap on a couple of names
    // (`earthing_arrangement` lives in both supply and board), so length is
    // computed from the same Set the schema builds.
    const filterMeta = (k) => !k.startsWith('_ui_');
    const expectedKeys = new Set([
      ...Object.keys(fieldSchema.circuit_fields).filter(filterMeta),
      ...Object.keys(fieldSchema.board_fields).filter(filterMeta),
      ...Object.keys(fieldSchema.supply_characteristics_fields).filter(filterMeta),
      ...Object.keys(fieldSchema.installation_details_fields).filter(filterMeta),
      ...contextKeys.sentinels,
    ]);
    expect(stringBranch.enum).toHaveLength(expectedKeys.size);
    for (const key of expectedKeys) {
      expect(stringBranch.enum).toContain(key);
    }
    expect(stringBranch.enum).not.toContain(null);
  });

  test('ask_user.context_field accepts the multi-board hierarchy keys (regression — field session CBC1C763, 2026-05-09)', () => {
    // Pins the 2026-05-09 widening. Pre-fix these keys triggered
    // `invalid_context_field` at stage6-dispatch-validation.js:304 when
    // Sonnet tried to focus-ask "Which circuit feeds this sub-board?" or
    // "Is this sub-distribution or sub-main?" — the focused ask never
    // reached TTS, Sonnet fell back to add_board with missing fields, and
    // the inspector saw nothing happen. Each key listed here corresponds
    // to a board-level slot that Sonnet must be able to legally scope an
    // ask to during sub-board creation.
    const askUser = byName('ask_user');
    const stringBranch = askUser.input_schema.properties.context_field.anyOf[0];
    const required = [
      'parent_board_id',
      'feed_circuit_ref',
      'board_type',
      'sub_main_cable_material',
      'sub_main_cable_csa',
      'sub_main_cpc_csa',
    ];
    for (const key of required) {
      expect(stringBranch.enum).toContain(key);
    }
  });

  test('ask_user.context_field accepts supply + installation field keys (so Sonnet can scope clarification asks)', () => {
    // Sonnet has been writing supply/installation fields via
    // record_board_reading for ages, but pre-2026-05-09 it could only tag
    // CLARIFICATION asks for those fields with the `none` sentinel, so
    // ask-bucket analytics had no field-level fidelity for the half of the
    // job that lives outside circuits[]. Widening makes context_field
    // analytics symmetric across both write tools.
    const askUser = byName('ask_user');
    const stringBranch = askUser.input_schema.properties.context_field.anyOf[0];
    expect(stringBranch.enum).toContain('earth_loop_impedance_ze');
    expect(stringBranch.enum).toContain('prospective_fault_current');
    expect(stringBranch.enum).toContain('address');
    expect(stringBranch.enum).toContain('postcode');
  });

  test('ask_user.context_field — no hand-rolled sentinel literals in schema module (Plan 02-01 single-source-of-truth guard)', () => {
    // Guard against a future edit that re-inlines the sentinel literals into
    // stage6-tool-schemas.js rather than sourcing them from
    // config/stage6-context-keys.json. The raw file MUST NOT contain an
    // `enum: ['observation_clarify'` literal.
    const src = fs.readFileSync(
      path.join(repoRoot, 'src', 'extraction', 'stage6-tool-schemas.js'),
      'utf8'
    );
    expect(src).not.toMatch(/enum:\s*\[\s*['"]observation_clarify['"]/);
  });

  test('PHASE 2 BLOCKER comment is removed from stage6-tool-schemas.js (Plan 02-01 closes the carryover)', () => {
    const src = fs.readFileSync(
      path.join(repoRoot, 'src', 'extraction', 'stage6-tool-schemas.js'),
      'utf8'
    );
    expect(src).not.toMatch(/PHASE 2 BLOCKER/);
  });

  test('rename_circuit requires from_ref and circuit_ref (Plan 02-01 — without from_ref the tool cannot actually rename)', () => {
    const rename = byName('rename_circuit');
    // Required list is exactly [from_ref, circuit_ref]. Length assertion
    // catches any future drift that adds unintended required keys.
    expect(rename.input_schema.required).toHaveLength(2);
    expect(rename.input_schema.required.sort()).toEqual(['circuit_ref', 'from_ref'].sort());
    // from_ref schema shape — integer, described. NB: `minimum: 1` used to
    // live on the schema but Anthropic strict-mode tools reject numerical
    // constraints (`tools.0.custom: For 'number' type, properties maximum,
    // minimum are not supported`). The lower bound is now enforced server-side
    // by validateRenameCircuit (stage6-dispatch-validation.js). This test
    // explicitly asserts `minimum` is absent so a regression that re-adds it
    // would fail in CI rather than blowing up in production at the API layer.
    const fromRef = rename.input_schema.properties.from_ref;
    expect(fromRef).toBeDefined();
    expect(fromRef.type).toBe('integer');
    expect(fromRef.minimum).toBeUndefined();
    expect(fromRef.maximum).toBeUndefined();
    expect(typeof fromRef.description).toBe('string');
    expect(fromRef.description.length).toBeGreaterThan(10);
  });

  test('create_circuit.required === [circuit_ref] — guards against rename=create regression (Plan 02-01 symmetry audit)', () => {
    const create = byName('create_circuit');
    // create_circuit is semantically distinct: it accepts only circuit_ref
    // as required. If rename_circuit and create_circuit share identical
    // required lists, dispatchers cannot disambiguate — this test locks the
    // distinction in.
    expect(create.input_schema.required).toEqual(['circuit_ref']);
    // from_ref must NOT exist on create_circuit.
    expect(create.input_schema.properties.from_ref).toBeUndefined();
  });

  test('Plan 02-01 required-list audit: all six write tools match REQUIREMENTS.md STS-01..06 literally', () => {
    // STS-01 record_reading
    expect(byName('record_reading').input_schema.required.sort()).toEqual(
      ['circuit', 'confidence', 'field', 'source_turn_id', 'value'].sort()
    );
    // STS-02 clear_reading
    expect(byName('clear_reading').input_schema.required.sort()).toEqual(
      ['circuit', 'field', 'reason'].sort()
    );
    // STS-03 create_circuit
    expect(byName('create_circuit').input_schema.required).toEqual(['circuit_ref']);
    // STS-04 rename_circuit — Plan 02-01 adds from_ref
    expect(byName('rename_circuit').input_schema.required.sort()).toEqual(
      ['circuit_ref', 'from_ref'].sort()
    );
    // STS-05 record_observation (Phase 1 round-4 MAJOR #3 — re-asserted)
    // schedule_item added 2026-05-01 (BPG4 pipeline restoration).
    // rationale added 2026-06-23 (Plan obs-#51 — required-with-null).
    // clarification_chain_id added 2026-07-15 (D2 chain-correlation — required-with-null).
    expect(byName('record_observation').input_schema.required.sort()).toEqual(
      [
        'circuit',
        'clarification_chain_id',
        'code',
        'location',
        'rationale',
        'schedule_item',
        'suggested_regulation',
        'text',
      ].sort()
    );
    // STS-06 delete_observation
    expect(byName('delete_observation').input_schema.required.sort()).toEqual(
      ['observation_id', 'reason'].sort()
    );
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

describe('ask_user.context_circuits (session C0C21546 2026-06-04)', () => {
  const byName = (name) => TOOL_SCHEMAS.find((t) => t.name === name);

  test('schema declares context_circuits as anyOf([array, null])', () => {
    const askUser = byName('ask_user');
    const ctxCircuits = askUser.input_schema.properties.context_circuits;
    expect(ctxCircuits).toBeDefined();
    expect(Array.isArray(ctxCircuits.anyOf)).toBe(true);
    expect(ctxCircuits.anyOf.some((b) => b.type === 'null')).toBe(true);
    const arr = ctxCircuits.anyOf.find((b) => b.type === 'array');
    expect(arr).toBeDefined();
    expect(arr.minItems).toBe(2);
    expect(arr.uniqueItems).toBe(true);
    expect(arr.items).toEqual({ type: 'integer', minimum: 1 });
  });

  test('context_circuits is OPTIONAL (not in required[])', () => {
    const askUser = byName('ask_user');
    expect((askUser.input_schema.required ?? []).includes('context_circuits')).toBe(false);
  });
});
