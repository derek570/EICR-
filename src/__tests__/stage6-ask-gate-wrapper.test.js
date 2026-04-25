/**
 * Stage 6 Phase 5 Plan 05-01 — ask-gate-wrapper unit tests.
 *
 * WHAT: Locks the higher-order composition that wires all four Phase 5 gates
 * (filled-slots shadow / restrained-mode / per-key budget / 1500ms debounce)
 * around the unmodified Plan 03-05 createAskDispatcher. Composition only;
 * the inner dispatcher is a black box.
 *
 * WHY these tests ARE the gate (RED step of the Plan 05-01 TDD pair):
 *   - STB-01 short-circuit ordering — gate.gateOrFire wraps every ask_user
 *     dispatch; restrained / budget short-circuit BEFORE the gate timer
 *     starts; gated replacements resolve with reason='gated'.
 *   - STB-04 — per-key budget enforced AHEAD of the inner dispatcher.
 *   - STB-05 — no existing guard weakened: composition does not mutate
 *     stage6-dispatcher-ask.js. The Codex grep at /verification/ proves
 *     this; the tests prove the wrapper achieves the same effect via
 *     pure composition.
 *   - Pitfall 4 (Plan 05-03 + 05-04 carry-over) — counters increment
 *     ONLY on successful fire; short-circuited asks (gated /
 *     restrained_mode / ask_budget_exhausted) MUST NOT consume budget.
 *
 * Fake-timer pattern: doNotFake Promise + queueMicrotask + nextTick is
 * the Stage 6 frozen pattern (Decision 03-09). It lets jest.advanceTimersByTime
 * step the 1500ms debounce deterministically while keeping async/await
 * scheduling real.
 *
 * REQUIREMENTS covered: STB-01, STB-04, STB-05.
 */

import { jest } from '@jest/globals';
import {
  createAskGateWrapper,
  wrapAskDispatcherWithGates,
  deriveAskKey,
  isWrapperShortCircuitReason,
  isPreEmitNonFireReason,
} from '../extraction/stage6-ask-gate-wrapper.js';
import * as wrapperModule from '../extraction/stage6-ask-gate-wrapper.js';
import { createAskBudget } from '../extraction/stage6-ask-budget.js';
import { QUESTION_GATE_DELAY_MS } from '../extraction/question-gate.js';

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'Promise', 'nextTick'] });
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// Helpers — kept dumb so each test reads top-down without a second indirection.
// ---------------------------------------------------------------------------

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeBudget({ exhausted = false } = {}) {
  return {
    isExhausted: jest.fn(() => exhausted),
    increment: jest.fn(),
    getCount: jest.fn(() => 0),
  };
}

function makeRestrained({ active = false } = {}) {
  return {
    isActive: jest.fn(() => active),
    recordAsk: jest.fn(),
    destroy: jest.fn(),
  };
}

function makeInnerDispatcher(outcome = { answered: true, user_text: 'ok' }) {
  return jest.fn(async (call /* , ctx */) => ({
    tool_use_id: call.id,
    content: JSON.stringify(outcome),
    is_error: false,
  }));
}

function makeCall(id, field, circuit) {
  return {
    id,
    name: 'ask_user',
    input: {
      question: 'Q?',
      reason: 'ambiguous_circuit',
      context_field: field,
      context_circuit: circuit,
      expected_answer_shape: 'text',
    },
  };
}

function makeCtx(turnId = 'sess-1-turn-1') {
  return { sessionId: 'sess-1', turnId };
}

