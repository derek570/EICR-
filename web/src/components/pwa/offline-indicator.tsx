'use client';

import * as React from 'react';
import Link from 'next/link';
import { AlertTriangle, CloudUpload, WifiOff } from 'lucide-react';
import { useOnlineStatus } from '@/lib/pwa/use-online-status';
import { useOutboxState } from '@/lib/pwa/use-outbox-state';

/**
 * Sync-status cluster (Phase 7b amber offline pill + Phase 7d pending /
 * poisoned counters + Phase 9 mobile banner variant). Exported as
 * `OfflineIndicator` for header-import compatibility; despite the name
 * it now renders up to three related pills depending on connectivity +
 * outbox state.
 *
 * Phase 9 mobile shape parity (`OfflineBanner.swift` on iOS):
 *   - Below the `md` breakpoint the offline pill is suppressed inside
 *     `OfflineIndicator` and replaced by a full-width `OfflineBanner`
 *     rendered via the exported `<OfflineBanner />` component. The
 *     banner is positioned by `AppShell` at the top of the viewport so
 *     it matches iOS's slide-in layout without interfering with the
 *     desktop header pill.
 *   - The pending/poisoned pills continue to live inside the header
 *     cluster on every breakpoint — those are status counters, not a
 *     connection-state callout, so a banner treatment would be over
 *     the top on mobile.
 *
 * Render matrix (all three pills can stack; in practice only one or two
 * appear at a time):
 *
 *   - Offline + no pending  : amber "Offline" pill.
 *   - Offline + pending > 0 : amber pill with a small blue dot badge
 *                             (overlay, not a separate pill) — matches
 *                             the 7c handoff recommendation. The dot
 *                             communicates "queued work waiting for
 *                             connectivity" without occupying more
 *                             header space on mobile.
 *   - Online  + pending > 0 : secondary blue pill "N syncing" — tells
 *                             the inspector their earlier offline edits
 *                             are still in flight so they don't panic
 *                             when the browser pill disappears but the
 *                             server hasn't caught up yet. Auto-hides
 *                             when the replay worker drains the queue.
 *   - Poisoned > 0          : red link-pill "N failed" pointing at
 *                             `/settings/system`. Renders regardless of
 *                             online state because poisoned rows never
 *                             drain on their own — the admin UI is the
 *                             only way to resolve them.
 *
 * Accessibility:
 *   - Each pill has its own `role="status"` + `aria-live="polite"` so
 *     screen readers announce state transitions without interrupting
 *     speech. Poisoned pill is a link, so it's keyboard-reachable via
 *     Tab — discoverable even for users who don't use a pointer.
 *   - Counts are baked into the accessible name (e.g. "3 pending edits
 *     syncing") rather than shown only visually — matches WCAG 2.1 AA
 *     guidance that status changes be announced meaningfully.
 *   - The blue dot on the offline pill is `aria-hidden`; the pending
 *     count is already in the pill's `aria-label` so the dot is pure
 *     visual reinforcement.
 *
 * Why no "back online + all synced" toast:
 *   - Serwist's `reloadOnOnline: true` (`next.config.ts`, set in 7a)
 *     reloads the page when the browser fires `online`. A toast would
 *     flash for a frame before the reload. The pills simply disappearing
 *     IS the confirmation.
 *
 * `navigator.onLine` caveats apply — see `useOnlineStatus` for the full
 * rationale. The pending/poisoned counts come from a real IDB read so
 * they're accurate regardless of what the browser thinks the connection
 * looks like.
 */
export function OfflineIndicator() {
  const isOnline = useOnlineStatus();
  const { pending, poisoned, loading } = useOutboxState();
  const pendingCount = pending.length;
  const poisonedCount = poisoned.length;

  // Nothing to show on the hot path — keep the header clean.
  if (isOnline && pendingCount === 0 && poisonedCount === 0) return null;
  // While the first IDB read is pending, only render the offline pill
  // (if applicable). Suppresses a one-frame flicker on cold load where
  // the pending/poisoned counts briefly default to 0 then populate.
  const showPendingPills = !loading;

  return (
    <div className="flex items-center gap-1.5">
      {/*
       * Phase 9: hide the offline pill on phones (< md) — the
       * `<OfflineBanner />` below renders the full-width iOS shape
       * instead. The pill stays visible from `md` up so desktop users
       * see the status inline in the header without a banner pushing
       * content down.
       */}
      {!isOnline ? (
        <div className="hidden md:block">
          <OfflinePill pendingCount={showPendingPills ? pendingCount : 0} />
        </div>
      ) : null}
      {isOnline && showPendingPills && pendingCount > 0 ? (
        <PendingPill count={pendingCount} />
      ) : null}
      {showPendingPills && poisonedCount > 0 ? <PoisonedPill count={poisonedCount} /> : null}
    </div>
  );
}

