/**
 * §A4 (field-feedback-2026-07-14, F8) — unit tests for the pending-value
 * module: extractPendingValue (capture rules incl. the F8 two-number ask
 * question), resolveFieldNameAnswer (NET-NEW field-name resolution), and
 * detectStructuredReading (the typed schema-aware detector spanning all
 * field families).
 */

import {
  extractPendingValue,
  resolveFieldNameAnswer,
  detectStructuredReading,
} from '../extraction/stage6-pending-value.js';

describe('extractPendingValue — F8 capture rules', () => {
  test('F8 variant A: value in the turn transcript, unit-bound', () => {
    const out = extractPendingValue({
      transcript: 'ICD trip time for circuit 2 is 26 milliseconds.',
      question: 'Which reading was that for?',
    });
    expect(out).toMatchObject({ value: '26', unit: 'ms', source: 'transcript' });
  });

  test('F8 variant B: transcript empty, ask QUESTION carries TWO numbers — "circuit 2" is scope, "26 milliseconds" is the value', () => {
    const out = extractPendingValue({
      transcript: null,
      question: 'I heard 26 milliseconds for circuit 2 — which reading was that for?',
    });
    expect(out).toMatchObject({ value: '26', unit: 'ms', source: 'question' });
  });

  test('scope-token exclusion holds in the transcript too', () => {
    const out = extractPendingValue({
      transcript: 'circuit 4 something 0.62 ohms',
      question: null,
    });
    expect(out).toMatchObject({ value: '0.62', unit: 'ohm', source: 'transcript' });
  });

  test('multiple unbound value spans → NO capture (never guess)', () => {
    const out = extractPendingValue({
      transcript: 'it was 26 or maybe 28 I think',
      question: null,
    });
    expect(out).toBeNull();
  });

  test('single unbound number → captured with null unit', () => {
    const out = extractPendingValue({ transcript: 'it was 26', question: null });
    expect(out).toMatchObject({ value: '26', unit: null, source: 'transcript' });
  });

  test('only scope numbers → no capture', () => {
    expect(extractPendingValue({ transcript: 'on circuit 2 please', question: null })).toBeNull();
  });

  test('transcript preferred over question when both carry values', () => {
    const out = extractPendingValue({
      transcript: 'reading was 26 milliseconds',
      question: 'was that 30 milliseconds?',
    });
    expect(out).toMatchObject({ value: '26', source: 'transcript' });
  });

  test('provenance sourceText is recorded', () => {
    const out = extractPendingValue({ transcript: 'reading was 26 milliseconds', question: null });
    expect(out.sourceText).toBe('reading was 26 milliseconds');
  });

  test('Codex r4-#3: ambiguous transcript NEVER falls through to a single-valued question (unbound)', () => {
    const out = extractPendingValue({
      transcript: 'it was 0.3 or 0.4 on circuit 2',
      question: 'Which reading was that 0.4 for?',
    });
    expect(out).toBeNull();
  });

  test('Codex r4-#3: ambiguous unit-bound transcript also stops — no question fallback', () => {
    const out = extractPendingValue({
      transcript: 'it was 0.3 ohms or 0.4 ohms',
      question: 'Which reading was that 0.4 for?',
    });
    expect(out).toBeNull();
  });

  test('Codex r4-#3: question fallback still works when the transcript has ZERO candidates', () => {
    const out = extractPendingValue({
      transcript: 'erm on circuit 2 please',
      question: 'I heard 26 milliseconds for circuit 2 — which reading was that for?',
    });
    expect(out).toMatchObject({ value: '26', unit: 'ms', source: 'question' });
  });

  test('Codex r4-#4: coordinated scope list — "circuits 5 and 6" contributes NO value candidates', () => {
    expect(
      extractPendingValue({
        transcript: null,
        question: 'Which reading was that for circuits 5 and 6?',
      })
    ).toBeNull();
  });

  test('Codex r4-#4: comma list "circuits 5, 6 and 7" — all scope', () => {
    expect(
      extractPendingValue({
        transcript: null,
        question: 'Was that on circuits 5, 6 and 7?',
      })
    ).toBeNull();
  });

  test('Codex r4-#4: range "circuits 5 to 7" — all scope', () => {
    expect(
      extractPendingValue({ transcript: null, question: 'Was that circuits 5 to 7?' })
    ).toBeNull();
  });

  test('Codex r4-#4: "circuit number 2" — connector keeps the run alive', () => {
    expect(
      extractPendingValue({ transcript: null, question: 'Which reading on circuit number 2?' })
    ).toBeNull();
  });

  test('Codex r4-#4: a real value OUTSIDE the scope run still captures', () => {
    const out = extractPendingValue({
      transcript: null,
      question: 'I heard 0.5 for circuits 5 and 6 — which reading was that?',
    });
    expect(out).toMatchObject({ value: '0.5', unit: null, source: 'question' });
  });

  test('Codex r7-#1: telegraphic dictation — a UNIT-BOUND value inside a scope run is still a value ("RCD trip time circuit 2 26 milliseconds")', () => {
    const out = extractPendingValue({
      transcript: 'RCD trip time circuit 2 26 milliseconds',
      question: null,
    });
    expect(out).toMatchObject({ value: '26', unit: 'ms', source: 'transcript' });
  });

  test('Codex r7-#1: "Zs circuit 4 0.30 ohms" captures 0.30, not scope', () => {
    const out = extractPendingValue({ transcript: 'Zs circuit 4 0.30 ohms', question: null });
    expect(out).toMatchObject({ value: '0.30', unit: 'ohm', source: 'transcript' });
  });
});

