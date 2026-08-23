/**
 * PLAN-B B3 (feedback id 131, 2026-08-23) — designation-matcher tolerance
 * for a stored noise token, locked against the EXACT evidence strings from
 * field session 17821FFA.
 *
 * The stored trailing "circuit" token defeated BOTH matcher passes at IR
 * script entry: pass 1 needed the ENTIRE stored designation inside the
 * utterance; pass 2 needed [upstairs, light, circuit] as a contiguous token
 * run. Both failed on exactly the suffix, producing a "Which circuit?" ask
 * with no structural gap (Audio-First §2 violation).
 */

import { findCircuitsByDesignation } from '../extraction/dialogue-engine/helpers/circuit-resolution.js';

function sessionWith(circuits) {
  return { sessionId: 's-b3', stateSnapshot: { circuits } };
}

describe('pass 1 — canonical stored form, both substring directions', () => {
  test('EVIDENCE: entry sentence resolves against stored "Upstairs lighting circuit"', () => {
    const session = sessionWith({ 2: { circuit_designation: 'Upstairs lighting circuit' } });
    const r = findCircuitsByDesignation(
      session,
      'insulation resistance for upstairs lighting live to live is lim'
    );
    expect(r.matched).toBe(2);
    expect(r.candidates).toEqual([2]);
  });

  test('reverse direction: short reply "Upstairs lighting." still resolves (answer-path parity)', () => {
    const session = sessionWith({ 2: { circuit_designation: 'Upstairs lighting circuit' } });
    const r = findCircuitsByDesignation(session, 'Upstairs lighting.');
    expect(r.matched).toBe(2);
  });

  test('metadata contract (id-105 masking): matchedDesignation is the CANONICAL variant, literally findable in the reply', () => {
    const session = sessionWith({ 2: { circuit_designation: 'Upstairs lighting circuit' } });
    const reply = 'Upstairs lighting, tested at 500';
    const r = findCircuitsByDesignation(session, reply);
    expect(r.matched).toBe(2);
    // The original stored form is NOT findable in the reply; the canonical
    // variant is — this is what keeps the engine's mask branch from
    // blanking the whole reply and dropping the co-dictated 500.
    expect(r.matchedDesignation).toBe('upstairs lighting');
    expect(reply.toLowerCase()).toContain(r.matchedDesignation);
  });

  test('ambiguity preserved: two near-twin designations still ask', () => {
    const session = sessionWith({
      1: { circuit_designation: 'Upstairs Lighting Circuit' },
      2: { circuit_designation: 'Upstairs Lighting' },
    });
    const r = findCircuitsByDesignation(session, 'upstairs lighting is LIM');
    expect(r.matched).toBe(null);
    expect(r.candidates).toEqual([1, 2]);
  });

  test('sharedDesignation stays the RAW stored form (quote-back speaks what is stored)', () => {
    const session = sessionWith({
      3: { circuit_designation: 'Sockets circuit' },
      4: { circuit_designation: 'Sockets circuit' },
    });
    const r = findCircuitsByDesignation(session, 'the sockets');
    expect(r.candidates).toEqual([3, 4]);
    expect(r.sharedDesignation).toBe('sockets circuit');
  });
});

describe('empty-canonical stored-row exclusion (both passes, raw AND canonical)', () => {
  test('stored "Circuit" and "Circuits" rows yield ZERO candidates for text containing the word "circuit"', () => {
    const session = sessionWith({
      1: { circuit_designation: 'Circuit' },
      2: { circuit_designation: 'Circuits' },
    });
    expect(findCircuitsByDesignation(session, 'the circuit is dead').candidates).toEqual([]);
    expect(findCircuitsByDesignation(session, 'circuit').candidates).toEqual([]);
    expect(
      findCircuitsByDesignation(session, 'insulation on the circuit is LIM').candidates
    ).toEqual([]);
  });
});

describe('QUERY-side canonical guard (interior tokens retained on the stored side)', () => {
  test('stored "Ring circuit sockets" vs generic "circuit" / "the circuit" → zero candidates', () => {
    const session = sessionWith({ 5: { circuit_designation: 'Ring circuit sockets' } });
    expect(findCircuitsByDesignation(session, 'circuit').candidates).toEqual([]);
    expect(findCircuitsByDesignation(session, 'the circuit').candidates).toEqual([]);
  });

  test('stored "Ring circuit sockets" still resolves for a real designation reply', () => {
    const session = sessionWith({ 5: { circuit_designation: 'Ring circuit sockets' } });
    expect(findCircuitsByDesignation(session, 'ring circuit sockets reading 0.3').matched).toBe(5);
  });

  test('generic-word bogus match eliminated: sole stored "Upstairs lighting circuit" no longer resolves from bare "circuit"', () => {
    const session = sessionWith({ 2: { circuit_designation: 'Upstairs lighting circuit' } });
    expect(findCircuitsByDesignation(session, 'the circuit').candidates).toEqual([]);
  });
});

