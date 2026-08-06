/**
 * Plan 00B-4 §C1a — the executor→runner translation layer.
 *
 * THE SHAPES DO NOT MATCH, and forwarding one as the other is silently
 * destructive. `judgeSample`/`judgeFrozenEvidence` return
 *
 *     { verdict, reason, mismatches: [{ class, expected, actual }, ...] }
 *
 * — PLURAL, and every entry carries free-form material: `expected`/`actual`
 * hold raw field values, transcript fragments and circuit text, and `reason`
 * is a bare class string with no identity. `runReservedAttempt` consumes a
 * SINGULAR, CLOSED `outcome.mismatch` of exactly
 * `{ mismatch_id, mismatch_kind, safety_critical }`.
 *
 * Handing the judge's object over unchanged does not fail loudly. The runner's
 * normaliser is a whitelist, so it would drop everything it did not name and
 * the attempt would terminate with NO usable mismatch — which the fold reads
 * as `unclassified_mismatch_fail` and turns into an IRREVERSIBLE BLOCK on an
 * append-only stream. A plumbing gap would be indistinguishable from a genuine
 * unclassifiable safety failure. This module is the seam that makes the two
 * different again.
 *
 * Three deliberate scope decisions live here:
 *
 * 1. ONLY THE TERMINAL MISMATCH IS PERSISTED. `fold.mjs` decides exclusively on
 *    the terminal's `mismatch_id`/`safety_critical`, so a list would be dead
 *    weight in the evidence stream while multiplying the surface that must be
 *    PII-checked. The full deduped kind list goes to the RUN CONSOLE, where an
 *    operator debugging a failed lane can see it, and into NO evidence row.
 *
 * 2. TERMINAL SELECTION IS DETERMINISTIC — ordered by `(mismatch_kind, then
 *    the judge's own emission index)` and first wins. Deterministic because a
 *    frozen judge result must yield the same `mismatch_id` on every run: the
 *    id is content-addressed, and a selection that varied would mint a new id
 *    for the same failure and strand the `decide-mismatch` record Derek had
 *    already published against the old one.
 *
 * 3. `mismatch_id` AND `mismatch_kind` ARE TWO DIFFERENT THINGS. The id is an
 *    OPAQUE deterministic identity minted from PII-free attempt identity
 *    (cohort + requirement + generation + the closed discriminator), unique
 *    within a cohort per (requirement, generation) and validated STRUCTURALLY
 *    only — no validator can recompute it, because a stored report carries
 *    neither the cohort id nor the discriminator. The kind is the judge's
 *    closed discriminator persisted verbatim beside it, and is the field the
 *    closed vocabulary governs.
 *
 * NOTHING free-form leaves this module. The judge's `reason` and every
 * `expected`/`actual` are dropped here; the returned `reason` is always a
 * closed literal, because the runner persists it verbatim as `invalid_reason`.
 */

import { createHash } from 'node:crypto';

import { classifyFixtureSafety } from '../../model-ab/lib/expectation-projection.mjs';
import { MISMATCH_KINDS } from './constants.mjs';

/** Hex length of a minted mismatch id. Fixed so the structural validator has a
 *  shape to check without needing the inputs the id was minted from. */
export const MISMATCH_ID_LENGTH = 32;

const MISMATCH_ID_PATTERN = new RegExp(`^[0-9a-f]{${MISMATCH_ID_LENGTH}}$`);

/** CLOSED translation reasons. Persisted verbatim as `invalid_reason`, so this
 *  list is the whole of what this layer may ever say about a failure. */
export const TRANSLATION_REASONS = Object.freeze([
  'judge_result_malformed',
  'judge_pass_with_mismatch',
  'judge_mismatch_unmappable',
  'judge_invalid_hold',
]);

export function isWellFormedMismatchId(id) {
  return typeof id === 'string' && MISMATCH_ID_PATTERN.test(id);
}

/**
 * Mint the opaque deterministic mismatch id. Inputs are PII-free by
 * construction: a cohort id, a requirement key, an integer generation and a
 * member of the closed kind vocabulary. Including the generation is what makes
 * a RETRY of the same requirement a DIFFERENT mismatch — a decision Derek made
 * about generation 1 must not silently pre-clear generation 2's failure.
 */
