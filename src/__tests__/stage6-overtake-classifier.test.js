/**
 * Stage 6 Phase 3 Plan 03-04 — classifyOvertake unit tests.
 *
 * WHAT: Locks the pure-function contract for the overtake classifier consumed
 * by Plan 03-08 (handleTranscript). The classifier inspects a user utterance's
 * regex results against the per-session pending-asks registry and returns a
 * verdict — no side effects, no registry mutation.
 *
 * WHY these tests ARE the gate (RED step of the Plan 03-04 TDD pair):
 *   - Open Question #4 resolution: when the utterance has no regex hits, the
 *     fail-safe default is 'user_moved_on'. Letting the user restate is safer
 *     than incorrectly attributing an unrelated utterance as an answer to the
 *     oldest pending ask. These tests lock in that conservative default so a
 *     future drift back to "answers-to-oldest" fails loudly.
 *   - Decision-tree order (exact match > different-field > same-field/different-
 *     circuit > no-regex fallback) is the whole contract. Each branch has at
 *     least one test to pin walk-order.
 *   - Duck-typed pendingAsks interface: the classifier only reads .size and
 *     .entries(). A plain Map-like mock works — no need to stand up the real
 *     registry. Test helper `mockPending` is the minimal shape.
 *
 * NOTE on duplicate-context pending asks: in Phase 3, two pending asks with
 * the same (contextField, contextCircuit) cannot occur — the dispatcher won't
 * re-register an already-pending id, and Phase 5 STA-06 will prevent two asks
 * for the same pair. The "first match wins" iteration order is therefore not
 * business-critical in Phase 3; documented here so Phase 5 knows it's safe to
 * rely on.
 *
 * REQUIREMENT covered: STA-04 (overtake classifier).
 */

import { classifyOvertake } from '../extraction/stage6-overtake-classifier.js';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Build a duck-typed pendingAsks stand-in from an array of [id, entry] pairs.
 * Matches the minimal surface the classifier reads: .size + .entries().
 */
function mockPending(entries) {
  return {
    get size() {
      return entries.length;
    },
    *entries() {
      yield* entries;
    },
  };
}

// -----------------------------------------------------------------------------
// Empty registry
// -----------------------------------------------------------------------------

describe('classifyOvertake — empty registry', () => {
  test('returns no_pending_asks when registry is empty', () => {
    const verdict = classifyOvertake('hello', [{ field: 'ze', circuit: null }], mockPending([]));
    expect(verdict).toEqual({ kind: 'no_pending_asks' });
  });

  test('returns no_pending_asks when pendingAsks is null', () => {
    const verdict = classifyOvertake('hello', [], null);
    expect(verdict).toEqual({ kind: 'no_pending_asks' });
  });
});

// -----------------------------------------------------------------------------
// Exact match → answers
// -----------------------------------------------------------------------------

describe('classifyOvertake — exact (field, circuit) match', () => {
  test('single pending ask (ze, null) + regex hit (ze, null, 0.45) → answers', () => {
    const verdict = classifyOvertake(
      'point four five',
      [{ field: 'ze', circuit: null, value: 0.45 }],
      mockPending([['ask_1', { contextField: 'ze', contextCircuit: null }]])
    );
    expect(verdict).toEqual({
      kind: 'answers',
      toolCallId: 'ask_1',
      userText: 'point four five',
    });
  });

  test('single pending ask (zs, 3) + regex hit (zs, 3, 1.08) → answers', () => {
    const verdict = classifyOvertake(
      'one point oh eight',
      [{ field: 'zs', circuit: 3, value: 1.08 }],
      mockPending([['ask_zs_3', { contextField: 'zs', contextCircuit: 3 }]])
    );
    expect(verdict.kind).toBe('answers');
    expect(verdict.toolCallId).toBe('ask_zs_3');
    expect(verdict.userText).toBe('one point oh eight');
  });

  test('two pending asks, regex matches the second → toolCallId is the second', () => {
    const verdict = classifyOvertake(
      'pfc is point two',
      [{ field: 'pfc', circuit: 2, value: 0.2 }],
      mockPending([
        ['ask_ze', { contextField: 'ze', contextCircuit: null }],
        ['ask_pfc_2', { contextField: 'pfc', contextCircuit: 2 }],
      ])
    );
    expect(verdict.kind).toBe('answers');
    expect(verdict.toolCallId).toBe('ask_pfc_2');
  });

  test('pending ask (ze, null) + multiple regex hits — first exact match wins', () => {
    const verdict = classifyOvertake(
      'ze point four five, zs one',
      [
        { field: 'ze', circuit: null, value: 0.45 },
        { field: 'zs', circuit: null, value: 1.0 },
      ],
      mockPending([['ask_ze', { contextField: 'ze', contextCircuit: null }]])
    );
    // First regex hit matches ze/null → answers returned before the zs hit is
    // evaluated as "new field" in step 2. Locks decision-tree order.
    expect(verdict.kind).toBe('answers');
    expect(verdict.toolCallId).toBe('ask_ze');
  });
});

