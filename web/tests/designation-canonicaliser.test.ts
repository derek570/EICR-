/**
 * PLAN-B2 — web drift test for the shared designation-canonicaliser
 * contract (feedback id 128 defence-in-depth).
 *
 * Layer pinning (B2-3): the golden-vector fixture
 * `config/designation-canonical-vectors.json` pins the PURE helper
 * (`canonicaliseCircuitDesignation`, "Circuit" → "") — the SAME file the
 * backend Jest test asserts, read via its repo-relative path so there is
 * exactly ONE fixture (a packages-path twin would drift against the file
 * the backend asserts). The REPAIR wrapper (`repairCircuitDesignation`,
 * what web write/load boundaries actually call) gets separate tests
 * below proving banned-token-only values are left UNCHANGED — blanking
 * would reclassify the circuit as a SPARE.
 */

import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

import {
  canonicaliseCircuitDesignation,
  designationCanonicalisesToEmpty,
  repairCircuitDesignation,
} from '@certmate/shared-utils';

const require = createRequire(import.meta.url);
const fixture = require('../../config/designation-canonical-vectors.json') as {
  vectors: Array<{ input: string; expected: string }>;
};

describe('canonicaliseCircuitDesignation — shared golden vectors (pure layer)', () => {
  it('fixture is non-trivial', () => {
    expect(fixture.vectors.length).toBeGreaterThanOrEqual(33);
  });

  for (const { input, expected } of fixture.vectors) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(canonicaliseCircuitDesignation(input)).toBe(expected);
    });
  }
});

describe('repairCircuitDesignation — client repair wrapper', () => {
  it('strips edge tokens when a meaningful remainder exists', () => {
    expect(repairCircuitDesignation('Upstairs lighting circuit')).toBe('Upstairs lighting');
    expect(repairCircuitDesignation('Circuit upstairs lighting')).toBe('upstairs lighting');
  });

  it('leaves a banned-token-only value UNCHANGED (empty = spare hazard)', () => {
    expect(repairCircuitDesignation('Circuit')).toBe('Circuit');
    expect(repairCircuitDesignation('circuits')).toBe('circuits');
    expect(repairCircuitDesignation('Circuit circuit.')).toBe('Circuit circuit.');
  });

  it('passes through non-strings, empty and whitespace-only values verbatim', () => {
    expect(repairCircuitDesignation('')).toBe('');
    expect(repairCircuitDesignation('   ')).toBe('   ');
    expect(repairCircuitDesignation(null)).toBe(null);
    expect(repairCircuitDesignation(undefined)).toBe(undefined);
    expect(repairCircuitDesignation(7 as unknown as string)).toBe(7);
  });

  it('never touches interior tokens or hyphen compounds', () => {
    expect(repairCircuitDesignation('Ring circuit sockets')).toBe('Ring circuit sockets');
    expect(repairCircuitDesignation('Short-circuit tester')).toBe('Short-circuit tester');
  });
});

describe('designationCanonicalisesToEmpty — parity helper', () => {
  it('true only for non-empty banned-token-only text', () => {
    expect(designationCanonicalisesToEmpty('Circuit')).toBe(true);
    expect(designationCanonicalisesToEmpty('Circuit circuits')).toBe(true);
    expect(designationCanonicalisesToEmpty('')).toBe(false);
    expect(designationCanonicalisesToEmpty('   ')).toBe(false);
    expect(designationCanonicalisesToEmpty('Cooker')).toBe(false);
    expect(designationCanonicalisesToEmpty(null)).toBe(false);
  });
});

/**
 * Cycle-9 (F3) — the blank tests inside `repair` and
 * `designationCanonicalisesToEmpty` are TRIMS, and the two platforms
 * were trimming with different character sets. Swift's Foundation sets
 * (`.whitespacesAndNewlines`, `.whitespaces`) are the Unicode
 * `White_Space` property, which contains U+0085 NEXT LINE; ECMAScript's
 * TrimString class does not.
 *
 * The golden-vector fixture CANNOT fence this: it pins `canonicalise`,
 * and both platforms already agreed there. The divergence was entirely
 * in what `repair` then DID with that agreed remainder. This is the
 * web half of the twin — see `DesignationCanonicaliserContractTests`.
 */
describe('repair — U+0085 is ECMAScript-untrimmable (cycle-9 F3 twin)', () => {
  it('treats a NEL-only remainder as meaningful, so the banned edge token is stripped', () => {
    // SPACE is a delimiter, so "Circuit" is a standalone leading token
    // and canonicalises away, leaving a lone NEL. JS `.trim()` leaves
    // that NEL in place, so the remainder is non-blank and repair
    // returns it. Swift trimming with a Foundation set saw '' instead,
    // concluded the value was banned-token-only, and returned the input
    // UNCHANGED — keeping the word "circuit" on iOS alone.
    expect(canonicaliseCircuitDesignation('Circuit \u0085')).toBe('\u0085');
    expect(repairCircuitDesignation('Circuit \u0085')).toBe('\u0085');
    expect(designationCanonicalisesToEmpty('Circuit \u0085')).toBe(false);
  });

  it('still treats a genuinely blank remainder as banned-token-only', () => {
    // Control: ordinary trailing whitespace. Both platforms always
    // agreed here, which is why the U+0085 case survived eight cycles.
    expect(canonicaliseCircuitDesignation('Circuit  ')).toBe('');
    expect(repairCircuitDesignation('Circuit  ')).toBe('Circuit  ');
    expect(designationCanonicalisesToEmpty('Circuit  ')).toBe(true);
  });
});
