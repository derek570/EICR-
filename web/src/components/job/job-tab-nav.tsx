'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { CertificateType } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * Job tab navigation.
 *
 * Desktop: vertical sidebar (~200px).
 * Mobile:  horizontal scroll strip under the job header.
 *
 * Tab ordering mirrors the iOS JobDetailView enum — EICR and EIC diverge
 * because EIC adds Design + Extent & Type while dropping Observations.
 * Labels are short enough to fit without truncation on a 390px viewport.
 */

type Tab = { slug: string; label: string; icon: string };

const EICR_TABS: Tab[] = [
  { slug: '', label: 'Overview', icon: '\u{1F3E0}' }, // house
  { slug: '/installation', label: 'Installation', icon: '\u{1F3D7}' }, // building construction
  { slug: '/supply', label: 'Supply', icon: '\u26A1' }, // lightning
  { slug: '/board', label: 'Board', icon: '\u{1F9F1}' }, // brick (placeholder for CU)
  { slug: '/circuits', label: 'Circuits', icon: '\u{1F500}' }, // shuffle (closest glyph)
  { slug: '/observations', label: 'Observations', icon: '\u26A0' }, // warning
  { slug: '/inspection', label: 'Inspection', icon: '\u2705' }, // check
  { slug: '/inspector', label: 'Inspector', icon: '\u{1F464}' }, // bust
  { slug: '/pdf', label: 'PDF', icon: '\u{1F4C4}' }, // page
];

const EIC_TABS: Tab[] = [
  { slug: '', label: 'Overview', icon: '\u{1F3E0}' },
  { slug: '/installation', label: 'Installation', icon: '\u{1F3D7}' },
  { slug: '/extent', label: 'Extent', icon: '\u{1F4CF}' }, // ruler
  { slug: '/supply', label: 'Supply', icon: '\u26A1' },
  { slug: '/board', label: 'Board', icon: '\u{1F9F1}' },
  { slug: '/circuits', label: 'Circuits', icon: '\u{1F500}' },
  { slug: '/inspection', label: 'Inspection', icon: '\u2705' },
  { slug: '/design', label: 'Design', icon: '\u{1F4D0}' }, // triangular ruler
  { slug: '/inspector', label: 'Inspector', icon: '\u{1F464}' },
  { slug: '/pdf', label: 'PDF', icon: '\u{1F4C4}' },
];

export function JobTabNav({
  jobId,
  certificateType,
}: {
  jobId: string;
  certificateType: CertificateType;
}) {
  const pathname = usePathname();
  const base = `/job/${jobId}`;
  const tabs = certificateType === 'EIC' ? EIC_TABS : EICR_TABS;

  return (
    <nav
      aria-label="Job sections"
      className={cn(
        // Mobile: horizontal scroll strip.
        'flex w-full overflow-x-auto border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] px-2 scrollbar-hide',
        // Desktop: transform into vertical sidebar.
        'md:h-full md:w-[220px] md:flex-shrink-0 md:flex-col md:overflow-y-auto md:overflow-x-visible md:border-b-0 md:border-r md:px-3 md:py-4'
      )}
    >
      {tabs.map((tab) => {
        const href = `${base}${tab.slug}`;
        const isActive =
          tab.slug === ''
            ? pathname === base
            : pathname === href || pathname.startsWith(`${href}/`);

        return (
          <Link
            key={tab.slug || 'overview'}
            href={href}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'flex items-center gap-2 whitespace-nowrap rounded-[var(--radius-md)] px-3 py-2 text-[13px] font-medium transition',
              'md:text-sm',
              isActive
                ? 'bg-[var(--color-brand-blue)]/12 text-[var(--color-brand-blue)]'
                : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text-primary)]'
            )}
          >
            <span aria-hidden className="text-[15px] leading-none">
              {tab.icon}
            </span>
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
