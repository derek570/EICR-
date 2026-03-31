'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  BarChart3,
  Building2,
  Zap,
  Cpu,
  ListOrdered,
  AlertTriangle,
  ClipboardCheck,
  UserCheck,
  FileText,
  Ruler,
  PenTool,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { CertificateType } from '@/lib/api';
import type { LucideIcon } from 'lucide-react';

interface JobTabsProps {
  jobId: string;
  certificateType?: CertificateType;
}

interface Tab {
  name: string;
  href: string;
  icon: LucideIcon;
}

// EICR tabs (9 tabs — matching iOS DashboardView)
const eicrTabs: Tab[] = [
  { name: 'Overview', href: '', icon: BarChart3 },
  { name: 'Installation', href: '/installation', icon: Building2 },
  { name: 'Supply', href: '/supply', icon: Zap },
  { name: 'Board', href: '/board', icon: Cpu },
  { name: 'Circuits', href: '/circuits', icon: ListOrdered },
  { name: 'Observations', href: '/observations', icon: AlertTriangle },
  { name: 'Inspection', href: '/inspection', icon: ClipboardCheck },
  { name: 'Staff', href: '/inspector', icon: UserCheck },
  { name: 'PDF', href: '/pdf', icon: FileText },
];

// EIC tabs (11 tabs — matching iOS DashboardView)
const eicTabs: Tab[] = [
  { name: 'Overview', href: '', icon: BarChart3 },
  { name: 'Installation', href: '/installation', icon: Building2 },
  { name: 'Supply', href: '/supply', icon: Zap },
  { name: 'Board', href: '/board', icon: Cpu },
  { name: 'Circuits', href: '/circuits', icon: ListOrdered },
  { name: 'Observations', href: '/observations', icon: AlertTriangle },
  { name: 'Inspection', href: '/eic-inspection', icon: ClipboardCheck },
  { name: 'Extent', href: '/extent', icon: Ruler },
  { name: 'Design', href: '/design', icon: PenTool },
  { name: 'Staff', href: '/inspector', icon: UserCheck },
  { name: 'PDF', href: '/pdf', icon: FileText },
];

function getTabsForType(type: CertificateType): Tab[] {
  return type === 'EIC' ? eicTabs : eicrTabs;
}

export function JobTabs({ jobId, certificateType = 'EICR' }: JobTabsProps) {
  const pathname = usePathname();
  const basePath = `/job/${jobId}`;
  const tabs = getTabsForType(certificateType);

  return (
    <div className="border-b border-border">
      <nav className="flex overflow-x-auto -mb-px" aria-label="Tabs">
        {tabs.map((tab) => {
          const href = `${basePath}${tab.href}`;
          const isActive = pathname === href || (tab.href === '' && pathname === basePath);
          const Icon = tab.icon;

          return (
            <Link
              key={tab.name}
              href={href}
              className={cn(
                'shrink-0 flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-xs font-medium transition-colors whitespace-nowrap',
                isActive
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:border-muted-foreground/30 hover:text-foreground'
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {tab.name}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
