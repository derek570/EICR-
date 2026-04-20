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
 * Drops questions whose (field, circuit) slot is already populated in the
 * session's stateSnapshot. Protects against Sonnet re-asking for values it
 * has already captured once the earlier turn falls out of the sliding window.
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
    // Orphan/install-field questions — QuestionGate handles these.
    if (!field || circuit === null || circuit === undefined) {
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
        qType: (q.type || 'unknown').slice(0, 40),
      });
      continue;
    }
    kept.push(q);
  }
  return kept;
}
