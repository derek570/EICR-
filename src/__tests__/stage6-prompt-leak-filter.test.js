/**
 * Stage 6 Phase 4 Plan 04-26 — Layer 2 unit tests for
 * `checkForPromptLeak()` in `stage6-prompt-leak-filter.js`.
 *
 * WHAT: exhaustive unit coverage on the output-side prompt-leak
 * filter. Four detection families + sanitised-replacement
 * shape + false-positive guard on 20 inspector-style
 * utterances.
 *
 * WHY: this is the pure-function core of Layer 2. Wiring tests
 * (Task 4) exercise the dispatcher integration; this file
 * locks the detection contract itself. A regression that
 * LOOSENS the filter (e.g., a marker string dropped from the
 * list) must fail here loudly, independent of any dispatcher
 * changes.
 *
 * Detection families under test:
 *   Group 1 — marker strings (case-insensitive substring).
 *   Group 2 — requirement-ID patterns (/ST[A-Z]-0\d/i).
 *   Group 3 — structural prompt phrases (case-insensitive).
 *   Group 4 — worked-example markers (context-gated to avoid
 *             "for example 1 hour" false positives).
 *   Group 5 — per-field length ceilings (suspicious oversize).
 *   Group 6 — sanitised replacement shape (per field class).
 *   Group 7 — false-positive guard (20 normal utterances).
 */

import { checkForPromptLeak } from '../extraction/stage6-prompt-leak-filter.js';

