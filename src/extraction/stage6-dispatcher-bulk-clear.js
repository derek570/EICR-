/**
 * PLAN-C3 (feedback-2026-09-17, Decision 5) — `clear_field_for_all_circuits`.
 *
 * THE TRADE THIS TOOL EXISTS TO MAKE. Decision 5 rejects the empty bulk
 * write, and it has to: `set_field_for_all_circuits {value: ""}` emptied a
 * field across a whole board with nothing read back per circuit, so an
 * inspector working in AirPods heard nothing at all while fourteen
 * certificate values disappeared. But the empty bulk write existed for a
 * reason — per-circuit model calls once stopped halfway through a 14-circuit
 * operation (session DC946608), which is exactly why the bulk tool was
 * built. Rejecting the empty write without a replacement would reintroduce
 * that failure.
 *
 * So the clear becomes its own tool: SERVER-ITERATED (the model emits one
 * call, never a burst it can truncate), and AUDIBLE (one grouped spoken line
 * for the whole sweep, plus an explicit disclosure for anything that did not
 * clear).
 *
 * ON THE WIRE NOTHING CHANGES: one `field_corrected` per cleared circuit,
 * exactly as `clear_reading` produces today, because both clients clear per
 * circuit and this tool must not invent a second shape for them to decode.
 * The grouping is a SPEECH decision and lives in the bundler, keyed on the
 * `BULK_OUTCOME_CALL_ID` stamp this dispatcher attaches.
 *
 * ALREADY-EMPTY TARGETS COUNT AS CLEARED, not as failures. The inspector
 * asked for the field to be empty across the scope, and it is. Calling that a
 * failure would produce a disclosure line about circuits where nothing was
 * ever wrong — noise that trains an inspector to ignore the channel that
 * exists to tell them something real did not land.
 */

import { logToolCall } from './stage6-dispatcher-logger.js';
import { CLEAR_READING_FIELD_ENUM } from './stage6-tool-schemas.js';
import { clearReadingFlagAware } from './stage6-snapshot-mutators.js';
import { normaliseBoardScopeInput, resolveEffectiveBoardId } from './stage6-multi-board-shape.js';
import { isBlankWrite } from './blank-write-policy.js';
import {
  attachEffectiveSlot,
  attachBulkOutcomeCallId,
  removeReadingWrites,
  decodeReadingKey,
  rawCircuitSlot,
  EFFECTIVE_CIRCUIT_SLOT,
} from './stage6-per-turn-writes.js';
import {
  resolveBulkTargets,
  stageCircuitPartialFailure,
  VALID_BULK_SCOPES,
  VALID_BULK_SPARE_POLICIES,
} from './stage6-dispatchers-circuit.js';

const CLEAR_READING_FIELD_SET = new Set(CLEAR_READING_FIELD_ENUM);

function envelope(tool_use_id, body, is_error) {
  return { tool_use_id, content: JSON.stringify(body), is_error };
}

/**
 * Validate the bulk-clear input. Deliberately a mirror of
 * `validateSetFieldForAllCircuits`'s shape checks minus everything about a
 * VALUE — there is no value here, which is the whole point of the tool.
 */
function validateClearFieldForAllCircuits(input) {
  if (typeof input.field !== 'string' || input.field.length === 0) {
    return { code: 'invalid_field', field: 'field' };
  }
  if (!CLEAR_READING_FIELD_SET.has(input.field)) {
    // Same code `clear_reading` returns for an excluded/unknown field, so the
    // model sees one contract for "that field is not clearable" rather than
    // two codes meaning the same thing on two tools.
    return { code: 'field_not_clearable', field: 'field', value: input.field };
  }
  if (typeof input.source_turn_id !== 'string' || input.source_turn_id.length === 0) {
    return { code: 'invalid_source_turn_id', field: 'source_turn_id' };
  }
  if (input.scope !== undefined && !VALID_BULK_SCOPES.has(input.scope)) {
    return { code: 'invalid_scope', field: 'scope' };
  }
  if (input.spare_policy !== undefined && !VALID_BULK_SPARE_POLICIES.has(input.spare_policy)) {
    return { code: 'invalid_spare_policy', field: 'spare_policy' };
  }
  return null;
}

