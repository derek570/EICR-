'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Logo } from '@/components/brand/logo';
import { api } from '@/lib/api-client';
import { clearAuth, getUser } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { InstallButton } from '@/components/pwa/install-button';
import { OfflineIndicator } from '@/components/pwa/offline-indicator';
import { useOutboxReplay } from '@/lib/pwa/outbox-replay';

/**
 * Top-nav + page frame for all authenticated screens.
 * Single-stack navigation (no persistent tabs), matches iOS CertMate
 * which uses NavigationStack rather than TabView for the primary flow.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [userName, setUserName] = React.useState<string>('');

  React.useEffect(() => {
    const u = getUser();
    if (u) setUserName(u.name || u.email);
  }, []);

  /*
   * Phase 7c — drain the offline mutation outbox on mount, on `online`,
   * and on tab foregrounding. Mounted here rather than at the root
   * layout so the replay worker only runs for authenticated sessions
   * (AppShell is the auth-gated layout boundary). The hook is a no-op
   * when the outbox is empty, so there's no cost to mounting it on
   * every auth-gated navigation.
   */
  useOutboxReplay();

  async function handleSignOut() {
    try {
      await api.logout();
    } catch {
      // Proceed anyway — local clear is the important bit.
    }
    clearAuth();
    router.replace('/login');
  }

  const isDashboard = pathname === '/dashboard';

  return (
    <div className="relative flex min-h-dvh flex-col">
      <header
        className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-0)]/80 px-4 backdrop-blur"
        role="banner"
      >
        <div className="flex items-center gap-3">
          {!isDashboard ? (
            <Link
              href="/dashboard"
              aria-label="Back to dashboard"
              className="inline-flex h-10 w-10 items-center justify-center rounded-full text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]"
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </Link>
          ) : null}
          <Link href="/dashboard" aria-label="CertMate home">
            <Logo size="md" />
          </Link>
        </div>
        <div className="flex items-center gap-3">
          {/*
           * Offline pill — Phase 7b. Renders only when the browser
           * reports `navigator.onLine === false`. Placed FIRST in the
           * right cluster so the user's eye lands on connection state
           * before anything else (the SWR caches may be showing stale
           * data and the pill is how they know).
           */}
          <OfflineIndicator />
          {userName ? (
            <span className="hidden text-sm text-[var(--color-text-secondary)] sm:inline">
              {userName}
            </span>
          ) : null}
          {/*
           * Renders only when Chrome/Edge/Android has fired
           * `beforeinstallprompt` and the deferred event is live in the
           * install store. On Safari (desktop + iOS) it stays hidden —
           * Safari never fires the event, so users must install via
           * Share → Add to Home Screen (a Phase 7b hint is planned).
           */}
          <InstallButton />
          <Button variant="ghost" size="sm" onClick={handleSignOut}>
            Sign out
          </Button>
        </div>
      </header>
      <div className="flex-1">{children}</div>
    </div>
  );
}
