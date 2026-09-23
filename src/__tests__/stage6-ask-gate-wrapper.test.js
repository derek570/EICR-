/**
 * Stage 6 Phase 5 Plan 05-01 — ask-gate-wrapper unit tests.
 *
 * WHAT: Locks the higher-order composition that wires the ask gates around
 * the unmodified Plan 03-05 createAskDispatcher. Composition only; the inner
 * dispatcher is a black box. The gates, in order:
 *   1. filledSlotsShadow — side-effect logging on EVERY attempted ask.
 *   1b. undeclared reserved AFDD wording → `validation_error` (pre-dispatch).
 *   2. AFDD clarification-chain guard — an `observation_clarify` ask while an
 *      AFDD flow is active that is not the canonical next question →
 *      `afdd_flow_violation` (pre-dispatch).
 *   3. 1500ms debounce — same-key replacement resolves the first call with
 *      reason='gated'.
 *   4. AFDD chain progress is recorded only on a real, answered fire.
 *
 * PLAN-B (feedback-2026-09-17, Decision 3) retired the per-key ask budget and
 * restrained mode. Nothing caps repeat asks on a key any more; the model
 * decides. These tests lock that a third and fourth same-key ask dispatch,
 * and that the wrapper composes with no budget or restrained-mode options.
 *
 * STB-05 — no existing guard weakened: composition does not mutate
 * stage6-dispatcher-ask.js; the tests prove the wrapper achieves its effect
 * via pure composition.
 *
 * Fake-timer pattern: doNotFake Promise + queueMicrotask + nextTick is
 * the Stage 6 frozen pattern (Decision 03-09). It lets jest.advanceTimersByTime
 * step the 1500ms debounce deterministically while keeping async/await
 * scheduling real.
 */

import { jest } from '@jest/globals';
import {
  createAskGateWrapper,
  wrapAskDispatcherWithGates,
  deriveAskKey,
  isWrapperShortCircuitReason,
  isPreEmitNonFireReason,
  createObsClarifyChainBroker,
} from '../extraction/stage6-ask-gate-wrapper.js';
import * as wrapperModule from '../extraction/stage6-ask-gate-wrapper.js';
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

// A broker whose AFDD flow is ACTIVE (topic already answered). Any
// observation_clarify ask that is not the canonical next AFDD question is
// then rejected pre-dispatch with `afdd_flow_violation`.
function makeActiveAfddBroker() {
  const broker = createObsClarifyChainBroker();
  const chainId = broker.mint();
  broker.noteAnsweredAfddQuestion(chainId, 'topic');
  return { broker, chainId };
}

// A generic severity clarification (no declared AFDD kind). During an active
// AFDD flow it is never the canonical next question.
function makeSeverityCall(id) {
  return {
    id,
    name: 'ask_user',
    input: {
      question: 'Is the damage cosmetic, or does it expose live parts?',
      reason: 'observation_confirmation',
      context_field: 'observation_clarify',
      context_circuit: 3,
      expected_answer_shape: 'free_text',
    },
  };
}

// A declared AFDD clarification; the wrapper renders the canonical wording.
function makeAfddCall(id, declaredKind) {
  return {
    id,
    name: 'ask_user',
    input: {
      question: 'model wording is ignored',
      reason: 'missing_context',
      context_field: 'observation_clarify',
      expected_answer_shape: 'free_text',
      observation_clarification_kind: declaredKind,
    },
  };
}

