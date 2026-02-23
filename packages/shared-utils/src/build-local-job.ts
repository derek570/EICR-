import type { JobDetail } from "@certmate/shared-types";

export interface LocalJobInput {
  id: string;
  userId: string;
  currentJob: JobDetail;
  overrides?: Partial<JobDetail>;
  isDirty: boolean;
  lastSynced: number | null;
}

export interface LocalJobRecord {
  id: string;
  userId: string;
  address: string;
  status: "pending" | "processing" | "done" | "failed";
  created_at: string;
  certificate_type: "EICR" | "EIC";
  circuits: JobDetail["circuits"];
  observations: JobDetail["observations"];
  board_info: JobDetail["board_info"];
  boards?: JobDetail["boards"];
  installation_details?: JobDetail["installation_details"];
  supply_characteristics?: JobDetail["supply_characteristics"];
  inspection_schedule?: JobDetail["inspection_schedule"];
  inspector_id?: JobDetail["inspector_id"];
  extent_and_type?: JobDetail["extent_and_type"];
  design_construction?: JobDetail["design_construction"];
  isDirty: boolean;
  lastModified: number;
  lastSynced: number | null;
}

export function buildLocalJob(input: LocalJobInput): LocalJobRecord {
  const job = { ...input.currentJob, ...input.overrides };
  return {
    id: input.id,
    userId: input.userId,
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
    isDirty: input.isDirty,
    lastModified: Date.now(),
    lastSynced: input.lastSynced,
  };
}
