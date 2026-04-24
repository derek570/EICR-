'use client';

import * as React from 'react';
import { api } from '@/lib/api-client';

/**
 * Phase 4 parity — client-side UK postcode autocomplete for the
 * Installation tab. Mirrors `InstallationTab.swift:L219-L306` on iOS.
 *
 * Behaviour:
 *  - Caller passes the raw postcode string on every keystroke. The hook
 *    normalises the input to the canonical "AA1 1AA" form (uppercase,
 *    single space before the last three chars) and defers the actual
 *    lookup by `delay` ms so fast typing only fires ONE network call.
 *  - Only postcodes that pass the loose UK regex are looked up — the
 *    backend is still the source of truth (postcodes.io will 404 for
 *    anything invalid), but this prevents firing lookups for obvious
 *    garbage while the user types.
 *  - Results are memoised per canonical postcode. If the user leaves
 *    the field and re-types the same postcode, no second call fires.
 *  - `onResolved` fires once the backend returns a hit; callers use it
 *    to merge town/county into the shape. The canonical postcode string
 *    is also passed back so callers can replace the user's raw input
 *    with the nicely-formatted version.
 *  - Failures are swallowed — autocomplete is best-effort, and the
 *    user can still type town/county manually. We don't want an alert
 *    for every typo.
 *
 * Why a hook and not an inline effect on the page? The Installation
 * tab has two separate postcode fields (client + installation) that
 * need the same debounce / memo plumbing; the hook gives each field
 * its own independent memo without duplicating the regex + debounce.
 */

const POSTCODE_REGEX = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/;

export function normalisePostcode(raw: string): string | null {
  const stripped = raw.toUpperCase().trim();
  const compact = stripped.replace(/\s+/g, '');
  if (compact.length < 5 || compact.length > 8) return null;
  let spaced: string;
  if (compact.length > 3) {
    const inward = compact.slice(-3);
    const outward = compact.slice(0, -3);
    spaced = `${outward} ${inward}`;
  } else {
    spaced = compact;
  }
  return POSTCODE_REGEX.test(spaced) ? spaced : null;
}

export interface PostcodeLookupResult {
  postcode: string;
  town: string;
  county: string;
}

export interface UsePostcodeLookupOptions {
  /** Debounce window in ms. Defaults to 400 to match iOS. */
  delay?: number;
  /** Callback fired when the lookup resolves to a hit. */
  onResolved: (result: PostcodeLookupResult) => void;
  /**
   * Optional override for the lookup function — used in tests so we
   * don't need to mock fetch/MSW. In production the default points
   * at the typed `api.lookupPostcode` wrapper.
   */
  lookup?: (postcode: string) => Promise<PostcodeLookupResult | null>;
}

export interface UsePostcodeLookupReturn {
  /**
   * Feed the raw input value in here on every keystroke. The hook
   * handles the debounce + memo internally.
   */
  onChange: (raw: string) => void;
}

export function usePostcodeLookup({
  delay = 400,
  onResolved,
  lookup = api.lookupPostcode.bind(api),
}: UsePostcodeLookupOptions): UsePostcodeLookupReturn {
  // Latest callback refs — we want the debounced fn to always call the
  // freshest handlers even if the parent re-renders.
  const onResolvedRef = React.useRef(onResolved);
  const lookupRef = React.useRef(lookup);
  React.useEffect(() => {
    onResolvedRef.current = onResolved;
    lookupRef.current = lookup;
  });

  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLookedUpRef = React.useRef<string | null>(null);

  // Cleanup on unmount so we don't fire a network call after the
  // component has gone.
  React.useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const onChange = React.useCallback(
    (raw: string) => {
      const normalised = normalisePostcode(raw);
      // Always cancel any in-flight debounce FIRST — if the user
      // corrupts a previously-valid postcode, a queued lookup must not
      // still fire 400ms later and overwrite the field they just
      // cleared.
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (!normalised) return;
      if (normalised === lastLookedUpRef.current) return;

      timerRef.current = setTimeout(() => {
        void (async () => {
          try {
            const result = await lookupRef.current(normalised);
            if (!result) return;
            lastLookedUpRef.current = normalised;
            onResolvedRef.current(result);
          } catch {
            // Swallow — autocomplete is best-effort.
          }
        })();
      }, delay);
    },
    [delay]
  );

  return { onChange };
}