// Canonical AFDD wording WITHOUT the declared-kind enum — rejected
// pre-dispatch with `validation_error`.
function makeUndeclaredReservedAfddCall(id) {
  return {
    id,
    name: 'ask_user',
    input: {
      question: 'Is this observation about AFDD protection or surge protection?',
      reason: 'missing_context',
      context_field: 'observation_clarify',
      expected_answer_shape: 'free_text',
    },
  };
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
    // the same-key debounce for the same logical question.
    expect(deriveAskKey({ context_field: null, context_circuit: null })).toBe('_:_');
  });

  test('undefined / missing keys also collapse to sentinel', () => {
    // undefined === null in sentinel semantics — the debounce gate's
    // Map<key,...> treats them identically once the key is normalised.
    expect(deriveAskKey({})).toBe('_:_');
  });

  // readback-correction-optionb §6 — board scope in the ask key.
  describe('context_board_id board scope (readback-correction-optionb §6)', () => {
    test('null / missing / empty board_id leaves the key byte-identical (back-compat)', () => {
      expect(deriveAskKey({ context_field: 'ze', context_circuit: 0 })).toBe('ze:0');
      expect(
        deriveAskKey({ context_field: 'ze', context_circuit: 0, context_board_id: null })
      ).toBe('ze:0');
      expect(deriveAskKey({ context_field: 'ze', context_circuit: 0, context_board_id: '' })).toBe(
        'ze:0'
      );
    });

    test('a non-null board_id appends a @<board> segment', () => {
      expect(
        deriveAskKey({
          context_field: 'measured_zs_ohm',
          context_circuit: 3,
          context_board_id: 'sub-1',
        })
      ).toBe('measured_zs_ohm:3@sub-1');
    });

    test('same field+circuit on DIFFERENT boards derive SEPARATE keys', () => {
      const main = deriveAskKey({ context_field: 'measured_zs_ohm', context_circuit: 3 });
      const subA = deriveAskKey({
        context_field: 'measured_zs_ohm',
        context_circuit: 3,
        context_board_id: 'A',
      });
      const subB = deriveAskKey({
        context_field: 'measured_zs_ohm',
        context_circuit: 3,
        context_board_id: 'B',
      });
      expect(new Set([main, subA, subB]).size).toBe(3);
    });

    test('same field+circuit+board derive the SAME key (still dedupes)', () => {
      expect(
        deriveAskKey({
          context_field: 'measured_zs_ohm',
          context_circuit: 3,
          context_board_id: 'A',
        })
      ).toBe(
        deriveAskKey({
          context_field: 'measured_zs_ohm',
          context_circuit: 3,
          context_board_id: 'A',
        })
      );
    });
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
    // Both expressions above must match for the same-key debounce to
    // bucket them together.
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
  //   2. Wrapper computes key 'NONE:7' and consults the (since-retired)
  //      per-key budget + gate.gateOrFire — bucket is empty, allow.
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
    // wrapper's same-key debounce catches case-alternation BEFORE the
    // inner dispatcher's validator runs.
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
    // circuit number must hit the same bucket so the same-key debounce
    // cannot be bypassed by alternating sentinel representations at the
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
    // null / 'none' / 'NONE' so the wrapper's same-key debounce
    // catches padding-alternation BEFORE the validator rejects the
    // malformed form.
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

  describe('context_circuits — plural ask bucket (session C0C21546 2026-06-04)', () => {
    test('plural [2,3] derives "wiring_type:[2-3]"', () => {
      expect(
        deriveAskKey({
          context_field: 'wiring_type',
          context_circuit: null,
          context_circuits: [2, 3],
        })
      ).toBe('wiring_type:[2-3]');
    });

    test('plural sorting is order-independent: [3,2] derives same key as [2,3]', () => {
      const a = deriveAskKey({
        context_field: 'wiring_type',
        context_circuit: null,
        context_circuits: [3, 2],
      });
      const b = deriveAskKey({
        context_field: 'wiring_type',
        context_circuit: null,
        context_circuits: [2, 3],
      });
      expect(a).toBe(b);
      expect(a).toBe('wiring_type:[2-3]');
    });

    test('distinct plural sets on the same field derive distinct keys (Bug 3 dedupe-key collision regression guard)', () => {
      const a = deriveAskKey({
        context_field: 'wiring_type',
        context_circuit: null,
        context_circuits: [2, 3],
      });
      const b = deriveAskKey({
        context_field: 'wiring_type',
        context_circuit: null,
        context_circuits: [4, 5],
      });
      expect(a).not.toBe(b);
      expect(a).toBe('wiring_type:[2-3]');
      expect(b).toBe('wiring_type:[4-5]');
    });

    test('field normalisation invariant preserved with plural: padded "none" sentinel + [2,3] → "_:[2-3]"', () => {
      expect(
        deriveAskKey({
          context_field: ' none ',
          context_circuit: null,
          context_circuits: [2, 3],
        })
      ).toBe('_:[2-3]');
    });

    test('field normalisation invariant preserved with plural: upper-case "NONE" + [2,3] → "_:[2-3]"', () => {
      expect(
        deriveAskKey({
          context_field: 'NONE',
          context_circuit: null,
          context_circuits: [2, 3],
        })
      ).toBe('_:[2-3]');
    });

    test('single-circuit context_circuit:0 still derives as "field:0" (board-level sentinel intact)', () => {
      // The plural branch only fires for arrays length >= 2; a single
      // contextCircuit of 0 (board-level sentinel per the wrapper's own
      // comment block at line 123-130) is unchanged.
      expect(deriveAskKey({ context_field: 'ze', context_circuit: 0 })).toBe('ze:0');
    });
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
  test('active AFDD flow + generic severity ask → inner NEVER called; filledSlotsShadow STILL called; reason="afdd_flow_violation"; one log row', async () => {
    const logger = makeLogger();
    const inner = makeInnerDispatcher();
    const { broker, chainId } = makeActiveAfddBroker();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });
    const filledSlotsShadow = jest.fn();

    const wrapped = wrapAskDispatcherWithGates(inner, {
      gate,
      filledSlotsShadow,
      logger,
      sessionId: 'sess-1',
      obsClarifyChains: broker,
    });

    const call = makeSeverityCall('call-1');
    const ctx = makeCtx();
    const result = await wrapped(call, ctx);

    expect(filledSlotsShadow).toHaveBeenCalledTimes(1);
    expect(filledSlotsShadow).toHaveBeenCalledWith(call, ctx);
    expect(inner).not.toHaveBeenCalled();
    expect(JSON.parse(result.content)).toEqual({ answered: false, reason: 'afdd_flow_violation' });
    expect(result.tool_use_id).toBe('call-1');
    expect(result.is_error).toBe(false);
    // Short-circuits BEFORE the debounce gate: no timer was started.
    expect(jest.getTimerCount()).toBe(0);

    const askUserCalls = logger.info.mock.calls.filter((c) => c[0] === 'stage6.ask_user');
    expect(askUserCalls).toHaveLength(1);
    expect(askUserCalls[0][1].answer_outcome).toBe('afdd_flow_violation');
    expect(askUserCalls[0][1].tool_call_id).toBe('call-1');

    // The rejected ask does not advance or retire the active flow.
    expect(broker.getActiveAfddFlow()).toEqual({ chainId, kinds: ['topic'] });

    gate.destroy();
  });

  test('undeclared reserved AFDD wording → inner NEVER called; filledSlotsShadow STILL called; reason="validation_error"', async () => {
    const logger = makeLogger();
    const inner = makeInnerDispatcher();
    const broker = createObsClarifyChainBroker();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });
    const filledSlotsShadow = jest.fn();

    const wrapped = wrapAskDispatcherWithGates(inner, {
      gate,
      filledSlotsShadow,
      logger,
      sessionId: 'sess-1',
      obsClarifyChains: broker,
    });

    const call = makeUndeclaredReservedAfddCall('call-1');
    const result = await wrapped(call, makeCtx());

    expect(filledSlotsShadow).toHaveBeenCalledTimes(1);
    expect(inner).not.toHaveBeenCalled();
    expect(JSON.parse(result.content)).toEqual({
      answered: false,
      reason: 'validation_error',
    });
    expect(jest.getTimerCount()).toBe(0);
    // Copied canonical wording cannot start an AFDD flow.
    expect(broker.getActiveAfddFlow()).toBeNull();

    gate.destroy();
  });

  test('no short-circuit → gate debounces; replaced ask resolves reason="gated"; replacement fires inner', async () => {
    const logger = makeLogger();
    const inner = makeInnerDispatcher();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });
    const filledSlotsShadow = jest.fn();

    const wrapped = wrapAskDispatcherWithGates(inner, {
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
    expect(inner).not.toHaveBeenCalled();

    jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);
    const r2 = await p2;
    expect(JSON.parse(r2.content).answered).toBe(true);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledWith(call2, ctx);

    // filledSlotsShadow ran on EACH attempted ask — twice.
    expect(filledSlotsShadow).toHaveBeenCalledTimes(2);

    gate.destroy();
  });

  test('filledSlotsShadow is invoked on EVERY attempted ask (regardless of subsequent short-circuit)', async () => {
    const logger = makeLogger();
    const inner = makeInnerDispatcher();
    const filledSlotsShadow = jest.fn();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });

    // First attempt — active AFDD flow, generic severity ask short-circuits.
    const { broker } = makeActiveAfddBroker();
    const wrappedActive = wrapAskDispatcherWithGates(inner, {
      gate,
      filledSlotsShadow,
      logger,
      sessionId: 'sess-1',
      obsClarifyChains: broker,
    });
    await wrappedActive(makeSeverityCall('call-1'), makeCtx());
    expect(filledSlotsShadow).toHaveBeenCalledTimes(1);

    // Second attempt — undeclared reserved AFDD wording short-circuits.
    const wrappedFresh = wrapAskDispatcherWithGates(inner, {
      gate,
      filledSlotsShadow,
      logger,
      sessionId: 'sess-1',
      obsClarifyChains: createObsClarifyChainBroker(),
    });
    await wrappedFresh(makeUndeclaredReservedAfddCall('call-2'), makeCtx());
    expect(filledSlotsShadow).toHaveBeenCalledTimes(2);
    expect(inner).not.toHaveBeenCalled();

    gate.destroy();
  });
});

