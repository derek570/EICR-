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
function matchOperation(expected, receipts, consumed, { boardWildcard = false } = {}) {
  const matchesSlot = (r) =>
    r.field === expected.field &&
    (r.circuit ?? null) === (expected.circuit ?? null) &&
    (boardWildcard ||
      expected.board_id == null ||
      r.board_id == null ||
      r.board_id === expected.board_id);

  for (let i = 0; i < receipts.length; i += 1) {
    if (consumed.has(i)) continue;
    const r = receipts[i];
    if (!matchesSlot(r)) continue;
    if (expected.state_transition === 'clear_then_write') {
      if (r.kind === 'clear') {
        // explicit clear — the write must follow on the same slot.
        for (let j = i + 1; j < receipts.length; j += 1) {
          if (consumed.has(j)) continue;
          const w = receipts[j];
          if (matchesSlot(w) && w.kind === 'reading' && norm(w.value) === norm(expected.value)) {
            consumed.add(i);
            consumed.add(j);
            return { matched: true, via: 'clear_then_write' };
          }
        }
        return { matched: false, reason: 'clear_without_matching_write' };
      }
      if (r.kind === 'reading' && norm(r.value) === norm(expected.value)) {
        // plain overwrite — valid per the pinned-IR rule.
        consumed.add(i);
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
    consumed.add(i);
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
  // Every receipt an expectation legitimately consumes is tracked by INDEX,
  // so an undeclared extra mutation ANYWHERE in the stream — before, between
  // or after expected operations — fails (§B2: undeclared/extra/wrong-target
  // mutations fail). Derived receipts with valid parent provenance ride
  // their parent's expectation.
  const consumed = new Set();

  for (const turn of expectation.turns ?? []) {
    for (const op of turn.operations ?? []) {
      const res = matchOperation(op, receipts, consumed, opts);
      if (!res.matched) {
        mismatches.push({ class: res.reason, expected: op, actual: res.actual ?? null });
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

  for (let i = 0; i < receipts.length; i += 1) {
    if (consumed.has(i)) continue;
    const r = receipts[i];
    // Derived receipts ride their parent; select_board is board navigation
    // that expectations do not declare (the semantic write it enables is
    // what gets judged).
    if (r.parent_operation_id || r.kind === 'select_board') continue;
    mismatches.push({
      class: 'extra_mutation',
      actual: { kind: r.kind, field: r.field, circuit: r.circuit, value: r.value },
    });
  }

  return {
    verdict: mismatches.length === 0 ? 'PASS' : 'FAIL',
    reason: mismatches.length === 0 ? null : mismatches[0].class,
    mismatches,
  };
}
