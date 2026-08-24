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
