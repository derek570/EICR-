/**
 * Stage 6 Agentic Extraction — Anthropic tool-schema codegen.
 *
 * Exports TOOL_SCHEMAS: an array of 7 Anthropic tool definitions with
 * strict:true input schemas, codegenned at module load from:
 *   - config/field_schema.json              (circuit_fields -> record_reading.field enum)
 *   - config/stage6-enumerations.json       (every other enum)
 *
 * Why runtime codegen (not a build step):
 *   - No committed generated artefact that can drift from its sources.
 *   - Tests can mutate fixtures without re-running a build.
 *   - ~1ms startup cost is negligible.
 *
 * Why strict:true on every tool:
 *   - REQUIREMENTS.md STS-08 mandates it.
 *   - Removes the need for a text-parsing fallback in the dispatcher layer —
 *     the API rejects invalid enum values before the call reaches our code
 *     (empirical verification via scripts/stage6-strict-mode-probe.js — see
 *     .planning-stage6-agentic/phases/01-foundation/OPEN_QUESTIONS.md Q#4).
 *
 * Why JSON imports via createRequire (not import-attributes `with { type: 'json' }`):
 *   - Jest's experimental-vm-modules loader does not yet support JSON import
 *     attributes. createRequire works under both Node's ESM loader and Jest's.
 *   - Once Jest ships support, this can be migrated without behaviour change.
 *
 * Scope lock: Phase 1 ships schemas only. Dispatchers (Phase 2) validate
 * circuit existence, enforce the ask_user budget, and mutate state. This file
 * has zero runtime side-effects beyond building the schema array.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// eslint-disable-next-line import/no-unresolved -- JSON is co-located config.
const fieldSchema = require('../../config/field_schema.json');
// eslint-disable-next-line import/no-unresolved -- JSON is co-located config.
const enumerations = require('../../config/stage6-enumerations.json');

/**
 * Build an Anthropic tool definition. Centralising the shape guarantees every
 * tool gets strict:true + additionalProperties:false without opportunity for
 * per-tool drift.
 */
function makeTool({ name, description, properties, required }) {
  return {
    name,
    description,
    strict: true,
    input_schema: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    },
  };
}

// ---------------------------------------------------------------------------
// STS-01: record_reading
// Writes a test reading into stateSnapshot.circuits[circuit][field].
// field enum is sourced from field_schema.circuit_fields keys (Phase 1
// resolved Q#2 as circuit-scoped; board-level readings may be widened in
// Phase 2 or split into record_board_reading).
// ---------------------------------------------------------------------------
const recordReading = makeTool({
  name: 'record_reading',
  description:
    'Write a test reading into stateSnapshot.circuits[circuit][field]. Use for every routine circuit reading captured from the inspector. The circuit must already exist in the schedule; if it does not, call create_circuit first (or ask_user for out_of_range_circuit).',
  properties: {
    field: {
      type: 'string',
      enum: Object.keys(fieldSchema.circuit_fields),
      description:
        'The circuit_fields key to write. Must match a key from config/field_schema.json circuit_fields.',
    },
    circuit: {
      type: 'integer',
      description:
        'The circuit_ref of the target circuit. Must reference an existing circuit; no silent create.',
    },
    value: {
      type: 'string',
      description:
        'Post-normalisation value as a string. Dispatcher will coerce to the field-specific type.',
    },
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'Model confidence 0.0–1.0 for this capture.',
    },
    source_turn_id: {
      type: 'string',
      description:
        'Identifier of the user turn this reading came from; used for dedup and correlation in logs.',
    },
  },
  required: ['field', 'circuit', 'value', 'confidence', 'source_turn_id'],
});

// ---------------------------------------------------------------------------
// STS-02: clear_reading
// Clears a previously-written reading. Used for corrections.
// ---------------------------------------------------------------------------
const clearReading = makeTool({
  name: 'clear_reading',
  description:
    'Clear a previously-written reading on stateSnapshot.circuits[circuit][field]. Used for corrections — emit this alongside a fresh record_reading in the same response when the user restates a value.',
  properties: {
    field: {
      type: 'string',
      enum: Object.keys(fieldSchema.circuit_fields),
      description: 'The circuit_fields key to clear.',
    },
    circuit: {
      type: 'integer',
      description: 'The circuit_ref of the target circuit.',
    },
    reason: {
      type: 'string',
      enum: enumerations.clear_reading_reason,
      description:
        'Why the reading is being cleared. user_correction: inspector restated. misheard: transcript was wrong. wrong_circuit: value was written to the wrong circuit_ref.',
    },
  },
  required: ['field', 'circuit', 'reason'],
});

