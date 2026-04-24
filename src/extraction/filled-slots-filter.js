// filled-slots-filter.js
// Stage 5 — dialog-state filledSlots pre-flight filter for Sonnet-emitted
// questions. Factored out of sonnet-stream.js so it can be unit-tested
// without pulling the WS server + S3 storage + OpenAI client into the test
// runtime (storage.js eagerly resolves `import.meta.dirname` at import time
// which jest can't satisfy without extra plumbing).
//
// See the docstring on `filterQuestionsAgainstFilledSlots` for behaviour.

import logger from '../logger.js';
import { normaliseValue } from './value-normalise.js';

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

    // (A) heard_value cross-reference across the entire state snapshot.
    //
    // The existing (field, circuit) slot check can't catch questions that
    // carry `field: null` or a sentinel circuit (e.g. -1 for "don't know").
    // Those are exactly the shapes Sonnet emits on its `unclear` /
    // orphan-disambiguation path. Session 0952EC64 (2026-04-24, job
    // 19 Ivy Dean Road lunch) fired 4 questions about heard_value=0.13
    // over 80s while `circuit.4.r1_plus_r2=0.13` was already stored:
    //   Q2: {type:'unclear', field:null, circuit:-1, heard_value:'0.13'}
    //   Q3: {type:'unclear', field:null, circuit:0,  heard_value:'0.13'}
    //   Q4: {type:'circuit_disambiguation', field:'r1_plus_r2',
    //        circuit:-1, heard_value:'0.13'}
    // All three sail past the null-field early-return below. If we can
    // prove the heard value is already stored SOMEWHERE in the snapshot
    // (and that stored location wasn't just extracted this turn), the
    // question is a stale re-ask and we drop it.
    //
    // Gated on REFILL_QUESTION_TYPES so out_of_range warnings / tt /
    // observation confirmations about an existing value survive — same
    // rule as the original slot-filled check below.
    if (q && q.heard_value != null && REFILL_QUESTION_TYPES.has(qType)) {
      const normHeard = normaliseValue(q.heard_value);
      if (normHeard) {
        const storedAt = findStoredLocation(circuits, normHeard, thisTurn);
        if (storedAt) {
          logger.info('suppressed_heard_value_already_stored', {
            sessionId,
            heardValue: normHeard.slice(0, 40),
            storedAtCircuit: storedAt.circuit,
            storedAtField: storedAt.field,
            qType: qType.slice(0, 40),
            qField: field || null,
            qCircuit: circuit === null || circuit === undefined ? null : circuit,
          });
          continue;
        }
      }
    }

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
      continue;
    }
    kept.push(q);
  }
  return kept;
}

// Exported for test coverage of the type whitelist — the set is small and
// stable so duplicating it in tests would just drift out of sync.
export const __TEST_REFILL_QUESTION_TYPES = REFILL_QUESTION_TYPES;

/**
 * Walk every (circuit, field) pair in the snapshot and return the first
 * location whose stored value, after shared normalisation, equals the
 * normalised heard_value. Skips locations already in `thisTurn` so a
 * question emitted in the same turn as its extraction isn't suppressed
 * by its own fresh write.
 *
 * Returns `{ circuit, field }` or `null`.
 *
 * O(circuits × fields) per question; the snapshot typically has ≤20
 * circuits × ≤15 fields, so this is cheap enough to run inline.
 */
function findStoredLocation(circuits, normHeard, thisTurn) {
  if (!circuits || !normHeard) return null;
  for (const [cNum, cFields] of Object.entries(circuits)) {
    if (!cFields || typeof cFields !== 'object') continue;
    for (const [fName, fVal] of Object.entries(cFields)) {
      if (fVal === null || fVal === undefined || fVal === '') continue;
      if (thisTurn.has(`${fName}:${cNum}`)) continue;
      if (normaliseValue(fVal) === normHeard) {
        return { circuit: cNum, field: fName };
      }
    }
  }
  return null;
}