describe('resolveFieldNameAnswer — field-name replies', () => {
  test('F8 reply "RCD trip time." → rcd_time_ms (canonical snapshot key, NOT the wire key)', () => {
    expect(resolveFieldNameAnswer('RCD trip time.')).toBe('rcd_time_ms');
  });

  test('"trip time" and the ICD garble form resolve too', () => {
    expect(resolveFieldNameAnswer('trip time')).toBe('rcd_time_ms');
    expect(resolveFieldNameAnswer('ICD trip time')).toBe('rcd_time_ms');
  });

  test('leading filler is stripped ("it was the trip time")', () => {
    expect(resolveFieldNameAnswer('it was the trip time')).toBe('rcd_time_ms');
  });

  test('"Zs" resolves to measured_zs_ohm', () => {
    expect(resolveFieldNameAnswer('Zs')).toBe('measured_zs_ohm');
  });

  test('unrelated prose → null (no fuzzy guessing)', () => {
    expect(resolveFieldNameAnswer('the weather is nice')).toBeNull();
    expect(resolveFieldNameAnswer('yes')).toBeNull();
    expect(resolveFieldNameAnswer('')).toBeNull();
  });
});

describe('detectStructuredReading — typed, schema-aware completeness', () => {
  test('circuit field + value + explicit ref → complete ("Zs circuit 4 is 0.30")', () => {
    const d = detectStructuredReading('Zs circuit 4 is 0.30');
    expect(d).toMatchObject({
      fieldKey: 'measured_zs_ohm',
      family: 'circuit',
      toolFamily: 'record_reading',
      circuit: 4,
      complete: true,
    });
  });

  test('BOARD reading needs no circuit → complete ("Ze is 0.22")', () => {
    const d = detectStructuredReading('Ze is 0.22');
    expect(d).toMatchObject({
      fieldKey: 'earth_loop_impedance_ze',
      toolFamily: 'record_board_reading',
      complete: true,
    });
  });

  test('SELECT field with a canonical option, zero digits → complete ("earthing arrangement is TT")', () => {
    const d = detectStructuredReading('earthing arrangement is TT');
    expect(d).toMatchObject({ fieldKey: 'earthing_arrangement', complete: true });
  });

  test('FREE-TEXT installation field via assignment form → complete ("customer name is David")', () => {
    const d = detectStructuredReading('customer name is David');
    expect(d).toMatchObject({ fieldKey: 'client_name', complete: true });
  });

  test('bare field name (the F8 ANSWER shape) → NOT complete', () => {
    const d = detectStructuredReading('RCD trip time.');
    expect(d == null || d.complete === false).toBe(true);
  });

  test('bare numeric value → no field → null', () => {
    expect(detectStructuredReading('26 milliseconds')).toBeNull();
  });

  test('circuit field + value but NO explicit ref → NOT complete (conservative against active asks)', () => {
    const d = detectStructuredReading('Zs is 0.30');
    expect(d).not.toBeNull();
    expect(d.complete).toBe(false);
  });

  test('Codex r1-#2: select ALIASES count — "earthing arrangement is PME" is complete (PME ≡ TN-C-S per the prompt garble list)', () => {
    const d = detectStructuredReading('earthing arrangement is PME');
    expect(d).toMatchObject({ fieldKey: 'earthing_arrangement', complete: true });
  });

  test('Codex r1-#2: squashed option forms count — "earthing arrangement is t n s" (TN-S) is complete', () => {
    const d = detectStructuredReading('earthing arrangement is t n s');
    expect(d).toMatchObject({ fieldKey: 'earthing_arrangement', complete: true });
  });

  test('Codex r3-#4: boundary anchoring — "earthing arrangement is not tested" is NOT complete (no TT inside "not tested")', () => {
    const d = detectStructuredReading('earthing arrangement is not tested');
    expect(d == null || d.complete === false).toBe(true);
  });

  test('sentinel value counts for a numeric circuit field ("R1 plus R2 on circuit 3 is a limitation")', () => {
    const d = detectStructuredReading('R1 plus R2 on circuit 3 is a limitation');
    expect(d).toMatchObject({ fieldKey: 'r1_r2_ohm', circuit: 3, complete: true });
  });

  test('Codex r7-#1: telegraphic complete reading is COMPLETE ("Zs circuit 4 0.30 ohms")', () => {
    // The unit-bound 0.30 must not inherit scope from the open "circuit 4"
    // run — an incomplete verdict here would let this fresh reading be
    // consumed as the answer to an unrelated pending ask.
    const d = detectStructuredReading('Zs circuit 4 0.30 ohms');
    expect(d).toMatchObject({ fieldKey: 'measured_zs_ohm', circuit: 4, complete: true });
  });

  test('Codex r7-#1: "RCD trip time circuit 2 26 milliseconds" is COMPLETE', () => {
    const d = detectStructuredReading('RCD trip time circuit 2 26 milliseconds');
    expect(d).toMatchObject({ fieldKey: 'rcd_time_ms', circuit: 2, complete: true });
  });

  test('Codex r8-#1: schema-declared BOOLEAN whose key lacks the name hints — "means earthing distributor yes" is COMPLETE', () => {
    // means_earthing_distributor is type:'boolean' in the schema but its key
    // contains none of confirmed/_present/polarity — pre-fix it fell to the
    // free-text branch and "… yes" came back incomplete, consumable as a
    // stale pending ask's answer.
    const d = detectStructuredReading('means earthing distributor yes');
    expect(d).toMatchObject({ fieldKey: 'means_earthing_distributor', complete: true });
  });

  test('Codex r8-#1: literal true/false joins the boolean vocabulary ("means earthing electrode is true")', () => {
    const d = detectStructuredReading('means earthing electrode is true');
    expect(d).toMatchObject({ fieldKey: 'means_earthing_electrode', complete: true });
  });
});