// ---------------------------------------------------------------------------
// STS-03: create_circuit
// Creates a new circuit row. No silent creation via record_reading.
// Requires only circuit_ref per REQUIREMENTS.md; other fields default to null.
// ---------------------------------------------------------------------------
const createCircuit = makeTool({
  name: 'create_circuit',
  description:
    'Append a new circuit to stateSnapshot.circuits. Use when the inspector references a circuit_ref not in the current schedule (typically after an ask_user confirms the addition). Dispatcher (Phase 2) rejects duplicate circuit_ref with a validation_error.',
  properties: {
    circuit_ref: {
      type: 'integer',
      description:
        'Circuit reference number. Must be unique within the current board.',
    },
    designation: {
      type: ['string', 'null'],
      description:
        'Human-readable circuit name (e.g. "Upstairs lighting"). Null if unknown.',
    },
    phase: {
      type: ['string', 'null'],
      enum: [...enumerations.circuit_phase, null],
      description:
        'Electrical phase. L1/L2/L3 for three-phase installations, single for single-phase. Null if unknown. Strict-mode JSON Schema validates enum against the VALUE, so null must be present in both `type` and `enum` for a `phase: null` payload to pass — REQUIREMENTS STS-03 explicitly permits `phase | null`.',
    },
    rating_amps: {
      type: ['integer', 'null'],
      description: 'OCPD rating in amps. Null if unknown.',
    },
    cable_csa_mm2: {
      type: ['number', 'null'],
      description: 'Live conductor cross-sectional area in mm^2. Null if unknown.',
    },
  },
  required: ['circuit_ref'],
});

// ---------------------------------------------------------------------------
// STS-04: rename_circuit
// Update designation or electrical properties of an existing circuit.
// Schema is byte-identical to create_circuit (see Open Q#3 — the tools
// are semantically distinguished by dispatcher validation, not by shape).
// ---------------------------------------------------------------------------
const renameCircuit = makeTool({
  name: 'rename_circuit',
  description:
    'Update designation or electrical properties of an existing circuit. Use when the inspector restates a circuit\'s description or electrical spec. Dispatcher (Phase 2) rejects non-existent circuit_ref with a validation_error.',
  properties: {
    circuit_ref: {
      type: 'integer',
      description: 'Circuit reference number of the existing circuit to update.',
    },
    designation: {
      type: ['string', 'null'],
      description: 'New human-readable circuit name. Null to leave unchanged.',
    },
    phase: {
      type: ['string', 'null'],
      enum: [...enumerations.circuit_phase, null],
      description:
        'New electrical phase. Null to leave unchanged. Strict-mode JSON Schema validates enum against the VALUE — null must appear in both `type` and `enum` for REQUIREMENTS STS-04 `phase | null`.',
    },
    rating_amps: {
      type: ['integer', 'null'],
      description: 'New OCPD rating in amps. Null to leave unchanged.',
    },
    cable_csa_mm2: {
      type: ['number', 'null'],
      description:
        'New live conductor cross-sectional area in mm^2. Null to leave unchanged.',
    },
  },
  required: ['circuit_ref'],
});

// ---------------------------------------------------------------------------
// STS-05: record_observation
// Append an observation to session.observations.
// ---------------------------------------------------------------------------
const recordObservation = makeTool({
  name: 'record_observation',
  description:
    'Append an observation (defect, non-compliance, limitation, or further-investigation item) to the certificate. Emit whenever the inspector calls out a specific fault or concern.',
  properties: {
    code: {
      type: 'string',
      enum: enumerations.observation_code,
      description:
        'Observation classification. C1: Danger present / risk of injury (immediate remedial). C2: Potentially dangerous. C3: Improvement recommended. FI: Further investigation required.',
    },
    location: {
      type: 'string',
      description:
        'Where in the installation the observation applies (room, distribution board, specific accessory).',
    },
    text: {
      type: 'string',
      description:
        'Full observation wording as it will appear on the certificate.',
    },
    circuit: {
      type: ['integer', 'null'],
      description:
        'Circuit_ref this observation is associated with, or null for board-wide / installation-wide observations.',
    },
    suggested_regulation: {
      type: ['string', 'null'],
      description:
        'BS7671 regulation reference (e.g. "411.3.1.1") if the model can reliably cite one. Null otherwise — the inspector will add it during review.',
    },
  },
  required: ['code', 'location', 'text'],
});

