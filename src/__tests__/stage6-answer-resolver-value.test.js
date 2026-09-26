/**
 * stage6-answer-resolver-value.test.js
 *
 * Unit tests for `resolveValueAnswer` — the Bug-J value-resolve helper.
 *
 * Pairs with the existing circuit-resolver tests in stage6-answer-resolver.test.js.
 * Tested here in isolation (pure module, no I/O) so the dispatcher integration
 * test can stay focused on threading + logging without re-asserting the
 * matcher's behaviour on every input shape.
 *
 * Repro pattern: session 08469BFC 2026-04-28. Sonnet asked "What is the R1
 * (live) reading for kitchen sockets?" with context_field=ring_r1_ohm,
 * context_circuit=6. User answered "0.47". Pre-fix dispatcher returned
 * `{answered:true, untrusted_user_text:"0.47"}` and the model's next turn
 * just verbally acknowledged ("Got it, zero point four seven") without
 * emitting `record_reading`. Post-fix the resolver auto-emits the write.
 */

import { resolveValueAnswer } from '../extraction/stage6-answer-resolver.js';

describe('resolveValueAnswer — happy path', () => {
  test('bare numeric answer → auto-resolved record_reading', () => {
    const verdict = resolveValueAnswer({
      userText: '0.47',
      contextField: 'ring_r1_ohm',
      contextCircuit: 6,
      sourceTurnId: 'turn-12',
    });
    expect(verdict).toEqual({
      kind: 'auto_resolve',
      writes: [
        {
          tool: 'record_reading',
          field: 'ring_r1_ohm',
          circuit: 6,
          value: '0.47',
          confidence: 0.9,
          source_turn_id: 'turn-12',
        },
      ],
    });
  });

  test('contextBoardId stamps board_id onto the resolved write (readback-correction-optionb §6)', () => {
    const verdict = resolveValueAnswer({
      userText: '0.68',
      contextField: 'measured_zs_ohm',
      contextCircuit: 3,
      sourceTurnId: 'turn-12',
      contextBoardId: 'sub-1',
    });
    expect(verdict.kind).toBe('auto_resolve');
    expect(verdict.writes[0].board_id).toBe('sub-1');
    expect(verdict.writes[0].circuit).toBe(3);
  });

  test('no contextBoardId → write omits board_id (back-compat byte shape)', () => {
    const verdict = resolveValueAnswer({
      userText: '0.68',
      contextField: 'measured_zs_ohm',
      contextCircuit: 3,
      sourceTurnId: 'turn-12',
    });
    expect(verdict.writes[0]).not.toHaveProperty('board_id');
  });

  test('"is 0.47" / "the value is 0.47" — strips surrounding words, keeps the numeric', () => {
    const verdict = resolveValueAnswer({
      userText: 'the value is 0.47',
      contextField: 'measured_zs_ohm',
      contextCircuit: 3,
      sourceTurnId: 'turn-5',
    });
    expect(verdict.kind).toBe('auto_resolve');
    expect(verdict.writes[0].value).toBe('0.47');
    expect(verdict.writes[0].field).toBe('measured_zs_ohm');
    expect(verdict.writes[0].circuit).toBe(3);
  });

  test('"0.7 no 0.47" correction pattern — escalates to the model (PLAN-W1 M2b)', () => {
    // Verbatim from session 08469BFC: user said "lives are 0.7 no. No.",
    // then "0.47". The resolver used to take the LAST numeric; "0.47, not
    // 0.7" then wrote 0.7. Decision 7: two numerics are not a sole value, so
    // the model reads the reply and writes or asks.
    const verdict = resolveValueAnswer({
      userText: '0.7 no 0.47',
      contextField: 'ring_r1_ohm',
      contextCircuit: 6,
      sourceTurnId: 'turn-12',
    });
    expect(verdict).toEqual({ kind: 'escalate', parsed_hint: 'multiple_numerics:0.7,0.47' });
  });

  test('integer answer ("32") for OCPD rating → auto-resolved', () => {
    const verdict = resolveValueAnswer({
      userText: '32',
      contextField: 'ocpd_rating_a',
      contextCircuit: 4,
      sourceTurnId: 't',
    });
    expect(verdict.kind).toBe('auto_resolve');
    expect(verdict.writes[0].value).toBe('32');
  });
});