describe('short-remainder guard', () => {
  test('stored "Circuit A": "circuit A is LIM" matches; bounded reply "A" matches', () => {
    const session = sessionWith({ 7: { circuit_designation: 'Circuit A' } });
    expect(findCircuitsByDesignation(session, 'circuit A is LIM').matched).toBe(7);
    expect(findCircuitsByDesignation(session, 'A').matched).toBe(7);
    expect(findCircuitsByDesignation(session, 'A.').matched).toBe(7);
    expect(findCircuitsByDesignation(session, 'the A circuit').matched).toBe(7);
    expect(findCircuitsByDesignation(session, 'A way').matched).toBe(7);
  });

  test('article "a" embedded in prose must NOT match stored "Circuit A" (fail closed)', () => {
    const session = sessionWith({ 7: { circuit_designation: 'Circuit A' } });
    expect(
      findCircuitsByDesignation(session, 'insulation resistance for a bedroom radial is LIM')
        .candidates
    ).toEqual([]);
  });

  test('query-side tier guard: canonical query "a" (from "the A circuit") never substring-matches normal rows', () => {
    // Codex cycle-1: without query-side classification, canonQuery "a"
    // character-matches any designation containing "a" ("garage") — a
    // false ambiguity beside the real "Circuit A".
    const session = sessionWith({
      7: { circuit_designation: 'Circuit A' },
      8: { circuit_designation: 'Garage' },
    });
    const r = findCircuitsByDesignation(session, 'the A circuit');
    expect(r.matched).toBe(7);
    expect(r.candidates).toEqual([7]);
  });

  test('strict query still reverse-matches a stored designation as a WHOLE TOKEN ("56" vs "56 sockets")', () => {
    const session = sessionWith({
      3: { circuit_designation: '56 sockets' },
      8: { circuit_designation: 'Garage' },
    });
    const r = findCircuitsByDesignation(session, '56');
    expect(r.candidates).toEqual([3]);
  });

  test('numeric remainder must NOT match a dictated value', () => {
    const session = sessionWith({ 9: { circuit_designation: 'Circuit 500' } });
    expect(findCircuitsByDesignation(session, 'tested at 500 volts').candidates).toEqual([]);
    // …but an explicit circuit-noun-adjacent form does resolve.
    expect(findCircuitsByDesignation(session, 'circuit 500').matched).toBe(9);
  });
});

describe('pass 2 — canonical stored tokens + fold table', () => {
  test('plural pass-2-only case: stored "Upstairs lighting circuits" vs spoken "upstairs lights"', () => {
    // Pass 1 fails on morphology (lights vs lighting); pass 2 folds AND
    // drops the edge token — only reachable through the canonicalised
    // stored token sequence.
    const session = sessionWith({ 2: { circuit_designation: 'Upstairs lighting circuits' } });
    const r = findCircuitsByDesignation(session, 'upstairs lights reading is LIM');
    expect(r.matched).toBe(2);
  });

  test('pass-2 user-side edge-token drop: spoken trailing "circuit" still resolves a folded designation', () => {
    const session = sessionWith({ 2: { circuit_designation: 'Upstairs Lights' } });
    const r = findCircuitsByDesignation(session, 'the upstairs lighting circuit');
    expect(r.matched).toBe(2);
  });
});

describe('pass interaction (round-19): canonical-only pass-1 admission also consults pass 2', () => {
  test('mixed-pass case yields TWO candidates + ambiguity, not a silent retarget', () => {
    const session = sessionWith({
      1: { circuit_designation: 'Upstairs Lighting Circuit' },
      2: { circuit_designation: 'Upstairs Lights' },
    });
    const r = findCircuitsByDesignation(
      session,
      'insulation resistance upstairs lighting greater than two hundred'
    );
    expect(r.matched).toBe(null);
    expect(r.candidates).toEqual([1, 2]);
  });

  test("pass-1 precedence preserved when the pass-1 match existed under the RAW comparison (today's behaviour)", () => {
    const session = sessionWith({
      1: { circuit_designation: 'Upstairs Lighting' },
      2: { circuit_designation: 'Upstairs Lights' },
    });
    // Raw pass 1 already matches ref 1 (no canonicalisation involved), so
    // pass 2 is not consulted and ref 2's morphology match stays dormant —
    // byte-identical precedence to the pre-PLAN-B behaviour.
    const r = findCircuitsByDesignation(session, 'upstairs lighting 0.5');
    expect(r.matched).toBe(1);
    expect(r.candidates).toEqual([1]);
  });
});
