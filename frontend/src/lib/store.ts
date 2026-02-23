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

export const useJobStore = create<JobState>((set, get) => ({
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
      const newLocalJob: LocalJob = {
        id: jobId,
        userId,
        address: jobData.address,
        status: jobData.status,
        created_at: jobData.created_at,
        certificate_type: jobData.certificate_type || "EICR",
        circuits: jobData.circuits,
        observations: jobData.observations,
        board_info: jobData.board_info,
        boards: jobData.boards,
        installation_details: jobData.installation_details,
        supply_characteristics: jobData.supply_characteristics,
        inspection_schedule: jobData.inspection_schedule,
        inspector_id: jobData.inspector_id,
        extent_and_type: jobData.extent_and_type,
        design_construction: jobData.design_construction,
        isDirty: false,
        lastModified: Date.now(),
        lastSynced: Date.now(),
      };
      await saveLocalJob(newLocalJob);
      set({ currentJob: jobData, userId, isDirty: false });
    }

    await get().refreshPendingCount();
  },

  updateCircuits: (circuits) => {
    const { currentJob, userId } = get();
    if (!currentJob || !userId) return;

    const updatedJob = { ...currentJob, circuits };
    set({ currentJob: updatedJob, isDirty: true });

    // Persist to IndexedDB
    const localJob: LocalJob = {
      id: currentJob.id,
      userId,
      address: currentJob.address,
      status: currentJob.status,
      created_at: currentJob.created_at,
      certificate_type: currentJob.certificate_type,
      circuits,
      observations: currentJob.observations,
      board_info: currentJob.board_info,
      boards: currentJob.boards,
      installation_details: currentJob.installation_details,
      supply_characteristics: currentJob.supply_characteristics,
      inspection_schedule: currentJob.inspection_schedule,
      inspector_id: currentJob.inspector_id,
      extent_and_type: currentJob.extent_and_type,
      design_construction: currentJob.design_construction,
      isDirty: true,
      lastModified: Date.now(),
      lastSynced: null,
    };
    saveLocalJob(localJob);
    get().refreshPendingCount();
  },

  updateObservations: (observations) => {
    const { currentJob, userId } = get();
    if (!currentJob || !userId) return;

    const updatedJob = { ...currentJob, observations };
    set({ currentJob: updatedJob, isDirty: true });

    const localJob: LocalJob = {
      id: currentJob.id,
      userId,
      address: currentJob.address,
      status: currentJob.status,
      created_at: currentJob.created_at,
      certificate_type: currentJob.certificate_type,
      circuits: currentJob.circuits,
      observations,
      board_info: currentJob.board_info,
      boards: currentJob.boards,
      installation_details: currentJob.installation_details,
      supply_characteristics: currentJob.supply_characteristics,
      inspection_schedule: currentJob.inspection_schedule,
      inspector_id: currentJob.inspector_id,
      extent_and_type: currentJob.extent_and_type,
      design_construction: currentJob.design_construction,
      isDirty: true,
      lastModified: Date.now(),
      lastSynced: null,
    };
    saveLocalJob(localJob);
    get().refreshPendingCount();
  },

  updateBoardInfo: (boardInfo) => {
    const { currentJob, userId } = get();
    if (!currentJob || !userId) return;

    const updatedJob = { ...currentJob, board_info: boardInfo };
    set({ currentJob: updatedJob, isDirty: true });

    const localJob: LocalJob = {
      id: currentJob.id,
      userId,
      address: currentJob.address,
      status: currentJob.status,
      created_at: currentJob.created_at,
      certificate_type: currentJob.certificate_type,
      circuits: currentJob.circuits,
      observations: currentJob.observations,
      board_info: boardInfo,
      boards: currentJob.boards,
      installation_details: currentJob.installation_details,
      supply_characteristics: currentJob.supply_characteristics,
      inspection_schedule: currentJob.inspection_schedule,
      inspector_id: currentJob.inspector_id,
      extent_and_type: currentJob.extent_and_type,
      design_construction: currentJob.design_construction,
      isDirty: true,
      lastModified: Date.now(),
      lastSynced: null,
    };
    saveLocalJob(localJob);
    get().refreshPendingCount();
  },

  updateBoards: (boards) => {
    const { currentJob, userId } = get();
    if (!currentJob || !userId) return;

    // When updating boards, also sync flat board_info and circuits for backward compat
    const primaryBoard = boards[0];
    const flatBoardInfo = primaryBoard ? primaryBoard.board_info : currentJob.board_info;
    const flatCircuits = boards.length === 1 && primaryBoard ? primaryBoard.circuits : currentJob.circuits;

    const updatedJob = { ...currentJob, boards, board_info: flatBoardInfo, circuits: flatCircuits };
    set({ currentJob: updatedJob, isDirty: true });

    const localJob: LocalJob = {
      id: currentJob.id,
      userId,
      address: currentJob.address,
      status: currentJob.status,
      created_at: currentJob.created_at,
      certificate_type: currentJob.certificate_type,
      circuits: flatCircuits,
      observations: currentJob.observations,
      board_info: flatBoardInfo,
      boards,
      installation_details: currentJob.installation_details,
      supply_characteristics: currentJob.supply_characteristics,
      inspection_schedule: currentJob.inspection_schedule,
      inspector_id: currentJob.inspector_id,
      extent_and_type: currentJob.extent_and_type,
      design_construction: currentJob.design_construction,
      isDirty: true,
      lastModified: Date.now(),
      lastSynced: null,
    };
    saveLocalJob(localJob);
    get().refreshPendingCount();
  },

  updateInstallationDetails: (details) => {
    const { currentJob, userId } = get();
    if (!currentJob || !userId) return;

    const updatedJob = { ...currentJob, installation_details: details };
    set({ currentJob: updatedJob, isDirty: true });

    const localJob: LocalJob = {
      id: currentJob.id,
      userId,
      address: currentJob.address,
      status: currentJob.status,
      created_at: currentJob.created_at,
      certificate_type: currentJob.certificate_type,
      circuits: currentJob.circuits,
      observations: currentJob.observations,
      board_info: currentJob.board_info,
      boards: currentJob.boards,
      installation_details: details,
      supply_characteristics: currentJob.supply_characteristics,
      inspection_schedule: currentJob.inspection_schedule,
      inspector_id: currentJob.inspector_id,
      extent_and_type: currentJob.extent_and_type,
      design_construction: currentJob.design_construction,
      isDirty: true,
      lastModified: Date.now(),
      lastSynced: null,
    };
    saveLocalJob(localJob);
    get().refreshPendingCount();
  },

  updateSupplyCharacteristics: (supply) => {
    const { currentJob, userId } = get();
    if (!currentJob || !userId) return;

    const updatedJob = { ...currentJob, supply_characteristics: supply };
    set({ currentJob: updatedJob, isDirty: true });

    const localJob: LocalJob = {
      id: currentJob.id,
      userId,
      address: currentJob.address,
      status: currentJob.status,
      created_at: currentJob.created_at,
      certificate_type: currentJob.certificate_type,
      circuits: currentJob.circuits,
      observations: currentJob.observations,
      board_info: currentJob.board_info,
      boards: currentJob.boards,
      installation_details: currentJob.installation_details,
      supply_characteristics: supply,
      inspection_schedule: currentJob.inspection_schedule,
      inspector_id: currentJob.inspector_id,
      extent_and_type: currentJob.extent_and_type,
      design_construction: currentJob.design_construction,
      isDirty: true,
      lastModified: Date.now(),
      lastSynced: null,
    };
    saveLocalJob(localJob);
    get().refreshPendingCount();
  },

  updateInspectionSchedule: (schedule) => {
    const { currentJob, userId } = get();
    if (!currentJob || !userId) return;

    const updatedJob = { ...currentJob, inspection_schedule: schedule };
    set({ currentJob: updatedJob, isDirty: true });

    const localJob: LocalJob = {
      id: currentJob.id,
      userId,
      address: currentJob.address,
      status: currentJob.status,
      created_at: currentJob.created_at,
      certificate_type: currentJob.certificate_type,
      circuits: currentJob.circuits,
      observations: currentJob.observations,
      board_info: currentJob.board_info,
      boards: currentJob.boards,
      installation_details: currentJob.installation_details,
      supply_characteristics: currentJob.supply_characteristics,
      inspection_schedule: schedule,
      inspector_id: currentJob.inspector_id,
      extent_and_type: currentJob.extent_and_type,
      design_construction: currentJob.design_construction,
      isDirty: true,
      lastModified: Date.now(),
      lastSynced: null,
    };
    saveLocalJob(localJob);
    get().refreshPendingCount();
  },

  setInspectorId: (inspectorId) => {
    const { currentJob, userId } = get();
    if (!currentJob || !userId) return;

    const updatedJob = { ...currentJob, inspector_id: inspectorId };
    set({ currentJob: updatedJob, isDirty: true });

    const localJob: LocalJob = {
      id: currentJob.id,
      userId,
      address: currentJob.address,
      status: currentJob.status,
      created_at: currentJob.created_at,
      certificate_type: currentJob.certificate_type,
      circuits: currentJob.circuits,
      observations: currentJob.observations,
      board_info: currentJob.board_info,
      boards: currentJob.boards,
      installation_details: currentJob.installation_details,
      supply_characteristics: currentJob.supply_characteristics,
      inspection_schedule: currentJob.inspection_schedule,
      inspector_id: inspectorId,
      extent_and_type: currentJob.extent_and_type,
      design_construction: currentJob.design_construction,
      isDirty: true,
      lastModified: Date.now(),
      lastSynced: null,
    };
    saveLocalJob(localJob);
    get().refreshPendingCount();
  },

  updateExtentAndType: (extentAndType) => {
    const { currentJob, userId } = get();
    if (!currentJob || !userId) return;

    const updatedJob = { ...currentJob, extent_and_type: extentAndType };
    set({ currentJob: updatedJob, isDirty: true });

    const localJob: LocalJob = {
      id: currentJob.id,
      userId,
      address: currentJob.address,
      status: currentJob.status,
      created_at: currentJob.created_at,
      certificate_type: currentJob.certificate_type,
      circuits: currentJob.circuits,
      observations: currentJob.observations,
      board_info: currentJob.board_info,
      boards: currentJob.boards,
      installation_details: currentJob.installation_details,
      supply_characteristics: currentJob.supply_characteristics,
      inspection_schedule: currentJob.inspection_schedule,
      inspector_id: currentJob.inspector_id,
      extent_and_type: extentAndType,
      design_construction: currentJob.design_construction,
      isDirty: true,
      lastModified: Date.now(),
      lastSynced: null,
    };
    saveLocalJob(localJob);
    get().refreshPendingCount();
  },

  updateDesignConstruction: (design) => {
    const { currentJob, userId } = get();
    if (!currentJob || !userId) return;

    const updatedJob = { ...currentJob, design_construction: design };
    set({ currentJob: updatedJob, isDirty: true });

    const localJob: LocalJob = {
      id: currentJob.id,
      userId,
      address: currentJob.address,
      status: currentJob.status,
      created_at: currentJob.created_at,
      certificate_type: currentJob.certificate_type,
      circuits: currentJob.circuits,
      observations: currentJob.observations,
      board_info: currentJob.board_info,
      boards: currentJob.boards,
      installation_details: currentJob.installation_details,
      supply_characteristics: currentJob.supply_characteristics,
      inspection_schedule: currentJob.inspection_schedule,
      inspector_id: currentJob.inspector_id,
      extent_and_type: currentJob.extent_and_type,
      design_construction: design,
      isDirty: true,
      lastModified: Date.now(),
      lastSynced: null,
    };
    saveLocalJob(localJob);
    get().refreshPendingCount();
  },

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
}));
