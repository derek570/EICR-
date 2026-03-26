'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { navItems, isActive } from './app-sidebar';

export function MobileTabBar() {
  const pathname = usePathname();

  return (
    <nav
      className={cn(
        'fixed bottom-0 left-0 right-0 z-50 md:hidden',
        'h-14 glass-bg border-t border-white/[0.08]',
        'flex items-center justify-around px-2',
        'safe-area-bottom'
      )}
    >
      {navItems.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'flex flex-col items-center justify-center gap-0.5 flex-1 py-1.5 transition-colors',
              active ? 'text-white' : 'text-white/60'
            )}
          >
            <div className="relative">
              <item.icon className={cn('h-5 w-5', active && 'text-brand-blue')} />
              {/* Active gradient dot */}
              {active && (
                <span className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-4 h-0.5 rounded-full bg-gradient-to-r from-brand-blue to-brand-green" />
              )}
            </div>
            <span
              className={cn('text-[11px] font-medium', active ? 'text-white' : 'text-white/60')}
            >
              {item.label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
