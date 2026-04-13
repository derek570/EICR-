/**
 * Tests for number-normaliser.ts — the spoken-to-numeric transcript normaliser.
 *
 * This normaliser runs on every Deepgram transcript before regex field matching.
 * Bugs here cause silent data loss (e.g. "nought point two seven" stays as text
 * and no resistance value gets extracted). These tests cover the core conversions.
 */

import { normalise } from '../lib/recording/number-normaliser';

describe('normalise() — spoken number conversion', () => {
  describe('spoken decimals', () => {
    it('converts "nought point two seven" → "0.27"', () => {
      expect(normalise('nought point two seven')).toBe('0.27');
    });

    it('converts "zero point eight five" → "0.85"', () => {
      expect(normalise('zero point eight five')).toBe('0.85');
    });

    it('converts "point two seven" (implied zero) → "0.27"', () => {
      expect(normalise('point two seven')).toBe('0.27');
    });

    it('converts "nought 88" (implied decimal) → "0.88"', () => {
      expect(normalise('nought 88')).toBe('0.88');
    });

    it('converts "nought point 0.87" (mixed spoken+numeric) → "0.87"', () => {
      expect(normalise('nought point 0.87')).toBe('0.87');
    });
  });

  describe('spoken abbreviations', () => {
    it('converts "zed s" → "Zs"', () => {
      expect(normalise('zed s')).toBe('Zs');
    });

    it('converts "zed e" → "Ze"', () => {
      expect(normalise('zed e')).toBe('Ze');
    });

    it('converts "p f c" → "PFC"', () => {
      expect(normalise('p f c')).toBe('PFC');
    });

    it('converts "r c d" → "RCD"', () => {
      expect(normalise('r c d')).toBe('RCD');
    });

    it('converts "r one" → "R1"', () => {
      expect(normalise('r one')).toBe('R1');
    });

    it('converts "r two" → "R2"', () => {
      expect(normalise('r two')).toBe('R2');
    });
  });

  describe('unit normalisation', () => {
    it('converts "meg ohms" → "MΩ"', () => {
      expect(normalise('meg ohms')).toBe('MΩ');
    });

    it('converts "ohms" → "Ω"', () => {
      expect(normalise('ohms')).toBe('Ω');
    });

    it('converts "milli amps" → "mA"', () => {
      expect(normalise('milli amps')).toBe('mA');
    });

    it('converts "millimetres" → "mm"', () => {
      expect(normalise('millimetres')).toBe('mm');
    });
  });

  describe('tens and teens', () => {
    it('converts "twenty one" → "21"', () => {
      expect(normalise('twenty one')).toBe('21');
    });

    it('converts "thirteen" → "13"', () => {
      expect(normalise('thirteen')).toBe('13');
    });

    it('converts "three hundred" → "300"', () => {
      expect(normalise('three hundred')).toBe('300');
    });
  });

  describe('digit sequence collapse', () => {
    it('collapses "2 9 9" → "299" (Deepgram digit artefact)', () => {
      expect(normalise('2 9 9')).toBe('299');
    });

    it('collapses "1 8" → "18"', () => {
      expect(normalise('1 8')).toBe('18');
    });
  });

  describe('passthrough', () => {
    it('leaves plain numeric strings unchanged', () => {
      expect(normalise('0.35')).toBe('0.35');
    });

    it('leaves empty string unchanged', () => {
      expect(normalise('')).toBe('');
    });

    it('leaves unrelated text unchanged', () => {
      expect(normalise('the circuit is fine')).toBe('the circuit is fine');
    });
  });

  describe('real transcript examples', () => {
    it('extracts resistance value from EICR transcript', () => {
      // "plus" is not converted — only spoken numbers and units are normalised
      const result = normalise('r one plus r two is nought point three five ohms');
      expect(result).toBe('R1 plus R2 is 0.35 Ω');
    });

    it('handles Zs reading in context', () => {
      const result = normalise('zed s at db is nought point eight seven ohms');
      expect(result).toBe('Zs at db is 0.87 Ω');
    });
  });
});
