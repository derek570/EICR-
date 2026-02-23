"use client";

import { useJobStore } from "@/lib/store";
import { Cloud, CloudOff, Loader2 } from "lucide-react";

export function Header() {
  const { isOnline, isSyncing, pendingSyncCount } = useJobStore();

  return (
    <header className="h-14 border-b border-gray-200 bg-white flex items-center justify-between px-6 dark:border-border dark:bg-card">
      <div className="flex items-center gap-2">
        <h1 className="text-sm font-medium text-gray-500 dark:text-muted-foreground">CertMate Desktop</h1>
      </div>

      <div className="flex items-center gap-3">
        {/* Sync status */}
        {isSyncing ? (
          <div className="flex items-center gap-1.5 text-sm text-brand-blue">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Syncing...</span>
          </div>
        ) : pendingSyncCount > 0 ? (
          <div className="flex items-center gap-1.5 text-sm text-status-c2">
            <CloudOff className="h-4 w-4" />
            <span>{pendingSyncCount} pending</span>
          </div>
        ) : null}

        {/* Online indicator */}
        <div
          className={`flex items-center gap-1.5 text-sm ${isOnline ? "text-status-satisfactory" : "text-gray-400"}`}
        >
          {isOnline ? (
            <Cloud className="h-4 w-4" />
          ) : (
            <CloudOff className="h-4 w-4" />
          )}
          <span>{isOnline ? "Online" : "Offline"}</span>
        </div>
      </div>
    </header>
  );
}
