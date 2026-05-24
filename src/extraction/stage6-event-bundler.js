/**
 * Stage 6 Phase 2 Plan 02-05 — Event bundler (pure function).
 *
 * REQUIREMENTS: STD-09 (bundler produces legacy shape) + STI-02 (iOS sees a
 * single `extraction` message per turn, not N granular events).
 * RESEARCH: §Q10 "iOS Event Bundling" — the server wire protocol does NOT
 * change in Phase 2. iOS still receives one `{type:'extraction', result:{...}}`
 * per turn. Only the SOURCE of that result shifts: prose-JSON parse (legacy)
 * vs. aggregated tool-call outcomes (Phase 2 shadow; Phase 7+ live).
 * PITFALL MITIGATED: #3 "bundler fires mid-loop" — this module is intentionally
 * side-effect-free and called ONCE post-loop by Plan 02-06's shadow harness.
 *
 * This module imports NOTHING and performs NO side effects (no logger, no
 * ws.send, no session mutation). It is a pure projection of the per-turn
 * writes accumulator (Plan 02-02) plus a passthrough of the legacy result's
 * `questions` slot into the iOS wire shape.
 */

import { decodeReadingKey, decodeBoardReadingKey } from './stage6-per-turn-writes.js';
// Loaded Barrel Phase 1.B (plan v10 §C) — the helper + friendly-name
// table moved into `confirmation-text.js` so loaded-barrel-speculator.js
// can import the same buildConfirmationText without dragging the rest
// of the bundler into its call site. No behavioural change here.
import { CONFIRMATION_MIN_CONFIDENCE, buildConfirmationText } from './confirmation-text.js';

export const BUNDLER_PHASE = 2;

/**
 * Synthesise brief read-back confirmations from the bundled readings.
 *
 * The legacy prose-JSON extractor used to emit a `confirmations` array
 * directly from the model (config/prompts/sonnet_extraction_system.md:283).
 * The Stage 6 agentic path has no analogue — record_reading is the only
 * write tool — so the iOS "Voice" toggle hooked to
 * `confirmationModeEnabled` (DeepgramRecordingViewModel.swift:7334) read
 * `result.confirmations` against an always-empty array, making the toggle
 * appear broken. This helper rebuilds the same wire shape from the
 * tool-call outcomes so the iOS path keeps working without a TestFlight
 * push or a prompt revision.
 *
 * Confirmation text is intentionally short (legacy "under 5 words" guidance
 * preserved at intent level; the friendly-name lookup keeps it concise).
 *
 * @param {Array<{field: string, circuit?: number|string, value: any, confidence: number}>} readings
 *   Circuit-scoped readings (bundler output extracted_readings).
 * @param {Array<{field: string, value: any, confidence: number}>} boardReadings
 *   Board-scoped readings (bundler output extracted_board_readings).
 * @returns {Array<{text: string, field: string, circuit: number|null}>}
 */
function synthesiseConfirmations(readings, boardReadings) {
  const out = [];
  for (const r of readings) {
    if (typeof r.confidence === 'number' && r.confidence < CONFIRMATION_MIN_CONFIDENCE) continue;
    const text = buildConfirmationText(r.field, r.value, r.circuit);
    if (!text) continue;
    const entry = {
      text,
      field: r.field,
      circuit: Number.isInteger(r.circuit) ? r.circuit : null,
    };
    // Loaded Barrel Phase 1.B — emit board_id when set so the iOS
    // POST can include it in the cache-key tuple. Omit when null/
    // undefined so single-board sessions stay byte-identical on the
    // wire and pre-Phase-4a iOS clients (which don't decode board_id
    // on ValueConfirmation yet) see no change.
    if (r.board_id != null) {
      entry.board_id = r.board_id;
    }
    out.push(entry);
  }
  for (const r of boardReadings) {
    if (typeof r.confidence === 'number' && r.confidence < CONFIRMATION_MIN_CONFIDENCE) continue;
    const text = buildConfirmationText(r.field, r.value, null);
    if (!text) continue;
    const entry = { text, field: r.field, circuit: null };
    if (r.board_id != null) {
      entry.board_id = r.board_id;
    }
    out.push(entry);
  }
  return out;
}

