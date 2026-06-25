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

  test('"0.7 no 0.47" correction pattern — takes the LAST numeric (lower confidence)', () => {
    // Verbatim from session 08469BFC: user said "lives are 0.7 no. No.",
    // then "0.47". Inside the correction pattern the resolver picks the
    // last value AND lowers confidence to 0.85 to surface the rephrase.
    const verdict = resolveValueAnswer({
      userText: '0.7 no 0.47',
      contextField: 'ring_r1_ohm',
      contextCircuit: 6,
      sourceTurnId: 'turn-12',
    });
    expect(verdict.kind).toBe('auto_resolve');
    expect(verdict.writes[0].value).toBe('0.47');
    expect(verdict.writes[0].confidence).toBe(0.85);
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
  test('"limb" / "lim" / "limitation" on a continuity field → write the string "LIM", never ∞', () => {
    for (const phrase of ['limb', 'lim', 'Limb.', 'limitation', 'limited']) {
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

  test('"limitation" on a non-continuity field → escalate (not ∞, not a drop)', () => {
    const verdict = resolveValueAnswer({
      userText: 'limitation',
      contextField: 'measured_zs_ohm',
      contextCircuit: 2,
      sourceTurnId: 't',
    });
    expect(verdict.kind).toBe('escalate');
    expect(verdict.parsed_hint).toBe('lim_on_non_continuity_field');
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

  test('corrected reply "0.7 no 0.47" with contextCircuits [3,4] fans out two writes at 0.85', () => {
    const verdict = resolveValueAnswer({
      userText: '0.7 no 0.47',
      contextField: 'measured_zs_ohm',
      contextCircuit: null,
      contextCircuits: [3, 4],
      sourceTurnId: 'turn-x',
    });
    expect(verdict.kind).toBe('auto_resolve');
    expect(verdict.writes).toHaveLength(2);
    expect(verdict.writes.every((w) => w.value === '0.47')).toBe(true);
    expect(verdict.writes.every((w) => w.confidence === 0.85)).toBe(true);
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
