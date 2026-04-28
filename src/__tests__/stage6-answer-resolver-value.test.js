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

  test('"open circuit" / "infinity" / "OL" / "LIM" — all map to ∞ on continuity fields', () => {
    for (const phrase of ['open circuit', 'infinity', 'OL', 'lim']) {
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
