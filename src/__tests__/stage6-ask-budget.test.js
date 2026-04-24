/**
 * Stage 6 Phase 5 Plan 05-03 — AskBudget unit tests.
 *
 * WHAT: Locks the per-session, per-(context_field, context_circuit) ask
 * counter contract for STA-06. This module is the cap that Plan 05-01's
 * wrapper consults BEFORE invoking the inner ask dispatcher; once the
 * cap is reached the wrapper short-circuits with answer_outcome=
 * 'ask_budget_exhausted'.
 *
 * WHY these tests ARE the gate (RED step of the Plan 05-03 TDD pair):
 *   - STA-06 boundary lock — "up to 2 asks per (field, circuit) pair are
 *     allowed; the 3rd is exhausted". Group 2 test 2 anchors the boundary
 *     at count >= maxAsksPerKey. If a future refactor flips the comparison
 *     to > or moves the cap from 2 to 3, the test fails loudly.
 *   - Codex STB-04 surface — "budget enforced in dispatcher, not post-hoc".
 *     The module is pure, has zero imports, zero logger coupling. The test
 *     suite is therefore the single source of truth for behaviour; no
 *     other module exposes the counter.
 *   - Pitfall (key opacity) — the budget MUST NOT interpret the key as a
 *     '${field}:${circuit}' tuple. The wrapper owns key normalisation.
 *     Tests use opaque tokens like '_:_' to enforce this.
 *
 * REQUIREMENTS covered: STA-06 (per-(field, circuit) ask budget = 2),
 * STB-04 (budget enforced in dispatcher, not post-hoc), STB-05 (no
 * backstop weakened — new backstop with trivial surface).
 */

import { createAskBudget } from '../extraction/stage6-ask-budget.js';

// -----------------------------------------------------------------------------
// Group 1: Initial state
// -----------------------------------------------------------------------------

