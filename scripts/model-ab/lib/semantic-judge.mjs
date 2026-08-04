/**
 * Plan 00B §B5 — the trusted semantic judge.
 *
 * Judges ONE model's captured evidence (mutation-commit receipts, ask
 * ledger, audible outputs) against a frozen expectation projection —
 * independently per model; cross-provider agreement is secondary and never
 * a correctness signal. Recorded model rounds can never satisfy a live
 * lane: the judge consumes only evaluation-captured semantics.
 *
 * Verdict classes:
 *   PASS          — every expected operation matched (semantics + order
 *                   where order matters), no undeclared extra mutation,
 *                   audible expectations satisfied.
 *   FAIL          — a semantic mismatch (missing/wrong/extra operation,
 *                   wrong value/slot, audibility violation).
 *   INVALID_HOLD  — capture itself is invalid (observer latched INVALID,
 *                   non-quiescent stop, partial capture). Never compared,
 *                   never counted as pass or fail.
 */

/** Normalise a receipt/expectation value for comparison. */
const norm = (v) => (v == null ? null : String(v));

/**
 * §B5 pinned-IR rule generalised: a `clear_then_write` expectation accepts
 * EITHER a plain overwrite (one reading receipt with the final value) OR an
 * explicit clear followed by the write, provided final semantics and order
 * expectations hold.
 */
function matchOperation(expected, receipts, cursorRef, { boardWildcard = false } = {}) {
  const matchesSlot = (r) =>
    r.field === expected.field &&
    (r.circuit ?? null) === (expected.circuit ?? null) &&
    (boardWildcard || expected.board_id == null || r.board_id == null || r.board_id === expected.board_id);

  for (let i = cursorRef.value; i < receipts.length; i += 1) {
    const r = receipts[i];
    if (!matchesSlot(r)) continue;
    if (expected.state_transition === 'clear_then_write') {
      if (r.kind === 'clear') {
        // explicit clear — the write must follow on the same slot.
        for (let j = i + 1; j < receipts.length; j += 1) {
          const w = receipts[j];
          if (matchesSlot(w) && w.kind === 'reading' && norm(w.value) === norm(expected.value)) {
            cursorRef.value = j + 1;
            return { matched: true, via: 'clear_then_write' };
          }
        }
        return { matched: false, reason: 'clear_without_matching_write' };
      }
      if (r.kind === 'reading' && norm(r.value) === norm(expected.value)) {
        // plain overwrite — valid per the pinned-IR rule.
        cursorRef.value = i + 1;
        return { matched: true, via: 'plain_overwrite' };
      }
      if (r.kind === 'reading') return { matched: false, reason: 'wrong_value', actual: r.value };
      continue;
    }
    // Default kinds: exact kind + value.
    if (r.kind !== (expected.kind ?? 'reading')) continue;
    if (expected.value != null && norm(r.value) !== norm(expected.value)) {
      return { matched: false, reason: 'wrong_value', actual: r.value };
    }
    cursorRef.value = i + 1;
    return { matched: true, via: r.kind };
  }
  return { matched: false, reason: 'operation_missing' };
}

/**
 * Judge one sample.
 *
 * @param {object} expectation — a projectFixtureExpectation() output.
 * @param {object} evidence — {
 *   receipts: mutation-commit receipts (observer.receipts),
 *   captureInvalid: observer.invalid | ledger invalids | freeze ineligibility,
 *   audibleTexts: array of spoken/confirmation texts actually emitted,
 * }
 * @param {object} [opts] — { boardWildcard } (single-board jobs judge with
 *   board wildcard per §B5's pinned IR contract).
 */
export function judgeSample(expectation, evidence, opts = {}) {
  if (evidence.captureInvalid) {
    return {
      verdict: 'INVALID_HOLD',
      reason: evidence.captureInvalid.reason ?? 'capture_invalid',
      mismatches: [],
    };
  }
  const mismatches = [];
  const receipts = evidence.receipts ?? [];
  // Mutation receipts the expectations may legitimately ignore: nothing —
  // every semantic mutation must be expected or explicitly allowlisted.
  const cursor = { value: 0 };
  const matchedReceiptCount = { count: 0 };

  for (const turn of expectation.turns ?? []) {
    for (const op of turn.operations ?? []) {
      const res = matchOperation(op, receipts, cursor, opts);
      if (!res.matched) {
        mismatches.push({ class: res.reason, expected: op, actual: res.actual ?? null });
      } else {
        matchedReceiptCount.count += res.via === 'clear_then_write' ? 2 : 1;
      }
    }
    for (const audible of turn.audible_outputs ?? []) {
      if (audible.match?.text_exact) {
        const hits = (evidence.audibleTexts ?? []).filter((t) => t === audible.match.text_exact);
        if (hits.length !== (audible.count ?? 1)) {
          mismatches.push({
            class: 'audibility_count_mismatch',
            expected: { text: audible.match.text_exact, count: audible.count ?? 1 },
            actual: hits.length,
          });
        }
      }
    }
  }

  // Undeclared EXTRA semantic mutations fail (§B2: undeclared/extra/
  // wrong-target mutations fail) — derived receipts with valid parent
  // provenance ride their parent expectation.
  const unmatched = receipts.filter(
    (r, i) => i >= 0 && !r.parent_operation_id && r.kind !== 'select_board'
  );
  const expectedOpCount = (expectation.turns ?? []).reduce(
    (n, t) => n + (t.operations ?? []).length,
    0
  );
  // Count semantic top-level receipts (clears participating in
  // clear_then_write are part of their expectation).
  if (mismatches.length === 0 && expectedOpCount > 0) {
    const topLevel = unmatched.length;
    const allowed = receipts.length; // matched span
    if (topLevel > 0 && cursor.value < receipts.length) {
      for (let i = cursor.value; i < receipts.length; i += 1) {
        const r = receipts[i];
        if (!r.parent_operation_id) {
          mismatches.push({
            class: 'extra_mutation',
            actual: { kind: r.kind, field: r.field, circuit: r.circuit, value: r.value },
          });
        }
      }
    }
    void allowed;
  }

  return {
    verdict: mismatches.length === 0 ? 'PASS' : 'FAIL',
    reason: mismatches.length === 0 ? null : mismatches[0].class,
    mismatches,
  };
}