describe('checkForPromptLeak() — Layer 2 output-side prompt-leak filter', () => {
  // ------------------------------------------------------------------
  // Group 1: marker strings
  // ------------------------------------------------------------------
  describe('Group 1 — marker strings (case-insensitive)', () => {
    test.each([
      ['TRUST BOUNDARY'],
      ['SNAPSHOT TRUST BOUNDARY'],
      ['<<<USER_TEXT>>>'],
      ['<<<END_USER_TEXT>>>'],
      ['SYSTEM_CHANNEL'],
      ['USER_CHANNEL'],
    ])('flags exact marker: %s', (marker) => {
      const result = checkForPromptLeak(marker, { field: 'question' });
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/^marker:/);
    });

    test('flags lowercase marker "trust boundary"', () => {
      const result = checkForPromptLeak('trust boundary', { field: 'question' });
      expect(result.safe).toBe(false);
    });

    test('flags mixed-case marker "Trust Boundary"', () => {
      const result = checkForPromptLeak('Trust Boundary', { field: 'question' });
      expect(result.safe).toBe(false);
    });

    test('flags marker embedded in larger sentence', () => {
      const result = checkForPromptLeak(
        'The content includes a TRUST BOUNDARY section at line 3.',
        { field: 'question' }
      );
      expect(result.safe).toBe(false);
    });

    test('safe on "trusted bounds" (partial word overlap)', () => {
      // Intentionally close but not the exact marker.
      const result = checkForPromptLeak('The trusted bounds of the installation.', {
        field: 'question',
      });
      expect(result.safe).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // Group 2: requirement-ID patterns
  // ------------------------------------------------------------------
  describe('Group 2 — requirement-ID patterns', () => {
    test.each([
      'STQ-01',
      'STQ-05',
      'STR-02',
      'STG-04',
      'STA-03',
      'STB-03',
      'STD-07',
      'STO-02',
      'STI-01',
      'STT-04',
      'STS-09',
    ])('flags requirement ID: %s', (id) => {
      const result = checkForPromptLeak(`See the ${id} block for details.`, {
        field: 'question',
      });
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/^req-id:/);
    });

    test('flags lowercase "stq-05" (case-insensitive)', () => {
      const result = checkForPromptLeak('stq-05 requires the verbatim sentence', {
        field: 'question',
      });
      expect(result.safe).toBe(false);
    });

    test('safe on "STQ-0" (no digit suffix)', () => {
      // Deliberately looser — STQ-0 alone is too generic and lives
      // on the banned-literal marker list only (to be enforced
      // separately if needed). The requirement-ID regex demands a
      // digit suffix to avoid FPs.
      const result = checkForPromptLeak('STQ-0 is mentioned in docs', {
        field: 'question',
      });
      expect(result.safe).toBe(true);
    });

    test('safe on "ST-01" (missing letter)', () => {
      const result = checkForPromptLeak('ST-01 transformer label', {
        field: 'question',
      });
      expect(result.safe).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // Group 3: structural prompt phrases
  // ------------------------------------------------------------------
  describe('Group 3 — structural prompt phrases', () => {
    test.each([
      'You are an EICR inspection assistant',
      'You have 7 tools',
      'Do not emit free-text JSON',
      'Prefer silent writes',
      'Corrections are writes',
    ])('flags structural phrase: %s', (phrase) => {
      const result = checkForPromptLeak(phrase, { field: 'question' });
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/^phrase:/);
    });

    test('flags lowercase "you have 7 tools"', () => {
      const result = checkForPromptLeak('you have 7 tools', { field: 'question' });
      expect(result.safe).toBe(false);
    });

    test('safe on "silent" alone', () => {
      const result = checkForPromptLeak('The circuit is in silent mode.', {
        field: 'question',
      });
      expect(result.safe).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // Group 4: worked-example markers (context-gated)
  // ------------------------------------------------------------------
  describe('Group 4 — worked-example markers (context-gated)', () => {
    test('flags "Example 1: record_reading({...})" (adjacent to tool keyword)', () => {
      const result = checkForPromptLeak(
        'Example 1: record_reading({ field: "measured_zs_ohm", circuit: 3, value: "0.35" })',
        { field: 'question' }
      );
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('example');
    });

    test('flags "Example 2:" followed by clear_reading', () => {
      const result = checkForPromptLeak(
        'Here is the flow — Example 2: clear_reading then record_reading',
        { field: 'question' }
      );
      expect(result.safe).toBe(false);
    });

    test('flags "Example 3:" followed by ask_user', () => {
      const result = checkForPromptLeak('Example 3: ask_user({ reason: "out_of_range_circuit" })', {
        field: 'question',
      });
      expect(result.safe).toBe(false);
    });

    test('safe on "for example 1 hour delay" (no tool keyword)', () => {
      const result = checkForPromptLeak(
        'For example, 1 hour delay was noted before the circuit tripped.',
        { field: 'observation_text' }
      );
      expect(result.safe).toBe(true);
    });

    test('safe on "example 2 of 5" in legitimate inspection prose', () => {
      const result = checkForPromptLeak(
        'In example 2 of 5 test scenarios, the RCD tripped correctly.',
        { field: 'observation_text' }
      );
      expect(result.safe).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // Group 5: per-field length ceilings
  // ------------------------------------------------------------------
  describe('Group 5 — per-field length ceilings', () => {
    test('ask_user.question of 600 chars is flagged (>500 ceiling)', () => {
      const text = 'a'.repeat(600);
      const result = checkForPromptLeak(text, { field: 'question' });
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/^length-suspicious:/);
    });

    test('ask_user.question of 400 chars is safe (under ceiling)', () => {
      const text = 'a'.repeat(400);
      const result = checkForPromptLeak(text, { field: 'question' });
      expect(result.safe).toBe(true);
    });

    test('record_observation.text of 1200 chars is flagged (>1000 ceiling)', () => {
      const text = 'a'.repeat(1200);
      const result = checkForPromptLeak(text, { field: 'observation_text' });
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/^length-suspicious:/);
    });

    test('record_observation.text of 800 chars is safe (under ceiling)', () => {
      const text = 'a'.repeat(800);
      const result = checkForPromptLeak(text, { field: 'observation_text' });
      expect(result.safe).toBe(true);
    });

    test('no length check when field is omitted', () => {
      const text = 'a'.repeat(9999);
      const result = checkForPromptLeak(text); // no opts
      expect(result.safe).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // Group 6: sanitised replacement shape
  // ------------------------------------------------------------------
  describe('Group 6 — sanitised replacement shape', () => {
    test('question-class leak returns a polite-refusal sanitised string', () => {
      const result = checkForPromptLeak('TRUST BOUNDARY', { field: 'question' });
      expect(result.safe).toBe(false);
      expect(typeof result.sanitised).toBe('string');
      expect(result.sanitised.length).toBeGreaterThan(10);
      expect(result.sanitised.toLowerCase()).toContain("can't share");
      expect(result.is_error_replacement).toBeFalsy();
    });

    test('observation-class leak returns a short "refused" body', () => {
      const result = checkForPromptLeak('TRUST BOUNDARY', { field: 'observation_text' });
      expect(result.safe).toBe(false);
      expect(typeof result.sanitised).toBe('string');
      expect(result.sanitised.toLowerCase()).toContain('refused');
      expect(result.is_error_replacement).toBeFalsy();
    });

    test('designation-class leak returns is_error_replacement=true (dispatcher should reject)', () => {
      const result = checkForPromptLeak('TRUST BOUNDARY', { field: 'designation' });
      expect(result.safe).toBe(false);
      expect(result.sanitised).toBeNull();
      expect(result.is_error_replacement).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // Group 7: false-positive guard on 20 inspector-style utterances
  // ------------------------------------------------------------------
  describe('Group 7 — false-positive guard (20 normal utterances)', () => {
    const SAMPLES = [
      'Zs on circuit three is nought point three five.',
      'Circuit two, insulation greater than two hundred both ways, polarity correct.',
      'Consumer unit in the hallway, RCBO type B, 32 amp.',
      'For example, 1 hour delay before the RCD tripped.',
      'Observation: missing earthing on the immersion heater.',
      'The trusted bounds of the installation include a sub-board in the garage.',
      'Code this as C2 — absent main bonding to gas.',
      'Add a C3 observation for the non-standard cable colour.',
      'R1 plus R2 is zero point five one ohms on circuit four.',
      'Example 1 of 5 scenarios tested — all circuits passed.',
      'The system does not emit any readings when the test is incomplete.',
      'Please correct the reading for circuit 3 — it should be 0.71.',
      'The silent writes mode is preferred by this electrician but not required.',
      'You are correct that circuit 6 is outdoors.',
      'The 7 tools in my kit include a multimeter and clamp meter.',
      'For instance, STQ is not a valid code.',
      'We have 7 observations so far in this inspection.',
      'The meter reads less than 0.5 ohm.',
      'Ring continuity test on circuit 4 gave matching values.',
      'No visible damage to the insulation on any accessible cable.',
    ];

    test.each(SAMPLES.map((s, i) => [i + 1, s]))('sample #%i is safe: %s', (_i, sample) => {
      // Check both field classes so any field-specific regression
      // is caught.
      const questionResult = checkForPromptLeak(sample, { field: 'question' });
      expect(questionResult.safe).toBe(true);
      const obsResult = checkForPromptLeak(sample, { field: 'observation_text' });
      expect(obsResult.safe).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // Group 8 — r20-#3 entropy + reversed + conservative detection
  //
  // r20 review identified that 04-26's detection families (markers,
  // requirement-IDs, structural phrases, example scaffolding, length
  // ceilings) covered plaintext leaks but not encoded / transformed
  // content. Three new families close the gap:
  //
  //   1. High-entropy substring detection — flags base64 / hex blobs
  //      of ≥40 chars. Real-world inspection text has almost no
  //      long high-entropy runs (a regulation like 411.3.3 is 7
  //      chars, a measurement like 0.35 is 4; base64-encoded prompt
  //      content is ≥60 chars minimum for useful fragments).
  //
  //   2. Reversed-content detection — checks whether the input
  //      reversed contains any known marker or structural phrase.
  //      Cheap: 1 reverse + ~11 substring checks.
  //
  //   3. Per-field conservative low-alpha-ratio backstop — for
  //      `question` (≥200 chars, <50% alpha) and `designation`
  //      (≥40 chars, <40% alpha). Catches binary-ish payloads that
  //      slip under length ceilings. `observation_text` is NOT
  //      low-alpha-guarded — observations legitimately contain lots
  //      of numeric content (readings, regulation refs, cable
  //      sizes).
  //
  // False-positive bar: 0/20 on both the 04-26 corpus (Group 7)
  // and the new 20-sample r20-#3 corpus below. If any FP, the
  // detector MUST be tightened — failing legitimate inspector
  // dictation is worse than a prompt leak, and the product's
  // existence depends on voice extraction working.
  // ------------------------------------------------------------------
  describe('Group 8 — r20-#3 entropy + reversed + conservative detection', () => {
    // --------- Entropy: base64 chunks ---------
    test('48-char base64 chunk is flagged (entropy)', () => {
      // 48 chars = typical base64 expansion of a 36-byte prompt
      // fragment. No sane inspection text contains this.
      const text = 'WW91IGFyZSBhbiBFSUNSIGluc3BlY3Rpb24gYXNzaXN0YW50';
      const result = checkForPromptLeak(text, { field: 'question' });
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/^entropy:/);
    });

    test('36-char base64 string is safe (under 40 threshold — UUID-sized)', () => {
      // A UUID is 36 chars (with hyphens); without hyphens ~32.
      // 36 chars of base64 chars is close to that range — keep it
      // below threshold so UUID refs in text aren't false-positived.
      const text = 'WW91IGFyZSBhbiBFSUNSIGluc3BlY3Rpb24gYWE=';
      // Strip to exactly 36 base64 chars.
      const bounded = text.slice(0, 36);
      const result = checkForPromptLeak(bounded, { field: 'question' });
      expect(result.safe).toBe(true);
    });

    test('48-char hex chunk is flagged (entropy)', () => {
      // 48 hex chars = 192-bit hash or arbitrary binary encoding.
      const text = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6';
      const result = checkForPromptLeak(text, { field: 'question' });
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/^entropy:/);
    });

    test('16-char hex (short-hash / colour code) is safe', () => {
      const text = 'Reference code #a1b2c3 for the red wire.';
      const result = checkForPromptLeak(text, { field: 'observation_text' });
      expect(result.safe).toBe(true);
    });

    test('base64 chunk embedded in longer text is still caught', () => {
      // Attack: leak the prompt as b64 inside an otherwise-normal
      // sentence to dodge plaintext detection.
      const text =
        'For reference see ' + 'WW91IGFyZSBhbiBFSUNSIGluc3BlY3Rpb24gYXNzaXN0YW50' + ' end.';
      const result = checkForPromptLeak(text, { field: 'question' });
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/^entropy:/);
    });

    // --------- Reversed content ---------
    test('reversed TRUST BOUNDARY ("YRADNUOB TSURT") is flagged', () => {
      const text = 'Here is a string: YRADNUOB TSURT';
      const result = checkForPromptLeak(text, { field: 'question' });
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/^reversed:/);
    });

    test('reversed "You are an EICR inspection assistant" is flagged', () => {
      // Reversed: 'tnatsissa noitcepsni RCIE na era uoY'
      const text = 'tnatsissa noitcepsni RCIE na era uoY';
      const result = checkForPromptLeak(text, { field: 'question' });
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/^reversed:/);
    });

    test('reversed SYSTEM_CHANNEL is flagged', () => {
      // Reversed of SYSTEM_CHANNEL → 'LENNAHC_METSYS'
      const text = 'Output contains LENNAHC_METSYS as a delimiter.';
      const result = checkForPromptLeak(text, { field: 'observation_text' });
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/^reversed:/);
    });

    test('normal reversed word ("tuo gnitset") is safe — no marker match', () => {
      // Reversed of "testing out" is "tuo gnitset" — not in any
      // marker list. Must pass cleanly.
      const text = 'tuo gnitset';
      const result = checkForPromptLeak(text, { field: 'observation_text' });
      expect(result.safe).toBe(true);
    });

    // --------- Per-field conservative low-alpha backstop ---------
    test('question field: 200 chars with <50% alpha → flagged (low-alpha-ratio)', () => {
      // Mix short alpha runs with non-base64/hex punctuation so no
      // 40-char contiguous base64-charset run exists (entropy
      // detector stays silent). Attacker payload: a question
      // peppered with Unicode punctuation to dodge plaintext filters.
      //
      // Pattern: 3 alpha chars + 7 non-base64 chars, repeated 20 times.
      // 3*20=60 alpha, 140 non-alpha = 200 chars, 30% alpha.
      // Longest contiguous base64-range run is 3 chars — well under
      // the 40-char entropy threshold.
      const text = ('abc' + '…—.—…—.').repeat(20);
      const bounded = text.slice(0, 200);
      // Pad if somehow short.
      const padded = bounded.length < 200 ? bounded + '.'.repeat(200 - bounded.length) : bounded;
      expect(padded.length).toBe(200);
      const alphaCount = (padded.match(/[a-zA-Z]/g) || []).length;
      expect(alphaCount / padded.length).toBeLessThan(0.5);
      const result = checkForPromptLeak(padded, { field: 'question' });
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/^low-alpha-ratio:/);
    });

    test('question field: 200 chars with normal alpha ratio → safe', () => {
      // 100% alpha; 200 chars — under 500 length ceiling.
      const text = 'a'.repeat(200);
      const result = checkForPromptLeak(text, { field: 'question' });
      expect(result.safe).toBe(true);
    });

    test('designation field: 50 chars with <40% alpha → flagged', () => {
      // Use punctuation outside b64/hex ranges so entropy can't
      // pre-empt the low-alpha guard.
      // 18 alpha + 32 em-dash/ellipsis/dots = 50 chars, 36% alpha.
      const text = 'abcdefghijklmnopqr' + '…—.—…—.'.repeat(5);
      const bounded = text.slice(0, 50);
      expect(bounded.length).toBe(50);
      const alphaCount = (bounded.match(/[a-zA-Z]/g) || []).length;
      expect(alphaCount / bounded.length).toBeLessThan(0.4);
      const result = checkForPromptLeak(bounded, { field: 'designation' });
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/^low-alpha-ratio:/);
    });

    test('designation field: 50 chars with normal alpha → safe', () => {
      // "Upstairs lights and landing corridor socket cct" = 48 chars
      // all alpha/space.
      const text = 'Upstairs lights and landing corridor socket cct';
      const result = checkForPromptLeak(text, { field: 'designation' });
      expect(result.safe).toBe(true);
    });

    test('observation_text field: NO low-alpha guard (numerics are legit)', () => {
      // 100 chars with 30% alpha — legitimate observation content
      // with lots of numeric readings must pass. Regulation refs,
      // cable sizes, readings, etc. all drive alpha ratio down.
      const text = '0.35 ohms 411.3.3 2.5mm2 0.71 0.5 ohm 522.6.201';
      expect(text.length).toBeGreaterThan(20);
      const result = checkForPromptLeak(text, { field: 'observation_text' });
      expect(result.safe).toBe(true);
    });

    // --------- Combined / ordering tests ---------
    test('length ceiling still fires as last resort on long alpha text (question)', () => {
      // 600 chars using only 6 distinct chars — under the entropy
      // distinct-char threshold (10) so entropy doesn't fire, alpha
      // ratio is 100% so low-alpha doesn't fire, no markers or
      // reversed content. Length ceiling is the last resort.
      const text = 'abcdef'.repeat(100);
      expect(text.length).toBe(600);
      const result = checkForPromptLeak(text, { field: 'question' });
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/^length-suspicious:/);
    });

    // --------- False-positive guard — NEW 20-sample corpus ---------
    //
    // This is a SECOND 20-sample corpus focused on content the
    // new detectors must NOT flag. Covers: regulation numbers,
    // readings with units, compound electrical terms, UUID/hash
    // references, observation narratives with mixed content.
    describe('Group 8 — FP guard: 20 normal samples safe across ALL field classes', () => {
      const SAMPLES_2 = [
        'Circuit 3 Zs is 0.35 ohms measured at the distribution board.',
        'RCD type AC 30mA trip time 23ms compliant with BS 7671 411.3.3.',
        'MCB 32A type C on Upstairs sockets ring circuit 2.5mm2 T+E.',
        'Cable reference colours — brown, black, grey and blue on L1/L2/L3/N.',
        'Insulation resistance > 999 MΩ between L and E at 500V test voltage.',
        'R1 + R2 measured 0.51, ring final so divide by 4 gives 0.128.',
        'Main earth conductor verified at 16mm2 minimum per 544.1.1.',
        'Bonding conductor to gas meter observed missing — C2 remedial.',
        'RCBO on circuit 4 did not trip at I delta n over 1 second.',
        'Consumer unit Wylex NHRS 17 with 100A isolator and 8 ways.',
        'Observation: loose neutral in back box, C1, immediate action.',
        'Test voltage 500V, live to earth and live to live on every circuit.',
        'Protective device rating 20A matches cable capacity 2.5mm2.',
        'CPC size correct for circuit rating per BS 7671 table 54.7.',
        'SPD observed type 2 fitted but not labelled per 534.4.4.5.',
        'Zs measured equals Ze plus R1+R2 so earth loop is sound.',
        'Distribution board location noted as under stairs cupboard.',
        'Labels for RCD protection present and legible on all ways.',
        'Reference id a1b2c3 noted on the certificate template.',
        'Bathroom Zone 2 compliance verified per 701 section.',
      ];

      test.each(SAMPLES_2.map((s, i) => [i + 1, s]))(
        'sample2 #%i is safe across question + observation_text + designation: %s',
        (_i, sample) => {
          const q = checkForPromptLeak(sample, { field: 'question' });
          expect(q.safe).toBe(true);
          const o = checkForPromptLeak(sample, { field: 'observation_text' });
          expect(o.safe).toBe(true);
          const d = checkForPromptLeak(sample, { field: 'designation' });
          expect(d.safe).toBe(true);
        }
      );
    });

    // --------- Re-run the 04-26 corpus across the new detectors ---------
    //
    // r20-#3 must not regress the 04-26 false-positive guard. If any
    // of the original 20 samples trip, the detector must be tightened.
    describe('Group 8 — 04-26 corpus still 0 FPs under new detectors', () => {
      const SAMPLES_04_26 = [
        'Zs on circuit three is nought point three five.',
        'Circuit two, insulation greater than two hundred both ways, polarity correct.',
        'Consumer unit in the hallway, RCBO type B, 32 amp.',
        'For example, 1 hour delay before the RCD tripped.',
        'Observation: missing earthing on the immersion heater.',
        'The trusted bounds of the installation include a sub-board in the garage.',
        'Code this as C2 — absent main bonding to gas.',
        'Add a C3 observation for the non-standard cable colour.',
        'R1 plus R2 is zero point five one ohms on circuit four.',
        'Example 1 of 5 scenarios tested — all circuits passed.',
        'The system does not emit any readings when the test is incomplete.',
        'Please correct the reading for circuit 3 — it should be 0.71.',
        'The silent writes mode is preferred by this electrician but not required.',
        'You are correct that circuit 6 is outdoors.',
        'The 7 tools in my kit include a multimeter and clamp meter.',
        'For instance, STQ is not a valid code.',
        'We have 7 observations so far in this inspection.',
        'The meter reads less than 0.5 ohm.',
        'Ring continuity test on circuit 4 gave matching values.',
        'No visible damage to the insulation on any accessible cable.',
      ];

      test.each(SAMPLES_04_26.map((s, i) => [i + 1, s]))(
        'sample1 #%i stays safe under r20-#3 detectors: %s',
        (_i, sample) => {
          const q = checkForPromptLeak(sample, { field: 'question' });
          expect(q.safe).toBe(true);
          const o = checkForPromptLeak(sample, { field: 'observation_text' });
          expect(o.safe).toBe(true);
          const d = checkForPromptLeak(sample, { field: 'designation' });
          expect(d.safe).toBe(true);
        }
      );
    });
  });

  // ------------------------------------------------------------------
  // Defensive edge cases
  // ------------------------------------------------------------------
  describe('Edge cases', () => {
    test('non-string input returns safe:true (defensive)', () => {
      // Filter should not throw on unexpected types — dispatcher
      // callers should already have type-validated, but the filter
      // is defence-in-depth and must not become a throw-site.
      expect(checkForPromptLeak(null).safe).toBe(true);
      expect(checkForPromptLeak(undefined).safe).toBe(true);
      expect(checkForPromptLeak(42).safe).toBe(true);
    });

    test('empty string is safe', () => {
      expect(checkForPromptLeak('').safe).toBe(true);
    });
  });
});