// -----------------------------------------------------------------------------
// Different-field regex → user_moved_on
// -----------------------------------------------------------------------------

describe('classifyOvertake — different-field regex hit', () => {
  test('pending (ze, null) + regex (zs, 1, 1.08) → user_moved_on', () => {
    const verdict = classifyOvertake(
      'zs circuit one is one oh eight',
      [{ field: 'zs', circuit: 1, value: 1.08 }],
      mockPending([['ask_ze', { contextField: 'ze', contextCircuit: null }]])
    );
    expect(verdict).toEqual({ kind: 'user_moved_on' });
  });

  test('pending (ze, null) + two regex hits, neither matches → user_moved_on', () => {
    const verdict = classifyOvertake(
      'zs one is one oh eight and pfc two is point two',
      [
        { field: 'zs', circuit: 1, value: 1.08 },
        { field: 'pfc', circuit: 2, value: 0.2 },
      ],
      mockPending([['ask_ze', { contextField: 'ze', contextCircuit: null }]])
    );
    expect(verdict.kind).toBe('user_moved_on');
  });

  test('pending (ze, 5) + regex (ze, 3, 0.5) — same field, different circuit → user_moved_on', () => {
    // Documents: contextCircuit equality is required for the "answers" verdict.
    // Field-only match doesn't qualify — that's the whole point of the circuit
    // dimension in (contextField, contextCircuit).
    const verdict = classifyOvertake(
      'ze three is point five',
      [{ field: 'ze', circuit: 3, value: 0.5 }],
      mockPending([['ask_ze_5', { contextField: 'ze', contextCircuit: 5 }]])
    );
    expect(verdict.kind).toBe('user_moved_on');
  });
});

// -----------------------------------------------------------------------------
// No-regex fallback → user_moved_on (Open Question #4 conservative default)
// -----------------------------------------------------------------------------

describe('classifyOvertake — no regex hits (fail-safe default)', () => {
  test('pending ask + empty regex array + short text "yes" → user_moved_on', () => {
    const verdict = classifyOvertake(
      'yes',
      [],
      mockPending([['ask_ze', { contextField: 'ze', contextCircuit: null }]])
    );
    // Conservative default per Open Question #4 — we do NOT assume "yes" answers
    // the oldest pending ask. Caller will rejectAll and let the user restate.
    expect(verdict).toEqual({ kind: 'user_moved_on' });
  });

  test('pending ask + empty regex array + long conversational text → user_moved_on', () => {
    const verdict = classifyOvertake(
      'yeah I think we should probably just move on and come back to that later',
      [],
      mockPending([['ask_ze', { contextField: 'ze', contextCircuit: null }]])
    );
    expect(verdict.kind).toBe('user_moved_on');
  });

  test('pending ask + regexResults undefined → user_moved_on (defensive)', () => {
    const verdict = classifyOvertake(
      'anything',
      undefined,
      mockPending([['ask_ze', { contextField: 'ze', contextCircuit: null }]])
    );
    expect(verdict.kind).toBe('user_moved_on');
  });
});

// -----------------------------------------------------------------------------
// Mixed regex (match + new) → answers wins
// -----------------------------------------------------------------------------

describe('classifyOvertake — mixed match + new field', () => {
  test('pending (ze, null) + regex [(ze, null), (pfc, 1)] → answers (match wins)', () => {
    const verdict = classifyOvertake(
      'ze is point four five and pfc one is point two',
      [
        { field: 'ze', circuit: null, value: 0.45 },
        { field: 'pfc', circuit: 1, value: 0.2 },
      ],
      mockPending([['ask_ze', { contextField: 'ze', contextCircuit: null }]])
    );
    // Decision-tree order: step 1 (exact match) returns BEFORE step 2 (new-
    // field signal) gets a chance. If this ever returns user_moved_on, the
    // walk-order has regressed.
    expect(verdict.kind).toBe('answers');
    expect(verdict.toolCallId).toBe('ask_ze');
  });

  test('pending [(ze,null),(pfc,1)] + regex [(ze,null),(pfc,1)] → answers, first match wins', () => {
    const verdict = classifyOvertake(
      'ze point four five, pfc one point two',
      [
        { field: 'ze', circuit: null, value: 0.45 },
        { field: 'pfc', circuit: 1, value: 0.2 },
      ],
      mockPending([
        ['ask_ze', { contextField: 'ze', contextCircuit: null }],
        ['ask_pfc', { contextField: 'pfc', contextCircuit: 1 }],
      ])
    );
    // Outer loop iterates regex results first; inner loop iterates pending.
    // First regex hit (ze) matches ask_ze → returned before pfc is considered.
    expect(verdict.kind).toBe('answers');
    expect(verdict.toolCallId).toBe('ask_ze');
  });
});

