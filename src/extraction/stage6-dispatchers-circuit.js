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
  deleteCircuit,
} from './stage6-snapshot-mutators.js';
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
  // source_turn_id, auto_resolved?} — field/circuit live in the Map key.
  // Bundler (Plan 02-05) splits the key on '::' to reconstruct them.
  //
  // P3-B (2026-04-27): tag synthetic auto-resolve writes so the slot
  // comparator can filter them out and avoid false-positive `extra_in_tool`
  // divergences against shadow mode (where the auto-resolve hook is dead
  // code; createAskDispatcher short-circuits before the resolution path).
  // The synthetic tool_call_id namespace marker '::auto::' is set by
  // createAutoResolveWriteHook in stage6-dispatchers.js.
  const autoResolved = String(call.tool_call_id ?? '').includes('::auto::');
  perTurnWrites.readings.set(`${input.field}::${input.circuit}`, {
    value: input.value,
    confidence: input.confidence ?? 1.0,
    source_turn_id: input.source_turn_id,
    auto_resolved: autoResolved || undefined,
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

  const err = validateDeleteCircuit(input, session.stateSnapshot);
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

  const { deleted } = deleteCircuit(session.stateSnapshot, {
    circuit_ref: input.circuit_ref,
  });

  perTurnWrites.circuitOps.push({
    op: 'delete',
    circuit_ref: input.circuit_ref,
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
  // all: walk every non-supply circuit in the snapshot.
  return Object.keys(snapshot.circuits || {})
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 1)
    .sort((a, b) => a - b);
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
function applyCalculatedReading(session, perTurnWrites, { circuit, field, value, tool }) {
  applyReadingToSnapshot(session.stateSnapshot, { circuit, field, value });
  perTurnWrites.readings.set(`${field}::${circuit}`, {
    value,
    confidence: 1.0,
    source_turn_id: `::calc::${tool}`,
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
    const bucket = session.stateSnapshot.circuits?.[ref];
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
    const bucket = session.stateSnapshot.circuits?.[ref];
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
