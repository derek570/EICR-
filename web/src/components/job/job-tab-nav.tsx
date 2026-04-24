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
 * Job tab navigation — horizontal strip, iOS-style.
 *
 * Each tab renders as an icon-over-label cell with an optional small status
 * dot (green=complete, amber=warning) anchored to the top-right of the icon.
 * Active tab shows a blue label + a thin underline beneath it; inactive tabs
 * keep a muted gray label with the brand-coloured icon.
 *
 * Tab set is cert-type-gated to mirror iOS
 * `CertMateUnified/Sources/Views/JobDetail/JobDetailView.swift:313-357`:
 *   EICR: Overview, Installation, Supply, Board, Circuits, Observations,
 *         Inspection, Staff, PDF
 *   EIC : Overview, Installation, Supply, Board, Circuits, Inspection,
 *         Extent, Design, Staff, PDF
 *
 * The prior unified set — shared between cert types — was a Wave 5 regression
 * (Observations hidden behind a FAB button that was never built; Extent +
 * Design shown on EICR where iOS hides them). Phase 1 of the Wave A parity
 * audit catalogued this as P0; the restoration here closes Phase 1 gaps
 * #1, #3, #4, and #8 (the `certificateType` prop gap is solved by reading
 * it off `useJobContext()` so no prop drilling is needed).
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

const OVERVIEW_TAB: Tab = { slug: '', label: 'Overview', Icon: LayoutDashboard };
const INSTALLATION_TAB: Tab = {
  slug: '/installation',
  label: 'Installation',
  Icon: Settings2,
  status: 'complete',
};
const SUPPLY_TAB: Tab = {
  slug: '/supply',
  label: 'Supply',
  Icon: Zap,
  status: 'complete',
};
const BOARD_TAB: Tab = {
  slug: '/board',
  label: 'Board',
  Icon: Boxes,
  status: 'complete',
};
const CIRCUITS_TAB: Tab = {
  slug: '/circuits',
  label: 'Circuits',
  Icon: List,
  status: 'warning',
};
const OBSERVATIONS_TAB: Tab = {
  slug: '/observations',
  label: 'Observations',
  Icon: AlertTriangle,
};
const INSPECTION_TAB: Tab = { slug: '/inspection', label: 'Inspection', Icon: ClipboardCheck };
const EXTENT_TAB: Tab = { slug: '/extent', label: 'Extent', Icon: Ruler };
const DESIGN_TAB: Tab = { slug: '/design', label: 'Design', Icon: DraftingCompass };
const STAFF_TAB: Tab = { slug: '/staff', label: 'Staff', Icon: UserCheck };
const PDF_TAB: Tab = { slug: '/pdf', label: 'PDF', Icon: FileText };

const EICR_TABS: Tab[] = [
  OVERVIEW_TAB,
  INSTALLATION_TAB,
  SUPPLY_TAB,
  BOARD_TAB,
  CIRCUITS_TAB,
  OBSERVATIONS_TAB,
  INSPECTION_TAB,
  STAFF_TAB,
  PDF_TAB,
];

const EIC_TABS: Tab[] = [
  OVERVIEW_TAB,
  INSTALLATION_TAB,
  SUPPLY_TAB,
  BOARD_TAB,
  CIRCUITS_TAB,
  INSPECTION_TAB,
  EXTENT_TAB,
  DESIGN_TAB,
  STAFF_TAB,
  PDF_TAB,
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
