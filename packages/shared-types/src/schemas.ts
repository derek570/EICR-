/**
 * Zod runtime validation schemas for API boundaries.
 * Graceful degradation: logs warnings on validation failure but never throws.
 */

import { z } from 'zod';

// ============= Auth Schemas =============

export const UserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  company_name: z.string().optional(),
});

export const AuthResponseSchema = z.object({
  token: z.string(),
  user: UserSchema,
});

// ============= Job Schemas =============

const CircuitSchema = z
  .object({
    circuit_ref: z.string(),
    circuit_designation: z.string(),
  })
  .passthrough();

const ObservationSchema = z.object({
  code: z.enum(['C1', 'C2', 'C3', 'FI']),
  item_location: z.string(),
  observation_text: z.string(),
  schedule_item: z.string().optional(),
  schedule_description: z.string().optional(),
  photos: z.array(z.string()).optional(),
});

const BoardInfoSchema = z
  .object({
    name: z.string().optional(),
    location: z.string().optional(),
    manufacturer: z.string().optional(),
  })
  .passthrough();

const BoardSchema = z.object({
  id: z.string(),
  designation: z.string(),
  location: z.string(),
  board_info: BoardInfoSchema,
  circuits: z.array(CircuitSchema),
});

export const JobSchema = z.object({
  id: z.string(),
  address: z.string(),
  status: z.enum(['pending', 'processing', 'done', 'failed']),
  created_at: z.string(),
  updated_at: z.string().optional(),
  certificate_type: z.enum(['EICR', 'EIC']).optional(),
});

export const JobDetailSchema = JobSchema.extend({
  certificate_type: z.enum(['EICR', 'EIC']),
  circuits: z.array(CircuitSchema),
  observations: z.array(ObservationSchema),
  board_info: BoardInfoSchema,
  boards: z.array(BoardSchema).optional(),
  installation_details: z.unknown().optional(),
  supply_characteristics: z.unknown().optional(),
  inspection_schedule: z.unknown().optional(),
  inspector_id: z.string().optional(),
  extent_and_type: z.unknown().optional(),
  design_construction: z.unknown().optional(),
});

export const JobListResponseSchema = z.array(JobSchema);

// ============= Settings / Auth / Invite (Phase 6) =============

/**
 * Change-password request body (PUT /api/auth/change-password).
 * Intentionally permissive on lengths — backend enforces the ≥6 char
 * rule and surfaces the error message, we don't want to double-guard
 * here and drift from server truth.
 */
export const ChangePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(6, 'New password must be at least 6 characters'),
});

/**
 * Invite-employee request body (POST /api/companies/:companyId/invite).
 * Backend rejects empty name/email with 400; schema mirrors that so
 * form validation + server validation speak the same contract.
 */
export const InviteEmployeeRequestSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Enter a valid email address'),
});

/**
 * User defaults — circuit-field default values (PUT/GET
 * /api/settings/:userId/defaults). Backend stores a free-form JSON
 * object; shape is `Record<string, string>` so any key the UI knows
 * about round-trips untouched. Empty strings are kept verbatim (the
 * apply-defaults helper treats them as "no default" — stripping them
 * here would collapse a deliberate "clear this default" edit into a
 * no-op).
 */
export const UserDefaultsSchema = z.record(z.string(), z.string());

// ============= Validate utility =============

/**
 * Validates API response data against a Zod schema.
 * On failure: logs a warning and returns the original data (graceful degradation).
 * On success: returns the parsed/validated data.
 */
export function validateResponse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    console.warn(
      '[API Validation] Response did not match expected schema:',
      result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
    );
    return data as T;
  }
  return result.data;
}
