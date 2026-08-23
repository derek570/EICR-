/**
 * PLAN-B B1 ingress 6 (feedback ids 128 + 131) — legacy JSON-prose
 * designation-hygiene seam.
 *
 * With `SONNET_TOOL_CALLS=off` (and in shadow mode, whose authoritative
 * result is the SAME legacy `extractFromUtterance` output), circuit
 * designations bypass every Stage-6 dispatcher that ingresses 1–4
 * canonicalise — the model's JSON-prose result is applied directly. This
 * is the documented rapid-ROLLBACK path, so it must not regress feedback
 * 128 ("the word circuit must never appear in a circuit description")
 * when used.
 *
 * BOTH legacy designation shapes are covered:
 *   - `extracted_readings[]` entries whose field is a designation key.
 *     Pre-sanitizer the wire may carry EITHER the legacy `designation`
 *     key (the KNOWN_FIELDS member) or the canonical `circuit_designation`
 *     (which `applyFieldNameCorrection` later rewrites to `designation`)
 *     — the seam runs BEFORE that correction, so it accepts both.
 *   - `circuit_updates[] {circuit, designation, action}` (create/rename)
 *     — the shape the legacy prompts emit for circuit naming. The
 *     `circuit ?? circuit_ref` / `action ?? op` alias spellings are
 *     accepted as defensive coding only: unreachable today (the live
 *     legacy/shadow contract is always `{circuit, designation, action}`;
 *     the aliases exist only in a test-only divergence script), retained
 *     for shape resilience.
 *
 * Responsibilities (each a review-settled PLAN-B requirement):
 *   1. Canonicalise every designation operation in place (edge-only
 *      strip via the shared canonicaliser) so snapshot, wire and speech
 *      all carry ONE cleaned value.
 *   2. Banned-token-only values ("Circuit") — remove the operation AND
 *      every paired confirmation, and surface exactly ONE server-owned
 *      designation clarification per turn (never a write/speech
 *      disagreement, Audio-First §1/§2).
 *   3. Retain an ORDERED ledger of surviving designation operations so
 *      the caller can REBUILD designation confirmations from the
 *      normalized operation sequence — one confirmation per surviving
 *      operation, in operation order, via the existing
 *      `buildConfirmationText` builder. Field+circuit pairing is
 *      insufficient when one result carries MULTIPLE designation
 *      operations for the same circuit (they collide on the pairing
 *      key), which is why this is a rebuild, not a patch.
 *   4. Return clarifications SEPARATELY (not inside
 *      `questions_for_user`): the field sanitizer unconditionally
 *      REPLACES `questions_for_user` with [] on any rejection, so a
 *      clarification appended before it would be deleted whenever the
 *      same result carries an unrelated off-schema reading. The caller
 *      appends them exactly once AFTER the sanitizer.
 *
 * The DELIVERY marker (`DESIGNATION_HYGIENE_QUESTION_*`) is the ONE
 * closed server-owned question tag that (a) the off-mode filled-slot
 * filter explicitly admits (a banned-only RENAME targets an
 * already-populated `circuit_designation` slot) and (b) shadow mode
 * consumes despite its blanket legacy-`questions_for_user` bypass —
 * never reopening arbitrary model-authored questions. The seam STRIPS
 * any model-authored question carrying the marker before adding its
 * own, so a marker-bearing question downstream is provably server-owned.
 *
 * Dependency direction: this module is a dispatch-layer leaf (imports
 * only the canonicaliser + confirmation-text builder) so both
 * `eicr-extraction-session.js` and `sonnet-stream.js` /
 * `filled-slots-filter.js` can import it without cycles.
 */

import {
  canonicaliseCircuitDesignation,
  designationCanonicalisesToEmpty,
} from './designation-canonicaliser.js';
import { buildConfirmationText } from './confirmation-text.js';

