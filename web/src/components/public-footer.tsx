import * as React from 'react';
import Link from 'next/link';

/**
 * Public footer surfaced on /legal/*, /login, and /offline. Carries the
 * company identification required by UK consumer transparency norms
 * (registered company name + number + office address) plus links to the
 * statutory consumer-facing documents.
 *
 * The ICO registration number is currently a placeholder — substitute
 * after registration completes (see
 * `.planning/compliance/two-week-launch-checklist.md` Task 4).
 */
export function PublicFooter() {
  return (
    <footer className="mt-12 border-t border-[var(--color-border-subtle)] bg-[var(--color-surface-0)]">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 md:flex-row md:items-start md:justify-between">
        <div className="flex flex-col gap-1 text-[12px] text-[var(--color-text-secondary)]">
          <p className="font-semibold text-[var(--color-text-primary)]">CertMate</p>
          <p>
            Operated by Beckley Electrical Ltd, registered in England &amp; Wales (Co. 11816656).
          </p>
          <p>Registered office: 1 MacArthur Close, Tilehurst, Reading RG30 4XW.</p>
          <p>ICO registration: pending.</p>
        </div>
        <nav aria-label="Legal" className="flex flex-col gap-1.5 text-[12px] md:items-end">
          <Link
            href="/legal/privacy-policy"
            className="text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)]"
          >
            Privacy Policy
          </Link>
          <Link
            href="/legal/cookie-policy"
            className="text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)]"
          >
            Cookie Policy
          </Link>
          <Link
            href="/legal/sub-processors"
            className="text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)]"
          >
            Sub-processors
          </Link>
          <Link
            href="/legal/acceptable-use-policy"
            className="text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)]"
          >
            Acceptable Use
          </Link>
          <Link
            href="/legal"
            className="text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)]"
          >
            All legal documents →
          </Link>
        </nav>
      </div>
    </footer>
  );
}
