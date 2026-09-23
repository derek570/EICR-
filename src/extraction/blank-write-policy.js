/**
 * PLAN-C3 (feedback-2026-09-17, Decision 5) — the ONE blank-write predicate.
 *
 * THE DEFECT. On September 17 the model was twice rejected on `BS 3871` for
 * `ocpd_bs_en`, so it wrote `""` and moved on — and the dispatcher accepted
 * it. The prompt literally told it to. The inspector heard nothing: a blank
 * write produces no read-back worth hearing, so a legally-significant
 * certificate value was emptied in silence. Decision 5: a blank field stays
 * blank, AUDIBLY. Every model-controlled mutation boundary rejects an
 * explicit blank string, and the refusal is spoken.
 *
 * WHY THIS MODULE HAS NO IMPORTS. The predicate is needed at six boundaries,
 * and one of them — `dialogue-engine/helpers/dialogue-slot-normalise.js` —
 * sits inside the dialogue engine, which CANNOT import
 * `stage6-tool-schemas.js` (that module imports `dialogue-engine/index.js`
 * and uses the binding at module top level, so the reverse edge evaluates the
 * tool schemas against an uninitialised binding — see the PLAN-A note in
 * `stage6-dispatch-validation.js`). Keeping the predicate itself in a leaf
 * with zero imports means every boundary shares ONE definition instead of
 * three copies that drift. The POLICY sets that need the field manifests
 * (the structural/excluded exemption union) live in
 * `stage6-dispatch-validation.js`, which may import freely.
 *
 * SCOPE, stated because it is narrower than it looks: this predicate is
 * about an EXPLICIT blank STRING the model chose to send. An omitted or
 * `null` argument is not a blank write — it keeps today's leave-unchanged or
 * default behaviour at every site, which is what `create_circuit` without a
 * `designation` has always meant.
 */

/**
 * True when `value` is a string that trims to nothing — `''`, `'   '`,
 * `'\t\n'`. Non-strings (numbers, null, undefined, objects) are NOT blank
 * writes: they are either legitimate typed inputs or a different rejection
 * class that the existing type validators already own.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isBlankWrite(value) {
  return typeof value === 'string' && value.trim() === '';
}

/**
 * The single rejection code every blank-write boundary returns. Bounded on
 * purpose: the Phase-7 analyzer groups by validation code, so one code per
 * defect class keeps the dashboards readable. The tool result additionally
 * names the CLEAR tool that can legitimately empty that field, so the model's
 * next move is the supported one rather than another blank.
 */
export const EMPTY_WRITE_REJECTION_CODE = 'empty_write_not_allowed';

/**
 * Board fields on which a blank string is a LEGITIMATE written value rather
 * than a silent clear — i.e. a select field whose option list includes `""`,
 * that is routable to a client, and that neither `classifyBoardClear` /
 * `BOARD_CLEAR_SCOPE_MAP` (board fields) nor `clear_reading` (circuit fields)
 * can clear. Such a field would become UNCLEARABLE if the blank predicate
 * rejected it, so it is allowed through.
 *
 * COMMITTED EMPTY, AND KEPT HONEST BY A TEST, NOT BY HAND. The derivation is
 * re-run in `tests/stage6-blank-write-allowlist.test.js` against the live
 * field schema and route manifests; the test fails if the derived set differs
 * from this constant. Today the derived set is empty — `board_type` and
 * `is_distribution_circuit`, the two candidates, are both in
 * `STRUCTURAL_READING_FIELDS` and are intercepted by the structural refusal
 * long before the value stage. The constant exists so that the day a schema
 * change creates a real member, the test says so instead of a field silently
 * becoming unclearable in production.
 *
 * @type {ReadonlySet<string>}
 */
export const BLANK_WRITE_ALLOWED_FIELDS = Object.freeze(new Set([]));
