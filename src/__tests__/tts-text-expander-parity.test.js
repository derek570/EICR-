/**
 * Parity tests for src/extraction/tts-text-expander.js against iOS
 * AlertManager.expandForTTS.
 *
 * The contract is: for any string iOS expands then POSTs to
 * /api/proxy/elevenlabs-tts, the speculator's expansion of the SAME
 * input must produce an identical UTF-8 byte sequence. Otherwise the
 * cache key (sha1 of the expanded text) won't match and the
 * speculator's pre-synthesised audio is unreachable from the iOS POST.
 *
 * Fixtures are organised by:
 *   1) per-rule sanity (one assertion per ttsReplacement entry)
 *   2) order-sensitivity (compound patterns must fire before
 *      individual ones)
 *   3) number expansion (decimals, 4+ digit ints, 1-3 digit ints)
 *   4) real bundler-output strings (synthesiseConfirmations in
 *      stage6-event-bundler.js)
 *   5) edge cases (null/undefined/empty, unicode untouched, repeated
 *      matches)
 *
 * To extend: add a tuple to the relevant array. To regenerate from
 * iOS: run the tour-audio generation flow in CertMateUnified and dump
 * the AlertManager.expandForTTS outputs side-by-side; mismatches
 * indicate iOS drifted.
 */

import { expandForTTS, EXPANDER_VERSION } from '../extraction/tts-text-expander.js';

describe('tts-text-expander — version constant', () => {
  test('EXPANDER_VERSION matches ISO date pattern with optional same-day suffix', () => {
    // Format pins the parity contract with iOS Bundle.expandForTTSVersion.
    // Bump this when REPLACEMENTS or expandNumbers change.
    expect(EXPANDER_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}[a-z]?$/);
  });
});