describe('resolveValueAnswer — sentinels', () => {
  test('"discontinuous" on ring_r1_ohm → auto-emit infinity sentinel', () => {
    // Per sonnet_agentic_system.md line 58, discontinuous continuity
    // readings must be the literal "∞" character. The resolver pre-stamps
    // it so the model doesn't have to spell out the unicode in a tool call.
    const verdict = resolveValueAnswer({
      userText: 'discontinuous',
      contextField: 'ring_r1_ohm',
      contextCircuit: 2,
      sourceTurnId: 'turn-3',
    });
    expect(verdict.kind).toBe('auto_resolve');
    expect(verdict.writes[0].value).toBe('∞');
    expect(verdict.writes[0].field).toBe('ring_r1_ohm');
  });

  test('"open circuit" / "infinity" / "OL" — all map to ∞ on continuity fields', () => {
    // NOTE: "LIM"/"lim" is deliberately NOT in this list — see the dedicated
    // LIM-sentinel test below. Field report 2026-06-24 #2: "limitation" is a
    // STRING sentinel, never ∞.
    for (const phrase of ['open circuit', 'infinity', 'OL']) {
      const verdict = resolveValueAnswer({
        userText: phrase,
        contextField: 'r1_r2_ohm',
        contextCircuit: 1,
        sourceTurnId: 't',
      });
      expect(verdict.kind).toBe('auto_resolve');
      expect(verdict.writes[0].value).toBe('∞');
    }
  });

  // Field report 2026-06-24 #2 — "Limb." (Deepgram garble of "LIM") was
  // substring-matched by 'lim' in DISCONTINUOUS_PHRASES and silently wrote
  // ring_r1_ohm = ∞ (corruption, deduped on TTS). LIM is a STRING sentinel
  // consistent with record-reading-coercion.js / value-normalise.js.
  test('"limb" / "lim" / "limp" / "limitation" on a continuity field → write the string "LIM", never ∞', () => {
    // P3 (2026-07-23): the four canonical forms only. "limited" is a near-match
    // that must NOT coerce (asserted separately below).
    for (const phrase of ['limb', 'lim', 'Limb.', 'limp', 'limitation']) {
      const verdict = resolveValueAnswer({
        userText: phrase,
        contextField: 'ring_r1_ohm',
        contextCircuit: 2,
        sourceTurnId: 't',
      });
      expect(verdict.kind).toBe('auto_resolve');
      expect(verdict.writes[0].value).toBe('LIM');
      expect(verdict.writes[0].value).not.toBe('∞');
      expect(verdict.writes[0].field).toBe('ring_r1_ohm');
    }
  });

  test('near-matches "limited"/"limit"/"lynn"/"lym" on a continuity field do NOT write LIM (P3)', () => {
    for (const phrase of ['limited', 'limit', 'lynn', 'lym']) {
      const verdict = resolveValueAnswer({
        userText: phrase,
        contextField: 'ring_r1_ohm',
        contextCircuit: 2,
        sourceTurnId: 't',
      });
      // Not a LIM auto-resolve; the resolver escalates (or otherwise does not
      // write "LIM").
      if (verdict.kind === 'auto_resolve') {
        expect(verdict.writes[0].value).not.toBe('LIM');
      } else {
        expect(verdict.kind).toBe('escalate');
      }
    }
  });

  // P3 (2026-07-23) — LIM is a valid reading for EVERY numeric reading field,
  // not just the continuity ones. A LIM reply for measured_zs_ohm now WRITES
  // "LIM" (previously it escalated to terminalApology — the round-9 fix).
  test('"limitation" on a non-continuity NUMERIC reading field (measured_zs_ohm) → write "LIM"', () => {
    const verdict = resolveValueAnswer({
      userText: 'limitation',
      contextField: 'measured_zs_ohm',
      contextCircuit: 2,
      sourceTurnId: 't',
    });
    expect(verdict.kind).toBe('auto_resolve');
    expect(verdict.writes[0].value).toBe('LIM');
  });

  test('"limitation" on a truly non-reading field → escalate (lim_on_non_numeric_reading_field)', () => {
    const verdict = resolveValueAnswer({
      userText: 'limitation',
      contextField: 'ocpd_type',
      contextCircuit: 2,
      sourceTurnId: 't',
    });
    expect(verdict.kind).toBe('escalate');
    expect(verdict.parsed_hint).toBe('lim_on_non_numeric_reading_field');
  });

  // Word-boundary guard: "open"/"ol" tokens must not bite mid-word.
  test('mid-word substrings ("old", "olive", "opening 12") do NOT trigger the ∞ sentinel', () => {
    for (const phrase of ['old wiring', 'olive', 'opening is 12']) {
      const verdict = resolveValueAnswer({
        userText: phrase,
        contextField: 'ring_r1_ohm',
        contextCircuit: 2,
        sourceTurnId: 't',
      });
      // Should NOT auto-resolve to ∞ via a mid-word false match.
      if (verdict.kind === 'auto_resolve') {
        expect(verdict.writes[0].value).not.toBe('∞');
      }
    }
  });

  test('"discontinuous" on a non-continuity field (e.g. measured_zs_ohm) → escalate', () => {
    // Discontinuous Zs is nonsensical — the resolver refuses to write ∞
    // and escalates to Sonnet so the model can ask a clarifying question.
    const verdict = resolveValueAnswer({
      userText: 'discontinuous',
      contextField: 'measured_zs_ohm',
      contextCircuit: 2,
      sourceTurnId: 't',
    });
    expect(verdict.kind).toBe('escalate');
    expect(verdict.parsed_hint).toBe('discontinuous_on_non_continuity_field');
  });
});

