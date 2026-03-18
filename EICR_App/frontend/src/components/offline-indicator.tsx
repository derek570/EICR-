"use client";

import { useEffect, useState } from "react";
import { Wifi, WifiOff, Cloud, CloudOff, Loader2, ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import { useJobStore } from "@/lib/store";
import { initSyncListeners, syncDirtyJobs, syncSingleJob } from "@/lib/sync";
import { db, type LocalJob } from "@/lib/db";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export function OfflineIndicator() {
  const { isOnline, isSyncing, pendingSyncCount, isDirty, userId } = useJobStore();
  const [expanded, setExpanded] = useState(false);
  const [pendingJobs, setPendingJobs] = useState<LocalJob[]>([]);
  const [syncingJobId, setSyncingJobId] = useState<string | null>(null);

  useEffect(() => {
    const cleanup = initSyncListeners();
    return cleanup;
  }, []);

  // Load pending jobs when expanded
  useEffect(() => {
    if (expanded && userId) {
      db.jobs
        .where({ userId })
        .filter((j) => j.isDirty)
        .toArray()
        .then(setPendingJobs);
    }
  }, [expanded, userId, pendingSyncCount]);

  // Handle retry for single job
  const handleRetryJob = async (jobId: string) => {
    setSyncingJobId(jobId);
    try {
      await syncSingleJob(jobId);
    } finally {
      setSyncingJobId(null);
    }
  };

  // Handle sync all
  const handleSyncAll = async () => {
    await syncDirtyJobs();
    setExpanded(false);
  };

  // Determine what to show
  const showPending = pendingSyncCount > 0 || isDirty;

  if (isSyncing && !expanded) {
    return (
      <div className="flex items-center gap-1.5 text-blue-600 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="hidden sm:inline">Syncing...</span>
      </div>
    );
  }

  if (!isOnline) {
    return (
      <div className="relative">
        <button
          onClick={() => showPending && setExpanded(!expanded)}
          className="flex items-center gap-1.5 text-amber-600 text-sm"
        >
          <WifiOff className="h-4 w-4" />
          <span className="hidden sm:inline">Offline</span>
          {showPending && (
            <>
              <span className="bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded text-xs font-medium">
                {pendingSyncCount || 1} pending
              </span>
              {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </>
          )}
        </button>

        {expanded && showPending && (
          <QueuePanel
            jobs={pendingJobs}
            syncingJobId={syncingJobId}
            onRetryJob={handleRetryJob}
            onSyncAll={handleSyncAll}
            disabled={!isOnline}
          />
        )}
      </div>
    );
  }

  if (showPending) {
    return (
      <div className="relative">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 text-amber-600 text-sm hover:text-amber-700"
        >
          <CloudOff className="h-4 w-4" />
          <span className="hidden sm:inline">Unsaved</span>
          <span className="bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded text-xs font-medium">
            {pendingSyncCount || 1}
          </span>
          {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </button>

        {expanded && (
          <QueuePanel
            jobs={pendingJobs}
            syncingJobId={syncingJobId}
            onRetryJob={handleRetryJob}
            onSyncAll={handleSyncAll}
            disabled={false}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 text-green-600 text-sm">
      <Cloud className="h-4 w-4" />
      <span className="hidden sm:inline">Synced</span>
    </div>
  );
}

interface QueuePanelProps {
  jobs: LocalJob[];
  syncingJobId: string | null;
  onRetryJob: (jobId: string) => void;
  onSyncAll: () => void;
  disabled: boolean;
}

function QueuePanel({ jobs, syncingJobId, onRetryJob, onSyncAll, disabled }: QueuePanelProps) {
  return (
    <div className="absolute right-0 top-full mt-2 w-72 bg-white border rounded-lg shadow-lg z-50 p-3">
      <div className="text-sm font-medium mb-2 flex items-center gap-2">
        <CloudOff className="h-4 w-4 text-amber-600" />
        {jobs.length} job{jobs.length !== 1 ? "s" : ""} pending sync
      </div>

      <div className="space-y-2 max-h-48 overflow-y-auto mb-3">
        {jobs.map((job) => (
          <div
            key={job.id}
            className="flex items-center justify-between p-2 bg-slate-50 rounded text-sm"
          >
            <div className="flex-1 min-w-0">
              <p className="font-medium truncate">{job.address}</p>
              <p className="text-xs text-muted-foreground">
                Modified {formatTimeAgo(job.lastModified)}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onRetryJob(job.id)}
              disabled={disabled || syncingJobId === job.id}
              className="ml-2 h-7 px-2"
            >
              {syncingJobId === job.id ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
            </Button>
          </div>
        ))}

        {jobs.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-2">
            Current job has unsaved changes
          </p>
        )}
      </div>

      <Button
        onClick={onSyncAll}
        disabled={disabled}
        size="sm"
        className="w-full"
      >
        {disabled ? "Go online to sync" : "Sync All"}
      </Button>
    </div>
  );
}

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);

  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
