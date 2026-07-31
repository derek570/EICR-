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

import {
  applyBoardReadingFlagAware,
  clearBoardReadingFlagAware,
} from './stage6-snapshot-mutators.js';
import {
  encodeBoardReadingKey,
  decodeBoardReadingKey,
  attachEffectiveBoardSlot,
  attachSectionDedupeOperation,
  EFFECTIVE_BOARD_SLOT,
  boardSlotKey,
  nextSectionDedupeOrdinal,
  recordBoardReadingWrite,
  removeBoardReadingWrites,
} from './stage6-per-turn-writes.js';
import { logToolCall } from './stage6-dispatcher-logger.js';
import { BOARD_FIELD_ENUM, CLEAR_BOARD_READING_FIELD_ENUM } from './stage6-tool-schemas.js';
import { isBoardClearKilled } from './voice-latency-config.js';
import { getActiveSessionEntry } from './active-sessions.js';
import { FIELD_CORRECTIONS } from './field-name-corrections.js';
import { CONFIRMATION_FRIENDLY_NAMES, deriveFriendlyName } from './confirmation-text.js';
import { stageMandatoryNotice, spokenBoardOrdinal } from './refusal-notices.js';
import { buildDegenerateDedupeKey, WIRE_CLIENT_SECTION_DEDUPE_SCOPES } from './ios-dedupe-key.js';
import {
  BOARD_READING_SCOPE_MAP,
  STRUCTURAL_READING_FIELDS,
  UNROUTABLE_READING_FIELDS,
} from './client-routable-reading-fields.js';
import {
  DEFAULT_MAIN_BOARD_ID,
  ensureMultiBoardShape,
  getCircuitBucket,
  getMainBoardId,
  isUnscopedBoardId,
  normaliseBoardScopeInput,
} from './stage6-multi-board-shape.js';
import { validateBoardHierarchy } from './board-hierarchy-validator.js';
import { validateBoardScope, BOARD_FIELD_VALUE_ENUMS } from './stage6-dispatch-validation.js';
import { coerceRecordBoardReadingValue } from './record-reading-coercion.js';
import { isWithinRange, BOARD_FIELD_NUMERIC_RANGES } from './value-enum-validator.js';
import {
  IMPEDANCE_CLAMP_CORRECTION,
  clampReadingForDispatch,
  logImpedanceClamp,
  resolveBoardAwareEarthing,
} from './impedance-clamp.js';

// Frozen Set for O(1) membership checks. Built once at module load — the
// underlying enum is itself frozen-by-convention (codegenned from
// field_schema.json + filtered for `_ui_*` once at module load in
// stage6-tool-schemas.js).
const BOARD_FIELD_SET = new Set(BOARD_FIELD_ENUM);

// PLAN-backend-final.md Phase 4.3 — anchored UK address-opener pattern
// the dispatcher uses to reject `record_board_reading {field:"client_name",
// value:"<digit> <word> <street-suffix>..."}` writes. Conservative on purpose:
// the leading `^\d+\s+\w+\s+` requires a digit + word + street suffix, so a
// real client surname like "John Road" (a person whose surname is "Road")
// doesn't trip the gate. Exported for the Phase 4.5 test that pins the
// shape — keeping the regex visible from the test prevents a future widen
// from silently accepting the very value class this guard exists to reject.
export const CLIENT_NAME_ADDRESS_SHAPE =
  /^\d+\s+\w+\s+(road|street|avenue|lane|close|drive|way|crescent|court|terrace|grove|gardens|mews|place)/i;

function envelope(tool_use_id, body, is_error) {
  return { tool_use_id, content: JSON.stringify(body), is_error };
}