// -----------------------------------------------------------------------------
// Real registry duck-type compatibility
// -----------------------------------------------------------------------------

describe('classifyOvertake — duck-typed pendingAsks interface', () => {
  test('plain Map with .size and .entries() works', () => {
    const map = new Map();
    map.set('ask_ze', { contextField: 'ze', contextCircuit: null });
    const verdict = classifyOvertake(
      'ze point four five',
      [{ field: 'ze', circuit: null, value: 0.45 }],
      map
    );
    expect(verdict.kind).toBe('answers');
    expect(verdict.toolCallId).toBe('ask_ze');
  });
});

// -----------------------------------------------------------------------------
// STA-04c — Shape-aware no-regex branch (Plan 03-11 Task 2, r3 MAJOR remediation)
//
// The original Open Question #4 ruling (no regex → user_moved_on) is correct
// for asks whose answers are numeric / circuit_ref: a bare "yes" or "thinking"
// reply should NOT poison a numeric slot map. BUT for yes_no / free_text
// asks the answer itself is inherently non-regex — "yes", "no", "upstairs
// lighting" will never produce a field regex hit. The 03-10 classifier
// rejected those legitimate answers as abandonment when they arrived
// through the transcript channel (pre-Phase-4 iOS clients or any bug path
// where iOS doesn't route via ask_user_answered).
//
// Fix: when expectedAnswerShape === 'yes_no' or 'free_text' on a pending
// ask AND there are no regex hits, consult the shape to decide:
//   - yes_no: treat yes/no/yeah/nope/etc. as answers
//   - free_text: treat any non-empty trimmed text as an answer
//   - number / circuit_ref / undefined: keep the conservative
//     user_moved_on fallback (wrong numeric attribution >> re-ask cost)
// -----------------------------------------------------------------------------

