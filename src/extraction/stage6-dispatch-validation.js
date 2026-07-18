/**
 * Stage 6 Phase 2 Plan 02-02 + Phase 3 Plan 03-02 — Pure dispatch-time
 * validators.
 *
 * WHAT: Seven pure functions mapping input → null | {code, field?}. Six
 * write-tool validators (Plan 02-02) + one ask_user validator (Plan 03-02,
 * STS-07).
 * They are pre-mutation gates: the dispatcher calls the validator first, and
 * only proceeds to state mutation + success logging if the validator returned
 * null. Rejection envelopes are logged with outcome:'rejected' by the
 * dispatcher.
 *
 * WHY pure (no mutation, no logging, no async):
 *   - Testability: unit tests construct a plain snapshot literal, no mocks.
 *   - Composability: the shadow comparator (Plan 02-06) replays these
 *     validators to predict what the legacy path would have accepted vs
 *     rejected — that only works if the validator is a pure function of
 *     (input, state).
 *   - Clarity: a validator that also logs hides rejections from the
 *     dispatcher's log row — the dispatcher owns logging, full stop.
 *
 * Validation-code namespace (must stay bounded — Phase 7 analyzer groups by
 * these codes; unbounded string space = broken dashboards):
 *   circuit_not_found       — record_reading / clear_reading / rename_circuit
 *                             references a circuit not in snapshot.circuits.
 *   circuit_already_exists  — create_circuit on an existing circuit_ref.
 *   source_not_found        — rename_circuit.from_ref not in snapshot.circuits.
 *   target_exists           — rename_circuit.circuit_ref already exists and
 *                             differs from from_ref (would overwrite).
 *   invalid_type            — numeric meta arrived as string (Pitfall #5).
 *                             strict:true catches this at the API boundary,
 *                             but we defend locally too.
 *   unknown_tool            — emitted by createWriteDispatcher (not here).
 *
 * BLOCK-2 (NOT in this namespace): 'observation_not_found'. An attempt to
 * delete an unknown observation is semantically a noop — the post-state
 * already satisfies the request. `validateDeleteObservation` returns null
 * always; `dispatchDeleteObservation` (Plan 02-04) handles the absence case
 * by returning {ok:true, noop:true, reason:'observation_not_found'} with
 * is_error:false. Research §Q8.
 *
 * Phase 3 addition (STS-07): `validateAskUser` below. Same pure-function
 * shape, but operates on the ask_user tool payload only — it does not consume
 * a snapshot because ask_user has no state preconditions beyond the
 * structural ones encoded by the schema. Failure-code namespace (bounded):
 *   invalid_question              — missing / empty / >500 chars / non-string
 *   invalid_reason                — not in ASK_USER_REASONS
 *   invalid_context_field         — non-null and not in CONTEXT_FIELD_ENUM
 *   invalid_context_circuit       — non-null and not an integer
 *   invalid_context_circuits      — present but not a unique-int array of length >= 2 with all >= 1
 *   context_circuit_conflict      — BOTH context_circuit and context_circuits set (XOR violation)
 *   invalid_expected_answer_shape — not in ASK_USER_ANSWER_SHAPES
 */

import { createRequire } from 'node:module';
import {
  CONTEXT_FIELD_ENUM,
  BOARD_FIELD_ENUM,
  CIRCUIT_FIELD_ENUM,
  CLEAR_READING_FIELD_ENUM,
} from './stage6-tool-schemas.js';
import {
  circuitExistsInSnapshot,
  getMainBoardId,
  listCircuitRefsInBoard,
} from './stage6-multi-board-shape.js';
import {
  isWithinRange,
  CIRCUIT_FIELD_NUMERIC_RANGES,
  BOARD_FIELD_NUMERIC_RANGES,
} from './value-enum-validator.js';