describe('resolveValueAnswer — escalation paths', () => {
  test('multiple distinct numerics with NO correction marker → escalate', () => {
    // "0.21 and 0.47" for a single-field ask is over-specification —
    // the resolver refuses to guess which one the inspector meant and
    // hands off to Sonnet with the parsed_hint.
    const verdict = resolveValueAnswer({
      userText: '0.21 and 0.47',
      contextField: 'ring_r1_ohm',
      contextCircuit: 6,
      sourceTurnId: 't',
    });
    expect(verdict.kind).toBe('escalate');
    expect(verdict.parsed_hint).toBe('multiple_numerics:0.21,0.47');
  });

  test('non-numeric, non-sentinel reply → escalate', () => {
    const verdict = resolveValueAnswer({
      userText: 'I need to check that one',
      contextField: 'ring_r1_ohm',
      contextCircuit: 6,
      sourceTurnId: 't',
    });
    expect(verdict.kind).toBe('escalate');
    expect(verdict.parsed_hint).toBe('no_numeric_in_reply');
  });

  test('empty reply → escalate', () => {
    const verdict = resolveValueAnswer({
      userText: '',
      contextField: 'ring_r1_ohm',
      contextCircuit: 6,
      sourceTurnId: 't',
    });
    expect(verdict.kind).toBe('escalate');
    expect(verdict.parsed_hint).toBe('empty_reply');
  });

  test('"skip" / "never mind" → cancel', () => {
    for (const phrase of ['skip', 'never mind', 'forget it']) {
      const verdict = resolveValueAnswer({
        userText: phrase,
        contextField: 'ring_r1_ohm',
        contextCircuit: 6,
        sourceTurnId: 't',
      });
      expect(verdict.kind).toBe('cancel');
    }
  });
});