// =============================================================================
// Group 1: deriveAskKey — sentinel normalisation (Pitfall 3)
// =============================================================================
describe('deriveAskKey', () => {
  test('extracts field:circuit from a normal input', () => {
    expect(deriveAskKey({ context_field: 'ze', context_circuit: 0 })).toBe('ze:0');
  });

  test('null field + null circuit collapse to sentinel "_:_" (NOT "null:null")', () => {
    // Pitfall 3 — null bypass. Without the sentinel collapse, a null-context
    // ask would derive a different key from a 0-circuit ask, side-stepping
    // the budget for the same logical question.
    expect(deriveAskKey({ context_field: null, context_circuit: null })).toBe('_:_');
  });

  test('undefined / missing keys also collapse to sentinel', () => {
    // undefined === null in sentinel semantics — Map<key,...> in
    // stage6-ask-budget.js treats them identically once the key is
    // normalised.
    expect(deriveAskKey({})).toBe('_:_');
  });

  // ===========================================================================
  // Plan 05-08 r2-#2 — null vs "none" key bypass.
  // ===========================================================================
  // stage6-tool-schemas.js:327 documents the context_field enum as: "...the
  // sentinel "none" (equivalently null) for scope-less asks". An ask carrying
  // context_field:null and a follow-up ask carrying context_field:"none"
  // refer to the same logical scope ("no field"). Pre-fix deriveAskKey
  // produced different keys ("_:N" vs "none:N") so per-key budget could not
  // catch repeated scope-less asks that alternated representations.
  //
  // Fix scope: only the context_field side is normalised. context_circuit
  // schema treats only `null` as the sentinel (per schema description); `0`
  // remains a distinct integer per the existing Group 1 test
  // ("extracts field:circuit from a normal input" at the top — `'ze:0'`).
  // ===========================================================================

  test('"none" (canonical sentinel) collapses to "_" — same as null', () => {
    expect(deriveAskKey({ context_field: 'none', context_circuit: null })).toBe('_:_');
    expect(deriveAskKey({ context_field: null, context_circuit: null })).toBe('_:_');
    // Both expressions above must match for the per-key budget to bucket
    // them together.
    expect(deriveAskKey({ context_field: 'none', context_circuit: null })).toBe(
      deriveAskKey({ context_field: null, context_circuit: null })
    );
  });

  // =========================================================================
  // Plan 05-10 r4-#1 — deriveAskKey runs at WRAPPER layer BEFORE validator.
  // =========================================================================
  // Codex r4 surfaced a defect inside Plan 05-09 r3-#3's case-sensitive
  // narrowing. The argument for r3-#3 was: validateAskUser at
  // stage6-dispatch-validation.js:204 is case-sensitive on
  // CONTEXT_FIELD_ENUM.includes, production never sees upper-case sentinel
  // forms because the validator rejects them upstream with
  // invalid_context_field, so the case-insensitive branch in deriveAskKey
  // was "dead code that encoded a contract divergence".
  //
  // That argument was wrong because ORDER MATTERS:
  // wrapAskDispatcherWithGates at stage6-ask-gate-wrapper.js:~317 calls
  //   const key = deriveAskKey(call.input);
  // BEFORE the inner dispatcher's validateAskUser runs. So a malformed
  // payload [null, 'NONE', 'None', null] derives 4 distinct keys at the
  // wrapper's budget/debounce surface — bypassing same-key debounce +
  // per-key budget — EVEN THOUGH each call is later rejected as
  // validation_error.
  //
  // Concrete bypass surface (pre-r4-#1):
  //   1. Sonnet emits ask_user with context_field:'NONE', circuit 7.
  //   2. Wrapper computes key 'NONE:7' and consults askBudget +
  //      gate.gateOrFire — bucket is empty, allow.
  //   3. Inner dispatcher rejects with validation_error.
  //   4. Wrapper post-step: isRealFire returns false (validation_error
  //      is in PRE_EMIT_NON_FIRE_REASONS — Plans 05-08 r2-#1 + 05-09
  //      r3-#1). NO budget burn. Good.
  //   5. Sonnet retries with context_field:'None'.
  //   6. Wrapper computes key 'None:7' — DISTINCT from 'NONE:7'. The
  //      per-key budget cap (default 2) is unaware these belong
  //      together. Same-key debounce never fires.
  //   7. The 1500ms debounce window for 'None:7' starts FRESH — Sonnet
  //      can keep retrying alternating sentinel cases and never trip
  //      either gate at the wrapper layer.
  //
  // The validator correctly rejects each malformed call; the bypass is
  // specifically of the WRAPPER's gates (debounce + per-key budget).
  // Decision 05-09-D3 is reversed: case-insensitive matching at the
  // wrapper IS load-bearing for the wrapper's own protection against
  // cross-case alternation.
  //
  // r4-#1 fix: REVERT to case-insensitive matching for the literal
  // sentinel string 'none'. Real (non-sentinel) field values still
  // pass through case-preserving — case-insensitivity is sentinel-only.
  // This is DEFENCE-IN-DEPTH at the wrapper layer; it does not widen
  // the validator's contract (validator still rejects upper-case forms
  // with invalid_context_field; the wrapper now correctly classifies
  // that envelope as PRE_EMIT_NON_FIRE_REASONS so no budget burn
  // occurs).
  //
  // Behaviour after r4-#1:
  //   - 'none' (lowercase canonical sentinel) → '_' (UNCHANGED).
  //   - null / undefined → '_' (UNCHANGED).
  //   - 'NONE' / 'None' / 'nOnE' → '_' (REVERTED to r2-#2 behaviour
  //     after r3-#3 broke it).
  //   - Real field values (e.g. 'ze', 'Ze', 'measured_zs_ohm') →
  //     case-preserving distinct keys (UNCHANGED — case-insensitivity
  //     is sentinel-only).
  // =========================================================================

  test('"NONE"/"None"/"nOnE" DO collapse to "_" — case-insensitive sentinel match (r4-#1)', () => {
    // Pre-r4-#1 (after r3-#3 narrowed): each upper-case form derived a
    // distinct key. Post-r4-#1: all three collapse to '_:_' so the
    // wrapper's same-key debounce + per-key budget catch case-
    // alternation BEFORE the inner dispatcher's validator runs.
    expect(deriveAskKey({ context_field: 'NONE', context_circuit: null })).toBe('_:_');
    expect(deriveAskKey({ context_field: 'None', context_circuit: null })).toBe('_:_');
    expect(deriveAskKey({ context_field: 'nOnE', context_circuit: null })).toBe('_:_');
    // All forms (null, 'none', 'NONE', 'None', 'nOnE') must equal the
    // same canonical bucket so the wrapper's gates cannot be bypassed
    // by alternating sentinel cases.
    expect(deriveAskKey({ context_field: 'NONE', context_circuit: null })).toBe(
      deriveAskKey({ context_field: null, context_circuit: null })
    );
    expect(deriveAskKey({ context_field: 'NONE', context_circuit: null })).toBe(
      deriveAskKey({ context_field: 'none', context_circuit: null })
    );
    expect(deriveAskKey({ context_field: 'None', context_circuit: null })).toBe(
      deriveAskKey({ context_field: 'nOnE', context_circuit: null })
    );
  });

  test('field collapse preserves real circuit number (sentinel forms only — case-insensitive)', () => {
    // Every sentinel form (null and any case of 'none') with the same
    // circuit number must hit the same bucket so per-key budget cannot
    // be bypassed by alternating sentinel representations at the
    // wrapper layer (which runs BEFORE the validator).
    expect(deriveAskKey({ context_field: 'none', context_circuit: 3 })).toBe('_:3');
    expect(deriveAskKey({ context_field: null, context_circuit: 3 })).toBe('_:3');
    expect(deriveAskKey({ context_field: 'NONE', context_circuit: 3 })).toBe('_:3');
    expect(deriveAskKey({ context_field: 'None', context_circuit: 3 })).toBe('_:3');
    // Cross-form equality (the load-bearing claim r4-#1 reinstates).
    expect(deriveAskKey({ context_field: 'none', context_circuit: 3 })).toBe(
      deriveAskKey({ context_field: null, context_circuit: 3 })
    );
    expect(deriveAskKey({ context_field: 'NONE', context_circuit: 3 })).toBe(
      deriveAskKey({ context_field: 'None', context_circuit: 3 })
    );
  });

  test('real field values are STILL case-preserving — case-insensitivity is sentinel-only (r4-#1)', () => {
    // r4-#1 case-insensitive normalisation applies ONLY to the literal
    // sentinel string 'none'. Real (non-sentinel) field values like
    // 'Ze' / 'ze' must still derive distinct keys so a typo bug
    // surfaces in the analyzer rather than silently bucketing wrong-
    // case values together. The validator owns canonical case for real
    // values; collapsing them at the wrapper would mask a typo bug
    // whose right surface is the validator's enum check.
    expect(deriveAskKey({ context_field: 'ze', context_circuit: 1 })).toBe('ze:1');
    expect(deriveAskKey({ context_field: 'Ze', context_circuit: 1 })).toBe('Ze:1');
    expect(deriveAskKey({ context_field: 'ZE', context_circuit: 1 })).toBe('ZE:1');
    // Three real values, three distinct keys — case sensitivity
    // preserved for non-sentinel values.
    expect(deriveAskKey({ context_field: 'ze', context_circuit: 1 })).not.toBe(
      deriveAskKey({ context_field: 'Ze', context_circuit: 1 })
    );
    expect(deriveAskKey({ context_field: 'ze', context_circuit: 1 })).not.toBe(
      deriveAskKey({ context_field: 'ZE', context_circuit: 1 })
    );
    // None of the real values may collapse to the sentinel bucket
    // (only the literal 'none' does).
    expect(deriveAskKey({ context_field: 'ze', context_circuit: 1 })).not.toBe(
      deriveAskKey({ context_field: null, context_circuit: 1 })
    );
    expect(deriveAskKey({ context_field: 'Ze', context_circuit: 1 })).not.toBe(
      deriveAskKey({ context_field: null, context_circuit: 1 })
    );
  });

  test('real field values are unchanged (case-PRESERVING)', () => {
    expect(deriveAskKey({ context_field: 'ze', context_circuit: 1 })).toBe('ze:1');
    expect(deriveAskKey({ context_field: 'measured_zs_ohm', context_circuit: 6 })).toBe(
      'measured_zs_ohm:6'
    );
    // No case-folding on real values — validator owns canonical case.
    // (We deliberately don't enforce case-equivalence here for non-sentinel
    // values; a malformed `'Ze'` should derive a DIFFERENT key from `'ze'`
    // so the bug shows up as a per-key bucket mismatch in the analyzer.)
    expect(deriveAskKey({ context_field: 'Ze', context_circuit: 1 })).not.toBe('ze:1');
  });

  test('regression lock — context_circuit:0 stays distinct from null (NOT collapsed)', () => {
    // Schema documents only `null` as the sentinel for context_circuit;
    // `0` is a valid integer with no sentinel meaning. The existing Group 1
    // test "extracts field:circuit from a normal input" asserts
    // {field:'ze',circuit:0} → 'ze:0'. r2-#2 is intentionally scoped to
    // context_field only.
    expect(deriveAskKey({ context_field: 'ze', context_circuit: 0 })).toBe('ze:0');
    expect(deriveAskKey({ context_field: 'ze', context_circuit: 0 })).not.toBe(
      deriveAskKey({ context_field: 'ze', context_circuit: null })
    );
  });

  // =========================================================================
  // Plan 05-11 r5-#1 — sentinel trim + case-fold needed.
  // =========================================================================
  // Codex r5 surfaced that Plan 05-10 r4-#1's case-fold uses
  // `fieldRaw.toLowerCase() === 'none'` without trimming whitespace. So
  // strings like " none ", "\tNONE\n", " None" derive DISTINCT wrapper
  // keys before the validator runs. Same bypass shape as r4-#1 but via
  // whitespace padding instead of case alternation.
  //
  // The validator at stage6-dispatch-validation.js:204 is
  // `CONTEXT_FIELD_ENUM.includes(input.context_field)` — strict
  // membership, no trim, no fold. So whitespace-padded forms are
  // rejected upstream as `invalid_context_field` (pre-emit non-fire,
  // no budget burn at validation), BUT the wrapper's protective
  // debounce + per-key budget gates never fired during the
  // pre-validation key derivation.
  //
  // r5-#1 fix: trim + fold the sentinel branch. Real (non-sentinel)
  // values are NOT trimmed — trimming `'  ze  '` to `'ze'` would
  // silently mask a typo / drift bug whose right surface is the
  // validator's enum check. Real values stay verbatim case-preserving
  // so a malformed `'  ze  '` derives `' ze :N'` and surfaces via the
  // analyzer.
  //
  // Behaviour after r5-#1:
  //   - 'none' / 'NONE' / 'None' (any case, no whitespace) → '_'
  //     (UNCHANGED from r4-#1).
  //   - ' none ' / '\tNONE\n' / '  None  ' (any case, whitespace) → '_'
  //     (NEW — was case-folded but not trimmed).
  //   - null / undefined → '_' (UNCHANGED).
  //   - Real values (' ze ', 'measured_zs_ohm', etc.) → verbatim
  //     case + whitespace preserving (UNCHANGED — sentinel-only
  //     normalisation).
  // =========================================================================

  test('Plan 05-11 r5-#1 — " none " (leading + trailing space) collapses to "_"', () => {
    // Whitespace-padded sentinel must collapse to the same bucket as
    // null / 'none' / 'NONE' so the wrapper's same-key debounce +
    // per-key budget catch padding-alternation BEFORE the validator
    // rejects the malformed form.
    expect(deriveAskKey({ context_field: ' none ', context_circuit: null })).toBe('_:_');
  });

  test('Plan 05-11 r5-#1 — "\\tNONE\\n" (tab + newline padding) collapses to "_"', () => {
    expect(deriveAskKey({ context_field: '\tNONE\n', context_circuit: null })).toBe('_:_');
  });

  test('Plan 05-11 r5-#1 — " None" (leading space) collapses to "_"', () => {
    expect(deriveAskKey({ context_field: ' None', context_circuit: null })).toBe('_:_');
  });

  test('Plan 05-11 r5-#1 — real values with whitespace are NOT trimmed (sentinel-only fold)', () => {
    // Real (non-sentinel) values must preserve whitespace so a malformed
    // `'  ze  '` surfaces in the analyzer rather than silently bucketing
    // with clean 'ze'. Trimming real values here would hide a typo /
    // drift bug whose right surface is the validator's enum check.
    expect(deriveAskKey({ context_field: ' ze ', context_circuit: 3 })).toBe(' ze :3');
    expect(deriveAskKey({ context_field: ' ze ', context_circuit: 3 })).not.toBe(
      deriveAskKey({ context_field: 'ze', context_circuit: 3 })
    );
    // Whitespace-padded real value is also NOT case-folded.
    expect(deriveAskKey({ context_field: ' ZE ', context_circuit: 3 })).toBe(' ZE :3');
  });

  test('Plan 05-11 r5-#1 — every padded sentinel form cross-equals (same bucket)', () => {
    // The load-bearing claim: 4 padded sentinel variants must all hit
    // the same '_:7' bucket so cap=2 sees them as same-key.
    const forms = [null, ' none ', '\tNONE\n', ' None'];
    const keys = forms.map((f) => deriveAskKey({ context_field: f, context_circuit: 7 }));
    // All keys must equal '_:7'.
    for (const k of keys) {
      expect(k).toBe('_:7');
    }
    // Cross-equality: every form equals every other form.
    for (let i = 0; i < forms.length - 1; i += 1) {
      expect(keys[i]).toBe(keys[i + 1]);
    }
  });

  test('Plan 05-11 r5-#1 — r4-#1 lock unchanged (unpadded case forms still collapse)', () => {
    // The r4-#1 case-insensitive contract for unpadded sentinel forms
    // remains intact post-r5-#1. The trim addition is additive: case
    // alternation still collapses, padding alternation also collapses.
    expect(deriveAskKey({ context_field: 'NONE', context_circuit: null })).toBe('_:_');
    expect(deriveAskKey({ context_field: 'None', context_circuit: null })).toBe('_:_');
    expect(deriveAskKey({ context_field: 'nOnE', context_circuit: null })).toBe('_:_');
  });
});

