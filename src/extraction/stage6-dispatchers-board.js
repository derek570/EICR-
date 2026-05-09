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

import { applyBoardReadingFlagAware } from './stage6-snapshot-mutators.js';
import { encodeBoardReadingKey } from './stage6-per-turn-writes.js';
import { logToolCall } from './stage6-dispatcher-logger.js';
import { BOARD_FIELD_ENUM } from './stage6-tool-schemas.js';
import {
  DEFAULT_MAIN_BOARD_ID,
  ensureMultiBoardShape,
  getCircuitBucket,
} from './stage6-multi-board-shape.js';
import { validateBoardHierarchy } from './board-hierarchy-validator.js';
import { validateBoardScope } from './stage6-dispatch-validation.js';

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

  // Hotfix slice 3.1 — validateBoardScope runs FIRST so a cross-board
  // record_board_reading on a non-current board surfaces as `wrong_board`
  // rather than confidence_out_of_range or invalid_field. The pre-hotfix
  // order ran scope last (after confidence + field-enum), which masked
  // the multi-board contract violation behind unrelated rejections.
  // Sonnet's prompt rule "call select_board first" depends on getting
  // the right error code back.
  const scopeErr = validateBoardScope(input, session.stateSnapshot);
  if (scopeErr) {
    logToolCall(logger, {
      sessionId: session.sessionId,
      turnId,
      tool_use_id: call.tool_call_id,
      tool: 'record_board_reading',
      round,
      is_error: true,
      outcome: 'rejected',
      validation_error: scopeErr,
      input_summary: { field: input.field ?? null },
    });
    return envelope(call.tool_call_id, { ok: false, error: scopeErr }, true);
  }

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

  // 3) mutate via the flag-aware wrapper. Flag-off: legacy circuits[0] write
  //    (preserves every existing reader until slice 5.6 retires the bucket).
  //    Flag-on: writes into BoardInfo on snapshot.boards via
  //    applyBoardReadingMultiBoard, falling back to snapshot.currentBoardId
  //    when input.board_id is not supplied. The schema doesn't yet expose
  //    board_id (Phase 6 / Codex deal-breaker #3 — the board_ops wire
  //    channel + tool surface widening), so today this is always
  //    currentBoardId-defaulted; threading the field anyway keeps the
  //    dispatcher forward-compatible for the Phase 6 schema bump.
  applyBoardReadingFlagAware(session.stateSnapshot, {
    field: input.field,
    value: input.value,
    boardId: input.board_id,
  });

  // 4) track in perTurnWrites for the bundler / shadow comparator.
  // Map keyed by field-only (degenerate circuit half — every board reading
  // lives at circuits[0]). Mirrors the readings Map's value-object shape.
  //
  // P3-B (2026-04-27): tag synthetic auto-resolve writes so the slot
  // comparator can filter them out (see stage6-dispatchers-circuit.js for
  // the parallel change on per-circuit writes).
  //
  // "Work on Board" hotfix slice 1.1a (2026-05-08): carry input.board_id on
  // the value object so the bundler can emit `reading.board_id` on the
  // wire (board-level supply / installation reads route to the right board
  // via the shadow-harness fold to extracted_readings circuit:0; iOS uses
  // the field on apply to land the value on board.zeAtDb / board.ipf rather
  // than always boards[0]).
  const autoResolved = String(call.tool_call_id ?? '').includes('::auto::');
  // Slice 1.1c — encodeBoardReadingKey embeds boardId in the Map key so a
  // single tool-loop turn can write the same field on two boards (e.g. main
  // and a sub-board's supply Ze) without one clobbering the other. Pre-1.1c
  // legacy keys (no boardId tag) decode as boardId=null in the bundler.
  perTurnWrites.boardReadings.set(encodeBoardReadingKey(input.field, input.board_id), {
    value: input.value,
    confidence: input.confidence ?? 1.0,
    source_turn_id: input.source_turn_id,
    auto_resolved: autoResolved || undefined,
    boardId: input.board_id ?? undefined,
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

// ---------------------------------------------------------------------------
// 2026-05-07 multi-board sprint Phase 6.1 — dispatchAddBoard.
//
// Schema-side: tool defined in stage6-tool-schemas.js (`addBoard`).
// Wire channel: appends an op onto perTurnWrites.boardOps (Phase 6.0 slot)
// which the bundler emits to iOS as the `board_ops` event channel.
//
// id synthesis: server picks `sub-${n}` (n = max existing sub-N + 1, or 1).
// `main-${n}` for board_type='main' (rare — main is implicit).
//
// Hierarchy validation: delegated to validateBoardHierarchy on the
// PROVISIONAL boards[] (current + new). Validator owns cycle/orphan/
// duplicate-main/feed-circuit-not-found rules; dispatcher rejects with
// `hierarchy_invalid` and leaves snapshot untouched on failure.
// ---------------------------------------------------------------------------

const VALID_BOARD_TYPES = new Set(['main', 'sub_distribution', 'sub_main']);

const ADD_BOARD_DESIGNATION_MAX = 32;

/**
 * add_board: validate → synthesise id → validate hierarchy → mutate
 * snapshot.boards + currentBoardId → push boardOps op → log → envelope.
 *
 * @param {{tool_call_id: string, name: string, input: {designation: string, board_type: string, parent_board_id?: string, feed_circuit_ref?: number}}} call
 * @param {{session: object, logger: object, turnId: string, perTurnWrites: object, round: number}} ctx
 */
export async function dispatchAddBoard(call, ctx) {
  const { session, logger, turnId, perTurnWrites, round } = ctx;
  const input = call.input ?? {};

  function reject(code, field) {
    const err = field == null ? { code } : { code, field };
    logToolCall(logger, {
      sessionId: session.sessionId,
      turnId,
      tool_use_id: call.tool_call_id,
      tool: 'add_board',
      round,
      is_error: true,
      outcome: 'rejected',
      validation_error: err,
      // PII: log only the names that drive the rejection. Never log the
      // designation here — it may carry user-supplied free text.
      input_summary: { board_type: input.board_type ?? null },
    });
    return envelope(call.tool_call_id, { ok: false, error: err }, true);
  }

  // 1) board_type must be a recognised enum value.
  if (!VALID_BOARD_TYPES.has(input.board_type)) {
    return reject('invalid_board_type', 'board_type');
  }

  // 2) designation must be a non-empty string of ≤ 32 chars.
  if (
    typeof input.designation !== 'string' ||
    input.designation.trim() === '' ||
    input.designation.length > ADD_BOARD_DESIGNATION_MAX
  ) {
    return reject('invalid_designation', 'designation');
  }

  // 3) parent_board_id required for sub_main — but with a defensive
  //    single-main fallback. When the inspector adds a sub_main on a job
  //    with exactly ONE main board on snapshot.boards[], the parent is
  //    structurally unambiguous, so we silently default to that single
  //    main board's id rather than rejecting the call. Pre-fix Sonnet
  //    routinely emitted add_board with parent_board_id omitted (or
  //    invented as the literal "main") and looped against
  //    parent_required / parent_not_found — sessions 7113A114 +
  //    399E69A7 (2026-05-09) showed 10+ rejected calls in two
  //    consecutive recordings.
  //
  //    The fallback only fires when EVERYTHING is unambiguous:
  //      * board_type === 'sub_main'
  //      * input.parent_board_id is null/undefined/empty string
  //      * snapshot.boards[] has exactly one entry whose board_type is
  //        'main' (or absent — legacy seeds may omit it).
  //    Multi-main jobs still reject with parent_required so the model
  //    must disambiguate. The fallback is logged so optimiser reports
  //    can spot it.
  const snapshot = session.stateSnapshot;
  ensureMultiBoardShape(snapshot);
  const existingBoards = snapshot.boards ?? [];

  let resolvedParentId = input.parent_board_id;
  if (input.board_type === 'sub_main' && !resolvedParentId) {
    const mains = existingBoards.filter((b) => b && (!b.board_type || b.board_type === 'main'));
    if (mains.length === 1 && typeof mains[0].id === 'string') {
      resolvedParentId = mains[0].id;
      if (logger?.info) {
        logger.info('stage6.add_board_parent_fallback', {
          sessionId: session.sessionId,
          turnId,
          tool_use_id: call.tool_call_id,
          source: 'single_main_fallback',
          resolved_parent_board_id: mains[0].id,
        });
      }
    } else {
      return reject('parent_required', 'parent_board_id');
    }
  }

  // 4) parent_board_id, when supplied (or fallback-resolved), must
  //    reference an existing board. The fallback path always picks an
  //    existing id so this branch only rejects when the model supplied
  //    a non-matching id explicitly.
  if (resolvedParentId) {
    const parent = existingBoards.find((b) => b && b.id === resolvedParentId);
    if (!parent) {
      return reject('parent_not_found', 'parent_board_id');
    }
  }

  // 5) feed_circuit_ref required + integer when parent_board_id is
  //    resolved (whether explicit or via the single-main fallback).
  if (
    resolvedParentId &&
    (input.feed_circuit_ref == null || !Number.isInteger(input.feed_circuit_ref))
  ) {
    return reject('feed_circuit_ref_required', 'feed_circuit_ref');
  }

  // 6) Synthesise the new board id. Stable across the session: `sub-${n}`
  //    where n = max existing sub-N + 1 (or 1 if none). `main-${n}` is
  //    used for board_type='main' to keep the primary id 'main' reserved
  //    for the synthesised default board.
  const existingIds = existingBoards.map((b) => b && b.id).filter((id) => typeof id === 'string');
  const prefix = input.board_type === 'main' ? 'main' : 'sub';
  let nextN = 1;
  for (const id of existingIds) {
    const m = new RegExp(`^${prefix}-(\\d+)$`).exec(id);
    if (m) nextN = Math.max(nextN, Number(m[1]) + 1);
  }
  const newId = `${prefix}-${nextN}`;
  // Defensive: id collision is structurally impossible given the max-walk
  // above, but if a future caller seeds boards[] with a synthetic id that
  // breaks the convention (e.g. sub-99999), bail rather than overwrite.
  if (existingIds.includes(newId)) {
    return reject('board_id_collision', null);
  }

  // 7) Build the new board record. Use the resolved parent id so the
  //    single-main fallback persists onto the snapshot record (otherwise a
  //    later PUT /api/job round-trip would surface the orphan as
  //    parent_not_found via the same shared validator).
  const newBoard = {
    id: newId,
    designation: input.designation.trim(),
    board_type: input.board_type,
  };
  if (resolvedParentId) newBoard.parent_board_id = resolvedParentId;
  if (input.feed_circuit_ref != null) newBoard.feed_circuit_ref = input.feed_circuit_ref;

  // 8) Hierarchy validation BEFORE mutating snapshot. The validator owns
  //    cycle / orphan / duplicate-main / feed-circuit-not-found rules — single
  //    source of truth shared with the iOS-side check and the PUT /api/job
  //    gate (Phase 2.3 of the multi-board sprint).
  //
  //    Shape adapter: the in-memory `snapshot.circuits` is a keyed map
  //    (numeric legacy keys 0/1/2... in flag-off, composite `${board_id}::${ref}`
  //    in flag-on), and bucket VALUES under flag-off carry no `circuit_ref`
  //    or `board_id`. The validator expects a flat array where each entry
  //    self-identifies. Synthesise the missing fields from the dictionary
  //    key + the implicit main board id so a legacy snapshot validates the
  //    same way a wire-shape array (PUT /api/job) does.
  const mainBoardId = existingBoards[0]?.id ?? DEFAULT_MAIN_BOARD_ID;
  const provisionalBoards = [...existingBoards, newBoard];
  const provisionalCircuits = Object.entries(snapshot.circuits ?? {}).map(([key, bucket]) => {
    const fromBucket = bucket && typeof bucket === 'object' ? bucket : {};
    const numericKey = Number(key);
    const synthesizedRef =
      fromBucket.circuit_ref ??
      fromBucket.circuit ??
      (Number.isInteger(numericKey) ? numericKey : undefined);
    return {
      ...fromBucket,
      circuit_ref: synthesizedRef,
      board_id: fromBucket.board_id ?? mainBoardId,
    };
  });
  const validation = validateBoardHierarchy(provisionalBoards, provisionalCircuits);
  if (!validation.ok) {
    const err = { code: 'hierarchy_invalid', field: null, details: validation.errors };
    logToolCall(logger, {
      sessionId: session.sessionId,
      turnId,
      tool_use_id: call.tool_call_id,
      tool: 'add_board',
      round,
      is_error: true,
      outcome: 'rejected',
      validation_error: { code: 'hierarchy_invalid' },
      input_summary: { board_type: input.board_type ?? null },
    });
    return envelope(call.tool_call_id, { ok: false, error: err }, true);
  }

  // 9) Mutate snapshot: append board, flip currentBoardId so subsequent
  //    record_reading / create_circuit calls land on the new board.
  snapshot.boards.push(newBoard);
  snapshot.currentBoardId = newId;

  // 10) Push the wire op for iOS (Phase 6.0 channel). Carry every payload
  //     field so the iOS receiver doesn't have to re-fetch state to learn
  //     what was added.
  perTurnWrites.boardOps.push({
    op: 'add_board',
    board_id: newId,
    designation: newBoard.designation,
    board_type: newBoard.board_type,
    parent_board_id: newBoard.parent_board_id ?? null,
    feed_circuit_ref: newBoard.feed_circuit_ref ?? null,
  });

  // 11) Log success. PII discipline: never log the designation (free text).
  logToolCall(logger, {
    sessionId: session.sessionId,
    turnId,
    tool_use_id: call.tool_call_id,
    tool: 'add_board',
    round,
    is_error: false,
    outcome: 'ok',
    validation_error: null,
    input_summary: {
      board_id: newId,
      board_type: newBoard.board_type,
      parent_board_id: newBoard.parent_board_id ?? null,
    },
  });
  return envelope(call.tool_call_id, { ok: true, board_id: newId, currentBoardId: newId }, false);
}

// ---------------------------------------------------------------------------
// 2026-05-07 multi-board sprint Phase 6.2 — dispatchSelectBoard.
//
// Inspector switches between boards they previously added. Schema-side:
// `selectBoard` in stage6-tool-schemas.js. Wire channel: appends a
// `{op: 'select_board', board_id}` op onto perTurnWrites.boardOps for iOS.
//
// id-only resolution: designation fuzzy match is a STOP slice (Levenshtein
// floor / case sensitivity / ambiguity rule are product judgement calls).
// Unknown id → reject with `board_not_found`.
//
// Idempotency note: select_board('main') when already on main still emits
// one boardOps entry. The wire shape carries "the model called the tool",
// not "the model changed state"; suppression isn't this layer's concern.
// ---------------------------------------------------------------------------
export async function dispatchSelectBoard(call, ctx) {
  const { session, logger, turnId, perTurnWrites, round } = ctx;
  const input = call.input ?? {};

  function reject(code, field) {
    const err = field == null ? { code } : { code, field };
    logToolCall(logger, {
      sessionId: session.sessionId,
      turnId,
      tool_use_id: call.tool_call_id,
      tool: 'select_board',
      round,
      is_error: true,
      outcome: 'rejected',
      validation_error: err,
      input_summary: { board_id: input.board_id ?? null },
    });
    return envelope(call.tool_call_id, { ok: false, error: err }, true);
  }

  // 1) board_id must be a non-empty string.
  if (typeof input.board_id !== 'string' || input.board_id.trim() === '') {
    return reject('invalid_board_id', 'board_id');
  }

  // 2) board_id must reference an existing board on the snapshot.
  const snapshot = session.stateSnapshot;
  ensureMultiBoardShape(snapshot);
  const target = (snapshot.boards ?? []).find((b) => b && b.id === input.board_id);
  if (!target) {
    return reject('board_not_found', 'board_id');
  }

  // 3) Mutate currentBoardId; emit wire op.
  snapshot.currentBoardId = target.id;
  perTurnWrites.boardOps.push({ op: 'select_board', board_id: target.id });

  // 4) Log success.
  logToolCall(logger, {
    sessionId: session.sessionId,
    turnId,
    tool_use_id: call.tool_call_id,
    tool: 'select_board',
    round,
    is_error: false,
    outcome: 'ok',
    validation_error: null,
    input_summary: { board_id: target.id },
  });
  return envelope(call.tool_call_id, { ok: true, currentBoardId: target.id }, false);
}

// ---------------------------------------------------------------------------
// 2026-05-07 multi-board sprint Phase 6.3 — dispatchMarkDistributionCircuit.
//
// Inspector says "Circuit 4 feeds the garage CU". Sonnet calls
// mark_distribution_circuit; dispatcher locates the circuit on the
// (board_id ?? currentBoardId) board, verifies feeds_board_id exists,
// writes is_distribution_circuit='yes' + feeds_board_id, emits an op.
//
// STOP-SLICE deviation from PLAN.md L577-583: when feeds_board_id does
// not resolve to an existing board, REJECT with `feeds_board_not_found`.
// PLAN.md prescribed an ask_user(add_board) flow; that's path-2 resolver
// territory and is deferred to a supervised session. Sonnet's prompt is
// updated (Phase 7.1) to call add_board FIRST when the target doesn't
// exist, so this contract remains the model's responsibility.
//
// Bucket lookup: getCircuitBucket is flag-aware — under flag-off it reads
// snapshot.circuits[ref], under flag-on it reads
// snapshot.circuits['${board_id}::${ref}']. Centralising the lookup
// keeps the dispatcher correct under both modes without conditional
// branches in this file.
// ---------------------------------------------------------------------------
export async function dispatchMarkDistributionCircuit(call, ctx) {
  const { session, logger, turnId, perTurnWrites, round } = ctx;
  const input = call.input ?? {};

  function reject(code, field) {
    const err = field == null ? { code } : { code, field };
    logToolCall(logger, {
      sessionId: session.sessionId,
      turnId,
      tool_use_id: call.tool_call_id,
      tool: 'mark_distribution_circuit',
      round,
      is_error: true,
      outcome: 'rejected',
      validation_error: err,
      input_summary: {
        circuit: Number.isInteger(input.circuit) ? input.circuit : null,
        feeds_board_id: typeof input.feeds_board_id === 'string' ? input.feeds_board_id : null,
      },
    });
    return envelope(call.tool_call_id, { ok: false, error: err }, true);
  }

  // 1) circuit must be a positive integer.
  if (!Number.isInteger(input.circuit) || input.circuit < 1) {
    return reject('invalid_circuit', 'circuit');
  }

  // 2) feeds_board_id must be a non-empty string.
  if (typeof input.feeds_board_id !== 'string' || input.feeds_board_id.trim() === '') {
    return reject('invalid_feeds_board_id', 'feeds_board_id');
  }

  const snapshot = session.stateSnapshot;
  ensureMultiBoardShape(snapshot);

  // 3) Resolve the source board (board_id arg → currentBoardId → 'main').
  const sourceBoardId = input.board_id ?? snapshot.currentBoardId ?? 'main';
  const sourceBoard = (snapshot.boards ?? []).find((b) => b && b.id === sourceBoardId);
  if (!sourceBoard) {
    return reject('source_board_not_found', 'board_id');
  }

  // 4) Resolve the target board. STOP-SLICE: NO forward-ref ask_user —
  //    Sonnet must call add_board first when the target doesn't exist.
  const targetBoard = (snapshot.boards ?? []).find((b) => b && b.id === input.feeds_board_id);
  if (!targetBoard) {
    return reject('feeds_board_not_found', 'feeds_board_id');
  }

  // 5) Locate the circuit bucket on the source board (flag-aware).
  const bucket = getCircuitBucket(snapshot, input.circuit, sourceBoardId);
  if (!bucket) {
    return reject('circuit_not_found', 'circuit');
  }

  // 6) Mutate: mark as distribution circuit + record fed board.
  bucket.is_distribution_circuit = 'yes';
  bucket.feeds_board_id = targetBoard.id;

  // 7) Emit wire op. Carry source_board_id explicitly so iOS doesn't have
  //    to assume currentBoardId at receive time.
  perTurnWrites.boardOps.push({
    op: 'mark_distribution_circuit',
    circuit_ref: input.circuit,
    feeds_board_id: targetBoard.id,
    source_board_id: sourceBoardId,
  });

  // 8) Log success.
  logToolCall(logger, {
    sessionId: session.sessionId,
    turnId,
    tool_use_id: call.tool_call_id,
    tool: 'mark_distribution_circuit',
    round,
    is_error: false,
    outcome: 'ok',
    validation_error: null,
    input_summary: {
      circuit: input.circuit,
      source_board_id: sourceBoardId,
      feeds_board_id: targetBoard.id,
    },
  });
  return envelope(call.tool_call_id, { ok: true }, false);
}
