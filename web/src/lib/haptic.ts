/**
 * haptic() — Phase 9 cross-cutting.
 *
 * Thin, best-effort wrapper around `navigator.vibrate()`. Mirrors the
 * intent of iOS `UIImpactFeedbackGenerator` but acknowledges the web
 * reality: the Vibration API is only implemented on Chrome/Firefox
 * Android. iOS Safari returns `undefined` (API is undefined) and
 * desktop browsers generally lack hardware anyway.
 *
 * Callsite contract:
 *   - Fire on destructive confirms, save successes, and long-press
 *     gestures where a light tactile hint improves confidence.
 *   - Never rely on the vibration firing — it's a progressive
 *     enhancement. All flows must work identically without it.
 *   - The helper silently no-ops on unsupported platforms; callers
 *     do not need to guard.
 *
 * The three preset strengths (light/medium/heavy) map roughly to the
 * iOS `UIImpactFeedbackGenerator.FeedbackStyle` so future refactors
 * can pick the same vocabulary across platforms.
 */

export type HapticStrength = 'light' | 'medium' | 'heavy' | 'success' | 'warning';

const PATTERNS: Record<HapticStrength, number | number[]> = {
  // Single short pulse — used for affirmative confirms + toggle flips.
  light: 10,
  // Slightly longer pulse — destructive confirms, delete actions.
  medium: 18,
  // Long pulse — save failures / errors. Kept under 35ms so it's never
  // jarring on Android where the motor is punchier than iOS's Taptic.
  heavy: 30,
  // Double-tap pattern — used for successful saves to give a distinct
  // "ok, that worked" feeling vs a generic button tap.
  success: [10, 40, 10],
  // Rapid double-buzz — error/retry. Differentiates from `success` by
  // having a shorter gap and equal-weight pulses.
  warning: [15, 30, 15],
};

/**
 * Fire a haptic pulse if the platform supports it.
 *
 * Safe to call unconditionally from render paths — executes in a
 * try/catch so a browser that throws on an unrecognised pattern
 * (rare, but seen on some older WebViews) doesn't break the caller.
 *
 * Returns `true` if the browser reported the request as scheduled,
 * `false` otherwise. Most callers should ignore the return value —
 * it's only useful for the unit tests that assert degradation.
 */
export function haptic(strength: HapticStrength = 'light'): boolean {
  if (typeof navigator === 'undefined') return false;
  // Cast to a local shape rather than the DOM-lib Navigator so we can
  // pass either a `number` or `number[]` — the spec lets the
  // browser accept both, but the DOM typings narrow to `Iterable`.
  const nav = navigator as unknown as {
    vibrate?: (pattern: number | number[]) => boolean;
  };
  const vibrate = nav.vibrate;
  if (typeof vibrate !== 'function') return false;
  try {
    const pattern = PATTERNS[strength];
    return Boolean(vibrate.call(nav, pattern));
  } catch {
    return false;
  }
}