describe('classifyOvertake — STA-04c shape-aware no-regex branch', () => {
  test("STA-04c-yes: yes_no ask + 'yes' + no regex → answers", () => {
    const verdict = classifyOvertake(
      'yes',
      [],
      mockPending([
        [
          'ask_confirm',
          {
            contextField: 'measured_zs_ohm',
            contextCircuit: 5,
            expectedAnswerShape: 'yes_no',
          },
        ],
      ])
    );
    expect(verdict).toEqual({ kind: 'answers', toolCallId: 'ask_confirm', userText: 'yes' });
  });

  test("STA-04c-no: yes_no ask + 'no' + no regex → answers", () => {
    const verdict = classifyOvertake(
      'no',
      [],
      mockPending([
        [
          'ask_confirm',
          { contextField: null, contextCircuit: null, expectedAnswerShape: 'yes_no' },
        ],
      ])
    );
    expect(verdict.kind).toBe('answers');
    expect(verdict.toolCallId).toBe('ask_confirm');
  });

  test('STA-04c-yes-variants: yes_no ask accepts yeah/yep/nope/correct + trailing punctuation', () => {
    for (const text of ['yeah', 'yep.', 'Nope!', 'Correct', 'negative', '  YES  ']) {
      const verdict = classifyOvertake(
        text,
        [],
        mockPending([
          ['ask_v', { contextField: null, contextCircuit: null, expectedAnswerShape: 'yes_no' }],
        ])
      );
      expect(verdict.kind).toBe('answers');
    }
  });

  // Plan 03-12 r11 MINOR remediation — multi-word yes/no variants.
  test("STA-04c-multi-word-yes-no: 'not really' / 'of course' / 'no way' match (r11 MINOR fix)", () => {
    for (const text of ['not really', 'not really.', 'Of course!', 'no way', 'NO WAY']) {
      const verdict = classifyOvertake(
        text,
        [],
        mockPending([
          ['ask_mw', { contextField: null, contextCircuit: null, expectedAnswerShape: 'yes_no' }],
        ])
      );
      expect(verdict.kind).toBe('answers');
    }
  });

  test('STA-04c-number: number ask + "yes" + no regex → user_moved_on (wrong attribution cost too high)', () => {
    const verdict = classifyOvertake(
      'yes',
      [],
      mockPending([
        [
          'ask_ze',
          {
            contextField: 'measured_zs_ohm',
            contextCircuit: null,
            expectedAnswerShape: 'number',
          },
        ],
      ])
    );
    expect(verdict.kind).toBe('user_moved_on');
  });

  // STA-04c-free (r6 revision): The r3 MAJOR fix added a free_text branch
  // that accepted any non-empty trimmed text as an answer. r6 MAJOR flagged
  // this as too permissive — "hold on a second" / "let me check" / "hmm"
  // would all classify as answers to a pending free_text ask. Per Plan
  // 03-12 r6 addendum: REMOVED the free_text shape-aware branch. No-regex
  // speech against a free_text ask now falls through to user_moved_on
  // (conservative default). Phase 4's iOS client will route free_text
  // answers via the direct ask_user_answered channel with
  // consumed_utterance_id, which is the authoritative path.
  test('STA-04c-free-removed: free_text ask + "upstairs lighting" + no regex → user_moved_on (r6 revision)', () => {
    const verdict = classifyOvertake(
      'upstairs lighting',
      [],
      mockPending([
        [
          'ask_desc',
          {
            contextField: 'circuit_designation',
            contextCircuit: 3,
            expectedAnswerShape: 'free_text',
          },
        ],
      ])
    );
    // Was `answers` pre-r6. Now `user_moved_on` — free_text must come through
    // the direct ask_user_answered channel, not transcript overtake.
    expect(verdict.kind).toBe('user_moved_on');
  });

  test('STA-04c-free-filler: free_text ask + "hold on a second" + no regex → user_moved_on (was the r6 bug)', () => {
    const verdict = classifyOvertake(
      'hold on a second',
      [],
      mockPending([
        [
          'ask_desc',
          {
            contextField: 'circuit_designation',
            contextCircuit: null,
            expectedAnswerShape: 'free_text',
          },
        ],
      ])
    );
    // Filler speech must never satisfy a free_text ask via overtake — rejectAll
    // and let Sonnet re-ask. This is the exact case r6 flagged.
    expect(verdict.kind).toBe('user_moved_on');
  });

  test('STA-04c-free-empty: free_text ask + whitespace-only text + no regex → user_moved_on (unchanged)', () => {
    const verdict = classifyOvertake(
      '   ',
      [],
      mockPending([
        [
          'ask_desc',
          { contextField: null, contextCircuit: null, expectedAnswerShape: 'free_text' },
        ],
      ])
    );
    expect(verdict.kind).toBe('user_moved_on');
  });

  test('STA-04c-ambiguous: two pending asks (yes_no + number), "yes" → answers the yes_no, oldest matching wins', () => {
    const verdict = classifyOvertake(
      'yes',
      [],
      mockPending([
        [
          'ask_number',
          {
            contextField: 'ze',
            contextCircuit: null,
            expectedAnswerShape: 'number',
          },
        ],
        [
          'ask_confirm',
          {
            contextField: null,
            contextCircuit: null,
            expectedAnswerShape: 'yes_no',
          },
        ],
      ])
    );
    expect(verdict.kind).toBe('answers');
    expect(verdict.toolCallId).toBe('ask_confirm');
  });

  test('STA-04c-undefined-shape: ask with no expectedAnswerShape + no regex → user_moved_on (backward compat)', () => {
    const verdict = classifyOvertake(
      'yes',
      [],
      // No expectedAnswerShape — represents pre-Plan-03-11 entries or a
      // dispatcher bug. Fallback remains conservative.
      mockPending([['ask_legacy', { contextField: 'ze', contextCircuit: null }]])
    );
    expect(verdict.kind).toBe('user_moved_on');
  });

  test('STA-04c-yes_no-non-yes-text: yes_no ask + "maybe later" + no regex → user_moved_on (text doesn\'t match yes/no)', () => {
    const verdict = classifyOvertake(
      'maybe later',
      [],
      mockPending([
        [
          'ask_confirm',
          { contextField: null, contextCircuit: null, expectedAnswerShape: 'yes_no' },
        ],
      ])
    );
    expect(verdict.kind).toBe('user_moved_on');
  });

  // ---------------------------------------------------------------------------
  // STA-04c-circuit-ref — circuit_ref shape branch (added 2026-04-29).
  //
  // Field-test session 17C4135E (job_1777459894020) lost a 299 MΩ live-to-
  // earth IR reading because the disambiguation ask had
  // expectedAnswerShape='circuit_ref' and the user's "circuit 2." reply
  // produced no value-regex hit, falling through to user_moved_on.
  // rejectAll fired before the iOS ask_user_answered channel could resolve
  // the same tool_call_id, dropping the answer. circuit_ref is now a
  // shape-aware short-circuit using extractCircuitRef from
  // stage6-answer-resolver — same parser the dispatcher's escalation path
  // uses, so accept/reject decisions stay consistent across both routes.
  // ---------------------------------------------------------------------------

  test('STA-04c-circuit-ref-bare-digit: circuit_ref ask + "2" → answers', () => {
    const verdict = classifyOvertake(
      '2',
      [],
      mockPending([
        [
          'ask_disambig',
          {
            contextField: 'ir_live_earth_mohm',
            contextCircuit: null,
            expectedAnswerShape: 'circuit_ref',
          },
        ],
      ])
    );
    expect(verdict).toEqual({ kind: 'answers', toolCallId: 'ask_disambig', userText: '2' });
  });

  test('STA-04c-circuit-ref-prefixed-digit: circuit_ref ask + "circuit 2." → answers (the field-test repro)', () => {
    const verdict = classifyOvertake(
      'circuit 2.',
      [],
      mockPending([
        [
          'ask_disambig',
          {
            contextField: 'ir_live_earth_mohm',
            contextCircuit: null,
            expectedAnswerShape: 'circuit_ref',
          },
        ],
      ])
    );
    expect(verdict.kind).toBe('answers');
    expect(verdict.toolCallId).toBe('ask_disambig');
    expect(verdict.userText).toBe('circuit 2.');
  });

  test('STA-04c-circuit-ref-word: circuit_ref ask + "two" → answers', () => {
    const verdict = classifyOvertake(
      'two',
      [],
      mockPending([
        [
          'ask_disambig',
          { contextField: null, contextCircuit: null, expectedAnswerShape: 'circuit_ref' },
        ],
      ])
    );
    expect(verdict.kind).toBe('answers');
  });

  test('STA-04c-circuit-ref-ordinal: circuit_ref ask + "the second circuit" → answers', () => {
    // Documented supported shape per extractCircuitRef JSDoc. "the second one"
    // is NOT supported because "second"→2 and "one"→1 conflict in the
    // single-ordinal scan and return null — leaving that case to user_moved_on
    // is correct (a re-ask is cheaper than a wrong-circuit attribution).
    const verdict = classifyOvertake(
      'the second circuit',
      [],
      mockPending([
        [
          'ask_disambig',
          { contextField: null, contextCircuit: null, expectedAnswerShape: 'circuit_ref' },
        ],
      ])
    );
    expect(verdict.kind).toBe('answers');
  });

  test('STA-04c-circuit-ref-decimal-rejected: circuit_ref ask + "0.4" → user_moved_on (decimal guard)', () => {
    const verdict = classifyOvertake(
      '0.4',
      [],
      mockPending([
        [
          'ask_disambig',
          { contextField: null, contextCircuit: null, expectedAnswerShape: 'circuit_ref' },
        ],
      ])
    );
    expect(verdict.kind).toBe('user_moved_on');
  });

  test('STA-04c-circuit-ref-multi-number-rejected: circuit_ref ask + "circuit 2 ze 0.34" → user_moved_on (single-number guard)', () => {
    // The multi-number guard is the safety rail that distinguishes a circuit-
    // ref answer from a value statement that happens to mention a circuit.
    // Note: a regex matcher running on "ze 0.34" would normally hit step 2
    // first — this test exercises the classifier's own guard in isolation.
    const verdict = classifyOvertake(
      'circuit 2 ze 0.34',
      [],
      mockPending([
        [
          'ask_disambig',
          { contextField: null, contextCircuit: null, expectedAnswerShape: 'circuit_ref' },
        ],
      ])
    );
    expect(verdict.kind).toBe('user_moved_on');
  });

  test('STA-04c-circuit-ref-out-of-range: circuit_ref ask + "circuit 250" → user_moved_on (1..200 guard)', () => {
    const verdict = classifyOvertake(
      'circuit 250',
      [],
      mockPending([
        [
          'ask_disambig',
          { contextField: null, contextCircuit: null, expectedAnswerShape: 'circuit_ref' },
        ],
      ])
    );
    expect(verdict.kind).toBe('user_moved_on');
  });

  test('STA-04c-circuit-ref-non-numeric: circuit_ref ask + "let me think" → user_moved_on', () => {
    const verdict = classifyOvertake(
      'let me think',
      [],
      mockPending([
        [
          'ask_disambig',
          { contextField: null, contextCircuit: null, expectedAnswerShape: 'circuit_ref' },
        ],
      ])
    );
    expect(verdict.kind).toBe('user_moved_on');
  });

  test('STA-04c-circuit-ref-number-shape-still-conservative: number ask + "2" → user_moved_on (bare "2" is ambiguous when the question asks for a value)', () => {
    // Locks the deliberate asymmetry: circuit_ref accepts "2", but number
    // does not. A bare "2" reply to a value question is genuinely ambiguous
    // (could be a value or a circuit ref) — Open Question #4 keeps it
    // conservative.
    const verdict = classifyOvertake(
      '2',
      [],
      mockPending([
        [
          'ask_value',
          {
            contextField: 'measured_zs_ohm',
            contextCircuit: 5,
            expectedAnswerShape: 'number',
          },
        ],
      ])
    );
    expect(verdict.kind).toBe('user_moved_on');
  });

  test('STA-04c-circuit-ref-mixed-shapes: yes_no + circuit_ref pending, "2" → answers the circuit_ref', () => {
    const verdict = classifyOvertake(
      '2',
      [],
      mockPending([
        ['ask_yn', { contextField: null, contextCircuit: null, expectedAnswerShape: 'yes_no' }],
        [
          'ask_cr',
          { contextField: null, contextCircuit: null, expectedAnswerShape: 'circuit_ref' },
        ],
      ])
    );
    expect(verdict.kind).toBe('answers');
    expect(verdict.toolCallId).toBe('ask_cr');
  });
});