// Fix B 2026-06-02 (handoff-2026-06-02-fixes.md §B) — per-field VALUE
// enum lookup, loaded from config/field_schema.json. The schema is the
// single source of truth (already consumed by stage6-tool-schemas.js's
// CIRCUIT_FIELD_ENUM builder for the name namespace); building the
// VALUE map here means a schema edit to `options[]` propagates to the
// dispatcher with no code change.
//
// Why createRequire vs an ESM `import ... with { type: 'json' }`: the
// codebase consistently uses createRequire for JSON loads (see
// stage6-tool-schemas.js:38-42). Keeping the pattern uniform avoids
// bundler-vs-node-loader behaviour drift.
//
// What gets a value enum: every field with `type: "select"` AND a
// non-empty `options` array. Fields with `type: "text"` are not
// constrained here (numeric ranges, BS-EN format checks, etc. are
// separate concerns and not in this validator's scope today).
//
// CRITICAL — the empty string "" is NOT auto-allowed. Some select
// fields list "" as an explicit option (rcd_type, polarity_confirmed)
// to mean "no reading yet"; others (ocpd_type, wiring_type, ref_method)
// do NOT — they don't have an "unwritten" representation. Treating ""
// as a universal escape would leak garbage writes through on every
// field that doesn't enumerate it. The validator checks membership
// strictly: input.value must appear in options[] verbatim.
const require = createRequire(import.meta.url);
const fieldSchema = require('../../config/field_schema.json');

export const CIRCUIT_FIELD_VALUE_ENUMS = (() => {
  const out = new Map();
  const fields = fieldSchema.circuit_fields ?? {};
  for (const [name, spec] of Object.entries(fields)) {
    if (name.startsWith('_ui_')) continue;
    if (spec?.type === 'select' && Array.isArray(spec.options)) {
      out.set(name, new Set(spec.options.map(String)));
    }
  }
  return out;
})();

/**
 * BOARD-side value enum map. Same construction as CIRCUIT_FIELD_VALUE_ENUMS
 * but spans THREE schema sections — supply_characteristics_fields,
 * board_fields, installation_details_fields — matching the union
 * `BOARD_FIELD_ENUM` builder uses in stage6-tool-schemas.js:130-136.
 *
 * Exported so the board dispatcher can apply the same enum guard pattern
 * inline (the dispatcher's existing field-NAME check is left intact;
 * this map adds the value-side check).
 */
export const BOARD_FIELD_VALUE_ENUMS = (() => {
  const out = new Map();
  for (const section of [
    'supply_characteristics_fields',
    'board_fields',
    'installation_details_fields',
  ]) {
    const fields = fieldSchema[section] ?? {};
    for (const [name, spec] of Object.entries(fields)) {
      if (name.startsWith('_ui_')) continue;
      if (spec?.type === 'select' && Array.isArray(spec.options)) {
        out.set(name, new Set(spec.options.map(String)));
      }
    }
  }
  return out;
})();

// Sets for O(1) membership tests in validateAskUser's pending_write
// cross-check. Pre-computing them here keeps the validator pure (no
// Array.includes scans on every call) without exposing Sets across module
// boundaries.
const RECORD_READING_FIELDS = new Set(CIRCUIT_FIELD_ENUM);
const RECORD_BOARD_READING_FIELDS = new Set(BOARD_FIELD_ENUM);
// §A2 Codex r6-#1 — the clear_reading field exclusions (circuit_ref,
// is_distribution_circuit, feeds_board_id) lived ONLY in the tool schema's
// enum, and the Anthropic tool definitions are not strictly enforced at
// runtime — an off-schema field reached dispatchClearReading and could
// clear row identity or silently break the board hierarchy. Same source of
// truth as the schema (CLEAR_READING_FIELD_ENUM), enforced here at runtime.
const CLEAR_READING_FIELDS = new Set(CLEAR_READING_FIELD_ENUM);

/**
 * record_reading: circuit must exist; confidence (when present) must be a
 * finite number in [0, 1]. The bound used to live on the input_schema as
 * `minimum: 0, maximum: 1` but Anthropic strict-mode tools reject those
 * keywords on number/integer types (`tools.0.custom: For 'number' type,
 * properties maximum, minimum are not supported`). The schema still marks
 * confidence as required so strict-mode-compliant calls always supply it;
 * the dispatcher defaults missing/null to 1.0 (legacy pass-through), so
 * we only reject present-but-invalid values here.
 */
