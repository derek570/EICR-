'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Settings,
  UserCheck,
  Building2,
  ChevronLeft,
  ChevronRight,
  Users,
  SlidersHorizontal,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { CertMateLogo, CertMateIcon } from '@/components/brand/certmate-logo';

const navItems = [
  { href: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { href: '/staff', icon: Users, label: 'Staff' },
  { href: '/defaults', icon: SlidersHorizontal, label: 'Defaults' },
  { href: '/settings', icon: Settings, label: 'Settings' },
  { href: '/settings/inspector', icon: UserCheck, label: 'Inspector' },
  { href: '/settings/company', icon: Building2, label: 'Company' },
];

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();

  return (
    <aside
      className={cn(
        'flex flex-col h-screen bg-[#0B1120] text-white transition-all duration-200 ease-in-out flex-shrink-0 relative',
        collapsed ? 'w-16' : 'w-60'
      )}
    >
      {/* Subtle gradient accent along the right edge */}
      <div className="absolute right-0 top-0 bottom-0 w-px bg-gradient-to-b from-blue-500/30 via-cyan-400/20 to-green-500/30" />

      {/* Logo */}
      <div className="flex items-center h-16 px-3 border-b border-white/5">
        {collapsed ? (
          <div className="mx-auto">
            <CertMateIcon size="sm" />
          </div>
        ) : (
          <CertMateLogoWhite size="sm" />
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-4 space-y-1 px-2">
        {navItems.map((item) => {
          const isActive =
            item.href === '/settings'
              ? pathname === '/settings'
              : pathname === item.href || pathname.startsWith(item.href + '/');
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-150',
                isActive
                  ? 'bg-gradient-to-r from-blue-500/15 to-cyan-500/10 text-white border border-blue-500/20'
                  : 'text-white/60 hover:bg-white/5 hover:text-white/90',
                collapsed && 'justify-center px-2'
              )}
              title={collapsed ? item.label : undefined}
            >
              <item.icon
                className={cn(
                  'h-5 w-5 flex-shrink-0 transition-colors',
                  isActive ? 'text-blue-400' : ''
                )}
              />
              {!collapsed && <span>{item.label}</span>}
            </Link>
          );
        })}
      </nav>

      {/* Collapse toggle */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex items-center justify-center h-12 border-t border-white/5 text-white/30 hover:text-white/70 hover:bg-white/5 transition-colors"
      >
        {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
      </button>
    </aside>
  );
}

/** White logo variant for the sidebar — imported from brand components */
function CertMateLogoWhite({ size = 'sm' }: { size?: 'sm' | 'md' | 'lg' }) {
  const s = {
    sm: { icon: 28, text: 14, gap: 8 },
    md: { icon: 36, text: 18, gap: 10 },
    lg: { icon: 48, text: 24, gap: 14 },
  }[size];
  return (
    <div className="flex items-center" style={{ gap: s.gap }}>
      <CertMateIcon size={size} />
      <span className="font-bold tracking-tight text-white" style={{ fontSize: s.text }}>
        Cert
        <span className="bg-gradient-to-r from-blue-400 via-cyan-300 to-green-400 bg-clip-text text-transparent">
          Mate
        </span>
      </span>
    </div>
  );
}
