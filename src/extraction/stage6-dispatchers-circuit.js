/**
 * Stage 6 Phase 2 Plan 02-03 — Circuit-facing write dispatchers.
 *
 * WHAT: Real implementations of the four circuit-shaped write tools —
 * record_reading, clear_reading, create_circuit, rename_circuit. Each follows
 * the same five-step pipeline: validate → mutate (via Plan 02-01 atom) → track
 * (perTurnWrites) → log (Plan 02-02 logger) → return envelope.
 *
 * WHY this file is the sole edit target for Plan 02-03 (MAJOR-2 parallelism
 * contract): Plan 02-04 owns the sibling `stage6-dispatchers-observation.js`;
 * the barrel `stage6-dispatchers.js` is append-only until Phase 3. Keeping the
 * circuit dispatchers in a single file lets Plans 02-03 and 02-04 land in
 * parallel with no merge conflict beyond the barrel's re-export manifest
 * (which was finalised in Plan 02-02 Task 4).
 *
 * WHY envelope() is a local helper (not hoisted): per Plan 02-02's scaffold
 * comment, file-isolation trumps micro-DRY during parallel-plan landing. The
 * observation sibling has its own identical helper; that duplication (~5 lines)
 * is the price of preventing a shared-util conflict during Wave 2 merge. If
 * we ever add a 3rd dispatcher file, the helper moves to a shared module.
 *
 * ---------------------------------------------------------------------------
 * INTENTIONAL DIVERGENCE FROM LEGACY (Research §Q4 / OPEN_QUESTIONS.md Q#1)
 * ---------------------------------------------------------------------------
 * `dispatchRecordReading` REJECTS calls for an unknown circuit. The LEGACY
 * path (eicr-extraction-session.js:989, preserved via applyReadingToSnapshot's
 * auto-create behaviour) AUTO-CREATES the bucket silently. This divergence is
 * DELIBERATE — strict-mode forces the model to emit `create_circuit` (or
 * `ask_user`) as a first-class observable signal. Plan 02-06's shadow
 * comparator tags this divergence with `reason: 'dispatcher_strict_mode'`;
 * Phase 7's analyzer MUST filter these rows out of STR-03 divergence-rate
 * calculations.
 * ---------------------------------------------------------------------------
 *
 * Same-turn correction semantics for `perTurnWrites.readings` (MAJOR-1 shape
 * lock from Plan 02-02):
 *   - `readings` is Map<"${field}::${circuit}", {value, confidence, source_turn_id}>.
 *   - Value object MUST NOT carry field/circuit — they live in the key.
 *   - Second record_reading for the same (field,circuit) OVERWRITES the first.
 *   - Subsequent clear_reading for the same (field,circuit) DELETES the Map
 *     entry AND appends to `cleared[]` — otherwise the bundler would report
 *     both a record and a clear for the same slot (contradictory wire).
 *
 * Envelope contract (matches Phase 1's runToolLoop dispatcher signature):
 *   { tool_use_id: string, content: string (JSON), is_error: boolean }
 */

import { createRequire } from 'node:module';
import {
  applyReadingFlagAware,
  clearReadingFlagAware,
  upsertCircuitMetaFlagAware,
  renameCircuitFlagAware,
  deleteCircuitFlagAware,
} from './stage6-snapshot-mutators.js';
import { encodeReadingKey } from './stage6-per-turn-writes.js';
import { getCircuitBucket, listCircuitRefsInBoard } from './stage6-multi-board-shape.js';
import { RING_FIELDS, recordRingContinuityWrite } from './ring-continuity-timeout.js';
import { IR_FIELDS, recordIrWrite } from './insulation-resistance-timeout.js';
import {
  validateRecordReading,
  validateClearReading,
  validateCreateCircuit,
  validateRenameCircuit,
  validateDeleteCircuit,
  validateCalculateZs,
  validateCalculateR1PlusR2,
  validateBoardScope,
} from './stage6-dispatch-validation.js';
import { logToolCall } from './stage6-dispatcher-logger.js';
import { checkForPromptLeak, hashPayload } from './stage6-prompt-leak-filter.js';
import { parseBsCode } from './dialogue-engine/parsers/bs-code.js';

// Field schema is loaded once at module init (same pattern as
// stage6-tool-schemas.js). Used by dispatchSetFieldForAllCircuits to
// validate `field` membership AND value-against-options for select-typed
// fields — defence in depth against off-enum sampling on a tool whose
// blast radius is every circuit at once.
const fieldSchemaRequire = createRequire(import.meta.url);
const FIELD_SCHEMA = fieldSchemaRequire('../../config/field_schema.json');

/**
 * Format a dispatcher return envelope. `content` is JSON-stringified here so
 * each dispatcher can hand back a plain object to this helper and the Phase 1
 * tool_result envelope shape stays consistent across all six dispatchers.
 */
function envelope(tool_use_id, body, is_error) {
  return { tool_use_id, content: JSON.stringify(body), is_error };
}

// ---- record_reading --------------------------------------------------------

/**
 * Validate → applyReadingToSnapshot → perTurnWrites.readings.set → log → envelope.
 *
 * REJECTS unknown-circuit calls (intentional divergence — see file header).
 *
 * @param {{tool_call_id: string, name: string, input: {field: string, circuit: number, value: string, confidence?: number, source_turn_id: string}}} call
 * @param {{session: object, logger: object, turnId: string, perTurnWrites: object, round: number}} ctx
 */
