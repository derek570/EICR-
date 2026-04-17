'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Boxes,
  ClipboardCheck,
  DraftingCompass,
  FileText,
  LayoutDashboard,
  List,
  Ruler,
  Settings2,
  UserCheck,
  Zap,
} from 'lucide-react';
import type { CertificateType } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * Job tab navigation — horizontal strip (always), iOS-style.
 *
 * Each tab renders as an icon-over-label cell with an optional small status
 * dot (green=complete, amber=warning) anchored to the top-right of the icon.
 * Active tab shows a blue label + a thin underline beneath it; inactive tabs
 * keep a muted gray label with the brand-coloured icon.
 *
 * The tab set is *unified* for EICR + EIC per iOS: Observations is NOT a
 * tab (it lives behind the Obs button in the floating action bar), and the
 * final tab is "Staff" not "Inspector". Extent & Design are always shown
 * — the backend permits them on EICR too and iOS keeps them visible.
 *
 * Reference: memory/ios_design_parity.md §"Tab set (unified)".
 */

type TabStatus = 'complete' | 'warning' | undefined;

type Tab = {
  slug: string;
  label: string;
  Icon: React.ComponentType<{
    className?: string;
    strokeWidth?: number;
    'aria-hidden'?: boolean;
    style?: React.CSSProperties;
  }>;
  status?: TabStatus;
};

const UNIFIED_TABS: Tab[] = [
  { slug: '', label: 'Overview', Icon: LayoutDashboard },
  { slug: '/installation', label: 'Installation', Icon: Settings2, status: 'complete' },
  { slug: '/supply', label: 'Supply', Icon: Zap, status: 'complete' },
  { slug: '/board', label: 'Board', Icon: Boxes, status: 'complete' },
  { slug: '/circuits', label: 'Circuits', Icon: List, status: 'warning' },
  { slug: '/inspection', label: 'Inspection', Icon: ClipboardCheck },
  { slug: '/extent', label: 'Extent', Icon: Ruler },
  { slug: '/design', label: 'Design', Icon: DraftingCompass },
  { slug: '/staff', label: 'Staff', Icon: UserCheck },
  { slug: '/pdf', label: 'PDF', Icon: FileText },
];

export function JobTabNav({
  jobId,
  certificateType: _certificateType,
}: {
  jobId: string;
  /** Retained for API compatibility; unified tab set ignores cert type. */
  certificateType: CertificateType;
}) {
  const pathname = usePathname();
  const base = `/job/${jobId}`;

  return (
    <nav
      aria-label="Job sections"
      className="flex w-full gap-0 overflow-x-auto border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-0)] px-2 scrollbar-hide"
    >
      {UNIFIED_TABS.map((tab) => {
        const href = `${base}${tab.slug}`;
        const isActive =
          tab.slug === ''
            ? pathname === base
            : pathname === href || pathname.startsWith(`${href}/`);

        const iconColor =
          tab.slug === '/supply' ? 'var(--color-brand-green)' : 'var(--color-brand-blue)';

        return (
          <Link
            key={tab.slug || 'overview'}
            href={href}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'relative flex flex-shrink-0 flex-col items-center gap-1 whitespace-nowrap px-3 pb-2 pt-2.5 text-[11px] font-medium transition',
              isActive
                ? 'text-[var(--color-brand-blue)]'
                : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
            )}
          >
            <span className="relative">
              <tab.Icon
                className="h-5 w-5"
                strokeWidth={2}
                aria-hidden
                style={{ color: isActive ? 'var(--color-brand-blue)' : iconColor }}
              />
              {tab.status ? (
                <span
                  aria-hidden
                  className="absolute -right-1 -top-1 block h-2 w-2 rounded-full ring-2 ring-[var(--color-surface-0)]"
                  style={{
                    background:
                      tab.status === 'complete'
                        ? 'var(--color-status-done)'
                        : 'var(--color-status-processing)',
                  }}
                />
              ) : null}
            </span>
            <span className="leading-none">{tab.label}</span>
            {isActive ? (
              <span
                aria-hidden
                className="absolute bottom-0 left-1/2 h-[2px] w-8 -translate-x-1/2 rounded-full bg-[var(--color-brand-blue)]"
              />
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
