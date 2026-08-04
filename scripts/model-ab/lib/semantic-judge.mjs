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

/**
 * Plan 00B-2 C4 — the frozen-evidence judge adapter. Reads EXCLUSIVELY from
 * the C3 chokepoint-latched `frozen` completion latch (never
 * `frozen.candidate`, never the live ledgers) and normalises mutation
 * receipts, emitted ask lifecycles, operation-backed delivery/playback
 * evidence and non-operation audible frames into a per-sample verdict.
 *
 * captureInvalid composes from: an ineligible freeze, mutation-observer
 * invalids, ask-ledger invalids, delivery-ledger invalids, unfinished
 * producers and unconsumed fast-TTS reservations/provisionals.
 */
export function judgeFrozenEvidence(expectation, frozen, opts = {}) {
  const invalid = composeCaptureInvalid(frozen);
  if (invalid) {
    return { verdict: 'INVALID_HOLD', reason: invalid.reason, mismatches: [] };
  }
  const ev = frozen.evidence;
  const mismatches = [];

  // ── operations, over the receipts (index-consumed, §B2 extra sweep) ──
  const receipts = ev.receipts ?? [];
  const consumed = new Set();
  for (const turn of expectation.turns ?? []) {
    for (const op of turn.operations ?? []) {
      const res = matchOperation(op, receipts, consumed, opts);
      if (!res.matched) {
        mismatches.push({ class: res.reason, expected: op, actual: res.actual ?? null });
      }
    }
  }

  // ── audible outputs, per projected kind/count/field/circuit/text ──
  const deliveries = ev.deliveries ?? [];
  const consumedDeliveries = new Set();
  // Two-tier evidence boundary (00B-2 C2): the corpus gate carries the FULL
  // semantic contract for TIER-1 (dispatcher/pending-value) asks only. A
  // Tier-2 dialogue-script/address-mirror ask (e.g. the IR script's
  // follow-up slot ask auto-entered from a Sonnet write) is proven by the
  // focused real-ingress integration tests, never counted here.
  const emittedAsks = (ev.ask_entries ?? []).filter(
    (e) => e.state !== 'produced' && (e.meta?.family ?? 'dispatcher') === 'dispatcher'
  );
  let declaredAskCount = 0;

  const parseOpKey = (key) => {
    try {
      return JSON.parse(key);
    } catch {
      return null;
    }
  };
  const deliveryMatches = (d, match) => {
    if (match?.text_exact != null) return d.text === match.text_exact;
    if (match?.field != null) {
      return (d.op_keys ?? []).some((k) => {
        const id = parseOpKey(k);
        return (
          id &&
          id.field === match.field &&
          (match.circuit === undefined || (id.circuit ?? null) === (match.circuit ?? null))
        );
      });
    }
    return true;
  };
  const playbackFor = (d) =>
    (ev.playbacks ?? []).filter((p) => (d.op_keys ?? [d.op_key]).includes(p.op_key));

  for (const turn of expectation.turns ?? []) {
    for (const audible of turn.audible_outputs ?? []) {
      if (audible.kind === 'ask_user') {
        declaredAskCount += audible.count ?? 1;
        if (emittedAsks.length < (audible.count ?? 1)) {
          mismatches.push({
            class: 'ask_missing',
            expected: { kind: 'ask_user', count: audible.count ?? 1 },
            actual: emittedAsks.length,
          });
        }
        continue;
      }
      if (audible.kind === 'field_null_fallback') {
        const rows = (ev.non_mutating_audible ?? []).filter((r) =>
          audible.match?.text_exact != null ? r.text === audible.match.text_exact : true
        );
        if (rows.length !== (audible.count ?? 1)) {
          mismatches.push({
            class: 'audibility_count_mismatch',
            expected: { kind: audible.kind, match: audible.match, count: audible.count ?? 1 },
            actual: rows.length,
          });
        }
        continue;
      }
      // reading_confirmation (and any operation-backed spoken kind): match
      // delivery rows, consume them, and require EXACTLY ONE authoritative
      // playback start per audibility-mandatory expectation.
      const rows = deliveries.filter(
        (d, i) => !consumedDeliveries.has(i) && deliveryMatches(d, audible.match)
      );
      if (rows.length !== (audible.count ?? 1)) {
        mismatches.push({
          class: 'audibility_count_mismatch',
          expected: { kind: audible.kind, match: audible.match, count: audible.count ?? 1 },
          actual: rows.length,
        });
        continue;
      }
      for (const row of rows) {
        consumedDeliveries.add(deliveries.indexOf(row));
        const starts = playbackFor(row);
        if (starts.length !== 1) {
          mismatches.push({
            class: 'playback_proof_missing',
            expected: { kind: audible.kind, match: audible.match, playback_starts: 1 },
            actual: starts.length,
          });
        }
        // C4 field_cleared narrow rule: the frozen v1 schema has no
        // clear-op shape, so the matched clear confirmation's descriptor
        // must identify EXACTLY ONE same-turn authoritative clear receipt,
        // then consumed for the extra-mutation sweep.
        if (audible.match?.field === 'field_cleared') {
          const clearIdx = [];
          for (let i = 0; i < receipts.length; i += 1) {
            if (consumed.has(i)) continue;
            if (receipts[i].kind === 'clear' || receipts[i].kind === 'board_clear') {
              clearIdx.push(i);
            }
          }
          if (clearIdx.length !== 1) {
            mismatches.push({
              class: 'field_cleared_receipt_mismatch',
              expected: { authoritative_clear_receipts: 1 },
              actual: clearIdx.length,
            });
          } else {
            consumed.add(clearIdx[0]);
          }
        }
      }
    }
  }

  // Undeclared extra ASKS fail the sample.
  if (emittedAsks.length > declaredAskCount) {
    mismatches.push({
      class: 'undeclared_ask',
      expected: { emitted_asks: declaredAskCount },
      actual: emittedAsks.length,
    });
  }

  // §B2 extra-mutation sweep over the un-consumed receipts.
  for (let i = 0; i < receipts.length; i += 1) {
    if (consumed.has(i)) continue;
    const r = receipts[i];
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

/** Compose the C4 captureInvalid latch from a completion freeze. */
export function composeCaptureInvalid(frozen) {
  if (!frozen) return { reason: 'no_completion_freeze' };
  if (frozen.eligible !== true) return { reason: frozen.reason ?? 'freeze_ineligible' };
  const ev = frozen.evidence;
  if (!ev) return { reason: 'no_frozen_evidence' };
  if (ev.mutation_invalid) return { reason: `mutation_invalid:${ev.mutation_invalid.reason}` };
  if (ev.ask_invalid) return { reason: `ask_invalid:${ev.ask_invalid.reason}` };
  if (ev.delivery_invalid) return { reason: `delivery_invalid:${ev.delivery_invalid.reason}` };
  if (ev.producer_invalid) return { reason: `producer_invalid:${ev.producer_invalid.reason}` };
  const busy = Object.entries(ev.producer_counts ?? {}).filter(([, v]) => v !== 0);
  if (busy.length > 0) return { reason: `unfinished_producer:${busy[0][0]}` };
  const unconsumed = (ev.provisionals ?? []).filter((p) => p.resolved_op_key == null);
  if (unconsumed.length > 0) return { reason: 'fast_provisional_unconsumed' };
  return null;
}