export function validateRecordReading(input, snapshot) {
  if (!circuitExistsInSnapshot(snapshot, input.circuit, input.board_id)) {
    return { code: 'circuit_not_found', field: 'circuit' };
  }
  if (input.confidence != null) {
    if (
      typeof input.confidence !== 'number' ||
      !Number.isFinite(input.confidence) ||
      input.confidence < 0 ||
      input.confidence > 1
    ) {
      return { code: 'confidence_out_of_range', field: 'confidence' };
    }
  }
  // Fix B 2026-06-02 (handoff §B) — per-field VALUE enum gate. Runs
  // AFTER the dispatcher's coercion pass (ordering enforced in
  // stage6-dispatchers-circuit.js dispatchRecordReading); fields not in
  // CIRCUIT_FIELD_VALUE_ENUMS (numeric/text fields without a closed
  // enum) pass through unchanged. Field NAME validity is enforced
  // upstream by the schema's strict:true input_schema + the field-NAME
  // namespace check that record_reading callers already see; this
  // check is value-only.
  //
  // Why value_not_in_options + valid_options[] payload: mirrors the
  // existing envelope used by set_field_for_all_circuits (the validator
  // there already surfaces the same shape so Sonnet can self-correct
  // on the next round). Same code → unified CloudWatch + dashboard
  // attribution.
  //
  // Why no empty-string exemption: some enums list "" (rcd_type,
  // polarity_confirmed) to mean "unwritten"; others (ocpd_type,
  // wiring_type, ref_method) deliberately don't. Treating "" as a
  // universal escape would silently accept blank writes on every field
  // that doesn't list it. Strict membership wins; "clear this field"
  // semantics belong to the clear_reading tool, not record_reading.
  const allowed = CIRCUIT_FIELD_VALUE_ENUMS.get(input.field);
  if (allowed) {
    if (typeof input.value !== 'string') {
      return { code: 'invalid_type', field: 'value' };
    }
    if (!allowed.has(input.value)) {
      return {
        code: 'value_not_in_options',
        field: 'value',
        valid_options: Array.from(allowed),
      };
    }
  }
  // Audit-2026-06-02 Phase 1 — numeric range gate for free-text numeric
  // fields (rcd_time_ms, measured_zs_ohm, ocpd_rating_a, …) that have
  // no closed enum in field_schema.json. Same rejection-envelope shape
  // as `value_not_in_options` so Sonnet's tool loop self-corrects via
  // the same path. See value-enum-validator.js for the per-field range
  // table + helper semantics (sentinel form, blank-passes, non-numeric
  // rejection).
  //
  // Empty-enum branch above doesn't catch this: rcd_time_ms is a free-
  // text field per the schema (no `options[]`), so allowed===undefined
  // and the closed-enum gate falls through. The range gate is the only
  // line of defence for "Sonnet wrote 3000 ms for a 30 mA AC RCD".
  const rangeVerdict = isWithinRange(input.field, input.value, CIRCUIT_FIELD_NUMERIC_RANGES);
  if (!rangeVerdict.ok) {
    return {
      code: rangeVerdict.code,
      field: 'value',
      value: input.value,
      min: rangeVerdict.min,
      max: rangeVerdict.max,
    };
  }
  return null;
}

/**
 * clear_reading: circuit must exist. `field_not_set` (the field is not
 * currently populated on that circuit) is NOT a validator rejection — it is
 * a dispatcher-level noop path returning {ok:true, noop:true} per Research
 * §Q8.
 */
export function validateClearReading(input, snapshot) {
  // Codex r6-#1 — runtime enforcement of the schema enum. Checked BEFORE
  // circuit existence so an excluded/unknown field is named as the error
  // even when the circuit is also wrong.
  if (!CLEAR_READING_FIELDS.has(input.field)) {
    return { code: 'field_not_clearable', field: 'field', value: input.field };
  }
  if (!circuitExistsInSnapshot(snapshot, input.circuit, input.board_id)) {
    return { code: 'circuit_not_found', field: 'circuit' };
  }
  return null;
}

/**
 * create_circuit: circuit_ref must be new; numeric meta must be numeric.
 */
