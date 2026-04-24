/**
 * Job wire schemas — list, detail, save-response.
 *
 * The `JobDetail` sections (installation, extent, supply, board, etc.)
 * are intentionally permissive `Record<string, unknown>` — they're free-
 * form field bags shared across 14 tab pages, and the per-tab phases
 * don't want a schema change to block their field additions. Use
 * `z.record(z.unknown())` here rather than `z.object().passthrough()`
 * so unknown top-level keys don't get silently stripped.
 *
 * `circuits` and `observations` DO round-trip between iOS and web, so
 * their required keys (`id`, `code`) are enforced, with an index
 * signature (`.passthrough()`) for per-tab extensions.
 */

import { z } from 'zod';

export const CircuitRowSchema = z
  .object({
    id: z.string(),
    number: z.string().optional(),
    description: z.string().optional(),
  })
  .passthrough();

export const ObservationRowSchema = z
  .object({
    id: z.string(),
    code: z.enum(['C1', 'C2', 'C3', 'FI']).optional(),
    description: z.string().optional(),
    location: z.string().optional(),
    remedial: z.string().optional(),
    // Filenames only — the bytes live in S3 under
    // jobs/{userId}/{folderName}/photos/{filename}. See notes on the
    // ObservationRow type for the read path.
    photos: z.array(z.string()).optional(),
  })
  .passthrough();

export const InspectorInfoSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    position: z.string().optional(),
    enrolment_number: z.string().optional(),
    signature_key: z.string().optional(),
    organisation: z.string().optional(),
  })
  .passthrough();

const CERT_TYPE = z.enum(['EICR', 'EIC']);
const JOB_STATUS = z.enum(['pending', 'processing', 'done', 'failed']);

/** List-view shape — just enough to render the dashboard row. */
export const JobSchema = z.object({
  id: z.string(),
  address: z.string(),
  status: JOB_STATUS,
  created_at: z.string(),
  updated_at: z.string().optional(),
  certificate_type: CERT_TYPE.optional(),
});

export const JobListSchema = z.array(JobSchema);

/**
 * Full tab-payload. Each section is a permissive record because
 * per-tab schemas (installation vs supply vs extent) live in their
 * own files and evolve independently. The adapter boundary only
 * enforces the envelope — individual tabs validate their own fields
 * at render time.
 *
 * Keys match the backend wire shape emitted by `GET /api/job/:userId/:jobId`
 * (`src/routes/jobs.js:575-592`) and the canonical shared-types
 * JobDetailSchema (`packages/shared-types/src/schemas.ts:65-77`). iOS
 * is aligned with the backend by construction; Wave 5 on the PWA
 * replaced them with drifted single-word aliases (`installation`,
 * `supply`, `board`, …) which zod's default strip-mode silently
 * dropped, so every tab was reading an empty bucket even though the
 * server returned the data.
 */
export const JobDetailSchema = JobSchema.extend({
  installation_details: z.record(z.string(), z.unknown()).optional(),
  supply_characteristics: z.record(z.string(), z.unknown()).optional(),
  board_info: z.record(z.string(), z.unknown()).optional(),
  boards: z.array(z.record(z.string(), z.unknown())).optional(),
  circuits: z.array(CircuitRowSchema).optional(),
  observations: z.array(ObservationRowSchema).optional(),
  inspection_schedule: z.record(z.string(), z.unknown()).optional(),
  extent_and_type: z.record(z.string(), z.unknown()).optional(),
  design_construction: z.record(z.string(), z.unknown()).optional(),
  inspector_id: z.string().optional(),
  // CCU analysis — most-recent flat copy + per-board map. See the
  // `ccu_analysis_by_board` comment on `JobDetail` for the multi-board
  // scoping decision (P0-3).
  ccu_analysis: z.record(z.string(), z.unknown()).optional(),
  ccu_analysis_by_board: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  last_session_id: z.string().optional(),
});

export const CreateJobResponseSchema = z.object({ id: z.string() });
export const DeleteJobResponseSchema = z.object({ success: z.boolean() });
export const SaveJobResponseSchema = z.object({ success: z.boolean() });

/** Deepgram key-mint response — single short-lived JWT. */
export const DeepgramKeyResponseSchema = z.object({ key: z.string() });
