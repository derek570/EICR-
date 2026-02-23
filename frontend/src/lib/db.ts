import Dexie, { type EntityTable } from "dexie";
import type {
  JobDetail,
  Circuit,
  Observation,
  BoardInfo,
  Board,
  CertificateType,
  InstallationDetails,
  SupplyCharacteristics,
  InspectionSchedule,
  ExtentAndType,
  DesignConstruction
} from "./api";

// Local job record with sync metadata
export interface LocalJob {
  id: string;
  userId: string;
  address: string;
  status: "pending" | "processing" | "done" | "failed";
  created_at: string;
  certificate_type: CertificateType;
  circuits: Circuit[];
  observations: Observation[];
  board_info: BoardInfo;
  boards?: Board[];
  // New fields for restored tabs
  installation_details?: InstallationDetails;
  supply_characteristics?: SupplyCharacteristics;
  inspection_schedule?: InspectionSchedule;
  inspector_id?: string;
  // EIC-specific
  extent_and_type?: ExtentAndType;
  design_construction?: DesignConstruction;
  // Sync metadata
  isDirty: boolean;
  lastModified: number;
  lastSynced: number | null;
}

// Dexie database class
class EICRDatabase extends Dexie {
  jobs!: EntityTable<LocalJob, "id">;

  constructor() {
    super("EICRoMatic");
    // Version 3: Added boards[] for multi-board support
    this.version(3).stores({
      jobs: "id, userId, isDirty, lastModified, certificate_type",
    });
    // Version 2: Added certificate_type, installation_details, supply_characteristics,
    // inspection_schedule, inspector_id, extent_and_type, design_construction
    this.version(2).stores({
      jobs: "id, userId, isDirty, lastModified, certificate_type",
    });
    // Keep version 1 for migration
    this.version(1).stores({
      jobs: "id, userId, isDirty, lastModified",
    });
  }
}

export const db = new EICRDatabase();

// Helper functions
export async function getLocalJob(jobId: string): Promise<LocalJob | undefined> {
  return db.jobs.get(jobId);
}

export async function saveLocalJob(job: LocalJob): Promise<void> {
  await db.jobs.put(job);
}

export async function getDirtyJobs(userId: string): Promise<LocalJob[]> {
  return db.jobs.where({ userId, isDirty: 1 }).toArray();
}

export async function markJobClean(jobId: string): Promise<void> {
  await db.jobs.update(jobId, { isDirty: false, lastSynced: Date.now() });
}

export async function deleteLocalJob(jobId: string): Promise<void> {
  await db.jobs.delete(jobId);
}

export async function getAllLocalJobs(userId: string): Promise<LocalJob[]> {
  return db.jobs.where({ userId }).toArray();
}
