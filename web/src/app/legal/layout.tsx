import * as React from 'react';
import Link from 'next/link';
import { Logo } from '@/components/brand/logo';
import { PublicFooter } from '@/components/public-footer';

/**
 * Public shell for /legal/* — minimal brand header + global footer. No
 * AppShell, no auth gates, no PWA chrome. The middleware allow-lists
 * `/legal` (see src/middleware.ts) so these pages render for any visitor.
 *
 * This is the URL surface the App Store privacy policy submission points
 * at, the URL the ICO will read on request, and the URL homeowner-facing
 * door-script QR codes resolve to. Keep the chrome calm and obvious.
 */
export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-[var(--color-surface-0)]">
      <header className="border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-0)]/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4 px-4 py-3">
          <Link
            href="/legal"
            className="flex items-baseline gap-2 focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)]"
          >
            <Logo size="sm" />
            <span className="text-[12px] text-[var(--color-text-tertiary)]">— Legal</span>
          </Link>
          <Link
            href="/login"
            className="text-[13px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)]"
          >
            Sign in
          </Link>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      <PublicFooter />
    </div>
  );
}
