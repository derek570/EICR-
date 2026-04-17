'use client';

import * as React from 'react';

/**
 * Subscribes to `navigator.onLine` and the `online` / `offline` window
 * events so components can render based on current connectivity.
 *
 * Returns a simple boolean — most callers just want to know if they're
 * online right now. Consumers that need "was offline, just came back"
 * semantics can derive it locally by holding the previous value in a
 * ref; keeping this hook small avoids tempting callers to depend on
 * transient state that's easy to get wrong across remounts.
 *
 * SSR / first-paint:
 *   - On the server and during the first client render, `navigator`
 *     doesn't exist, so we default to `true` (optimistic). If the user
 *     really is offline, the `offline` event (or the initial
 *     `navigator.onLine` check inside the effect) will flip state
 *     within a tick — the alternative of defaulting to `false` would
 *     show the offline indicator for one frame on every cold render.
 *   - This mirrors what React's own `useSyncExternalStore` pattern
 *     would do, kept as a plain `useState` so callers don't eat the
 *     extra subscription cost of `useSyncExternalStore` for a binary
 *     flag that changes at most a handful of times per session.
 *
 * `navigator.onLine` caveats (same in every browser):
 *   - `true` just means "the device has a network interface assigned",
 *     NOT "the backend is reachable". A captive-portal wifi is
 *     reported as online even though requests 401 or time out.
 *   - For that reason the UI uses this hook for a visible pill ONLY;
 *     actual retry logic should always be driven by a real failed
 *     fetch (see dashboard / job-layout SWR paths in 7b).
 */
export function useOnlineStatus(): boolean {
  const [isOnline, setIsOnline] = React.useState<boolean>(true);

  React.useEffect(() => {
    if (typeof navigator === 'undefined') return;
    // Correct the optimistic SSR default on first mount.
    setIsOnline(navigator.onLine);

    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return isOnline;
}
