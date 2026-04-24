/**
 * Stage 6 Phase 2 Plan 02-04 — Observation dispatchers (real implementation).
 *
 * WHAT: Real implementations of dispatchRecordObservation (STD-07) and
 * dispatchDeleteObservation (STD-08). Replaces the Plan 02-02 Task 4 NOOPs.
 * Each dispatcher follows the validate → mutate → track → log → envelope
 * pipeline locked by Plans 02-01/02-02.
 *
 * WHY a thin sibling file instead of inlining into the barrel (MAJOR-2):
 * Wave-2 parallelism — Plan 02-03 edits stage6-dispatchers-circuit.js in the
 * same wave. Keeping each plan to exactly one file makes merge conflicts
 * structurally impossible. The barrel (stage6-dispatchers.js) is append-only.
 *
 * WHY the envelope helper is duplicated across this file and its circuit
 * sibling: hoisting it would re-couple the two sibling files Wave-2 was
 * designed to decouple. The 3-line cost is acceptable.
 *
 * ---------------------------------------------------------------------------
 * PII DISCIPLINE (CALLER CONTRACT — locked by tests in Group 5)
 * ---------------------------------------------------------------------------
 * The free-text fields observation.text, observation.location, and
 * suggested_regulation MUST NEVER appear in any logToolCall input_summary.
 * These fields may contain inspector-dictated PII (client names, address
 * fragments, regulation numbers that can index into a regulation database).
 * Only {observation_id, code, reason} are loggable from this file.
 *
 * The logger helper (stage6-dispatcher-logger.js) is intentionally dumb — it
 * does NOT redact. The redaction contract lives HERE, at the caller.
 * ---------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------
 * BLOCK-2 NOOP CONTRACT (delete-already-deleted is NOT an error)
 * ---------------------------------------------------------------------------
 * If the model calls delete_observation with an observation_id that is no
 * longer in session.extractedObservations (e.g. it already deleted it in a
 * prior turn, or it hallucinated an id), the correct response is:
 *   envelope: {ok:true, noop:true, reason:'observation_not_found'}
 *   is_error: false
 *   log row:  outcome: 'noop', validation_error: null
 *
 * NEVER is_error:true. Research §Q8 forbids that because it drives Sonnet
 * into retry loops (the post-state already satisfies the request).
 *
 * The validator (validateDeleteObservation) always returns null for this
 * reason — the absence check is a DISPATCHER concern, not a validator one.
 * ---------------------------------------------------------------------------
 */

import { appendObservation, deleteObservation } from './stage6-snapshot-mutators.js';
import {
  validateRecordObservation,
  validateDeleteObservation,
} from './stage6-dispatch-validation.js';
import { logToolCall } from './stage6-dispatcher-logger.js';
import { checkForPromptLeak } from './stage6-prompt-leak-filter.js';

function envelope(tool_use_id, body, is_error) {
  return { tool_use_id, content: JSON.stringify(body), is_error };
}

/**
 * STD-07: record_observation dispatcher.
 *
 * Pipeline:
 *   1. Validate (schema-level, always null today — Plan 02-02 locked contract).
 *   2. appendObservation(session, {...}) — atom generates UUID, pushes to
 *      session.extractedObservations, returns {id}.
 *   3. perTurnWrites.observations.push(enriched copy) for Plan 02-05 bundler.
 *   4. Log outcome 'ok' with {observation_id, code} only.
 *   5. Return envelope {ok:true, observation_id} so the model can reference
 *      the id in a future delete_observation call.
 *
 * @param {{tool_call_id: string, name: string, input: object}} call
 * @param {{session: object, logger: object, turnId: string,
 *          perTurnWrites: object, round: number}} ctx
 */
