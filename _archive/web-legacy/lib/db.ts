/**
 * Dexie IndexedDB for offline-first storage
 * Ported from frontend/src/lib/db.ts
 */

import Dexie, { type EntityTable } from "dexie";
import type {
  Circuit,
  Observation,
  BoardInfo,
  Board,
  CertificateType,
  InstallationDetails,
  SupplyCharacteristics,
  InspectionSchedule,
  ExtentAndType,
  DesignConstruction,
} from "./types";

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
  installation_details?: InstallationDetails;
  supply_characteristics?: SupplyCharacteristics;
  inspection_schedule?: InspectionSchedule;
  inspector_id?: string;
  extent_and_type?: ExtentAndType;
  design_construction?: DesignConstruction;
  isDirty: boolean;
  lastModified: number;
  lastSynced: number | null;
}

class CertMateDatabase extends Dexie {
  jobs!: EntityTable<LocalJob, "id">;

  constructor() {
    super("CertMateDesktop");
    this.version(1).stores({
      jobs: "id, userId, isDirty, lastModified",
    });
    this.version(2).stores({
      jobs: "id, userId, isDirty, lastModified, certificate_type",
    });
    this.version(3).stores({
      jobs: "id, userId, isDirty, lastModified, certificate_type",
    });
  }
}

export const db = new CertMateDatabase();

export async function getLocalJob(jobId: string): Promise<LocalJob | undefined> {
  return db.jobs.get(jobId);
}

export async function saveLocalJob(job: LocalJob): Promise<void> {
  await db.jobs.put(job);
}

export async function getDirtyJobs(userId: string): Promise<LocalJob[]> {
  return db.jobs.where({ userId }).filter((j) => j.isDirty === true).toArray();
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
