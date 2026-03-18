import { api } from "./api";
import { db, type LocalJob, markJobClean, getDirtyJobs } from "./db";
import { useJobStore } from "./store";

export async function syncDirtyJobs(): Promise<{ synced: number; failed: number }> {
  const store = useJobStore.getState();
  const { userId, isOnline } = store;

  if (!userId || !isOnline) {
    return { synced: 0, failed: 0 };
  }

  store.setSyncing(true);

  let synced = 0;
  let failed = 0;

  try {
    const dirtyJobs = await getDirtyJobs(userId);

    for (const job of dirtyJobs) {
      try {
        await api.saveJob(userId, job.id, {
          circuits: job.circuits,
          observations: job.observations,
          board_info: job.board_info,
          boards: job.boards,
          installation_details: job.installation_details,
          supply_characteristics: job.supply_characteristics,
          inspection_schedule: job.inspection_schedule,
          inspector_id: job.inspector_id,
          extent_and_type: job.extent_and_type,
          design_construction: job.design_construction,
        });

        await markJobClean(job.id);
        synced++;

        // If this is the current job, mark it clean in the store too
        if (store.currentJob?.id === job.id) {
          store.markClean();
        }
      } catch (error) {
        console.error(`Failed to sync job ${job.id}:`, error);
        failed++;
      }
    }
  } finally {
    store.setSyncing(false);
    await store.refreshPendingCount();
  }

  return { synced, failed };
}

export async function syncSingleJob(jobId: string): Promise<boolean> {
  const store = useJobStore.getState();
  const { userId, isOnline } = store;

  if (!userId || !isOnline) {
    return false;
  }

  const job = await db.jobs.get(jobId);
  if (!job || !job.isDirty) {
    return false;
  }

  store.setSyncing(true);

  try {
    await api.saveJob(userId, job.id, {
      circuits: job.circuits,
      observations: job.observations,
      board_info: job.board_info,
      boards: job.boards,
      installation_details: job.installation_details,
      supply_characteristics: job.supply_characteristics,
      inspection_schedule: job.inspection_schedule,
      inspector_id: job.inspector_id,
      extent_and_type: job.extent_and_type,
      design_construction: job.design_construction,
    });

    await markJobClean(job.id);

    // If this is the current job, mark it clean in the store too
    if (store.currentJob?.id === job.id) {
      store.markClean();
    }

    return true;
  } catch (error) {
    console.error(`Failed to sync job ${jobId}:`, error);
    return false;
  } finally {
    store.setSyncing(false);
    await store.refreshPendingCount();
  }
}

export async function syncCurrentJob(): Promise<boolean> {
  const store = useJobStore.getState();
  const { currentJob, userId, isOnline, isDirty } = store;

  if (!currentJob || !userId || !isOnline || !isDirty) {
    return false;
  }

  store.setSyncing(true);

  try {
    await api.saveJob(userId, currentJob.id, {
      circuits: currentJob.circuits,
      observations: currentJob.observations,
      board_info: currentJob.board_info,
      boards: currentJob.boards,
      installation_details: currentJob.installation_details,
      supply_characteristics: currentJob.supply_characteristics,
      inspection_schedule: currentJob.inspection_schedule,
      inspector_id: currentJob.inspector_id,
      extent_and_type: currentJob.extent_and_type,
      design_construction: currentJob.design_construction,
    });

    await markJobClean(currentJob.id);
    store.markClean();
    return true;
  } catch (error) {
    console.error("Failed to sync current job:", error);
    return false;
  } finally {
    store.setSyncing(false);
  }
}

// Set up online/offline listeners
export function initSyncListeners(): () => void {
  const handleOnline = async () => {
    useJobStore.getState().setOnline(true);
    // Auto-sync when coming back online
    await syncDirtyJobs();
  };

  const handleOffline = () => {
    useJobStore.getState().setOnline(false);
  };

  if (typeof window !== "undefined") {
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    // Set initial state
    useJobStore.getState().setOnline(navigator.onLine);
  }

  return () => {
    if (typeof window !== "undefined") {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    }
  };
}