export async function dispatchRecordReading(call, ctx) {
  const { session, logger, turnId, perTurnWrites, round } = ctx;
  const input = call.input;

  const err =
    validateBoardScope(input, session.stateSnapshot) ||
    validateRecordReading(input, session.stateSnapshot);
  if (err) {
    logToolCall(logger, {
      sessionId: session.sessionId,
      turnId,
      tool_use_id: call.tool_call_id,
      tool: 'record_reading',
      round,
      is_error: true,
      outcome: 'rejected',
      validation_error: err,
      input_summary: { field: input.field, circuit: input.circuit },
    });
    return envelope(call.tool_call_id, { ok: false, error: err }, true);
  }

  // 2026-05-24 BS-EN canonicalisation (scenario bs_en_normalisation,
  // prompt-engineering Item 1). Sonnet sometimes emits the schema-canonical
  // form ("BS EN 60898"), sometimes drops the "EN" prefix ("BS 60898"),
  // sometimes emits bare digits ("60898") despite explicit prompt
  // guidance to use the schema-canonical string. The dialogue-engine
  // parseBsCode already knows every reasonable variant + the Levenshtein-1
  // fallback for Deepgram digit drift, so route every ocpd_bs_en /
  // rcd_bs_en write through it and accept the canonical it returns.
  // Pass-through (parseBsCode → null) preserves the raw value so a
  // legitimately new form surfaces as a divergence rather than getting
  // silently coerced to "".
  if (
    typeof input.value === 'string' &&
    (input.field === 'ocpd_bs_en' || input.field === 'rcd_bs_en')
  ) {
    const canonical = parseBsCode(input.value);
    if (canonical) input.value = canonical;
  }

  applyReadingFlagAware(session.stateSnapshot, {
    circuit: input.circuit,
    field: input.field,
    value: input.value,
    boardId: input.board_id,
  });

  // MAJOR-1 shape lock: value object carries ONLY {value, confidence,
  // source_turn_id, auto_resolved?, boardId?} — field/circuit live in the
  // Map key. Bundler (Plan 02-05) splits the key on '::' to reconstruct them.
  //
  // P3-B (2026-04-27): tag synthetic auto-resolve writes so the slot
  // comparator can filter them out and avoid false-positive `extra_in_tool`
  // divergences against shadow mode (where the auto-resolve hook is dead
  // code; createAskDispatcher short-circuits before the resolution path).
  // The synthetic tool_call_id namespace marker '::auto::' is set by
  // createAutoResolveWriteHook in stage6-dispatchers.js.
  //
  // "Work on Board" hotfix slice 1.1a (2026-05-08): carry input.board_id on
  // the value object so the bundler can emit `reading.board_id` on the wire
  // and iOS can route by (boardId, circuitRef) rather than pin to boards[0].
  // OMIT (undefined) for single-board sessions so the bundler can suppress
  // the field on the wire and the wire shape stays byte-identical pre-hotfix.
  const autoResolved = String(call.tool_call_id ?? '').includes('::auto::');
  // Hotfix slice 1.1c — encodeReadingKey embeds boardId in the Map key so
  // cross-board same-(field, circuit) writes in a single tool-loop turn
  // (e.g. set_field_for_all_circuits('*')) don't collide on Map.set's
  // last-write-wins. Legacy keys without the boardId tag still decode to
  // boardId=null in the bundler.
  perTurnWrites.readings.set(encodeReadingKey(input.field, input.circuit, input.board_id), {
    value: input.value,
    confidence: input.confidence ?? 1.0,
    source_turn_id: input.source_turn_id,
    auto_resolved: autoResolved || undefined,
    boardId: input.board_id ?? undefined,
  });

  // Ring continuity tracking — stamp the circuit's last-write timestamp
  // on every record_reading hitting one of the three ring fields. The
  // server-side timeout detector (ring-continuity-timeout.js) reads
  // these timestamps on each user turn to fire ask_user when a partial
  // bucket has gone stale (>60s). Server-driven timeout is needed
  // because Sonnet has no reliable way to track elapsed time across
  // turns and the agentic prompt explicitly delegates timing here.
  if (RING_FIELDS.includes(input.field)) {
    recordRingContinuityWrite(session, input.circuit);
  }
  // Insulation resistance tracking — same pattern. The 60s detector
  // (insulation-resistance-timeout.js) re-asks LL or LE if the bucket
  // has gone stale (1 of 2 filled, >60s since last write) regardless
  // of whether the IR script ever ran for this circuit.
  if (IR_FIELDS.includes(input.field)) {
    recordIrWrite(session, input.circuit);
  }

  logToolCall(logger, {
    sessionId: session.sessionId,
    turnId,
    tool_use_id: call.tool_call_id,
    tool: 'record_reading',
    round,
    is_error: false,
    outcome: 'ok',
    validation_error: null,
    input_summary: { field: input.field, circuit: input.circuit },
  });
  return envelope(call.tool_call_id, { ok: true }, false);
}

// ---- clear_reading ---------------------------------------------------------

/**
 * Validate → clearReadingInSnapshot → if cleared: perTurnWrites.cleared.push +
 * perTurnWrites.readings.delete (same-turn correction) → log → envelope.
 *
 * If the field is not currently set on the circuit, emits a NOOP envelope
 * (`{ok:true, noop:true, reason:'field_not_set'}`) with outcome:'noop' in the
 * log row. This keeps the model out of retry loops (Research §Q8).
 *
 * @param {{tool_call_id: string, name: string, input: {field: string, circuit: number, reason: string}}} call
 * @param {{session: object, logger: object, turnId: string, perTurnWrites: object, round: number}} ctx
 */
export async function dispatchClearReading(call, ctx) {
  const { session, logger, turnId, perTurnWrites, round } = ctx;
  const input = call.input;

  const err =
    validateBoardScope(input, session.stateSnapshot) ||
    validateClearReading(input, session.stateSnapshot);
  if (err) {
    logToolCall(logger, {
      sessionId: session.sessionId,
      turnId,
      tool_use_id: call.tool_call_id,
      tool: 'clear_reading',
      round,
      is_error: true,
      outcome: 'rejected',
      validation_error: err,
      input_summary: { field: input.field, circuit: input.circuit, reason: input.reason },
    });
    return envelope(call.tool_call_id, { ok: false, error: err }, true);
  }

  const { cleared, previousValue } = clearReadingFlagAware(session.stateSnapshot, {
    circuit: input.circuit,
    field: input.field,
    boardId: input.board_id,
  });

  if (!cleared) {
    // Noop — field was not set. Log outcome:'noop'; do NOT push to cleared[].
    logToolCall(logger, {
      sessionId: session.sessionId,
      turnId,
      tool_use_id: call.tool_call_id,
      tool: 'clear_reading',
      round,
      is_error: false,
      outcome: 'noop',
      validation_error: null,
      input_summary: { field: input.field, circuit: input.circuit, reason: input.reason },
    });
    return envelope(call.tool_call_id, { ok: true, noop: true, reason: 'field_not_set' }, false);
  }

  // Same-turn correction: if a record_reading for this slot was pushed earlier
  // in THIS turn, remove it from the Map so the bundler doesn't report both a
  // record and a clear for the same slot (that would be contradictory wire).
  // Slice 1.1c — same boardId-bearing key shape as the record_reading set
  // call so the delete targets the right (field, circuit, board) tuple.
  perTurnWrites.readings.delete(encodeReadingKey(input.field, input.circuit, input.board_id));
  perTurnWrites.cleared.push({
    field: input.field,
    circuit: input.circuit,
    reason: input.reason,
  });
  // 1a.6: enqueue a field_corrected WS event so iOS clients with the
  // Stage 1b handler can patch local state when Sonnet clears a value.
  // Wire shape pinned in PLAN_v3 §4.5 (snake_case keys + closed reason
  // enum). board_id surfaced for multi-board sessions; null otherwise.
  perTurnWrites.fieldCorrections.push({
    type: 'field_corrected',
    circuit: input.circuit,
    field: input.field,
    previous_value: previousValue,
    reason: 'clear_reading',
    board_id: input.board_id ?? null,
  });

  logToolCall(logger, {
    sessionId: session.sessionId,
    turnId,
    tool_use_id: call.tool_call_id,
    tool: 'clear_reading',
    round,
    is_error: false,
    outcome: 'ok',
    validation_error: null,
    input_summary: { field: input.field, circuit: input.circuit, reason: input.reason },
  });
  return envelope(call.tool_call_id, { ok: true }, false);
}

