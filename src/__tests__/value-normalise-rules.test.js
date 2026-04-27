// Tests for the shared sentinel + evasion classification rules. These rules
// are mirrored on iOS via scripts/generate-ios-value-rules.mjs — any change
// here must be propagated to the Swift side, asserted by the schema-parity
// CI check.

import {
  acceptsAsWrite,
  isEvasionMarker,
  isValidSentinel,
  STAGE6_VALUE_RULES,
} from '../extraction/value-normalise.js';

describe('isValidSentinel', () => {
  test.each([
    ['N/A', true],
    ['n/a', true],
    ['NA', true],
    ['na', true],
    ['LIM', true],
    ['lim', true],
    ['  N/A  ', true],
    ['∞', true],
    ['inf', true],
    ['infinity', true],
    // Numeric values are NOT sentinels (they're real readings).
    ['0.13', false],
    ['>200', false],
    ['<1.0', false],
    // Evasion markers are NOT sentinels (different semantic).
    ['unknown', false],
    ['incomplete', false],
    // Edge cases.
    ['', false],
    [null, false],
    [undefined, false],
  ])('isValidSentinel(%j) === %j', (input, expected) => {
    expect(isValidSentinel(input)).toBe(expected);
  });
});

describe('isEvasionMarker', () => {
  test.each([
    ['incomplete', true],
    ['Incomplete', true],
    ['INCOMPLETE', true],
    ['unknown', true],
    ['partial', true],
    ['unclear', true],
    ['not specified', true],
    ['not provided', true],
    ['not given', true],
    ['not stated', true],
    ['pending', true],
    ['tbd', true],
    ['tbc', true],
    // Sentinels are NOT evasion markers.
    ['N/A', false],
    ['LIM', false],
    ['∞', false],
    // Real values are NOT evasion markers.
    ['0.13', false],
    ['>200', false],
    ['Cooker', false],
    ['', false],
    [null, false],
  ])('isEvasionMarker(%j) === %j', (input, expected) => {
    expect(isEvasionMarker(input)).toBe(expected);
  });
});

describe('acceptsAsWrite — composite gate', () => {
  test('accepts numeric values', () => {
    expect(acceptsAsWrite('0.13')).toBe(true);
    expect(acceptsAsWrite('>200')).toBe(true);
    expect(acceptsAsWrite('250')).toBe(true);
  });

  test('accepts sentinel values (the bug-2A regression)', () => {
    expect(acceptsAsWrite('N/A')).toBe(true);
    expect(acceptsAsWrite('n/a')).toBe(true);
    expect(acceptsAsWrite('LIM')).toBe(true);
    expect(acceptsAsWrite('∞')).toBe(true);
  });

  test('rejects evasion markers', () => {
    expect(acceptsAsWrite('incomplete')).toBe(false);
    expect(acceptsAsWrite('unknown')).toBe(false);
    expect(acceptsAsWrite('not specified')).toBe(false);
  });

  test('rejects empty / null', () => {
    expect(acceptsAsWrite('')).toBe(false);
    expect(acceptsAsWrite('   ')).toBe(false);
    expect(acceptsAsWrite(null)).toBe(false);
    expect(acceptsAsWrite(undefined)).toBe(false);
  });

  test("accepts arbitrary text values (they are someone else's problem to validate)", () => {
    // The gate is permissive on free text — field-level enum checks happen
    // downstream in the dispatcher's validateRecordReading. This gate's only
    // job is filtering empty / evasive content.
    expect(acceptsAsWrite('TN-C-S')).toBe(true);
    expect(acceptsAsWrite('Cooker')).toBe(true);
    expect(acceptsAsWrite('the cooker')).toBe(true);
  });
});

describe('STAGE6_VALUE_RULES exposed snapshot', () => {
  test('frozen and stable shape', () => {
    expect(Object.isFrozen(STAGE6_VALUE_RULES)).toBe(true);
    expect(Object.keys(STAGE6_VALUE_RULES).sort()).toEqual(['EVASION_MARKERS', 'VALID_SENTINELS']);
  });

  test('VALID_SENTINELS includes the 2026-04-27 regression cases', () => {
    expect(STAGE6_VALUE_RULES.VALID_SENTINELS).toContain('n/a');
    expect(STAGE6_VALUE_RULES.VALID_SENTINELS).toContain('lim');
  });

  test('"n/a" is NOT on the evasion list — bug-2A invariant', () => {
    // This is the class-of-bug test. The Ivydene Road regression came from
    // iOS treating "N/A" as an evasion marker because its local nonValueStrings
    // set was out of sync with this file. The cross-file equality is enforced
    // by scripts/generate-ios-value-rules.mjs + schema-parity CI.
    expect(STAGE6_VALUE_RULES.EVASION_MARKERS).not.toContain('n/a');
    expect(STAGE6_VALUE_RULES.EVASION_MARKERS).not.toContain('na');
    expect(STAGE6_VALUE_RULES.EVASION_MARKERS).not.toContain('lim');
  });
});
