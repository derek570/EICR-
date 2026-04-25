// filled-slots-filter.js
// Stage 5 — dialog-state filledSlots pre-flight filter for Sonnet-emitted
// questions. Factored out of sonnet-stream.js so it can be unit-tested
// without pulling the WS server + S3 storage + OpenAI client into the test
// runtime (storage.js eagerly resolves `import.meta.dirname` at import time
// which jest can't satisfy without extra plumbing).
//
// See the docstring on `filterQuestionsAgainstFilledSlots` for behaviour.

import logger from '../logger.js';

/**
 * Sonnet question types that are "refill-style" — i.e. the model is asking
 * the inspector to (re-)supply a value. Only these are safe to suppress when
 * the (field, circuit) slot is already populated.
 *
 * Codex review of the first cut (2026-04-20) flagged that a blanket drop on
 * `field+circuit` filled would also swallow legitimate WARNING prompts about
 * captured values — notably `out_of_range` (Sonnet flagging a suspicious
 * reading) and observation-related questions (which already pass through
 * because they carry field=null, but belt-and-braces). Those prompts ask
 * the inspector to CONFIRM or CORRECT an existing value rather than to
 * supply a missing one, so they must survive.
 *
 * Canonical question-type vocabulary lives in the Sonnet schema at
 * config/prompts/sonnet_extraction_system.md line 562:
 *   orphaned | out_of_range | unclear | tt_confirmation
 *   | circuit_disambiguation | observation_confirmation
 *
 * Refill-style ⊂ canonical: only the types where the inspector is being
 * asked to (re-)supply a value. `out_of_range` (warning), `tt_confirmation`
 * (confirm supply), `observation_confirmation` (observation-related) are
 * NOT refill-style and must survive the filter. Sonnet-stream.js line ~1201
 * has a separate ALLOWED_QUESTION_TYPES whitelist for iOS reply annotation
 * which is superset-by-design (includes `clarify` / `observation_code` /
 * `observation_unclear` / `voice_command`) — if any of those surface as
 * questions_for_user types they too fall through the default-pass-through
 * path below.
 * Types NOT in REFILL_QUESTION_TYPES default to PASS-THROUGH (safer
 * failure mode: an extra spoken question is better than a silent drop).
 */
const REFILL_QUESTION_TYPES = new Set([
  'unclear', // "I couldn't quite hear that — could you repeat?"
  'orphaned', // "I heard a reading but don't know which circuit it was for."
  'circuit_disambiguation', // "Was that for circuit 2 or circuit 12?"
]);

/**
 * Drops questions whose (field, circuit) slot is already populated in the
 * session's stateSnapshot AND whose `type` is a refill-style re-ask. Protects
 * against Sonnet re-asking for values it has already captured once the earlier
 * turn falls out of the sliding window.
 *
 * Reproducer: session F21934D4, "R1 plus R2 for circuit 2 is 0.64 ohms"
 * extracted on turn N. On a later turn the sliding window has dropped the
 * exchange and Sonnet emits `{ field: 'r1_r2', circuit: 2, type: 'unclear' }`
 * in `questions_for_user`. Without this filter the question reaches QuestionGate,
 * fires as TTS, and re-asks the inspector for a reading already on the form.
 *
 * Rules:
 *   - Only filter questions with BOTH a concrete field and a numeric circuit.
 *     null-circuit questions are orphan-disambiguation / install-field wildcards
 *     that QuestionGate's existing install-field logic already handles safely.
 *   - Only filter questions whose `type` is in REFILL_QUESTION_TYPES.
 *     `out_of_range` warnings, `tt_confirmation` prompts, voice commands, and
 *     observation-related types explicitly survive — they address a captured
 *     value rather than asking the inspector to re-supply it.
 *   - Never drop a question whose slot was ALSO extracted THIS turn
 *     (`resolvedFieldsThisTurn`). Same-turn questions are Sonnet's in-turn
 *     judgement that the extracted value is incomplete — e.g. the "half a
 *     postcode" case guarded by sonnet-stream.js's resolve-before-enqueue
 *     ordering — and must survive. stateSnapshot reflects this turn's
 *     extraction (updateStateSnapshot runs inside extractFromUtterance before
 *     returning), so checking the raw snapshot alone would regress the
 *     same-turn protection.
 *   - Corrections still flow as extracted_readings with a DIFFERENT value
 *     (see eicr-extraction-session.js line 631 dedup filter). Suppressing
 *     re-ask questions never blocks user-initiated edits because corrections
 *     are never shaped as questions.
 *
 * Emits `suppressed_refill_question` so CloudWatch can count how often Sonnet
 * tries to refill a captured slot (a signal that the stateSnapshot injection
 * in the system prompt isn't being respected).
 *
 * @param {Array} questions               Sonnet's questions_for_user array.
 * @param {Object} stateSnapshot          session.stateSnapshot (reads .circuits).
 * @param {Set<string>} resolvedFieldsThisTurn  `field:circuit` keys extracted this turn.
 * @param {string} sessionId              for log correlation.
 * @returns {Array} filtered questions (never null for a non-null input).
 */