// ---- create_circuit --------------------------------------------------------

/**
 * Validate (duplicate rejection + numeric meta types) → upsertCircuitMeta →
 * perTurnWrites.circuitOps.push({op:'create'}) → log → envelope.
 *
 * Rejects duplicate `circuit_ref` with `{code: 'circuit_already_exists'}`.
 *
 * @param {{tool_call_id: string, name: string, input: {circuit_ref: number, designation?: string|null, phase?: string|null, rating_amps?: number|null, cable_csa_mm2?: number|null}}} call
 * @param {{session: object, logger: object, turnId: string, perTurnWrites: object, round: number}} ctx
 */
export async function dispatchCreateCircuit(call, ctx) {
  const { session, logger, turnId, perTurnWrites, round } = ctx;
  const input = call.input;

  const err =
    validateBoardScope(input, session.stateSnapshot) ||
    validateCreateCircuit(input, session.stateSnapshot);
  if (err) {
    logToolCall(logger, {
      sessionId: session.sessionId,
      turnId,
      tool_use_id: call.tool_call_id,
      tool: 'create_circuit',
      round,
      is_error: true,
      outcome: 'rejected',
      validation_error: err,
      // PII: circuit_ref only (phase is an enum — safe). NEVER log `designation`
      // (free-text inspector-authored name that may carry PII).
      input_summary: { circuit_ref: input.circuit_ref },
    });
    return envelope(call.tool_call_id, { ok: false, error: err }, true);
  }

  // Plan 04-26 Layer 2: scan designation for system-prompt leak content.
  //
  // Scope: `designation` ONLY (when non-null). Other meta fields (phase,
  // rating_amps, cable_csa_mm2) are constrained types (enum / number)
  // and not plausible leak surfaces.
  //
  // On leak: REJECT the tool call (is_error:true, prompt_leak_in_designation).
  // Certificate correctness: the designation becomes the circuit's column
  // header in the PDF. Substituting a refusal string there would corrupt
  // the cert. Rejection + is_error:true signals the model to retry with
  // a real inspection-domain name.
  if (typeof input.designation === 'string' && input.designation.length > 0) {
    const desLeak = checkForPromptLeak(input.designation, { field: 'designation' });
    if (!desLeak.safe) {
      // r20-#2 redacted telemetry.
      logger.warn('stage6.prompt_leak_blocked', {
        tool: 'create_circuit',
        tool_call_id: call.tool_call_id,
        sessionId: session.sessionId,
        turnId,
        filter_reason: desLeak.reason,
        field: 'designation',
        length: input.designation.length,
        hash: hashPayload(input.designation),
      });
      logToolCall(logger, {
        sessionId: session.sessionId,
        turnId,
        tool_use_id: call.tool_call_id,
        tool: 'create_circuit',
        round,
        is_error: true,
        outcome: 'rejected',
        validation_error: 'prompt_leak_in_designation',
        // PII: circuit_ref only. Never log designation.
        input_summary: { circuit_ref: input.circuit_ref },
      });
      return envelope(
        call.tool_call_id,
        {
          ok: false,
          error: { code: 'prompt_leak_in_designation', reason: desLeak.reason },
        },
        true
      );
    }
  }

  upsertCircuitMetaFlagAware(session.stateSnapshot, {
    circuit_ref: input.circuit_ref,
    designation: input.designation,
    phase: input.phase,
    rating_amps: input.rating_amps,
    cable_csa_mm2: input.cable_csa_mm2,
    boardId: input.board_id,
  });

  perTurnWrites.circuitOps.push({
    op: 'create',
    circuit_ref: input.circuit_ref,
    // "Work on Board" hotfix slice 1.1a — circuit_updates wire shape carries
    // board_id so the iOS apply path (which converts shadow-harness's legacy-
    // shape delete projection into a bucket lookup) routes the new bucket to
    // the right board. Omit-when-undefined preserves byte-identical traffic
    // for single-board sessions.
    ...(input.board_id != null ? { board_id: input.board_id } : {}),
    meta: {
      designation: input.designation ?? null,
      phase: input.phase ?? null,
      rating_amps: input.rating_amps ?? null,
      cable_csa_mm2: input.cable_csa_mm2 ?? null,
    },
  });

  // Mark the new circuit as "recent" so its full bucket (including the
  // designation we just wrote) renders in the compact snapshot on the next
  // turn instead of being elided to "N earlier circuits stored server-side".
  // Without this, tool-loop-created circuits look nameless to Sonnet on the
  // very next utterance — exactly the prod 286D500D-2026-05-24 symptom:
  // create_circuit(2) succeeds, then "Zs for upstairs lighting" produces
  // ambiguous_circuit because c2's designation never reached the model.
  // Mirrors the recency push that _seedStateFromJobState (line 1125) and
  // applyReadingFlagAware (line 2106) already do.
  if (Array.isArray(session.recentCircuitOrder) && input.circuit_ref !== 0) {
    const idx = session.recentCircuitOrder.indexOf(input.circuit_ref);
    if (idx !== -1) session.recentCircuitOrder.splice(idx, 1);
    session.recentCircuitOrder.push(input.circuit_ref);
  }

  logToolCall(logger, {
    sessionId: session.sessionId,
    turnId,
    tool_use_id: call.tool_call_id,
    tool: 'create_circuit',
    round,
    is_error: false,
    outcome: 'ok',
    validation_error: null,
    input_summary: { circuit_ref: input.circuit_ref, phase: input.phase ?? null },
  });
  return envelope(call.tool_call_id, { ok: true }, false);
}

// ---- rename_circuit --------------------------------------------------------

