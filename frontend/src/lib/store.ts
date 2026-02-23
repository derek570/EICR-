import { create } from "zustand";
import type {
  JobDetail,
  Circuit,
  Observation,
  BoardInfo,
  Board,
  InstallationDetails,
  SupplyCharacteristics,
  InspectionSchedule,
  ExtentAndType,
  DesignConstruction
} from "./api";
import { db, type LocalJob, saveLocalJob, getLocalJob } from "./db";

interface JobState {
  // Current job being edited
  currentJob: JobDetail | null;
  userId: string | null;

  // Sync status
  isDirty: boolean;
  isSyncing: boolean;
  isOnline: boolean;
  pendingSyncCount: number;

  // Actions
  setUser: (userId: string | null) => void;
  loadJob: (jobId: string, jobData: JobDetail, userId: string) => Promise<void>;
  updateCircuits: (circuits: Circuit[]) => void;
  updateObservations: (observations: Observation[]) => void;
  updateBoardInfo: (boardInfo: BoardInfo) => void;
  updateBoards: (boards: Board[]) => void;
  updateInstallationDetails: (details: InstallationDetails) => void;
  updateSupplyCharacteristics: (supply: SupplyCharacteristics) => void;
  updateInspectionSchedule: (schedule: InspectionSchedule) => void;
  setInspectorId: (inspectorId: string) => void;
  updateExtentAndType: (extentAndType: ExtentAndType) => void;
  updateDesignConstruction: (design: DesignConstruction) => void;
  setOnline: (online: boolean) => void;
  setSyncing: (syncing: boolean) => void;
  markClean: () => void;
  clearJob: () => void;
  refreshPendingCount: () => Promise<void>;
}

function jobToLocal(job: JobDetail, userId: string, isDirty: boolean, lastSynced: number | null): LocalJob {
  return {
    id: job.id,
    userId,
    address: job.address,
    status: job.status,
    created_at: job.created_at,
    certificate_type: job.certificate_type,
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
    isDirty,
    lastModified: Date.now(),
    lastSynced,
  };
}

export const useJobStore = create<JobState>((set, get) => {
  /** Update one or more fields on the current job, persist to IndexedDB, and mark dirty. */
  function updateJobFields(patch: Partial<JobDetail>) {
    const { currentJob, userId } = get();
    if (!currentJob || !userId) return;

    const updatedJob = { ...currentJob, ...patch };
    set({ currentJob: updatedJob, isDirty: true });
    saveLocalJob(jobToLocal(updatedJob, userId, true, null));
    get().refreshPendingCount();
  }

  return {
    currentJob: null,
    userId: null,
    isDirty: false,
    isSyncing: false,
    isOnline: typeof navigator !== "undefined" ? navigator.onLine : true,
    pendingSyncCount: 0,

    setUser: (userId) => set({ userId }),

    loadJob: async (jobId, jobData, userId) => {
      // Check if we have a local version with unsaved changes
      const localJob = await getLocalJob(jobId);

      if (localJob && localJob.isDirty) {
        // Use local version if it has unsaved changes
        set({
          currentJob: {
            id: localJob.id,
            address: localJob.address,
            status: localJob.status,
            created_at: localJob.created_at,
            certificate_type: localJob.certificate_type || "EICR",
            circuits: localJob.circuits,
            observations: localJob.observations,
            board_info: localJob.board_info,
            boards: localJob.boards,
            installation_details: localJob.installation_details,
            supply_characteristics: localJob.supply_characteristics,
            inspection_schedule: localJob.inspection_schedule,
            inspector_id: localJob.inspector_id,
            extent_and_type: localJob.extent_and_type,
            design_construction: localJob.design_construction,
          },
          userId,
          isDirty: true,
        });
      } else {
        // Use server version and cache it locally
        await saveLocalJob(jobToLocal(jobData, userId, false, Date.now()));
        set({ currentJob: jobData, userId, isDirty: false });
      }

      await get().refreshPendingCount();
    },

    updateCircuits: (circuits) => updateJobFields({ circuits }),
    updateObservations: (observations) => updateJobFields({ observations }),
    updateBoardInfo: (boardInfo) => updateJobFields({ board_info: boardInfo }),

    updateBoards: (boards) => {
      const { currentJob } = get();
      if (!currentJob) return;

      // When updating boards, also sync flat board_info and circuits for backward compat
      const primaryBoard = boards[0];
      const board_info = primaryBoard ? primaryBoard.board_info : currentJob.board_info;
      const circuits = boards.length === 1 && primaryBoard ? primaryBoard.circuits : currentJob.circuits;

      updateJobFields({ boards, board_info, circuits });
    },

    updateInstallationDetails: (details) => updateJobFields({ installation_details: details }),
    updateSupplyCharacteristics: (supply) => updateJobFields({ supply_characteristics: supply }),
    updateInspectionSchedule: (schedule) => updateJobFields({ inspection_schedule: schedule }),
    setInspectorId: (inspectorId) => updateJobFields({ inspector_id: inspectorId }),
    updateExtentAndType: (extentAndType) => updateJobFields({ extent_and_type: extentAndType }),
    updateDesignConstruction: (design) => updateJobFields({ design_construction: design }),

    setOnline: (online) => set({ isOnline: online }),

    setSyncing: (syncing) => set({ isSyncing: syncing }),

    markClean: () => {
      const { currentJob } = get();
      if (currentJob) {
        db.jobs.update(currentJob.id, { isDirty: false, lastSynced: Date.now() });
      }
      set({ isDirty: false });
      get().refreshPendingCount();
    },

    clearJob: () => set({ currentJob: null, isDirty: false }),

    refreshPendingCount: async () => {
      const { userId } = get();
      if (!userId) {
        set({ pendingSyncCount: 0 });
        return;
      }
      const dirtyJobs = await db.jobs.where({ userId }).filter(j => j.isDirty).count();
      set({ pendingSyncCount: dirtyJobs });
    },
  };
});
