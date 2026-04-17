'use client';

import * as React from 'react';
import { WifiOff } from 'lucide-react';
import { useOnlineStatus } from '@/lib/pwa/use-online-status';

/**
 * Compact pill that appears in the AppShell header whenever the browser
 * reports the device as offline. Designed to sit flush with other header
 * cluster items (user name, <InstallButton />, Sign-out) so it doesn't
 * re-layout the header when it pops in/out.
 *
 * Design choices:
 *   - Amber (`--color-status-processing`) instead of red. Red communicates
 *     "something broke" (destructive / error); amber communicates
 *     "degraded — be aware". Offline with a cached render is degraded,
 *     not broken — the inspector can still review and browse. Red would
 *     read as panic-inducing for a state the SWR layer (7b IDB cache)
 *     gracefully handles.
 *   - Small text on desktop, icon-only below the `sm` breakpoint. The
 *     mobile header has strict space constraints (56px tall, Logo +
 *     user-name + install + sign-out already pack the right cluster);
 *     icon-only keeps the pill readable at tap-target size without
 *     pushing Sign-out off-screen on a 320px iPhone SE.
 *   - `title` + `aria-label` always carry the full string so hover and
 *     screen readers aren't starved even when the label is icon-only.
 *   - `aria-live="polite"` on the wrapper so screen readers announce
 *     state transitions without interrupting any in-flight speech.
 *     Deliberately NOT `assertive` — offline is informational, not an
 *     immediate action the user must take.
 *
 * Why not also show a "back online" confirmation:
 *   - Serwist's `reloadOnOnline: true` (set in `next.config.ts` since
 *     7a) already triggers `window.location.reload()` when the browser
 *     fires `online` after being offline. By the time any "reconnected"
 *     toast would render, the page is already reloading — the toast
 *     would flash for a frame or two and disappear. The visible pill
 *     disappearing IS the confirmation.
 *
 * `navigator.onLine` truthiness caveat (repeated from the hook):
 *   - `true` means "the device claims to have a network interface", NOT
 *     "requests will succeed". Captive-portal wifi, hotel DNS hijack,
 *     and ISP blocks all look "online" to the browser. The SWR paths
 *     in 7b handle actual request failures; this pill only handles the
 *     clear-cut "no interface at all" case.
 */
export function OfflineIndicator() {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;
  return (
    <span
      role="status"
      aria-live="polite"
      aria-label="You are offline. Showing cached data; changes will not sync until your connection returns."
      title="Offline — showing cached data"
      className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-status-processing)]/40 bg-[var(--color-status-processing)]/15 px-2.5 py-1 text-[12px] font-semibold text-[var(--color-status-processing)]"
    >
      <WifiOff className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden />
      <span className="hidden sm:inline">Offline</span>
    </span>
  );
}