/**
 * Validate (source_not_found / target_exists / numeric meta types) →
 * idempotent noop (if from_ref === circuit_ref AND no meta supplied) →
 * renameCircuit atom (rekey when from_ref !== circuit_ref) → optional
 * upsertCircuitMeta (if any meta field non-null) → perTurnWrites.circuitOps.push
 * ({op:'rename'}) → log → envelope.
 *
 * Phase-1-carryover contract (OPEN_QUESTIONS.md Q#3): `from_ref` is schema-
 * required (Plan 02-01 closed this). Validator rejects absent-source /
 * target-collision BEFORE mutation. The defensive throw on
 * `renameResult.ok === false` below guards against a hypothetical state
 * race between validate and mutate — under current single-threaded async
 * execution this is unreachable, but the assertion makes state corruption
 * loud rather than silent if a future refactor introduces concurrency.
 *
 * @param {{tool_call_id: string, name: string, input: {from_ref: number, circuit_ref: number, designation?: string|null, phase?: string|null, rating_amps?: number|null, cable_csa_mm2?: number|null}}} call
 * @param {{session: object, logger: object, turnId: string, perTurnWrites: object, round: number}} ctx
 */
export async function dispatchRenameCircuit(call, ctx) {
  const { session, logger, turnId, perTurnWrites, round } = ctx;
  const input = call.input;

  const err =
    validateBoardScope(input, session.stateSnapshot) ||
    validateRenameCircuit(input, session.stateSnapshot);
  if (err) {
    logToolCall(logger, {
      sessionId: session.sessionId,
      turnId,
      tool_use_id: call.tool_call_id,
      tool: 'rename_circuit',
      round,
      is_error: true,
      outcome: 'rejected',
      validation_error: err,
      input_summary: { from_ref: input.from_ref, circuit_ref: input.circuit_ref },
    });
    return envelope(call.tool_call_id, { ok: false, error: err }, true);
  }

  // Plan 04-26 Layer 2: scan designation for system-prompt leak content.
  // Same rationale as dispatchCreateCircuit — reject rather than
  // substitute; certificate correctness trumps retry simplicity.
  if (typeof input.designation === 'string' && input.designation.length > 0) {
    const desLeak = checkForPromptLeak(input.designation, { field: 'designation' });
    if (!desLeak.safe) {
      // r20-#2 redacted telemetry.
      logger.warn('stage6.prompt_leak_blocked', {
        tool: 'rename_circuit',
        tool_call_id: call.tool_call_id,
        sessionId: session.sessionId,
        turnId,
        filter_reason: desLeak.reason,
        field: 'designation',
        length: input.designation.length,
        hash: hashPayload(input.designation),
      });
      logToolCall(logger, {
        sessionId: session.sessionId,
        turnId,
        tool_use_id: call.tool_call_id,
        tool: 'rename_circuit',
        round,
        is_error: true,
        outcome: 'rejected',
        validation_error: 'prompt_leak_in_designation',
        input_summary: { from_ref: input.from_ref, circuit_ref: input.circuit_ref },
      });
      return envelope(
        call.tool_call_id,
        {
          ok: false,
          error: { code: 'prompt_leak_in_designation', reason: desLeak.reason },
        },
        true
      );
    }
  }

  const metaSupplied =
    input.designation != null ||
    input.phase != null ||
    input.rating_amps != null ||
    input.cable_csa_mm2 != null;

  // Idempotent noop: rename-to-same with no meta supplied.
  if (input.from_ref === input.circuit_ref && !metaSupplied) {
    logToolCall(logger, {
      sessionId: session.sessionId,
      turnId,
      tool_use_id: call.tool_call_id,
      tool: 'rename_circuit',
      round,
      is_error: false,
      outcome: 'noop',
      validation_error: null,
      input_summary: { from_ref: input.from_ref, circuit_ref: input.circuit_ref },
    });
    return envelope(call.tool_call_id, { ok: true, noop: true, reason: 'rename_to_same' }, false);
  }

  // Rekey when from_ref !== circuit_ref. The atom is a pure noop when they
  // are equal, so the branch is safe to take unconditionally.
  const renameResult = renameCircuitFlagAware(session.stateSnapshot, {
    from_ref: input.from_ref,
    circuit_ref: input.circuit_ref,
    boardId: input.board_id,
  });
  if (!renameResult.ok) {
    // Defensive — validator already vetted these inputs. If this fires, a
    // state race happened between validate and mutate.
    throw new Error(`rename invariant violated: ${renameResult.error?.code}`);
  }

  if (metaSupplied) {
    upsertCircuitMetaFlagAware(session.stateSnapshot, {
      circuit_ref: input.circuit_ref,
      designation: input.designation,
      phase: input.phase,
      rating_amps: input.rating_amps,
      cable_csa_mm2: input.cable_csa_mm2,
      boardId: input.board_id,
    });
  }

  perTurnWrites.circuitOps.push({
    op: 'rename',
    from_ref: input.from_ref,
    circuit_ref: input.circuit_ref,
    // "Work on Board" hotfix slice 1.1a — see dispatchCreateCircuit for
    // rationale. Rename ops route to the target board's bucket on iOS.
    ...(input.board_id != null ? { board_id: input.board_id } : {}),
    meta: {
      designation: input.designation ?? null,
      phase: input.phase ?? null,
      rating_amps: input.rating_amps ?? null,
      cable_csa_mm2: input.cable_csa_mm2 ?? null,
    },
  });

  // Mark the (renamed) circuit as "recent" so its bucket renders in the
  // compact snapshot on the next turn — same rationale as
  // dispatchCreateCircuit. Drop from_ref's slot first (it no longer
  // exists in the snapshot post-rename) before pushing the new ref.
  if (Array.isArray(session.recentCircuitOrder)) {
    const fromIdx = session.recentCircuitOrder.indexOf(input.from_ref);
    if (fromIdx !== -1) session.recentCircuitOrder.splice(fromIdx, 1);
    const toIdx = session.recentCircuitOrder.indexOf(input.circuit_ref);
    if (toIdx !== -1) session.recentCircuitOrder.splice(toIdx, 1);
    if (input.circuit_ref !== 0) session.recentCircuitOrder.push(input.circuit_ref);
  }

  logToolCall(logger, {
    sessionId: session.sessionId,
    turnId,
    tool_use_id: call.tool_call_id,
    tool: 'rename_circuit',
    round,
    is_error: false,
    outcome: 'ok',
    validation_error: null,
    input_summary: { from_ref: input.from_ref, circuit_ref: input.circuit_ref },
  });
  return envelope(call.tool_call_id, { ok: true }, false);
}

// ---- delete_circuit --------------------------------------------------------

