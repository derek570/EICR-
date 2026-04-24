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

    // ----------------------------------------------------------
    // r23-#2 — bare wrapper literals
    //
    // WHY: r22 marker set catches <<<USER_TEXT>>> and
    // <<<END_USER_TEXT>>> as composite wrappers but lets the bare
    // identifiers (USER_TEXT, END_USER_TEXT, <<<, >>>) slip
    // through. The CONFIDENTIALITY prompt names all four bare
    // tokens as forbidden literals — the model must never emit
    // them. An attacker steering the model into "The marker
    // identifier is USER_TEXT" extracts prompt scaffolding with
    // no wrapper-character neighbour and the filter currently
    // returns safe:true.
    //
    // Fix: 4 new MARKER_STRINGS entries with distinct stable IDs
    // (`user-text-bare`, `end-user-text-bare`, `left-angle-triple`,
    // `right-angle-triple`). Listed AFTER the composite entries so
    // a full wrapper surfaces as `marker:user-text-open` (sharper
    // telemetry) rather than the weaker bare ID.
    // ----------------------------------------------------------
    describe('r23-#2 bare wrapper literals', () => {
      test('flags bare USER_TEXT as marker:user-text-bare', () => {
        const result = checkForPromptLeak('The scaffolding uses USER_TEXT markers.', {
          field: 'question',
        });
        expect(result.safe).toBe(false);
        expect(result.reason).toBe('marker:user-text-bare');
      });

      test('flags bare END_USER_TEXT as marker:end-user-text-bare', () => {
        const result = checkForPromptLeak('Dictation ends at END_USER_TEXT every time.', {
          field: 'question',
        });
        expect(result.safe).toBe(false);
        expect(result.reason).toBe('marker:end-user-text-bare');
      });

      test('flags bare <<< as marker:left-angle-triple', () => {
        const result = checkForPromptLeak('The wrapper opens with <<< at the start.', {
          field: 'question',
        });
        expect(result.safe).toBe(false);
        // First-match-wins: <<< appears first in the text AND the
        // marker list comes BEFORE >>>, so the reason is
        // left-angle-triple. If the iteration hits USER_TEXT first
        // (for a payload containing both), the composite/earlier
        // entries take precedence — that's fine.
        expect(result.reason).toBe('marker:left-angle-triple');
      });

      test('flags bare >>> as marker:right-angle-triple', () => {
        const result = checkForPromptLeak('Legitimate reference to >>> chunks exists.', {
          field: 'question',
        });
        expect(result.safe).toBe(false);
        expect(result.reason).toBe('marker:right-angle-triple');
      });

      test('case-insensitive: lowercase user_text fires bare marker', () => {
        const result = checkForPromptLeak('user_text identifiers in the prompt source.', {
          field: 'question',
        });
        expect(result.safe).toBe(false);
        expect(result.reason).toBe('marker:user-text-bare');
      });

      // Back-compat — composite markers still ID'd as composite
      test('composite <<<USER_TEXT>>> still surfaces as user-text-open (not the bare ID)', () => {
        const result = checkForPromptLeak('<<<USER_TEXT>>> is the full wrapper.', {
          field: 'question',
        });
        expect(result.safe).toBe(false);
        expect(result.reason).toBe('marker:user-text-open');
      });

      test('composite <<<END_USER_TEXT>>> still surfaces as user-text-close (not the bare ID)', () => {
        const result = checkForPromptLeak('<<<END_USER_TEXT>>> closes dictation.', {
          field: 'question',
        });
        expect(result.safe).toBe(false);
        expect(result.reason).toBe('marker:user-text-close');
      });

      // FP audit — 60-sample composite normal corpus must show 0 FP
      // across all 4 field classes under the 4 new markers.
      describe('FP audit: 60-sample normal corpus 0/60 across 4 field classes', () => {
        const GROUP_7_SAMPLES = [
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
        const GROUP_9_LOCATION = [
          'Kitchen sockets consumer unit',
          'Bathroom shaver socket',
          'Under stairs cupboard',
          'Garage sub-main distribution board',
          'Main CU by front door',
          'First floor landing ring',
          'Upstairs bedroom lighting board',
          'Hallway consumer unit position 3',
          'Outside meter tails',
          'Loft immersion isolator',
        ];
        const GROUP_9_REGULATION = [
          'Regulation 522.6.201',
          'BS 7671 643.3.2',
          '411.3.1.1',
          'Regulation 411.3.3',
          'BS 7671 Part 6',
          '701.415.2',
          '544.1.1',
          '722.533',
          'BS 7671 Section 706',
          'Regulation 132.15',
        ];
        const GROUP_9_NORMAL = [
          'Circuit 3 MCB is BS EN 60898-1 type C 16 amp.',
          'Ring final on upstairs ring: R1 plus R2 is 0.51 ohms.',
          'Downstairs sockets ring tested with mini-RCBO.',
          'Lighting circuit live tested with line to earth at 230V.',
          'Shower circuit protected by 50mA type A RCD.',
          'Immersion heater isolator adjacent to cylinder.',
          'Consumer unit labelled and accessible in the garage.',
          'Main bonding to gas within 600mm of the gas meter.',
          'RCBO on cooker circuit type B 32 amp.',
          'Continuity of CPC by all three means confirmed.',
        ];
        const ALL_SAMPLES = [
          ...GROUP_7_SAMPLES,
          ...GROUP_9_LOCATION,
          ...GROUP_9_REGULATION,
          ...GROUP_9_NORMAL,
        ];
        // 60 samples: 20 Group 7 + 10 + 10 + 10 Group 9
        const FIELD_CLASSES = [
          'question',
          'observation_text',
          'observation_location',
          'observation_regulation',
        ];

        test('no sample trips any of the 4 new bare markers under any of the 4 field classes', () => {
          const falsePositives = [];
          for (const field of FIELD_CLASSES) {
            for (const sample of ALL_SAMPLES) {
              const result = checkForPromptLeak(sample, { field });
              if (!result.safe) {
                const reason = result.reason || '';
                if (
                  reason === 'marker:user-text-bare' ||
                  reason === 'marker:end-user-text-bare' ||
                  reason === 'marker:left-angle-triple' ||
                  reason === 'marker:right-angle-triple'
                ) {
                  falsePositives.push({ field, sample, reason });
                }
              }
            }
          }
          expect(falsePositives).toEqual([]);
        });
      });
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
  // Group 9 — r21-#1 field-class granularity for observation sub-fields
  // ------------------------------------------------------------------
  //
  // WHY: r21 re-review of my r20-#1 fix found that `location` and
  // `suggested_regulation` were correctly ADDED to the scan list in
  // `dispatchRecordObservation`, but BOTH were classified as
  // `field: 'observation_text'`, inheriting the loose 1000-char length
  // ceiling. Real-world values:
  //   - `location`: ~30 chars ("Kitchen sockets consumer unit")
  //   - `suggested_regulation`: ~20 chars ("Regulation 522.6.201")
  // A 150-char benign paraphrase of the system prompt in either
  // field passes every existing detector (no markers, no entropy, no
  // low-alpha, under 1000c) yet is genuinely anomalous for these
  // fields. Introducing `observation_location` (120c + alpha guard)
  // + `observation_regulation` (60c, no alpha guard because real
  // refs are numeric-heavy) closes the bypass.
  describe('Group 9 — r21-#1 observation_location + observation_regulation field classes', () => {
    // --------- observation_location (120c ceiling) ---------
    test('observation_location: 150-char benign paraphrase → flagged on length ceiling', () => {
      // Pure alpha + spaces so no markers, no entropy, no low-alpha
      // detectors fire. Only the 120-char length ceiling should
      // catch this for `observation_location`.
      const text =
        'This is a legitimate looking short narrative describing ' +
        'some position in the consumer unit but it is a bit too long ' +
        'for a location label and should be flagged.';
      expect(text.length).toBeGreaterThan(120);
      expect(text.length).toBeLessThan(200);
      const result = checkForPromptLeak(text, { field: 'observation_location' });
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/^length-suspicious:/);
    });

    test('observation_location: 30-char real location "Kitchen sockets consumer unit" → safe', () => {
      const text = 'Kitchen sockets consumer unit';
      expect(text.length).toBe(29);
      const result = checkForPromptLeak(text, { field: 'observation_location' });
      expect(result.safe).toBe(true);
    });

    test('observation_location: 60-char real location (edge case) → safe', () => {
      const text = 'Bathroom shaver socket and lighting circuit junction box TB';
      expect(text.length).toBeGreaterThan(50);
      expect(text.length).toBeLessThan(120);
      const result = checkForPromptLeak(text, { field: 'observation_location' });
      expect(result.safe).toBe(true);
    });

    test('observation_location same 150-char text under observation_text class → safe (1000c ceiling)', () => {
      // Same text that trips the 120c observation_location ceiling
      // should pass under observation_text (1000c). Proves the
      // split field-class contract.
      const text =
        'This is a legitimate looking short narrative describing ' +
        'some position in the consumer unit but it is a bit too long ' +
        'for a location label and should be flagged.';
      const result = checkForPromptLeak(text, { field: 'observation_text' });
      expect(result.safe).toBe(true);
    });

    // --------- observation_location low-alpha backstop ---------
    test('observation_location: 50 chars with <60% alpha → flagged low-alpha', () => {
      // Use non-base64 punctuation so entropy can't pre-empt.
      // 20 alpha + 30 dots/dashes = 50 chars, 40% alpha.
      const text = 'abcdefghijklmnopqrst' + '.'.repeat(30);
      const bounded = text.slice(0, 50);
      expect(bounded.length).toBe(50);
      const alphaCount = (bounded.match(/[a-zA-Z]/g) || []).length;
      expect(alphaCount / bounded.length).toBeLessThan(0.6);
      const result = checkForPromptLeak(bounded, { field: 'observation_location' });
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/^low-alpha-ratio:/);
    });

    test('observation_location: 30 chars with 80% alpha → safe', () => {
      const text = 'Hallway board position 2';
      const result = checkForPromptLeak(text, { field: 'observation_location' });
      expect(result.safe).toBe(true);
    });

    // --------- observation_regulation (60c ceiling) ---------
    test('observation_regulation: 150-char benign paraphrase → flagged length', () => {
      const text =
        'This is a really long regulation citation that would ' +
        'describe some BS 7671 section in great detail and should be ' +
        'rejected for exceeding the ceiling.';
      expect(text.length).toBeGreaterThan(60);
      const result = checkForPromptLeak(text, { field: 'observation_regulation' });
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/^length-suspicious:/);
    });

    test('observation_regulation: 20-char real reg "Regulation 522.6.201" → safe', () => {
      const text = 'Regulation 522.6.201';
      expect(text.length).toBe(20);
      const result = checkForPromptLeak(text, { field: 'observation_regulation' });
      expect(result.safe).toBe(true);
    });

    test('observation_regulation: 18-char real reg "BS 7671 643.3.2" → safe', () => {
      const text = 'BS 7671 643.3.2';
      expect(text.length).toBe(15);
      const result = checkForPromptLeak(text, { field: 'observation_regulation' });
      expect(result.safe).toBe(true);
    });

    test('observation_regulation: 55-char edge case just under 60c → r22-#1 rejects narrative form', () => {
      // Plan 04-29 r22-#1 TIGHTENING: this string carries a
      // narrative suffix "shock-risk installation" which is a
      // DESCRIPTION of the breach, not a pure reference. Under
      // r21, the 60c ceiling was the only gate and the string
      // passed. Under r22's positive shape allowlist, this
      // doesn't match any REGULATION_SHAPE_PATTERNS entry (all
      // entries are anchored `^...$` to pure refs) and now
      // surfaces as `non-regulation-shape`. The narrative text
      // belongs in `observation_text`; `suggested_regulation`
      // carries the bare reference only.
      const text = 'BS 7671 regulation 522.6.201 shock-risk installation';
      expect(text.length).toBeGreaterThan(50);
      expect(text.length).toBeLessThan(60);
      const result = checkForPromptLeak(text, { field: 'observation_regulation' });
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/^non-regulation-shape/);
    });

    test('observation_regulation: NO low-alpha guard — numeric-heavy refs pass', () => {
      // Real regulation refs are numeric-heavy: "522.6.201" is 22%
      // alpha over its raw length. A legitimate rich ref like
      // "BS 7671 522.6.201" is ~50% alpha but applying the
      // observation_location 0.6 bar would destroy real content.
      // Plan 04-29 r22-#1 TIGHTENING: the reference MUST also be
      // shape-matching — a bare "BS 7671 522.6.201" (canonical
      // form) is accepted by pattern 6 of REGULATION_SHAPE_PATTERNS.
      // The original r21 test used "7671 522.6.201" (missing "BS "
      // prefix) which was a tolerated ambiguous form; r22 tightens
      // to the canonical shape.
      const text = 'BS 7671 522.6.201';
      expect(text.length).toBeLessThan(60);
      // This form now sits at ~41% alpha (5 alphas / 17 chars) —
      // still under the 0.6 bar but we don't apply the low-alpha
      // guard to observation_regulation anyway.
      const result = checkForPromptLeak(text, { field: 'observation_regulation' });
      expect(result.safe).toBe(true);
    });

    // --------- 60-sample corpus regression across new field classes ---------
    describe('Group 9 — FP guard on new field classes (60-sample composite corpus)', () => {
      const SAMPLES_LOCATION = [
        'Kitchen sockets consumer unit',
        'Bathroom shaver socket',
        'Under stairs cupboard',
        'Garage sub-main distribution board',
        'Main CU by front door',
        'First floor landing ring',
        'Upstairs bedroom lighting board',
        'Hallway consumer unit position 3',
        'Outside meter tails',
        'Loft immersion isolator',
      ];
      const SAMPLES_REGULATION = [
        'Regulation 522.6.201',
        'BS 7671 643.3.2',
        '411.3.1.1',
        'Regulation 411.3.3',
        'BS 7671 Part 6',
        '701.415.2',
        '544.1.1',
        '722.533',
        'BS 7671 Section 706',
        'Regulation 132.15',
      ];

      test.each(SAMPLES_LOCATION.map((s, i) => [i + 1, s]))(
        'location sample #%i safe in observation_location class: %s',
        (_i, sample) => {
          const result = checkForPromptLeak(sample, { field: 'observation_location' });
          expect(result.safe).toBe(true);
        }
      );

      test.each(SAMPLES_REGULATION.map((s, i) => [i + 1, s]))(
        'regulation sample #%i safe in observation_regulation class: %s',
        (_i, sample) => {
          const result = checkForPromptLeak(sample, { field: 'observation_regulation' });
          expect(result.safe).toBe(true);
        }
      );

      // Cross-class: the 40 existing corpus samples (20 from 04-26
      // + 20 from r20-#3) should still be safe on the NEW classes
      // too — except that real observation narratives legitimately
      // exceed 120c (for location) / 60c (for regulation), so we
      // scope this regression to location/regulation only on
      // realistic location/regulation inputs (the 20 above).
    });
  });

  // ------------------------------------------------------------------
  // Group 10 — r21-#2 entropy detector iterates ALL regex matches
  // ------------------------------------------------------------------
  //
  // WHY: r21 re-review of r20-#3 found that `hasHighEntropyChunk()`
  // used `text.match(pattern)` which returns only the FIRST match.
  // Attacker can prepend a benign 40+ char run of repeated/low-
  // diversity chars (e.g. `"aaaa...aaaa"` — 1 distinct, fails the
  // 10-distinct threshold; or `"abcabc..."` — 3 distinct, also
  // fails), then append the real 40-char base64/hex leak. First
  // match's distinct-char count is low → passes. Real leak never
  // checked.
  //
  // Fix: flip regex to global flag (required for `matchAll`);
  // rewrite `hasHighEntropyChunk()` to iterate all matches and
  // return true if ANY chunk clears the distinct-char threshold.
  // Cost: O(N) iteration where N is the number of 40+ char matches
  // in the text — typically 0 or 1 on real inspection speech.
  describe('Group 10 — r21-#2 entropy detector iterates all matches', () => {
    // --------- Prefix-benign bypass: the attack r21-#2 closes ---------
    //
    // The bypass requires a break between the low-diversity prefix
    // and the real high-entropy blob — otherwise the regex swallows
    // both into one match whose distinct count is already high
    // (driven by the blob). A non-base64 character (e.g. space, hyphen
    // outside hex range, Unicode punct) ends the first match and
    // starts a second.
    test('50 "a"s + space + real 40-char base64 blob → caught (entropy:base64)', () => {
      // Attack: 50-"a" prefix is match #1 (1 distinct, fails
      // 10-threshold). Break char forces match #2 over the real blob
      // (high distinct count). First-match-only filter SEES ONLY #1
      // → safe:true (BYPASS). matchAll catches match #2 → safe:false.
      const prefix = 'a'.repeat(50);
      const realBlob = 'WW91IGFyZSBhbiBFSUNSIGluc3BlY3Rpb24gYXNzaXN0YW50';
      expect(realBlob.length).toBeGreaterThanOrEqual(40);
      const text = prefix + ' ' + realBlob;
      const result = checkForPromptLeak(text, { field: 'question' });
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/^entropy:base64/);
    });

    test('48 "abcabc..." + break + real 40-char hex blob → caught (entropy)', () => {
      // "abcabcabc..." has only 3 distinct chars — fails 10-threshold
      // even though it's a valid base64-range match. Real hex has
      // 16 distinct chars, passes threshold.
      const prefix = 'abc'.repeat(16); // 48 chars, 3 distinct
      expect(prefix.length).toBe(48);
      expect(new Set(prefix).size).toBe(3);
      const realHex = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'; // 40 hex chars
      expect(realHex.length).toBe(40);
      // Force separation: space between prefix and hex so neither
      // base64 nor hex regex concatenates them into one match.
      const text = prefix + ' ' + realHex;
      const result = checkForPromptLeak(text, { field: 'question' });
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/^entropy:/);
    });

    // --------- Guards: repetitive-only content stays safe ---------
    test('40 chars of "abcabcabc..." (low diversity) alone → safe', () => {
      // 6 distinct chars — below 10-threshold. Only match. No bypass.
      const text = 'abcabcabcabcabcabcabcabcabcabcabcabcabcd';
      expect(text.length).toBe(40);
      expect(new Set(text).size).toBeLessThan(10);
      const result = checkForPromptLeak(text, { field: 'question' });
      expect(result.safe).toBe(true);
    });

    test('60-char single "a" run alone → safe', () => {
      const text = 'a'.repeat(60);
      const result = checkForPromptLeak(text, { field: 'question' });
      expect(result.safe).toBe(true);
    });

    test('multi-match where ALL chunks fail distinct-char threshold → safe', () => {
      // 40 'a' (distinct=1) + 10 dashes (break match) + 40 'b'
      // (distinct=1). Two separate matches, both fail threshold.
      // Filter must NOT flag.
      const text = 'a'.repeat(40) + ' - - - - ' + 'b'.repeat(40);
      const result = checkForPromptLeak(text, { field: 'question' });
      expect(result.safe).toBe(true);
    });

    // --------- Regression: 40-sample FP corpus across new detector ---------
    describe('Group 10 — 40-sample FP corpus unaffected by multi-match entropy', () => {
      const SAMPLES_ALL = [
        // 04-26 Group 7 corpus
        'Zs on circuit three is nought point three five.',
        'Circuit two, insulation greater than two hundred both ways, polarity correct.',
        'Consumer unit in the hallway, RCBO type B, 32 amp.',
        'For example, 1 hour delay before the RCD tripped.',
        'Observation: missing earthing on the immersion heater.',
        'The trusted bounds of the installation include a sub-board in the garage.',
        'Code this as C2 — absent main bonding to gas.',
        'Add a C3 observation for the non-standard cable colour.',
        'R1 plus R2 is zero point five one ohms on circuit four.',
        'The meter reads less than 0.5 ohm.',
        // r20-#3 Group 8 corpus (sample of 10 — 10 more already
        // covered by Group 8 regression tests themselves).
        'Circuit 3 Zs is 0.35 ohms measured at the distribution board.',
        'RCD type AC 30mA trip time 23ms compliant with BS 7671 411.3.3.',
        'MCB 32A type C on Upstairs sockets ring circuit 2.5mm2 T+E.',
        'Cable reference colours — brown, black, grey and blue on L1/L2/L3/N.',
        'Insulation resistance > 999 MΩ between L and E at 500V test voltage.',
        'R1 + R2 measured 0.51, ring final so divide by 4 gives 0.128.',
        'Main earth conductor verified at 16mm2 minimum per 544.1.1.',
        'Consumer unit Wylex NHRS 17 with 100A isolator and 8 ways.',
        'Observation: loose neutral in back box, C1, immediate action.',
        'Reference id a1b2c3 noted on the certificate template.',
      ];

      test.each(SAMPLES_ALL.map((s, i) => [i + 1, s]))(
        'FP sample #%i stays safe under multi-match entropy: %s',
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
  // Group 11 — r22-#1 positive regulation-shape allowlist
  // ------------------------------------------------------------------
  //
  // WHY: r22 re-review of my r21-#1 fix found that the
  // observation_regulation field class added a 60-char length
  // ceiling but NO positive shape validation. Real regulation
  // references are narrowly shaped — "Regulation 522.6.201",
  // "BS 7671 Table 41.1", "BS EN 61008-1", bare numerics like
  // "411.3.3". A 50-char English paraphrase like "The system says
  // sockets must be GFCI protected" is under 60 chars, hits no
  // markers, no entropy, no low-alpha guard (deliberately off for
  // numeric-heavy regulation refs) — filter currently lets it
  // through as safe:true.
  //
  // Fix: REGULATION_SHAPE_PATTERNS allowlist; observation_regulation
  // values that don't match at least one shape are rejected with
  // reason 'non-regulation-shape'. Must fire AFTER the existing
  // detector chain so that marker/phrase/entropy/length reasons
  // still take precedence for sharper telemetry.
  //
  // Critical FP guard: the 20 real regulation refs below MUST all
  // accept. If any legitimate reference fails the shape check, we
  // LOOSEN the pattern — never reject real inspection content.
  describe('Group 11 — r22-#1 observation_regulation shape allowlist', () => {
    // --------- Accept: 20+ real regulation references ---------
    const ACCEPT_SAMPLES = [
      // "Regulation <numeric>" forms
      'Regulation 522.6.201',
      'Regulation 411.3.3',
      'Regulation 132.15',
      'Reg 411.3.3',
      // Bare BS series
      'BS 7671',
      'BS 3871',
      'BS 88-2',
      // "BS <num> <numeric>"
      'BS 7671 643.3.2',
      'BS 7671 411.3.3',
      // "BS <num> <modifier> <section>"
      'BS 7671 Table 41.1',
      'BS 7671 Table 54.7',
      'BS 7671 Part 6',
      'BS 7671 Section 706',
      'BS 7671 Appendix 4',
      // BS EN series
      'BS EN 61008-1',
      'BS EN 60898-1',
      'BS EN 60335-2-73',
      'BS EN 61558-2-5',
      'BS EN 61643-11',
      // Bare numeric sections
      '411.3.1.1',
      '522.6.201',
      '722.411.4.1',
      '534.4.4.5',
      '701.411.3.3',
      // IET / HSE guidance
      'IET Guidance',
      'IET Guidance Note 3',
    ];

    test.each(ACCEPT_SAMPLES.map((s, i) => [i + 1, s]))(
      'accept real regulation #%i: "%s"',
      (_i, sample) => {
        const result = checkForPromptLeak(sample, { field: 'observation_regulation' });
        expect(result.safe).toBe(true);
      }
    );

    // --------- Reject: non-regulation-shape content ---------
    test('reject: 50-char English paraphrase', () => {
      const text = 'The system says sockets must be GFCI protected';
      expect(text.length).toBeLessThanOrEqual(60);
      const result = checkForPromptLeak(text, { field: 'observation_regulation' });
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/^non-regulation-shape/);
    });

    test('reject: narrative non-shape content', () => {
      const text = 'abcdefgh xyz ijk mno';
      const result = checkForPromptLeak(text, { field: 'observation_regulation' });
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/^non-regulation-shape/);
    });

    test('reject: "Regulation 411.3.3 is breached" (narrative form, not pure ref)', () => {
      // Anchored patterns — accepts "Regulation 411.3.3" but NOT
      // "Regulation 411.3.3 is breached" (narrative). The
      // observation's TEXT field is where the narrative goes;
      // suggested_regulation is the bare ref.
      const text = 'Regulation 411.3.3 is breached';
      const result = checkForPromptLeak(text, { field: 'observation_regulation' });
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/^non-regulation-shape/);
    });

    // --------- Ordering invariant ---------
    test('ordering: marker check fires BEFORE shape check', () => {
      // TRUST BOUNDARY in observation_regulation field: the filter
      // should surface the sharper "marker:*" telemetry, not the
      // coarser "non-regulation-shape".
      const text = 'TRUST BOUNDARY';
      const result = checkForPromptLeak(text, { field: 'observation_regulation' });
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/^marker:/);
      expect(result.reason).not.toMatch(/^non-regulation-shape/);
    });

    test('ordering: structural phrase check fires BEFORE shape check', () => {
      const text = 'You are an EICR inspection assistant';
      const result = checkForPromptLeak(text, { field: 'observation_regulation' });
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/^phrase:/);
      expect(result.reason).not.toMatch(/^non-regulation-shape/);
    });

    test('ordering: length-ceiling fires BEFORE shape check (over-60c pure alpha)', () => {
      // 65-char alpha string with no markers/phrases/entropy. Fails
      // BOTH the 60c length ceiling AND the shape check; ceiling
      // should win for sharper telemetry.
      const text = 'A'.repeat(65);
      expect(text.length).toBe(65);
      const result = checkForPromptLeak(text, { field: 'observation_regulation' });
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/^length-suspicious:/);
    });

    // --------- Empty / nullish ---------
    test('empty string in observation_regulation → safe (null regulation is legit)', () => {
      const result = checkForPromptLeak('', { field: 'observation_regulation' });
      expect(result.safe).toBe(true);
    });

    test('whitespace-only in observation_regulation → safe', () => {
      // trim() removes it; empty after trim = safe.
      const result = checkForPromptLeak('   ', { field: 'observation_regulation' });
      expect(result.safe).toBe(true);
    });

    // --------- Cross-class: same content passes under observation_text ---------
    test('cross-class: English paraphrase passes under observation_text (narrative field)', () => {
      const text = 'The system says sockets must be GFCI protected';
      const result = checkForPromptLeak(text, { field: 'observation_text' });
      expect(result.safe).toBe(true);
    });

    // --------- Group 9 corpus regression ---------
    describe('Group 11 — Group 9 regulation corpus passes under new shape gate', () => {
      const SAMPLES_REGULATION_FROM_GROUP_9 = [
        'Regulation 522.6.201',
        'BS 7671 643.3.2',
        '411.3.1.1',
        'Regulation 411.3.3',
        'BS 7671 Part 6',
        '701.415.2',
        '544.1.1',
        '722.533',
        'BS 7671 Section 706',
        'Regulation 132.15',
      ];

      test.each(SAMPLES_REGULATION_FROM_GROUP_9.map((s, i) => [i + 1, s]))(
        'Group 9 regulation corpus #%i safe under shape gate: "%s"',
        (_i, sample) => {
          const result = checkForPromptLeak(sample, { field: 'observation_regulation' });
          expect(result.safe).toBe(true);
        }
      );
    });
  });

  // ------------------------------------------------------------------
  // Group 12 — r23-#1 composite regulation references
  // ------------------------------------------------------------------
  //
  // WHY: r23 re-review found that my r22-#1 REGULATION_SHAPE_PATTERNS
  // allowlist is anchored `^...$` on each pattern. Real electricians
  // routinely dictate composite references — a single
  // suggested_regulation value that cites multiple regulations
  // joined by a separator:
  //   - "411.3.3 / 522.6.201"              (slash-separated)
  //   - "BS 7671 411.3.3, Table 41.1"      (comma-separated, reg+table)
  //   - "Regulation 522.6.201 and 411.3.3" (" and " conjunction, spoken)
  //   - "BS 7671; 411.3.3"                 (semicolon-separated)
  // Each token is individually valid under an existing pattern, but
  // the composite string fails every anchored pattern and gets
  // rejected as `non-regulation-shape`. Legitimate inspection data
  // blocked.
  //
  // Fix: composite-splitter recognises separators (/, comma,
  // semicolon, " and "), splits the trimmed value, and accepts iff
  // every non-empty token matches REGULATION_SHAPE_PATTERNS. Empty
  // tokens (leading/trailing/doubled separators) are skipped — they
  // are dictation artefacts, not failed references. A 10th bare-
  // modifier pattern ("Table 41.1", "Part 6", "Appendix 4" without
  // the BS prefix) is added to REGULATION_SHAPE_PATTERNS so
  // composites like "BS 7671 411.3.3, Table 41.1" parse cleanly.
  //
  // Critical FP guard: 8 composite forms MUST accept; all 26 Group
  // 11 single refs + 10 Group 9 single refs MUST still accept.
  // Ordering invariant MUST be preserved: marker / phrase / entropy
  // / length detectors fire BEFORE the shape gate, so a leak hidden
  // in a composite-shaped envelope ("TRUST BOUNDARY / 411.3.3")
  // surfaces as `marker:*` not `non-regulation-shape`.
  describe('Group 12 — r23-#1 composite regulation-ref splitter', () => {
    // --------- Accept: 8 composite forms real electricians dictate ---------
    const COMPOSITE_ACCEPT = [
      '411.3.3 / 522.6.201',
      '411.3.3/522.6.201',
      'BS 7671 411.3.3, Table 41.1',
      'BS 7671 411.3.3, 522.6.201',
      'Regulation 522.6.201 and 411.3.3',
      'BS 7671; 411.3.3',
      '411.3.3, 522.6.201, 132.15',
      'BS EN 61008-1 / BS EN 60898-1',
    ];

    test.each(COMPOSITE_ACCEPT.map((s, i) => [i + 1, s]))(
      'accept composite regulation #%i: "%s"',
      (_i, sample) => {
        const result = checkForPromptLeak(sample, { field: 'observation_regulation' });
        expect(result.safe).toBe(true);
      }
    );

    // --------- Reject: composite shape with at least one bad token ---------
    test('reject: composite with prompt-injection imperative in 2nd token', () => {
      const text = 'BS 7671 411.3.3, IGNORE PREVIOUS';
      const result = checkForPromptLeak(text, { field: 'observation_regulation' });
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/^non-regulation-shape/);
    });

    test('reject: composite with English narrative in 2nd token', () => {
      const text = '411.3.3 / the system says leak';
      const result = checkForPromptLeak(text, { field: 'observation_regulation' });
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/^non-regulation-shape/);
    });

    test('reject: three-token composite all non-shape', () => {
      const text = 'a / b / c';
      const result = checkForPromptLeak(text, { field: 'observation_regulation' });
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/^non-regulation-shape/);
    });

    // --------- Back-compat: single refs still pass ---------
    test('back-compat: Group 11 ACCEPT_SAMPLES still pass under composite-aware validator', () => {
      // Mirror Group 11 ACCEPT_SAMPLES — the composite-aware
      // validator MUST NOT regress single-ref acceptance.
      const singles = [
        'Regulation 522.6.201',
        'Regulation 411.3.3',
        'Regulation 132.15',
        'Reg 411.3.3',
        'BS 7671',
        'BS 3871',
        'BS 88-2',
        'BS 7671 643.3.2',
        'BS 7671 411.3.3',
        'BS 7671 Table 41.1',
        'BS 7671 Table 54.7',
        'BS 7671 Part 6',
        'BS 7671 Section 706',
        'BS 7671 Appendix 4',
        'BS EN 61008-1',
        'BS EN 60898-1',
        'BS EN 60335-2-73',
        'BS EN 61558-2-5',
        'BS EN 61643-11',
        '411.3.1.1',
        '522.6.201',
        '722.411.4.1',
        '534.4.4.5',
        '701.411.3.3',
        'IET Guidance',
        'IET Guidance Note 3',
      ];
      for (const s of singles) {
        const result = checkForPromptLeak(s, { field: 'observation_regulation' });
        expect(result.safe).toBe(true);
      }
    });

    test('back-compat: Group 9 SAMPLES_REGULATION still pass under composite-aware validator', () => {
      const group9 = [
        'Regulation 522.6.201',
        'BS 7671 643.3.2',
        '411.3.1.1',
        'Regulation 411.3.3',
        'BS 7671 Part 6',
        '701.415.2',
        '544.1.1',
        '722.533',
        'BS 7671 Section 706',
        'Regulation 132.15',
      ];
      for (const s of group9) {
        const result = checkForPromptLeak(s, { field: 'observation_regulation' });
        expect(result.safe).toBe(true);
      }
    });

    // --------- Ordering invariant ---------
    test('ordering: marker check fires BEFORE composite shape check', () => {
      // TRUST BOUNDARY embedded in an otherwise-composite-shaped
      // envelope — filter must return `marker:*` (sharper telemetry),
      // not `non-regulation-shape`.
      const text = 'TRUST BOUNDARY / 411.3.3';
      const result = checkForPromptLeak(text, { field: 'observation_regulation' });
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/^marker:/);
      expect(result.reason).not.toMatch(/^non-regulation-shape/);
    });

    test('ordering: requirement-ID check fires BEFORE composite shape check', () => {
      const text = 'STQ-01 / 411.3.3';
      const result = checkForPromptLeak(text, { field: 'observation_regulation' });
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/^req-id:/);
      expect(result.reason).not.toMatch(/^non-regulation-shape/);
    });

    // --------- Empty-token handling ---------
    test('empty tokens from trailing separator are skipped (not failed)', () => {
      const text = '411.3.3, ';
      const result = checkForPromptLeak(text, { field: 'observation_regulation' });
      expect(result.safe).toBe(true);
    });

    test('empty tokens from leading separator are skipped (not failed)', () => {
      const text = ', 411.3.3';
      const result = checkForPromptLeak(text, { field: 'observation_regulation' });
      expect(result.safe).toBe(true);
    });

    test('empty tokens from doubled separator are skipped (not failed)', () => {
      const text = '411.3.3,,522.6.201';
      const result = checkForPromptLeak(text, { field: 'observation_regulation' });
      expect(result.safe).toBe(true);
    });

    test('pure-separator string rejects (no non-empty tokens)', () => {
      const text = ', , ,';
      const result = checkForPromptLeak(text, { field: 'observation_regulation' });
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/^non-regulation-shape/);
    });

    // --------- "and" word boundary ---------
    test('word "understand" (contains "and" substring) does NOT split a single ref', () => {
      // The " and " separator must be whitespace-bounded so "and"
      // inside a word doesn't split. "understand" is not a real reg
      // but this test proves the splitter regex doesn't false-split.
      const text = 'understand';
      // The string doesn't match any pattern AND doesn't contain a
      // real separator, so it rejects as non-regulation-shape (which
      // is correct — "understand" is not a reg ref). The point here
      // is that it doesn't accidentally split into ["underst", "d"]
      // and pretend to be a composite; the telemetry reason should
      // be non-regulation-shape, not a spurious composite accept.
      const result = checkForPromptLeak(text, { field: 'observation_regulation' });
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/^non-regulation-shape/);
    });
  });

  // ------------------------------------------------------------------
  // Group 13 — r24-#1 composite context scoping for bare modifier-section
  // ------------------------------------------------------------------
  //
  // WHY: r24 re-review found that my r23-#1 10th
  // REGULATION_SHAPE_PATTERNS entry (bare modifier-section:
  // "Table 41.1", "Appendix 4", "Part 6", "Section 706",
  // "Annex A") was added to cover the NON-FIRST token of
  // composites like "BS 7671 411.3.3, Table 41.1". But the
  // pattern is also live on the single-ref fast path, so
  // standalone "Table 41.1" / "Appendix 4" / "Part 6" now
  // passes as a regulation reference. In isolation the value
  // is not meaningful — "Table 41.1 of WHICH standard?"
  //
  // Fix: split REGULATION_SHAPE_PATTERNS into
  //   FULLY_QUALIFIED_PATTERNS (9 — each standalone-valid;
  //     establishes a standard), and
  //   BARE_MODIFIER_PATTERNS (r23-#1 10th — only valid as a
  //     non-first token in a composite, scoped to the
  //     preceding fully-qualified token's standard).
  // Single-ref (non-composite) validation uses only
  // FULLY_QUALIFIED. Composite validation requires
  // first-non-empty-token be fully-qualified; subsequent
  // tokens may be either fully-qualified or bare-modifier.
  //
  // Ordering invariant preserved: marker / phrase / entropy /
  // length detectors still fire BEFORE the shape gate, so a
  // leak hidden in a composite-shaped envelope ("TRUST
  // BOUNDARY / Table 41.1") surfaces as `marker:*` not
  // `non-regulation-shape`.
  describe('Group 13 — r24-#1 composite context scoping for bare modifier-section', () => {
    // --------- Reject: standalone bare-modifier (NOT fully qualified) ---------
    test.each([['Table 41.1'], ['Appendix 4'], ['Part 6'], ['Section 706'], ['Annex A']])(
      'reject standalone bare-modifier "%s" (no standard established)',
      (sample) => {
        const result = checkForPromptLeak(sample, { field: 'observation_regulation' });
        expect(result.safe).toBe(false);
        expect(result.reason).toMatch(/^non-regulation-shape/);
      }
    );

    // --------- Accept: composite with bare-modifier as NON-FIRST token ---------
    test.each([
      ['BS 7671 411.3.3, Table 41.1'],
      ['BS 7671, Table 41.1'],
      ['BS 7671 411.3.3, Appendix 4'],
      ['Regulation 522.6.201, Table 41.1'],
    ])('accept composite with bare-modifier non-first: "%s"', (sample) => {
      const result = checkForPromptLeak(sample, { field: 'observation_regulation' });
      expect(result.safe).toBe(true);
    });

    // --------- Reject: composite with bare-modifier as FIRST token ---------
    test.each([
      ['Table 41.1, BS 7671 411.3.3'],
      ['Part 6, BS 7671 411.3.3'],
      ['Appendix 4 / 411.3.3'],
    ])('reject composite with bare-modifier first: "%s"', (sample) => {
      const result = checkForPromptLeak(sample, { field: 'observation_regulation' });
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/^non-regulation-shape/);
    });

    // --------- Accept: bare-numeric-first (fully qualified by convention) ---------
    test('accept bare-numeric-first composite: "411.3.3, Table 41.1"', () => {
      // Bare numeric "411.3.3" matches pattern 1 (FULLY_QUALIFIED)
      // — it establishes a standard by UK electrical convention
      // (BS 7671 is the implicit standard for bare numeric refs).
      const text = '411.3.3, Table 41.1';
      const result = checkForPromptLeak(text, { field: 'observation_regulation' });
      expect(result.safe).toBe(true);
    });

    // --------- Back-compat: Group 12 composite accepts still pass ---------
    test('back-compat: all 8 Group 12 composite accepts still pass', () => {
      const group12 = [
        '411.3.3 / 522.6.201',
        '411.3.3/522.6.201',
        'BS 7671 411.3.3, Table 41.1',
        'BS 7671 411.3.3, 522.6.201',
        'Regulation 522.6.201 and 411.3.3',
        'BS 7671; 411.3.3',
        '411.3.3, 522.6.201, 132.15',
        'BS EN 61008-1 / BS EN 60898-1',
      ];
      for (const s of group12) {
        const result = checkForPromptLeak(s, { field: 'observation_regulation' });
        expect(result.safe).toBe(true);
      }
    });

    // --------- Back-compat: Group 11 + Group 9 single refs still pass ---------
    test('back-compat: 26 Group 11 ACCEPT_SAMPLES still pass as single refs', () => {
      const singles = [
        'Regulation 522.6.201',
        'Regulation 411.3.3',
        'Regulation 132.15',
        'Reg 411.3.3',
        'BS 7671',
        'BS 3871',
        'BS 88-2',
        'BS 7671 643.3.2',
        'BS 7671 411.3.3',
        'BS 7671 Table 41.1',
        'BS 7671 Table 54.7',
        'BS 7671 Part 6',
        'BS 7671 Section 706',
        'BS 7671 Appendix 4',
        'BS EN 61008-1',
        'BS EN 60898-1',
        'BS EN 60335-2-73',
        'BS EN 61558-2-5',
        'BS EN 61643-11',
        '411.3.1.1',
        '522.6.201',
        '722.411.4.1',
        '534.4.4.5',
        '701.411.3.3',
        'IET Guidance',
        'IET Guidance Note 3',
      ];
      for (const s of singles) {
        const result = checkForPromptLeak(s, { field: 'observation_regulation' });
        expect(result.safe).toBe(true);
      }
    });

    test('back-compat: 10 Group 9 SAMPLES_REGULATION still pass as single refs', () => {
      const group9 = [
        'Regulation 522.6.201',
        'BS 7671 643.3.2',
        '411.3.1.1',
        'Regulation 411.3.3',
        'BS 7671 Part 6',
        '701.415.2',
        '544.1.1',
        '722.533',
        'BS 7671 Section 706',
        'Regulation 132.15',
      ];
      for (const s of group9) {
        const result = checkForPromptLeak(s, { field: 'observation_regulation' });
        expect(result.safe).toBe(true);
      }
    });

    // --------- Ordering invariant ---------
    test('ordering: marker check fires BEFORE shape check (composite with bare modifier)', () => {
      const text = 'TRUST BOUNDARY / Table 41.1';
      const result = checkForPromptLeak(text, { field: 'observation_regulation' });
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/^marker:/);
      expect(result.reason).not.toMatch(/^non-regulation-shape/);
    });

    test('ordering: requirement-ID check fires BEFORE shape check (composite with bare modifier)', () => {
      const text = 'STQ-01, Table 41.1';
      const result = checkForPromptLeak(text, { field: 'observation_regulation' });
      expect(result.safe).toBe(false);
      expect(result.reason).toMatch(/^req-id:/);
      expect(result.reason).not.toMatch(/^non-regulation-shape/);
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