// =============================================================================
// Group 3b: PLAN-B — no ask budget, unconditional composition
// =============================================================================
// PLAN-B (feedback-2026-09-17, Decision 3) removed the per-key ask budget and
// restrained mode. A repeated ask on the same key is the model's decision;
// only the debounce and the AFDD guard remain.
// =============================================================================
describe('PLAN-B — no ask budget; the wrapper composes unconditionally', () => {
  test('third and fourth same-key asks (no AFDD flow) each dispatch the inner dispatcher', async () => {
    const logger = makeLogger();
    const inner = makeInnerDispatcher();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });
    const wrapped = wrapAskDispatcherWithGates(inner, {
      gate,
      filledSlotsShadow: () => {},
      logger,
      sessionId: 'sess-1',
      obsClarifyChains: createObsClarifyChainBroker(),
    });

    const results = [];
    for (let i = 1; i <= 4; i += 1) {
      const p = wrapped(makeCall(`call-${i}`, 'ze', 0), makeCtx(`sess-1-turn-${i}`));
      jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);
      results.push(await p);
    }

    expect(inner).toHaveBeenCalledTimes(4);
    for (const [i, r] of results.entries()) {
      expect(r.tool_use_id).toBe(`call-${i + 1}`);
      expect(JSON.parse(r.content)).toEqual({ answered: true, user_text: 'ok' });
    }
    const outcomes = logger.info.mock.calls
      .filter((c) => c[0] === 'stage6.ask_user')
      .map((c) => c[1].answer_outcome);
    expect(outcomes).toEqual([]); // no wrapper short-circuit row for any of the four
  });

  test('third and fourth asks on the SAME observation_clarify chain (no AFDD flow) each dispatch', async () => {
    const logger = makeLogger();
    const inner = makeInnerDispatcher();
    const broker = createObsClarifyChainBroker();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });
    const wrapped = wrapAskDispatcherWithGates(inner, {
      gate,
      filledSlotsShadow: () => {},
      logger,
      sessionId: 'sess-1',
      obsClarifyChains: broker,
    });

    let chainId = null;
    for (let i = 1; i <= 4; i += 1) {
      const call = makeSeverityCall(`call-${i}`);
      if (chainId) call.input.clarification_chain_id = chainId;
      const p = wrapped(call, makeCtx());
      jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);
      const r = await p;
      expect(JSON.parse(r.content).answered).toBe(true);
      chainId ??= call.input.clarification_chain_id;
      expect(call.input.clarification_chain_id).toBe(chainId);
    }
    expect(inner).toHaveBeenCalledTimes(4);
  });

  test('composes with only gate + logger + sessionId (no budget, restrained-mode, shadow or chain options); debounce still applies', async () => {
    const logger = makeLogger();
    const inner = makeInnerDispatcher();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });
    const wrapped = wrapAskDispatcherWithGates(inner, { gate, logger, sessionId: 'sess-1' });

    const ctx = makeCtx();
    const p1 = wrapped(makeCall('call-1', 'ze', 0), ctx);
    jest.advanceTimersByTime(400);
    const p2 = wrapped(makeCall('call-2', 'ze', 0), ctx);

    const r1 = await p1;
    expect(JSON.parse(r1.content)).toEqual({ answered: false, reason: 'gated' });

    jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);
    const r2 = await p2;
    expect(r2.tool_use_id).toBe('call-2');
    expect(JSON.parse(r2.content)).toEqual({ answered: true, user_text: 'ok' });
    expect(inner).toHaveBeenCalledTimes(1);

    // An observation_clarify ask with no broker threaded dispatches untouched.
    const p3 = wrapped(makeSeverityCall('call-3'), ctx);
    jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);
    const r3 = await p3;
    expect(JSON.parse(r3.content).answered).toBe(true);
    expect(inner).toHaveBeenCalledTimes(2);

    gate.destroy();
  });

  test('afdd_flow_violation → synth envelope, inner never called, shadow still called, exactly one stage6.ask_user row', async () => {
    const logger = makeLogger();
    const inner = makeInnerDispatcher();
    const { broker, chainId } = makeActiveAfddBroker();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });
    const filledSlotsShadow = jest.fn();
    const wrapped = wrapAskDispatcherWithGates(inner, {
      gate,
      filledSlotsShadow,
      logger,
      sessionId: 'sess-1',
      obsClarifyChains: broker,
    });

    // Out of order: after topic, the flow accepts applicability or premises,
    // never a second topic question.
    const call = makeAfddCall('call-1', 'afdd_topic');
    const result = await wrapped(call, makeCtx());

    expect(result).toEqual({
      tool_use_id: 'call-1',
      content: JSON.stringify({ answered: false, reason: 'afdd_flow_violation' }),
      is_error: false,
    });
    expect(inner).not.toHaveBeenCalled();
    expect(filledSlotsShadow).toHaveBeenCalledTimes(1);
    expect(filledSlotsShadow).toHaveBeenCalledWith(call, expect.any(Object));

    const askUserCalls = logger.info.mock.calls.filter((c) => c[0] === 'stage6.ask_user');
    expect(askUserCalls).toHaveLength(1);
    expect(askUserCalls[0][1]).toMatchObject({
      answer_outcome: 'afdd_flow_violation',
      wait_duration_ms: 0,
      tool_call_id: 'call-1',
      context_field: 'observation_clarify',
    });
    // The server owns the active chain: the rejected ask is stamped onto it.
    expect(call.input.clarification_chain_id).toBe(chainId);
    expect(broker.getActiveAfddFlow()).toEqual({ chainId, kinds: ['topic'] });

    gate.destroy();
  });

  test('canonical AFDD sequence topic → applicability → premises dispatches all three; a fourth generic ask is afdd_flow_violation', async () => {
    const logger = makeLogger();
    const inner = makeInnerDispatcher();
    const broker = createObsClarifyChainBroker();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });
    const wrapped = wrapAskDispatcherWithGates(inner, {
      gate,
      filledSlotsShadow: () => {},
      logger,
      sessionId: 'sess-1',
      obsClarifyChains: broker,
    });

    let chainId = null;
    for (const kind of ['afdd_topic', 'afdd_applicability', 'afdd_premises']) {
      const call = makeAfddCall(`call-${kind}`, kind);
      const p = wrapped(call, makeCtx());
      jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);
      expect(JSON.parse((await p).content).answered).toBe(true);
      chainId ??= call.input.clarification_chain_id;
      expect(call.input.clarification_chain_id).toBe(chainId);
    }
    expect(inner).toHaveBeenCalledTimes(3);
    expect(broker.getActiveAfddFlow()).toEqual({
      chainId,
      kinds: ['topic', 'applicability', 'premises'],
    });

    const severity = await wrapped(makeSeverityCall('call-severity'), makeCtx());
    expect(JSON.parse(severity.content)).toEqual({
      answered: false,
      reason: 'afdd_flow_violation',
    });
    expect(inner).toHaveBeenCalledTimes(3);

    gate.destroy();
  });

  test('AFDD chain progress is recorded only on an ANSWERED fire', async () => {
    const logger = makeLogger();
    const broker = createObsClarifyChainBroker();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });

    // A topic ask that times out does not start the flow…
    const timedOut = wrapAskDispatcherWithGates(
      makeInnerDispatcher({ answered: false, reason: 'timeout' }),
      { gate, logger, sessionId: 'sess-1', obsClarifyChains: broker }
    );
    const p1 = timedOut(makeAfddCall('call-1', 'afdd_topic'), makeCtx());
    jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);
    await p1;
    expect(broker.getActiveAfddFlow()).toBeNull();

    // …an answered one does.
    const answered = wrapAskDispatcherWithGates(makeInnerDispatcher(), {
      gate,
      logger,
      sessionId: 'sess-1',
      obsClarifyChains: broker,
    });
    const call2 = makeAfddCall('call-2', 'afdd_topic');
    const p2 = answered(call2, makeCtx());
    jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);
    await p2;
    expect(broker.getActiveAfddFlow()).toEqual({
      chainId: call2.input.clarification_chain_id,
      kinds: ['topic'],
    });

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
      gate,
      filledSlotsShadow: () => {},
      logger,
      sessionId: 'sess-1',
      obsClarifyChains: makeActiveAfddBroker().broker,
    });

    const call = makeSeverityCall('call-1');
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
      gate,
      filledSlotsShadow: () => {},
      logger,
      sessionId: 'sess-1',
      obsClarifyChains: makeActiveAfddBroker().broker,
    });

    await wrapped(makeSeverityCall('call-1'), makeCtx());

    // logAskUser uses logger.info with first arg 'stage6.ask_user' — find it.
    const askUserCalls = logger.info.mock.calls.filter((c) => c[0] === 'stage6.ask_user');
    expect(askUserCalls).toHaveLength(1);
    const payload = askUserCalls[0][1];
    expect(payload.answer_outcome).toBe('afdd_flow_violation');
    expect(payload.wait_duration_ms).toBe(0);
    expect(payload.mode).toBe('live');
    expect(payload.tool_call_id).toBe('call-1');
    expect(payload.sessionId).toBe('sess-1');
    expect(payload.turnId).toBe('sess-1-turn-1');

    gate.destroy();
  });
});

