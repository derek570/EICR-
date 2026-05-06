/**
 * Unit tests for the BS-code parser's fuzzy fallback. Covers the
 * production failure shape from session C4467E35 (2026-05-06):
 * Deepgram dropped a digit ("BS 60898" → "BS 6898"), the strict
 * regex patterns missed it, the engine looped re-asking forever.
 *
 * Lev-1 fuzzy fallback closes that loop. Tests assert both the
 * happy fuzzy paths and the deliberate fall-throughs (ambiguity,
 * length-bounds, total miss) so future loosening of the matcher
 * doesn't accidentally accept noise.
 */

import { parseBsCode, bsCodeDigits } from '../extraction/dialogue-engine/parsers/bs-code.js';

describe('parseBsCode — exact regex patterns', () => {
  test('"BS EN 60898" → canonical', () => {
    expect(parseBsCode('BS EN 60898')).toBe('BS EN 60898');
  });

  test('bare "60898" → canonical', () => {
    expect(parseBsCode('60898')).toBe('BS EN 60898');
  });

  test('"BS 60898" (no EN) → canonical — ordinary speech', () => {
    expect(parseBsCode('BS 60898')).toBe('BS EN 60898');
  });

  test('"BS EN 61009" → canonical (RCBO pivot value)', () => {
    expect(parseBsCode('BS EN 61009')).toBe('BS EN 61009');
  });

  test('"BS EN 61008" → canonical (RCD)', () => {
    expect(parseBsCode('BS EN 61008')).toBe('BS EN 61008');
  });

  test('"BS EN 60947-2" → canonical (MCCB)', () => {
    expect(parseBsCode('BS EN 60947-2')).toBe('BS EN 60947-2');
  });

  test('"BS EN 60947-3" → canonical (switch-disconnector)', () => {
    expect(parseBsCode('BS EN 60947-3')).toBe('BS EN 60947-3');
  });

  test('"BS 3036" → canonical (rewireable fuse)', () => {
    expect(parseBsCode('BS 3036')).toBe('BS 3036');
  });

  test('"BS 1361" → canonical (cartridge fuse)', () => {
    expect(parseBsCode('BS 1361')).toBe('BS 1361');
  });

  // 2026-05-06 BS-EN alignment: BS 88-2 / BS 88-3 (legacy UK
  // designation for HRC fuses) collapse to the harmonised European
  // canonical BS EN 60269-2 — the only HRC option in the schema.
  test('"BS 88-2" → BS EN 60269-2 (legacy UK → harmonised EN)', () => {
    expect(parseBsCode('BS 88-2')).toBe('BS EN 60269-2');
  });

  test('"BS 88-3" → BS EN 60269-2 (legacy UK → harmonised EN)', () => {
    expect(parseBsCode('BS 88-3')).toBe('BS EN 60269-2');
  });

  test('"88-2" bare → BS EN 60269-2', () => {
    expect(parseBsCode('88-2')).toBe('BS EN 60269-2');
  });

  test('"BS EN 60269-2" → canonical (HRC fuse, harmonised)', () => {
    expect(parseBsCode('BS EN 60269-2')).toBe('BS EN 60269-2');
  });

  // AFDD (BS EN 62606) and BS 4293 are NOT in the schema option list
  // and the parser deliberately doesn't recognise them — inspectors
  // dictating these will be re-asked rather than write a value the
  // resolver will reject.
  test('"BS EN 62606" → null (AFDD out of scope)', () => {
    expect(parseBsCode('BS EN 62606')).toBe(null);
  });

  test('"BS 4293" → null (legacy non-EN RCD out of scope)', () => {
    expect(parseBsCode('BS 4293')).toBe(null);
  });
});

describe('parseBsCode — fuzzy fallback (Lev-1)', () => {
  // Production failure: session C4467E35 OCPD ask_user loop.
  // Inspector said "BS 60898" three times; Deepgram emitted "BS 6898".
  test('"6898" (Deepgram dropped 0) → BS EN 60898 via insertion', () => {
    expect(parseBsCode('6898')).toBe('BS EN 60898');
  });

  test('"BS 6898" (named-extractor passes "6898" → fuzzy)', () => {
    expect(parseBsCode('BS 6898')).toBe('BS EN 60898');
  });

  test('"6898." (trailing punctuation matches the production shape)', () => {
    expect(parseBsCode('6898.')).toBe('BS EN 60898');
  });

  test('"60008" (1 substitution from 61008) → BS EN 61008', () => {
    // "60008" sits at Lev-1 from "61008" (single sub at index 1) and
    // Lev-2 from "60898" (subs at indices 2 and 3). The matcher picks
    // the unique closest target.
    expect(parseBsCode('60008')).toBe('BS EN 61008');
  });

  test('"610008" (1 insertion in 61008) → BS EN 61008', () => {
    expect(parseBsCode('610008')).toBe('BS EN 61008');
  });

  test('"6100" (1 deletion from 61009 OR 61008) → null on ambiguity', () => {
    // Both 61008 and 61009 are at Lev-1 from "6100" — the matcher
    // must NOT guess. Inspector re-asks via the engine.
    expect(parseBsCode('6100')).toBe(null);
  });

  test('"1234" (no Lev-1 candidate) → null', () => {
    expect(parseBsCode('1234')).toBe(null);
  });
});

describe('parseBsCode — fuzzy fallback length bounds', () => {
  test('digit run shorter than 4 chars → no fuzzy attempt', () => {
    // "988" alone is 3 digits — too short to be a BS code.
    expect(parseBsCode('it was 988')).toBe(null);
  });

  test('digit run longer than 6 chars → no fuzzy attempt', () => {
    // 7+ digits can only be a phone / serial number, not a BS code.
    expect(parseBsCode('reading was 60898123')).toBe(null);
  });

  test('text with no digits at all → null', () => {
    expect(parseBsCode('I have no idea')).toBe(null);
  });
});

describe('parseBsCode — fuzzy fallback does not break existing exact-match paths', () => {
  test('"6 zero 8 9 8" still resolves to BS EN 60898 via zero-word collapse', () => {
    expect(parseBsCode('6 zero 8 9 8')).toBe('BS EN 60898');
  });

  test('"a b s 60898" letter-split → BS EN 60898', () => {
    expect(parseBsCode('a b s 60898')).toBe('BS EN 60898');
  });

  test('"61008" exact match takes precedence over fuzzy', () => {
    expect(parseBsCode('61008')).toBe('BS EN 61008');
  });
});

describe('bsCodeDigits — derivation lookup helper', () => {
  test('"BS EN 61009" → "61009" (RCBO pivot trigger)', () => {
    expect(bsCodeDigits('BS EN 61009')).toBe('61009');
  });

  test('"BS 3036" → "3036" (Rew derivation trigger)', () => {
    expect(bsCodeDigits('BS 3036')).toBe('3036');
  });

  test('"BS 1361" → "1361" (cartridge derivation trigger)', () => {
    expect(bsCodeDigits('BS 1361')).toBe('1361');
  });
});