/**
 * Mobile-only full-width offline banner (Phase 9). Renders nothing on
 * `md+` viewports — the inline header pill covers that case — and
 * nothing at all when the browser is online. Placed by `AppShell` at
 * the top of the viewport so it slides in above page content,
 * matching the iOS `OfflineBanner.swift` shape.
 */
export function OfflineBanner() {
  const isOnline = useOnlineStatus();
  const { pending, loading } = useOutboxState();
  if (isOnline) return null;
  const pendingCount = loading ? 0 : pending.length;
  const label =
    pendingCount > 0
      ? `You are offline. ${pendingCount} edit${pendingCount === 1 ? '' : 's'} queued — will sync when your connection returns.`
      : 'You are offline. Showing cached data; changes will not sync until your connection returns.';
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label}
      className="md:hidden flex w-full items-center justify-center gap-2 border-b border-[var(--color-status-processing)]/40 bg-[var(--color-status-processing)]/15 px-3 py-2 text-[12px] font-semibold text-[var(--color-status-processing)]"
    >
      <WifiOff className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden />
      <span>
        Offline
        {pendingCount > 0 ? ` · ${pendingCount} queued` : ' · showing cached data'}
      </span>
    </div>
  );
}

function OfflinePill({ pendingCount }: { pendingCount: number }) {
  const hasPending = pendingCount > 0;
  const label = hasPending
    ? `You are offline. ${pendingCount} edit${pendingCount === 1 ? '' : 's'} queued — will sync when your connection returns.`
    : 'You are offline. Showing cached data; changes will not sync until your connection returns.';
  return (
    <span
      role="status"
      aria-live="polite"
      aria-label={label}
      title={hasPending ? `Offline — ${pendingCount} queued` : 'Offline — showing cached data'}
      className="relative inline-flex items-center gap-1.5 rounded-full border border-[var(--color-status-processing)]/40 bg-[var(--color-status-processing)]/15 px-2.5 py-1 text-[12px] font-semibold text-[var(--color-status-processing)]"
    >
      <WifiOff className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden />
      <span className="hidden sm:inline">Offline</span>
      {hasPending ? (
        <span
          aria-hidden
          className="absolute -right-0.5 -top-0.5 inline-flex h-2.5 w-2.5 items-center justify-center rounded-full border border-[var(--color-surface-0)] bg-[var(--color-brand-blue)]"
        />
      ) : null}
    </span>
  );
}

function PendingPill({ count }: { count: number }) {
  const label = `${count} pending edit${count === 1 ? '' : 's'} — will sync shortly`;
  return (
    <span
      role="status"
      aria-live="polite"
      aria-label={label}
      title={label}
      className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-brand-blue)]/40 bg-[var(--color-brand-blue)]/15 px-2.5 py-1 text-[12px] font-semibold text-[var(--color-brand-blue)]"
    >
      <CloudUpload className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden />
      <span className="hidden sm:inline">Syncing</span>
      <span>{count}</span>
    </span>
  );
}

function PoisonedPill({ count }: { count: number }) {
  const label = `${count} edit${count === 1 ? '' : 's'} failed — tap to review and retry`;
  return (
    <Link
      href="/settings/system"
      role="status"
      aria-live="polite"
      aria-label={label}
      title={label}
      className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-status-failed)]/40 bg-[var(--color-status-failed)]/15 px-2.5 py-1 text-[12px] font-semibold text-[var(--color-status-failed)] hover:bg-[var(--color-status-failed)]/25 focus-visible:outline-2 focus-visible:outline-[var(--color-status-failed)]"
    >
      <AlertTriangle className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden />
      <span className="hidden sm:inline">Failed</span>
      <span>{count}</span>
    </Link>
  );
}
