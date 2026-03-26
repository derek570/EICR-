'use client';

import { useRef, useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Home,
  Mic,
  Building2,
  Zap,
  CircuitBoard,
  List,
  AlertTriangle,
  ClipboardCheck,
  FileText,
  UserCheck,
  Settings2,
  Ruler,
  PenTool,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { CertificateType } from '@/lib/types';

interface TabItem {
  name: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
}

const eicrTabs: TabItem[] = [
  { name: 'Overview', href: '', icon: Home },
  { name: 'Record', href: '/record', icon: Mic },
  { name: 'Installation', href: '/installation', icon: Building2 },
  { name: 'Supply', href: '/supply', icon: Zap },
  { name: 'Board', href: '/board', icon: CircuitBoard },
  { name: 'Circuits', href: '/circuits', icon: List },
  { name: 'Observations', href: '/observations', icon: AlertTriangle },
  { name: 'Inspection', href: '/inspection', icon: ClipboardCheck },
  { name: 'Defaults', href: '/defaults', icon: Settings2 },
  { name: 'Inspector', href: '/inspector', icon: UserCheck },
  { name: 'PDF', href: '/pdf', icon: FileText },
];

const eicTabs: TabItem[] = [
  { name: 'Overview', href: '', icon: Home },
  { name: 'Record', href: '/record', icon: Mic },
  { name: 'Installation', href: '/installation', icon: Building2 },
  { name: 'Extent & Type', href: '/extent', icon: Ruler },
  { name: 'Supply', href: '/supply', icon: Zap },
  { name: 'Board', href: '/board', icon: CircuitBoard },
  { name: 'Circuits', href: '/circuits', icon: List },
  { name: 'Inspection', href: '/eic-inspection', icon: ClipboardCheck },
  { name: 'Design', href: '/design', icon: PenTool },
  { name: 'Defaults', href: '/defaults', icon: Settings2 },
  { name: 'Inspector', href: '/inspector', icon: UserCheck },
  { name: 'PDF', href: '/pdf', icon: FileText },
];

interface JobTabNavProps {
  jobId: string;
  certificateType: CertificateType;
}

export function JobTabNav({ jobId, certificateType }: JobTabNavProps) {
  const pathname = usePathname();
  const basePath = `/job/${jobId}`;
  const tabs = certificateType === 'EIC' ? eicTabs : eicrTabs;
  const containerRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<(HTMLAnchorElement | null)[]>([]);
  const [indicator, setIndicator] = useState({ left: 0, width: 0 });

  const activeIndex = tabs.findIndex((tab) => {
    const href = `${basePath}${tab.href}`;
    return pathname === href || (tab.href === '' && pathname === basePath);
  });

  const updateIndicator = useCallback(() => {
    if (activeIndex < 0) return;
    const el = tabRefs.current[activeIndex];
    const container = containerRef.current;
    if (!el || !container) return;
    const containerRect = container.getBoundingClientRect();
    const tabRect = el.getBoundingClientRect();
    setIndicator({
      left: tabRect.left - containerRect.left + container.scrollLeft,
      width: tabRect.width,
    });
  }, [activeIndex]);

  useEffect(() => {
    updateIndicator();
  }, [updateIndicator, pathname]);

  // Scroll active tab into view
  useEffect(() => {
    if (activeIndex < 0) return;
    const el = tabRefs.current[activeIndex];
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }, [activeIndex]);

  return (
    <div className="relative flex-shrink-0 border-b border-white/5 bg-L1">
      <div ref={containerRef} className="flex overflow-x-auto scrollbar-none px-2">
        {tabs.map((tab, idx) => {
          const href = `${basePath}${tab.href}`;
          const isActive = idx === activeIndex;
          const Icon = tab.icon;

          return (
            <Link
              key={tab.name}
              href={href}
              ref={(el) => {
                tabRefs.current[idx] = el;
              }}
              className={cn(
                'relative flex items-center gap-1.5 px-3 py-3 min-h-[44px] text-sm whitespace-nowrap transition-colors',
                isActive ? 'text-white font-medium' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Icon className="h-4 w-4 flex-shrink-0" />
              <span>{tab.name}</span>
            </Link>
          );
        })}

        {/* Sliding gradient indicator */}
        <div
          className="tab-indicator absolute bottom-0 h-[3px] rounded-full"
          style={{
            left: indicator.left,
            width: indicator.width,
            background: 'linear-gradient(90deg, var(--brand-blue), var(--brand-green))',
          }}
        />
      </div>
    </div>
  );
}