// =============================================================================
// Group 6: Plan 05-07 r1-#3 — mode is threaded through wrapper short-circuits
// =============================================================================
// The wrapper emits one stage6.ask_user log row per short-circuited ask (with
// answer_outcome set to the short-circuit reason). Plan 05-05 r19 closed the
// mode-typo gate with a closed enum {shadow, live}. r1-#3 surfaced that the
// wrapper had hard-coded mode='live' at synthResultWrapped, so when
// runShadowHarness composes the wrapper inside the shadow path the rows
// mis-tagged shadow asks as live — Phase 8 dashboards split by mode.
//
// Fix threads `mode` through both createAskGateWrapper opts (covers gated +
// session_terminated + dispatcher_error paths) and wrapAskDispatcherWithGates
// opts (covers the pre-dispatch afdd_flow_violation + validation_error
// paths). Default 'live'.
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

  test("wrapAskDispatcherWithGates({mode:'shadow'}) + afdd_flow_violation → row carries mode:'shadow'", async () => {
    const logger = makeLogger();
    const inner = makeInnerDispatcher();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1', mode: 'shadow' });

    const wrapped = wrapAskDispatcherWithGates(inner, {
      gate,
      filledSlotsShadow: () => {},
      logger,
      sessionId: 'sess-1',
      mode: 'shadow',
      obsClarifyChains: makeActiveAfddBroker().broker,
    });

    await wrapped(makeSeverityCall('call-1'), makeCtx());

    const askUserCalls = logger.info.mock.calls.filter((c) => c[0] === 'stage6.ask_user');
    expect(askUserCalls).toHaveLength(1);
    expect(askUserCalls[0][1].answer_outcome).toBe('afdd_flow_violation');
    expect(askUserCalls[0][1].mode).toBe('shadow');

    gate.destroy();
  });

  test("wrapAskDispatcherWithGates({mode:'shadow'}) + undeclared reserved AFDD wording → validation_error row carries mode:'shadow'", async () => {
    const logger = makeLogger();
    const inner = makeInnerDispatcher();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1', mode: 'shadow' });

    const wrapped = wrapAskDispatcherWithGates(inner, {
      gate,
      filledSlotsShadow: () => {},
      logger,
      sessionId: 'sess-1',
      mode: 'shadow',
      obsClarifyChains: createObsClarifyChainBroker(),
    });

    await wrapped(makeUndeclaredReservedAfddCall('call-1'), makeCtx());

    const askUserCalls = logger.info.mock.calls.filter((c) => c[0] === 'stage6.ask_user');
    expect(askUserCalls).toHaveLength(1);
    expect(askUserCalls[0][1].answer_outcome).toBe('validation_error');
    expect(askUserCalls[0][1].mode).toBe('shadow');

    gate.destroy();
  });

  test("gated short-circuit (same-key replacement) carries mode:'shadow' when wrapper composed in shadow", async () => {
    const logger = makeLogger();
    const inner = makeInnerDispatcher();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1', mode: 'shadow' });

    const wrapped = wrapAskDispatcherWithGates(inner, {
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
    // No `mode` opt on either createAskGateWrapper or wrapAskDispatcherWithGates.
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });

    const wrapped = wrapAskDispatcherWithGates(inner, {
      gate,
      filledSlotsShadow: () => {},
      logger,
      sessionId: 'sess-1',
      obsClarifyChains: makeActiveAfddBroker().broker,
    });

    await wrapped(makeSeverityCall('call-1'), makeCtx());

    const askUserCalls = logger.info.mock.calls.filter((c) => c[0] === 'stage6.ask_user');
    expect(askUserCalls).toHaveLength(1);
    expect(askUserCalls[0][1].answer_outcome).toBe('afdd_flow_violation');
    expect(askUserCalls[0][1].mode).toBe('live'); // default — every existing test relies on this

    gate.destroy();
  });
});

// =============================================================================
// Group 7: Plan 05-08 r2-#1 + r3-#1 — pre-emit non-fire envelopes
// =============================================================================
// The inner dispatcher emits five reasons whose envelopes signal "the ask
// never reached the client / never registered with pendingAsks":
// validation_error, duplicate_tool_call_id, prompt_leak_blocked, shadow_mode
// (structurally pre-emit — r3-#1) and dispatcher_error. The wrapper passes
// them through verbatim (the inner dispatcher already emitted its STO-02 row)
// and must not treat them as a fire. Since PLAN-B removed the ask budget, the
// only post-dispatch consequence of a fire is AFDD chain progress, so these
// tests drive an AFDD topic ask and assert the flow does NOT start. The
// classification itself is locked by the predicate tests in Group 9.
// =============================================================================

