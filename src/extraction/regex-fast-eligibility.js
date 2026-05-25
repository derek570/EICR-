/**
 * Regex fast-TTS eligibility whitelist.
 *
 * Single-round latency sprint Phase 1 (PLAN_v8 §A Pivot 2).
 *
 * The Mode-A fast-TTS path bypasses the bundler + dispatcher for
 * specific high-confidence numeric readings where:
 *
 *   (a) iOS's TranscriptFieldMatcher regex extraction is ~100%
 *       accurate (i.e. the value text "0.13" can only mean the
 *       measured Zs the inspector dictated; no ambiguity for
 *       Sonnet to resolve later);
 *   (b) the cert-row consequence of speaking a wrong value is low
 *       (a numeric reading that Sonnet later overwrites in the
 *       background is mildly confusing but not safety-critical);
 *   (c) iOS has a deterministic numeric-circuit-ref regex pattern
 *       in `TranscriptFieldMatcher.swift` that produces the value
 *       client-side BEFORE the server sees the transcript.
 *
 * Fields explicitly EXCLUDED from the whitelist even though iOS may
 * extract them via regex:
 *
 *   - polarity_confirmed — booleans drift. iOS "Y" might map to a
 *     different value than Sonnet's interpretation, and saying "polarity
 *     confirmed" before Sonnet has agreed creates a UX where the
 *     subsequent extraction looks like it's been overridden.
 *   - rcd_time_ms — no iOS regex pattern yet (P1.9 adds patterns only
 *     for the five fields listed below); whitelisting without a matcher
 *     is dead code that would silently never fire.
 *
 * Eligibility is a hard whitelist — the route returns 422 for any
 * field not in this set, the iOS client receives the rejection and
 * (per Pivot 5) silently abandons rather than falling back to a
 * native TTS announcement.
 */

/**
 * The set of field names eligible for the regex fast-TTS path. Each
 * must have:
 *   - a matching pattern in iOS Sources/Recording/TranscriptFieldMatcher.swift
 *   - a confirmation-text recipe in src/extraction/confirmation-text.js
 *     that `buildConfirmationText` understands
 *
 * Field name canonical form matches `config/field_schema.json` circuit_fields
 * keys.
 */
export const REGEX_FAST_ELIGIBLE_FIELDS = Object.freeze(
  new Set([
    'measured_zs_ohm',
    'r1_r2_ohm',
    'ir_live_earth_mohm',
    'ir_live_live_mohm',
    'number_of_points',
  ])
);

/**
 * Eligibility predicate. Returns true iff `fieldName` is on the
 * whitelist. Always returns false for null/undefined/non-string input
 * so callers don't have to pre-validate.
 *
 * @param {unknown} fieldName
 * @returns {boolean}
 */
export function isRegexFastEligible(fieldName) {
  if (typeof fieldName !== 'string' || fieldName.length === 0) return false;
  return REGEX_FAST_ELIGIBLE_FIELDS.has(fieldName);
}