// -----------------------------------------------------------------------------
// 2026-06-03 — Bug 1b sprint. Step 1.5 branch routes any non-empty reply to a
// pending observation_clarify ask as the answer, UNLESS the regex hits encode
// a genuine topic-change (real reading field + value present).
//
// Repro (session D7D01509 11:50:51):
//   Q2 ask had contextField='observation_clarify', contextCircuit=null,
//   expectedAnswerShape='free_text'. User reply "circuit 3, and it is a
//   permanent fitting." produced regex hit {circuit: 3} with no field/value.
//   Pre-fix: step 2's fail-safe routed to user_moved_on (no full match
//   possible because observation_clarify is not a schema field). The
//   ask_user_answered_unresolved warning fired the same millisecond.
//
// The new step 1.5 fires AFTER exact-match step 1 and BEFORE step 2's
// fail-safe — exact (field, circuit) matches against normal pending asks
// still win even when an observation_clarify ask is also pending.
// -----------------------------------------------------------------------------

describe('classifyOvertake — Bug 1b step 1.5 (observation_clarify)', () => {
  test('D7D01509 repro: bare-circuit reply to observation_clarify ask routes as answer', () => {
    // The literal session D7D01509 repro: regex hit for circuit 3 (no
    // field, no value) MUST NOT route to user_moved_on because the
    // reply is a continuation of the pending observation, not a fresh
    // reading.
    const verdict = classifyOvertake(
      'circuit 3, and it is a permanent fitting.',
      [{ circuit: 3 }],
      mockPending([
        [
          'obs_ask',
          {
            contextField: 'observation_clarify',
            contextCircuit: null,
            expectedAnswerShape: 'free_text',
          },
        ],
      ])
    );
    expect(verdict.kind).toBe('answers');
    expect(verdict.toolCallId).toBe('obs_ask');
    expect(verdict.userText).toBe('circuit 3, and it is a permanent fitting.');
  });

  test('multi-pending-ask priority: exact-match ask STILL wins over observation_clarify', () => {
    // Step 1 must fire FIRST. Two pending asks — one observation_clarify
    // (older), one exact-match measured_zs_ohm,circuit:3. A reply that
    // exactly matches the latter should route to it, not steal into the
    // observation_clarify. Without this assertion a future refactor of
    // step 1.5 to fire ahead of step 1 would silently re-introduce the
    // steal-from-specific-ask failure mode.
    const verdict = classifyOvertake(
      'Zs on 3 is 0.18',
      [{ field: 'measured_zs_ohm', circuit: 3, value: 0.18 }],
      mockPending([
        [
          'obs_ask',
          {
            contextField: 'observation_clarify',
            contextCircuit: null,
            expectedAnswerShape: 'free_text',
          },
        ],
        [
          'zs_ask',
          {
            contextField: 'measured_zs_ohm',
            contextCircuit: 3,
            expectedAnswerShape: 'number',
          },
        ],
      ])
    );
    expect(verdict.kind).toBe('answers');
    expect(verdict.toolCallId).toBe('zs_ask');
  });

  test('recordable-regex topic-change: real reading + value falls through to user_moved_on', () => {
    // Critical for the hasRecordableRegex predicate: when the regex hit
    // has a real reading field AND a value, the reply is a genuine
    // topic-change. Step 1.5 must NOT steal it into the observation
    // ask; step 2's fail-safe runs and routes to user_moved_on so the
    // user restates the reading next turn.
    const verdict = classifyOvertake(
      'Actually, Zs on circuit 3 is 0.18',
      [{ field: 'measured_zs_ohm', circuit: 3, value: 0.18 }],
      mockPending([
        [
          'obs_ask',
          {
            contextField: 'observation_clarify',
            contextCircuit: null,
            expectedAnswerShape: 'free_text',
          },
        ],
      ])
    );
    expect(verdict.kind).toBe('user_moved_on');
  });

  test('legacy-alias topic-change: legacy field name + value still falls through to user_moved_on', () => {
    // Critical regression lock for the legacy aliases in
    // RECORDABLE_READING_FIELDS. If a future change drops the legacy
    // names (zs, pfc, r1_plus_r2, rcd_trip_time) the hasRecordableRegex
    // predicate would silently fail to recognise a topic-change in the
    // wire shape that existing classifier + pre-LLM-gate tests use,
    // and step 1.5 would steal the reading into the observation ask.
    const verdict = classifyOvertake(
      'Zs on circuit 3 is 0.18',
      [{ field: 'zs', circuit: 3, value: 0.18 }],
      mockPending([
        [
          'obs_ask',
          {
            contextField: 'observation_clarify',
            contextCircuit: null,
            expectedAnswerShape: 'free_text',
          },
        ],
      ])
    );
    expect(verdict.kind).toBe('user_moved_on');
  });

  test('regex.value === null is treated as missing — bare field without value falls through to step 1.5', () => {
    // hasRecordableRegex predicate requires r.value != null. A regex
    // hit with a real field but no value (e.g. "Zs on circuit 3 —" mid-
    // utterance) is NOT a topic-change; step 1.5 should still fire
    // because the reply is compatible with continuing the observation.
    const verdict = classifyOvertake(
      'Zs on circuit 3',
      [{ field: 'measured_zs_ohm', circuit: 3, value: null }],
      mockPending([
        [
          'obs_ask',
          {
            contextField: 'observation_clarify',
            contextCircuit: null,
            expectedAnswerShape: 'free_text',
          },
        ],
      ])
    );
    expect(verdict.kind).toBe('answers');
    expect(verdict.toolCallId).toBe('obs_ask');
  });

  test('empty reply to observation_clarify ask falls through to user_moved_on (existing default preserved)', () => {
    // Regression: empty / whitespace-only replies must NOT be routed
    // as answers. The trim().length > 0 guard inside step 1.5 protects
    // the conservative default from the dispatcher's empty placeholders.
    const verdict = classifyOvertake(
      '',
      [],
      mockPending([
        [
          'obs_ask',
          {
            contextField: 'observation_clarify',
            contextCircuit: null,
            expectedAnswerShape: 'free_text',
          },
        ],
      ])
    );
    expect(verdict.kind).toBe('user_moved_on');
  });

  test('non-observation ask types are NOT affected — yes_no still uses step 3 only', () => {
    // Cross-check that the new branch is scoped to observation_clarify
    // alone. A pending yes_no ask should still route through the
    // existing yes/no vocabulary path in step 3.
    const verdict = classifyOvertake(
      'yes',
      [],
      mockPending([
        [
          'yn_ask',
          {
            contextField: null,
            contextCircuit: null,
            expectedAnswerShape: 'yes_no',
          },
        ],
      ])
    );
    expect(verdict.kind).toBe('answers');
    expect(verdict.toolCallId).toBe('yn_ask');
  });

  test('oldest observation_clarify ask wins when two are pending (rare)', () => {
    // Documented in the source comment: rare but possible. Two
    // observation_clarify asks pending; the bare-circuit reply routes
    // to the oldest one (insertion order). This is the only sensible
    // default — chronological asks are likely to be older waiting on
    // their answer first.
    const verdict = classifyOvertake(
      'circuit 3',
      [{ circuit: 3 }],
      mockPending([
        [
          'obs_first',
          {
            contextField: 'observation_clarify',
            contextCircuit: null,
            expectedAnswerShape: 'free_text',
          },
        ],
        [
          'obs_second',
          {
            contextField: 'observation_clarify',
            contextCircuit: null,
            expectedAnswerShape: 'free_text',
          },
        ],
      ])
    );
    expect(verdict.kind).toBe('answers');
    expect(verdict.toolCallId).toBe('obs_first');
  });
});

