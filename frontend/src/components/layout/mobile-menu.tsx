'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as Dialog from '@radix-ui/react-dialog';
import { Menu, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { navItems } from './app-sidebar';
import { CertMateIcon } from '@/components/brand/certmate-logo';

function isActive(pathname: string, href: string) {
  if (href === '/dashboard') return pathname === '/dashboard' || pathname === '/';
  return pathname === href || pathname.startsWith(href + '/');
}

export function MobileMenu() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close menu on route change
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          className="md:hidden flex items-center justify-center w-10 h-10 rounded-input text-white/60 hover:text-white hover:bg-white/[0.06] transition-colors"
          aria-label="Open menu"
        >
          <Menu className="h-5 w-5" />
        </button>
      </Dialog.Trigger>

      <Dialog.Portal>
        {/* Backdrop */}
        <Dialog.Overlay className="menu-overlay fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />

        {/* Slide-in panel */}
        <Dialog.Content className="menu-panel fixed top-0 left-0 z-50 h-full w-72 glass-bg border-r border-white/[0.08] flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between h-16 px-4 border-b border-white/[0.06]">
            <div className="flex items-center gap-2.5">
              <CertMateIcon size="sm" />
              <span className="font-bold text-[15px] tracking-tight text-white">
                Cert<span className="gradient-text">Mate</span>
              </span>
            </div>
            <Dialog.Close asChild>
              <button
                className="flex items-center justify-center w-8 h-8 rounded-input text-white/40 hover:text-white hover:bg-white/[0.06] transition-colors"
                aria-label="Close menu"
              >
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </div>

          {/* Nav links */}
          <nav className="flex-1 py-4 px-3">
            <ul className="flex flex-col gap-1">
              {navItems.map((item) => {
                const active = isActive(pathname, item.href);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={cn(
                        'flex items-center gap-3 px-3 py-3 rounded-pill text-sm font-medium transition-all duration-150',
                        active
                          ? 'bg-gradient-to-r from-brand-blue/15 to-brand-green/10 text-white'
                          : 'text-white/50 hover:bg-white/[0.06] hover:text-white/80'
                      )}
                    >
                      <item.icon
                        className={cn('h-5 w-5 flex-shrink-0', active ? 'text-brand-blue' : '')}
                      />
                      <span>{item.label}</span>
                      {active && (
                        <span className="ml-auto w-1 h-4 rounded-full bg-gradient-to-b from-brand-blue to-brand-green" />
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>

          {/* Footer */}
          <div className="px-4 py-3 border-t border-white/[0.06]">
            <p className="text-[11px] text-white/20">CertMate v2.0</p>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