export function validateCreateCircuit(input, snapshot) {
  if (circuitExistsInSnapshot(snapshot, input.circuit_ref, input.board_id)) {
    return { code: 'circuit_already_exists', field: 'circuit_ref' };
  }
  // F1AC26FB #5.2 — reject implausible scratch/temp circuit refs. There is
  // no atomic swap tool, so to "swap circuits 3 and 4" Sonnet parked a
  // scratch circuit 999 "(temp)" as a rekey buffer and never cleaned it up,
  // leaving a junk circuit on the cert. A real circuit ref is a small board
  // position: refs >= 100, or far above the current max for this board, are
  // almost always model-invented scratch. Designation swaps must use two
  // rename_circuit calls (see the SWAP/REORDER prompt rule), never a
  // placeholder. iOS already tolerates a rejected op, so this is safe.
  // (>= 100 is the absolute cap; +20 over the current max catches scratch
  // refs on boards that legitimately run to high way-counts. Bump only if a
  // real board exceeds 100 ways.)
  if (Number.isInteger(input.circuit_ref)) {
    const existingRefs = listCircuitRefsInBoard(snapshot, input.board_id);
    const maxExistingRef = existingRefs.length > 0 ? Math.max(...existingRefs) : 0;
    if (input.circuit_ref >= 100 || input.circuit_ref > maxExistingRef + 20) {
      return {
        code: 'implausible_circuit_ref',
        field: 'circuit_ref',
        max_existing_ref: maxExistingRef,
        hint: 'Do not create scratch/temp circuits for swaps; update existing circuit designations with rename_circuit.',
      };
    }
  }
  if (input.rating_amps != null && typeof input.rating_amps !== 'number') {
    return { code: 'invalid_type', field: 'rating_amps' };
  }
  if (input.cable_csa_mm2 != null && typeof input.cable_csa_mm2 !== 'number') {
    return { code: 'invalid_type', field: 'cable_csa_mm2' };
  }
  return null;
}

/**
 * rename_circuit: source must exist; target must not collide (unless same as
 * source — a "rename to self" is a permitted noop). Numeric meta must be
 * numeric.
 */
export function validateRenameCircuit(input, snapshot) {
  // Lower bound (>=1) used to live on the input_schema as `minimum: 1` —
  // Anthropic strict-mode tools reject numerical constraints on integer/number
  // types, so we enforce it here. Same rationale as confidence in
  // validateRecordReading above.
  if (!Number.isInteger(input.from_ref) || input.from_ref < 1) {
    return { code: 'invalid_from_ref', field: 'from_ref' };
  }
  if (!circuitExistsInSnapshot(snapshot, input.from_ref, input.board_id)) {
    // 2026-06-12 field report (session 15B88D6B, voiceFeedbackId 22):
    // "Circuit 1 is— circuit 2 is a upstairs lighting circuit" (merged
    // stutter) made Sonnet call rename_circuit(1→2) on an EMPTY board; the
    // bare {code, field} rejection gave the model nothing to recover with
    // and it ended the turn silently — the dictated circuit name was lost
    // with no question asked. Surface the existing refs plus an explicit
    // recovery hint so the tool loop self-corrects to create_circuit (or
    // asks) instead of dropping the inspector's dictation on the floor.
    return {
      code: 'source_not_found',
      field: 'from_ref',
      existing_refs: listCircuitRefsInBoard(snapshot, input.board_id),
      hint: 'No circuit with this ref exists yet. If the inspector is naming a circuit that does not exist, use create_circuit instead. If their intent is unclear, use ask_user — never discard the dictated designation.',
    };
  }
  if (
    input.from_ref !== input.circuit_ref &&
    circuitExistsInSnapshot(snapshot, input.circuit_ref, input.board_id)
  ) {
    return { code: 'target_exists', field: 'circuit_ref' };
  }
  if (input.rating_amps != null && typeof input.rating_amps !== 'number') {
    return { code: 'invalid_type', field: 'rating_amps' };
  }
  if (input.cable_csa_mm2 != null && typeof input.cable_csa_mm2 !== 'number') {
    return { code: 'invalid_type', field: 'cable_csa_mm2' };
  }
  return null;
}

/**
 * record_observation: no preconditions. Enum validation (code) is strict:true
 * at the API layer; Plan 02-04 dispatcher adds a belt-and-braces local check
 * before mutation.
 */

