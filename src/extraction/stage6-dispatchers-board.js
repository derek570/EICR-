/**
 * Stage 6 Phase 2 carryover — Board / supply / installation write dispatcher.
 *
 * WHAT: Real implementation of the eighth write tool — `record_board_reading`.
 * Mirrors the dispatchRecordReading shape from
 * `stage6-dispatchers-circuit.js` (validate → mutate via Plan 02-01 atom →
 * track in perTurnWrites → log → return envelope), but writes to the
 * board / supply / installation surface (`stateSnapshot.circuits[0]`) rather
 * than to a per-circuit bucket.
 *
 * WHY a separate sibling file (not inlined into circuit / observation
 * siblings): mirrors the Wave-2 parallelism contract that owns the dispatcher
 * surface — each tool family lives in exactly one file so a future plan can
 * land changes in parallel without merge conflicts on the others. The barrel
 * `stage6-dispatchers.js` is append-only.
 *
 * WHY envelope() is a local helper (not hoisted): same rationale as the
 * circuit + observation siblings — file isolation trumps micro-DRY.
 *
 * ---------------------------------------------------------------------------
 * STORAGE DECISION (mirrored from applyBoardReadingToSnapshot JSDoc)
 * ---------------------------------------------------------------------------
 * Board / supply / installation readings live at `stateSnapshot.circuits[0]`
 * with a flat field key. This matches the legacy parser path
 * (`_seedStateFromJobState` in `eicr-extraction-session.js` and `KNOWN_FIELDS`
 * in `sonnet-stream.js`) so divergence comparison projects both paths into
 * the same slot keys.
 * ---------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------
 * VALIDATION (defence in depth — strict:true should catch most before us)
 * ---------------------------------------------------------------------------
 * Strict-mode tools at the API boundary already reject:
 *   - off-enum `field` values (BOARD_FIELD_ENUM membership)
 *   - missing required fields
 *   - type mismatches
 *
 * The dispatcher additionally enforces:
 *   - confidence ∈ [0, 1] and finite      → confidence_out_of_range
 *   - field is a member of BOARD_FIELD_ENUM → invalid_field
 *
 * The field-enum check is defence-in-depth: strict:true should reject before
 * we run, but a future SDK version that strips strict-mode flags or a fixture
 * that bypasses the API would let an off-enum string hit the dispatcher. The
 * extra check ensures we never write `circuits[0].arbitrary_string = …`.
 *
 * @file
 */

import { applyBoardReadingToSnapshot } from './stage6-snapshot-mutators.js';
import { logToolCall } from './stage6-dispatcher-logger.js';
import { BOARD_FIELD_ENUM } from './stage6-tool-schemas.js';

// Frozen Set for O(1) membership checks. Built once at module load — the
// underlying enum is itself frozen-by-convention (codegenned from
// field_schema.json + filtered for `_ui_*` once at module load in
// stage6-tool-schemas.js).
const BOARD_FIELD_SET = new Set(BOARD_FIELD_ENUM);

function envelope(tool_use_id, body, is_error) {
  return { tool_use_id, content: JSON.stringify(body), is_error };
}

/**
 * Validate `confidence` ∈ [0, 1] and finite. Mirrors the bounds enforcement
 * applied by `validateRecordReading` for record_reading.confidence. Returns
 * a `{code, field}` rejection envelope or null on success.
 */
function validateConfidence(confidence) {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) {
    return { code: 'confidence_out_of_range', field: 'confidence' };
  }
  if (confidence < 0 || confidence > 1) {
    return { code: 'confidence_out_of_range', field: 'confidence' };
  }
  return null;
}

/**
 * record_board_reading: validate → applyBoardReadingToSnapshot →
 * perTurnWrites.boardReadings.set → log → envelope.
 *
 * Same-turn correction semantics: the boardReadings Map is keyed by `field`
 * (no circuit suffix because every entry lives at circuits[0]). A second
 * record_board_reading for the same field overwrites the first, matching the
 * last-write-wins pathway used by record_reading.
 *
 * @param {{tool_call_id: string, name: string, input: {field: string, value: string, confidence: number, source_turn_id: string}}} call
 * @param {{session: object, logger: object, turnId: string, perTurnWrites: object, round: number}} ctx
 */
export async function dispatchRecordBoardReading(call, ctx) {
  const { session, logger, turnId, perTurnWrites, round } = ctx;
  const input = call.input ?? {};

  // 1) confidence bounds — mirrors record_reading dispatcher.
  const confErr = validateConfidence(input.confidence);
  if (confErr) {
    logToolCall(logger, {
      sessionId: session.sessionId,
      turnId,
      tool_use_id: call.tool_call_id,
      tool: 'record_board_reading',
      round,
      is_error: true,
      outcome: 'rejected',
      validation_error: confErr,
      // PII: field name only. Never log the value (could be a fragment of an
      // address, postcode, or client name — every installation_details_fields
      // value is potentially PII).
      input_summary: { field: input.field ?? null },
    });
    return envelope(call.tool_call_id, { ok: false, error: confErr }, true);
  }

  // 2) field-enum membership (defence in depth).
  if (typeof input.field !== 'string' || !BOARD_FIELD_SET.has(input.field)) {
    const err = { code: 'invalid_field', field: 'field' };
    logToolCall(logger, {
      sessionId: session.sessionId,
      turnId,
      tool_use_id: call.tool_call_id,
      tool: 'record_board_reading',
      round,
      is_error: true,
      outcome: 'rejected',
      validation_error: err,
      input_summary: { field: input.field ?? null },
    });
    return envelope(call.tool_call_id, { ok: false, error: err }, true);
  }

  // 3) mutate via the shared atom — the atom is a pure write into circuits[0].
  applyBoardReadingToSnapshot(session.stateSnapshot, {
    field: input.field,
    value: input.value,
  });

  // 4) track in perTurnWrites for the bundler / shadow comparator.
  // Map keyed by field-only (degenerate circuit half — every board reading
  // lives at circuits[0]). Mirrors the readings Map's value-object shape.
  perTurnWrites.boardReadings.set(input.field, {
    value: input.value,
    confidence: input.confidence ?? 1.0,
    source_turn_id: input.source_turn_id,
  });

  // 5) log success.
  logToolCall(logger, {
    sessionId: session.sessionId,
    turnId,
    tool_use_id: call.tool_call_id,
    tool: 'record_board_reading',
    round,
    is_error: false,
    outcome: 'ok',
    validation_error: null,
    // PII: field name only. NEVER log the value here — the value might be the
    // installation address, postcode, client name, etc. Mirrors the PII
    // discipline in observation dispatchers.
    input_summary: { field: input.field },
  });
  return envelope(call.tool_call_id, { ok: true }, false);
}
