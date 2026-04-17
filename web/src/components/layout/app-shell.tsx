'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Logo } from '@/components/brand/logo';
import { api } from '@/lib/api-client';
import { clearAuth, getUser } from '@/lib/auth';
import { Button } from '@/components/ui/button';

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
          {userName ? (
            <span className="hidden text-sm text-[var(--color-text-secondary)] sm:inline">
              {userName}
            </span>
          ) : null}
          <Button variant="ghost" size="sm" onClick={handleSignOut}>
            Sign out
          </Button>
        </div>
      </header>
      <div className="flex-1">{children}</div>
    </div>
  );
}
