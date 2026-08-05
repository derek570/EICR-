/**
 * Plan 00B-4 C1a — the CLOSED semantic-mismatch discriminator vocabulary.
 *
 * `semantic-judge.mjs` returns a free-form-BEARING failure list: each entry is
 * `{ class, expected, actual }` where `expected`/`actual` carry raw field
 * values, transcript fragments and circuit text. NONE of that may reach an
 * append-only evidence row. What DOES cross the executor→runner boundary is
 * the `class` discriminator alone, and only if it is a member of this list.
 *
 * Why the vocabulary lives HERE rather than inside the judge: the judge is an
 * enumerated `SEMANTIC_ORACLE_INPUTS` row, so adding an exported constant to
 * it would move `semantic_oracle_digest` and force a re-attestation of the
 * whole cohort — for a change that cannot alter a single verdict. This module
 * is deliberately NOT enumerated, and is pure data with no imports so it can
 * never acquire behaviour that ought to have been attested.
 *
 * The list is FROZEN and CLOSED. An unknown kind is REJECTED at the evidence
 * boundary rather than persisted: a judge that grows a failure class without
 * declaring it here fails loudly at mint time instead of writing an
 * unclassifiable mismatch into a stream that cannot be rewritten. The drift
 * test in `plan00-evidence.test.js` source-scans the judge so that failure is
 * caught in CI rather than on a live vendor-lane run that has already spent
 * provider money.
 *
 * Membership was derived from ALL emission sites in `semantic-judge.mjs`:
 * every static `class: '<literal>'` push, plus the three failure `reason`s
 * returned by `matchOperation` (forwarded dynamically as
 * `mismatches.push({ class: res.reason, ... })`). `composeCaptureInvalid`
 * reasons are deliberately ABSENT — they produce `INVALID_HOLD` verdicts with
 * an EMPTY mismatch list, so they are invalid-attempt reasons, not mismatch
 * kinds, and conflating the two would let an unusable capture masquerade as a
 * decidable semantic failure.
 */

export const SEMANTIC_MISMATCH_KINDS = Object.freeze([
  'ask_missing',
  'ask_not_answered',
  'audibility_count_mismatch',
  'audibility_mandate_missing',
  'clear_without_matching_write',
  'extra_mutation',
  'field_cleared_receipt_mismatch',
  'operation_missing',
  'playback_proof_missing',
  'undeclared_ask',
  'undeclared_audible',
  'undeclared_delivery',
  'wrong_value',
]);

export function isKnownMismatchKind(kind) {
  return typeof kind === 'string' && SEMANTIC_MISMATCH_KINDS.includes(kind);
}
