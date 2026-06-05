/**
 * Stage 6 Phase 5 Plan 05-02 — filled-slots-shadow adapter.
 *
 * WHAT: A pure, side-effect-only adapter that wraps the unmodified Stage 5
 * `filterQuestionsAgainstFilledSlots` so Plan 05-01's gate composer can
 * MEASURE how often the legacy filter would have suppressed an `ask_user`
 * on the tool-call path WITHOUT actually suppressing.
 *
 * The wrapper at stage6-ask-gate-wrapper.js calls this adapter PRE-WRAPPER
 * (Open Question #5 — before any restrained / budget / debounce short-circuit)
 * on every ask_user the model emits. The return value is intentionally
 * IGNORED by the wrapper — Phase 7 retirement analysis joins the emitted
 * `stage6.filled_slots_would_suppress` rows with the dispatcher's
 * `stage6.ask_user` rows on (sessionId, tool_call_id) to decide whether
 * the legacy filter has any residual signal worth retaining.
 *
 * WHY composition over modification (STB-05 anchor):
 *   - filled-slots-filter.js is IMPORTED, never edited. The Codex grep
 *     `git diff stage6-phase4-base -- src/extraction/filled-slots-filter.js`
 *     remains empty by construction. Editing the legacy module would
 *     re-open its review surface and risk regressing the Stage 5 same-turn
 *     protection (filled-slots-filter.js:118-122) that the F21934D4
 *     reproducer required.
 *   - The ASK_REASON_TO_LEGACY_TYPE mapping is the ONLY translation point
 *     between the new tool-call surface (ask_user.reason enum) and the
 *     legacy question.type vocabulary. Every test in
 *     stage6-filled-slots-shadow.test.js asserts against this single
 *     surface — drift is caught loudly.
 *
 * WHY observation_confirmation is mapped to itself (Pitfall 6 anchor):
 *   The legacy filter's REFILL_QUESTION_TYPES whitelist
 *   (filled-slots-filter.js:42-46) contains ONLY
 *   {unclear, orphaned, circuit_disambiguation}. Any question.type
 *   outside that whitelist passes through unchanged, REGARDLESS of
 *   filled state — this is the deliberate "do not silence confirmation
 *   asks" guarantee from the Stage 5 codex-round-2 fix (commit 1cc6eba).
 *   Routing observation_confirmation → 'unclear' here would silently
 *   regress that guarantee on the tool-call path.
 *
 * WHY the safety contract (Group 4 tests):
 *   Shadow logging MUST NEVER tear down dispatch. Every plausible
 *   failure mode — sessionGetter returning undefined (the activeSessions
 *   entry was evicted between turn entry and ask emission), sessionGetter
 *   throwing, the filter itself throwing — collapses to a logged warn
 *   plus a safe `{ wouldHaveSuppressed: false, legacyType: <best-effort> }`
 *   return. The wrapper's own try/catch around the adapter call
 *   (stage6-ask-gate-wrapper.js:218) is a second layer of defence; this
 *   layer exists so the wrapper's catch block stays the unreachable
 *   belt-and-braces it claims to be.
 *
 * REQUIREMENTS: STB-03 (filled-slots filter runs in shadow mode on the
 * tool-call path) + STB-05 (no backstop weakened — composition only).
 */

import { filterQuestionsAgainstFilledSlots } from './filled-slots-filter.js';

/**
 * Closed mapping: ask_user.reason → legacy question.type.
 *
 * Keys: every value in ask_user's reason enum
 * (stage6-tool-schemas.js:319 + stage6-dispatch-validation.js:157).
 * Values: a subset of the legacy question.type vocabulary
 * (config/prompts/sonnet_extraction_system.md line 562).
 *
 * Membership in REFILL_QUESTION_TYPES (filled-slots-filter.js:42-46) is
 * the test that decides whether the filter MIGHT suppress:
 *   - 'circuit_disambiguation' ∈ REFILL_QUESTION_TYPES — filter MAY suppress
 *   - 'unclear'                ∈ REFILL_QUESTION_TYPES — filter MAY suppress
 *   - 'observation_confirmation' ∉ REFILL_QUESTION_TYPES — filter PASSES THROUGH
 *
 * Any future ask_user.reason without an explicit entry here defaults to
 * DEFAULT_LEGACY_TYPE ('unclear') — better to over-flag (extra shadow row)
 * than under-flag (missed signal).
 */
export const ASK_REASON_TO_LEGACY_TYPE = Object.freeze({
  out_of_range_circuit: 'circuit_disambiguation',
  ambiguous_circuit: 'circuit_disambiguation',
  contradiction: 'unclear',
  missing_context: 'unclear',
  observation_confirmation: 'observation_confirmation',
});

/**
 * Defensive default for unmapped ask_user.reason values. 'unclear' is in
 * REFILL_QUESTION_TYPES so an unmapped reason will cause the filter to
 * test the slot — Phase 7 analytics will see the unmapped reason in
 * the row's `reason` field and the table can be extended deliberately.
 */
const DEFAULT_LEGACY_TYPE = 'unclear';