/**
 * Translate per-turn tool-call outcomes into the legacy `extraction` result
 * shape that iOS `ServerWebSocketService` expects.
 *
 * @param {{readings: Map<string, {value: any, confidence: number, source_turn_id?: string, boardId?: string}>,
 *          boardReadings: Map<string, {value: any, confidence: number, source_turn_id?: string, boardId?: string}>,
 *          cleared: Array<{field: string, circuit: string, reason?: string}>,
 *          observations: Array<{id: string, text: string, code: string}>,
 *          deletedObservations: Array<{id: string, reason?: string}>,
 *          circuitOps: Array<{op: string, circuit_ref: string, from_ref?: string, board_id?: string, meta?: any}>,
 *          boardOps?: Array<{op: string, [key: string]: any}>}} perTurnWrites
 *   Accumulator populated by Phase 2 dispatchers (Plans 02-03 + 02-04 +
 *   Bug-C carryover dispatcher record_board_reading + Phase 6 board-op
 *   dispatchers).
 * @param {{questions?: Array<any>}|null|undefined} legacyResultShape
 *   The legacy extractor's result object. Only `.questions` is consumed
 *   (Phase 2 keeps legacy question-gate behaviour; tool-call ask_user is
 *   Phase 3+). If null/undefined, treated as `{}` so the bundler still
 *   produces a valid empty-questions shape even when the legacy path threw.
 * @returns {{extracted_readings: Array<{field: string, circuit: string, value: any, confidence: number, source: 'tool_call', board_id?: string}>,
 *            observations: Array<{id: string, text: string, code: string}>,
 *            questions: Array<any>,
 *            cleared_readings?: Array<{field: string, circuit: string, reason?: string}>,
 *            circuit_updates?: Array<{op: string, circuit_ref: string, from_ref?: string, board_id?: string, meta?: any}>,
 *            observation_deletions?: Array<{id: string, reason?: string}>,
 *            extracted_board_readings?: Array<{field: string, value: any, confidence: number, source: 'tool_call', board_id?: string}>,
 *            board_ops?: Array<{op: string, [key: string]: any}>}}
 */