// -----------------------------------------------------------------------------
// Plan E §4b piece 2 (2026-07-28, feedback id 100(a)) — anchored main-earth
// DETECTOR_ALIASES + per-alias notFollowedBy exclusions + ze-at-board
// precedence. The safety matrix here is what keeps the two new aliases from
// cannibalising the ADJACENT earth-family fields: the lexicon-form cases
// exercise the lexicon path, the alias-FORM cases exercise the alias path
// with its exclusion lookahead (round-5: lexicon-form cases alone never
// exercise the alias path).
// -----------------------------------------------------------------------------

describe('detectStructuredReading — plan E main-earth aliases', () => {
  test('"main earth is 16" → earthing_conductor_csa, complete (the id-100 repro reply)', () => {
    const d = detectStructuredReading('main earth is 16');
    expect(d).toMatchObject({
      fieldKey: 'earthing_conductor_csa',
      family: 'supply',
      complete: true,
    });
  });

  test('"main earthing conductor 10" → earthing_conductor_csa, complete', () => {
    const d = detectStructuredReading('main earthing conductor 10');
    expect(d).toMatchObject({ fieldKey: 'earthing_conductor_csa', complete: true });
  });

  test('lexicon-form adjacents keep their homes: material / continuity', () => {
    expect(detectStructuredReading('earthing conductor material is Copper')).toMatchObject({
      fieldKey: 'earthing_conductor_material',
      complete: true,
    });
    expect(detectStructuredReading('earthing conductor continuity is pass')).toMatchObject({
      fieldKey: 'earthing_conductor_continuity',
      complete: true,
    });
  });

  test('ALIAS-form adjacents (round-5 — these exercise the notFollowedBy lookahead): "main earthing conductor material/continuity" are NOT CSA', () => {
    expect(detectStructuredReading('main earthing conductor material is Copper')).toMatchObject({
      fieldKey: 'earthing_conductor_material',
    });
    expect(detectStructuredReading('main earthing conductor continuity is pass')).toMatchObject({
      fieldKey: 'earthing_conductor_continuity',
    });
  });

  test('SAFETY INVARIANT (round-4): "main earth bonding is 10" is NOT CSA — no lexicon name exists, so the detector returns null', () => {
    // A positive bonding_conductor_csa assertion is unachievable (the
    // lexicon has no "main bonding"/"main earth bonding" name); the
    // invariant is null-or-not-CSA — the prompt steers the model for the
    // positive bonding write (live probe 6).
    const d = detectStructuredReading('main earth bonding is 10');
    expect(d === null || d.fieldKey !== 'earthing_conductor_csa').toBe(true);
  });

  test('adjacent select field unaffected: "earthing arrangement is TT" → earthing_arrangement', () => {
    expect(detectStructuredReading('earthing arrangement is TT')).toMatchObject({
      fieldKey: 'earthing_arrangement',
      complete: true,
    });
  });

  test('ze-at-board precedence (round-4): "Ze at the board is 0.2" → ze_at_db, never supply earth_loop_impedance_ze', () => {
    expect(detectStructuredReading('Ze at the board is 0.2')).toMatchObject({
      fieldKey: 'ze_at_db',
      family: 'board',
      complete: true,
    });
    expect(detectStructuredReading('Ze at DB is 0.2')).toMatchObject({ fieldKey: 'ze_at_db' });
    // Bare Ze keeps its supply routing.
    expect(detectStructuredReading('Ze is 0.35')).toMatchObject({
      fieldKey: 'earth_loop_impedance_ze',
      family: 'supply',
    });
  });

  test('IMMEDIATE-lookahead exclusion (round-6): a compound utterance with the excluded word ELSEWHERE still matches at its own position', () => {
    expect(detectStructuredReading('main earth is 16 and the bonding is 10')).toMatchObject({
      fieldKey: 'earthing_conductor_csa',
      complete: true,
    });
  });

  // Two DECIDED-behaviour pins carried over as the review-quiet evidence for
  // this standalone extraction (the main-earth precedence steer + detector
  // aliases above). Both are checked here rather than assumed.
  //
  // The unit-precedence ladder ("an ohms unit ⇒ earth_loop_impedance_ze") lives
  // in the PROMPT (§4), not in this detector. The detector's only job is to
  // decide whether a reply is a FRESH structured reading or the answer to a
  // pending ask — it never writes a field. When the detector disagrees with an
  // ask still pending, no branch on `origin/main` writes the detector's field:
  // depending on which pre-existing path the reply arrives through, it is
  // either re-injected as a fresh transcript (the pendingValue-class direct
  // `ask_user_answered` channel and the transcript-first overtake path both do
  // this) or, on the dispatcher's own fallback, forwarded to the model as
  // `untrusted_user_text` in the tool result (see
  // stage6-dispatcher-ask-pending-value.test.js's main-earth pins, which
  // assert this exact field on the response body) — either way the MODEL
  // makes the final field decision under the §4 ladder, never this detector.
  // It can never produce a wrong write or a lost reading.
  test('DECIDED: an explicit ohms unit does NOT re-route the detector — the prompt ladder owns unit precedence, and the detector never writes', () => {
    expect(detectStructuredReading('main earth is 0.35 ohms')).toMatchObject({
      fieldKey: 'earthing_conductor_csa',
    });
    // The consequence that makes this safe: the value still reaches the model
    // as a fresh transcript, and "Ze"-anchored speech is unaffected.
    expect(detectStructuredReading('Ze is 0.35 ohms')).toMatchObject({
      fieldKey: 'earth_loop_impedance_ze',
    });
  });

  test('DECIDED: the BARE "earthing conductor" alias stays dropped — adding it would seize "earthing conductor material is Copper" as a CSA reading', () => {
    // Returning null means this reply is treated as the pending ask's answer
    // rather than a fresh reading. That is the accepted cost of keeping the
    // adjacent material/continuity fields correct; the inverted-ask earth case
    // is the named follow-up, not this alias.
    expect(detectStructuredReading('earthing conductor is 16')).toBeNull();
    expect(detectStructuredReading('earthing conductor material is Copper')).toMatchObject({
      fieldKey: 'earthing_conductor_material',
    });
  });
});
