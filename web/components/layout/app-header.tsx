'use client';

import { useJobStore } from '@/lib/store';
import { Cloud, CloudOff, Loader2 } from 'lucide-react';
import { MobileMenu } from './mobile-menu';

export function AppHeader() {
  const { isOnline, isSyncing, pendingSyncCount } = useJobStore();

  return (
    <header className="h-14 glass-bg border-b border-white/[0.08] flex items-center justify-between px-4 md:px-6 flex-shrink-0">
      <div className="flex items-center gap-3">
        {/* Hamburger menu — visible < md */}
        <MobileMenu />
        <h1 className="text-sm font-medium text-white/30 hidden sm:block">CertMate</h1>
      </div>

      <div className="flex items-center gap-4">
        {/* Sync status */}
        {isSyncing ? (
          <div className="flex items-center gap-1.5 text-sm">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-brand-blue" />
            <span className="text-brand-blue font-medium">Syncing…</span>
          </div>
        ) : pendingSyncCount > 0 ? (
          <div className="flex items-center gap-1.5 text-sm">
            <CloudOff className="h-3.5 w-3.5 text-status-amber" />
            <span className="text-status-amber">{pendingSyncCount} pending</span>
          </div>
        ) : null}

        {/* Online indicator */}
        <div className="flex items-center gap-1.5 text-xs">
          {isOnline ? (
            <>
              <div className="w-1.5 h-1.5 rounded-full bg-status-green shadow-[0_0_6px_rgba(0,230,118,0.5)]" />
              <span className="text-white/40">Online</span>
            </>
          ) : (
            <>
              <div className="w-1.5 h-1.5 rounded-full bg-white/20" />
              <span className="text-white/30">Offline</span>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
