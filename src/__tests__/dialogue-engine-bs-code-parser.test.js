/**
 * PLAN-CS (feedback-2026-09-17) — the backend BS-standard parsers.
 *
 * `parseOcpdStandard` is the backend twin of PLAN-CC's client canonicaliser
 * (`packages/shared-utils/src/ocpd-standard.ts`, Swift `OcpdStandard.swift`).
 * The enforcement of byte-identity is the SHARED MANIFEST: every vector in
 * `config/ocpd-bs-suggestions.json` is driven through the real function and
 * the returned bytes compared, exactly as the web and iOS suites do.
 *
 * `parseRcdBsCode` is strict: `rcd_bs_en` stays a closed list.
 *
 * The Levenshtein-1 fuzzy fallback that this file used to pin is GONE (HARD
 * RULE: no fuzzy garble correction). Its old cases are kept below as
 * regressions that must stay non-fuzzy.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as bsCode from '../extraction/dialogue-engine/parsers/bs-code.js';
import { extractNamedFieldValues } from '../extraction/dialogue-engine/helpers/extraction.js';
import { ocpdSchema } from '../extraction/dialogue-engine/schemas/ocpd.js';
import { rcdSchema } from '../extraction/dialogue-engine/schemas/rcd.js';

const {
  parseOcpdStandard,
  parseRcdBsCode,
  bsCodeDigits,
  ocpdStandardShapeAccepts,
  BS_STANDARD_NAMED_EXTRACTOR,
  OCPD_STANDARD_TIER1,
  OCPD_STANDARD_TIER2,
} = bsCode;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST = JSON.parse(
  readFileSync(resolve(REPO_ROOT, 'config/ocpd-bs-suggestions.json'), 'utf8')
);

describe('parseOcpdStandard — the shared manifest (byte-identity with the TS and Swift twins)', () => {
  test('the manifest carries both vector sets', () => {
    expect(MANIFEST.accepted_value_vectors.length).toBeGreaterThan(0);
    expect(MANIFEST.rejected_value_vectors.length).toBeGreaterThan(0);
  });

  test.each(MANIFEST.accepted_value_vectors.map((v) => [v.input, v.expected]))(
    'accepted %j → %j',
    (input, expected) => {
      expect(parseOcpdStandard(input)).toBe(expected);
    }
  );

  test.each(MANIFEST.rejected_value_vectors.map((v) => [v.input, v.reason]))(
    'rejected %j (%s) → null',
    (input) => {
      expect(parseOcpdStandard(input)).toBeNull();
    }
  );

  test('the tier exports are the manifest tiers, never a second copy', () => {
    expect([...OCPD_STANDARD_TIER1]).toEqual(MANIFEST.tier1);
    expect([...OCPD_STANDARD_TIER2]).toEqual(MANIFEST.tier2);
  });
});

describe('parseOcpdStandard — structural twin check against the TypeScript source', () => {
  // The vectors are the enforcement; this is a cheap tripwire for the three
  // literals most likely to be edited on one side only.
  const tsSource = readFileSync(
    resolve(REPO_ROOT, 'packages/shared-utils/src/ocpd-standard.ts'),
    'utf8'
  );
  const jsSource = readFileSync(
    resolve(REPO_ROOT, 'src/extraction/dialogue-engine/parsers/bs-code.js'),
    'utf8'
  );
  const literal = (src, name) => {
    // Up to the statement-ending `;` at END OF LINE: EDGE_PUNCTUATION has a
    // `;` inside its character class.
    const m = new RegExp(`const ${name}[^=]*=\\s*([\\s\\S]*?);\\n`).exec(src);
    return m ? m[1].replace(/\s+/g, ' ').trim() : null;
  };

  test.each(['CAPTURE_GRAMMAR', 'WHITESPACE_CLASS', 'EDGE_PUNCTUATION'])(
    '%s is byte-identical to the TS twin',
    (name) => {
      expect(literal(jsSource, name)).not.toBeNull();
      expect(literal(jsSource, name)).toBe(literal(tsSource, name));
    }
  );

  test('the alias rows are identical to the TS twin', () => {
    const rows = (src) =>
      [...src.matchAll(/^\s*'(BS[^']*)': '(BS[^']*)',$/gm)].map((m) => `${m[1]}=>${m[2]}`);
    expect(rows(jsSource).length).toBeGreaterThan(0);
    expect(rows(jsSource)).toEqual(rows(tsSource));
  });
});

describe('parseOcpdStandard — acceptance 2 (plan)', () => {
  test('whitespace forms normalise from captures, never echo the input bytes', () => {
    expect(parseOcpdStandard('b s en 12345 - 12 - 3')).toBe('BS EN 12345-12-3');
    expect(parseOcpdStandard('BS   EN   60898')).toBe('BS EN 60898');
  });

  test('a value over 24 characters made only of internal whitespace is normalised, not rejected', () => {
    const padded = 'BS      EN      12345   -   12   -   3';
    expect(padded.length).toBeGreaterThan(24);
    const out = parseOcpdStandard(padded);
    expect(out).toBe('BS EN 12345-12-3');
    expect(out).toHaveLength(16);
  });

  test('never "" and never whitespace-bearing output', () => {
    for (const v of MANIFEST.accepted_value_vectors) {
      const out = parseOcpdStandard(v.input);
      expect(out).not.toBe('');
      expect(out).not.toMatch(/\s{2,}/);
    }
  });

  test('non-string, non-number input is a miss', () => {
    expect(parseOcpdStandard(null)).toBeNull();
    expect(parseOcpdStandard(undefined)).toBeNull();
    expect(parseOcpdStandard({})).toBeNull();
    expect(parseOcpdStandard(Number.NaN)).toBeNull();
  });

  test('ocpdStandardShapeAccepts is the same predicate', () => {
    expect(ocpdStandardShapeAccepts('BS 3871')).toBe(true);
    expect(ocpdStandardShapeAccepts('N/A')).toBe(true);
    expect(ocpdStandardShapeAccepts('There is no RCBO')).toBe(false);
    expect(ocpdStandardShapeAccepts('LIM')).toBe(false);
    expect(ocpdStandardShapeAccepts('')).toBe(false);
  });
});

describe('parseRcdBsCode — strict closed list', () => {
  test.each([
    ['61008', 'BS EN 61008'],
    ['BS EN 61008', 'BS EN 61008'],
    ['62423', 'BS EN 62423'],
    ['N/A', 'N/A'],
    // Legacy stored forms canonicalise INTO the list, so the fill predicate
    // never re-asks a healthy legacy value (CS-66).
    ['61009-1', 'BS EN 61009'],
    ['BS EN 61009-1', 'BS EN 61009'],
    ['61009', 'BS EN 61009'],
  ])('%j → %j', (input, expected) => {
    expect(parseRcdBsCode(input)).toBe(expected);
  });

  test.each(['6898', 'BS EN 60898', 'BS 3871', 'BS 3036', 'BS 9999', '', '   ', 'no idea'])(
    '%j → null',
    (input) => {
      expect(parseRcdBsCode(input)).toBeNull();
    }
  );
});

describe('no fuzzy matching anywhere (HARD RULE)', () => {
  test('the old fuzzy entry points no longer exist', () => {
    expect(bsCode.parseBsCode).toBeUndefined();
    expect(bsCode.fuzzyMatchBsCode).toBeUndefined();
  });

  test('a dropped digit is NOT repaired into a different real standard', () => {
    // Pre-PLAN-CS, Levenshtein-1 turned "6898" into BS EN 60898. It is a
    // standard-shaped OCPD value in its own right now, recorded as said…
    expect(parseOcpdStandard('6898')).toBe('BS 6898');
    // …and on the strict RCD list it is simply a miss.
    expect(parseRcdBsCode('6898')).toBeNull();
    expect(parseRcdBsCode('60008')).toBeNull();
    expect(parseRcdBsCode('610008')).toBeNull();
  });

  test('prose containing a standard is a miss — the grammar is anchored', () => {
    expect(parseOcpdStandard('the BS code is 60898')).toBeNull();
    expect(parseOcpdStandard('There is no RCBO')).toBeNull();
  });
});

describe('BS_STANDARD_NAMED_EXTRACTOR — the two remaining BS extractors', () => {
  test('is shared by the OCPD and RCD schemas and by nothing else', () => {
    const ocpdBs = ocpdSchema.slots.find((s) => s.field === 'ocpd_bs_en');
    const rcdBs = rcdSchema.slots.find((s) => s.field === 'rcd_bs_en');
    expect(ocpdBs.namedExtractor).toBe(BS_STANDARD_NAMED_EXTRACTOR);
    expect(rcdBs.namedExtractor).toBe(BS_STANDARD_NAMED_EXTRACTOR);
    expect(BS_STANDARD_NAMED_EXTRACTOR.global).toBe(false);
  });

  test.each([
    // The old capture stopped after ONE single-digit suffix: 60947-4-1 was
    // written and read back as 60947-4.
    ['the breaker is BS EN 60947-4-1', 'BS EN 60947-4-1'],
    ['BS EN 12345-12-3 on this one', 'BS EN 12345-12-3'],
    ['b s en 12345 - 12 - 3', 'BS EN 12345-12-3'],
    ['BS 88-2', 'BS 88-2'],
    ['a b s 60898', 'BS EN 60898'],
    ['BS 3871', 'BS 3871'],
  ])('OCPD named extraction of %j → %j', (text, expected) => {
    const named = extractNamedFieldValues(text, ocpdSchema.slots).filter(
      (w) => w.field === 'ocpd_bs_en'
    );
    expect(named).toEqual([{ field: 'ocpd_bs_en', value: expected }]);
  });

  test('a longer digit run is never cut into a shorter standard (right boundary)', () => {
    const named = extractNamedFieldValues('BS 123456', ocpdSchema.slots).filter(
      (w) => w.field === 'ocpd_bs_en'
    );
    expect(named).toEqual([]);
  });

  test.each(['BS EN 60898A', 'BS EN 60947-4-1A', 'BS 3871x'])(
    'a trailing letter is not cut off into a shorter standard (%j) — EP cycle 1, Codex c1-2',
    (text) => {
      // Named and whole-value paths must agree: both refuse the token.
      expect(parseOcpdStandard(text)).toBeNull();
      const named = extractNamedFieldValues(text, ocpdSchema.slots).filter(
        (w) => w.field === 'ocpd_bs_en'
      );
      expect(named).toEqual([]);
    }
  );

  test('a bare two-digit BS 88 is not a standard, so nothing is named-extracted', () => {
    const named = extractNamedFieldValues('BS 88 fuse', ocpdSchema.slots).filter(
      (w) => w.field === 'ocpd_bs_en'
    );
    expect(named).toEqual([]);
  });
});

describe('bsCodeDigits — derivation lookup helper (unchanged)', () => {
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