describe('Plan 05-08 r2-#1 — PRE_EMIT_NON_FIRE_REASONS treated as non-fires', () => {
  function makeInnerDispatcherReturning(reason, isError = false) {
    return jest.fn(async (call /* , ctx */) => ({
      tool_use_id: call.id,
      content: JSON.stringify({ answered: false, reason }),
      is_error: isError,
    }));
  }

  // Real dispatcher returns is_error:true on validation_error (only outcome
  // that does so) — the wrapper must still pass it through unchanged.
  test.each([
    ['validation_error', true],
    ['duplicate_tool_call_id', false],
    ['prompt_leak_blocked', false],
    ['shadow_mode', false],
  ])(
    '%s → envelope passes through verbatim, wrapper logs nothing, AFDD chain NOT advanced',
    async (reason, isError) => {
      const logger = makeLogger();
      const inner = makeInnerDispatcherReturning(reason, isError);
      const broker = createObsClarifyChainBroker();
      const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });

      const wrapped = wrapAskDispatcherWithGates(inner, {
        gate,
        filledSlotsShadow: () => {},
        logger,
        sessionId: 'sess-1',
        obsClarifyChains: broker,
      });

      const promise = wrapped(makeAfddCall('call-1', 'afdd_topic'), makeCtx('sess-1-turn-1'));
      jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);
      const result = await promise;

      expect(inner).toHaveBeenCalledTimes(1);
      expect(JSON.parse(result.content)).toEqual({ answered: false, reason });
      expect(result.is_error).toBe(isError);
      expect(logger.info.mock.calls.filter((c) => c[0] === 'stage6.ask_user')).toHaveLength(0);
      expect(broker.getActiveAfddFlow()).toBeNull();

      gate.destroy();
    }
  );

  test('contrast — an ANSWERED real fire on the same path DOES advance the AFDD chain', async () => {
    // Keeps the non-fire tests above honest: the same composition with an
    // answered inner envelope starts the flow, so a null flow above is caused
    // by the envelope, not by a broken harness.
    const logger = makeLogger();
    const broker = createObsClarifyChainBroker();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });
    const wrapped = wrapAskDispatcherWithGates(makeInnerDispatcher(), {
      gate,
      filledSlotsShadow: () => {},
      logger,
      sessionId: 'sess-1',
      obsClarifyChains: broker,
    });

    const call = makeAfddCall('call-1', 'afdd_topic');
    const promise = wrapped(call, makeCtx('sess-1-turn-1'));
    jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);
    await promise;

    expect(broker.getActiveAfddFlow()).toEqual({
      chainId: call.input.clarification_chain_id,
      kinds: ['topic'],
    });

    gate.destroy();
  });
});

// =============================================================================
// Group 8: Plan 05-08 r2-#2 + r5-#1 — sentinel alternation cannot bypass the
// same-key debounce
// =============================================================================
// End-to-end lock: calls whose context_field alternates between sentinel
// forms (null / 'none' / 'NONE' / padded variants) for the same
// context_circuit must all derive the same '_:N' key, so the wrapper's
// same-key debounce collapses them. Until PLAN-B this was also asserted
// through the per-key budget; the debounce is the gate that remains.
// =============================================================================