/**
 * An explicit `board_id` must name a board that exists (`'*'` is the sweep
 * sentinel). Without this an unknown id resolves to zero targets and the tool
 * reports `{ok:true, cleared:[]}` — a successful-looking result for a clear
 * that never ran, while the value the inspector asked to remove stays put.
 */
function validateBulkBoardId(input, snapshot) {
  const id = input.board_id;
  if (id == null || id === '*') return null;
  if (!Array.isArray(snapshot?.boards)) return null;
  if (snapshot.boards.some((b) => b && b.id === id)) return null;
  return {
    code: 'board_not_found',
    field: 'board_id',
    hint: 'Use an exact board id from the BOARDS section, omit board_id for the current board, or pass "*" for every board.',
  };
}

/**
 * Clear ONE circuit's field through the same snapshot mutation and the same
 * same-turn-write reconciliation `dispatchClearReading` uses, then stamp the
 * bulk-call identity onto the resulting entries.
 *
 * The same-turn write removal is NOT optional housekeeping: without it a
 * `record_reading` earlier in the turn and this clear would both reach the
 * bundler for one slot, and the wire would carry a record and a clear for the
 * same cell — contradictory state on both clients.
 *
 * @returns {'cleared'|'already_empty'}
 */
function clearOneCircuit(
  session,
  perTurnWrites,
  { field, circuit, boardId, callId, reason, bucket }
) {
  // ALREADY-EMPTY is decided on the VALUE, not on whether a key exists. A
  // bucket carrying `ref_method: ''` is empty as far as the certificate is
  // concerned, and `clearReadingFlagAware` would report it as cleared because
  // the property was there to delete. Counting that as a clear would put a
  // `field_corrected` on the wire for a cell that did not change and name the
  // circuit in a spoken line that says something happened to it.
  if (bucket != null && isBlankWrite(String(bucket[field] ?? ''))) return 'already_empty';
  const { cleared, previousValue } = clearReadingFlagAware(session.stateSnapshot, {
    circuit,
    field,
    boardId,
  });
  if (!cleared) return 'already_empty';

  const effectiveBoardId = resolveEffectiveBoardId(session, boardId);
  const effectiveKey = rawCircuitSlot(field, circuit, effectiveBoardId);
  const rawKey = rawCircuitSlot(field, circuit, boardId ?? null);
  removeReadingWrites(perTurnWrites, (mapKey, val) => {
    const sym = val?.[EFFECTIVE_CIRCUIT_SLOT];
    if (sym) return rawCircuitSlot(sym.field, sym.circuit, sym.boardId) === effectiveKey;
    const decoded = decodeReadingKey(mapKey);
    return rawCircuitSlot(decoded.field, decoded.circuit, decoded.boardId) === rawKey;
  });

  perTurnWrites.cleared.push(
    attachEffectiveSlot({ field, circuit, reason }, field, circuit, effectiveBoardId)
  );
  perTurnWrites.fieldCorrections.push(
    attachBulkOutcomeCallId(
      attachEffectiveSlot(
        {
          type: 'field_corrected',
          circuit,
          field,
          previous_value: previousValue,
          reason: 'clear_reading',
          board_id: boardId ?? null,
        },
        field,
        circuit,
        effectiveBoardId
      ),
      callId
    )
  );
  return 'cleared';
}

/**
 * `clear_field_for_all_circuits` — validate, resolve the scope ONCE through
 * the shared `resolveBulkTargets`, then clear every eligible circuit.
 *
 * Scope resolution is the SAME function `set_field_for_all_circuits` uses, on
 * purpose: "all the RCD-protected circuits except 4" must mean the same set
 * whether the inspector is setting a value or clearing one, and two
 * resolutions is how that stops being true.
 */
