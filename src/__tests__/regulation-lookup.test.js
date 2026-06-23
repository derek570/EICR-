/**
 * Plan 06-23 obs-#52 Fix B — regulation-lookup unit tests.
 *
 * Locks the key-normalisation + table HIT/MISS behaviour the
 * record_observation dispatcher relies on to attach canonical BS 7671 wording.
 */

import { deriveRegulationRef, lookupRegulation } from '../extraction/regulation-lookup.js';

describe('deriveRegulationRef — bare table-key normalisation', () => {
  test('bare numeric ref → itself', () => {
    expect(deriveRegulationRef('411.3.3')).toBe('411.3.3');
  });

  test('ref + spaced wording → strips the wording tail', () => {
    expect(deriveRegulationRef('411.3.3 — model wording here')).toBe('411.3.3');
    expect(deriveRegulationRef('411.3.3 - model wording')).toBe('411.3.3');
    expect(deriveRegulationRef('411.3.3: model wording')).toBe('411.3.3');
  });

  test('"Regulation <num>" / "Reg <num>" prefix is stripped', () => {
    expect(deriveRegulationRef('Regulation 411.3.3')).toBe('411.3.3');
    expect(deriveRegulationRef('Reg 411.3.3')).toBe('411.3.3');
  });

  test('"BS 7671 <num>" standard prefix is stripped to the bare key', () => {
    expect(deriveRegulationRef('BS 7671 411.3.3')).toBe('411.3.3');
  });

  test('4-component section ref (e.g. 701.411.3.3) preserved', () => {
    expect(deriveRegulationRef('701.411.3.3')).toBe('701.411.3.3');
  });

  test('non-numeric / bare-standard / empty → null', () => {
    expect(deriveRegulationRef('BS 7671 Part 6')).toBeNull();
    expect(deriveRegulationRef('BS 88-2')).toBeNull();
    expect(deriveRegulationRef('')).toBeNull();
    expect(deriveRegulationRef('   ')).toBeNull();
    expect(deriveRegulationRef(null)).toBeNull();
    expect(deriveRegulationRef(42)).toBeNull();
  });
});

describe('lookupRegulation — canonical table lookup', () => {
  test('HIT: 411.3.3 + model wording → canonical entry with title/description', () => {
    const hit = lookupRegulation('411.3.3 — model wording');
    expect(hit).not.toBeNull();
    expect(hit.ref).toBe('411.3.3');
    expect(typeof hit.title).toBe('string');
    expect(hit.title.length).toBeGreaterThan(0);
    expect(typeof hit.description).toBe('string');
  });

  test('MISS: 411.3.4 (schema example, absent from A2:2022 table) → null', () => {
    expect(lookupRegulation('411.3.4 — Additional protection')).toBeNull();
  });

  test('MISS: bare standard name → null', () => {
    expect(lookupRegulation('BS 7671 Part 6')).toBeNull();
  });
});