export function validateRecordObservation(input, _session) {
  // 2026-06-03 — require a concrete BS 7671 regulation citation whenever
  // the observation carries a real Classification Code (C1 / C2 / C3 / FI).
  // The JSON tool schema makes `suggested_regulation` a required FIELD with
  // null allowed, because installation-wide / no-specific-reg cases legit
  // need null. But for a CODED observation, null is the wrong answer —
  // BPG4 7.3 and the WRAG corpus both insist every coded defect cites the
  // breached regulation, and field-test session C112923C (2026-06-03,
  // "outside light not RCD protected" → C2 with no regulation visible on
  // the iOS UI) confirmed the model was silently emitting `null` here.
  //
  // NC and any future Obs-like codes legitimately may not have a specific
  // regulation (they're documentation, not breaches), so the gate is on
  // C1/C2/C3/FI only. The matching `text` (observation_text) is also
  // required to be non-empty — emitting code+regulation without the
  // observation text is a contract violation (would render as a blank row
  // on the certificate).
  if (!input || typeof input !== 'object') return null;
  const code = typeof input.code === 'string' ? input.code.toUpperCase() : '';
  const codedCodes = new Set(['C1', 'C2', 'C3', 'FI']);
  if (!codedCodes.has(code)) return null;
  const reg = input.suggested_regulation;
  if (reg === null || reg === undefined || (typeof reg === 'string' && reg.trim() === '')) {
    return {
      code: 'regulation_required_for_coded_observation',
      field: 'suggested_regulation',
      reason: `code "${code}" requires a BS 7671 regulation citation (e.g. "411.3.4"). Null is only allowed for NC observations.`,
    };
  }
  return null;
}

/**
 * delete_observation: ALWAYS valid (BLOCK-2 contract).
 *
 * Absence of the target observation is NOT a validator rejection. It is a
 * dispatcher-level noop outcome per Research §Q8. The dispatcher in Plan
 * 02-04 is responsible for detecting the absence and returning
 *   {ok: true, noop: true, reason: 'observation_not_found'}
 * with is_error:false. This preserves the invariant that validators only
 * reject inputs the dispatcher cannot meaningfully process — a delete of an
 * unknown id IS meaningful (the post-state already satisfies the request,
 * so the correct answer is "noop").
 */

export function validateDeleteObservation(_input, _session) {
  return null;
}

/**
 * delete_circuit: ALWAYS valid for circuit_ref ≥ 1.
 *
 * Same noop-on-absence semantics as delete_observation — if the circuit isn't
 * present, the post-state already satisfies the request and the dispatcher
 * returns ok:true with deleted:false. The validator only rejects structurally
 * invalid input (non-integer or ref ≤ 0; circuit_ref 0 is the supply bucket,
 * which the delete_circuit tool MUST NOT touch — the supply data lives there
 * for the entire job life and is the wrong abstraction layer for this tool).
 */
export function validateDeleteCircuit(input, _snapshot) {
  if (!Number.isInteger(input.circuit_ref) || input.circuit_ref < 1) {
    return { code: 'invalid_circuit_ref', field: 'circuit_ref' };
  }
  return null;
}

/**
 * calculate_zs / calculate_r1_plus_r2 share the same selector shape:
 *   - circuit_ref: int|null         → single circuit (when non-null)
 *   - circuit_refs: int[]|null      → batch (when non-empty array)
 *   - all: bool                     → every circuit with required inputs
 *
 * EXACTLY ONE of these three selectors must be set. The dispatcher then walks
 * the chosen circuits, applies the formula where prerequisites are met, skips
 * (without error) where they aren't, and never overwrites an existing value.
 */
export function validateCalculateSelector(input) {
  const hasRef = Number.isInteger(input.circuit_ref) && input.circuit_ref >= 1;
  const hasRefs =
    Array.isArray(input.circuit_refs) &&
    input.circuit_refs.length > 0 &&
    input.circuit_refs.every((r) => Number.isInteger(r) && r >= 1);
  const hasAll = input.all === true;
  const setCount = (hasRef ? 1 : 0) + (hasRefs ? 1 : 0) + (hasAll ? 1 : 0);
  if (setCount === 0) {
    return { code: 'missing_selector', field: 'circuit_ref' };
  }
  if (setCount > 1) {
    return { code: 'conflicting_selector', field: 'circuit_ref' };
  }
  return null;
}

/**
 * calculate_r1_plus_r2: selector + method enum check.
 * Method must be 'zs_minus_ze' (default radial backout) or 'ring_continuity'
 * (the (R1+R2)/4 ring-final formula).
 */
export function validateCalculateR1PlusR2(input, snapshot) {
  const selErr = validateCalculateSelector(input);
  if (selErr) return selErr;
  if (input.method !== 'zs_minus_ze' && input.method !== 'ring_continuity') {
    return { code: 'invalid_method', field: 'method' };
  }
  // Codex r2 — same board-target validation as calculate_zs.
  return validateCalculateBoardTarget(input, snapshot);
}