// =============================================================================
// Group 2: createAskGateWrapper — debounce semantics (Research §Q10)
// =============================================================================
describe('createAskGateWrapper — debounce', () => {
  test('single gateOrFire fires inner dispatcher exactly once after 1500ms', async () => {
    const logger = makeLogger();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });
    const inner = makeInnerDispatcher();
    const call = makeCall('call-1', 'ze', 0);
    const ctx = makeCtx();

    const promise = gate.gateOrFire(call, ctx, inner);

    // Before the 1500ms expires, inner has not been called yet.
    await Promise.resolve();
    expect(inner).not.toHaveBeenCalled();

    jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);
    const result = await promise;

    expect(inner).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledWith(call, ctx);
    expect(result.tool_use_id).toBe('call-1');
    expect(JSON.parse(result.content)).toEqual({ answered: true, user_text: 'ok' });

    gate.destroy();
  });

  test('same-key within 1500ms cancels first + replaces; first resolves with reason="gated", second fires after a fresh 1500ms', async () => {
    const logger = makeLogger();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });
    const inner = makeInnerDispatcher();
    const call1 = makeCall('call-1', 'ze', 0);
    const call2 = makeCall('call-2', 'ze', 0); // same (field, circuit) → same key
    const ctx = makeCtx();

    const p1 = gate.gateOrFire(call1, ctx, inner);

    // t=800ms — second call arrives before first fires.
    jest.advanceTimersByTime(800);
    const p2 = gate.gateOrFire(call2, ctx, inner);

    // First's outer Promise resolves immediately with the gated synthResult.
    const r1 = await p1;
    expect(r1.tool_use_id).toBe('call-1');
    expect(JSON.parse(r1.content)).toEqual({ answered: false, reason: 'gated' });
    expect(r1.is_error).toBe(false);

    // Inner dispatcher has NOT been called yet — the 1500ms timer was reset.
    expect(inner).not.toHaveBeenCalled();

    // Advance through the FRESH 1500ms (resetTimer pattern).
    jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);
    const r2 = await p2;

    expect(inner).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledWith(call2, ctx);
    expect(r2.tool_use_id).toBe('call-2');
    expect(JSON.parse(r2.content)).toEqual({ answered: true, user_text: 'ok' });

    gate.destroy();
  });

  test('different keys each get their own timer; both inner dispatches fire', async () => {
    const logger = makeLogger();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });
    const inner = makeInnerDispatcher();
    const call1 = makeCall('call-1', 'ze', 0); // key 'ze:0'
    const call2 = makeCall('call-2', 'zs', 4); // key 'zs:4' — distinct
    const ctx = makeCtx();

    const p1 = gate.gateOrFire(call1, ctx, inner);
    const p2 = gate.gateOrFire(call2, ctx, inner);

    jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(inner).toHaveBeenCalledTimes(2);
    expect(JSON.parse(r1.content).answered).toBe(true);
    expect(JSON.parse(r2.content).answered).toBe(true);

    gate.destroy();
  });

  test('gate.destroy() clears pending timers and resolves outstanding promises with reason="session_terminated"', async () => {
    const logger = makeLogger();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });
    const inner = makeInnerDispatcher();
    const call = makeCall('call-1', 'ze', 0);
    const ctx = makeCtx();

    const p = gate.gateOrFire(call, ctx, inner);
    expect(jest.getTimerCount()).toBe(1);

    gate.destroy();

    expect(jest.getTimerCount()).toBe(0);
    const r = await p;
    expect(JSON.parse(r.content)).toEqual({ answered: false, reason: 'session_terminated' });
    expect(r.tool_use_id).toBe('call-1');
    expect(inner).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Group 3: wrapAskDispatcherWithGates — short-circuit ordering
// =============================================================================
describe('wrapAskDispatcherWithGates — short-circuit ordering', () => {
  test('restrainedMode active → inner NEVER called; filledSlotsShadow STILL called; reason="restrained_mode"; counters NOT incremented', async () => {
    const logger = makeLogger();
    const inner = makeInnerDispatcher();
    const askBudget = makeBudget();
    const restrainedMode = makeRestrained({ active: true });
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });
    const filledSlotsShadow = jest.fn();

    const wrapped = wrapAskDispatcherWithGates(inner, {
      askBudget,
      restrainedMode,
      gate,
      filledSlotsShadow,
      logger,
      sessionId: 'sess-1',
    });

    const call = makeCall('call-1', 'ze', 0);
    const ctx = makeCtx();
    const result = await wrapped(call, ctx);

    expect(filledSlotsShadow).toHaveBeenCalledTimes(1);
    expect(filledSlotsShadow).toHaveBeenCalledWith(call, ctx);
    expect(inner).not.toHaveBeenCalled();
    expect(JSON.parse(result.content)).toEqual({ answered: false, reason: 'restrained_mode' });
    expect(result.tool_use_id).toBe('call-1');
    expect(result.is_error).toBe(false);

    expect(askBudget.increment).not.toHaveBeenCalled();
    expect(restrainedMode.recordAsk).not.toHaveBeenCalled();

    gate.destroy();
  });

  test('restrained inactive + budget exhausted → inner NEVER called; filledSlotsShadow STILL called; reason="ask_budget_exhausted"; counters NOT incremented', async () => {
    const logger = makeLogger();
    const inner = makeInnerDispatcher();
    const askBudget = makeBudget({ exhausted: true });
    const restrainedMode = makeRestrained({ active: false });
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });
    const filledSlotsShadow = jest.fn();

    const wrapped = wrapAskDispatcherWithGates(inner, {
      askBudget,
      restrainedMode,
      gate,
      filledSlotsShadow,
      logger,
      sessionId: 'sess-1',
    });

    const call = makeCall('call-1', 'ze', 0);
    const ctx = makeCtx();
    const result = await wrapped(call, ctx);

    expect(filledSlotsShadow).toHaveBeenCalledTimes(1);
    expect(inner).not.toHaveBeenCalled();
    expect(JSON.parse(result.content)).toEqual({
      answered: false,
      reason: 'ask_budget_exhausted',
    });
    // Budget check happened — but the post-dispatch increment must NOT fire
    // for a short-circuited ask (Pitfall 4).
    expect(askBudget.isExhausted).toHaveBeenCalledWith('ze:0');
    expect(askBudget.increment).not.toHaveBeenCalled();
    expect(restrainedMode.recordAsk).not.toHaveBeenCalled();

    gate.destroy();
  });

  test('both inactive → gate debounces; replaced ask resolves reason="gated"; replacement fires inner; only the SUCCESSFUL fire increments counters', async () => {
    const logger = makeLogger();
    const inner = makeInnerDispatcher();
    const askBudget = makeBudget();
    const restrainedMode = makeRestrained();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });
    const filledSlotsShadow = jest.fn();

    const wrapped = wrapAskDispatcherWithGates(inner, {
      askBudget,
      restrainedMode,
      gate,
      filledSlotsShadow,
      logger,
      sessionId: 'sess-1',
    });

    const call1 = makeCall('call-1', 'ze', 0);
    const call2 = makeCall('call-2', 'ze', 0); // same key — replaces
    const ctx = makeCtx();

    const p1 = wrapped(call1, ctx);
    jest.advanceTimersByTime(400);
    const p2 = wrapped(call2, ctx);

    const r1 = await p1;
    expect(JSON.parse(r1.content).reason).toBe('gated');
    // Pitfall 4: gated short-circuit must NOT consume budget or
    // restrained-window slot.
    expect(askBudget.increment).not.toHaveBeenCalled();
    expect(restrainedMode.recordAsk).not.toHaveBeenCalled();

    jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);
    const r2 = await p2;
    expect(JSON.parse(r2.content).answered).toBe(true);

    // Only the successful fire counts.
    expect(askBudget.increment).toHaveBeenCalledTimes(1);
    expect(askBudget.increment).toHaveBeenCalledWith('ze:0');
    expect(restrainedMode.recordAsk).toHaveBeenCalledTimes(1);
    expect(restrainedMode.recordAsk).toHaveBeenCalledWith(ctx.turnId);

    // filledSlotsShadow ran on EACH attempted ask — twice.
    expect(filledSlotsShadow).toHaveBeenCalledTimes(2);

    gate.destroy();
  });

  test('filledSlotsShadow is invoked on EVERY attempted ask (regardless of subsequent short-circuit)', async () => {
    const logger = makeLogger();
    const inner = makeInnerDispatcher();
    const askBudget = makeBudget();
    const filledSlotsShadow = jest.fn();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });

    // First attempt — restrained ON, short-circuits.
    const restrainedActive = makeRestrained({ active: true });
    const wrappedActive = wrapAskDispatcherWithGates(inner, {
      askBudget,
      restrainedMode: restrainedActive,
      gate,
      filledSlotsShadow,
      logger,
      sessionId: 'sess-1',
    });
    await wrappedActive(makeCall('call-1', 'ze', 0), makeCtx());
    expect(filledSlotsShadow).toHaveBeenCalledTimes(1);

    // Second attempt — budget exhausted, short-circuits.
    const restrainedInactive = makeRestrained({ active: false });
    const askBudgetExhausted = makeBudget({ exhausted: true });
    const wrappedExhausted = wrapAskDispatcherWithGates(inner, {
      askBudget: askBudgetExhausted,
      restrainedMode: restrainedInactive,
      gate,
      filledSlotsShadow,
      logger,
      sessionId: 'sess-1',
    });
    await wrappedExhausted(makeCall('call-2', 'pfc', 0), makeCtx());
    expect(filledSlotsShadow).toHaveBeenCalledTimes(2);

    gate.destroy();
  });
});

