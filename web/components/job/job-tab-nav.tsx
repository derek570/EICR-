'use client';

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
  Image,
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
  { name: 'Photos', href: '/photos', icon: Image },
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
  { name: 'Photos', href: '/photos', icon: Image },
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

  return (
    <nav className="w-[180px] flex-shrink-0 border-r border-white/5 bg-[#0F172A] py-2 overflow-y-auto">
      {tabs.map((tab) => {
        const href = `${basePath}${tab.href}`;
        const isActive = pathname === href || (tab.href === '' && pathname === basePath);
        const Icon = tab.icon;

        return (
          <Link
            key={tab.name}
            href={href}
            className={cn(
              'flex items-center gap-2.5 px-4 py-2 text-sm transition-colors mx-1 rounded-md',
              isActive
                ? 'bg-brand-blue/10 text-brand-blue font-medium'
                : 'text-gray-400 hover:bg-white/5 hover:text-white'
            )}
          >
            <Icon className="h-4 w-4 flex-shrink-0" />
            <span className="truncate">{tab.name}</span>
          </Link>
        );
      })}
    </nav>
  );
}