describe('resolveValueAnswer — no-context fallthrough', () => {
  test('null contextField → no_value_context (caller falls through)', () => {
    const verdict = resolveValueAnswer({
      userText: '0.47',
      contextField: null,
      contextCircuit: 6,
      sourceTurnId: 't',
    });
    expect(verdict.kind).toBe('no_value_context');
  });

  test('contextField="none" sentinel → no_value_context', () => {
    const verdict = resolveValueAnswer({
      userText: '0.47',
      contextField: 'none',
      contextCircuit: 6,
      sourceTurnId: 't',
    });
    expect(verdict.kind).toBe('no_value_context');
  });

  test('contextField="observation_clarify" sentinel → no_value_context', () => {
    // Observation-clarify asks aren't field-value asks; let them pass
    // through to the legacy body without resolution.
    const verdict = resolveValueAnswer({
      userText: 'C2 because the lid is missing',
      contextField: 'observation_clarify',
      contextCircuit: 6,
      sourceTurnId: 't',
    });
    expect(verdict.kind).toBe('no_value_context');
  });

  test('null contextCircuit → no_value_context (the circuit-resolver should handle this)', () => {
    // When the circuit is missing, that's a circuit-resolver case
    // (with a pending_write); the value-resolver doesn't try to guess.
    const verdict = resolveValueAnswer({
      userText: '0.47',
      contextField: 'ring_r1_ohm',
      contextCircuit: null,
      sourceTurnId: 't',
    });
    expect(verdict.kind).toBe('no_value_context');
  });
});

describe('multi-circuit value resolve (session C0C21546 2026-06-04)', () => {
  test('single numeric "0.42" with contextCircuits [5,6] fans out two writes at 0.9', () => {
    const verdict = resolveValueAnswer({
      userText: '0.42',
      contextField: 'measured_zs_ohm',
      contextCircuit: null,
      contextCircuits: [5, 6],
      sourceTurnId: 'turn-x',
    });
    expect(verdict.kind).toBe('auto_resolve');
    expect(verdict.writes).toHaveLength(2);
    expect(verdict.writes.map((w) => w.circuit).sort()).toEqual([5, 6]);
    expect(verdict.writes.every((w) => w.value === '0.42')).toBe(true);
    expect(verdict.writes.every((w) => w.confidence === 0.9)).toBe(true);
  });

  test('discontinuous "infinity" on ring_r1_ohm with contextCircuits [3,4] fans out two ∞ writes at 0.9', () => {
    const verdict = resolveValueAnswer({
      userText: 'infinity',
      contextField: 'ring_r1_ohm',
      contextCircuit: null,
      contextCircuits: [3, 4],
      sourceTurnId: 'turn-x',
    });
    expect(verdict.kind).toBe('auto_resolve');
    expect(verdict.writes).toHaveLength(2);
    expect(verdict.writes.every((w) => w.value === '∞')).toBe(true);
    expect(verdict.writes.every((w) => w.confidence === 0.9)).toBe(true);
  });

  test('corrected reply "0.7 no 0.47" with contextCircuits [3,4] escalates (PLAN-W1 M2b)', () => {
    const verdict = resolveValueAnswer({
      userText: '0.7 no 0.47',
      contextField: 'measured_zs_ohm',
      contextCircuit: null,
      contextCircuits: [3, 4],
      sourceTurnId: 'turn-x',
    });
    expect(verdict).toEqual({ kind: 'escalate', parsed_hint: 'multiple_numerics:0.7,0.47' });
  });

  test('contextCircuits length-1 with no contextCircuit → no_value_context (validator normally blocks, resolver defends)', () => {
    const verdict = resolveValueAnswer({
      userText: '0.42',
      contextField: 'measured_zs_ohm',
      contextCircuit: null,
      contextCircuits: [5],
      sourceTurnId: 't',
    });
    expect(verdict.kind).toBe('no_value_context');
  });

  test('contextCircuits length-1 with contextCircuit set → falls back to single-circuit [contextCircuit]', () => {
    const verdict = resolveValueAnswer({
      userText: '0.42',
      contextField: 'measured_zs_ohm',
      contextCircuit: 7,
      contextCircuits: [5],
      sourceTurnId: 't',
    });
    expect(verdict.kind).toBe('auto_resolve');
    expect(verdict.writes).toHaveLength(1);
    expect(verdict.writes[0].circuit).toBe(7);
  });
});