export async function dispatchClearFieldForAllCircuits(call, ctx) {
  const { session, logger, turnId, perTurnWrites, round } = ctx;
  const input = normaliseBoardScopeInput(call.input ?? {}, session.stateSnapshot);

  const err =
    validateClearFieldForAllCircuits(input) ?? validateBulkBoardId(input, session.stateSnapshot);
  if (err) {
    logToolCall(logger, {
      sessionId: session.sessionId,
      turnId,
      tool_use_id: call.tool_call_id,
      tool: 'clear_field_for_all_circuits',
      round,
      is_error: true,
      outcome: 'rejected',
      validation_error: err,
      input_summary: {
        field: typeof input.field === 'string' ? input.field : null,
        scope: input.scope ?? null,
        spare_policy: input.spare_policy ?? null,
      },
    });
    return envelope(call.tool_call_id, { ok: false, error: err }, true);
  }

  const targets = resolveBulkTargets(input, session.stateSnapshot);
  const cleared = [];
  const alreadyEmpty = [];
  const failed = [];

  for (const candidate of targets.candidates) {
    // Ordering is load-bearing: `resolveBulkCandidates` marks a bucket MISS
    // as `eligible:false` too, so testing eligibility first would swallow the
    // one class that must be disclosed. An EXPLICITLY excluded ref stays
    // silent — the inspector asked us to skip it.
    if (candidate.excluded) continue;
    if (!candidate.bucket) {
      // A registry/bucket disagreement: the ref was offered by
      // `listCircuitRefsInBoard` but has no record. This is the one class
      // that would otherwise be silent, so it gets an explicit disclosure —
      // the inspector asked for a scope and part of that scope did not
      // happen.
      failed.push({ circuit_ref: candidate.ref, reason: 'circuit_not_found' });
      stageCircuitPartialFailure(ctx, {
        reason: 'circuit_not_found',
        field: input.field,
        circuit: candidate.ref,
        boardId: candidate.boardId,
        producer: 'clear_field_for_all_circuits_bucket_miss',
      });
      continue;
    }
    if (!candidate.eligible) continue;
    let outcome;
    try {
      outcome = clearOneCircuit(session, perTurnWrites, {
        field: input.field,
        circuit: candidate.ref,
        boardId: candidate.boardId,
        callId: call.tool_call_id,
        reason: 'user_correction',
        bucket: candidate.bucket,
      });
    } catch (clearErr) {
      logger?.warn?.('stage6.bulk_clear_circuit_failed', {
        sessionId: session.sessionId,
        turnId,
        field: input.field,
        circuit: candidate.ref,
        error: clearErr?.message ?? String(clearErr),
      });
      failed.push({ circuit_ref: candidate.ref, reason: 'write_failed' });
      stageCircuitPartialFailure(ctx, {
        reason: 'write_failed',
        field: input.field,
        circuit: candidate.ref,
        boardId: candidate.boardId,
        producer: 'clear_field_for_all_circuits_write_failed',
      });
      continue;
    }
    if (outcome === 'already_empty') alreadyEmpty.push(candidate.ref);
    else cleared.push(candidate.ref);
  }

  logToolCall(logger, {
    sessionId: session.sessionId,
    turnId,
    tool_use_id: call.tool_call_id,
    tool: 'clear_field_for_all_circuits',
    round,
    is_error: false,
    outcome: cleared.length > 0 ? 'ok' : 'noop',
    validation_error: null,
    input_summary: {
      field: input.field,
      scope: input.scope ?? null,
      spare_policy: input.spare_policy ?? null,
      resolved_spare_policy: targets.effectiveSparePolicy,
      cleared_count: cleared.length,
      already_empty_count: alreadyEmpty.length,
      failed_count: failed.length,
    },
  });

  return envelope(
    call.tool_call_id,
    {
      ok: true,
      // `cleared` is what the inspector asked for and got. An already-empty
      // circuit is part of that outcome, reported separately so the model can
      // see the distinction without it reading as a failure.
      cleared,
      already_empty: alreadyEmpty,
      failed,
    },
    false
  );
}

/** Re-export for the bulk-clear unit tests; the validator is otherwise private. */
export { validateClearFieldForAllCircuits };
