"use client";

import { useEffect } from "react";
import { initSyncListeners } from "@/lib/sync";
import { useJobStore } from "@/lib/store";

export function SyncProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    // Initialize sync listeners
    const cleanup = initSyncListeners();

    // Refresh pending count on mount
    const userStr = localStorage.getItem("user");
    if (userStr) {
      try {
        const user = JSON.parse(userStr);
        useJobStore.getState().setUser(user.id);
        useJobStore.getState().refreshPendingCount();
      } catch {
        // Invalid user data, ignore
      }
    }

    return cleanup;
  }, []);

  return <>{children}</>;
}