/**
 * calculate_zs: selector check only (single formula: Zs = Ze + R1+R2).
 */
/**
 * Codex r2 (F/U-4 wave) — validate the calculator's board TARGET before any
 * Ze resolution or selector walk. `board_id:'*'` is documented as
 * unsupported on the calc tools (forward-safe key encoding only) but
 * previously returned ok:true with empty results; an unknown board id
 * produced misleading circuit_missing skips. Legacy single-board snapshots
 * (no boards[]) accept the main id.
 */
export function validateCalculateBoardTarget(input, snapshot) {
  // Codex r4 — validate the RESOLVED target, not just an explicit
  // input.board_id: a stale/'*' snapshot.currentBoardId would otherwise
  // bypass validation and silently compute against orphan buckets with the
  // origin Ze. The getMainBoardId fallback is always valid by construction.
  const bid = input?.board_id ?? snapshot?.currentBoardId;
  if (bid == null) return null;
  // Codex r3 — errors use the established {code, field} validator envelope
  // (the shape validateCalculateSelector / invalid_method already emit).
  if (bid === '*') return { code: 'board_id_star_unsupported', field: 'board_id' };
  const boards = Array.isArray(snapshot?.boards) ? snapshot.boards : [];
  if (boards.some((b) => b && b.id === bid)) return null;
  if (boards.length === 0 && bid === getMainBoardId(snapshot)) return null;
  return { code: 'board_not_found', field: 'board_id' };
}

export function validateCalculateZs(input, snapshot) {
  return validateCalculateSelector(input) ?? validateCalculateBoardTarget(input, snapshot);
}

// ---------------------------------------------------------------------------
// Phase 3 Plan 03-02 — ask_user (STS-07) runtime defensive validator.
//
// Why these enum consts live here (and not in stage6-tool-schemas.js):
//   - stage6-enumerations.json is the build-time source of truth for the
//     schema. The validator needs the SAME values as the schema, but lifting
//     the JSON into the validator module couples two concerns (schema codegen
//     + dispatch validation). We instead keep the lists small and local with
//     an ASSERTION that they stay aligned — covered by the validator tests
//     (any drift between these and config/stage6-enumerations.json shows up
//     as a happy-path test failure because the schema would reject the value
//     before dispatch ever ran).
//   - If this pair of files ever diverges intentionally, the failure-code
//     namespace already documents the breakpoint.
// ---------------------------------------------------------------------------
// Exported so src/__tests__/stage6-dispatch-validation.test.js can
// import this list and lockstep-assert it against
// config/stage6-enumerations.json. Without the lockstep test the pair
// has drifted silently in the past (Sonnet 4.6 invented
// `missing_field_and_context`; the JSON-schema enum rejected it; the
// validator's hand-rolled copy was the runtime guard). 2026-06-03 widen
// covers (a) `missing_field` (Bug 2 case — value + circuit known, no
// field cue) and (b) the three legacy values already live in
// config/prompts/sonnet_agentic_system.md (missing_value at line 79,
// missing_field_and_circuit at line 78, missing_field_and_context as
// Sonnet 4.6's invented compound case from session D7D01509).
export const ASK_USER_REASONS = [
  'out_of_range_circuit',
  'ambiguous_circuit',
  'contradiction',
  'observation_confirmation',
  'missing_context',
  'missing_field',
  'missing_value',
  'missing_field_and_circuit',
  'missing_field_and_context',
];
const ASK_USER_ANSWER_SHAPES = ['yes_no', 'number', 'free_text', 'circuit_ref'];
const MAX_QUESTION_LEN = 500;

/**
 * ask_user (STS-07): defensive runtime payload validator.
 *
 * Short-circuits on first failure in the order: question → reason →
 * context_field → context_circuit → expected_answer_shape. Callers (Plan
 * 03-05 dispatcher) rely on ordering so that a single failed field is
 * deterministic across SDK versions.
 *
 * Returns null on success or {code, field?} on failure. Never throws.
 */