// =============================================================================
// Group 4: synthResult shape + STO-02 logging
// =============================================================================
describe('wrapAskDispatcherWithGates — synthResult shape and logging', () => {
  test('short-circuit envelope shape: { tool_use_id: call.id, content: JSON({answered:false,reason}), is_error: false }', async () => {
    const logger = makeLogger();
    const inner = makeInnerDispatcher();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });
    const wrapped = wrapAskDispatcherWithGates(inner, {
      askBudget: makeBudget(),
      restrainedMode: makeRestrained({ active: true }),
      gate,
      filledSlotsShadow: () => {},
      logger,
      sessionId: 'sess-1',
    });

    const call = makeCall('call-1', 'ze', 0);
    const result = await wrapped(call, makeCtx());

    expect(result.tool_use_id).toBe('call-1');
    expect(typeof result.content).toBe('string');
    expect(result.is_error).toBe(false);
    const body = JSON.parse(result.content);
    expect(body.answered).toBe(false);
    expect(typeof body.reason).toBe('string');

    gate.destroy();
  });

  test('exactly one logger.info row per short-circuit path with answer_outcome === reason and wait_duration_ms === 0', async () => {
    const logger = makeLogger();
    const inner = makeInnerDispatcher();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });
    const wrapped = wrapAskDispatcherWithGates(inner, {
      askBudget: makeBudget(),
      restrainedMode: makeRestrained({ active: true }),
      gate,
      filledSlotsShadow: () => {},
      logger,
      sessionId: 'sess-1',
    });

    await wrapped(makeCall('call-1', 'ze', 0), makeCtx());

    // logAskUser uses logger.info with first arg 'stage6.ask_user' — find it.
    const askUserCalls = logger.info.mock.calls.filter((c) => c[0] === 'stage6.ask_user');
    expect(askUserCalls).toHaveLength(1);
    const payload = askUserCalls[0][1];
    expect(payload.answer_outcome).toBe('restrained_mode');
    expect(payload.wait_duration_ms).toBe(0);
    expect(payload.mode).toBe('live');
    expect(payload.tool_call_id).toBe('call-1');
    expect(payload.sessionId).toBe('sess-1');
    expect(payload.turnId).toBe('sess-1-turn-1');

    gate.destroy();
  });
});

// =============================================================================
// Group 5: Pitfall 4 — counters increment ONLY on successful fire
// =============================================================================
describe('wrapAskDispatcherWithGates — Pitfall 4: counters only on successful fire', () => {
  test('happy path: gate fires inner, wrapper increments askBudget(key) + restrainedMode.recordAsk(turnId) exactly once', async () => {
    const logger = makeLogger();
    const inner = makeInnerDispatcher({ answered: true, user_text: 'yes' });
    const askBudget = makeBudget();
    const restrainedMode = makeRestrained();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });

    const wrapped = wrapAskDispatcherWithGates(inner, {
      askBudget,
      restrainedMode,
      gate,
      filledSlotsShadow: () => {},
      logger,
      sessionId: 'sess-1',
    });

    const call = makeCall('call-1', 'ze', 0);
    const ctx = makeCtx('sess-1-turn-7');
    const promise = wrapped(call, ctx);

    jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);
    const result = await promise;

    expect(JSON.parse(result.content).answered).toBe(true);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(askBudget.increment).toHaveBeenCalledTimes(1);
    expect(askBudget.increment).toHaveBeenCalledWith('ze:0');
    expect(restrainedMode.recordAsk).toHaveBeenCalledTimes(1);
    expect(restrainedMode.recordAsk).toHaveBeenCalledWith('sess-1-turn-7');

    gate.destroy();
  });

  test('inner dispatcher returning answered:false (e.g. timeout) STILL increments counters — counters track FIRES, not user-yes outcomes', async () => {
    // Rationale: budget caps how many times Sonnet may PROBE the user for
    // a given (field, circuit). A timeout used the budget slot just as
    // surely as a real answer did — otherwise Sonnet could spam asks and
    // cycle through every counter slot without ever burning one.
    const logger = makeLogger();
    const inner = makeInnerDispatcher({ answered: false, reason: 'timeout' });
    const askBudget = makeBudget();
    const restrainedMode = makeRestrained();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });

    const wrapped = wrapAskDispatcherWithGates(inner, {
      askBudget,
      restrainedMode,
      gate,
      filledSlotsShadow: () => {},
      logger,
      sessionId: 'sess-1',
    });

    const promise = wrapped(makeCall('call-1', 'ze', 0), makeCtx());
    jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);
    await promise;

    expect(askBudget.increment).toHaveBeenCalledTimes(1);
    expect(restrainedMode.recordAsk).toHaveBeenCalledTimes(1);

    gate.destroy();
  });
});

// =============================================================================
// Group 6: Plan 05-07 r1-#3 — mode is threaded through wrapper short-circuits
// =============================================================================
// The wrapper emits one stage6.ask_user log row per attempted ask (with
// answer_outcome set to the short-circuit reason or the inner dispatcher's
// outcome). Plan 05-05 r19 closed the mode-typo gate with a closed enum
// {shadow, live}. r1-#3 surfaced that the wrapper had hard-coded mode='live'
// at synthResultWrapped, so when runShadowHarness composes the wrapper inside
// the shadow path the rows mis-tagged shadow asks as live — Phase 8
// dashboards split by mode, so this corrupts the split.
//
// Fix threads `mode` through both createAskGateWrapper opts (covers gated +
// session_terminated + dispatcher_error paths) and wrapAskDispatcherWithGates
// opts (covers restrained_mode + ask_budget_exhausted paths). Default 'live'
// preserves every existing caller's behaviour. Production wiring in
// stage6-shadow-harness.js explicitly passes mode:'shadow' so its rows
// match the session's actual mode.
// =============================================================================

describe("Plan 05-07 r1-#3 — synthResultWrapped honours opts.mode (defaults to 'live')", () => {
  test("createAskGateWrapper({mode:'shadow'}) → destroy()-emitted session_terminated row carries mode:'shadow'", async () => {
    const logger = makeLogger();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1', mode: 'shadow' });
    const inner = makeInnerDispatcher();

    // Start a gateOrFire then immediately destroy — destroy() emits the
    // session_terminated synthResult, which is the wrapper-internal short-
    // circuit that carries the gate's `mode` opt.
    const p = gate.gateOrFire(makeCall('call-1', 'ze', 0), makeCtx(), inner);
    gate.destroy();
    const r = await p;
    expect(JSON.parse(r.content).reason).toBe('session_terminated');

    const askUserCalls = logger.info.mock.calls.filter((c) => c[0] === 'stage6.ask_user');
    expect(askUserCalls.length).toBeGreaterThanOrEqual(1);
    // Every wrapper-emitted row in this scenario must carry the shadow mode.
    for (const [, payload] of askUserCalls) {
      expect(payload.mode).toBe('shadow');
    }
  });

  test("wrapAskDispatcherWithGates({mode:'shadow'}) + restrainedMode active → row carries mode:'shadow'", async () => {
    const logger = makeLogger();
    const inner = makeInnerDispatcher();
    const askBudget = makeBudget();
    const restrainedMode = makeRestrained({ active: true });
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1', mode: 'shadow' });

    const wrapped = wrapAskDispatcherWithGates(inner, {
      askBudget,
      restrainedMode,
      gate,
      filledSlotsShadow: () => {},
      logger,
      sessionId: 'sess-1',
      mode: 'shadow',
    });

    await wrapped(makeCall('call-1', 'ze', 0), makeCtx());

    const askUserCalls = logger.info.mock.calls.filter((c) => c[0] === 'stage6.ask_user');
    expect(askUserCalls).toHaveLength(1);
    expect(askUserCalls[0][1].answer_outcome).toBe('restrained_mode');
    expect(askUserCalls[0][1].mode).toBe('shadow');

    gate.destroy();
  });

  test("wrapAskDispatcherWithGates({mode:'shadow'}) + budget exhausted → row carries mode:'shadow'", async () => {
    const logger = makeLogger();
    const inner = makeInnerDispatcher();
    const askBudget = makeBudget({ exhausted: true });
    const restrainedMode = makeRestrained({ active: false });
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1', mode: 'shadow' });

    const wrapped = wrapAskDispatcherWithGates(inner, {
      askBudget,
      restrainedMode,
      gate,
      filledSlotsShadow: () => {},
      logger,
      sessionId: 'sess-1',
      mode: 'shadow',
    });

    await wrapped(makeCall('call-1', 'ze', 0), makeCtx());

    const askUserCalls = logger.info.mock.calls.filter((c) => c[0] === 'stage6.ask_user');
    expect(askUserCalls).toHaveLength(1);
    expect(askUserCalls[0][1].answer_outcome).toBe('ask_budget_exhausted');
    expect(askUserCalls[0][1].mode).toBe('shadow');

    gate.destroy();
  });

  test("gated short-circuit (same-key replacement) carries mode:'shadow' when wrapper composed in shadow", async () => {
    const logger = makeLogger();
    const inner = makeInnerDispatcher();
    const askBudget = makeBudget();
    const restrainedMode = makeRestrained({ active: false });
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1', mode: 'shadow' });

    const wrapped = wrapAskDispatcherWithGates(inner, {
      askBudget,
      restrainedMode,
      gate,
      filledSlotsShadow: () => {},
      logger,
      sessionId: 'sess-1',
      mode: 'shadow',
    });

    const call1 = makeCall('call-1', 'ze', 0);
    const call2 = makeCall('call-2', 'ze', 0); // same key — replaces
    const ctx = makeCtx();

    const p1 = wrapped(call1, ctx);
    jest.advanceTimersByTime(400);
    const p2 = wrapped(call2, ctx);

    const r1 = await p1;
    expect(JSON.parse(r1.content).reason).toBe('gated');

    jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);
    await p2;

    const askUserCalls = logger.info.mock.calls.filter((c) => c[0] === 'stage6.ask_user');
    // The first call's gated synth-result emits a stage6.ask_user row.
    const gatedRow = askUserCalls.find(([, p]) => p.answer_outcome === 'gated');
    expect(gatedRow).toBeDefined();
    expect(gatedRow[1].mode).toBe('shadow');

    gate.destroy();
  });

  test("default opts → mode:'live' (regression lock — every existing caller still emits live)", async () => {
    const logger = makeLogger();
    const inner = makeInnerDispatcher();
    const askBudget = makeBudget();
    const restrainedMode = makeRestrained({ active: true });
    // No `mode` opt on either createAskGateWrapper or wrapAskDispatcherWithGates.
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });

    const wrapped = wrapAskDispatcherWithGates(inner, {
      askBudget,
      restrainedMode,
      gate,
      filledSlotsShadow: () => {},
      logger,
      sessionId: 'sess-1',
    });

    await wrapped(makeCall('call-1', 'ze', 0), makeCtx());

    const askUserCalls = logger.info.mock.calls.filter((c) => c[0] === 'stage6.ask_user');
    expect(askUserCalls).toHaveLength(1);
    expect(askUserCalls[0][1].answer_outcome).toBe('restrained_mode');
    expect(askUserCalls[0][1].mode).toBe('live'); // default — every existing test relies on this

    gate.destroy();
  });
});