describe('tts-text-expander — iOS parity', () => {
  describe('impedance values (compound first)', () => {
    const cases = [
      ['Ze/Zs', 'zed E over zed S'],
      ['ze/zs', 'zed E over zed S'],
      ['Ze', 'zed E'],
      ['ze', 'zed E'],
      ['Zs', 'zed S'],
      ['zs', 'zed S'],
      // Compound wins over individual: "Ze/Zs" → "zed E over zed S",
      // NOT "zed E/zed S".
      ['report Ze/Zs together', 'report zed E over zed S together'],
      // Individual still fires when no compound: "Ze 0.5" → "zed E zero point five"
      ['Ze 0.5', 'zed E zero point five'],
    ];
    test.each(cases)('expandForTTS(%j) === %j', (input, expected) => {
      expect(expandForTTS(input)).toBe(expected);
    });
  });

  describe('units', () => {
    const cases = [
      ['mm²', 'millimetres squared'],
      ['mm2 squared', 'millimetres squared squared'],
      // \bMΩ\b is broken in both JS and Swift (\b is ASCII-only);
      // the bundler doesn't emit unicode units, so this fixture is
      // here only to prove BOTH ports skip it the same way. With a
      // following ASCII word char the boundary fires.
      ['5 megohms here', '5 megger ohms here'],
      ['10 mega ohms here', '10 megger ohms here'],
      ['200 milliohms now', '200 milli ohms now'],
      ['16 kA available', '16 kilo amps available'],
      ['rated 200 ms', 'rated 200 milliseconds'],
    ];
    test.each(cases)('expandForTTS(%j) === %j', (input, expected) => {
      expect(expandForTTS(input)).toBe(expected);
    });
  });

  describe('greater-than prefix', () => {
    const cases = [
      ['>200', 'greater than 200'],
      ['> 200', 'greater than 200'],
      ['>  200', 'greater than 200'],
      ['IR >999', 'IR greater than 999'],
    ];
    test.each(cases)('expandForTTS(%j) === %j', (input, expected) => {
      expect(expandForTTS(input)).toBe(expected);
    });
  });

  describe('circuit protection abbreviations', () => {
    const cases = [
      ['RCD', 'R C D'],
      ['rcd', 'R C D'],
      ['RCBO', 'R C B O'],
      ['rcbo', 'R C B O'],
      ['MCB', 'M C B'],
      ['mcb', 'M C B'],
      ['SPD', 'S P D'],
      ['BSEN', 'B S E N'],
      ['BS EN', 'B S E N'],
      // 7671 is a 4-digit integer so it ALSO triggers number expansion
      // after the literal "BS 7671" rewrite — matches iOS.
      ['BS 7671', 'B S seven six seven one'],
      ['BS  7671', 'B S seven six seven one'], // double space tolerated by \s*
    ];
    test.each(cases)('expandForTTS(%j) === %j', (input, expected) => {
      expect(expandForTTS(input)).toBe(expected);
    });
  });

  describe('electrical formulae (compound first)', () => {
    const cases = [
      // R1+R2 first rewrites to "R1 plus R2", then bare R1/R2 rules
      // ALSO fire on the rewrite output → "R 1 plus R 2". Matches iOS.
      ['R1+R2', 'R 1 plus R 2'],
      ['R2', 'R 2'],
      ['R1', 'R 1'],
      ['R1+R2 test', 'R 1 plus R 2 test'],
    ];
    test.each(cases)('expandForTTS(%j) === %j', (input, expected) => {
      expect(expandForTTS(input)).toBe(expected);
    });
  });

  describe('earthing systems', () => {
    const cases = [
      ['TN-C-S', 'T N C S'],
      ['TN-S', 'T N S'],
      ['TT', 'T T'],
      ['PME', 'P M E'],
    ];
    test.each(cases)('expandForTTS(%j) === %j', (input, expected) => {
      expect(expandForTTS(input)).toBe(expected);
    });
  });

  describe('"live" → "lyve" pronunciation', () => {
    const cases = [
      ['live CSA', 'lyve CSA'],
      ['the live conductor', 'the lyve conductor'],
      // Word boundary — "lived" is NOT replaced (no \b after live):
      ['I have lived here', 'I have lived here'],
      // Mid-word substring — NOT matched:
      ['alive', 'alive'],
    ];
    test.each(cases)('expandForTTS(%j) === %j', (input, expected) => {
      expect(expandForTTS(input)).toBe(expected);
    });
  });

  describe('number expansion', () => {
    const cases = [
      // Decimals expand digit-by-digit, BOTH whole + fractional.
      ['0.5', 'zero point five'],
      ['1.25', 'one point two five'],
      ['0.19', 'zero point one nine'],
      ['10.5', 'one zero point five'],
      // 4+ digit integers expand digit-by-digit.
      ['1234', 'one two three four'],
      ['7671', 'seven six seven one'],
      ['65000', 'six five zero zero zero'],
      // 1-3 digit integers PASS THROUGH (TTS reads "200" → "two
      // hundred" naturally).
      ['5', '5'],
      ['32', '32'],
      ['200', '200'],
      ['999', '999'],
      // Mixed: small int then big int, only big expands.
      ['set 32 limit 12345', 'set 32 limit one two three four five'],
      // Decimal with multi-digit whole — both halves expand.
      ['12.34', 'one two point three four'],
    ];
    test.each(cases)('expandForTTS(%j) === %j', (input, expected) => {
      expect(expandForTTS(input)).toBe(expected);
    });
  });

  describe('real bundler outputs (buildConfirmationText)', () => {
    // Sample of strings the bundler at stage6-event-bundler.js:66
    // actually produces. Verified by hand against the same input
    // strings run through iOS AlertManager.expandForTTS on
    // 2026-05-23.
    const cases = [
      ['Circuit 1, points 5', 'Circuit 1, points 5'],
      ['Circuit 12, polarity confirmed', 'Circuit 12, polarity confirmed'],
      ['polarity confirmed', 'polarity confirmed'],
      ['Ze 0.19', 'zed E zero point one nine'],
      ['Ze 0.5', 'zed E zero point five'],
      ['PFC 280', 'PFC 280'],
      ['PFC 1500', 'PFC one five zero zero'],
      ['PEFC 800', 'PEFC 800'],
      ['PSCC 1200', 'PSCC one two zero zero'],
      ['Circuit 4, Zs 1.25', 'Circuit 4, zed S one point two five'],
      ['Circuit 5, R1 plus R2 0.5', 'Circuit 5, R 1 plus R 2 zero point five'],
      ['Circuit 5, R2 0.3', 'Circuit 5, R 2 zero point three'],
      ['Circuit 5, ring r1 0.4', 'Circuit 5, ring r1 zero point four'],
      ['Circuit 5, IR L to E 200', 'Circuit 5, IR L to E 200'],
      ['Circuit 5, IR L to L 1500', 'Circuit 5, IR L to L one five zero zero'],
      ['Circuit 3, OCPD rating 32', 'Circuit 3, OCPD rating 32'],
      ['Circuit 3, OCPD type B', 'Circuit 3, OCPD type B'],
      ['Circuit 3, RCD 30', 'Circuit 3, R C D 30'],
      ['Circuit 3, RCD time 200', 'Circuit 3, R C D time 200'],
      ['Circuit 3, RCD type AC', 'Circuit 3, R C D type AC'],
      ['Circuit 5, live CSA 4', 'Circuit 5, lyve CSA 4'],
      ['Circuit 5, CPC CSA 1.5', 'Circuit 5, CPC CSA one point five'],
      ['Circuit 3, wiring type A', 'Circuit 3, wiring type A'],
    ];
    test.each(cases)('expandForTTS(%j) === %j', (input, expected) => {
      expect(expandForTTS(input)).toBe(expected);
    });
  });

  describe('edge cases', () => {
    test('null returns empty string', () => {
      expect(expandForTTS(null)).toBe('');
    });
    test('undefined returns empty string', () => {
      expect(expandForTTS(undefined)).toBe('');
    });
    test('empty string returns empty string', () => {
      expect(expandForTTS('')).toBe('');
    });
    test('non-string input is coerced via String()', () => {
      // The bundler always passes strings; this just proves we don't
      // throw if a number ever slips through.
      expect(expandForTTS(123)).toBe('123');
      expect(expandForTTS(1234)).toBe('one two three four');
    });
    test('text with NO replacements is identity', () => {
      expect(expandForTTS('hello world 5')).toBe('hello world 5');
    });
    test('multiple occurrences of same pattern all replace', () => {
      expect(expandForTTS('Ze and Ze')).toBe('zed E and zed E');
      expect(expandForTTS('RCD then RCD then MCB')).toBe('R C D then R C D then M C B');
    });
  });
});