export function filterQuestionsAgainstFilledSlots(
  questions,
  stateSnapshot,
  resolvedFieldsThisTurn,
  sessionId
) {
  if (!Array.isArray(questions) || questions.length === 0) return questions;
  const circuits = stateSnapshot?.circuits || {};
  const thisTurn = resolvedFieldsThisTurn instanceof Set ? resolvedFieldsThisTurn : new Set();
  const kept = [];
  for (const q of questions) {
    const field = q && q.field;
    const circuit = q && q.circuit;
    const qType = q && typeof q.type === 'string' ? q.type.toLowerCase() : '';
    // Orphan/install-field questions — QuestionGate handles these.
    if (!field || circuit === null || circuit === undefined) {
      kept.push(q);
      continue;
    }
    // Only suppress refill-style types. Warnings (`out_of_range`), confirmations
    // (`tt_confirmation`), voice commands, and observation-related types must
    // survive because they address an already-captured value rather than asking
    // the inspector to re-supply it. Unknown types default to pass-through.
    if (!REFILL_QUESTION_TYPES.has(qType)) {
      kept.push(q);
      continue;
    }
    // Same-turn extraction: trust Sonnet, do not drop.
    if (thisTurn.has(`${field}:${circuit}`)) {
      kept.push(q);
      continue;
    }
    const slotFilled =
      circuits[circuit] &&
      Object.prototype.hasOwnProperty.call(circuits[circuit], field) &&
      circuits[circuit][field] !== null &&
      circuits[circuit][field] !== undefined &&
      circuits[circuit][field] !== '';
    if (slotFilled) {
      logger.info('suppressed_refill_question', {
        sessionId,
        field,
        circuit,
        filledValue: String(circuits[circuit][field]).slice(0, 40),
        qType: qType.slice(0, 40),
      });
      // Phase 8 Plan 08-01 SC #6 — emit a one-shot deletion-pending warn
      // alongside the info-log so the operator scanning CloudWatch sees
      // the T+4w deletion schedule inline (mirrors Phase 7's
      // logLegacyPathInvokedOnce pattern in sonnet-stream.js:208). The
      // info-log row stays as-is — the metric is still useful diagnostic
      // for prompt regressions through T+4w.
      logSuppressedRefillDeletionPendingOnce(sessionId);
      continue;
    }
    kept.push(q);
  }
  return kept;
}

// Exported for test coverage of the type whitelist — the set is small and
// stable so duplicating it in tests would just drift out of sync.
export const __TEST_REFILL_QUESTION_TYPES = REFILL_QUESTION_TYPES;

// ─────────────────────────────────────────────────────────────────
// Phase 8 Plan 08-01 SC #6 — deletion-pending warn-log helper.
//
// One-shot per sessionId. Pattern mirrors logLegacyPathInvokedOnce()
// in src/extraction/sonnet-stream.js:208 (Phase 7 commit b6c77a5).
// Why module-level state rather than the entry-stamp pattern Phase 7
// used: filterQuestionsAgainstFilledSlots is a pure function with no
// access to the activeSessions entry. A module-level Set keyed on
// sessionId is the equivalent for a stateless caller — sessions
// terminate eventually (by GC of the activeSessions entry) and the
// Set membership is bounded by the number of distinct sessions
// observed by the process, which is bounded by ECS task lifetime.
// Memory cost: ~36 bytes per session (UUID string), under any
// realistic load this is sub-megabyte.
//
// Reset hook (__TEST_RESET_DELETION_PENDING_LOG_STATE) is exported
// for tests because beforeEach can't otherwise reset the closure
// state. Same pattern as `seenSessionsForLegacyPathInvoked` could
// have been if Phase 7 hadn't piggy-backed on the entry. Marked
// __TEST_ prefix so it's clearly NOT for production callers.
// ─────────────────────────────────────────────────────────────────

const _seenDeletionPendingSessions = new Set();

function logSuppressedRefillDeletionPendingOnce(sessionId) {
  if (!sessionId) return;
  if (_seenDeletionPendingSessions.has(sessionId)) return;
  _seenDeletionPendingSessions.add(sessionId);
  logger.warn('stage6.suppressed_refill_question_deletion_pending', {
    sessionId,
    _invoked_at: new Date().toISOString(),
    _deletion_target: 'T+4w (Phase 7 STR-05)',
    _refs: 'REQUIREMENTS.md STO-05; ROADMAP §Phase 8 SC #6',
  });
}

// Test-only export — DO NOT call from production code. Resets the
// per-process one-shot state so tests can re-exercise the first-emit
// path. Same idiom as test-only setters in question-gate.js.
export function __TEST_RESET_DELETION_PENDING_LOG_STATE() {
  _seenDeletionPendingSessions.clear();
}
