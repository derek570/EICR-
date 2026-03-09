'use client';

import { useJobStore } from '@/lib/store';
import { Cloud, CloudOff, Loader2 } from 'lucide-react';

export function Header() {
  const { isOnline, isSyncing, pendingSyncCount } = useJobStore();

  return (
    <header className="h-14 border-b border-gray-100 bg-white/80 backdrop-blur-md flex items-center justify-between px-6 dark:border-white/5 dark:bg-[#0F172A]/80">
      <div className="flex items-center gap-2">
        <h1 className="text-sm font-medium text-gray-400 dark:text-white/40">CertMate Desktop</h1>
      </div>

      <div className="flex items-center gap-4">
        {/* Sync status */}
        {isSyncing ? (
          <div className="flex items-center gap-1.5 text-sm">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
            <span className="text-blue-500 font-medium">Syncing...</span>
          </div>
        ) : pendingSyncCount > 0 ? (
          <div className="flex items-center gap-1.5 text-sm">
            <CloudOff className="h-3.5 w-3.5 text-orange-400" />
            <span className="text-orange-400">{pendingSyncCount} pending</span>
          </div>
        ) : null}

        {/* Online indicator */}
        <div className="flex items-center gap-1.5 text-xs">
          {isOnline ? (
            <>
              <div className="w-1.5 h-1.5 rounded-full bg-green-400 shadow-sm shadow-green-400/50" />
              <span className="text-gray-400 dark:text-white/40">Online</span>
            </>
          ) : (
            <>
              <div className="w-1.5 h-1.5 rounded-full bg-gray-300" />
              <span className="text-gray-400 dark:text-white/30">Offline</span>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