/** PLAN-2D terminal structural/unroutable board-reading rejection. */
function stageBoardReadingDispositionRefusal(call, ctx, input) {
  const route = UNROUTABLE_READING_FIELDS.has(input.field)
    ? 'unroutable_board_reading'
    : STRUCTURAL_READING_FIELDS.has(input.field)
      ? 'unsupported_structural_reading'
      : null;
  if (route == null) return null;

  const { session, perTurnWrites, turnId } = ctx;
  const boardId = resolveEffectiveBoardIdForClear(session, input.board_id) ?? null;
  const ordinal = spokenBoardOrdinal(session?.stateSnapshot, boardId);
  const boardRenderable =
    boardId == null || !Array.isArray(session?.stateSnapshot?.boards) || ordinal != null;
  if (boardRenderable && call.tool_call_id != null) {
    const friendlyBase = boardFieldSpokenName(input.field);
    const friendly = ordinal == null ? friendlyBase : `${friendlyBase} on board ${ordinal}`;
    const slotKey = boardSlotKey(input.field, boardId);
    stageMandatoryNotice(perTurnWrites, session, {
      family: route,
      slotKey,
      turnId,
      friendly,
      field: input.field,
      boardId,
      reason: route,
      coveredToolCallIds: [call.tool_call_id],
      route,
      repeatKey: `${route}::${slotKey}`,
    });
  }
  return {
    code:
      route === 'unroutable_board_reading'
        ? 'client_route_unavailable'
        : 'structural_field_not_recordable',
    field: 'field',
  };
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
  // PLAN-2B — the ask resolver may freeze a board-reading designation
  // census on board A, block on its server-owned mdr-* clarification, then
  // resume after the user selected board B. Its generated write carries A
  // explicitly and reaches this dispatcher through createAutoResolveWriteHook.
  // Permit that one internal synthetic route to retain A without moving the
  // mutable cursor. Model-emitted calls cannot set dispatcher context, and the
  // synthetic call-id check prevents widening the ordinary wrong-board gate.
  const frozenAutoResolveBoardScope =
    ctx.allowFrozenAutoResolveBoardScope === true &&
    String(call.tool_call_id ?? '').includes('::auto::') &&
    !isUnscopedBoardId(input.board_id);
  const scopeErr = frozenAutoResolveBoardScope
    ? null
    : validateBoardScope(input, session.stateSnapshot);
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

  // PLAN-2D: structural metadata and the three legitimate-but-unroutable
  // sub-main readings fail closed before coercion or snapshot mutation. The
  // covered mandatory notice owns audibility, so a solo rejection suppresses
  // the generic retry prompt and a mixed turn drains beside sibling read-backs.
  const dispositionErr = stageBoardReadingDispositionRefusal(call, ctx, input);
  if (dispositionErr) {
    logToolCall(logger, {
      sessionId: session.sessionId,
      turnId,
      tool_use_id: call.tool_call_id,
      tool: 'record_board_reading',
      round,
      is_error: true,
      outcome: 'rejected',
      validation_error: dispositionErr,
      input_summary: { field: input.field },
    });
    return envelope(call.tool_call_id, { ok: false, error: dispositionErr }, true);
  }

  // Fix B 2026-06-02 (handoff §B) — value coercion + per-field VALUE
  // enum gate. Coerce first (currently nominal_voltage_u/uo "240"→"230"
  // for the UK pre-harmonisation drift; extend coerceRecordBoardReadingValue
  // as new board-side coercion needs surface), then check the coerced
  // value against the per-field option set.
  //
  // Audit-2026-06-02 confirmed reproductions (handoff §B):
  //   - nominal_voltage_uo = "240" (off-enum; coercion → "230" accepts)
  //   - afdd_button_confirmed = "true" is a CIRCUIT-side bug; handled by
  //     the parallel validateRecordReading gate. This board gate only
  //     bites for board/supply/installation enum drift.
  //
  // PII discipline mirrors steps 1 + 2 above — never log input.value.
  input.value = coerceRecordBoardReadingValue(input.field, input.value);
  // id-100(b) (2026-07-25) — SERVER-AUTHORITATIVE impedance clamp. THIS IS THE
  // C06B9904 REPRO PATH: `record_board_reading {earth_loop_impedance_ze, "16"}`
  // used to be written verbatim server-side and read back as "Ze 16", while the
  // client independently divided it to 1.6 — the inspector heard a value that
  // was never stored (Audio-First #1: the read-back must speak the value that
  // was stored). The server now performs the correction itself, so the spoken
  // confirmation is synthesised from the SAME scalar that lands in the snapshot.
  //
  // Ordering is coerce → clamp → validate: the clamp sees the post-coercion
  // value, and the enum/range gates below see the post-clamp value. Mutating
  // `input.value` in place is deliberate — it is the SINGLE source that both
  // the authoritative `applyBoardReadingFlagAware` write and the perTurnWrites
  // mirror read from, which structurally forecloses a snapshot-vs-wire split
  // brain (there is no second variable that could drift).
  //
  // The Ze band depends on the earthing arrangement (TT installations legitimately
  // measure up to 200 Ω), so it is resolved board-aware; when the arrangement is
  // UNKNOWN the clamp declines to divide (fail safe — see impedance-clamp.js).
  const boardClamp = clampReadingForDispatch({
    field: input.field,
    value: input.value,
    earthing: resolveBoardAwareEarthing(session.stateSnapshot, input.board_id),
  });
  input.value = boardClamp.value;
  const allowed = BOARD_FIELD_VALUE_ENUMS.get(input.field);
  if (allowed) {
    if (typeof input.value !== 'string') {
      const err = { code: 'invalid_type', field: 'value' };
      logToolCall(logger, {
        sessionId: session.sessionId,
        turnId,
        tool_use_id: call.tool_call_id,
        tool: 'record_board_reading',
        round,
        is_error: true,
        outcome: 'rejected',
        validation_error: err,
        input_summary: { field: input.field },
      });
      return envelope(call.tool_call_id, { ok: false, error: err }, true);
    }
    if (!allowed.has(input.value)) {
      const err = {
        code: 'value_not_in_options',
        field: 'value',
        valid_options: Array.from(allowed),
      };
      logToolCall(logger, {
        sessionId: session.sessionId,
        turnId,
        tool_use_id: call.tool_call_id,
        tool: 'record_board_reading',
        round,
        is_error: true,
        outcome: 'rejected',
        validation_error: err,
        input_summary: { field: input.field },
      });
      return envelope(call.tool_call_id, { ok: false, error: err }, true);
    }
  }

  // Audit-2026-06-02 Phase 1 — parallel numeric range gate to the
  // circuit-side check. BOARD_FIELD_NUMERIC_RANGES is empty today (no
  // board-side free-text numeric fields without a closed enum) but
  // wiring the gate now means a future board-side range addition
  // (e.g. supply Ze tolerances) won't need a second dispatcher edit.
  // Same rejection-envelope shape as the circuit path so dashboards
  // attribute consistently.
  const rangeVerdict = isWithinRange(input.field, input.value, BOARD_FIELD_NUMERIC_RANGES);
  if (!rangeVerdict.ok) {
    const err = {
      code: rangeVerdict.code,
      field: 'value',
      value: input.value,
      min: rangeVerdict.min,
      max: rangeVerdict.max,
    };
    logToolCall(logger, {
      sessionId: session.sessionId,
      turnId,
      tool_use_id: call.tool_call_id,
      tool: 'record_board_reading',
      round,
      is_error: true,
      outcome: 'rejected',
      validation_error: err,
      input_summary: { field: input.field },
    });
    return envelope(call.tool_call_id, { ok: false, error: err }, true);
  }

  // PLAN-backend-final.md Phase 4.3 — field-level guard against the
  // Marlborough / 71-Hexham-Road class bug where Sonnet wrote
  // `record_board_reading {field:"client_name", value:"71 Hexham Road,
  // Reading"}` in response to *"Should I use this address for the client
  // too?"* + *"Y"*. The right routing is four record_board_reading
  // writes to `client_address` / `client_postcode` / `client_town` /
  // `client_county` (Phase 4.0 added those slots; Phase 4.2 added the
  // prompt guidance). This guard rejects the legacy bad routing so
  // Sonnet sees a structured error and retries with the right slot
  // rather than the cached prefix carrying a misrouted value into the
  // PDF. Anchored at start of value, case-insensitive, matches the
  // common UK address openers; deliberately conservative — "John Road"
  // (a person's actual surname) doesn't match because the leading
  // digit-then-word pattern is required.
  if (input.field === 'client_name' && typeof input.value === 'string') {
    if (CLIENT_NAME_ADDRESS_SHAPE.test(input.value)) {
      const err = { code: 'client_name_looks_like_address', field: 'value' };
      logToolCall(logger, {
        sessionId: session.sessionId,
        turnId,
        tool_use_id: call.tool_call_id,
        tool: 'record_board_reading',
        round,
        is_error: true,
        outcome: 'rejected',
        validation_error: err,
        input_summary: { field: input.field },
      });
      return envelope(call.tool_call_id, { ok: false, error: err }, true);
    }
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
  const boardMirror = {
    value: input.value,
    confidence: input.confidence ?? 1.0,
    source_turn_id: input.source_turn_id,
    auto_resolved: autoResolved || undefined,
    boardId: input.board_id ?? undefined,
  };
  // id-100(b) — stash the clamp correction on the mirror entry so the bundler
  // can name it aloud ("Ze recorded as 1.6 — I corrected 16 to 1.6"). A Symbol
  // key is invisible to JSON.stringify and to every `Object.keys`/spread-based
  // wire serialiser by construction, so this is backend-internal transport that
  // CANNOT leak onto the wire or into a snapshot — no wire-shape change, and no
  // client decoder work is required for either platform.
  if (boardClamp.correction) {
    Object.defineProperty(boardMirror, IMPEDANCE_CLAMP_CORRECTION, {
      value: boardClamp.correction,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    logImpedanceClamp(logger, {
      sessionId: session.sessionId,
      turnId,
      seam: 'record_board_reading',
      field: input.field,
      circuit: null,
      board_id: input.board_id ?? null,
      original: boardClamp.correction.original,
      corrected: boardClamp.correction.corrected,
      divisor: boardClamp.correction.divisor,
    });
  }
  // PLAN-2D — stamp every client-routable board/section write through the
  // dedicated WRITE scope map. This remains separate from
  // BOARD_CLEAR_SCOPE_MAP: classifying a destination must never make a field
  // clearable. Board-scoped writes carry the effective board because the
  // extraction frame precedes current_board_changed on the wire; global fields
  // stay board-insensitive.
  const writeCanonical = FIELD_CORRECTIONS[input.field] ?? input.field;
  {
    const writeScope = BOARD_READING_SCOPE_MAP[writeCanonical];
    if (writeScope === 'global') {
      attachEffectiveBoardSlot(boardMirror, writeCanonical, null);
    } else if (writeScope === 'board') {
      attachEffectiveBoardSlot(
        boardMirror,
        writeCanonical,
        resolveEffectiveBoardIdForClear(session, input.board_id)
      );
    }
  }
  // PLAN-2C — token producer identity is decided at DISPATCH, where the
  // authoritative operation scope and full write journal are still present.
  // It must not be inferred later from optional wire board_id spelling or the
  // post-LWW confirmation list. Postcode is installation-global, so an
  // explicit/frozen board spelling cannot mint a different client key for the
  // same logical operation. Count prior same-field/scope journal entries so a
  // fresh replay remains ord0 while two writes in one turn become ord0/ord1.
  const dedupeScope = WIRE_CLIENT_SECTION_DEDUPE_SCOPES[writeCanonical];
  if (dedupeScope) {
    attachSectionDedupeOperation(
      boardMirror,
      writeCanonical,
      dedupeScope,
      nextSectionDedupeOrdinal(perTurnWrites, writeCanonical, dedupeScope)
    );
  }
  // A2-multiboard — journal the board write. `record_board_reading` carries NO
  // schema `board_id`, so the raw Map key is boardless and
  // `select_board A → record manufacturer → select_board B → record manufacturer`
  // collided: the second Map.set DESTROYED the first, silently un-writing a
  // dictated board reading that had already been read back aloud.
  recordBoardReadingWrite(
    perTurnWrites,
    encodeBoardReadingKey(input.field, input.board_id),
    boardMirror
  );

  // 4b) Bonding-continuity mirror derivation — 2026-06-12 field report
  // (session 15B88D6B, voiceFeedbackId 21): "I'd like this [main protective
  // bonding continuity] to pass when bonding of a service is given." When a
  // bonding service check lands as PASS and the continuity slot is still
  // empty, derive bonding_conductor_continuity = PASS — the inspector cannot
  // have verified bonding to a service without the conductor being
  // continuous, so the derivation is implied by the dictation, mirroring the
  // iOS regex path's autoContinuityIfBonded. Never overrides an existing
  // value (in particular FAIL/LIM stay untouched), and skips when the model
  // wrote continuity itself this turn.
  if (BONDING_SERVICE_FIELDS.has(input.field) && input.value === 'PASS') {
    const continuityKey = encodeBoardReadingKey('bonding_conductor_continuity', input.board_id);
    const current = readBoardFieldDualShape(
      session.stateSnapshot,
      'bonding_conductor_continuity',
      input.board_id
    );
    const writtenThisTurn = perTurnWrites.boardReadings.has(continuityKey);
    if (!writtenThisTurn && (current == null || current === '')) {
      applyBoardReadingFlagAware(session.stateSnapshot, {
        field: 'bonding_conductor_continuity',
        value: 'PASS',
        boardId: input.board_id,
      });
      recordBoardReadingWrite(perTurnWrites, continuityKey, {
        value: 'PASS',
        confidence: input.confidence ?? 1.0,
        source_turn_id: input.source_turn_id,
        // Derived write, not a model tool call — tag auto_resolved so the
        // shadow comparator filters it (same convention as the RCBO pivot
        // mirrors in stage6-shadow-harness.js). The bundler still emits it
        // to iOS with the flag attached.
        auto_resolved: true,
        boardId: input.board_id ?? undefined,
      });
      logger.info('stage6.bonding_continuity_derived', {
        sessionId: session.sessionId,
        turnId,
        trigger_field: input.field,
      });
    }
  }

  // 5) log success.
  // PLAN voice-feedback-2026-06-05 W1.2 (b): extend input_summary with
  // `confidence` (numeric — Sonnet's self-reported confidence) and a
  // projected `expected_dedupe_key` so CloudWatch operators can correlate
  // the dispatcher row with the eventual bundler `ios_send_attempt` row +
  // the iOS-side dedupe Set decision. The key here uses `input.value` as
  // a TEXT proxy (final TTS text isn't built until the bundler synthesise
  // step); the bundler row replaces the proxy with the canonical TTS
  // text. Both rows share the same field + boardId so an operator can
  // join them. Mirrors iOS algorithm at DeepgramRecordingViewModel.swift:649
  // — see ios-dedupe-key.js for the cross-platform contract.
  // PII discipline (re-asserted): value is NEVER logged as raw text —
  // only its djb2 hash is exposed, which is a one-way scalar.
  logToolCall(logger, {
    sessionId: session.sessionId,
    turnId,
    tool_use_id: call.tool_call_id,
    tool: 'record_board_reading',
    round,
    is_error: false,
    outcome: 'ok',
    validation_error: null,
    input_summary: {
      field: input.field,
      confidence: input.confidence,
      board_id: input.board_id ?? null,
      expected_dedupe_key: buildDegenerateDedupeKey(
        input.field,
        input.value == null ? '' : String(input.value),
        input.board_id ?? null
      ),
    },
  });
  return envelope(call.tool_call_id, { ok: true }, false);
}

// Bonding service checks whose PASS implies main bonding conductor
// continuity (see 4b above). bonding_conductor_continuity itself is
// deliberately absent — it is the derivation TARGET. bonding_other is
// also absent: it is a free-TEXT field (the bonded item's name), so its
// value is never legitimately 'PASS'.
const BONDING_SERVICE_FIELDS = new Set([
  'bonding_water',
  'bonding_gas',
  'bonding_oil',
  'bonding_structural_steel',
  'bonding_lightning',
]);

/**
 * Read a board-level field via the same dual-shape rule the mutators use:
 * main-board target reads the legacy `circuits[0]` bucket, non-main targets
 * read the BoardInfo entry on `snapshot.boards`. Returns undefined when the
 * field (or board) is absent.
 */
function readBoardFieldDualShape(snapshot, field, boardId) {
  const mainId = getMainBoardId(snapshot);
  const target = boardId ?? snapshot?.currentBoardId ?? mainId;
  if (target === mainId) {
    return snapshot?.circuits?.[0]?.[field];
  }
  const board = Array.isArray(snapshot?.boards)
    ? snapshot.boards.find((b) => b && b.id === target)
    : undefined;
  return board?.[field];
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

  // 10a) Atomicity — when add_board carries both parent_board_id and
  //      feed_circuit_ref, also mark the parent's feed circuit as a
  //      distribution circuit feeding the new board. ONE inspector
  //      utterance ("garage CU fed from circuit 2 on the main board")
  //      then = ONE atomic mutation = ONE round-trip, instead of forcing
  //      Sonnet to chain `add_board` → `mark_distribution_circuit` and
  //      navigate the cross-board source-resolution problem.
  //
  //      Field test FD4FF35F (2026-05-09) hit exactly this cascade: after
  //      add_board flipped currentBoardId to "sub-1", the model called
  //      mark_distribution_circuit({circuit:2, feeds_board_id:"sub-1"})
  //      without an explicit board_id, the dispatcher resolved source =
  //      currentBoardId = "sub-1", and the source-board check rejected
  //      (sub-1 had no circuit 2). Doing the mark inline removes the
  //      whole second-tool-call class of failure and matches the model's
  //      semantic intent — adding a sub-main IS marking its feed circuit.
  //
  //      No-op when the feed circuit doesn't exist yet (e.g. inspector
  //      adds the sub-board before describing the feed). Sonnet can call
  //      mark_distribution_circuit later when the circuit is created.
  //      Explicit log row when this fires so optimiser reports can audit
  //      the round-trip and an "add but no mark" is distinguishable from
  //      an "add then ask".
  if (resolvedParentId && Number.isInteger(input.feed_circuit_ref)) {
    const parentBucket = getCircuitBucket(snapshot, input.feed_circuit_ref, resolvedParentId);
    if (parentBucket) {
      parentBucket.is_distribution_circuit = 'yes';
      parentBucket.feeds_board_id = newId;
      perTurnWrites.boardOps.push({
        op: 'mark_distribution_circuit',
        circuit_ref: input.feed_circuit_ref,
        feeds_board_id: newId,
        source_board_id: resolvedParentId,
      });
      if (logger?.info) {
        logger.info('stage6.add_board_auto_mark_dist', {
          sessionId: session.sessionId,
          turnId,
          tool_use_id: call.tool_call_id,
          board_id: newId,
          source_board_id: resolvedParentId,
          circuit_ref: input.feed_circuit_ref,
        });
      }
    } else if (logger?.info) {
      // Distinguish the "circuit exists yet" miss from a successful mark
      // so the same telemetry can flag inspectors who declare the feed
      // circuit only after adding the board.
      logger.info('stage6.add_board_auto_mark_dist_skipped', {
        sessionId: session.sessionId,
        turnId,
        tool_use_id: call.tool_call_id,
        board_id: newId,
        source_board_id: resolvedParentId,
        circuit_ref: input.feed_circuit_ref,
        reason: 'feed_circuit_not_found',
      });
    }
  }

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
  // A2-multiboard item 6 — normalise the board scope before anything reads it.
  // Here `board_id` names the SOURCE board, resolved with a nullish fallback to
  // the current board; an empty string used to slip past that fallback and come
  // back `source_board_not_found` instead of defaulting like an absent key.
  // The two destructive/authoritative board dispatchers in this file
  // (`clear_board_reading`, `record_board_reading`) are deliberately EXEMPT and
  // must keep rejecting an injected empty id — see validateBoardScope.
  const input = normaliseBoardScopeInput(call.input ?? {});

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

// ---------------------------------------------------------------------------
// Plan A1a (2026-07-27, feedback id 101) — clear_board_reading dispatcher.
// ---------------------------------------------------------------------------

// O(1) membership for the runtime enum validation. Strict mode is disabled
// (Bug-E), so tool schemas are model GUIDANCE — an off-enum `field` CAN reach
// the dispatcher and MUST be rejected here before anything else runs.
const CLEAR_BOARD_FIELD_SET = new Set(CLEAR_BOARD_READING_FIELD_ENUM);

/**
 * A1a's MINIMAL pinned scope map — the backend-only source for the
 * field-scope classification (§3.4). Covers ONLY the fields the collapse
 * tests exercise; the full client-sweep-derived classification for all 78
 * members is A1b's. A1a ships mutation-dark, so an unclassified member can
 * never mutate for a real session (the dispatcher denies before the scope
 * question arises); a capable test session clearing an unclassified field
 * fails CLOSED (`board_clear_scope_unclassified`, §3.4 / test 19).
 *
 * Keyed by CANONICAL field (post-FIELD_CORRECTIONS). Raw spellings are
 * canonicalised before lookup, so `earth_loop_impedance_ze` resolves via
 * 'ze' and `prospective_fault_current` via 'pfc'.
 *
 *  - 'global': ONE client cell per job regardless of selected board
 *    (iOS supplyCharacteristics singletons). Slot identity is field-only;
 *    the mutator sweeps every backend bucket + alias.
 *  - 'board': one value per board on BOTH clients (manufacturer is the
 *    round-16 exemplar — the only row with a proven per-board write arm on
 *    both clients). Slot identity carries the resolved board id.
 */
export const BOARD_CLEAR_SCOPE_MAP = Object.freeze({
  ze: 'global',
  pfc: 'global',
  manufacturer: 'board',
});

// Plan B (honest-refusal, 2026-07-28) §3.1 — the notice-family machinery
// (families + djb2-seeded rotation selection + staging/coalescing) moved
// VERBATIM to the shared refusal-notice registry so new structural-refusal
// families are declared, not re-implemented. These two re-exports are the
// COMPATIBILITY surface: existing A1a suites import them from this module,
// and the byte-parity pins live against these names. The shared module is
// dependency-downstream-only (imports nothing from dispatchers/harness).
export { BOARD_CLEAR_NOTICE_FAMILIES, selectMandatoryNoticeText } from './refusal-notices.js';

/** Spoken name for a board field: friendly-table entry or snake→spaces. */
function boardFieldSpokenName(field) {
  return CONFIRMATION_FRIENDLY_NAMES[field] ?? deriveFriendlyName(field);
}

function resolveEffectiveBoardIdForClear(session, rawBoardId) {
  const snapshot = session?.stateSnapshot;
  if (rawBoardId != null && rawBoardId !== '') return rawBoardId;
  return snapshot?.currentBoardId ?? getMainBoardId(snapshot);
}

/**
 * Plan B §3.2 (round-3) — the PURE board-clear classifier, extracted from
 * dispatchClearBoardReading's inline steps 3–5 so the `clear_reading` bridge
 * can ask "would clear_board_reading deny this field, and why?" WITHOUT
 * running the dispatcher (which, in the capable state, would MUTATE — it
 * would clear a reading the user never asked that tool to clear).
 *
 * Side-effect-free by contract: no logging, no staging, no snapshot writes.
 * `dispatchClearBoardReading` consumes this in place of its inline checks
 * (validation precedence + rendered bytes pinned by parity tests), so the
 * two callers can never drift.
 *
 * DECISION ORDER (A1a round-11 pin, test 20): capability/kill-switch denial
 * → cert-type applicability refusal → scope classification. Capability-
 * missing is checked FIRST: it is the honest dark-state message (the
 * kill-switch code is only meaningful for a client that could otherwise
 * clear).
 *
 * `input` is required (round-6): the board-scoped slotKey needs
 * `input.board_id` via resolveEffectiveBoardIdForClear and the friendlyLabel
 * needs the field spelling; for global `ze`/`pfc` the board component is
 * null and `input.board_id` is unused. The returned `slotKey` is
 * SCOPE-CONDITIONED to mirror the success path's EFFECTIVE_BOARD_SLOT
 * stamping exactly (`clearSlotBoardComponent = scope==='global' ? null :
 * resolvedBoardId`) — the bridge uses this ONE derivation for both its
 * notice slotKey and its `${family}::${slotKey}` repeat key, so a
 * same-turn `clear_board_reading` success on the same slot can reconcile
 * the bridge's wrong_tool_clear notice away (net-0).
 *
 * @returns {{denialFamily: string|null, slotKey: string, friendlyLabel: string,
 *            resolvedBoardId: string|null, scope: 'global'|'board'|undefined}}
 *          `denialFamily ∈ {board_clear_capability_missing, board_clear_disabled,
 *          field_not_applicable_on_eicr, board_clear_scope_unclassified}`;
 *          null means the field IS clearable for this session.
 */
export function classifyBoardClear(session, ctx, canonicalField, input) {
  const friendlyLabel = boardFieldSpokenName(input.field);
  const resolvedBoardId = resolveEffectiveBoardIdForClear(session, input.board_id);
  const scope = BOARD_CLEAR_SCOPE_MAP[canonicalField];
  // Scope-conditioned slot for CLASSIFIED fields; total denial-slot fallback
  // (canonical field + resolved board) for UNCLASSIFIED fields — erring
  // toward EXTRA audibility (two denials on different boards both speak)
  // rather than over-suppression (A1a §3.5 round-11).
  const slotKey =
    scope === 'global'
      ? boardSlotKey(canonicalField, null)
      : boardSlotKey(canonicalField, resolvedBoardId);
  // A1b (2026-07-29) — the capability is read LIVE from the active-sessions
  // registry at DISPATCH time, never from the turn-start ctx snapshot. The
  // reconnect re-parse (sonnet-stream.js ~:2594) mutates the SIBLING
  // `entry.voiceLatency.capabilities` mid-turn, so a snapshot taken at
  // harness construction (`ctx.hasBoardClearV1`) can be stale by the time a
  // destructive clear dispatches; the synchronous registry read is
  // event-loop-atomic against that re-parse (same live-read pattern as
  // stage6-shadow-harness.js `getActiveSessionEntry(session.sessionId)`).
  // An UNREGISTERED session (no entry) reads as capability-missing —
  // deny-first, the safe direction. `ctx.hasBoardClearV1` remains for the
  // bundler's projection-time board-fill gate; the DISPATCH decision must
  // not use it.
  const capabilityMissing =
    getActiveSessionEntry(session.sessionId)?.voiceLatency?.capabilities?.hasBoardClearV1 !== true;
  const killed = isBoardClearKilled();
  if (capabilityMissing || killed) {
    return {
      denialFamily: capabilityMissing ? 'board_clear_capability_missing' : 'board_clear_disabled',
      slotKey,
      friendlyLabel,
      resolvedBoardId,
      scope,
    };
  }
  if (
    input.field === 'comments' &&
    typeof session.certType === 'string' &&
    session.certType.toLowerCase() !== 'eic'
  ) {
    return {
      denialFamily: 'field_not_applicable_on_eicr',
      slotKey,
      friendlyLabel,
      resolvedBoardId,
      scope,
    };
  }
  if (scope !== 'global' && scope !== 'board') {
    return {
      denialFamily: 'board_clear_scope_unclassified',
      slotKey,
      friendlyLabel,
      resolvedBoardId,
      scope,
    };
  }
  return { denialFamily: null, slotKey, friendlyLabel, resolvedBoardId, scope };
}

/**
 * clear_board_reading: the board/supply-scope clear (plan A1a §3.4).
 *
 * VALIDATION ORDER (round-11 pin, test 20): runtime enum-validation →
 * board-scope backstop → capability/kill-switch denial → cert-type
 * applicability refusal → scope classification → mutator. So a
 * capability-absent EICR `comments` clear reports
 * `board_clear_capability_missing` (the honest dark-state message) and the
 * EICR refusal only fires for a CAPABLE session.
 *
 * ENVELOPE DISCIPLINE (§3.5a): every denial/refusal/no-op path returns a
 * SOFT SKIP (`is_error: false`, outcome 'skipped'/'noop') copying P3's
 * denyLim byte-for-byte, AND stages a `perTurnWrites.mandatoryNotices`
 * entry. A hard-rejection envelope would hand the turn to the A3
 * all-rejected net (generic "couldn't action that") and silently discard
 * the designed wording; the old `voiceNotices` channel would drop the
 * notice on any turn that also wrote something. The ONLY hard rejections
 * here are the schema/validation classes (`invalid_field`, `wrong_board`)
 * — genuine model errors the model should correct, correctly owned by the
 * A3 net.
 */
export async function dispatchClearBoardReading(call, ctx) {
  const { session, logger, turnId, perTurnWrites, round } = ctx;
  const input = call.input ?? {};

  // 1) Runtime enum validation FIRST (§3.4). Hard rejection — no notice,
  //    no mutation, no frame.
  if (typeof input.field !== 'string' || !CLEAR_BOARD_FIELD_SET.has(input.field)) {
    const err = { code: 'invalid_field', field: 'field' };
    logToolCall(logger, {
      sessionId: session.sessionId,
      turnId,
      tool_use_id: call.tool_call_id,
      tool: 'clear_board_reading',
      round,
      is_error: true,
      outcome: 'rejected',
      validation_error: err,
      input_summary: { field: input.field ?? null },
    });
    return envelope(call.tool_call_id, { ok: false, error: err }, true);
  }

  // 2) Board-scope backstop. The schema has no board_id param, so this fires
  //    only for injected / off-schema calls — but raw board_id is validated
  //    BEFORE any effective-target normalisation: an empty string returns
  //    wrong_board (validateBoardScope's deliberate contract) rather than
  //    silently retargeting a destructive clear at the current board.
  const scopeErr = validateBoardScope(input, session.stateSnapshot);
  if (scopeErr) {
    logToolCall(logger, {
      sessionId: session.sessionId,
      turnId,
      tool_use_id: call.tool_call_id,
      tool: 'clear_board_reading',
      round,
      is_error: true,
      outcome: 'rejected',
      validation_error: scopeErr,
      input_summary: { field: input.field },
    });
    return envelope(call.tool_call_id, { ok: false, error: scopeErr }, true);
  }

  const canonicalField = FIELD_CORRECTIONS[input.field] ?? input.field;

  // 3–5) Capability/kill-switch denial → cert-type applicability refusal →
  //    scope classification, via the PURE classifier (plan B §3.2 extraction
  //    — the clear_reading bridge shares the exact decision sequence without
  //    risking a mutation). Decision order + rendered bytes are parity-pinned
  //    against the pre-extraction inline checks. A denial is a SOFT SKIP
  //    (is_error:false) + a staged mandatory notice, per the envelope
  //    discipline in the function header; the honest dark-state message
  //    (capability_missing) wins over the kill-switch code, the EICR
  //    refusal only fires for a CAPABLE session, and UNKNOWN scope fails
  //    CLOSED (a mis-scoped clear is the F5 factory — a global field
  //    cleared as board-scoped never sweeps circuits[0], so the value
  //    survives and re-asserts).
  const cls = classifyBoardClear(session, ctx, canonicalField, input);
  const friendly = cls.friendlyLabel;
  const resolvedBoardId = cls.resolvedBoardId;
  const scope = cls.scope;
  const noticeSlotKey = cls.slotKey;
  if (cls.denialFamily != null) {
    const reason = cls.denialFamily;
    logToolCall(logger, {
      sessionId: session.sessionId,
      turnId,
      tool_use_id: call.tool_call_id,
      tool: 'clear_board_reading',
      round,
      is_error: false,
      outcome: 'skipped',
      validation_error: null,
      input_summary: { field: input.field, reason },
    });
    stageMandatoryNotice(perTurnWrites, session, {
      family: reason,
      slotKey: noticeSlotKey,
      turnId,
      friendly,
      field: input.field,
      boardId: resolvedBoardId,
      reason,
    });
    return envelope(call.tool_call_id, { ok: true, skipped: true, reason }, false);
  }

  // 6) Mutate. scope decides both the slot key and the bucket sweep —
  //    global fields clear everywhere under every alias; board-scoped
  //    fields clear one board's record (§3.3a).
  const { cleared, previousValue } = clearBoardReadingFlagAware(session.stateSnapshot, {
    field: input.field,
    boardId: input.board_id,
    scope,
  });

  if (!cleared) {
    // Already-empty: a spoken no-op, NEVER silence and NEVER an apology —
    // the request was understood; the field is simply blank (§3.5).
    logToolCall(logger, {
      sessionId: session.sessionId,
      turnId,
      tool_use_id: call.tool_call_id,
      tool: 'clear_board_reading',
      round,
      is_error: false,
      outcome: 'noop',
      validation_error: null,
      input_summary: { field: input.field, reason: 'field_not_set' },
    });
    stageMandatoryNotice(perTurnWrites, session, {
      family: 'board_clear_already_empty',
      slotKey: noticeSlotKey,
      turnId,
      friendly,
      field: input.field,
      boardId: resolvedBoardId,
      reason: 'field_not_set',
    });
    return envelope(call.tool_call_id, { ok: true, noop: true, reason: 'field_not_set' }, false);
  }

  // 7) Mechanism A — same-turn write→clear collapse: delete every
  //    perTurnWrites.boardReadings entry whose EFFECTIVE slot equals this
  //    clear's effective slot. The raw map key CANNOT be used (it is
  //    boardless for schema-conforming writes and stores the raw spelling);
  //    match on the stamped EFFECTIVE_BOARD_SLOT, with a raw-identity
  //    fallback for Symbol-less (legacy/unclassified) entries so a
  //    same-raw-spelling write→clear still collapses.
  //
  //    A2-multiboard — the removal goes through the JOURNAL, not a bare
  //    `boardReadings.delete(mapKey)`. The raw key is boardless, so two boards'
  //    writes of the same field share ONE key; deleting that key would also
  //    un-write the OTHER board's reading. `removeBoardReadingWrites` drops
  //    only the matching journal ENTRIES and then re-points the Map at whatever
  //    winner still claims the raw key. The predicate is the pre-journal
  //    identity contract verbatim.
  const clearSlotBoardComponent = scope === 'global' ? null : resolvedBoardId;
  const clearSlotKey = boardSlotKey(canonicalField, clearSlotBoardComponent);
  removeBoardReadingWrites(perTurnWrites, (mapKey, val) => {
    const sym = val?.[EFFECTIVE_BOARD_SLOT];
    if (sym) {
      return boardSlotKey(sym.field, sym.boardId) === clearSlotKey;
    }
    const decoded = decodeBoardReadingKey(mapKey);
    const decodedCanonical = FIELD_CORRECTIONS[decoded.field] ?? decoded.field;
    const decodedBoard =
      scope === 'global'
        ? null
        : (decoded.boardId ?? resolveEffectiveBoardIdForClear(session, null));
    return boardSlotKey(decodedCanonical, decodedBoard) === clearSlotKey;
  });

  // 8) Emit the board field_corrected entry (§3.4b wire contract): circuit
  //    null + non-null board_id is the discriminator both clients route on.
  //    `field` is pushed RAW — the bundler's FIELD_CORRECTIONS
  //    canonicalisation rewrites the OUTBOUND copy only (so a
  //    prospective_fault_current clear rides the wire as 'pfc').
  perTurnWrites.fieldCorrections.push(
    attachEffectiveBoardSlot(
      {
        type: 'field_corrected',
        circuit: null,
        field: input.field,
        previous_value: previousValue,
        reason: 'clear_reading',
        board_id: resolvedBoardId,
      },
      canonicalField,
      clearSlotBoardComponent
    )
  );

  logToolCall(logger, {
    sessionId: session.sessionId,
    turnId,
    tool_use_id: call.tool_call_id,
    tool: 'clear_board_reading',
    round,
    is_error: false,
    outcome: 'ok',
    validation_error: null,
    input_summary: { field: input.field, board_id: input.board_id ?? null, scope },
  });
  return envelope(call.tool_call_id, { ok: true }, false);
}
