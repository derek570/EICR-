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
      mockPending([['ask_1', { contextField: 'ze', contextCircuit: null }]]),
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
      mockPending([['ask_zs_3', { contextField: 'zs', contextCircuit: 3 }]]),
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
      ]),
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
      mockPending([['ask_ze', { contextField: 'ze', contextCircuit: null }]]),
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
      mockPending([['ask_ze', { contextField: 'ze', contextCircuit: null }]]),
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
      mockPending([['ask_ze', { contextField: 'ze', contextCircuit: null }]]),
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
      mockPending([['ask_ze_5', { contextField: 'ze', contextCircuit: 5 }]]),
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
      mockPending([['ask_ze', { contextField: 'ze', contextCircuit: null }]]),
    );
    // Conservative default per Open Question #4 — we do NOT assume "yes" answers
    // the oldest pending ask. Caller will rejectAll and let the user restate.
    expect(verdict).toEqual({ kind: 'user_moved_on' });
  });

  test('pending ask + empty regex array + long conversational text → user_moved_on', () => {
    const verdict = classifyOvertake(
      'yeah I think we should probably just move on and come back to that later',
      [],
      mockPending([['ask_ze', { contextField: 'ze', contextCircuit: null }]]),
    );
    expect(verdict.kind).toBe('user_moved_on');
  });

  test('pending ask + regexResults undefined → user_moved_on (defensive)', () => {
    const verdict = classifyOvertake(
      'anything',
      undefined,
      mockPending([['ask_ze', { contextField: 'ze', contextCircuit: null }]]),
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
      mockPending([['ask_ze', { contextField: 'ze', contextCircuit: null }]]),
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
      ]),
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
      map,
    );
    expect(verdict.kind).toBe('answers');
    expect(verdict.toolCallId).toBe('ask_ze');
  });
});