/**
 * Validate (circuit_ref ≥ 1) → deleteCircuit atom (idempotent on absent ref) →
 * perTurnWrites.circuitOps.push({op:'delete'}) → log → envelope.
 *
 * Idempotency: an absent circuit_ref returns {ok:true, deleted:false} with
 * outcome:'noop' in the log, mirroring delete_observation. The op is still
 * pushed to circuitOps so the wire reflects the inspector's intent — iOS can
 * decide whether to surface a "circuit was already gone" toast or silent
 * success based on the `deleted` flag in the envelope.
 *
 * Why we still push circuitOps on noop: the shadow-harness translation layer
 * (stage6-shadow-harness.js, deleteCircuit translation block added in this
 * commit) emits the legacy iOS shape {circuit, designation, action:'delete'}
 * for every delete op — without the push, an idempotent re-delete from a
 * voice retry ("delete circuit 2... delete circuit 2") would land on iOS
 * silently and the user would have no visual confirmation the second
 * attempt did anything. Sending the op through tells iOS to re-run its own
 * idempotent removal; iOS already short-circuits if the circuit is absent.
 *
 * @param {{tool_call_id: string, name: string, input: {circuit_ref: number}}} call
 * @param {{session: object, logger: object, turnId: string, perTurnWrites: object, round: number}} ctx
 */
export async function dispatchDeleteCircuit(call, ctx) {
  const { session, logger, turnId, perTurnWrites, round } = ctx;
  const input = call.input;

  const err =
    validateBoardScope(input, session.stateSnapshot) ||
    validateDeleteCircuit(input, session.stateSnapshot);
  if (err) {
    logToolCall(logger, {
      sessionId: session.sessionId,
      turnId,
      tool_use_id: call.tool_call_id,
      tool: 'delete_circuit',
      round,
      is_error: true,
      outcome: 'rejected',
      validation_error: err,
      input_summary: { circuit_ref: input.circuit_ref },
    });
    return envelope(call.tool_call_id, { ok: false, error: err }, true);
  }

  const { deleted } = deleteCircuitFlagAware(session.stateSnapshot, {
    circuit_ref: input.circuit_ref,
    boardId: input.board_id,
  });

  perTurnWrites.circuitOps.push({
    op: 'delete',
    circuit_ref: input.circuit_ref,
    // "Work on Board" hotfix slice 1.1a — board_id flows through to iOS so
    // the legacy-shape delete projection (shadow-harness :436-447) can route
    // to the right board's bucket on apply.
    ...(input.board_id != null ? { board_id: input.board_id } : {}),
  });

  logToolCall(logger, {
    sessionId: session.sessionId,
    turnId,
    tool_use_id: call.tool_call_id,
    tool: 'delete_circuit',
    round,
    is_error: false,
    outcome: deleted ? 'ok' : 'noop',
    validation_error: null,
    input_summary: { circuit_ref: input.circuit_ref },
  });
  return envelope(call.tool_call_id, { ok: true, deleted }, false);
}

// ---- calculate_zs / calculate_r1_plus_r2 -----------------------------------
//
// Selector helpers shared by both calculate tools.
// The validators (validateCalculateSelector) already guarantee exactly one
// selector is set, so these helpers are total functions over valid inputs.

/**
 * Resolve the input selector to a sorted, deduped list of circuit refs the
 * dispatcher should iterate. NOT validated here (validator ran first); just
 * the projection from input shape → ordered ref list.
 *
 * @param {{circuit_ref?: number|null, circuit_refs?: number[]|null, all?: boolean}} input
 * @param {{circuits: Object}} snapshot
 * @returns {number[]}
 */
function selectorRefs(input, snapshot) {
  if (Number.isInteger(input.circuit_ref) && input.circuit_ref >= 1) {
    return [input.circuit_ref];
  }
  if (Array.isArray(input.circuit_refs) && input.circuit_refs.length > 0) {
    return [...new Set(input.circuit_refs.filter((r) => Number.isInteger(r) && r >= 1))].sort(
      (a, b) => a - b
    );
  }
  // all: walk every non-supply circuit in the snapshot. Under flag-on, this
  // walks composite-key buckets scoped to (input.board_id ?? currentBoardId);
  // under flag-off, numeric keys >= 1 (legacy behaviour, board_id ignored).
  // Phase 6.5 — board_id thread-through.
  return listCircuitRefsInBoard(snapshot, input.board_id);
}

/**
 * Parse a snapshot value to a finite number. Returns null if absent, empty,
 * or unparseable (so the calc dispatcher treats those circuits as "missing
 * input" rather than crashing on string concat / NaN arithmetic).
 *
 * Why a local helper: snapshot values are stored as strings (the legacy
 * write path) or numbers (some seeded paths), and Number('') === 0 would
 * silently corrupt downstream sums. This helper enforces null on anything
 * that isn't a finite number after coercion.
 */