describe('createAskBudget — initial state', () => {
  test('getCount on unseen key is 0', () => {
    const budget = createAskBudget();
    expect(budget.getCount('unseen')).toBe(0);
  });

  test('isExhausted on unseen key is false', () => {
    const budget = createAskBudget();
    expect(budget.isExhausted('unseen')).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Group 2: Increment + exhaust (STA-06 core behaviour)
// -----------------------------------------------------------------------------

describe('createAskBudget — increment and exhaust (STA-06)', () => {
  test('after one increment, count is 1 and not exhausted', () => {
    const budget = createAskBudget();
    budget.increment('ze:0');
    expect(budget.getCount('ze:0')).toBe(1);
    expect(budget.isExhausted('ze:0')).toBe(false);
  });

  test('after two increments, count is 2 and IS exhausted (STA-06 boundary)', () => {
    // STA-06 — "2 asks allowed, 3rd is exhausted" → boundary is count >= 2.
    // The 1st and 2nd ask fire (wrapper checks isExhausted BEFORE increment,
    // so count=0 and count=1 both produce isExhausted=false). After the
    // 2nd increment count=2, the next isExhausted check returns true and
    // the wrapper short-circuits the 3rd attempt.
    const budget = createAskBudget();
    budget.increment('ze:0');
    budget.increment('ze:0');
    expect(budget.getCount('ze:0')).toBe(2);
    expect(budget.isExhausted('ze:0')).toBe(true);
  });

  test('module does not cap count — 3rd increment yields 3, still exhausted (defensive)', () => {
    // The module is resilient to wrapper mis-use. The wrapper's short-circuit
    // is the contract that prevents a 3rd increment in production, but if a
    // future refactor or test path increments past the cap, the module must
    // not silently saturate — the count keeps climbing and isExhausted stays
    // true. This guards against a future bug where someone "fixes" the cap
    // with a Math.min and breaks debugging.
    const budget = createAskBudget();
    budget.increment('ze:0');
    budget.increment('ze:0');
    budget.increment('ze:0');
    expect(budget.getCount('ze:0')).toBe(3);
    expect(budget.isExhausted('ze:0')).toBe(true);
  });

  test('two different keys are independent', () => {
    // Key isolation — incrementing one key never touches another. This
    // anchors the STA-06 "per-(field, circuit)" semantics: 'ze:0' and
    // 'r1:5' represent different (field, circuit) tuples and must each
    // get their own 2-ask budget.
    const budget = createAskBudget();
    budget.increment('ze:0');
    budget.increment('ze:0');
    budget.increment('r1:5');
    expect(budget.getCount('ze:0')).toBe(2);
    expect(budget.isExhausted('ze:0')).toBe(true);
    expect(budget.getCount('r1:5')).toBe(1);
    expect(budget.isExhausted('r1:5')).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Group 3: destroy
// -----------------------------------------------------------------------------

describe('createAskBudget — destroy', () => {
  test('destroy clears all counts and isExhausted returns false', () => {
    const budget = createAskBudget();
    budget.increment('ze:0');
    budget.increment('ze:0');
    budget.increment('r1:5');
    budget.destroy();
    expect(budget.getCount('ze:0')).toBe(0);
    expect(budget.getCount('r1:5')).toBe(0);
    expect(budget.isExhausted('ze:0')).toBe(false);
    expect(budget.isExhausted('r1:5')).toBe(false);
  });

  test('destroy on empty budget is a no-op (no throw, idempotent)', () => {
    const budget = createAskBudget();
    expect(() => budget.destroy()).not.toThrow();
    // A second destroy is also a no-op (matches Phase 3 pendingAsks
    // rejectAll idempotency contract).
    expect(() => budget.destroy()).not.toThrow();
    expect(budget.getCount('ze:0')).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// Group 4: _snapshot
// -----------------------------------------------------------------------------

describe('createAskBudget — _snapshot', () => {
  test('_snapshot returns plain object with current counts', () => {
    const budget = createAskBudget();
    budget.increment('ze:0');
    budget.increment('ze:0');
    budget.increment('r1:5');
    expect(budget._snapshot()).toEqual({ 'ze:0': 2, 'r1:5': 1 });
  });

  test('_snapshot is a copy — mutating it does not affect internal state', () => {
    // Crucial for both test isolation and Plan 05-06 logger usage:
    // exposing the internal Map by reference would let consumers
    // accidentally corrupt the budget. Object.fromEntries breaks the
    // reference, so a write to the returned object cannot leak back.
    const budget = createAskBudget();
    budget.increment('ze:0');
    budget.increment('ze:0');
    const snap = budget._snapshot();
    snap['ze:0'] = 999;
    snap['r1:5'] = 42;
    expect(budget.getCount('ze:0')).toBe(2);
    expect(budget.getCount('r1:5')).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// Group 5: Custom cap + opaque keys
// -----------------------------------------------------------------------------

describe('createAskBudget — custom cap and opaque keys', () => {
  test('maxAsksPerKey: 3 → not exhausted at 0/1/2, exhausted at 3', () => {
    const budget = createAskBudget({ maxAsksPerKey: 3 });
    expect(budget.isExhausted('k')).toBe(false);
    budget.increment('k');
    expect(budget.isExhausted('k')).toBe(false);
    budget.increment('k');
    expect(budget.isExhausted('k')).toBe(false);
    budget.increment('k');
    expect(budget.isExhausted('k')).toBe(true);
  });

  test("keys '_:_' and 'ze:0' are distinct opaque tokens (module does not parse key structure)", () => {
    // The budget treats keys as black-box strings. The wrapper's
    // deriveAskKey is responsible for normalising null fields/circuits
    // into the '_:_' sentinel; the budget never inspects whether a key
    // contains a colon, an underscore, or an empty segment.
    const budget = createAskBudget();
    budget.increment('_:_');
    budget.increment('_:_');
    expect(budget.isExhausted('_:_')).toBe(true);
    // 'ze:0' is a different key and gets its own counter.
    expect(budget.isExhausted('ze:0')).toBe(false);
    expect(budget.getCount('ze:0')).toBe(0);
    // Just to be thorough — even visually-similar keys are distinct.
    budget.increment('ze:0');
    expect(budget.getCount('ze:0')).toBe(1);
    expect(budget.getCount('_:_')).toBe(2);
  });
});
