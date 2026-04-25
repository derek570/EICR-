import { describe, it, expect } from 'vitest';
import { normalise } from '@/lib/recording/number-normaliser';

// Mirrors the iOS `NumberNormaliserTests.swift` corpus + a handful of
// extra spoken-form edge cases the regex authors flagged. Whenever a
// new case is added on iOS, add the equivalent here so the two ports
// stay locked.

describe('NumberNormaliser — spoken decimals', () => {
  it('"nought point two seven" → "0.27"', () => {
    expect(normalise('nought point two seven')).toBe('0.27');
  });

  it('"nought point three five" → "0.35"', () => {
    expect(normalise('nought point three five')).toBe('0.35');
  });

  it('"one point five" → "1.5"', () => {
    expect(normalise('one point five')).toBe('1.5');
  });

  it('"zero point seven" → "0.7"', () => {
    expect(normalise('zero point seven')).toBe('0.7');
  });

  it('"nought point one four" → "0.14"', () => {
    expect(normalise('nought point one four')).toBe('0.14');
  });

  it('"nought point four five eight" → "0.458" (3 fractional digits)', () => {
    expect(normalise('nought point four five eight')).toBe('0.458');
  });

  it('"two point one two three four" → "2.1234" (4 fractional digits)', () => {
    // Web-only extension above iOS — supports 4-sig-fig IR readings without
    // dropping the trailing digit (codex P2 follow-up on R1).
    expect(normalise('two point one two three four')).toBe('2.1234');
  });
});

describe('NumberNormaliser — implied zero decimal', () => {
  it('"Zs point two seven" preserves prefix and yields 0.27', () => {
    const result = normalise('Zs point two seven');
    expect(result).toContain('0.27');
  });

  it('leading "point" becomes "0." even at start of string', () => {
    expect(normalise('point seven five')).toBe('0.75');
  });
});

describe('NumberNormaliser — whole numbers', () => {
  it('"thirty two" → "32"', () => {
    expect(normalise('thirty two')).toBe('32');
  });

  it('"twenty one" → "21"', () => {
    expect(normalise('twenty one')).toBe('21');
  });

  it('"thirteen" → "13"', () => {
    expect(normalise('thirteen')).toBe('13');
  });

  it('"sixteen" → "16"', () => {
    expect(normalise('sixteen')).toBe('16');
  });

  it('standalone "twenty" → "20"', () => {
    expect(normalise('twenty')).toBe('20');
  });

  it('standalone "forty" → "40"', () => {
    expect(normalise('forty')).toBe('40');
  });
});

describe('NumberNormaliser — hundreds', () => {
  it('"two hundred" → "200"', () => {
    expect(normalise('two hundred')).toBe('200');
  });

  it('"three hundred" → "300"', () => {
    expect(normalise('three hundred')).toBe('300');
  });
});

describe('NumberNormaliser — already-numeric passthrough', () => {
  it('numeric decimal unchanged', () => {
    expect(normalise('0.27')).toBe('0.27');
  });

  it('numeric integer unchanged', () => {
    expect(normalise('32')).toBe('32');
  });

  it('idempotent — running normalise twice yields the same string', () => {
    const once = normalise('nought point three five');
    const twice = normalise(once);
    expect(twice).toBe(once);
  });
});

describe('NumberNormaliser — edge cases', () => {
  it('empty string', () => {
    expect(normalise('')).toBe('');
  });

  it('text without numbers passes through', () => {
    expect(normalise('hello world')).toBe('hello world');
  });

  it('mixed text + decimal', () => {
    const result = normalise('Ze is nought point three four');
    expect(result).toContain('0.34');
  });
});

describe('NumberNormaliser — spoken abbreviations', () => {
  it('"zed s" → "Zs" alongside a decimal', () => {
    const result = normalise('zed s is nought point seven two');
    expect(result).toContain('Zs');
    expect(result).toContain('0.72');
  });

  it('"zed e" → "Ze" alongside a decimal', () => {
    const result = normalise('zed e is nought point three four');
    expect(result).toContain('Ze');
    expect(result).toContain('0.34');
  });

  it('"p f c" → "PFC"', () => {
    expect(normalise('p f c is two point five')).toContain('PFC');
  });

  it('"m c b" → "MCB"', () => {
    expect(normalise('m c b')).toContain('MCB');
  });

  it('"r c b o" → "RCBO"', () => {
    expect(normalise('r c b o')).toContain('RCBO');
  });

  it('"r c d" → "RCD"', () => {
    expect(normalise('r c d')).toContain('RCD');
  });

  it('"r one" → "R1"', () => {
    expect(normalise('r one plus r two')).toContain('R1');
  });

  it('"r two" → "R2"', () => {
    expect(normalise('r one plus r two')).toContain('R2');
  });

  it('"a f d d" → "AFDD"', () => {
    expect(normalise('a f d d trip current is thirty')).toContain('AFDD');
  });

  it('"our c d" Deepgram-misheard form → "RCD"', () => {
    expect(normalise('our c d trip time')).toContain('RCD');
  });
});