// ---------------------------------------------------------------------------
// STS-06: delete_observation
// Remove a previously-recorded observation (undo / correction).
// ---------------------------------------------------------------------------
const deleteObservation = makeTool({
  name: 'delete_observation',
  description:
    'Remove a previously-recorded observation from session.observations. Use when the inspector retracts or corrects an observation. The observation_id is assigned by the dispatcher at record_observation time and is echoed back to the model in subsequent state snapshots.',
  properties: {
    observation_id: {
      type: 'string',
      description:
        'Server-assigned id of the observation to remove. Must match an existing observation in the session.',
    },
    reason: {
      type: 'string',
      enum: enumerations.delete_observation_reason,
      description:
        'Why the observation is being removed. user_correction: inspector retracted. duplicate: same observation already present. misheard: transcript misclassified a remark as an observation.',
    },
  },
  required: ['observation_id', 'reason'],
});

// ---------------------------------------------------------------------------
// STS-07: ask_user
// Blocking clarification tool. Phase 3 implements the blocking dispatch
// contract; Phase 1 ships the schema only.
// ---------------------------------------------------------------------------
const askUser = makeTool({
  name: 'ask_user',
  description:
    'Blocking clarification tool. Server pauses the model turn, iOS speaks the question via TTS, user replies via STT, reply is returned as tool_result, model resumes in the same turn. Use ONLY when acting without asking would be wrong. Do not ask if you have already asked about the same (context_field, context_circuit) pair in this session.',
  properties: {
    question: {
      type: 'string',
      description:
        'Exact phrasing to speak to the inspector. Concise, natural, ends with a question mark.',
    },
    reason: {
      type: 'string',
      enum: enumerations.ask_user_reason,
      description:
        'Why the ask is being made. out_of_range_circuit: inspector referenced a circuit_ref not in the schedule. ambiguous_circuit: multiple circuits match the description. contradiction: new value conflicts with an existing reading. observation_confirmation: wording ambiguous enough to warrant a check. missing_context: a required companion value is absent.',
    },
    context_field: {
      type: ['string', 'null'],
      description:
        'Context key this ask is blocking on (e.g. "measured_zs_ohm", "earthing_arrangement", "observation_confirmation"), or null if the ask is not field-scoped. STS-07 mandates `string | null` — intentionally open-ended in Phase 1 because Phase 2+ asks need non-circuit scopes (board-level readings, earthing, observation confirmation, general missing-context) that the circuit_fields key set does not cover. An early iteration narrowed this to `Object.keys(fieldSchema.circuit_fields) | null` to stabilise Phase 5 per-(context_field, context_circuit) budget analytics; Codex round-3 STG review flagged that the narrow enum would force Phase 2 non-circuit asks to collapse to null, breaking those same analytics on the non-circuit path. PHASE 2 BLOCKER: Plan 02-01 MUST design the canonical Stage-6 context-key namespace (circuit_fields keys + board-scope keys + observation/general sentinels) and reinstate a strict enum here before non-circuit asks ship. Until then, Phase 5 analytics will bucket by raw value; budget drift is accepted in exchange for unblocked Phase 2 scope.',
    },
    context_circuit: {
      type: ['integer', 'null'],
      description:
        'Circuit_ref this ask is scoped to, or null if the ask is board- or installation-wide.',
    },
    expected_answer_shape: {
      type: 'string',
      enum: enumerations.expected_answer_shape,
      description:
        'Shape the model expects the answer to take. Drives downstream parsing hints. yes_no / number / free_text / circuit_ref.',
    },
  },
  required: ['question', 'reason', 'expected_answer_shape'],
});

// ---------------------------------------------------------------------------
// Exports — declared in a fixed order so callers can rely on it for logging /
// metric tagging. The order matches REQUIREMENTS.md STS-01..07.
// ---------------------------------------------------------------------------
export const TOOL_SCHEMAS = [
  recordReading,
  clearReading,
  createCircuit,
  renameCircuit,
  recordObservation,
  deleteObservation,
  askUser,
];

/**
 * Look up a tool by name. Returns undefined for unknown names so callers can
 * short-circuit cleanly when a dispatcher receives an unrecognised tool_use
 * block (belt-and-braces — strict:true should already reject these at the API).
 */
export function getToolByName(name) {
  if (!name || typeof name !== 'string') return undefined;
  return TOOL_SCHEMAS.find((t) => t.name === name);
}
