/**
 * Single-round latency sprint Phase 1 (PLAN_v8 §A Pivot 2) — eligibility
 * whitelist contract.
 *
 * The whitelist gates the fast-TTS route. Pinning the exact set here
 * prevents accidental widening (which would surface bad reads to the
 * inspector before Sonnet has had a chance to override) AND accidental
 * narrowing (which would silently drop fast-path traffic onto the
 * bundler at the cost of ~500ms audible-first-byte).
 */

import {
  REGEX_FAST_ELIGIBLE_FIELDS,
  isRegexFastEligible,
} from '../extraction/regex-fast-eligibility.js';

describe('REGEX_FAST_ELIGIBLE_FIELDS', () => {
  test('contains exactly the five whitelisted numeric-circuit-ref fields', () => {
    expect([...REGEX_FAST_ELIGIBLE_FIELDS].sort()).toEqual(
      [
        'ir_live_earth_mohm',
        'ir_live_live_mohm',
        'measured_zs_ohm',
        'number_of_points',
        'r1_r2_ohm',
      ].sort()
    );
  });

  test('set is frozen (defensive — eligibility cannot drift at runtime)', () => {
    expect(Object.isFrozen(REGEX_FAST_ELIGIBLE_FIELDS)).toBe(true);
  });
});

describe('isRegexFastEligible', () => {
  test('returns true for every whitelisted field', () => {
    for (const f of REGEX_FAST_ELIGIBLE_FIELDS) {
      expect(isRegexFastEligible(f)).toBe(true);
    }
  });

  test('returns false for unknown field names', () => {
    expect(isRegexFastEligible('unknown_field')).toBe(false);
    expect(isRegexFastEligible('designation')).toBe(false);
  });

  test('returns false for explicitly excluded fields (polarity / rcd time)', () => {
    // Excluded by design — see module header for rationale.
    expect(isRegexFastEligible('polarity_confirmed')).toBe(false);
    expect(isRegexFastEligible('rcd_time_ms')).toBe(false);
  });

  test('returns false for non-string / empty input', () => {
    expect(isRegexFastEligible(null)).toBe(false);
    expect(isRegexFastEligible(undefined)).toBe(false);
    expect(isRegexFastEligible('')).toBe(false);
    expect(isRegexFastEligible(123)).toBe(false);
    expect(isRegexFastEligible({})).toBe(false);
    expect(isRegexFastEligible([])).toBe(false);
  });
});