describe('NumberNormaliser — unit normalisation', () => {
  it('"meg ohms" → "MΩ"', () => {
    expect(normalise('two hundred meg ohms')).toContain('MΩ');
  });

  it('"milliamps" → "mA"', () => {
    expect(normalise('thirty milliamps')).toContain('mA');
  });

  it('"mm squared" → "mm²"', () => {
    expect(normalise('two point five mm squared')).toContain('mm²');
  });

  it('"millimeters squared" matches before "millimeters" (longest-first sort)', () => {
    const result = normalise('two point five millimeters squared');
    expect(result).toContain('mm²');
    expect(result).not.toContain('mm squared');
    expect(result).not.toMatch(/mm\b(?!\²)/);
  });

  it('"kilo amps" → "kA"', () => {
    expect(normalise('three kilo amps')).toContain('kA');
  });
});

describe('NumberNormaliser — stray digit-word stripping', () => {
  it('"naught 0.14" → "0.14" (drop the redundant word)', () => {
    expect(normalise('naught 0.14')).toBe('0.14');
  });

  it('"no 0.27" → "0.27" (Deepgram misheard "nought" as "no")', () => {
    expect(normalise('no 0.27')).toBe('0.27');
  });
});

describe('NumberNormaliser — implied decimal ("Nought 88" → "0.88")', () => {
  it('"nought 88" → "0.88"', () => {
    expect(normalise('nought 88')).toBe('0.88');
  });

  it('"oh 12" → "0.12" (oh is a recognised zero-word)', () => {
    expect(normalise('oh 12')).toBe('0.12');
  });

  it('keeps three-digit form: "nought 234" → "0.234"', () => {
    expect(normalise('nought 234')).toBe('0.234');
  });
});

describe('NumberNormaliser — digit-sequence collapse (iOS-canon: any 2+ run)', () => {
  it('"2 9 9" → "299" (canonical IR-reading form)', () => {
    expect(normalise('2 9 9')).toBe('299');
  });

  it('"6 0 8 9 8" → "60898" (postcode-style runs)', () => {
    expect(normalise('6 0 8 9 8')).toBe('60898');
  });

  it('"2 3" → "23" — 2-digit run collapses (iOS canon)', () => {
    expect(normalise('2 3')).toBe('23');
  });

  it('"Zs point 6 0" → "Zs 0.60" — 2-digit fractional after "point" collapses via the general pattern + POINT_DIGIT_PATTERN', () => {
    expect(normalise('Zs point 6 0')).toBe('Zs 0.60');
  });

  it('"point 1 2 3" → "0.123" — 3-digit fractional after "point"', () => {
    expect(normalise('point 1 2 3')).toBe('0.123');
  });

  it('"point 1 2 3 4" → "0.1234" — 4-digit fractional after "point"', () => {
    expect(normalise('point 1 2 3 4')).toBe('0.1234');
  });

  it('does not over-fire: "32 in" stays "32 in"', () => {
    expect(normalise('32 in')).toBe('32 in');
  });

  // Known limitation: "circuit 1 6 amp m c b" → "circuit 16 amp MCB"
  // — the 2-digit collapse merges the circuit number and rating.
  // iOS has the same behaviour and disambiguates downstream in the
  // matcher (R3). Web will do the same. No regression lock at this
  // layer — the test will live in R3's matcher suite where the
  // surrounding context ("circuit" prefix, "amp" suffix) is in scope.
});

describe('NumberNormaliser — mixed spoken-zero + point + numeric', () => {
  it('"Nought Point 0.87" → "0.87"', () => {
    expect(normalise('Nought Point 0.87')).toBe('0.87');
  });

  it('"nought point 87" (no decimal in the captured digits) → "0.87"', () => {
    expect(normalise('nought point 87')).toBe('0.87');
  });
});

describe('NumberNormaliser — tens plurals', () => {
  it('"twenties" → "20"', () => {
    expect(normalise('twenties')).toBe('20');
  });

  it('"thirties" → "30"', () => {
    expect(normalise('thirties')).toBe('30');
  });
});