export function validateAskUser(input) {
  // Plan 03-12 r11 MAJOR remediation — reject whitespace-only question.
  // Prior check used `input.question.length === 0` only, so "   " (pure
  // whitespace), a bare tab, or a line feed would pass validation, reach
  // the dispatcher, and produce blank/garbage TTS prompts on iOS. The
  // schema contract is "non-empty question"; trimming before length
  // check enforces the INTENT of the contract, not its accidental
  // byte-level reading. The upper bound still checks the un-trimmed
  // length — a 4097-char string with 4096 chars of trailing whitespace
  // is still oversized by the schema cap, and the dispatcher's analyzer
  // would break if we accepted it. Two different length semantics for
  // two different failure modes.
  if (
    typeof input?.question !== 'string' ||
    input.question.trim().length === 0 ||
    input.question.length > MAX_QUESTION_LEN
  ) {
    return { code: 'invalid_question', field: 'question' };
  }
  if (!ASK_USER_REASONS.includes(input.reason)) {
    return { code: 'invalid_reason', field: 'reason' };
  }
  // context_field is nullable per the schema. Coerce undefined → null so a
  // missing key is treated the same as an explicit null — the dispatcher's
  // logging path already does `?? null` at line ~192, so the two sides
  // agree on the semantic. Pre-coercion bug (session 1B496E8A turn-2,
  // 2026-05-26 11:47:15): Sonnet emitted ask_user without a context_field
  // key for a no-clarification recovery ("Sorry, I didn't catch that…").
  // `input.context_field` was undefined; `!== null` was true; the enum
  // .includes(undefined) was false; validator rejected with
  // `invalid_context_field`. The wire-shape contract says "nullable" — a
  // missing key IS the null case; tool-schema codegen makes the field
  // optional, so absence is well-formed.
  const ctxField = input.context_field ?? null;
  if (ctxField !== null && !CONTEXT_FIELD_ENUM.includes(ctxField)) {
    return { code: 'invalid_context_field', field: 'context_field' };
  }
  // context_circuit follows the same nullable + omittable contract.
  // Number.isInteger(null) and Number.isInteger(undefined) both return
  // false; coerce upstream so the integer check only fires on a real
  // non-null value the caller affirmatively supplied. Same repro pinned
  // the bug — Sonnet's recovery ask had no context_circuit key, the
  // dispatcher rejected, the tool returned validation_error and
  // SonnetStream disconnected ~2 s later.
  const ctxCircuit = input.context_circuit ?? null;
  if (ctxCircuit !== null && !Number.isInteger(ctxCircuit)) {
    return { code: 'invalid_context_circuit', field: 'context_circuit' };
  }
  // context_circuits — optional plural form for multi-circuit asks.
  // Shape: array of length >= 2, all entries unique positive integers
  // (minimum:1 keeps circuit_ref 0, a board-level sentinel per
  // stage6-ask-gate-wrapper.js:123-130, out of the plural fan-out).
  // XOR with context_circuit: schema description says context_circuit
  // MUST be null when context_circuits is set. Enforce here so Sonnet
  // can't silently ship both — without this, the resolver/ask-gate
  // would prefer the plural with no error surfaced.
  const ctxCircuits = input.context_circuits ?? null;
  if (ctxCircuits !== null) {
    if (
      !Array.isArray(ctxCircuits) ||
      ctxCircuits.length < 2 ||
      !ctxCircuits.every((n) => Number.isInteger(n) && n >= 1) ||
      new Set(ctxCircuits).size !== ctxCircuits.length
    ) {
      return { code: 'invalid_context_circuits', field: 'context_circuits' };
    }
    if (input.context_circuit !== null && input.context_circuit !== undefined) {
      return { code: 'context_circuit_conflict', field: 'context_circuits' };
    }
  }
  if (!ASK_USER_ANSWER_SHAPES.includes(input.expected_answer_shape)) {
    return { code: 'invalid_expected_answer_shape', field: 'expected_answer_shape' };
  }
  // pending_write is OPTIONAL — null/absent is the common case for asks that
  // aren't resolving a buffered value (out_of_range_circuit, observation
  // confirmation, etc.). When PRESENT it must be a fully-shaped object.
  // The server-side answer resolver consumes these fields, so a malformed
  // pending_write is a Sonnet contract bug we surface here rather than
  // silently dropping during resolution.
  if (input.pending_write !== undefined && input.pending_write !== null) {
    const pw = input.pending_write;
    if (typeof pw !== 'object') {
      return { code: 'invalid_pending_write', field: 'pending_write' };
    }
    if (pw.tool !== 'record_reading' && pw.tool !== 'record_board_reading') {
      return { code: 'invalid_pending_write_tool', field: 'pending_write.tool' };
    }
    if (typeof pw.field !== 'string' || pw.field.length === 0) {
      return { code: 'invalid_pending_write_field', field: 'pending_write.field' };
    }
    if (typeof pw.value !== 'string') {
      return { code: 'invalid_pending_write_value', field: 'pending_write.value' };
    }
    if (
      typeof pw.confidence !== 'number' ||
      !Number.isFinite(pw.confidence) ||
      pw.confidence < 0 ||
      pw.confidence > 1
    ) {
      return { code: 'invalid_pending_write_confidence', field: 'pending_write.confidence' };
    }
    if (typeof pw.source_turn_id !== 'string') {
      return {
        code: 'invalid_pending_write_source_turn_id',
        field: 'pending_write.source_turn_id',
      };
    }
    // Cross-check: pending_write.field MUST be valid for pending_write.tool.
    // Catches Sonnet attaching a board-field name with tool: "record_reading"
    // (or vice versa) at the validation gate, BEFORE the user's clarification
    // turn is wasted on a malformed buffered write that can't dispatch. Same
    // bug class as 1A/1B/1C — Sonnet contract drift produces silent downstream
    // failures; the only safe place to surface that is here, not in the
    // resolver (where the bad pw is already in flight).
    if (pw.tool === 'record_reading' && !RECORD_READING_FIELDS.has(pw.field)) {
      return { code: 'invalid_pending_write_field_for_tool', field: 'pending_write.field' };
    }
    if (pw.tool === 'record_board_reading' && !RECORD_BOARD_READING_FIELDS.has(pw.field)) {
      return { code: 'invalid_pending_write_field_for_tool', field: 'pending_write.field' };
    }
  }
  return null;
}