describe('Plan 05-08 r2-#2 — null/"none" alternation cannot bypass the same-key debounce', () => {
  async function runAlternation(variants) {
    const logger = makeLogger();
    const inner = makeInnerDispatcher();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });
    const wrapped = wrapAskDispatcherWithGates(inner, {
      gate,
      filledSlotsShadow: () => {},
      logger,
      sessionId: 'sess-1',
    });

    // Every call lands inside the previous call's debounce window, so each
    // same-key arrival replaces the pending one.
    const ctx = makeCtx();
    const promises = [];
    for (let i = 0; i < variants.length; i += 1) {
      promises.push(wrapped(makeCall(`call-${i + 1}`, variants[i], 7), ctx));
      jest.advanceTimersByTime(100);
    }
    jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);
    const results = await Promise.all(promises);
    gate.destroy();
    return { inner, results };
  }

  test('4-call case alternation with same circuit hits the same key; first 3 gated, last fires', async () => {
    // Plan 05-10 r4-#1 — deriveAskKey runs at the WRAPPER layer BEFORE the
    // inner dispatcher's validateAskUser, so case-sensitive matching would
    // let [null, 'none', 'NONE', null] derive distinct keys and slip past the
    // same-key debounce. Case-insensitive sentinel matching collapses them.
    const { inner, results } = await runAlternation([null, 'none', 'NONE', null]);

    for (const r of results.slice(0, 3)) {
      expect(JSON.parse(r.content)).toEqual({ answered: false, reason: 'gated' });
    }
    expect(JSON.parse(results[3].content).answered).toBe(true);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(inner.mock.calls[0][0].id).toBe('call-4');
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

  test('Plan 05-11 r5-#1 — 4-call padded-sentinel alternation hits the same key; first 3 gated, last fires', async () => {
    // Pre-r5-#1 each padded form derived its own distinct key (' none :7',
    // '\tNONE\n:7', etc.), so the debounce never collapsed any of them.
    const { inner, results } = await runAlternation([null, ' none ', '\tNONE\n', ' None']);

    for (const r of results.slice(0, 3)) {
      expect(JSON.parse(r.content)).toEqual({ answered: false, reason: 'gated' });
    }
    expect(JSON.parse(results[3].content).answered).toBe(true);
    expect(inner).toHaveBeenCalledTimes(1);
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
    // Wrapper-emitted synth handled in a wrapAskDispatcherWithGates
    // pre-dispatch branch, not in isRealFire's classifier path:
    expect(isWrapperShortCircuitReason('afdd_flow_violation')).toBe(false);
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

  test('isPreEmitNonFireReason returns true for every legacy member (incl. r3-#1 shadow_mode + r6 dispatcher_error — Plan 05-14 r8-#2 reverted r7 lifecycle split)', () => {
    // Plan 05-08 r2-#1 + Plan 05-09 r3-#1 + Plan 05-12 r6 + Plan 05-14
    // r8-#2 — five pre-emit reasons (r7's lifecycle-keyed split was
    // REVERTED at r8-#2 to preserve the closed-enum wire schema;
    // lifecycle position is now carried as a SEPARATE log-row metadata
    // field, not split across two enum values):
    expect(isPreEmitNonFireReason('validation_error')).toBe(true);
    expect(isPreEmitNonFireReason('duplicate_tool_call_id')).toBe(true);
    expect(isPreEmitNonFireReason('prompt_leak_blocked')).toBe(true);
    expect(isPreEmitNonFireReason('shadow_mode')).toBe(true);
    // Plan 05-12 r6 / Plan 05-14 r8-#2 — `dispatcher_error` is the
    // single canonical wire-schema name post-r8-#2 (revert of r7's
    // `_pre_emit` rename). The active emit site at
    // `stage6-dispatcher-ask.js:361` produces `'dispatcher_error'`
    // verbatim and adds an out-of-band `lifecycle: 'pre_emit'` field
    // at the log-row level. The schema audit preserved in the wrapper
    // JSDoc (above _WRAPPER_SHORT_CIRCUIT_REASONS) confirms every
    // current emit site is structurally pre-emit, so the classifier
    // treats `dispatcher_error` as a member of this set → non-fire.
    expect(isPreEmitNonFireReason('dispatcher_error')).toBe(true);
  });

  test('isPreEmitNonFireReason returns false for non-members (Plan 05-14 r8-#2 — wire-schema preserved)', () => {
    expect(isPreEmitNonFireReason('answered')).toBe(false);
    expect(isPreEmitNonFireReason('user_moved_on')).toBe(false);
    expect(isPreEmitNonFireReason('timeout')).toBe(false);
    expect(isPreEmitNonFireReason('gated')).toBe(false);
    expect(isPreEmitNonFireReason('afdd_flow_violation')).toBe(false);
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
    //
    // Plan 05-14 r8-#2 — `dispatcher_error_pre_emit` and
    // `dispatcher_error_post_emit` no longer exist in the closed
    // enum (the r7 split was reverted). The classifier returns
    // false for them because they are not members of either
    // pre-emit set — same fall-through that any unknown reason
    // takes. We assert this explicitly so a regression that
    // reintroduces the r7 names without updating the classifier
    // (or vice versa) trips the lock.
    expect(isPreEmitNonFireReason('dispatcher_error_pre_emit')).toBe(false);
    expect(isPreEmitNonFireReason('dispatcher_error_post_emit')).toBe(false);
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

  test('regression lock — afdd_flow_violation is outside both predicates yet short-circuits BEFORE the gate', async () => {
    // afdd_flow_violation is wrapper-emitted but lives in a pre-dispatch
    // branch, not in isRealFire's classifier. Lock that via behaviour: the
    // ask never starts a debounce timer, never reaches the inner dispatcher,
    // and never advances the active AFDD flow.
    const logger = makeLogger();
    const inner = makeInnerDispatcher();
    const { broker, chainId } = makeActiveAfddBroker();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });

    const wrapped = wrapAskDispatcherWithGates(inner, {
      gate,
      filledSlotsShadow: () => {},
      logger,
      sessionId: 'sess-1',
      obsClarifyChains: broker,
    });

    const result = await wrapped(makeSeverityCall('call-1'), makeCtx());
    expect(JSON.parse(result.content).reason).toBe('afdd_flow_violation');
    expect(jest.getTimerCount()).toBe(0);
    expect(inner).not.toHaveBeenCalled();
    expect(broker.getActiveAfddFlow()).toEqual({ chainId, kinds: ['topic'] });

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
// Tests (since PLAN-B retired the ask budget, the only post-dispatch
// consequence of a fire is AFDD chain progress, so the envelope tests drive
// an AFDD topic ask and assert the flow does not start):
//   - End-to-end: inner dispatcher throws → wrapper's timer catch
//     fires → resolves with `dispatcher_error` envelope → non-fire
//     (Plan 05-14 r8-#2 classification).
//   - Synthesised gate_dispatcher_error envelope (mock inner
//     returns the reason directly) → non-fire (wrapper-internal
//     reservation).
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

  test('inner dispatcher throws → wrapper resolves dispatcher_error → AFDD chain NOT advanced (Plan 05-14 r8-#2 reverted r7 lifecycle split — wire-schema preserved)', async () => {
    // The wrapper's timer block catches inner throws and resolves the
    // outer Promise with synthResultWithoutLog(call, 'dispatcher_error')
    // (Plan 05-14 r8-#1 + r8-#2 — was synthResultWrapped(...)
    // with `'dispatcher_error_pre_emit'` post-r7; r8-#1 routed the
    // catch through the non-logging helper to close the double-log
    // bug, then r8-#2 reverted the wire-schema name back to
    // `'dispatcher_error'` so downstream analyzer queries on the
    // closed-enum wire-schema name keep working).
    //
    // r1 → r5 → r6 → r7 → r8 lineage:
    //   - Pre-r5-#2 (Plan 05-07 r1-#1): dispatcher_error was in
    //     _WRAPPER_SHORT_CIRCUIT_REASONS — non-fire.
    //   - r5-#2 (Plan 05-11): removed from wrapper short-circuit set,
    //     classified as fire (conservative defence against a
    //     theoretical CASE B post-emit refactor that could add
    //     synchronous code AFTER ws.send and reach the same outer
    //     catch).
    //   - r6 (Plan 05-12): REVERTED. Codex r6 surfaced that current
    //     source has no CASE B path: register() rethrow at line 297
    //     is BEFORE ws.send line 305; ws.send failures are caught +
    //     swallowed in an inner try/catch that never reaches the
    //     outer catch; no synchronous post-send work exists. r5's
    //     classification was forward-looking, not current-state-
    //     correct. r6 placed dispatcher_error in
    //     _PRE_EMIT_NON_FIRE_REASONS.
    //   - r7 (Plan 05-13): split the outcome name into lifecycle-keyed
    //     values that encode position structurally. Every CURRENT
    //     emit site renamed to `dispatcher_error_pre_emit`. The
    //     `_post_emit` sibling was RESERVED for future post-emit
    //     code paths.
    //   - r8 (Plan 05-14 — THIS test's classification): REVERTED r7's
    //     wire-schema rename. The closed-enum split was a breaking
    //     wire-schema change — downstream consumers (CloudWatch
    //     Insights queries) filtering on `answer_outcome =
    //     'dispatcher_error'` post-r7 silently match nothing. r8-#2
    //     restores the canonical wire-schema name and layers
    //     lifecycle position as a SEPARATE optional log-row metadata
    //     field. The classifier returns to the r6 shape: legacy name
    //     `'dispatcher_error'` is back in
    //     `_PRE_EMIT_NON_FIRE_REASONS` → non-fire. The wrapper's
    //     timer-catch path also routes through the new
    //     `synthResultWithoutLog` helper (r8-#1) so the dispatcher's
    //     outer catch is the sole emitter of the `stage6.ask_user`
    //     row for the inner-throw path.
    const logger = makeLogger();
    const inner = makeThrowingInner();
    const broker = createObsClarifyChainBroker();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });

    const wrapped = wrapAskDispatcherWithGates(inner, {
      gate,
      filledSlotsShadow: () => {},
      logger,
      sessionId: 'sess-1',
      obsClarifyChains: broker,
    });

    const promise = wrapped(makeAfddCall('call-1', 'afdd_topic'), makeCtx('sess-1-turn-1'));
    jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);
    const result = await promise;

    expect(JSON.parse(result.content).reason).toBe('dispatcher_error');
    // Plan 05-14 r8-#2 classification: `dispatcher_error` is back in
    // `_PRE_EMIT_NON_FIRE_REASONS` (r6 placement preserved post-r8).
    // The ask never reached the client, so the AFDD flow does not start.
    expect(broker.getActiveAfddFlow()).toBeNull();

    gate.destroy();
  });

  test('Plan 05-14 r8-#1: inner dispatcher throws → exactly ONE stage6.ask_user log row from the dispatcher (wrapper timer-catch must NOT log a duplicate)', async () => {
    // Plan 05-14 r8-#1 closure lock. Pre-r8-#1 the wrapper's timer-
    // catch resolved with `synthResultWrapped(...)` which calls
    // `logAskUser(...)` as part of every wrapper synth. But the inner
    // dispatcher's outer catch (stage6-dispatcher-ask.js line 352-364)
    // already called `logAskUser(...)` with answer_outcome=
    // 'dispatcher_error_pre_emit' BEFORE rethrowing. Result: TWO
    // stage6.ask_user rows per failed ask, both carrying the same
    // tool_call_id and answer_outcome but different wait_duration_ms
    // (real wait from the dispatcher; 0 from the wrapper synth).
    //
    // r8-#1 fix: route the wrapper's timer-catch through a non-logging
    // synthesis helper (`synthResultWithoutLog`). The wrapper still
    // produces a properly-shaped tool_result envelope so the awaiter
    // is not stranded — but it does NOT emit a duplicate log row.
    //
    // Test scope: this test uses `makeThrowingInner` which throws
    // SYNCHRONOUSLY without going through the real dispatcher's outer
    // catch. So this test asserts the WRAPPER side: the wrapper's
    // timer-catch path emits ZERO stage6.ask_user rows. The dispatcher-
    // side log row is asserted by the existing Group 8 r10 test in
    // stage6-dispatcher-ask.test.js, which uses the real dispatcher
    // and a register() that throws — it asserts exactly ONE row from
    // the dispatcher's outer catch with answer_outcome=
    // 'dispatcher_error_pre_emit'.
    //
    // Together the two tests cover the full pipeline: dispatcher emits
    // exactly 1 row; wrapper emits 0 rows; total = 1 (post-r8-#1).
    const logger = makeLogger();
    const inner = makeThrowingInner();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });

    const wrapped = wrapAskDispatcherWithGates(inner, {
      gate,
      filledSlotsShadow: () => {},
      logger,
      sessionId: 'sess-1',
    });

    const promise = wrapped(makeCall('call-1', 'ze', 0), makeCtx('sess-1-turn-1'));
    jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);
    await promise;

    const askUserRows = logger.info.mock.calls.filter((c) => c[0] === 'stage6.ask_user');
    // r8-#1 RED: pre-fix this is 1 (the wrapper's synthResultWrapped
    // logs from its catch). r8-#1 GREEN: this is 0 (the wrapper's
    // catch routes through a non-logging synth helper; the real
    // dispatcher's outer catch is the sole emitter for this path).
    expect(askUserRows).toHaveLength(0);

    gate.destroy();
  });

  test('synthesised gate_dispatcher_error envelope → passes through; AFDD chain NOT advanced (wrapper-internal non-fire)', async () => {
    // gate_dispatcher_error is RESERVED for future wrapper-internal
    // catches. At r5-#2 closure there is no emit site — to test the
    // path we synthesise a mock inner dispatcher that returns the
    // gate_dispatcher_error envelope directly. The classification
    // itself is locked by the predicate test below.
    const logger = makeLogger();
    const inner = makeInnerReturning('gate_dispatcher_error');
    const broker = createObsClarifyChainBroker();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });

    const wrapped = wrapAskDispatcherWithGates(inner, {
      gate,
      filledSlotsShadow: () => {},
      logger,
      sessionId: 'sess-1',
      obsClarifyChains: broker,
    });

    const promise = wrapped(makeAfddCall('call-1', 'afdd_topic'), makeCtx('sess-1-turn-1'));
    jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);
    const result = await promise;

    expect(JSON.parse(result.content).reason).toBe('gate_dispatcher_error');
    expect(broker.getActiveAfddFlow()).toBeNull();

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
    // the wrapper-short-circuit set (r6/r8-#2 place it in the pre-emit
    // set instead — see the next test).
    expect(isWrapperShortCircuitReason('dispatcher_error')).toBe(false);
  });

  test('predicate: isPreEmitNonFireReason("dispatcher_error") === true (Plan 05-14 r8-#2 — back in pre-emit set after r7 revert)', () => {
    // Plan 05-14 r8-#2 classification lock — REVERTS Plan 05-13 r7's
    // `dispatcher_error` → `dispatcher_error_pre_emit` rename.
    //
    // r7's wire-schema split was a BREAKING change to the closed
    // enum `ASK_USER_ANSWER_OUTCOMES`: downstream analyzer queries
    // (CloudWatch Insights, future analyze-session.js consumers)
    // filtering on `answer_outcome = 'dispatcher_error'` post-r7
    // silently matched nothing. r8-#2 restores the canonical wire-
    // schema name as the single emitted value and layers lifecycle
    // position as a SEPARATE optional log-row field — additive
    // metadata, not a closed-enum split.
    //
    // The classifier returns to the r6 shape: `'dispatcher_error'`
    // is back in `_PRE_EMIT_NON_FIRE_REASONS`. The schema audit
    // preserved in the wrapper JSDoc (above
    // `_WRAPPER_SHORT_CIRCUIT_REASONS`) still applies — every active
    // emit site reaches the outer catch via the structurally pre-
    // emit `register()` rethrow path at line 297 (BEFORE ws.send at
    // line 305; ws.send failures caught + swallowed in an inner
    // try/catch that never reaches the outer catch). The lifecycle
    // metadata field at the log-row layer carries that audit
    // conclusion as a first-class attribute without disturbing the
    // wire schema.
    expect(isPreEmitNonFireReason('dispatcher_error')).toBe(true);
  });
});