describe('non-circuit context-field guard (value resolver, multi-circuit fan-out only)', () => {
  test('ze_at_db + contextCircuits:[2,3] → no_value_context', () => {
    const verdict = resolveValueAnswer({
      userText: '0.42',
      contextField: 'ze_at_db',
      contextCircuit: null,
      contextCircuits: [2, 3],
      sourceTurnId: 't',
    });
    expect(verdict.kind).toBe('no_value_context');
  });

  test('earth_loop_impedance_ze + contextCircuits:[2,3] → no_value_context', () => {
    const verdict = resolveValueAnswer({
      userText: '0.42',
      contextField: 'earth_loop_impedance_ze',
      contextCircuit: null,
      contextCircuits: [2, 3],
      sourceTurnId: 't',
    });
    expect(verdict.kind).toBe('no_value_context');
  });
});

// PLAN-W1 M2b (B-48, B-49, A-2) — a value reply writes only when the WHOLE
// reply is one value of the asked field. Every red proof below wrote on main.
describe('PLAN-W1 M2b — sole-value replies only', () => {
  const resolve = (userText, contextField = 'r1_r2_ohm') =>
    resolveValueAnswer({ userText, contextField, contextCircuit: 5, sourceTurnId: 't' });

  test.each([
    ['0.47, not 0.7', 'measured_zs_ohm', 'multiple_numerics:0.47,0.7'],
    ["It's not LIM, it's 0.4", 'measured_zs_ohm', 'reply_not_value_only'],
    ["I'll have to open it up", 'r1_r2_ohm', 'reply_not_value_only'],
    ['Give me 2 seconds', 'measured_zs_ohm', 'reply_not_value_only'],
  ])('red proof: "%s" (%s) escalates %s', (reply, field, hint) => {
    expect(resolve(reply, field)).toEqual({ kind: 'escalate', parsed_hint: hint });
  });

  test('red proof A-2: ".43" writes 0.43, not 43', () => {
    const v = resolve('.43', 'ring_r1_ohm');
    expect(v.kind).toBe('auto_resolve');
    expect(v.writes[0].value).toBe('0.43');
  });

  test('"-.5" normalises to -0.5', () => {
    expect(resolve('-.5', 'measured_zs_ohm').writes[0].value).toBe('-0.5');
  });

  test.each([
    ['25 milliseconds', 'measured_zs_ohm', 'unit_mismatch:milliseconds'],
    ['0.35 ohms', 'rcd_time_ms', 'unit_mismatch:ohms'],
  ])('red proof W1-2: "%s" for %s escalates %s', (reply, field, hint) => {
    expect(resolve(reply, field)).toEqual({ kind: 'escalate', parsed_hint: hint });
  });

  test('the old one → no_numeric_in_reply', () => {
    expect(resolve('the old one', 'measured_zs_ohm')).toEqual({
      kind: 'escalate',
      parsed_hint: 'no_numeric_in_reply',
    });
  });

  test.each([
    ['0.47', 'measured_zs_ohm', '0.47'],
    ["it's 0.47 ohms", 'measured_zs_ohm', '0.47'],
    ['25 milliseconds', 'rcd_time_ms', '25'],
    ['Zs is 0.47', 'measured_zs_ohm', '0.47'],
    ['LIM', 'measured_zs_ohm', 'LIM'],
    ['open circuit', 'r2_ohm', '∞'],
  ])('control: "%s" (%s) auto-resolves %s', (reply, field, value) => {
    const v = resolve(reply, field);
    expect(v.kind).toBe('auto_resolve');
    expect(v.writes[0].value).toBe(value);
  });

  test('W1-21: a field outside the numeric reading set still writes a bare value, and escalates a unit the grammar does not know', () => {
    expect(resolve('2.5', 'live_csa_mm2')).toMatchObject({ kind: 'auto_resolve' });
    expect(resolve('2.5 mm', 'live_csa_mm2')).toEqual({
      kind: 'escalate',
      parsed_hint: 'reply_not_value_only',
    });
  });

  test('a family-less field escalates any explicit unit', () => {
    expect(resolve('2.5 ohms', 'live_csa_mm2')).toEqual({
      kind: 'escalate',
      parsed_hint: 'unit_mismatch:ohms',
    });
  });
});