/**
 * The closed server-owned designation-hygiene question marker. BOTH keys
 * are required to match (mirrors the address_mirror trust boundary in
 * question-gate.js — a single spoofable key is not a marker). Exact
 * strings are part of the delivery contract:
 *   type:    'designation_hygiene'
 *   purpose: 'server_designation_hygiene'
 */
export const DESIGNATION_HYGIENE_QUESTION_TYPE = 'designation_hygiene';
export const DESIGNATION_HYGIENE_QUESTION_PURPOSE = 'server_designation_hygiene';

/**
 * TRUE iff the question carries the full server-owned designation-hygiene
 * marker pair. Used by the filled-slot filter (explicit admit), the
 * shadow-mode consumption gate in sonnet-stream.js, and the seam's own
 * forged-marker strip.
 */
export function isDesignationHygieneQuestion(q) {
  return (
    q != null &&
    q.purpose === DESIGNATION_HYGIENE_QUESTION_PURPOSE &&
    q.type === DESIGNATION_HYGIENE_QUESTION_TYPE
  );
}

// Designation keys as they appear on the legacy wire PRE-sanitizer:
// `designation` is the KNOWN_FIELDS/client key; `circuit_designation` is
// the canonical schema key the sanitizer's applyFieldNameCorrection later
// rewrites to `designation`. The seam runs before that correction.
const DESIGNATION_READING_FIELDS = new Set(['designation', 'circuit_designation']);

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function opCircuitRef(op) {
  // Alias spelling `circuit_ref` — defensive only ("unreachable today,
  // retained for shape resilience"); the live legacy shape is `circuit`.
  const raw = op.circuit ?? op.circuit_ref;
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}

function opAction(op) {
  // Alias spelling `op` — defensive only, same provenance as above.
  return op.action ?? op.op;
}

function buildClarificationQuestion(removedCircuits) {
  const circuits = [...new Set(removedCircuits.filter((c) => Number.isInteger(c) && c > 0))];
  const single = circuits.length === 1 ? circuits[0] : null;
  const question =
    single != null
      ? `I couldn't use that as a name for circuit ${single} — "circuit" on its own isn't a description. What should circuit ${single} be called?`
      : `I couldn't use "circuit" on its own as a circuit name — it isn't a description. What should that circuit be called?`;
  return {
    type: DESIGNATION_HYGIENE_QUESTION_TYPE,
    purpose: DESIGNATION_HYGIENE_QUESTION_PURPOSE,
    field: 'circuit_designation',
    circuit: single,
    question,
  };
}

/**
 * Normalise a parsed legacy extraction result IN PLACE. Must run
 * IMMEDIATELY after parsing / initial assistantHistoryText creation —
 * BEFORE `sanitizeReadingFieldContractWithReport` and BEFORE
 * `nonMirrorQuestions` is computed (PLAN-B ordering, pinned round 15).
 *
 * Mutations applied to `result`:
 *   - designation `extracted_readings` values canonicalised in place;
 *     banned-token-only entries REMOVED;
 *   - `circuit_updates` create/rename designations canonicalised in
 *     place; banned-token-only operations REMOVED (delete ops and their
 *     `designation: ''` placeholders untouched);
 *   - when ANY designation operation exists (surviving or removed), the
 *     seam takes ownership of designation confirmations: every
 *     designation-paired confirmation is stripped here and the caller
 *     rebuilds the surviving subset from the returned ledger via
 *     `mergeDesignationConfirmations` (post-sanitizer). Orphan
 *     designation confirmations with ZERO designation operations are
 *     deliberately left alone (today's semantics — not this seam's to
 *     change);
 *   - model-authored questions forging the server-owned marker are
 *     stripped (the marker is a trust boundary, not model vocabulary).
 *
 * @returns {{
 *   changed: boolean,           // any designation op changed or removed
 *                               //   (the assistant-history rebuild trigger)
 *   designationOps: Array<{shape, wireField, circuit, boardId, value, action}>,
 *                               // ORDERED surviving-operation ledger
 *   clarifications: Array<object>, // 0 or exactly 1 marker-tagged question
 *   removedCount: number,
 * }}
 */