// =============================================================================
// Group 7: Plan 05-08 r2-#1 — PRE_EMIT_NON_FIRE_REASONS treated as non-fires
// =============================================================================
// The inner dispatcher (Plan 03-05 + 04-26) emits three reasons whose
// envelopes signal "the ask never reached iOS / never registered with
// pendingAsks":
//
//   - validation_error  (Plan 03-02 — invalid input rejected pre-dispatch)
//   - duplicate_tool_call_id  (Plan 03-05 — SDK retry-replay caught at register)
//   - prompt_leak_blocked  (Plan 04-26 — prompt-leak filter blocked pre-emit)
//
// Pre-fix the wrapper's isRealFire returned `true` for these (they aren't in
// WRAPPER_SHORT_CIRCUIT_REASONS) so wrapAskDispatcherWithGates incremented
// askBudget + restrainedMode.recordAsk for them. That is wrong — the budget
// cap counts "Sonnet successfully probed the user", and these reasons mean
// the user was never probed. Effects:
//   - Budget burned on inputs that never reached the user.
//   - Restrained-mode rolling-5-turn counter saw phantom asks, raising the
//     false-positive activation rate.
//
// Fix: PRE_EMIT_NON_FIRE_REASONS frozen Set in stage6-ask-gate-wrapper.js;
// isRealFire returns false when body.reason is in the set. Exported so the
// offline harness can extend HARNESS_WRAPPER_SHORT_CIRCUIT_REASONS with the
// same values (single source of truth — runtime budget AND offline askCount
// share the classifier).
//
// Tests pass an inner dispatcher that returns the pre-emit envelope verbatim
// (the inner dispatcher already emitted its STO-02 row before returning, so
// the wrapper's job is purely to NOT consume budget on these).
// =============================================================================

describe('Plan 05-08 r2-#1 — PRE_EMIT_NON_FIRE_REASONS treated as non-fires', () => {
  function makeInnerDispatcherReturning(reason, isError = false) {
    return jest.fn(async (call /* , ctx */) => ({
      tool_use_id: call.id,
      content: JSON.stringify({ answered: false, reason }),
      is_error: isError,
    }));
  }

  test('validation_error → askBudget.increment + restrainedMode.recordAsk NOT called', async () => {
    const logger = makeLogger();
    // Real dispatcher returns is_error:true on validation_error (only outcome
    // that does so) — the wrapper's accounting must still treat it as a
    // pre-emit non-fire regardless of the is_error flag.
    const inner = makeInnerDispatcherReturning('validation_error', true);
    const askBudget = makeBudget();
    const restrainedMode = makeRestrained();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });

    const wrapped = wrapAskDispatcherWithGates(inner, {
      askBudget,
      restrainedMode,
      gate,
      filledSlotsShadow: () => {},
      logger,
      sessionId: 'sess-1',
    });

    const promise = wrapped(makeCall('call-1', 'ze', 0), makeCtx('sess-1-turn-1'));
    jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);
    const result = await promise;

    expect(JSON.parse(result.content).reason).toBe('validation_error');
    expect(askBudget.increment).not.toHaveBeenCalled();
    expect(restrainedMode.recordAsk).not.toHaveBeenCalled();

    gate.destroy();
  });

  test('duplicate_tool_call_id → askBudget.increment + restrainedMode.recordAsk NOT called', async () => {
    const logger = makeLogger();
    const inner = makeInnerDispatcherReturning('duplicate_tool_call_id', false);
    const askBudget = makeBudget();
    const restrainedMode = makeRestrained();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });

    const wrapped = wrapAskDispatcherWithGates(inner, {
      askBudget,
      restrainedMode,
      gate,
      filledSlotsShadow: () => {},
      logger,
      sessionId: 'sess-1',
    });

    const promise = wrapped(makeCall('call-1', 'ze', 0), makeCtx('sess-1-turn-1'));
    jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);
    const result = await promise;

    expect(JSON.parse(result.content).reason).toBe('duplicate_tool_call_id');
    expect(askBudget.increment).not.toHaveBeenCalled();
    expect(restrainedMode.recordAsk).not.toHaveBeenCalled();

    gate.destroy();
  });

  test('prompt_leak_blocked → askBudget.increment + restrainedMode.recordAsk NOT called', async () => {
    const logger = makeLogger();
    const inner = makeInnerDispatcherReturning('prompt_leak_blocked', false);
    const askBudget = makeBudget();
    const restrainedMode = makeRestrained();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });

    const wrapped = wrapAskDispatcherWithGates(inner, {
      askBudget,
      restrainedMode,
      gate,
      filledSlotsShadow: () => {},
      logger,
      sessionId: 'sess-1',
    });

    const promise = wrapped(makeCall('call-1', 'ze', 0), makeCtx('sess-1-turn-1'));
    jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);
    const result = await promise;

    expect(JSON.parse(result.content).reason).toBe('prompt_leak_blocked');
    expect(askBudget.increment).not.toHaveBeenCalled();
    expect(restrainedMode.recordAsk).not.toHaveBeenCalled();

    gate.destroy();
  });

  // ===========================================================================
  // Plan 05-09 r3-#1 — shadow_mode is ALSO a pre-emit non-fire.
  // ===========================================================================
  // Codex r3 review of Plan 05-08's closure surface raised this finding:
  // shadow_mode is structurally pre-emit. Inner dispatcher returns the
  // shadow_mode envelope at stage6-dispatcher-ask.js:206-225 — that block
  // is BEFORE step 3 (line 228+) where pendingAsks.register and
  // ws.send(ask_user_started) run. So shadow_mode runs are no-iOS-emission,
  // no-registry-register: identical pre-emit pattern to the other three
  // reasons in PRE_EMIT_NON_FIRE_REASONS.
  //
  // Plan 05-08 D2 wording was wrong: it claimed "shadow_mode runs after
  // validation + leak filter ... so it counts as a fire". Post-validation
  // + post-leak-filter is true but irrelevant — the relevant predicate is
  // "before register + ws.send", which holds for shadow_mode.
  //
  // Effect of the pre-fix bug (production):
  //   - Shadow runs (Plan 05-02 + Plan 05-04 shadow harness) burned
  //     askBudget on every shadow_mode envelope. Shadow's whole point is
  //     observe-without-affect — burning shadow runs against the budget
  //     cap is the OPPOSITE of that.
  //   - Worse: shadow-mode rolling-5-turn restrained-mode counter accrued
  //     phantom asks, contaminating the next live run's threshold
  //     accounting.
  //
  // Fix: add 'shadow_mode' to PRE_EMIT_NON_FIRE_REASONS. The harness
  // automatically inherits via the existing ...PRE_EMIT_NON_FIRE_REASONS
  // spread (single source of truth).
  // ===========================================================================
  test('shadow_mode → askBudget.increment + restrainedMode.recordAsk NOT called', async () => {
    const logger = makeLogger();
    const inner = makeInnerDispatcherReturning('shadow_mode', false);
    const askBudget = makeBudget();
    const restrainedMode = makeRestrained();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });

    const wrapped = wrapAskDispatcherWithGates(inner, {
      askBudget,
      restrainedMode,
      gate,
      filledSlotsShadow: () => {},
      logger,
      sessionId: 'sess-1',
    });

    const promise = wrapped(makeCall('call-1', 'ze', 0), makeCtx('sess-1-turn-1'));
    jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);
    const result = await promise;

    expect(JSON.parse(result.content).reason).toBe('shadow_mode');
    expect(askBudget.increment).not.toHaveBeenCalled();
    expect(restrainedMode.recordAsk).not.toHaveBeenCalled();

    gate.destroy();
  });

  test('regression lock — inner-dispatcher reasons NOT in PRE_EMIT_NON_FIRE_REASONS still count as fires', async () => {
    // user_moved_on / timeout / etc are real fires (Sonnet did probe the
    // user; the user just didn't engage). These MUST still increment.
    // Same case lives in Group 5 but we keep an explicit r2-#1 lock so a
    // future careless edit to PRE_EMIT_NON_FIRE_REASONS that accidentally
    // includes user_moved_on flips this regression test red.
    const logger = makeLogger();
    const inner = makeInnerDispatcherReturning('user_moved_on', false);
    const askBudget = makeBudget();
    const restrainedMode = makeRestrained();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });

    const wrapped = wrapAskDispatcherWithGates(inner, {
      askBudget,
      restrainedMode,
      gate,
      filledSlotsShadow: () => {},
      logger,
      sessionId: 'sess-1',
    });

    const promise = wrapped(makeCall('call-1', 'ze', 0), makeCtx('sess-1-turn-1'));
    jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);
    await promise;

    expect(askBudget.increment).toHaveBeenCalledTimes(1);
    expect(restrainedMode.recordAsk).toHaveBeenCalledTimes(1);

    gate.destroy();
  });
});