/**
 * Factory for the side-effect-only filled-slots shadow logger.
 *
 * Returns a `shadowCheck(call, ctx)` function. On every invocation:
 *   1. Call sessionGetter() to read the CURRENT activeSessions entry.
 *      Lazy by design — the snapshot must reflect every prior turn's
 *      writes, not a stale snapshot captured at factory time.
 *   2. Translate the ask_user tool-call into a legacy question shape:
 *      { field, circuit, type, heard_value }.
 *   3. Invoke the unmodified `filterQuestionsAgainstFilledSlots` with
 *      a SINGLE-ELEMENT array + the live stateSnapshot + an EMPTY
 *      same-turn Set (this is a shadow check OUTSIDE the per-turn
 *      resolve cycle — passing a non-empty set would falsely
 *      protect against suppression).
 *   4. If the filter returns an empty array, emit ONE
 *      `stage6.filled_slots_would_suppress` log row.
 *   5. Return { wouldHaveSuppressed, legacyType } purely for test
 *      assertion + Plan 05-06 retirement-analytics counter usage.
 *      The wrapper at stage6-ask-gate-wrapper.js IGNORES this return
 *      value (filledSlotsShadow?.(call, ctx) inside try/catch).
 *
 * @param {object} opts
 * @param {() => { sessionId: string, stateSnapshot: object } | undefined} opts.sessionGetter
 *   Lazy accessor for the activeSessions entry. Returning undefined is
 *   safe — the adapter logs warn once and returns the no-op result.
 * @param {{ info: Function, warn: Function }} opts.logger
 * @param {typeof filterQuestionsAgainstFilledSlots} [opts.existingFilter]
 *   Override for tests; defaults to the imported real filter.
 * @returns {(call: object, ctx: { sessionId: string, turnId: string })
 *           => { wouldHaveSuppressed: boolean, legacyType: string | null }}
 */
export function createFilledSlotsShadowLogger({
  sessionGetter,
  logger,
  existingFilter = filterQuestionsAgainstFilledSlots,
}) {
  return function shadowCheck(call, ctx) {
    // (1) Lazy session read — guard against eviction races.
    let session;
    try {
      session = sessionGetter();
    } catch (err) {
      logger.warn('stage6.filled_slots_shadow_getter_threw', {
        sessionId: ctx?.sessionId ?? 'unknown',
        tool_call_id: call?.id ?? 'unknown',
        error: err?.message ?? 'unknown',
      });
      return { wouldHaveSuppressed: false, legacyType: null };
    }
    if (!session) {
      logger.warn('stage6.filled_slots_shadow_no_session', {
        sessionId: ctx?.sessionId ?? 'unknown',
        tool_call_id: call?.id ?? 'unknown',
      });
      return { wouldHaveSuppressed: false, legacyType: null };
    }

    // (2) Translate ask_user → legacy question shape.
    const input = call?.input ?? {};
    const reason = input.reason ?? null;
    const legacyType = ASK_REASON_TO_LEGACY_TYPE[reason] ?? DEFAULT_LEGACY_TYPE;

    // Note on null-handling: the legacy filter at line 106-109 takes the
    // `!field || circuit === null || circuit === undefined` early-out and
    // KEEPS the question (passes through) when either coordinate is null.
    // We deliberately do NOT normalise null → '_' here (Pitfall 3 splitting
    // — null-bypass protection is owned by the budget wrapper at
    // stage6-ask-gate-wrapper.js:60-64, NOT by this adapter). The shadow
    // log mirrors the legacy path's actual decision surface, not an
    // idealised one.
    const translated = {
      field: input.context_field ?? null,
      circuit: input.context_circuit ?? null,
      type: legacyType,
      heard_value: '(tool-call)',
    };

    // (3) Invoke the unmodified filter.
    let kept;
    try {
      kept = existingFilter([translated], session.stateSnapshot, new Set(), session.sessionId);
    } catch (err) {
      logger.warn('stage6.filled_slots_shadow_filter_threw', {
        sessionId: session.sessionId,
        tool_call_id: call?.id ?? 'unknown',
        error: err?.message ?? 'unknown',
      });
      // Preserve the legacyType on the failure path — the mapping is
      // pure and useful to the caller even when the filter call failed.
      return { wouldHaveSuppressed: false, legacyType };
    }

    // (4) Emit log row ONLY when filter returned empty (i.e. it would
    // have suppressed). One row per attempted ask, never per failed
    // attempt within a turn — Phase 7 dashboards dedupe on
    // (sessionId, tool_call_id).
    const wouldHaveSuppressed = Array.isArray(kept) && kept.length === 0;
    if (wouldHaveSuppressed) {
      logger.info('stage6.filled_slots_would_suppress', {
        sessionId: session.sessionId,
        turnId: ctx?.turnId ?? null,
        phase: 5,
        tool_call_id: call?.id ?? null,
        context_field: input.context_field ?? null,
        context_circuit: input.context_circuit ?? null,
        reason,
        legacy_type_mapped: legacyType,
        emittedAt: new Date().toISOString(),
      });
    }

    return { wouldHaveSuppressed, legacyType };
  };
}