// =============================================================================
// Plan 05-15 r9-#3 — innerAlreadyLogs option for createAskGateWrapper
// =============================================================================
// Plan 05-14 r8-#1 routed the wrapper's timer-catch through the new
// `synthResultWithoutLog` helper. That's correct ONLY when the inner
// dispatcher is the production `createAskDispatcher`, which logs its
// own `dispatcher_error` row from its outer catch BEFORE rethrowing.
// The wrapper is exported as a generic higher-order-function — a future
// or custom inner dispatcher (test-only mock, alternative dispatcher in
// a Phase 6 refactor, hypothetical replay tool) that throws WITHOUT
// logging would lose its audit-trail breadcrumb under the always-non-
// logging timer-catch.
//
// r9-#3 closure (Option B): expose an `innerAlreadyLogs: boolean` option
// (default true for the production composition where createAskDispatcher
// is the only in-tree caller). Default-true preserves the r8-#1 fix:
// no double-log when the inner is the production dispatcher. Explicit-
// false delegates the audit-trail emission to the wrapper, so a custom
// inner dispatcher's throws still surface as one stage6.ask_user row.
// =============================================================================

describe('Plan 05-15 r9-#3 — innerAlreadyLogs flag for inner-throw logging', () => {
  function makeThrowingInner() {
    return jest.fn(async (/* call, ctx */) => {
      throw new Error('synthetic inner-dispatcher failure');
    });
  }

  test('createAskGateWrapper without innerAlreadyLogs option (default true): inner throws → wrapper does NOT call logAskUser', async () => {
    // Default behaviour preserves Plan 05-14 r8-#1: production
    // createAskDispatcher logs its own dispatcher_error row from the
    // outer catch before rethrowing; wrapper's timer-catch must not
    // duplicate. This regression-locks the default-true semantics.
    const logger = makeLogger();
    const inner = makeThrowingInner();
    const gate = createAskGateWrapper({ logger, sessionId: 'sess-1' });

    const wrapped = wrapAskDispatcherWithGates(inner, {
      gate,
      filledSlotsShadow: () => {},
      logger,
      sessionId: 'sess-1',
    });

    const promise = wrapped(makeCall('call-1', 'ze', 0), makeCtx('sess-1-turn-1'));
    jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);
    const result = await promise;

    const askUserRows = logger.info.mock.calls.filter((c) => c[0] === 'stage6.ask_user');
    // Default-true → wrapper does NOT log; total log rows from the
    // wrapper = 0 (the inner is a stub that doesn't log either, so
    // total = 0 here; in production the dispatcher's outer catch
    // would log exactly 1 row).
    expect(askUserRows).toHaveLength(0);
    // Envelope still synthesised so the awaiter is not stranded.
    expect(result.tool_use_id).toBe('call-1');
    expect(JSON.parse(result.content)).toEqual({
      answered: false,
      reason: 'dispatcher_error',
    });

    gate.destroy();
  });

  test('createAskGateWrapper({ innerAlreadyLogs: true }) explicit: same as default — wrapper does NOT log on inner-throw', async () => {
    // Explicit-true must be byte-identical to default-true. Future
    // refactors that change the default value would still pin this
    // path closed.
    const logger = makeLogger();
    const inner = makeThrowingInner();
    const gate = createAskGateWrapper({
      logger,
      sessionId: 'sess-1',
      innerAlreadyLogs: true,
    });

    const wrapped = wrapAskDispatcherWithGates(inner, {
      gate,
      filledSlotsShadow: () => {},
      logger,
      sessionId: 'sess-1',
    });

    const promise = wrapped(makeCall('call-1', 'ze', 0), makeCtx('sess-1-turn-1'));
    jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);
    await promise;

    const askUserRows = logger.info.mock.calls.filter((c) => c[0] === 'stage6.ask_user');
    expect(askUserRows).toHaveLength(0);

    gate.destroy();
  });

  test('createAskGateWrapper({ innerAlreadyLogs: false }): inner throws → wrapper DOES call logAskUser exactly once with dispatcher_error', async () => {
    // The defining test: when the consumer signals "my inner does NOT
    // log on throw", the wrapper takes responsibility and emits the
    // audit-trail row itself. Used by future custom inner dispatchers
    // (test-only mocks, replay tools, alternative dispatchers in a
    // Phase 6 refactor) that don't have the production createAskDispatcher's
    // outer catch + logAskUser call.
    const logger = makeLogger();
    const inner = makeThrowingInner();
    const gate = createAskGateWrapper({
      logger,
      sessionId: 'sess-1',
      innerAlreadyLogs: false,
    });

    const wrapped = wrapAskDispatcherWithGates(inner, {
      gate,
      filledSlotsShadow: () => {},
      logger,
      sessionId: 'sess-1',
    });

    const promise = wrapped(makeCall('call-1', 'ze', 0), makeCtx('sess-1-turn-1'));
    jest.advanceTimersByTime(QUESTION_GATE_DELAY_MS);
    const result = await promise;

    const askUserRows = logger.info.mock.calls.filter((c) => c[0] === 'stage6.ask_user');
    // Exactly ONE row from the wrapper itself (the inner doesn't log;
    // the wrapper takes over).
    expect(askUserRows).toHaveLength(1);
    const [, row] = askUserRows[0];
    expect(row.answer_outcome).toBe('dispatcher_error');
    expect(row.tool_call_id).toBe('call-1');
    // Envelope shape unchanged — only the logging side-effect differs.
    expect(result.tool_use_id).toBe('call-1');
    expect(JSON.parse(result.content)).toEqual({
      answered: false,
      reason: 'dispatcher_error',
    });

    gate.destroy();
  });
});

