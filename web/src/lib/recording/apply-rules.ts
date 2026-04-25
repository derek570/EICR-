/**
 * 3-tier priority apply rules: pre-existing > Sonnet > regex.
 *
 * Port of iOS `DeepgramRecordingViewModel.applySonnetValue` /
 * `applyRegexValue` (R2 of `web/audit/REGEX_TIER_PLAN.md`). The TS port
 * keeps the priority truth-table verbatim and drops the iOS-side TTS
 * dedupe machinery — web's TTS dedupe lives in `recording-context.tsx`
 * and routes via the existing `confirmationToSentence` path.
 *
 * Both helpers are pure: they take the new value, the current value,
 * a FieldSourceMap, and an `apply` callback that performs the actual
 * write. They return a verb-rich outcome describing what happened so
 * apply-extraction can roll up discrepancy / overwrite counts and the
 * regex-hint builder (R5) can decide which fields to bundle.
 */

import { hasValue } from './apply-utils';
import type { FieldSourceMap } from './field-source';

export type ApplyOutcome = {
  /** Whether `apply` was invoked. */
  applied: boolean;
  /** Tag describing which branch of the priority chain fired. Useful
   *  for telemetry / discrepancy logging downstream. */
  reason:
    | 'first-set' /* empty → fill */
    | 'regex-last-wins' /* regex source, value differs */
    | 'sonnet-overwrite-regex' /* Sonnet wrote different value over a regex source */
    | 'sonnet-overwrite-preexisting' /* Sonnet wrote different value over a pre-existing source */
    | 'sonnet-confirmed-same' /* Sonnet read the same value back — flip source label */
    | 'blocked-duplicate-preexisting' /* Sonnet repeated a pre-existing value verbatim */
    | 'regex-locked-by-sonnet' /* regex tier saw a sonnet-source field; left alone */
    | 'regex-locked-by-preexisting' /* regex tier saw a preexisting-source field; left alone */;
};

export type ApplyArgs = {
  key: string;
  newValue: unknown;
  currentValue: unknown;
  sources: FieldSourceMap;
  apply: () => void;
};

/**
 * Regex-tier write. Mirrors iOS `applyRegexValue`:
 *  - currentValue empty → apply, fieldSources[key]=regex.
 *  - currentSource==regex AND newValue!=currentValue → apply, last-wins
 *    within regex (no source change).
 *  - any other source (sonnet / preExisting) → no-op.
 *
 * Returns whether `apply` ran + the priority-chain reason.
 */
export function applyRegexValue(args: ApplyArgs): ApplyOutcome {
  const { key, newValue, currentValue, sources, apply } = args;
  if (!hasValue(currentValue)) {
    apply();
    sources.set(key, 'regex', newValue);
    return { applied: true, reason: 'first-set' };
  }
  const currentSource = sources.get(key);
  if (currentSource === 'regex' && !sameValue(newValue, currentValue)) {
    apply();
    // Source stays 'regex' — last-wins within tier.
    return { applied: true, reason: 'regex-last-wins' };
  }
  if (currentSource === 'sonnet') {
    return { applied: false, reason: 'regex-locked-by-sonnet' };
  }
  return { applied: false, reason: 'regex-locked-by-preexisting' };
}

/**
 * Sonnet-tier write. Mirrors iOS `applySonnetValue`:
 *
 *  1. Compute `isPreExisting` = currentSource is preExisting OR unset
 *     AND currentValue is non-empty. Stamp as originallyPreExisting
 *     so question-suppression downstream survives the overwrite.
 *  2. If isPreExisting AND newValue == currentValue → block (Sonnet
 *     re-read what was already there). Source label stays.
 *  3. If currentValue empty → apply, source=sonnet (first-set).
 *  4. Else if newValue != currentValue → apply, source=sonnet
 *     (overwrite). Reason carries which kind of overwrite happened
 *     so the caller can increment the discrepancy counter.
 *  5. Else (currentValue non-empty AND newValue == currentValue):
 *     don't re-apply, but flip a regex-source label to sonnet
 *     (Sonnet has now confirmed the value — future Sonnet writes go
 *     through the regular sonnet→sonnet path, not the regex
 *     last-wins path). Pre-existing remains pre-existing.
 *
 * Returns whether `apply` ran + the priority-chain reason.
 */
export function applySonnetValue(args: ApplyArgs): ApplyOutcome {
  const { key, newValue, currentValue, sources, apply } = args;
  const currentSource = sources.get(key);
  const isPreExisting =
    (currentSource === 'preExisting' || currentSource === undefined) && hasValue(currentValue);

  if (isPreExisting) {
    sources.markOriginallyPreExisting(key);
  }

  // Block only true duplicates over a pre-existing value.
  if (isPreExisting && sameValue(newValue, currentValue)) {
    return { applied: false, reason: 'blocked-duplicate-preexisting' };
  }

  if (!hasValue(currentValue)) {
    apply();
    sources.set(key, 'sonnet', newValue);
    return { applied: true, reason: 'first-set' };
  }

  if (!sameValue(newValue, currentValue)) {
    apply();
    sources.set(key, 'sonnet', newValue);
    if (currentSource === 'regex') {
      return { applied: true, reason: 'sonnet-overwrite-regex' };
    }
    return { applied: true, reason: 'sonnet-overwrite-preexisting' };
  }

  // Sonnet confirmed the same value — flip a regex source to sonnet
  // so it's no longer eligible for regex last-wins. iOS does this so
  // the field is "locked in" once Sonnet has agreed once.
  if (currentSource === 'regex') {
    sources.set(key, 'sonnet', newValue);
  }
  return { applied: false, reason: 'sonnet-confirmed-same' };
}

/** Loose equality for the apply-rules priority comparison. iOS uses
 *  Swift String.== which is exact. We coerce both sides to strings
 *  and trim so a "0.27" Sonnet response matches a "0.27 " typed
 *  pre-existing value (with a stray space) without firing
 *  preexisting_overwrite. Numeric / boolean values fall through
 *  identity. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a === 'string' && typeof b === 'string') {
    return a.trim() === b.trim();
  }
  if (
    (typeof a === 'string' && typeof b === 'number') ||
    (typeof a === 'number' && typeof b === 'string')
  ) {
    return String(a).trim() === String(b).trim();
  }
  return false;
}