function parseFiniteNumber(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Apply a calculated reading to the snapshot AND perTurnWrites.readings so it
 * flows through the standard extracted_readings wire path to iOS. Mirrors the
 * record_reading dispatcher's writes, with two differences:
 *   1. confidence is fixed at 1.0 (a derived value is fully self-consistent).
 *   2. source_turn_id carries a synthetic '::calc::<tool>' marker so log
 *      analysis can split server-derived writes from Sonnet-direct writes.
 */
function applyCalculatedReading(session, perTurnWrites, { circuit, field, value, tool, boardId }) {
  // Calculated writes (Zs from Ze + R1+R2, R1+R2 from Zs - Ze, etc.) flow
  // through the same flag-aware mutator as record_reading so the calc
  // outputs land in the SAME bucket shape as the source readings — no
  // mismatch between manually-recorded inputs and server-derived outputs.
  // Phase 6.5: thread boardId so explicit input.board_id on calculate_zs /
  // calculate_r1_plus_r2 routes the WRITE to the right composite-key bucket
  // (the SELECTOR already routes via listCircuitRefsInBoard + getCircuitBucket).
  applyReadingFlagAware(session.stateSnapshot, { circuit, field, value, boardId });
  // "Work on Board" hotfix slice 1.1a — propagate boardId on the value
  // entry so the bundler emits `reading.board_id` on the wire and iOS
  // routes calc-derived readings to the right board.
  // Slice 1.1c — encode boardId in the Map key so a cross-board calc sweep
  // (`board_id: '*'` is not yet supported on the calc tools, but the
  // pattern is forward-safe) doesn't collide on (field, circuit) key.
  perTurnWrites.readings.set(encodeReadingKey(field, circuit, boardId), {
    value,
    confidence: 1.0,
    source_turn_id: `::calc::${tool}`,
    boardId: boardId ?? undefined,
  });
}

/**
 * dispatchCalculateZs — Zs = Ze + (R1+R2) per circuit.
 *
 * Skip rules (per-circuit, no error envelope — circuits drop into the
 * `skipped` array of the tool result so Sonnet can read back what was and
 * wasn't computed):
 *   - reason='already_set'  : measured_zs_ohm exists (NEVER overwrite).
 *   - reason='no_ze'        : circuits[0].earth_loop_impedance_ze is missing.
 *   - reason='no_r1_r2'     : the circuit has no r1_r2_ohm value.
 *   - reason='circuit_missing' : the ref doesn't exist in the schedule
 *                                 (only possible via circuit_ref / circuit_refs;
 *                                 'all' walks existing keys).
 */
export async function dispatchCalculateZs(call, ctx) {
  const { session, logger, turnId, perTurnWrites, round } = ctx;
  const input = call.input;

  const err = validateCalculateZs(input, session.stateSnapshot);
  if (err) {
    logToolCall(logger, {
      sessionId: session.sessionId,
      turnId,
      tool_use_id: call.tool_call_id,
      tool: 'calculate_zs',
      round,
      is_error: true,
      outcome: 'rejected',
      validation_error: err,
      input_summary: {},
    });
    return envelope(call.tool_call_id, { ok: false, error: err }, true);
  }

  const ze = parseFiniteNumber(session.stateSnapshot.circuits?.[0]?.earth_loop_impedance_ze);
  const refs = selectorRefs(input, session.stateSnapshot);

  const computed = [];
  const skipped = [];

  for (const ref of refs) {
    const bucket = getCircuitBucket(session.stateSnapshot, ref, input.board_id);
    if (!bucket) {
      skipped.push({ circuit_ref: ref, reason: 'circuit_missing' });
      continue;
    }
    if (bucket.measured_zs_ohm != null && bucket.measured_zs_ohm !== '') {
      skipped.push({ circuit_ref: ref, reason: 'already_set' });
      continue;
    }
    if (ze == null) {
      skipped.push({ circuit_ref: ref, reason: 'no_ze' });
      continue;
    }
    const r1r2 = parseFiniteNumber(bucket.r1_r2_ohm);
    if (r1r2 == null) {
      skipped.push({ circuit_ref: ref, reason: 'no_r1_r2' });
      continue;
    }
    // Round to 2 dp — same precision as a typical multifunction tester. Stored
    // as a string to match the legacy write shape (every reading on the wire
    // is a string; the iOS decoder + PDF generator both expect strings).
    const value = (Math.round((ze + r1r2) * 100) / 100).toFixed(2);
    applyCalculatedReading(session, perTurnWrites, {
      circuit: ref,
      field: 'measured_zs_ohm',
      value,
      tool: 'calculate_zs',
      boardId: input.board_id,
    });
    computed.push({ circuit_ref: ref, field: 'measured_zs_ohm', value });
  }

  logToolCall(logger, {
    sessionId: session.sessionId,
    turnId,
    tool_use_id: call.tool_call_id,
    tool: 'calculate_zs',
    round,
    is_error: false,
    outcome: computed.length > 0 ? 'ok' : 'noop',
    validation_error: null,
    input_summary: {
      selector: Number.isInteger(input.circuit_ref)
        ? 'ref'
        : Array.isArray(input.circuit_refs) && input.circuit_refs.length > 0
          ? 'refs'
          : 'all',
      computed_count: computed.length,
      skipped_count: skipped.length,
    },
  });
  return envelope(call.tool_call_id, { ok: true, computed, skipped }, false);
}

/**
 * dispatchCalculateR1PlusR2 — r1_r2_ohm via one of two methods.
 *   method='zs_minus_ze'    → r1_r2 = measured_zs_ohm - Ze
 *   method='ring_continuity' → r1_r2 = (ring_r1_ohm + ring_r2_ohm) / 4
 *
 * Same skip semantics as calculate_zs (per-circuit, structured `skipped`
 * array, no errors). Method-specific skip reasons:
 *   zs_minus_ze:
 *     - reason='no_zs'     : measured_zs_ohm missing on this circuit.
 *     - reason='no_ze'     : board-level Ze missing.
 *   ring_continuity:
 *     - reason='no_ring_r1' : ring_r1_ohm missing on this circuit.
 *     - reason='no_ring_r2' : ring_r2_ohm missing on this circuit.
 * Common skips: 'circuit_missing', 'already_set'.
 */
export async function dispatchCalculateR1PlusR2(call, ctx) {
  const { session, logger, turnId, perTurnWrites, round } = ctx;
  const input = call.input;

  const err = validateCalculateR1PlusR2(input, session.stateSnapshot);
  if (err) {
    logToolCall(logger, {
      sessionId: session.sessionId,
      turnId,
      tool_use_id: call.tool_call_id,
      tool: 'calculate_r1_plus_r2',
      round,
      is_error: true,
      outcome: 'rejected',
      validation_error: err,
      input_summary: { method: input.method },
    });
    return envelope(call.tool_call_id, { ok: false, error: err }, true);
  }

  const ze = parseFiniteNumber(session.stateSnapshot.circuits?.[0]?.earth_loop_impedance_ze);
  const refs = selectorRefs(input, session.stateSnapshot);
  const method = input.method;

  const computed = [];
  const skipped = [];

  for (const ref of refs) {
    const bucket = getCircuitBucket(session.stateSnapshot, ref, input.board_id);
    if (!bucket) {
      skipped.push({ circuit_ref: ref, reason: 'circuit_missing' });
      continue;
    }
    if (bucket.r1_r2_ohm != null && bucket.r1_r2_ohm !== '') {
      skipped.push({ circuit_ref: ref, reason: 'already_set' });
      continue;
    }

    let value = null;
    if (method === 'zs_minus_ze') {
      const zs = parseFiniteNumber(bucket.measured_zs_ohm);
      if (zs == null) {
        skipped.push({ circuit_ref: ref, reason: 'no_zs' });
        continue;
      }
      if (ze == null) {
        skipped.push({ circuit_ref: ref, reason: 'no_ze' });
        continue;
      }
      const raw = zs - ze;
      // Defensive: a Zs measurement smaller than Ze yields a negative R1+R2,
      // which is physically impossible. Clamp at 0 and flag in the skip list
      // so the inspector sees something happened rather than a silent
      // "calculated 0.00 ohms" — that's almost certainly a meter typo and
      // they should re-measure.
      if (raw < 0) {
        skipped.push({ circuit_ref: ref, reason: 'zs_below_ze' });
        continue;
      }
      value = (Math.round(raw * 100) / 100).toFixed(2);
    } else {
      // method === 'ring_continuity' (validator already enforced enum)
      const r1 = parseFiniteNumber(bucket.ring_r1_ohm);
      if (r1 == null) {
        skipped.push({ circuit_ref: ref, reason: 'no_ring_r1' });
        continue;
      }
      const r2 = parseFiniteNumber(bucket.ring_r2_ohm);
      if (r2 == null) {
        skipped.push({ circuit_ref: ref, reason: 'no_ring_r2' });
        continue;
      }
      value = (Math.round(((r1 + r2) / 4) * 100) / 100).toFixed(2);
    }

    applyCalculatedReading(session, perTurnWrites, {
      circuit: ref,
      field: 'r1_r2_ohm',
      value,
      tool: 'calculate_r1_plus_r2',
      boardId: input.board_id,
    });
    computed.push({ circuit_ref: ref, field: 'r1_r2_ohm', value, method });
  }

  logToolCall(logger, {
    sessionId: session.sessionId,
    turnId,
    tool_use_id: call.tool_call_id,
    tool: 'calculate_r1_plus_r2',
    round,
    is_error: false,
    outcome: computed.length > 0 ? 'ok' : 'noop',
    validation_error: null,
    input_summary: {
      method: input.method,
      selector: Number.isInteger(input.circuit_ref)
        ? 'ref'
        : Array.isArray(input.circuit_refs) && input.circuit_refs.length > 0
          ? 'refs'
          : 'all',
      computed_count: computed.length,
      skipped_count: skipped.length,
    },
  });
  return envelope(call.tool_call_id, { ok: true, computed, skipped }, false);
}

// ---- set_field_for_all_circuits -------------------------------------------

/**
 * dispatchSetFieldForAllCircuits — Bug A from session DC946608 (8 Branagh Ct,
 * 2026-05-06). Replaces the model's 14-tool-call burst pattern (which Sonnet
 * silently truncated to 7 in production) with one server-iterated tool call.
 *
 * Validation:
 *   - field MUST be a known circuit_fields key (CIRCUIT_FIELD_ENUM membership).
 *   - value MUST be a non-null string (record_reading's contract — empty is
 *     allowed: that's how Sonnet writes a clear-equivalent here).
 *   - confidence MUST be a finite number in [0, 1] (mirrors record_reading).
 *   - source_turn_id MUST be a non-empty string.
 *   - scope MUST be one of {'non_spare', 'all', 'rcd_protected_only'} or
 *     omitted (default 'non_spare').
 *
 * Execution:
 *   - Walks every non-supply circuit (circuit_ref >= 1) in
 *     session.stateSnapshot.circuits.
 *   - Filters by scope: 'non_spare' drops circuits whose designation contains
 *     "spare" (case-insensitive); 'rcd_protected_only' keeps only circuits
 *     with any of rcd_bs_en / rcd_type / rcd_operating_current_ma populated;
 *     'all' is the no-filter passthrough.
 *   - Applies field=value via applyReadingToSnapshot + perTurnWrites.readings,
 *     same path as dispatchRecordReading. RING / IR write tracking is NOT
 *     fired — bulk fills aren't live test entries, and stamping every circuit
 *     with the same timestamp would poison the per-circuit staleness detectors.
 *
 * Envelope:
 *   { ok: true, applied: [{circuit, field, value}], skipped: [{circuit_ref, reason}] }
 *   where `reason` is 'spare_circuit' | 'no_rcd' depending on the filter.
 *
 * Mirrors dispatchCalculateZs's per-circuit applied/skipped breakdown so
 * Sonnet can read back exactly what was and wasn't written without a
 * round-trip.
 */
export async function dispatchSetFieldForAllCircuits(call, ctx) {
  const { session, logger, turnId, perTurnWrites, round } = ctx;
  const input = call.input ?? {};

  const err = validateSetFieldForAllCircuits(input);
  if (err) {
    logToolCall(logger, {
      sessionId: session.sessionId,
      turnId,
      tool_use_id: call.tool_call_id,
      tool: 'set_field_for_all_circuits',
      round,
      is_error: true,
      outcome: 'rejected',
      validation_error: err,
      input_summary: { field: input.field, scope: input.scope ?? 'non_spare' },
    });
    return envelope(call.tool_call_id, { ok: false, error: err }, true);
  }

  const scope = input.scope ?? 'non_spare';

  // 2026-05-07 Phase 6.5 — board_id thread-through with `'*'` cross-board sweep.
  //
  // Resolve the iteration plan: a list of {boardId, refs[]} tuples.
  //   - input.board_id === '*' → every board on the snapshot, scoped via
  //     listCircuitRefsInBoard per board. Cross-board sweep is the locked
  //     S5 decision from the multi-board sprint PLAN.md self-review:
  //     default current-board-only, explicit '*' to opt into cross-board.
  //   - input.board_id is a specific id → that board only.
  //   - input.board_id omitted → default to currentBoardId via listCircuitRefsInBoard's
  //     own fallback (preserves pre-Phase-6 behaviour exactly).
  //
  // Under flag-off, every board collapses to the legacy numeric-key namespace
  // because listCircuitRefsInBoard ignores the boardId arg. So '*' is a no-op
  // deviation from the unscoped default — same iteration shape, same writes.
  const snapshot = session.stateSnapshot;
  const iterationPlan =
    input.board_id === '*'
      ? (snapshot.boards ?? []).map((b) => ({
          boardId: b?.id,
          refs: listCircuitRefsInBoard(snapshot, b?.id),
        }))
      : [{ boardId: input.board_id, refs: listCircuitRefsInBoard(snapshot, input.board_id) }];

  const applied = [];
  const skipped = [];
  for (const { boardId, refs } of iterationPlan) {
    for (const ref of refs) {
      const bucket = getCircuitBucket(snapshot, ref, boardId);
      if (!bucket) continue;
      if (scope === 'non_spare') {
        // Two ways a circuit reads as "spare":
        //   (a) the designation literally contains the word "spare" — but
        //       matched as a WHOLE WORD, not a substring. The previous
        //       `.includes('spare')` falsely flagged "non-spare" (rare in
        //       practice but a real correctness bug). \bspare\b avoids that.
        //   (b) the designation is empty / null / whitespace — blank-row
        //       circuits in the schedule are spares by convention (the
        //       inspector hasn't named them because there's nothing to
        //       inspect). The previous filter only caught (a) and would
        //       have applied the bulk write to every blank slot — a real
        //       data-quality bug for any real-world dual-RCD board where
        //       trailing slots are reserved for future use.
        // The negative lookbehind `(?<!-)` rejects compound forms like
        // "non-spare" / "anti-spare" — \b alone treats the hyphen as a word
        // boundary and would falsely flag those as spares. The lookahead
        // `\b` after `spare` is symmetric in spirit but we don't need a
        // mirror lookahead because trailing hyphens on "spare-anything"
        // ARE genuinely spares (e.g. "spare-RCBO"). Asymmetric on purpose.
        // Belt-and-braces: canonical first, legacy fallback for snapshots
        // hydrated from pre-fix tool-loop creates. See stage6-snapshot-
        // mutators.js comment.
        const designation = String(bucket.circuit_designation ?? bucket.designation ?? '').trim();
        if (designation === '' || /(?<!-)\bspare\b/i.test(designation)) {
          skipped.push({ circuit_ref: ref, reason: 'spare_circuit' });
          continue;
        }
      } else if (scope === 'rcd_protected_only') {
        // rcd_operating_current_ma is DELIBERATELY excluded from the hasRcd
        // check: field_schema.json:166 declares its default as "30", which
        // means non-RCD circuits inherit "30" the moment any code reads
        // through the default path. Including it would tag every circuit
        // in the snapshot as RCD-protected and the filter would do nothing.
        // Verified against session DC946608's snapshot — every circuit had
        // rcd_operating_current_ma="30" regardless of actual RCD bank
        // membership.
        const hasRcd =
          (bucket.rcd_bs_en && bucket.rcd_bs_en !== '') ||
          (bucket.rcd_type && bucket.rcd_type !== '');
        if (!hasRcd) {
          skipped.push({ circuit_ref: ref, reason: 'no_rcd' });
          continue;
        }
      }
      // Phase 6.5 — thread boardId so the flag-aware mutator writes to the
      // correct composite-key bucket (under flag-on) or the legacy numeric
      // bucket (under flag-off, where boardId is ignored by the mutator).
      applyReadingFlagAware(snapshot, {
        circuit: ref,
        field: input.field,
        value: input.value,
        boardId,
      });
      // Slice 1.1c — perTurnWrites key now embeds boardId via
      // encodeReadingKey. Cross-board '*' sweep can write the same
      // (field, ref) on every board in one turn without collision; each
      // (field, ref, board) tuple lands in its own Map slot, the bundler
      // emits the correct extracted_readings entry per board, and the
      // applied[] array still surfaces the per-board breakdown.
      //
      // "Work on Board" hotfix slice 1.1a — value entry carries boardId so
      // the bundler emits the right `reading.board_id` on each entry.
      perTurnWrites.readings.set(encodeReadingKey(input.field, ref, boardId), {
        value: input.value,
        confidence: input.confidence,
        source_turn_id: input.source_turn_id,
        boardId: boardId ?? undefined,
      });
      applied.push({
        circuit: ref,
        field: input.field,
        value: input.value,
        // Surface the board_id only for cross-board sweeps so the existing
        // single-board envelope shape stays byte-identical for every
        // pre-Phase-6.5 caller. iOS decoder treats unknown keys as benign.
        ...(input.board_id === '*' ? { board_id: boardId } : {}),
      });
    }
  }

  logToolCall(logger, {
    sessionId: session.sessionId,
    turnId,
    tool_use_id: call.tool_call_id,
    tool: 'set_field_for_all_circuits',
    round,
    is_error: false,
    outcome: applied.length > 0 ? 'ok' : 'noop',
    validation_error: null,
    input_summary: {
      field: input.field,
      scope,
      applied_count: applied.length,
      skipped_count: skipped.length,
    },
  });
  return envelope(call.tool_call_id, { ok: true, applied, skipped }, false);
}

// ---- inline validator for set_field_for_all_circuits ----------------------
//
// Kept inline (not threaded through stage6-dispatch-validation.js) because the
// shape is small and the validator's heavy lift is the per-field-schema check
// against FIELD_SCHEMA, which is already imported here. If other bulk tools
// land later (set_observation_for_all_circuits etc.), refactor up to the
// shared validator module.
//
// Defence in depth (Bug-E removed strict:true at the API layer per
// stage6-tool-schemas.js:108, so off-enum sampling can slip through):
//   - field MUST be a known circuit_fields key — bypassing this would
//     silently corrupt the snapshot via applyReadingToSnapshot.
//   - For SELECT-typed fields, value MUST be in the field's option list.
//     record_reading doesn't enforce this either (legacy gap), but the
//     blast radius of a bad value here is EVERY circuit at once vs one,
//     so the cost/benefit on the bulk path tilts toward stricter checks.
//   - For TEXT-typed fields, accept any string (matches record_reading
//     behaviour — the schema has no enum to validate against).
const VALID_SCOPES = new Set(['non_spare', 'all', 'rcd_protected_only']);
function validateSetFieldForAllCircuits(input) {
  if (typeof input.field !== 'string' || input.field.length === 0) {
    return { code: 'invalid_field', field: 'field' };
  }
  const fieldDef = FIELD_SCHEMA.circuit_fields?.[input.field];
  if (!fieldDef) {
    return { code: 'unknown_field', field: 'field' };
  }
  if (typeof input.value !== 'string') {
    return { code: 'invalid_value', field: 'value' };
  }
  // Per-field option enforcement for select-typed fields. Empty option ""
  // is valid (it's the dispatcher's clear-equivalent — write empty across
  // all circuits to wipe the field). N/A is valid only when present in the
  // option list, which it is for most select fields by convention.
  if (fieldDef.type === 'select' && Array.isArray(fieldDef.options)) {
    if (!fieldDef.options.includes(input.value)) {
      return {
        code: 'value_not_in_options',
        field: 'value',
        valid_options: fieldDef.options,
      };
    }
  }
  if (
    typeof input.confidence !== 'number' ||
    !Number.isFinite(input.confidence) ||
    input.confidence < 0 ||
    input.confidence > 1
  ) {
    return { code: 'invalid_confidence', field: 'confidence' };
  }
  if (typeof input.source_turn_id !== 'string' || input.source_turn_id.length === 0) {
    return { code: 'invalid_source_turn_id', field: 'source_turn_id' };
  }
  if (input.scope !== undefined && !VALID_SCOPES.has(input.scope)) {
    return { code: 'invalid_scope', field: 'scope' };
  }
  return null;
}