export function mintMismatchId({ cohortId, requirementKey, attemptGeneration, mismatchKind }) {
  const material = JSON.stringify([
    'plan00.mismatch.v1',
    String(cohortId ?? ''),
    String(requirementKey ?? ''),
    Number.isInteger(attemptGeneration) ? attemptGeneration : -1,
    String(mismatchKind ?? ''),
  ]);
  return createHash('sha256').update(material).digest('hex').slice(0, MISMATCH_ID_LENGTH);
}

/** Stable, PII-free, deduped kind list for the RUN CONSOLE only. Unknown kinds
 *  are included precisely BECAUSE they are the thing an operator needs to see
 *  when a run terminates unmappable — they simply never reach evidence. */
function consoleKinds(mismatches) {
  const seen = new Set();
  for (const mm of mismatches) {
    const cls = mm?.class;
    if (typeof cls === 'string' && cls.length > 0) seen.add(cls);
  }
  return [...seen].sort();
}

/**
 * Translate a judge result into the runner's closed executor outcome.
 *
 * `corpusId` resolves `safety_critical` from the ATTESTED C4 per-fixture
 * classification rather than from anything the judge said — the judge does not
 * know, and cannot know, whether the fixture it just failed mutates a
 * certificate. `classifyFixtureSafety` fails closed, so an unlisted or
 * unclassified fixture is treated as safety-critical and BLOCKS.
 *
 * @returns {{verdict: string, reason: string|null, mismatch: object|null, mismatchKinds: string[]}}
 */
export function translateJudgeResult(
  judgeResult,
  { cohortId, requirementKey, attemptGeneration, corpusId }
) {
  if (!judgeResult || typeof judgeResult !== 'object' || Array.isArray(judgeResult)) {
    return {
      verdict: 'INVALID',
      reason: 'judge_result_malformed',
      mismatch: null,
      mismatchKinds: [],
    };
  }
  const mismatches = Array.isArray(judgeResult.mismatches) ? judgeResult.mismatches : [];
  const mismatchKinds = consoleKinds(mismatches);

  if (judgeResult.verdict === 'PASS') {
    // A PASS carrying mismatches is a contradiction in the judge's own output.
    // It is INVALID rather than silently downgraded to FAIL: an attempt whose
    // producer contradicted itself has not measured anything, and INVALID is
    // the only verdict that can be retried at the next generation.
    if (mismatches.length > 0) {
      return {
        verdict: 'INVALID',
        reason: 'judge_pass_with_mismatch',
        mismatch: null,
        mismatchKinds,
      };
    }
    return { verdict: 'PASS', reason: null, mismatch: null, mismatchKinds: [] };
  }

  if (judgeResult.verdict !== 'FAIL') {
    // INVALID_HOLD and anything else. The judge's own reason is free-form
    // (`mutation_invalid:<detail>`, `unfinished_producer:<id>`), so it is
    // dropped and replaced with the closed literal; the detail is console-only.
    return { verdict: 'INVALID', reason: 'judge_invalid_hold', mismatch: null, mismatchKinds };
  }

  const classified = [];
  for (let i = 0; i < mismatches.length; i += 1) {
    const cls = mismatches[i]?.class;
    if (typeof cls === 'string' && MISMATCH_KINDS.includes(cls)) {
      classified.push({ kind: cls, index: i });
    }
  }
  if (classified.length === 0) {
    // A FAIL we cannot classify STAYS A FAIL. Downgrading it to INVALID would
    // let a real semantic failure be retried away at the next generation; the
    // fold's `unclassified_mismatch_fail` BLOCK is the correct fail-closed
    // outcome, and the console list names the kinds the judge actually emitted
    // so the vocabulary gap is fixable.
    return {
      verdict: 'FAIL',
      reason: 'judge_mismatch_unmappable',
      mismatch: null,
      mismatchKinds,
    };
  }
  classified.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.index - b.index));
  const terminal = classified[0];

  return {
    verdict: 'FAIL',
    reason: null,
    mismatch: {
      mismatch_id: mintMismatchId({
        cohortId,
        requirementKey,
        attemptGeneration,
        mismatchKind: terminal.kind,
      }),
      mismatch_kind: terminal.kind,
      safety_critical: classifyFixtureSafety(corpusId),
    },
    mismatchKinds,
  };
}