// -----------------------------------------------------------------------------
// §A4 (field-feedback-2026-07-14, F8) — pendingValue continuation + brokered
// pvr-* value asks.
//
// Repro (session 6B6FE011 06:24): "ICD trip time … 26 milliseconds" garbled
// the FIELD, so the model asked "which reading was that for?" with
// context_field:"none". The inspector's reply "RCD trip time." is a FIELD
// NAME — it never produces a recordable regex hit, so pre-A4 the classifier's
// r6 free_text removal routed it user_moved_on, the ask died, and the 26 ms
// was written nowhere (beep-then-silence).
//
// Two new no-regex branches, both inside the !hasRecordableRegex step 1.5:
//   (a) contextField 'none' + pendingValue != null + free_text + non-empty
//       reply → answers — UNLESS the typed detector says the reply is itself
//       a structurally complete FRESH reading (round-13 guard: regex ABSENCE
//       is not evidence of an answer; "earthing arrangement is TT" has zero
//       digits and zero regex hits but must be an overtake).
//   (b) pvr-* id (server-brokered) + CONCRETE contextField + numeric/sentinel
//       reply → answers — round-10: a transcript-first "26 milliseconds"
//       reply to a pvr value ask must not delete the registry entry before
//       the duplicate direct ask_user_answered frame arrives.
// Ordinary toolu_* number asks keep the Open Question #4 conservative
// default byte-for-byte.
// -----------------------------------------------------------------------------