// =============================================================================
// Group 8: Plan 05-08 r2-#2 — null/"none" alternation cannot bypass per-key budget
// =============================================================================
// End-to-end lock: 4 calls with context_field alternating between
// `[null, 'none', 'NONE', null]` for the same context_circuit must all
// land in the same `'_:N'` bucket of the REAL askBudget. With cap=2 the
// first two calls fire the inner dispatcher and the last two
// short-circuit with reason='ask_budget_exhausted'.
//
// We use the REAL createAskBudget (not the mock from makeBudget()) so the
// counters' bucket-by-key behaviour is exercised end-to-end.
// =============================================================================

describe('Plan 05-08 r2-#2 — null/"none" alternation cannot bypass per-key budget', () => {
  test('4-call alternation with same circuit hits same bucket; first 2 fire, last 2 short-circuit', async () => {
    const logger = makeLogger();
    const inner = makeInnerDispatcher();
    const askBudget = createAskBudget({ maxAsksPerKey: 2 });
    const restrainedMode = makeRestrained({ active: false });
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });

    const wrapped = wrapAskDispatcherWithGates(inner, {
      askBudget,
      restrainedMode,
      gate,
      filledSlotsShadow: () => {},
      logger,
      sessionId: 'sess-1',
    });

    // Same circuit number across all 4 calls; field alternates between
    // the four sentinel forms (null + 'none' + 'NONE' + null). Every
    // form MUST resolve to the same budget key '_:7'.
    //
    // Plan 05-10 r4-#1 — Codex r4 surfaced that Plan 05-09 r3-#3
    // had narrowed deriveAskKey to verbatim case-sensitive matching,
    // arguing that the validator catches upper-case forms first and
    // case-insensitivity at the wrapper was dead code. That argument
    // was wrong because deriveAskKey runs at the WRAPPER layer
    // (wrapAskDispatcherWithGates line ~317) BEFORE the inner
    // dispatcher's validateAskUser. So case-sensitive matching at the
    // wrapper let alternating cases ([null, 'none', 'NONE', null])
    // derive 4 distinct keys, bypassing the wrapper's same-key
    // debounce + per-key budget gates BEFORE the validator could
    // reject. The validator still rejected each malformed call; but
    // the wrapper's protective gates were bypassed.
    //
    // r4-#1 reverts to case-insensitive sentinel matching — every case
    // variant of 'none' collapses to '_'. The variants list goes back
    // to its r2-#2 form: 4 calls, same logical scope, same per-key
    // budget bucket '_:7'. With cap=2: first 2 fire, last 2
    // short-circuit ask_budget_exhausted. Pre-r4-#1 (under r3-#3's
    // case-sensitive matching) call 3 would have its own 'NONE:7'
    // bucket and fire freely — this test FAILS pre-r4-#1.
    const variants = [null, 'none', 'NONE', null];
    const results = [];
    for (let i = 0; i < variants.length; i++) {
      const call = makeCall(`call-${i + 1}`, variants[i], 7);
      const ctx = makeCtx(`sess-1-turn-${i + 1}`);
      const p = wrapped(call, ctx);
      jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);

      results.push(await p);
    }

    // First two: real fires (inner dispatcher invoked, answered:true).
    expect(JSON.parse(results[0].content).answered).toBe(true);
    expect(JSON.parse(results[1].content).answered).toBe(true);
    // Last two: ask_budget_exhausted short-circuit (the wrapper's pre-
    // dispatch check sees isExhausted('_:7') === true).
    expect(JSON.parse(results[2].content).reason).toBe('ask_budget_exhausted');
    expect(JSON.parse(results[3].content).reason).toBe('ask_budget_exhausted');

    expect(inner).toHaveBeenCalledTimes(2);

    gate.destroy();
  });

  test('regression lock — distinct REAL field values do NOT bypass each other', () => {
    // Sanity: r2-#2's canonicalisation must NOT widen to non-sentinel
    // values. 'ze' and 'zs' are distinct schema values and must keep
    // distinct keys.
    expect(deriveAskKey({ context_field: 'ze', context_circuit: 7 })).not.toBe(
      deriveAskKey({ context_field: 'zs', context_circuit: 7 })
    );
    expect(deriveAskKey({ context_field: 'measured_r1_plus_r2', context_circuit: null })).not.toBe(
      deriveAskKey({ context_field: 'measured_zs_ohm', context_circuit: null })
    );
  });

  // =========================================================================
  // Plan 05-11 r5-#1 — padded-sentinel alternation cannot bypass per-key
  // budget end-to-end. Mirrors the r4-#1 alternation test but uses
  // whitespace padding instead of case alternation.
  // =========================================================================
  test('Plan 05-11 r5-#1 — 4-call padded-sentinel alternation hits same bucket; first 2 fire, last 2 short-circuit', async () => {
    const logger = makeLogger();
    const inner = makeInnerDispatcher();
    const askBudget = createAskBudget({ maxAsksPerKey: 2 });
    const restrainedMode = makeRestrained({ active: false });
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });

    const wrapped = wrapAskDispatcherWithGates(inner, {
      askBudget,
      restrainedMode,
      gate,
      filledSlotsShadow: () => {},
      logger,
      sessionId: 'sess-1',
    });

    // 4 sentinel variants, all whitespace-padded, every one mapping
    // to the same '_:7' bucket post-r5-#1. Pre-r5-#1 each padded
    // form derived its own distinct key (' none :7', '\tNONE\n:7',
    // etc.) so the per-key budget had 4 independent buckets and the
    // 1500ms debounce never collapsed any of them — Sonnet could
    // freely retry by alternating padding within a single turn.
    const variants = [null, ' none ', '\tNONE\n', ' None'];
    const results = [];
    for (let i = 0; i < variants.length; i += 1) {
      const call = makeCall(`call-${i + 1}`, variants[i], 7);
      const ctx = makeCtx(`sess-1-turn-${i + 1}`);
      const p = wrapped(call, ctx);
      jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);
      results.push(await p);
    }

    // First two: real fires (inner dispatcher invoked, answered:true).
    expect(JSON.parse(results[0].content).answered).toBe(true);
    expect(JSON.parse(results[1].content).answered).toBe(true);
    // Last two: ask_budget_exhausted (cap=2 hit, all 4 in same bucket).
    expect(JSON.parse(results[2].content).reason).toBe('ask_budget_exhausted');
    expect(JSON.parse(results[3].content).reason).toBe('ask_budget_exhausted');

    expect(inner).toHaveBeenCalledTimes(2);

    gate.destroy();
  });
});

// =============================================================================
// Group 9: Plan 05-10 r4-#2 — predicate helpers replace mutable Set exports
// =============================================================================
// Pre-r4-#2 the wrapper exported two Sets:
//   - WRAPPER_SHORT_CIRCUIT_REASONS = new Set([...])
//     (no Object.freeze at all — bare Set)
//   - PRE_EMIT_NON_FIRE_REASONS = Object.freeze(new Set([...]))
//
// Object.freeze on a Set DOES NOT prevent .add() / .delete() — it freezes
// the Set object's own enumerable properties + prevents extensions, but
// the Set's internal [[SetData]] slot is unaffected. So an importer
// could call:
//   import { WRAPPER_SHORT_CIRCUIT_REASONS } from '...';
//   WRAPPER_SHORT_CIRCUIT_REASONS.add('foo');
//   // → silently changes the budget classifier in this process for
//   //   the remainder of its lifetime; harness's
//   //   HARNESS_WRAPPER_SHORT_CIRCUIT_REASONS spread on next harness
//   //   run also pulls in 'foo'.
// Or:
//   PRE_EMIT_NON_FIRE_REASONS.delete('shadow_mode');
//   // → silently undoes Plan 05-09 r3-#1's fix.
//
// Footgun, not active attack surface (we don't pass these Sets to
// untrusted code), but the API contract is that they're constants and
// the previous shape didn't enforce it.
//
// r4-#2 fix: replace exported Sets with predicate helpers
//   isWrapperShortCircuitReason(reason: string): boolean
//   isPreEmitNonFireReason(reason: string): boolean
// Module-private Sets stay (immutable from outside since they're not
// exported). The harness updates to use the predicates instead of
// importing + spreading the Sets — single source of truth becomes the
// predicate behaviour, not the Set's contents.
// =============================================================================

