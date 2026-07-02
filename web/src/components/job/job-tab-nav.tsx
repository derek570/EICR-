'use client';

import * as React from 'react';
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
 * Active tab (WS5, iOS JobDetailView canon): brand-blue icon + white bold
 * label; inactive tabs sit at white/35 icon + white/45 label. A single 3px
 * blue→green gradient underline slides between tabs (see the indicator
 * comment inside the component).
 *
 * Tab set is cert-type-gated to mirror iOS
 * `CertMateUnified/Sources/Views/JobDetail/JobDetailView.swift:472-536`:
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

  // WS5 (2026-07-02) — iOS tab rail restyle (JobDetailView.swift:266-309):
  // active tab = brand-blue icon + white bold label; inactive tabs sit at
  // white/35 (icon) and white/45 (label) — the old per-tab coloured icons
  // (green Supply etc.) had no iOS equivalent. The underline is a single
  // 3px blue→green gradient bar (`Gradients.tabIndicator`, radius 1.5,
  // blue glow) that SLIDES between tabs — the iOS matchedGeometryEffect +
  // tabSlide spring, ported by measuring the active link and
  // transitioning left/width on one shared indicator element. The global
  // prefers-reduced-motion guard collapses the slide to an instant move.
  const navRef = React.useRef<HTMLElement>(null);
  const [indicator, setIndicator] = React.useState<{ left: number; width: number } | null>(null);

  React.useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const measure = () => {
      const active = nav.querySelector<HTMLElement>('a[aria-current="page"]');
      if (!active) {
        setIndicator(null);
        return;
      }
      setIndicator({ left: active.offsetLeft, width: active.offsetWidth });
      // Keep the active tab reachable on narrow rails.
      active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(nav);
    return () => ro.disconnect();
  }, [pathname, tabs]);

  return (
    <nav
      ref={navRef}
      aria-label="Job sections"
      className="relative flex w-full gap-0 overflow-x-auto border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-0)] px-2 scrollbar-hide"
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
              'relative flex min-h-[44px] flex-shrink-0 flex-col items-center justify-center gap-1 whitespace-nowrap px-3 pb-2 pt-2.5 text-[12px] transition',
              isActive ? 'font-bold text-white' : 'font-medium text-white/45 hover:text-white/70'
            )}
          >
            <span className="relative">
              <tab.Icon
                className={cn('h-5 w-5 transition-transform', !isActive && 'scale-[0.92]')}
                strokeWidth={isActive ? 2.5 : 2}
                aria-hidden
                style={{
                  color: isActive ? 'var(--color-brand-blue)' : 'rgba(255,255,255,0.35)',
                }}
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
          </Link>
        );
      })}
      {indicator ? (
        <span
          aria-hidden
          className="absolute bottom-0 h-[3px] rounded-[1.5px] shadow-[0_2px_6px_rgba(0,102,255,0.4)] transition-[left,width] duration-300"
          style={{
            left: indicator.left,
            width: indicator.width,
            background: 'linear-gradient(90deg, var(--color-brand-blue), var(--color-brand-green))',
            transitionTimingFunction: 'var(--ease-spring)',
          }}
        />
      ) : null}
    </nav>
  );
}
