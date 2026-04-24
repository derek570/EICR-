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

import {
  applyReadingToSnapshot,
  clearReadingInSnapshot,
  upsertCircuitMeta,
  renameCircuit,
} from './stage6-snapshot-mutators.js';
import {
  validateRecordReading,
  validateClearReading,
  validateCreateCircuit,
  validateRenameCircuit,
} from './stage6-dispatch-validation.js';
import { logToolCall } from './stage6-dispatcher-logger.js';
import { checkForPromptLeak, hashPayload } from './stage6-prompt-leak-filter.js';

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

  const err = validateRecordReading(input, session.stateSnapshot);
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

  applyReadingToSnapshot(session.stateSnapshot, {
    circuit: input.circuit,
    field: input.field,
    value: input.value,
  });

  // MAJOR-1 shape lock: value object carries ONLY {value, confidence,
  // source_turn_id} — field/circuit live in the Map key. Bundler (Plan 02-05)
  // splits the key on '::' to reconstruct them.
  perTurnWrites.readings.set(`${input.field}::${input.circuit}`, {
    value: input.value,
    confidence: input.confidence ?? 1.0,
    source_turn_id: input.source_turn_id,
  });

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

  const err = validateClearReading(input, session.stateSnapshot);
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

  const { cleared } = clearReadingInSnapshot(session.stateSnapshot, {
    circuit: input.circuit,
    field: input.field,
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
  perTurnWrites.readings.delete(`${input.field}::${input.circuit}`);
  perTurnWrites.cleared.push({
    field: input.field,
    circuit: input.circuit,
    reason: input.reason,
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

  const err = validateCreateCircuit(input, session.stateSnapshot);
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

  upsertCircuitMeta(session.stateSnapshot, {
    circuit_ref: input.circuit_ref,
    designation: input.designation,
    phase: input.phase,
    rating_amps: input.rating_amps,
    cable_csa_mm2: input.cable_csa_mm2,
  });

  perTurnWrites.circuitOps.push({
    op: 'create',
    circuit_ref: input.circuit_ref,
    meta: {
      designation: input.designation ?? null,
      phase: input.phase ?? null,
      rating_amps: input.rating_amps ?? null,
      cable_csa_mm2: input.cable_csa_mm2 ?? null,
    },
  });

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

  const err = validateRenameCircuit(input, session.stateSnapshot);
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
  const renameResult = renameCircuit(session.stateSnapshot, {
    from_ref: input.from_ref,
    circuit_ref: input.circuit_ref,
  });
  if (!renameResult.ok) {
    // Defensive — validator already vetted these inputs. If this fires, a
    // state race happened between validate and mutate.
    throw new Error(`rename invariant violated: ${renameResult.error?.code}`);
  }

  if (metaSupplied) {
    upsertCircuitMeta(session.stateSnapshot, {
      circuit_ref: input.circuit_ref,
      designation: input.designation,
      phase: input.phase,
      rating_amps: input.rating_amps,
      cable_csa_mm2: input.cable_csa_mm2,
    });
  }

  perTurnWrites.circuitOps.push({
    op: 'rename',
    from_ref: input.from_ref,
    circuit_ref: input.circuit_ref,
    meta: {
      designation: input.designation ?? null,
      phase: input.phase ?? null,
      rating_amps: input.rating_amps ?? null,
      cable_csa_mm2: input.cable_csa_mm2 ?? null,
    },
  });

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
