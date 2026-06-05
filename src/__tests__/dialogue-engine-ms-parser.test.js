/**
 * Tests for parseMs (RCD trip time parser).
 */

import { parseMs } from '../extraction/dialogue-engine/parsers/ms.js';

describe('parseMs', () => {
  test('parses "25 ms" → "25"', () => {
    expect(parseMs('25 ms')).toBe('25');
  });

  test('parses "25ms" (no space)', () => {
    expect(parseMs('25ms')).toBe('25');
  });

  test('parses "30 milliseconds"', () => {
    expect(parseMs('30 milliseconds')).toBe('30');
  });

  test('parses "30 millisecond" (singular)', () => {
    expect(parseMs('30 millisecond')).toBe('30');
  });

  test('parses bare "25" (slot-bare-value path)', () => {
    expect(parseMs('25')).toBe('25');
  });

  test('parses decimal "12.5 ms" → "12.5"', () => {
    expect(parseMs('12.5 ms')).toBe('12.5');
  });

  test('strips trailing zero: "25.0 ms" → "25"', () => {
    expect(parseMs('25.0 ms')).toBe('25');
  });

  test('rejects 0 (below 1 ms range)', () => {
    expect(parseMs('0 ms')).toBe(null);
  });

  test('rejects over 1000 ms', () => {
    expect(parseMs('1500 ms')).toBe(null);
  });

  test('returns null for non-numeric text', () => {
    expect(parseMs('cable looks fine')).toBe(null);
  });

  test('returns null for empty string', () => {
    expect(parseMs('')).toBe(null);
  });

  test('returns null for non-string input', () => {
    expect(parseMs(null)).toBe(null);
    expect(parseMs(undefined)).toBe(null);
    expect(parseMs(42)).toBe(null);
  });

  test('handles "m s" with space (Flux artefact)', () => {
    expect(parseMs('25 m s')).toBe('25');
  });

  test('extracts from natural sentence', () => {
    // The schema's namedExtractor handles "trip time" prefix matching;
    // parseMs is called on just the captured value group, but for
    // robustness it also tolerates being handed a longer string.
    expect(parseMs('about 25 ms or so')).toBe('25');
  });
});