export function normaliseLegacyDesignationResult(result, { sessionId = null, logger = null } = {}) {
  const report = { changed: false, designationOps: [], clarifications: [], removedCount: 0 };
  if (!result || typeof result !== 'object') return report;

  // Forged-marker strip — the marker is server-owned; anything already
  // carrying it came from the model and must not reach the shadow-mode
  // consumption gate as if the server had authored it.
  if (Array.isArray(result.questions_for_user)) {
    const before = result.questions_for_user.length;
    result.questions_for_user = result.questions_for_user.filter(
      (q) => !isDesignationHygieneQuestion(q)
    );
    if (result.questions_for_user.length !== before) {
      logger?.warn?.('legacy_designation_seam_forged_marker_stripped', {
        sessionId,
        stripped: before - result.questions_for_user.length,
      });
    }
  }

  const removedCircuits = [];

  // ── Shape 1: extracted_readings[field ∈ designation keys] ────────────
  if (Array.isArray(result.extracted_readings)) {
    result.extracted_readings = result.extracted_readings.filter((reading) => {
      if (!reading || !DESIGNATION_READING_FIELDS.has(reading.field)) return true;
      if (!isNonEmptyString(reading.value)) return true; // empty/typed-odd: today's semantics
      if (designationCanonicalisesToEmpty(reading.value)) {
        report.changed = true;
        report.removedCount += 1;
        removedCircuits.push(Number(reading.circuit));
        logger?.info?.('legacy_designation_seam_removed_banned_only', {
          sessionId,
          shape: 'reading',
          circuit: reading.circuit ?? null,
        });
        return false;
      }
      const canonical = canonicaliseCircuitDesignation(reading.value);
      if (canonical !== reading.value) {
        reading.value = canonical;
        report.changed = true;
      }
      const circuit = Number(reading.circuit);
      if (Number.isInteger(circuit) && circuit > 0) {
        report.designationOps.push({
          shape: 'reading',
          // Post-sanitizer the reading's field is always the legacy
          // `designation` key (applyFieldNameCorrection) — mirror that on
          // the rebuilt confirmation so the snapshot-dedup filter compares
          // against the key the reading will actually write.
          wireField: 'designation',
          circuit,
          boardId: reading.board_id ?? null,
          value: canonical,
          action: null,
        });
      }
      return true;
    });
  }

  // ── Shape 2: circuit_updates[] {circuit, designation, action} ────────
  if (Array.isArray(result.circuit_updates)) {
    result.circuit_updates = result.circuit_updates.filter((op) => {
      if (!op || typeof op !== 'object') return true;
      const action = opAction(op);
      if (action !== 'create' && action !== 'rename') return true; // deletes untouched
      if (!isNonEmptyString(op.designation)) return true; // '' placeholder untouched
      if (designationCanonicalisesToEmpty(op.designation)) {
        report.changed = true;
        report.removedCount += 1;
        removedCircuits.push(opCircuitRef(op));
        logger?.info?.('legacy_designation_seam_removed_banned_only', {
          sessionId,
          shape: 'circuit_update',
          action,
          circuit: opCircuitRef(op),
        });
        return false;
      }
      const canonical = canonicaliseCircuitDesignation(op.designation);
      if (canonical !== op.designation) {
        op.designation = canonical;
        report.changed = true;
      }
      const circuit = opCircuitRef(op);
      if (circuit != null && circuit > 0) {
        report.designationOps.push({
          shape: 'circuit_update',
          // upsertCircuitMeta stores under the canonical snapshot key.
          wireField: 'circuit_designation',
          circuit,
          boardId: op.board_id ?? null,
          value: canonical,
          action,
        });
      }
      return true;
    });
  }

  // NO duplicate collapse (Codex cycle-1 #2): the ledger retains EVERY
  // surviving operation — one rebuilt confirmation per operation, in
  // operation order, is the plan contract. Collapsing on (circuit, value)
  // would silently drop the confirmation of a second applied operation
  // (create + rename canonicalising to the same value) and, board-blind,
  // would collapse identical-(ref, value) operations on DIFFERENT boards.
  // The snapshot confirmation-dedup downstream still suppresses genuine
  // re-emissions of a value the (board-aware) snapshot already holds.

  // Confirmation ownership: with any designation operation present,
  // strip every designation-paired confirmation (both the banned-only
  // ops' paired confirmations AND the survivors' model-authored text —
  // survivors are rebuilt deterministically from the ledger after the
  // sanitizer, via mergeDesignationConfirmations).
  if (
    (report.designationOps.length > 0 || report.removedCount > 0) &&
    Array.isArray(result.confirmations)
  ) {
    result.confirmations = result.confirmations.filter(
      (conf) => !DESIGNATION_READING_FIELDS.has(conf?.field)
    );
  }

  // Exactly ONE server-owned clarification per turn, regardless of how
  // many banned-only operations were removed.
  if (report.removedCount > 0) {
    report.clarifications.push(buildClarificationQuestion(removedCircuits));
  }

  return report;
}

