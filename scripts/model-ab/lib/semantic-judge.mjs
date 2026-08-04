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
function matchOperation(expected, receipts, consumed, { boardWildcard = false } = {}, eligible = null) {
  // Codex r3 finding 2 + mini-review r3 — board identity is EXACT outside
  // the single-board wildcard: a board-null receipt never satisfies board
  // `main`, and an UNSCOPED expectation never absorbs a `sub-a` receipt
  // (both are wrong credit in multi-board evidence). The wildcard ignores
  // board entirely (single-board jobs, §B5 pinned IR contract).
  const matchesSlot = (r) =>
    r.field === expected.field &&
    (r.circuit ?? null) === (expected.circuit ?? null) &&
    (boardWildcard || (expected.board_id ?? null) === (r.board_id ?? null));

  for (let i = 0; i < receipts.length; i += 1) {
    if (consumed.has(i)) continue;
    // Codex r2 finding 6 — turn membership: when the driver supplies the
    // per-turn extraction turn ids, an expectation only matches receipts
    // committed in ITS OWN turn (cross-turn identity beats index order).
    if (eligible && !eligible(i)) continue;
    const r = receipts[i];
    if (!matchesSlot(r)) continue;
    if (expected.state_transition === 'clear_then_write') {
      if (r.kind === 'clear') {
        // explicit clear — the write must follow on the same slot.
        for (let j = i + 1; j < receipts.length; j += 1) {
          if (consumed.has(j)) continue;
          if (eligible && !eligible(j)) continue;
          const w = receipts[j];
          if (matchesSlot(w) && w.kind === 'reading' && norm(w.value) === norm(expected.value)) {
            consumed.add(i);
            consumed.add(j);
            // Only the WRITE is the audible half of a clear_then_write —
            // the collapsed clear itself is designed-silent, so the op's
            // audibility mandate binds to the write receipt alone.
            return { matched: true, via: 'clear_then_write', indices: [i, j], audibleIndices: [j] };
          }
        }
        return { matched: false, reason: 'clear_without_matching_write' };
      }
      if (r.kind === 'reading' && norm(r.value) === norm(expected.value)) {
        // plain overwrite — valid per the pinned-IR rule.
        consumed.add(i);
        return { matched: true, via: 'plain_overwrite', indices: [i] };
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
    return { matched: true, via: r.kind, indices: [i] };
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
  const invalid = composeCaptureInvalid(frozen, {
    windowedOpenAskFamilies: opts.windowedOpenAskFamilies ?? [],
  });
  if (invalid) {
    return { verdict: 'INVALID_HOLD', reason: invalid.reason, mismatches: [] };
  }
  const ev = frozen.evidence;
  const mismatches = [];

  // Turn membership (Codex r2 finding 6): the driver supplies each fixture
  // turn's extraction turn id; receipts, deliveries and the field_cleared
  // narrow rule then judge turn-exactly. Without the map (unit tests,
  // legacy callers) matching stays whole-capture.
  const turnIds = Array.isArray(opts.turnIds) ? opts.turnIds : null;

  // ── operations, over the receipts (index-consumed, §B2 extra sweep) ──
  const receipts = ev.receipts ?? [];
  const consumed = new Set();
  // Codex r3 finding 1 — per-receipt audibility from the DECLARED op, so
  // the implied-declared delivery exemption still enforces the op's own
  // exactly-once playback mandate when the projection carries no explicit
  // audible_outputs row for it.
  const receiptAudibility = new Map();
  const turns = expectation.turns ?? [];
  for (let t = 0; t < turns.length; t += 1) {
    const eligible =
      turnIds && turnIds[t] != null
        ? (i) => (receipts[i].extraction_turn_id ?? null) === turnIds[t]
        : null;
    for (const op of turns[t].operations ?? []) {
      const res = matchOperation(op, receipts, consumed, opts, eligible);
      if (!res.matched) {
        mismatches.push({ class: res.reason, expected: op, actual: res.actual ?? null });
      } else if (Array.isArray(res.indices)) {
        for (const idx of res.audibleIndices ?? res.indices) {
          receiptAudibility.set(idx, op.audibility ?? null);
        }
      }
    }
  }

  // ── audible outputs, per projected kind/count/field/circuit/text ──
  const deliveries = ev.deliveries ?? [];
  const consumedDeliveries = new Set();
  const consumedNonMutating = new Set();
  // Two-tier evidence boundary (00B-2 C2): the corpus gate carries the FULL
  // semantic contract for TIER-1 (dispatcher/pending-value) asks only. A
  // Tier-2 dialogue-script/address-mirror ask (e.g. the IR script's
  // follow-up slot ask auto-entered from a Sonnet write) is proven by the
  // focused real-ingress integration tests, never counted here.
  //
  // Codex r2 finding 3 — only entries whose history proves a REAL emission
  // count (a produced-only row never crossed the wire), and every expected
  // ask CONSUMES entries so one emitted ask can never satisfy two
  // expectations.
  const emittedAsks = (ev.ask_entries ?? []).filter(
    (e) =>
      (e.meta?.family ?? 'dispatcher') === 'dispatcher' &&
      Array.isArray(e.history) &&
      e.history.includes('emitted')
  );
  const consumedAsks = new Set();

  const parseOpKey = (key) => {
    try {
      return JSON.parse(key);
    } catch {
      return null;
    }
  };
  // Codex r2 finding 5 — text_exact NO LONGER short-circuits: when a
  // matcher carries both text and field terms, BOTH must hold. Turn scoping
  // applies through the op_keys' embedded turn when available.
  const deliveryMatches = (d, match, expectedTurnId) => {
    if (match?.text_exact != null && d.text !== match.text_exact) return false;
    const keys = d.op_keys ?? (d.op_key ? [d.op_key] : []);
    // Mini-review r2 finding 6 — when a field term is present, ONE key must
    // satisfy BOTH the turn and field/circuit terms (a multi-key unit could
    // otherwise pass the turn test with one key and the field test with
    // another).
    if (match?.field != null) {
      return keys.some((k) => {
        const id = parseOpKey(k);
        if (!id) return false;
        if (expectedTurnId != null && id.turn != null && id.turn !== expectedTurnId) return false;
        return (
          id.field === match.field &&
          (match.circuit === undefined || (id.circuit ?? null) === (match.circuit ?? null))
        );
      });
    }
    if (expectedTurnId != null) {
      const anyTurnKnown = keys.some((k) => parseOpKey(k)?.turn != null);
      if (anyTurnKnown && !keys.some((k) => parseOpKey(k)?.turn === expectedTurnId)) return false;
    }
    return true;
  };
  const playbackFor = (d) =>
    (ev.playbacks ?? []).filter((p) => (d.op_keys ?? [d.op_key]).includes(p.op_key));

  for (let t = 0; t < turns.length; t += 1) {
    const expectedTurnId = turnIds ? (turnIds[t] ?? null) : null;
    for (const audible of turns[t].audible_outputs ?? []) {
      if (audible.kind === 'ask_user') {
        const want = audible.count ?? 1;
        // Codex r4 finding 1 — a turn that DECLARES its answer requires the
        // consumed ask to have reached the ANSWERED terminal: crediting a
        // ['produced','emitted','timeout'] entry against a declared-answer
        // expectation would pass a broken answer ingress. Turns without
        // declared answers accept any genuinely emitted ask (fixtures may
        // legitimately let an ask time out).
        const requireAnswered = (turns[t].ask_answers ?? []).length > 0;
        // Mini-review r4 finding 1 — MONOTONIC assignment: each expectation
        // consumes the NEXT unconsumed entry (never skips), then validates
        // the ASSIGNED entry's terminal. Skipping let a later turn's
        // answered entry be swapped into an earlier declared-answer turn
        // while the earlier timeout drifted to the answerless turn.
        let taken = 0;
        for (let i = 0; i < emittedAsks.length && taken < want; i += 1) {
          if (consumedAsks.has(i)) continue;
          consumedAsks.add(i);
          taken += 1;
          if (requireAnswered && emittedAsks[i].state !== 'answered') {
            mismatches.push({
              class: 'ask_not_answered',
              expected: { kind: 'ask_user', answered_required: true },
              actual: { state: emittedAsks[i].state },
            });
          }
        }
        if (taken < want) {
          mismatches.push({
            class: 'ask_missing',
            expected: { kind: 'ask_user', count: want, answered_required: requireAnswered },
            actual: taken,
          });
        }
        continue;
      }
      if (audible.kind === 'field_null_fallback') {
        // Codex r2 finding 4 — CONSUME matched rows so the undeclared-
        // audible sweep below sees only genuine leftovers.
        const rowsAll = ev.non_mutating_audible ?? [];
        const want = audible.count ?? 1;
        let taken = 0;
        for (let i = 0; i < rowsAll.length && taken < want; i += 1) {
          if (consumedNonMutating.has(i)) continue;
          if (audible.match?.text_exact != null && rowsAll[i].text !== audible.match.text_exact) {
            continue;
          }
          consumedNonMutating.add(i);
          taken += 1;
        }
        if (taken !== want) {
          mismatches.push({
            class: 'audibility_count_mismatch',
            expected: { kind: audible.kind, match: audible.match, count: want },
            actual: taken,
          });
        }
        continue;
      }
      // reading_confirmation (and any operation-backed spoken kind): match
      // delivery rows, consume them, and require EXACTLY ONE authoritative
      // playback start per audibility-mandatory expectation.
      const rows = deliveries.filter(
        (d, i) => !consumedDeliveries.has(i) && deliveryMatches(d, audible.match, expectedTurnId)
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
        // C4 field_cleared narrow rule (Codex r2 finding 5): the matched
        // clear confirmation's descriptor must identify EXACTLY ONE
        // authoritative clear receipt from the SAME turn (when turn ids are
        // known) and a compatible circuit — a prior-turn clear of another
        // target can never satisfy it.
        if (audible.match?.field === 'field_cleared') {
          const descriptorCircuit = (() => {
            const keys = row.op_keys ?? (row.op_key ? [row.op_key] : []);
            for (const k of keys) {
              const id = parseOpKey(k);
              if (id && id.field === 'field_cleared') return id.circuit ?? null;
            }
            return null;
          })();
          // Mini-review r2 finding 5 — the wire dedupe_token
          // (`clear_<field>_<circuit|board>_<turnId>_ord<N>`) is the only
          // structured carrier of WHICH field was cleared; a same-turn
          // clear of a DIFFERENT field (pfc vs ze) must never satisfy the
          // confirmation. Spellings are alias-tolerant (raw
          // `earth_loop_impedance_ze` vs wire `ze`).
          const tokenField = (() => {
            const tok = row.dedupe_token;
            if (typeof tok !== 'string' || !tok.startsWith('clear_')) return null;
            const m = tok.match(/^clear_(.+?)_(?:\d+|board)_.+_ord\d+$/);
            return m ? m[1] : null;
          })();
          const CLEAR_FIELD_ALIASES = new Map([
            ['pfc', 'prospective_fault_current'],
            ['ze', 'earth_loop_impedance_ze'],
          ]);
          const clearFieldCompatible = (receiptField) => {
            if (tokenField == null || receiptField == null) return true;
            if (receiptField === tokenField) return true;
            if (receiptField.endsWith(tokenField) || tokenField.endsWith(receiptField)) return true;
            const alias = CLEAR_FIELD_ALIASES.get(tokenField);
            return alias != null && receiptField === alias;
          };
          const clearIdx = [];
          for (let i = 0; i < receipts.length; i += 1) {
            if (consumed.has(i)) continue;
            const r = receipts[i];
            if (r.kind !== 'clear' && r.kind !== 'board_clear') continue;
            if (
              expectedTurnId != null &&
              (r.extraction_turn_id ?? null) !== expectedTurnId
            ) {
              continue;
            }
            if (
              descriptorCircuit != null &&
              (r.circuit ?? null) !== descriptorCircuit
            ) {
              continue;
            }
            if (!clearFieldCompatible(r.field ?? null)) continue;
            clearIdx.push(i);
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

  // Undeclared extra ASKS fail the sample (consumption-based).
  const leftoverAsks = emittedAsks.filter((_e, i) => !consumedAsks.has(i));
  if (leftoverAsks.length > 0) {
    mismatches.push({
      class: 'undeclared_ask',
      expected: { emitted_asks: consumedAsks.size },
      actual: emittedAsks.length,
    });
  }

  // Codex r2 finding 4 — undeclared AUDIBLE sweep: a delivery or
  // non-mutating audible row no expectation consumed is undeclared speech
  // and fails the sample exactly like an undeclared mutation.
  //
  // IMPLIED-DECLARED exemption: a delivery whose op_keys ALL reference
  // receipts consumed by DECLARED operation expectations is the read-back
  // of a declared write — under Audio-First every applied reading is read
  // back exactly once, so the projection does not (and need not) duplicate
  // each operation as an audible row. A delivery backing any UNDECLARED
  // receipt still fails.
  const consumedReceiptIdx = [...consumed];
  // Mini-review r2 finding 4 — the exemption carries CARDINALITY: each
  // consumed receipt vouches for AT MOST ONE undeclared delivery (a second
  // duplicate read-back of the same operation is undeclared speech), and
  // board identity participates in the reconciliation.
  const impliedClaimedReceipts = new Set();
  const findBackingReceipt = (key) => {
    const id = parseOpKey(key);
    if (!id) return -1;
    return consumedReceiptIdx.findIndex((i) => {
      if (impliedClaimedReceipts.has(i)) return false;
      const r = receipts[i];
      return (
        r.field === id.field &&
        (r.circuit ?? null) === (id.circuit ?? null) &&
        (r.board_id ?? null) === (id.board_id ?? null) &&
        ((r.extraction_turn_id ?? null) === (id.turn ?? null) || id.turn == null) &&
        ((r.turn_ordinal ?? 0) === (id.ordinal ?? 0) || id.ordinal == null)
      );
    });
  };
  for (let i = 0; i < deliveries.length; i += 1) {
    if (consumedDeliveries.has(i)) continue;
    const keys = deliveries[i].op_keys ?? (deliveries[i].op_key ? [deliveries[i].op_key] : []);
    if (keys.length > 0) {
      const backing = keys.map(findBackingReceipt);
      if (backing.every((idx) => idx >= 0)) {
        const receiptIndices = backing.map((idx) => consumedReceiptIdx[idx]);
        for (const idx of receiptIndices) impliedClaimedReceipts.add(idx);
        // Codex r3 finding 1 — the implied read-back of an
        // audibility-MANDATORY op still requires its exactly-once playback
        // proof; the exemption covers the DECLARATION, never the mandate.
        if (receiptIndices.some((idx) => receiptAudibility.get(idx) === 'exactly_once')) {
          const starts = playbackFor(deliveries[i]);
          if (starts.length !== 1) {
            mismatches.push({
              class: 'playback_proof_missing',
              expected: { implied_for: 'exactly_once_operation', playback_starts: 1 },
              actual: starts.length,
            });
          }
        }
        continue;
      }
    }
    mismatches.push({
      class: 'undeclared_delivery',
      actual: { kind: deliveries[i].kind ?? null, text: deliveries[i].text ?? null },
    });
  }
  for (let i = 0; i < (ev.non_mutating_audible ?? []).length; i += 1) {
    if (consumedNonMutating.has(i)) continue;
    const r = ev.non_mutating_audible[i];
    mismatches.push({
      class: 'undeclared_audible',
      actual: { kind: r.kind ?? null, channel: r.channel ?? null, text: r.text ?? null },
    });
  }

  // Mini-review r3 finding 1 — EXISTENCE half of the audibility mandate:
  // an exactly_once operation whose receipt has NO delivery row at all is
  // a silently-written reading (Audio-First #1's zero-times direction) —
  // the per-delivery playback checks above can only fire when a delivery
  // exists.
  const receiptHasDelivery = (r) =>
    deliveries.some((d) => {
      const keys = d.op_keys ?? (d.op_key ? [d.op_key] : []);
      return keys.some((k) => {
        const id = parseOpKey(k);
        return (
          id &&
          id.field === r.field &&
          (id.circuit ?? null) === (r.circuit ?? null) &&
          (id.board_id ?? null) === (r.board_id ?? null) &&
          ((r.extraction_turn_id ?? null) === (id.turn ?? null) ||
            id.turn == null ||
            r.extraction_turn_id == null) &&
          ((r.turn_ordinal ?? 0) === (id.ordinal ?? 0) || id.ordinal == null)
        );
      });
    });
  for (const [idx, aud] of receiptAudibility) {
    if (aud !== 'exactly_once') continue;
    if (!receiptHasDelivery(receipts[idx])) {
      mismatches.push({
        class: 'audibility_mandate_missing',
        expected: { audibility: 'exactly_once', deliveries: 1 },
        actual: { field: receipts[idx].field, circuit: receipts[idx].circuit ?? null },
      });
    }
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

/**
 * Plan 00B-3 C2 — windowed-judging carve-out for OPEN-TIER-2-ASK-ONLY
 * non-quiescence. The C2 quiescence fold makes an ask still open at the
 * stop boundary freeze the completion INELIGIBLE (counts.open_asks_*),
 * which is exactly what 00C's completion fold must consume (it reads the
 * counts directly and its "non_quiescent_at_stop is always
 * evidence-ineligible" rule is UNCHANGED). The recorded corpus, however,
 * judges a declared TURN WINDOW, and dialogue-script asks live OUTSIDE the
 * corpus's observation boundary (the dialogue_answer_ingress exclusion —
 * a fixture cannot even declare the trailing script ask its transcript
 * provokes). An emitted-but-unresolved ask is a STABLE state waiting on a
 * human — unlike an in-flight extraction/producer it cannot mutate the
 * judged evidence — so when the ONLY non-quiescence is open_asks_* (every
 * other count zero, revisions stable) the windowed judge proceeds to the
 * ordinary evidence checks instead of holding.
 */
function isOpenAskOnlyNonQuiescence(frozen, windowedOpenAskFamilies) {
  if (!Array.isArray(windowedOpenAskFamilies) || windowedOpenAskFamilies.length === 0) {
    // Codex r1 (B-2/C-4) — STRICT BY DEFAULT: the carve-out exists only for
    // callers that explicitly declare which ask families live outside their
    // observation window. Every other consumer (00C's fold reads the counts
    // directly and never calls this) holds on ANY ineligible freeze.
    return false;
  }
  if (frozen?.reason !== 'non_quiescent_at_stop') return false;
  const counts = frozen.counts ?? {};
  if ((counts.revision_instability ?? 0) !== 0) return false;
  let sawOpenAsk = false;
  for (const [key, value] of Object.entries(counts)) {
    if (key === 'non_quiescent_at_stop' || key === 'revision_instability') continue;
    if (key.startsWith('open_asks_')) {
      if (value !== 0) {
        // Only a DECLARED window-external family may be open — a dispatcher
        // ask (or any undeclared family) still holds the judge.
        const family = key.slice('open_asks_'.length);
        if (!windowedOpenAskFamilies.includes(family)) return false;
        sawOpenAsk = true;
      }
      continue;
    }
    if (value !== 0) return false;
  }
  return sawOpenAsk;
}

/** Compose the C4 captureInvalid latch from a completion freeze. */
export function composeCaptureInvalid(frozen, { windowedOpenAskFamilies = [] } = {}) {
  if (!frozen) return { reason: 'no_completion_freeze' };
  if (frozen.eligible !== true && !isOpenAskOnlyNonQuiescence(frozen, windowedOpenAskFamilies)) {
    return { reason: frozen.reason ?? 'freeze_ineligible' };
  }
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