/**
 * 2026-05-08 "Work on Board" Phase B — strict currentBoardId scope.
 *
 * Reject mutator tool calls when an explicit `board_id` is supplied that
 * does not match the session's `currentBoardId`. Tells Sonnet to call
 * `select_board` first.
 *
 * WHY: Q0.4 of the multi-board sprint locks "no auto-routing of cross-board
 * readings". The inspector switches boards by voice → server flips
 * `currentBoardId` → all subsequent writes scope there. If Sonnet supplies
 * an explicit `board_id` targeting a different board, the only safe action
 * is to reject and force a `select_board` first; otherwise a misheard
 * transcript could silently land on the wrong board's circuit. Phase A's
 * dual-shape storage made cross-board writes possible; Phase B closes the
 * door so they can only happen via an explicit board switch.
 *
 * Tools gated by this validator: record_reading, clear_reading,
 * create_circuit, rename_circuit, delete_circuit, record_board_reading.
 *
 * Tools INTENTIONALLY exempt:
 *   - calculate_zs / calculate_r1_plus_r2 — Phase 6.5 explicitly threads
 *     board_id for cross-board calcs (legitimate read-mostly use case).
 *   - set_field_for_all_circuits — supports the `'*'` cross-board sweep
 *     (locked S5 decision from the multi-board sprint).
 *   - select_board — flips currentBoardId; gating it would be circular.
 *   - add_board — creates new boards; currentBoardId doesn't apply.
 *   - mark_distribution_circuit — its `board_id` arg names the SOURCE
 *     board for the distribution-circuit relationship; semantics differ
 *     from "the board this write lands on".
 *
 * Omitted `board_id` is always allowed — the mutators (applyReadingFlagAware
 * et al.) default to currentBoardId, which is the locked behaviour we want.
 *
 * @param {{board_id?: string|null}} input
 * @param {{currentBoardId?: string, boards?: Array<{id?: string, board_type?: string}>}} snapshot
 * @returns {null | {code: 'wrong_board', field: 'board_id', expected: string, got: string, hint: string}}
 */
export function validateBoardScope(input, snapshot) {
  const supplied = input?.board_id;
  if (supplied == null) return null;
  const expected = snapshot?.currentBoardId ?? getMainBoardId(snapshot);
  if (supplied === expected) return null;
  return {
    code: 'wrong_board',
    field: 'board_id',
    expected,
    got: supplied,
    hint: 'Call select_board to switch boards before recording on a different one.',
  };
}
