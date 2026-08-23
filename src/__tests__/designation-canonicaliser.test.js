/**
 * PLAN-B (feedback ids 128+131) — canonicaliseCircuitDesignation golden
 * vectors + caller-policy helpers.
 *
 * The vector table lives in `config/designation-canonical-vectors.json`
 * — the CROSS-PLATFORM CONTRACT file PLAN-B2's iOS/web implementations
 * consume byte-identical. This test IS the backend drift test: every
 * vector must hold against the live implementation, so an edit to either
 * side without the other fails here.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

import {
  canonicaliseCircuitDesignation,
  designationCanonicalisesToEmpty,
  repairCircuitDesignation,
} from '../extraction/designation-canonicaliser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VECTORS_PATH = path.join(__dirname, '..', '..', 'config', 'designation-canonical-vectors.json');

describe('canonicaliseCircuitDesignation — golden vectors (cross-platform contract)', () => {
  const { vectors } = JSON.parse(readFileSync(VECTORS_PATH, 'utf8'));

  it('fixture is present and non-trivial', () => {
    expect(Array.isArray(vectors)).toBe(true);
    expect(vectors.length).toBeGreaterThanOrEqual(20);
  });

  for (const { input, expected } of JSON.parse(readFileSync(VECTORS_PATH, 'utf8')).vectors) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(canonicaliseCircuitDesignation(input)).toBe(expected);
    });
  }
});

describe('canonicaliseCircuitDesignation — behaviour beyond the vector table', () => {
  it('returns non-string inputs verbatim', () => {
    expect(canonicaliseCircuitDesignation(null)).toBe(null);
    expect(canonicaliseCircuitDesignation(undefined)).toBe(undefined);
    expect(canonicaliseCircuitDesignation(42)).toBe(42);
  });

  it('is byte-identical (same reference semantics) when nothing is removed', () => {
    const s = '  Ring circuit sockets  ';
    expect(canonicaliseCircuitDesignation(s)).toBe(s);
  });

  it('iterative edge strip handles mixed punctuated stutters on both edges', () => {
    expect(canonicaliseCircuitDesignation('Circuit, circuit! kitchen circuit. circuits')).toBe(
      'kitchen'
    );
  });

  it('does not treat hyphen as a token delimiter (no regex \\b shortcut)', () => {
    expect(canonicaliseCircuitDesignation('Sub-circuit monitor')).toBe('Sub-circuit monitor');
    expect(canonicaliseCircuitDesignation('tester short-circuit')).toBe('tester short-circuit');
  });
});

describe('designationCanonicalisesToEmpty — the interactive reject-empty gate condition', () => {
  it('fires only on non-empty raw → empty canonical', () => {
    expect(designationCanonicalisesToEmpty('Circuit')).toBe(true);
    expect(designationCanonicalisesToEmpty('circuits')).toBe(true);
    expect(designationCanonicalisesToEmpty('Circuit circuit.')).toBe(true);
    expect(designationCanonicalisesToEmpty('Upstairs lighting circuit')).toBe(false);
    // Today's semantics preserved: empty / whitespace / punctuation-only
    // inputs never trip the gate (they were writable before this wave).
    expect(designationCanonicalisesToEmpty('')).toBe(false);
    expect(designationCanonicalisesToEmpty('   ')).toBe(false);
    expect(designationCanonicalisesToEmpty(' . ')).toBe(false);
    expect(designationCanonicalisesToEmpty(null)).toBe(false);
    expect(designationCanonicalisesToEmpty(7)).toBe(false);
  });
});

describe('repairCircuitDesignation — persistence repair-never-reject', () => {
  it('strips where a meaningful remainder exists', () => {
    expect(repairCircuitDesignation('Upstairs lighting circuit')).toBe('Upstairs lighting');
    expect(repairCircuitDesignation('Circuit upstairs lighting')).toBe('upstairs lighting');
  });

  it('leaves a banned-token-only value UNCHANGED (never blanks — empty = spare hazard)', () => {
    expect(repairCircuitDesignation('Circuit')).toBe('Circuit');
    expect(repairCircuitDesignation('Circuits')).toBe('Circuits');
    expect(repairCircuitDesignation('Circuit circuit')).toBe('Circuit circuit');
  });

  it('passes through empty / non-string values verbatim', () => {
    expect(repairCircuitDesignation('')).toBe('');
    expect(repairCircuitDesignation(null)).toBe(null);
    expect(repairCircuitDesignation(undefined)).toBe(undefined);
  });
});