describe('Plan 05-10 r4-#2 — predicate helpers replace mutable Set exports', () => {
  test('isWrapperShortCircuitReason exported as a function', () => {
    expect(typeof isWrapperShortCircuitReason).toBe('function');
  });

  test('isWrapperShortCircuitReason returns true for every legacy member (post-r5-#2)', () => {
    // Legacy WRAPPER_SHORT_CIRCUIT_REASONS members (Plan 05-01 +
    // r1-#1 audit prose). Plan 05-11 r5-#2 splits dispatcher_error
    // into two reasons:
    //   - 'gate_dispatcher_error' (NEW) — wrapper-internal failures.
    //     Reserved at r5-#2 closure for any future wrapper-side catch
    //     (e.g. timer-leak, gate.destroy mid-fire). True non-fire.
    //   - 'dispatcher_error' (REMOVED from this set at r5-#2) —
    //     conservatively reclassified as a real fire because the
    //     inner dispatcher's outer catch block (line 321 of
    //     stage6-dispatcher-ask.js) wraps everything inside the
    //     live-path Promise constructor including post-register +
    //     post-ws.send code paths. We cannot prove pre-emit on every
    //     code path, so we count as fire.
    expect(isWrapperShortCircuitReason('gated')).toBe(true);
    expect(isWrapperShortCircuitReason('session_terminated')).toBe(true);
    expect(isWrapperShortCircuitReason('gate_dispatcher_error')).toBe(true);
  });

  test('isWrapperShortCircuitReason returns false for non-members (post-r5-#2)', () => {
    // Real-fire reasons (inner dispatcher answers; not wrapper short-
    // circuits) MUST return false.
    expect(isWrapperShortCircuitReason('answered')).toBe(false);
    expect(isWrapperShortCircuitReason('user_moved_on')).toBe(false);
    expect(isWrapperShortCircuitReason('timeout')).toBe(false);
    // PRE_EMIT_NON_FIRE_REASONS members are NOT wrapper short-circuit
    // reasons — they live in a separate set.
    expect(isWrapperShortCircuitReason('validation_error')).toBe(false);
    expect(isWrapperShortCircuitReason('shadow_mode')).toBe(false);
    // Wrapper-emitted but post-dispatch synth (handled in
    // wrapAskDispatcherWithGates pre-dispatch branches, not in
    // isRealFire's classifier path):
    expect(isWrapperShortCircuitReason('restrained_mode')).toBe(false);
    expect(isWrapperShortCircuitReason('ask_budget_exhausted')).toBe(false);
    // Plan 05-11 r5-#2 → Plan 05-12 r6 — `dispatcher_error` is
    // NOT a wrapper short-circuit reason. r5-#2 removed it from
    // this set (was a wrapper short-circuit pre-r5-#2). r6
    // reclassifies it again — but to _PRE_EMIT_NON_FIRE_REASONS
    // (semantic fit: dispatcher_error originates from the inner
    // dispatcher's outer catch, alongside validation_error /
    // shadow_mode / etc), NOT back to _WRAPPER_SHORT_CIRCUIT_REASONS.
    // So the expectation here stays `false` — but the reason is
    // now "it's a dispatcher pre-emit reason" not "it's a real
    // fire". See the Group 9 r6 test
    // ("isPreEmitNonFireReason returns true for every legacy
    // member (incl. r3-#1 shadow_mode + r6 dispatcher_error)") for
    // the membership-side lock.
    expect(isWrapperShortCircuitReason('dispatcher_error')).toBe(false);
    // Garbage input must not throw and must return false.
    expect(isWrapperShortCircuitReason('not-a-real-reason')).toBe(false);
    expect(isWrapperShortCircuitReason('')).toBe(false);
  });

  test('isPreEmitNonFireReason exported as a function', () => {
    expect(typeof isPreEmitNonFireReason).toBe('function');
  });

  test('isPreEmitNonFireReason returns true for every legacy member (incl. r3-#1 shadow_mode + r6 dispatcher_error)', () => {
    // Plan 05-08 r2-#1 + Plan 05-09 r3-#1 + Plan 05-12 r6 — five
    // pre-emit reasons:
    expect(isPreEmitNonFireReason('validation_error')).toBe(true);
    expect(isPreEmitNonFireReason('duplicate_tool_call_id')).toBe(true);
    expect(isPreEmitNonFireReason('prompt_leak_blocked')).toBe(true);
    expect(isPreEmitNonFireReason('shadow_mode')).toBe(true);
    // Plan 05-12 r6-#1+#2 — `dispatcher_error` reverted to pre-emit
    // non-fire. r5-#2 conservatively classified it as fire to defend
    // against a theoretical post-emit refactor (CASE B in the wrapper
    // JSDoc audit). Codex r6 surfaced that current source has NO
    // post-emit code path: register() rethrow at line 297 is BEFORE
    // ws.send line 305; ws.send failures are caught + swallowed in
    // an inner try/catch that never reaches the outer catch; no
    // synchronous post-send work exists. So r5's classification was
    // forward-looking, not current-state-correct. r6 reverts. If a
    // future refactor adds post-emit code, introduce a NEW outcome
    // `dispatcher_error_post_emit` and classify THAT as fire — do
    // NOT reclassify dispatcher_error itself (retroactive
    // reclassification breaks historical analyzer queries).
    expect(isPreEmitNonFireReason('dispatcher_error')).toBe(true);
  });

  test('isPreEmitNonFireReason returns false for non-members', () => {
    expect(isPreEmitNonFireReason('answered')).toBe(false);
    expect(isPreEmitNonFireReason('user_moved_on')).toBe(false);
    expect(isPreEmitNonFireReason('timeout')).toBe(false);
    expect(isPreEmitNonFireReason('gated')).toBe(false);
    expect(isPreEmitNonFireReason('restrained_mode')).toBe(false);
    expect(isPreEmitNonFireReason('ask_budget_exhausted')).toBe(false);
    // Plan 05-12 r6 — `dispatcher_error` MOVED to the pre-emit set
    // (see the "returns true for every legacy member" test above
    // for full r5↔r6 lineage). Removed from this list at r6.
    //
    // Plan 05-11 r5-#2 — `gate_dispatcher_error` is wrapper-internal
    // (lives in WRAPPER_SHORT_CIRCUIT_REASONS), NOT pre-emit. The
    // semantic distinction matters: gate_dispatcher_error is reserved
    // for future WRAPPER-side catches (timer leak, gate.destroy
    // mid-fire, etc.); dispatcher_error originates from the INNER
    // dispatcher's outer catch.
    expect(isPreEmitNonFireReason('gate_dispatcher_error')).toBe(false);
    expect(isPreEmitNonFireReason('not-a-real-reason')).toBe(false);
    expect(isPreEmitNonFireReason('')).toBe(false);
  });

  test('legacy Set exports REMOVED — wrapper module exports no mutable Set', () => {
    // r4-#2 lock: the wrapper module must not export
    // WRAPPER_SHORT_CIRCUIT_REASONS or PRE_EMIT_NON_FIRE_REASONS as
    // Set instances any more. The wildcard import (`import *`) gives
    // us the entire module's public surface; we assert neither name
    // is present. Future drift that re-introduces the mutable export
    // (e.g. a careless refactor copying the Set back to the export
    // section) trips this assertion.
    expect(wrapperModule.WRAPPER_SHORT_CIRCUIT_REASONS).toBeUndefined();
    expect(wrapperModule.PRE_EMIT_NON_FIRE_REASONS).toBeUndefined();
    // Predicates ARE on the module surface (sanity-check the
    // wildcard import sees them).
    expect(wrapperModule.isWrapperShortCircuitReason).toBe(isWrapperShortCircuitReason);
    expect(wrapperModule.isPreEmitNonFireReason).toBe(isPreEmitNonFireReason);
  });

  test('regression lock — restrained_mode / ask_budget_exhausted still excluded at HARNESS layer', async () => {
    // The wrapper module's predicates do NOT include restrained_mode /
    // ask_budget_exhausted (those are wrapper-emitted but live in
    // pre-dispatch branches, not in isRealFire's classifier). The
    // HARNESS layer is what unions those into its accounting set.
    // We assert that semantics via behaviour — a wrapper run with
    // restrainedMode active must NOT increment counters (gated by
    // wrapAskDispatcherWithGates' restrainedMode branch which short-
    // circuits BEFORE the post-dispatch counter step).
    const logger = makeLogger();
    const inner = makeInnerDispatcher();
    const askBudget = makeBudget();
    const restrainedMode = makeRestrained({ active: true });
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });

    const wrapped = wrapAskDispatcherWithGates(inner, {
      askBudget,
      restrainedMode,
      gate,
      filledSlotsShadow: () => {},
      logger,
      sessionId: 'sess-1',
    });

    const result = await wrapped(makeCall('call-1', 'ze', 0), makeCtx());
    expect(JSON.parse(result.content).reason).toBe('restrained_mode');
    expect(askBudget.increment).not.toHaveBeenCalled();
    expect(restrainedMode.recordAsk).not.toHaveBeenCalled();

    gate.destroy();
  });
});

