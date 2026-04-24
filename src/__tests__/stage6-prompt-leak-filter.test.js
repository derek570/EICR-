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
