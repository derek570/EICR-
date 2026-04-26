'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  AlertTriangle,
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
import { cn } from '@/lib/utils';
import { useJobContext } from '@/lib/job-context';

/**
 * Job tab navigation — mirrors iOS JobDetailView.swift:332-355.
 *
 * iOS branches the tab list by certificate type. EICR has 9 tabs ending
 * in Observations / Inspection / Staff / PDF; EIC has 10 tabs ending in
 * Inspection / Extent / Design / Staff / PDF (no Observations — EIC is a
 * new-installation certificate, not a periodic inspection). The earlier
 * "unified array" implementation was wrong against iOS and meant EICR
 * jobs surfaced phantom Extent + Design tabs while hiding Observations
 * behind a non-tab route. Fixed by branching here.
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

const EICR_TABS: Tab[] = [
  { slug: '', label: 'Overview', Icon: LayoutDashboard },
  { slug: '/installation', label: 'Installation', Icon: Settings2, status: 'complete' },
  { slug: '/supply', label: 'Supply', Icon: Zap, status: 'complete' },
  { slug: '/board', label: 'Board', Icon: Boxes, status: 'complete' },
  { slug: '/circuits', label: 'Circuits', Icon: List, status: 'warning' },
  { slug: '/observations', label: 'Observations', Icon: AlertTriangle },
  { slug: '/inspection', label: 'Inspection', Icon: ClipboardCheck },
  { slug: '/staff', label: 'Staff', Icon: UserCheck },
  { slug: '/pdf', label: 'PDF', Icon: FileText },
];

const EIC_TABS: Tab[] = [
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

export function JobTabNav({ jobId }: { jobId: string }) {
  const pathname = usePathname();
  const { certificateType } = useJobContext();
  const base = `/job/${jobId}`;
  const tabs = certificateType === 'EIC' ? EIC_TABS : EICR_TABS;

  return (
    <nav
      aria-label="Job sections"
      className="flex w-full gap-0 overflow-x-auto border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-0)] px-2 scrollbar-hide"
    >
      {tabs.map((tab) => {
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