describe('classifyOvertake — §A4 pendingValue continuation + pvr-* value asks', () => {
  // The F8 inverted-ask entry shape: value captured at registration, field
  // name expected in the reply.
  const pendingValueEntry = () => ({
    contextField: 'none',
    contextCircuit: null,
    expectedAnswerShape: 'free_text',
    pendingValue: {
      value: '26',
      unit: 'ms',
      sourceText: 'ICD trip time for circuit 2 is 26 milliseconds.',
      source: 'transcript',
    },
  });

  test("F8 repro: 'none'+pendingValue+free_text ask + field-name reply 'RCD trip time.' + no regex → answers", () => {
    const verdict = classifyOvertake(
      'RCD trip time.',
      [],
      mockPending([['toolu_pv', pendingValueEntry()]])
    );
    expect(verdict).toEqual({
      kind: 'answers',
      toolCallId: 'toolu_pv',
      userText: 'RCD trip time.',
    });
  });

  test("round-13 guard: detector-complete NO-regex reading 'earthing arrangement is TT' → user_moved_on", () => {
    // Zero digits, zero regex hits — only the TYPED detector can tell this
    // apart from a field-name answer. It must be classified as an overtake
    // so the fresh select-field reading is processed by normal dispatch,
    // never joined to the stale pendingValue.
    const verdict = classifyOvertake(
      'earthing arrangement is TT',
      [],
      mockPending([['toolu_pv', pendingValueEntry()]])
    );
    expect(verdict.kind).toBe('user_moved_on');
  });

  test("round-13 guard: detector-complete circuit reading 'Zs circuit 4 is 0.30' (no regex) → user_moved_on", () => {
    // Structurally complete circuit reading (field + explicit circuit ref +
    // value) arriving transcript-first with no regex hit — an overtake, not
    // the field-name answer.
    const verdict = classifyOvertake(
      'Zs circuit 4 is 0.30',
      [],
      mockPending([['toolu_pv', pendingValueEntry()]])
    );
    expect(verdict.kind).toBe('user_moved_on');
  });

  test("round-10: pvr-* id + concrete contextField + numeric reply '26 milliseconds' + no regex → answers", () => {
    const verdict = classifyOvertake(
      '26 milliseconds',
      [],
      mockPending([
        [
          'pvr-sess-A-rcd_time_ms-1',
          {
            contextField: 'rcd_time_ms',
            contextCircuit: 2,
            expectedAnswerShape: 'number',
          },
        ],
      ])
    );
    expect(verdict).toEqual({
      kind: 'answers',
      toolCallId: 'pvr-sess-A-rcd_time_ms-1',
      userText: '26 milliseconds',
    });
  });

  test('toolu_* id (NOT pvr) + concrete contextField + bare numeric reply → user_moved_on (conservative default preserved)', () => {
    // Locks the pvr-* scoping: an ordinary Sonnet-emitted number ask keeps
    // the Open Question #4 conservative default — a bare numeric through the
    // transcript channel is genuinely ambiguous, and the direct
    // ask_user_answered channel remains the authoritative route.
    const verdict = classifyOvertake(
      '26 milliseconds',
      [],
      mockPending([
        [
          'toolu_value_ask',
          {
            contextField: 'rcd_time_ms',
            contextCircuit: 2,
            expectedAnswerShape: 'number',
          },
        ],
      ])
    );
    expect(verdict.kind).toBe('user_moved_on');
  });

  test("'none' ask WITHOUT pendingValue + free-text reply → user_moved_on (r6 free_text removal stays; no-CPC-class safety)", () => {
    // A context_field:"none" ask that captured NO pendingValue (ambiguous /
    // multi-number turn) must NOT accept arbitrary free text — that would
    // resurrect the r6 filler-speech bug ("hold on a second" consumed as an
    // answer). Only the value-captured inverted shape gets the continuation.
    const verdict = classifyOvertake(
      'RCD trip time.',
      [],
      mockPending([
        [
          'toolu_none_no_pv',
          {
            contextField: 'none',
            contextCircuit: null,
            expectedAnswerShape: 'free_text',
            pendingValue: null,
          },
        ],
      ])
    );
    expect(verdict.kind).toBe('user_moved_on');
  });
});