// ---------------------------------------------------------------------------
// F7 Item 3 — gateOrFire rejects on a fatal control-flow error.
// ---------------------------------------------------------------------------
import { ExtractionCancelledError } from '../extraction/stage6-control-flow-errors.js';

describe('F7 Item 3 — gateOrFire propagates fatal control-flow errors by REJECTING', () => {
  test('an inner dispatcher that throws ExtractionCancelledError rejects the composed gate Promise (no pending timer/entry)', async () => {
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const gate = createAskGateWrapper({ delayMs: QUESTION_GATE_DELAY_MS, logger, sessionId: 's' });
    const inner = jest.fn(async () => {
      throw new ExtractionCancelledError('ceiling');
    });
    const call = { tool_call_id: 'toolu_1', input: { context_field: 'ze', context_circuit: 1 } };
    const p = gate.gateOrFire(call, { turnId: 't1' }, inner);
    // Attach the rejection expectation BEFORE firing the timer so the
    // rejection isn't momentarily unhandled during the tick.
    const assertion = expect(p).rejects.toBeInstanceOf(ExtractionCancelledError);
    await jest.advanceTimersByTimeAsync(QUESTION_GATE_DELAY_MS);
    await assertion;
    // No pending timer/entry left behind — destroy() is a no-op with nothing to
    // resolve (would throw if it tried to resolve a settled Promise).
    expect(() => gate.destroy()).not.toThrow();
  });

  test('an ordinary inner error still resolves as a dispatcher_error envelope (unchanged)', async () => {
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const gate = createAskGateWrapper({ delayMs: QUESTION_GATE_DELAY_MS, logger, sessionId: 's' });
    const inner = jest.fn(async () => {
      throw new Error('ordinary boom');
    });
    const call = { tool_call_id: 'toolu_2', input: { context_field: 'ze', context_circuit: 1 } };
    const p = gate.gateOrFire(call, { turnId: 't1' }, inner);
    await jest.advanceTimersByTimeAsync(QUESTION_GATE_DELAY_MS);
    const res = await p;
    expect(JSON.parse(res.content).reason).toBe('dispatcher_error');
  });
});