export function bundleToolCallsIntoResult(perTurnWrites, legacyResultShape, options = {}) {
  if (!perTurnWrites || !(perTurnWrites.readings instanceof Map)) {
    throw new TypeError('bundleToolCallsIntoResult: perTurnWrites.readings must be a Map');
  }
  // boardReadings is optional for backwards compat with any caller that
  // builds the accumulator manually (e.g. older test fixtures that pre-date
  // the Bug C carryover). createPerTurnWrites() always seeds an empty Map.
  const boardReadings =
    perTurnWrites.boardReadings instanceof Map ? perTurnWrites.boardReadings : new Map();
  const legacy = legacyResultShape ?? {};

  // 1. Readings projection — Map → array. Key `${field}::${circuit}` splits
  //    to recover (field, circuit); value carries {value, confidence, ...}.
  //    Confidence is passed VERBATIM (dispatcher already applied ?? 1.0).
  //    Map.entries() preserves insertion order — STT-09 same-turn correction
  //    survives because the dispatcher overwrote the Map entry before we see it.
  //
  //    Codex Phase-2 review MAJOR #2 fix: the Map key is built via template
  //    literal (`${field}::${input.circuit}`) which coerces the original
  //    integer circuit_ref to a string. Legacy `extracted_readings[].circuit`
  //    is typed as integer at `eicr-extraction-session.js:992` (`circuit === -1`)
  //    and the STS-01..04 tool schemas all declare `circuit` / `circuit_ref`
  //    as `integer` (stage6-tool-schemas.js). Emitting a string here would
  //    make the slot comparator see a legitimate divergence whenever both
  //    paths record the same reading, and Phase 7's wire projection would
  //    drift from legacy. Parse the suffix back to an integer when it round-
  //    trips cleanly; fall back to the raw string otherwise (future-proof
  //    against a non-integer circuit_ref the schema doesn't currently allow).
  const extracted_readings = [];
  for (const [key, entry] of perTurnWrites.readings) {
    // Slice 1.1c — decodeReadingKey handles BOTH the new boardId-tagged
    // shape `${field}::${circuit}<NUL>__board__<NUL>${boardId}<NUL>` and
    // legacy 2-part `${field}::${circuit}` keys (test fixtures or older
    // accumulators) so this loop is shape-agnostic. boardId from the key
    // is NOT used for emission — the value entry's boardId (set by the
    // dispatcher in slice 1.1a) is the wire-shape SoT; the key boardId
    // is purely a same-turn collision-key.
    const { field, circuit: circuitStr } = decodeReadingKey(key);
    const circuitInt = Number(circuitStr);
    const circuit =
      circuitStr !== '' && Number.isInteger(circuitInt) && String(circuitInt) === circuitStr
        ? circuitInt
        : circuitStr;
    const reading = {
      field,
      circuit,
      value: entry.value,
      confidence: entry.confidence,
      source: 'tool_call',
    };
    // P3-B (2026-04-27) — propagate the auto_resolve marker so the slot
    // comparator can filter synthetic writes out of shadow-vs-live diffs.
    // Set ONLY when truthy so the JSON wire shape stays byte-identical for
    // every Sonnet-direct write (the existing iOS decoder doesn't know this
    // field; omitting when undefined keeps the snapshot stable).
    if (entry.auto_resolved === true) {
      reading.auto_resolved = true;
    }
    // "Work on Board" hotfix slice 1.1a (2026-05-08) — emit board_id when
    // the dispatcher recorded one on the value entry. Omit otherwise so
    // single-board sessions stay byte-identical to pre-hotfix traffic and
    // pre-fix iOS clients (which ignore the field via decodeIfPresent) see
    // no change.
    if (entry.boardId != null) {
      reading.board_id = entry.boardId;
    }
    extracted_readings.push(reading);
  }

  // 2-3. Observations + questions — defensive copies so downstream mutation
  //      cannot retroactively alter the bundled result.
  const result = {
    extracted_readings,
    observations: [...perTurnWrites.observations],
    questions: Array.isArray(legacy.questions) ? [...legacy.questions] : [],
  };

  // 4-6. New Phase 2 slots — OMITTED when empty so iOS decoders unaware of
  //      these keys see byte-identical traffic to today. Swift Codable
  //      ignores unknown keys, but omission keeps session logs clean.
  if (perTurnWrites.cleared.length > 0) {
    result.cleared_readings = [...perTurnWrites.cleared];
  }
  if (perTurnWrites.circuitOps.length > 0) {
    result.circuit_updates = [...perTurnWrites.circuitOps];
  }
  if (perTurnWrites.deletedObservations.length > 0) {
    result.observation_deletions = [...perTurnWrites.deletedObservations];
  }
  // 1a.6 — field_corrected event payloads. Carried on result so the
  // orchestrator (sonnet-stream.js) can iterate after sending the
  // extraction envelope and emit each as a separate WS message with the
  // pinned wire shape from PLAN_v3 §4.5 (type/circuit/field/
  // previous_value/reason). OMITTED when empty so back-compat decoders
  // never see the key.
  if (Array.isArray(perTurnWrites.fieldCorrections) && perTurnWrites.fieldCorrections.length > 0) {
    result.field_corrections = [...perTurnWrites.fieldCorrections];
  }

  // 7. Phase 2 carryover slot — supply / installation / board-level writes
  //    via record_board_reading. Same shape as extracted_readings (field +
  //    value + confidence + source: 'tool_call') but WITHOUT a `circuit`
  //    field — these readings always live at circuits[0] in the snapshot.
  //    Emitting them in a SEPARATE slot (rather than merging into
  //    extracted_readings with circuit:0) makes the Stage 6 wire shape
  //    self-describing — a downstream consumer can tell tool_call board
  //    writes apart from circuit writes without having to inspect every
  //    entry's `circuit` field. The slot comparator (Plan 02-06) projects
  //    legacy's circuit:0 readings into the same comparison Map so
  //    divergence comparison still aligns the two paths.
  //
  //    Map.entries() preserves insertion order — same property the readings
  //    Map relies on for STT-09 same-turn correction.
  if (boardReadings.size > 0) {
    const extracted_board_readings = [];
    for (const [key, entry] of boardReadings) {
      // Slice 1.1c — same key-decoder treatment as the readings Map. Legacy
      // field-only keys decode to boardId=null; new boardId-tagged keys
      // strip the tag so `field` is the bare field name on the wire.
      const { field } = decodeBoardReadingKey(key);
      const reading = {
        field,
        value: entry.value,
        confidence: entry.confidence,
        source: 'tool_call',
      };
      // P3-B — same auto_resolve propagation as extracted_readings above.
      if (entry.auto_resolved === true) {
        reading.auto_resolved = true;
      }
      // "Work on Board" hotfix slice 1.1a — emit board_id so shadow-harness's
      // fold to extracted_readings (with circuit:0) carries the field through
      // to iOS, where applySonnetReadings can land board-level supply on the
      // right BoardInfo via the boardIndex(for:) helper rather than
      // pinning to boards[0].
      if (entry.boardId != null) {
        reading.board_id = entry.boardId;
      }
      extracted_board_readings.push(reading);
    }
    result.extracted_board_readings = extracted_board_readings;
  }

  // 8. Phase 6.0 — multi-board board-ops wire channel (Codex deal-breaker #3).
  //    Append-only Array of discriminated-union ops emitted by Phase 6 board
  //    dispatchers (`add_board` / `select_board` / `mark_distribution_circuit`,
  //    plus any future board-mutation tool). Each entry carries an `op` field
  //    plus the payload the tool dispatcher built.
  //
  //    Emit verbatim (defensive shallow copy so downstream mutation can't
  //    retro-alter the bundled result). OMITTED when empty so pre-Phase-6
  //    traffic — every session today, since no dispatcher writes here yet —
  //    stays byte-identical and existing iOS decoders unaware of the slot
  //    see no change.
  //
  //    boardOps is optional in the input shape because callers building the
  //    accumulator manually (older test fixtures) may pre-date the Phase 6.0
  //    wire-in. createPerTurnWrites() always seeds an empty array.
  if (Array.isArray(perTurnWrites.boardOps) && perTurnWrites.boardOps.length > 0) {
    result.board_ops = perTurnWrites.boardOps.map((op) => ({ ...op }));
  }

  // 9. Stage 6 confirmation read-backs (2026-05-20).
  //    When the client opts in via `confirmations_enabled` on the
  //    transcript message (iOS Voice toggle → sonnet-stream.js:3707 →
  //    runShadowHarness options → here), synthesise brief text-to-speech
  //    read-backs from the per-turn writes. iOS already decodes
  //    `result.confirmations` (DeepgramRecordingViewModel.swift:7334) and
  //    applies its own dedupe/suppression layer; the backend's job is just
  //    to emit a short well-formed array per turn so the iOS speech queue
  //    has something to work with.
  //
  //    Legacy prose-JSON path: when `legacyResultShape.confirmations` is
  //    already populated (shadow mode, prompt-JSON extractor produced
  //    them), preserve those verbatim and skip synthesis — the legacy
  //    output is the authoritative shape there and we don't want to
  //    double-emit. Live mode always has `legacy === null` and synthesis
  //    is the only source.
  //
  //    OMITTED from the result when empty so pre-feature traffic and
  //    sessions where the inspector turned the toggle off stay byte-
  //    identical on the wire.
  if (Array.isArray(legacy.confirmations) && legacy.confirmations.length > 0) {
    result.confirmations = legacy.confirmations.map((c) => ({ ...c }));
  } else if (options.confirmationsEnabled === true) {
    const boardReadings = Array.isArray(result.extracted_board_readings)
      ? result.extracted_board_readings
      : [];
    const confirmations = synthesiseConfirmations(extracted_readings, boardReadings);
    if (confirmations.length > 0) {
      result.confirmations = confirmations;
    }
  }

  return result;
}