export async function dispatchRecordObservation(call, ctx) {
  const { session, logger, turnId, perTurnWrites, round } = ctx;
  const input = call.input;

  const baseLogRow = {
    sessionId: session.sessionId,
    turnId,
    tool_use_id: call.tool_call_id,
    tool: 'record_observation',
    round,
  };

  const err = validateRecordObservation(input, session);
  if (err) {
    logToolCall(logger, {
      ...baseLogRow,
      is_error: true,
      outcome: 'rejected',
      validation_error: err,
      input_summary: { code: input.code ?? null },
    });
    return envelope(call.tool_call_id, { ok: false, error: err }, true);
  }

  // Plan 04-27 r20-#1: scan ALL free-text observation fields for system-
  // prompt leak content, not just `text`.
  //
  // r20 review found that 04-26's decision to only scan `text` left
  // `location` and `suggested_regulation` as live bypass routes: both
  // render on the PDF certificate (location column + regulation reference
  // under the observation text). An attacker who steers the model to
  // emit prompt content into either field sees it appear verbatim in
  // the customer's PDF.
  //
  // Failure mode CHANGED (r20-#1) vs 04-26:
  //   04-26 — substitute `text` with sanitised refusal; preserve the
  //           observation on session for audit trail.
  //   04-27 — reject the ENTIRE call (is_error:true). `location` and
  //           `suggested_regulation` are short fields that can't carry
  //           a meaningful sanitised substitute without corrupting the
  //           PDF shape (a refusal string in the location column would
  //           be nonsensical). A uniform reject rule is simpler and
  //           safer. The prompt_leak_blocked warn row carries the
  //           audit breadcrumb (which fields leaked, what filter family
  //           fired, how long the payload was — NEVER any substring of
  //           the blocked content; see r20-#2 redaction).
  //
  // Scan results aggregated across all three fields so the log row
  // names EVERY offending field in one emission (not one-per-field).
  // The model sees a single structured error with `fields: [...]` and
  // can retry with a fresh observation.
  const OBS_FREE_TEXT_FIELDS = ['text', 'location', 'suggested_regulation'];
  const offendingLeaks = [];
  for (const fieldName of OBS_FREE_TEXT_FIELDS) {
    const value = input[fieldName];
    if (typeof value !== 'string' || value.length === 0) continue;
    const leak = checkForPromptLeak(value, { field: 'observation_text' });
    if (!leak.safe) {
      offendingLeaks.push({ field: fieldName, reason: leak.reason, length: value.length });
    }
  }

  if (offendingLeaks.length > 0) {
    const offendingFieldNames = offendingLeaks.map((entry) => entry.field);
    const primary = offendingLeaks[0];
    logger.warn('stage6.prompt_leak_blocked', {
      tool: 'record_observation',
      tool_call_id: call.tool_call_id,
      sessionId: session.sessionId,
      turnId,
      reason: primary.reason,
      fields: offendingFieldNames,
      offending_field_lengths: offendingLeaks.reduce((acc, entry) => {
        acc[entry.field] = entry.length;
        return acc;
      }, {}),
    });
    logToolCall(logger, {
      ...baseLogRow,
      is_error: true,
      outcome: 'rejected',
      validation_error: 'prompt_leak_in_observation',
      input_summary: { code: input.code ?? null, fields: offendingFieldNames },
    });
    return envelope(
      call.tool_call_id,
      {
        ok: false,
        error: {
          code: 'prompt_leak_in_observation',
          reason: primary.reason,
          fields: offendingFieldNames,
        },
      },
      true
    );
  }

  // Atom owns UUID generation. Atom writes to session.extractedObservations.
  // (Legacy session.stateSnapshot.observations is a separate text-dedup
  // surface the atom deliberately does NOT touch — see Plan 02-01 SUMMARY.)
  const { id } = appendObservation(session, {
    code: input.code ?? null,
    text: input.text,
    location: input.location ?? null,
    circuit: input.circuit ?? null,
    suggested_regulation: input.suggested_regulation ?? null,
  });

  perTurnWrites.observations.push({
    id,
    code: input.code ?? null,
    text: input.text,
    location: input.location ?? null,
    circuit: input.circuit ?? null,
    suggested_regulation: input.suggested_regulation ?? null,
  });

  logToolCall(logger, {
    ...baseLogRow,
    is_error: false,
    outcome: 'ok',
    validation_error: null,
    // PII guard: only id + code. text / location / suggested_regulation NEVER.
    input_summary: { observation_id: id, code: input.code ?? null },
  });

  return envelope(call.tool_call_id, { ok: true, observation_id: id }, false);
}

/**
 * STD-08: delete_observation dispatcher.
 *
 * Pipeline (BLOCK-2 noop contract):
 *   1. Validate (schema-level, always null — absence is handled here not there).
 *   2. Look up observation_id in session.extractedObservations. If MISSING,
 *      return {ok:true, noop:true, reason:'observation_not_found'} with
 *      is_error:false and log outcome:'noop'. NEVER an error envelope.
 *   3. If found, deleteObservation(session, {observation_id}) — atom strips
 *      from session.extractedObservations and returns {ok:true, removed}.
 *   4. perTurnWrites.deletedObservations.push({id, reason}) for Plan 02-05.
 *   5. Log outcome 'ok' with {observation_id, reason} only.
 *
 * @param {{tool_call_id: string, name: string, input: object}} call
 * @param {{session: object, logger: object, turnId: string,
 *          perTurnWrites: object, round: number}} ctx
 */
export async function dispatchDeleteObservation(call, ctx) {
  const { session, logger, turnId, perTurnWrites, round } = ctx;
  const input = call.input;

  const baseLogRow = {
    sessionId: session.sessionId,
    turnId,
    tool_use_id: call.tool_call_id,
    tool: 'delete_observation',
    round,
  };

  const err = validateDeleteObservation(input, session);
  if (err) {
    logToolCall(logger, {
      ...baseLogRow,
      is_error: true,
      outcome: 'rejected',
      validation_error: err,
      input_summary: { observation_id: input.observation_id, reason: input.reason },
    });
    return envelope(call.tool_call_id, { ok: false, error: err }, true);
  }

  // BLOCK-2: semantic absence check lives here (not in validator).
  const observations = Array.isArray(session.extractedObservations)
    ? session.extractedObservations
    : [];
  const found = observations.find((o) => o.id === input.observation_id);

  if (!found) {
    logToolCall(logger, {
      ...baseLogRow,
      is_error: false,
      outcome: 'noop',
      validation_error: null,
      input_summary: { observation_id: input.observation_id, reason: input.reason },
    });
    return envelope(
      call.tool_call_id,
      { ok: true, noop: true, reason: 'observation_not_found' },
      false
    );
  }

  const result = deleteObservation(session, { observation_id: input.observation_id });
  if (!result.ok) {
    // Invariant violation: we just confirmed the observation existed. If the
    // atom now reports not_found, something is seriously wrong (concurrent
    // mutation, corrupted session state). Surfacing this as a thrown error
    // beats silently swallowing state corruption.
    throw new Error(
      `delete_observation invariant violated: ${input.observation_id} vanished between find and delete`
    );
  }

  perTurnWrites.deletedObservations.push({
    id: input.observation_id,
    reason: input.reason ?? 'unspecified',
  });

  logToolCall(logger, {
    ...baseLogRow,
    is_error: false,
    outcome: 'ok',
    validation_error: null,
    input_summary: { observation_id: input.observation_id, reason: input.reason },
  });

  return envelope(call.tool_call_id, { ok: true }, false);
}