// =============================================================================
// Group 10: Plan 05-11 r5-#2 — dispatcher_error vs gate_dispatcher_error
// classification split.
// =============================================================================
// Codex r5 surfaced a lifecycle-position split for the wrapper's
// dispatcher_error reason. Pre-r5-#2 it was a member of
// WRAPPER_SHORT_CIRCUIT_REASONS so isRealFire returned false → no
// budget burn. But the inner dispatcher (stage6-dispatcher-ask.js)
// has its OWN dispatcher_error emit site at line 341 inside an outer
// try/catch starting at line 321 that wraps EVERYTHING in the
// live-path Promise constructor including post-register +
// post-ws.send code paths.
//
// Schema audit of stage6-dispatcher-ask.js dispatcher_error emit
// sites (line 341, outer catch line 321):
//
//   Inner dispatcher live-path Promise constructor:
//     line 247 — setTimeout (timer registers; no throw possible
//                synchronously)
//     line 266 — pendingAsks.register(toolCallId, entry)
//                throws on duplicate (caught at 285) or other
//                invariants (rethrown at 297). Pre-emit if it
//                throws non-duplicate at 297 (clearTimeout + throw
//                propagates to Promise → outer catch fires →
//                dispatcher_error logged at 341).
//     line 305 — ws.send('ask_user_started') wrapped in its own
//                try/catch which swallows send failures. ws.send
//                throws CANNOT reach the outer catch.
//
//   Lifecycle position of inner dispatcher_error:
//     CASE A (pre-emit): register() throws non-duplicate at 297.
//       clearTimeout + throw → Promise rejection → outer catch
//       at 321. No iOS emission. Treating as non-fire would be
//       correct here.
//     CASE B (post-emit, theoretical): if a future refactor adds
//       any synchronous code AFTER ws.send (e.g. post-send
//       analytics, post-send registry update) and that throws,
//       the SAME outer catch fires at 321 — but the user has
//       seen ask_user_started and may have started the TTS prompt.
//       Treating as non-fire here would let Sonnet bypass the cap
//       by repeatedly triggering this code path.
//
//   We cannot reliably distinguish CASE A from CASE B from the
//   envelope alone (both produce the same `dispatcher_error`
//   reason). Conservative classification: TREAT AS FIRE. The
//   false-positive cost (CASE A unnecessary budget burn) is
//   bounded at +1 budget slot per real bug. The false-negative
//   cost (CASE B Sonnet bypass) is unbounded if dispatcher_error
//   is reachable on demand.
//
// The wrapper's OWN dispatcher_error path (line 282 of the wrapper)
// fires when the timer block catches an exception thrown by the
// inner dispatcher. This is structurally pre-emit with respect to
// the wrapper's own work — but the inner dispatcher may itself
// have done post-emit work before throwing, so the conservative
// classification still applies.
//
// gate_dispatcher_error (NEW reason at r5-#2) is RESERVED for a
// future wrapper-internal catch (e.g. timer leak, gate.destroy
// mid-fire, Promise constructor synchronous failure). At r5-#2
// closure there is NO emit site — the reason is pre-registered
// in WRAPPER_SHORT_CIRCUIT_REASONS so when a future refactor
// introduces a wrapper-internal catch, the classification is
// already in place.
//
// Tests:
//   - End-to-end: inner dispatcher throws → wrapper's timer catch
//     fires → resolves with `dispatcher_error` envelope →
//     askBudget.increment + restrainedMode.recordAsk ARE called
//     (post-r5-#2 fire classification).
//   - Synthesised gate_dispatcher_error envelope (mock inner
//     returns the reason directly) → counters NOT incremented
//     (wrapper-internal non-fire reservation).
// =============================================================================

describe('Plan 05-11 r5-#2 — dispatcher_error / gate_dispatcher_error split', () => {
  function makeThrowingInner() {
    return jest.fn(async (/* call, ctx */) => {
      throw new Error('synthetic inner-dispatcher failure');
    });
  }

  function makeInnerReturning(reason) {
    return jest.fn(async (call /* , ctx */) => ({
      tool_use_id: call.id,
      content: JSON.stringify({ answered: false, reason }),
      is_error: false,
    }));
  }

  test('inner dispatcher throws → wrapper resolves dispatcher_error → counters NOT incremented (post-r6 pre-emit non-fire)', async () => {
    // The wrapper's timer block catches inner throws and resolves the
    // outer Promise with synthResultWrapped(call, 'dispatcher_error').
    //
    // r5↔r6 lineage:
    //   - Pre-r5-#2: dispatcher_error was in
    //     _WRAPPER_SHORT_CIRCUIT_REASONS — non-fire.
    //   - r5-#2: removed from wrapper short-circuit set, classified
    //     as fire (conservative defence against a theoretical CASE B
    //     post-emit refactor that could add synchronous code AFTER
    //     ws.send and reach the same outer catch).
    //   - r6: REVERTED. Codex r6 surfaced that current source has
    //     no CASE B path: register() rethrow at line 297 is BEFORE
    //     ws.send line 305; ws.send failures are caught + swallowed
    //     in an inner try/catch that never reaches the outer catch;
    //     no synchronous post-send work exists. r5's classification
    //     was forward-looking, not current-state-correct. r6 places
    //     dispatcher_error in _PRE_EMIT_NON_FIRE_REASONS (alongside
    //     validation_error / shadow_mode / etc — semantic fit:
    //     dispatcher_error originates from the inner dispatcher
    //     outer catch).
    //
    // If a future refactor adds post-emit synchronous code that can
    // throw, the right move is to introduce a NEW outcome name
    // (dispatcher_error_post_emit) and classify THAT as fire — do
    // NOT reclassify dispatcher_error itself (retroactive
    // reclassification breaks historical analyzer queries).
    const logger = makeLogger();
    const inner = makeThrowingInner();
    const askBudget = makeBudget();
    const restrainedMode = makeRestrained();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });

    const wrapped = wrapAskDispatcherWithGates(inner, {
      askBudget,
      restrainedMode,
      gate,
      filledSlotsShadow: () => {},
      logger,
      sessionId: 'sess-1',
    });

    const promise = wrapped(makeCall('call-1', 'ze', 0), makeCtx('sess-1-turn-1'));
    jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);
    const result = await promise;

    expect(JSON.parse(result.content).reason).toBe('dispatcher_error');
    // r6 reclassification: dispatcher_error is pre-emit non-fire.
    // Neither counter increments — the ask never reached iOS.
    expect(askBudget.increment).not.toHaveBeenCalled();
    expect(restrainedMode.recordAsk).not.toHaveBeenCalled();

    gate.destroy();
  });

  test('synthesised gate_dispatcher_error envelope → counters NOT incremented (wrapper-internal non-fire)', async () => {
    // gate_dispatcher_error is RESERVED for future wrapper-internal
    // catches. At r5-#2 closure there is no emit site — to test the
    // classifier we synthesise a mock inner dispatcher that returns
    // the gate_dispatcher_error envelope directly. The wrapper's
    // isRealFire must return false (consults the private
    // _WRAPPER_SHORT_CIRCUIT_REASONS Set via .has()) so neither
    // counter increments.
    const logger = makeLogger();
    const inner = makeInnerReturning('gate_dispatcher_error');
    const askBudget = makeBudget();
    const restrainedMode = makeRestrained();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });

    const wrapped = wrapAskDispatcherWithGates(inner, {
      askBudget,
      restrainedMode,
      gate,
      filledSlotsShadow: () => {},
      logger,
      sessionId: 'sess-1',
    });

    const promise = wrapped(makeCall('call-1', 'ze', 0), makeCtx('sess-1-turn-1'));
    jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);
    const result = await promise;

    expect(JSON.parse(result.content).reason).toBe('gate_dispatcher_error');
    expect(askBudget.increment).not.toHaveBeenCalled();
    expect(restrainedMode.recordAsk).not.toHaveBeenCalled();

    gate.destroy();
  });

  test('predicate: isWrapperShortCircuitReason("gate_dispatcher_error") === true', () => {
    // r5-#2 reservation: the new reason is the membership lock for
    // future wrapper-internal catches. Adding it pre-emptively means
    // a refactor that introduces a wrapper-internal try/catch can
    // emit gate_dispatcher_error and the classifier is already
    // wired correctly.
    expect(isWrapperShortCircuitReason('gate_dispatcher_error')).toBe(true);
  });

  test('predicate: isWrapperShortCircuitReason("dispatcher_error") === false', () => {
    // r5-#2 reclassification lock: dispatcher_error is removed from
    // the wrapper-short-circuit set. isRealFire returns true for
    // these envelopes (default branch, no Set.has() match) so the
    // budget + restrained-window slot are consumed.
    expect(isWrapperShortCircuitReason('dispatcher_error')).toBe(false);
  });

  test('predicate: isPreEmitNonFireReason("dispatcher_error") === true (post-r6 — reverted from r5-#2 fire)', () => {
    // r6 reclassification lock: dispatcher_error MOVED to
    // _PRE_EMIT_NON_FIRE_REASONS. r5-#2 conservatively classified
    // it as fire (NOT in pre-emit set, NOT in wrapper-short-circuit
    // set) defending against a theoretical CASE B post-emit refactor
    // that doesn't exist in current source. Codex r6 surfaced the
    // mismeasure: every dispatcher_error emit site in current
    // stage6-dispatcher-ask.js is structurally pre-emit (register
    // rethrow BEFORE ws.send; ws.send failures swallowed in inner
    // try/catch). r6 reverts to non-fire — the ask never reached
    // iOS, so budget/restrained-window slots must NOT be consumed.
    //
    // Regression lock direction is now INVERTED: the lock asserts
    // dispatcher_error is in the pre-emit set, NOT that it's
    // excluded. A future refactor that wants to add post-emit
    // dispatcher work must introduce a NEW outcome name
    // (dispatcher_error_post_emit) and classify THAT as fire —
    // dispatcher_error itself stays non-fire forever to keep
    // historical analyzer queries on stage6.ask_user log rows
    // stable across the r5↔r6 toggle window.
    expect(isPreEmitNonFireReason('dispatcher_error')).toBe(true);
  });
});
