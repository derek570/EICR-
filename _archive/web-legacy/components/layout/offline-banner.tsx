'use client';

import { useEffect, useState } from 'react';
import { WifiOff } from 'lucide-react';

/**
 * OfflineBanner — mirrors iOS OfflineBanner.swift
 * Shows a fixed yellow warning bar when the browser loses network connectivity.
 * Disappears automatically when connection is restored.
 */
export function OfflineBanner() {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    // Initialise from current state
    setOffline(!navigator.onLine);

    const handleOffline = () => setOffline(true);
    const handleOnline = () => setOffline(false);

    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, []);

  if (!offline) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center justify-center gap-2 px-4 py-2 bg-amber-500/90 text-amber-950 text-sm font-medium"
    >
      <WifiOff className="h-4 w-4 shrink-0" />
      <span>Offline — changes will sync when connected</span>
    </div>
  );
}
