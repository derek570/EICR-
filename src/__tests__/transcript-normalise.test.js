/**
 * Unit tests for the backend dictation-transcript normaliser (P6).
 *
 * Covers both v1 rules + their boundary/negative cases + idempotency. There is
 * NO unit-garble rule (dropped in refine round 3 as speculative — units are
 * already aliased by parseBareMegaohmsWithUnit).
 */

import { describe, test, expect } from '@jest/globals';
import { normalise, NORMALISE_RULE_IDS } from '../extraction/transcript-normalise.js';

describe('transcript-normalise — rule 1: context-gated "Z s" → "Zs"', () => {
  test('collapses the observed reading-shaped clause (id 89)', () => {
    const r = normalise('Z s on the heating was 0.67');
    expect(r.text).toBe('Zs on the heating was 0.67');
    expect(r.rules_hit).toEqual([NORMALISE_RULE_IDS.ZS_FIELD_TOKEN]);
  });

  test('collapses "Zed s" spelled form in a reading clause', () => {
    expect(normalise('Zed s for the cooker is 0.4').text).toBe('Zs for the cooker is 0.4');
    expect(normalise('zed s reads 1.2').text).toBe('Zs reads 1.2');
  });

  test('collapses with a sentinel value (not just a number)', () => {
    expect(normalise('Z s on the shower was LIM').text).toBe('Zs on the shower was LIM');
  });

  test('lower/upper/mixed casing of the token all collapse', () => {
    expect(normalise('z s on the lights was 0.3').text).toBe('Zs on the lights was 0.3');
    expect(normalise('Z S on the lights was 0.3').text).toBe('Zs on the lights was 0.3');
    expect(normalise('z S on the lights was 0.3').text).toBe('Zs on the lights was 0.3');
  });

  test('already-canonical "Zs" is left untouched (no space to re-trigger)', () => {
    const r = normalise('Zs on the heating was 0.67');
    expect(r.text).toBe('Zs on the heating was 0.67');
    expect(r.rules_hit).toEqual([]);
  });

  // ── Negative cases — genuine two-letter dictation MUST NOT collapse ──
  test('customer name "Z S Electrical" is NOT collapsed (no connector+value)', () => {
    const r = normalise('customer name Z S Electrical');
    expect(r.text).toBe('customer name Z S Electrical');
    expect(r.rules_hit).toEqual([]);
  });

  test('designation "Z S 1" is NOT collapsed (adjacent value, no connector)', () => {
    const r = normalise('designation Z S 1');
    expect(r.text).toBe('designation Z S 1');
    expect(r.rules_hit).toEqual([]);
  });

  test('designation with a preceding "is" is still NOT collapsed (connector before, not after)', () => {
    // "is" sits BEFORE the token; the rule requires a connector AFTER the token.
    expect(normalise('the designation is Z S 1').text).toBe('the designation is Z S 1');
  });

  test('spelled postcode text is NOT collapsed', () => {
    // No "z s" token followed by connector+value.
    expect(normalise('postcode S W 1 A one A A').text).toBe('postcode S W 1 A one A A');
  });

  test('does not bridge across a sentence boundary', () => {
    // Token in clause 1, value in clause 2 — the "." delimiter blocks the gate.
    const r = normalise('customer name Z S. The reading was 0.67');
    expect(r.text).toBe('customer name Z S. The reading was 0.67');
    expect(r.rules_hit).toEqual([]);
  });

  test('does not match "z s" inside larger words', () => {
    // No word-boundary z<space>s pattern here.
    expect(normalise('the fuses on circuit 3 was 0.4').text).toBe('the fuses on circuit 3 was 0.4');
  });
});

describe('transcript-normalise — rule 2: "a hundred" → "100"', () => {
  test('digit-ises the observed IR reply (id 80A)', () => {
    const r = normalise('A hundred MΩ');
    expect(r.text).toBe('100 MΩ');
    expect(r.rules_hit).toEqual([NORMALISE_RULE_IDS.A_HUNDRED]);
  });

  test('fires mid-sentence and with a trailing unit word', () => {
    expect(normalise('the IR for the cooker is a hundred megaohms').text).toBe(
      'the IR for the cooker is 100 megaohms'
    );
    expect(normalise('a hundred ohms').text).toBe('100 ohms');
    expect(normalise('a hundred.').text).toBe('100.');
  });

  test('is case-insensitive', () => {
    expect(normalise('A HUNDRED').text).toBe('100');
  });

  // ── Compound guard — a compound must NOT be corrupted into "100 and ..." ──
  test('leaves "a hundred and fifty" UNTOUCHED (compound out of scope, no corruption)', () => {
    const r = normalise('a hundred and fifty megaohms');
    expect(r.text).toBe('a hundred and fifty megaohms');
    expect(r.rules_hit).toEqual([]);
  });

  test('leaves "a hundred and one" untouched', () => {
    expect(normalise('a hundred and one').text).toBe('a hundred and one');
  });

  test('does not fire inside a larger word', () => {
    // No "\ba hundred\b" boundary match.
    expect(normalise('bahundred').text).toBe('bahundred');
  });
});

describe('transcript-normalise — combined + idempotency', () => {
  test('both rules can fire on one transcript (a_hundred runs first, enabling the Zs gate)', () => {
    // "was a hundred" — the Zs context gate needs a DIGIT value, so a_hundred
    // MUST run first ("a hundred" → "100") for "Z s" to then collapse. rules_hit
    // is reported in application order.
    const r = normalise('Z s on the cooker was a hundred');
    expect(r.text).toBe('Zs on the cooker was 100');
    expect(r.rules_hit).toEqual([
      NORMALISE_RULE_IDS.A_HUNDRED,
      NORMALISE_RULE_IDS.ZS_FIELD_TOKEN,
    ]);
  });

  test('idempotent — normalise(normalise(x)) === normalise(x) across every case', () => {
    const inputs = [
      'Z s on the heating was 0.67',
      'Zed s for the cooker is 0.4',
      'Z s on the shower was LIM',
      'A hundred MΩ',
      'Z s on the cooker was a hundred',
      'customer name Z S Electrical',
      'designation Z S 1',
      'a hundred and fifty megaohms',
      '',
      'nothing to change here',
      // punctuation / case variants
      'z s ON THE lights WAS 0.3',
      'the IR is A Hundred.',
    ];
    for (const input of inputs) {
      const once = normalise(input);
      const twice = normalise(once.text);
      expect(twice.text).toBe(once.text);
      expect(twice.rules_hit).toEqual([]);
    }
  });

  test('non-string input is coerced safely, no rules hit', () => {
    expect(normalise(undefined)).toEqual({ text: '', rules_hit: [] });
    expect(normalise(null)).toEqual({ text: '', rules_hit: [] });
    expect(normalise(42)).toEqual({ text: '', rules_hit: [] });
    expect(normalise('')).toEqual({ text: '', rules_hit: [] });
  });
});
