// value-normalise.test.js
// Covers the shared helper used by filled-slots-filter.js (heard_value
// cross-reference) and question-gate.js (heard_value re-ask dedup). The
// two defences must agree on equivalence, so regressions here break
// both at once — keep the cases wide.

import { normaliseValue } from '../extraction/value-normalise.js';

describe('normaliseValue', () => {
  test('returns "" for null / undefined / empty / whitespace', () => {
    expect(normaliseValue(null)).toBe('');
    expect(normaliseValue(undefined)).toBe('');
    expect(normaliseValue('')).toBe('');
    expect(normaliseValue('   ')).toBe('');
  });

  test('canonicalises numeric forms: trailing-zero collapse + string/number parity', () => {
    expect(normaliseValue(0.13)).toBe('0.13');
    expect(normaliseValue('0.13')).toBe('0.13');
    expect(normaliseValue('0.130')).toBe('0.13');
    expect(normaliseValue(' 0.13 ')).toBe('0.13');
    expect(normaliseValue('0.13000')).toBe('0.13');
  });

  test('strips a short unit suffix after a number', () => {
    expect(normaliseValue('0.13 ohms')).toBe('0.13');
    expect(normaliseValue('0.13Ω')).toBe('0.13');
    expect(normaliseValue('0.13 mV')).toBe('0.13');
  });

  test('preserves ">" and "<" prefixes (different semantics from the bare number)', () => {
    // IR readings on a megger hit the upper bound ">200" — must NOT
    // equate to "200" or anything else.
    expect(normaliseValue('>200')).toBe('>200');
    expect(normaliseValue('<0.01')).toBe('<0.01');
    expect(normaliseValue('>200')).not.toBe(normaliseValue('200'));
  });

  test('lowercases and trims non-numeric strings without destroying them', () => {
    expect(normaliseValue('LIM')).toBe('lim');
    expect(normaliseValue('TT')).toBe('tt');
    expect(normaliseValue(' TN-S ')).toBe('tn-s');
  });

  test('collapses internal whitespace on multi-word phrases (observation text)', () => {
    expect(normaliseValue('sockets   not   identified')).toBe('sockets not identified');
    expect(normaliseValue('  two spaces  between  words  ')).toBe('two spaces between words');
  });

  test('numeric equality across forms matters for cross-module dedup', () => {
    // Both modules rely on this — if these drift the gate and the filter
    // will disagree about whether "0.13" and 0.13 are the same value.
    const forms = [0.13, '0.13', '0.130', ' 0.13 ', '0.13 ohms'];
    const normalised = forms.map(normaliseValue);
    expect(new Set(normalised).size).toBe(1);
  });

  test('non-numeric tails fall back to the raw string (safety over over-matching)', () => {
    // "0.13 and something" is not a clean reading — don't silently drop
    // the tail, treat it as a different value from "0.13".
    expect(normaliseValue('0.13 and something')).not.toBe('0.13');
  });

  test('negative numbers and scientific notation', () => {
    expect(normaliseValue('-0.5')).toBe('-0.5');
    expect(normaliseValue('-0.50')).toBe('-0.5');
    // Scientific notation: Number.toString may render as "0.0000001" or
    // "1e-7" depending on magnitude — accept whatever toString gives us
    // so long as the SAME input produces the SAME output.
    const a = normaliseValue('1e-7');
    const b = normaliseValue(1e-7);
    expect(a).toBe(b);
  });
});