/**
 * Post-sanitizer merge: rebuild the designation-confirmation subset from
 * the seam's ordered ledger. MUST run AFTER
 * `sanitizeReadingFieldContractWithReport` (which, on any rejection,
 * fully replaces `result.confirmations` from accepted extracted_readings
 * only — collapsing multiple same-slot designation confirmations to one
 * winner and dropping circuit_updates confirmations entirely) and BEFORE
 * the snapshot confirmation-dedup and locality fold in
 * eicr-extraction-session.js.
 *
 * Behaviour:
 *   - no designation operations (surviving or removed) → no-op;
 *   - otherwise designation-paired confirmations currently on the result
 *     (sanitizer-rebuilt collapsed winners included) are removed, and —
 *     gated by confirmationsEnabled — ONE confirmation per surviving
 *     ledger operation is appended in operation order via the existing
 *     builder. Other server-owned sanitizer confirmations are preserved.
 */
export function mergeDesignationConfirmations(result, seamReport, { confirmationsEnabled } = {}) {
  if (!result || !seamReport) return;
  const { designationOps, removedCount } = seamReport;
  if ((!designationOps || designationOps.length === 0) && !(removedCount > 0)) return;

  if (!Array.isArray(result.confirmations)) result.confirmations = [];
  result.confirmations = result.confirmations.filter(
    (conf) => !DESIGNATION_READING_FIELDS.has(conf?.field)
  );

  if (confirmationsEnabled !== true) return;

  for (const op of designationOps) {
    // The builder's circuit_designation branch produces the designation
    // phrasing ("Circuit N is now the X"); the record's `field` carries
    // the key the operation actually writes so the snapshot dedup filter
    // compares against the right slot.
    const text = buildConfirmationText('circuit_designation', op.value, op.circuit);
    if (typeof text !== 'string' || text.trim().length === 0) continue;
    // WIRE SHAPE (Codex cycle-1 #1): the legacy confirmation contract is
    // EXACTLY {text, field, circuit} — projectExtractionResultForWire
    // passes confirmations through unchanged, so any extra enumerable key
    // here would be a client-visible wire change (ZERO-wire-change
    // violation). `value` and `board_id` are still needed by the
    // board-aware snapshot confirmation-dedup upstream of egress, so they
    // ride as NON-enumerable properties: readable by in-process property
    // access, invisible to JSON.stringify and every spread/Object.keys.
    const confirmation = {
      text,
      field: op.wireField,
      circuit: op.circuit,
    };
    Object.defineProperty(confirmation, 'value', {
      value: op.value,
      enumerable: false,
      configurable: true,
    });
    if (op.boardId != null) {
      Object.defineProperty(confirmation, 'board_id', {
        value: op.boardId,
        enumerable: false,
        configurable: true,
      });
    }
    result.confirmations.push(confirmation);
  }
}
