'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as NavigationMenu from '@radix-ui/react-navigation-menu';
import {
  LayoutDashboard,
  Briefcase,
  Users,
  Settings,
  ChevronLeft,
  ChevronRight,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { CertMateIcon } from '@/components/brand/certmate-logo';

export interface NavItem {
  href: string;
  icon: LucideIcon;
  label: string;
}

export const navItems: NavItem[] = [
  { href: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { href: '/job', icon: Briefcase, label: 'Jobs' },
  { href: '/clients', icon: Users, label: 'Clients' },
  { href: '/settings', icon: Settings, label: 'Settings' },
];

export function isActive(pathname: string, href: string) {
  if (href === '/dashboard') return pathname === '/dashboard' || pathname === '/';
  return pathname === href || pathname.startsWith(href + '/');
}

export function AppSidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();

  return (
    <aside
      className={cn(
        'hidden md:flex flex-col h-screen flex-shrink-0 relative transition-all duration-200 ease-in-out',
        'glass-bg border-r border-white/[0.08]',
        collapsed ? 'w-[var(--spacing-sidebar-collapsed)]' : 'w-[var(--spacing-sidebar-expanded)]'
      )}
    >
      {/* Gradient bottom border accent along right edge */}
      <div className="absolute right-0 top-0 bottom-0 w-px bg-gradient-to-b from-brand-blue/30 via-brand-green/20 to-transparent" />

      {/* Logo area */}
      <div className="flex items-center h-16 px-4 border-b border-white/[0.06]">
        {collapsed ? (
          <div className="mx-auto">
            <CertMateIcon size="sm" />
          </div>
        ) : (
          <div className="flex items-center gap-2.5">
            <CertMateIcon size="sm" />
            <span className="font-bold text-[15px] tracking-tight text-white">
              Cert<span className="gradient-text">Mate</span>
            </span>
          </div>
        )}
      </div>

      {/* Navigation */}
      <NavigationMenu.Root orientation="vertical" className="flex-1 py-4 px-2">
        <NavigationMenu.List className="flex flex-col gap-1">
          {navItems.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <NavigationMenu.Item key={item.href}>
                <NavigationMenu.Link asChild active={active}>
                  <Link
                    href={item.href}
                    className={cn(
                      'flex items-center gap-3 px-3 py-3 rounded-pill text-sm font-medium transition-all duration-150 min-h-[44px]',
                      active
                        ? 'bg-gradient-to-r from-brand-blue/15 to-brand-green/10 text-white shadow-soft'
                        : 'text-white/60 hover:bg-white/[0.06] hover:text-white/80',
                      collapsed && 'justify-center px-2'
                    )}
                    title={collapsed ? item.label : undefined}
                  >
                    <item.icon
                      className={cn(
                        'h-5 w-5 flex-shrink-0 transition-colors',
                        active ? 'text-brand-blue' : ''
                      )}
                    />
                    {!collapsed && <span>{item.label}</span>}
                    {/* Active gradient indicator bar */}
                    {active && !collapsed && (
                      <span className="ml-auto w-1 h-4 rounded-full bg-gradient-to-b from-brand-blue to-brand-green" />
                    )}
                  </Link>
                </NavigationMenu.Link>
              </NavigationMenu.Item>
            );
          })}
        </NavigationMenu.List>
      </NavigationMenu.Root>

      {/* Collapse toggle */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex items-center justify-center h-12 border-t border-white/[0.06] text-white/30 hover:text-white/60 hover:bg-white/[0.04] transition-colors"
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
      </button>
    </aside>
  );
}
