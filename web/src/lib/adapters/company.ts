/**
 * Company-admin wire schemas — `/api/companies/:companyId/*`.
 *
 * Thin read-only projections plus an invite-response envelope. The
 * `CompanyJobRow` shape deliberately carries `user_id` + `employee_*`
 * fields so the dashboard can render the "who owns this job" column
 * without a second round-trip.
 */

import { z } from 'zod';

const ROLE = z.enum(['admin', 'user']);
const COMPANY_ROLE = z.enum(['owner', 'admin', 'employee']);
const JOB_STATUS = z.enum(['pending', 'processing', 'done', 'failed']);
const CERT_TYPE = z.enum(['EICR', 'EIC']);

export const CompanyMemberSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    role: ROLE.optional(),
    company_role: COMPANY_ROLE.optional(),
    is_active: z.boolean().optional(),
    last_login: z.string().nullable().optional(),
    created_at: z.string().optional(),
  })
  .passthrough();

export const CompanyMemberListSchema = z.array(CompanyMemberSchema);

export const CompanyJobRowSchema = z
  .object({
    id: z.string(),
    address: z.string().nullable(),
    status: JOB_STATUS,
    created_at: z.string(),
    updated_at: z.string().optional(),
    certificate_type: CERT_TYPE.optional(),
    user_id: z.string().optional(),
    employee_name: z.string().nullable().optional(),
    employee_email: z.string().nullable().optional(),
  })
  .passthrough();

/**
 * Paginated envelope — matches `utils/pagination.js#paginatedResponse`
 * on the backend. We use a factory so each consumer can pass its own
 * row schema without type gymnastics.
 */
export function paginatedSchema<T extends z.ZodTypeAny>(row: T) {
  return z.object({
    data: z.array(row),
    pagination: z.object({
      limit: z.number(),
      offset: z.number(),
      total: z.number(),
      hasMore: z.boolean(),
    }),
  });
}

export const CompanyJobListSchema = paginatedSchema(CompanyJobRowSchema);

export const CompanyStatsSchema = z
  .object({
    company: z
      .object({
        id: z.string(),
        name: z.string(),
        is_active: z.boolean().optional(),
        created_at: z.string().optional(),
      })
      .passthrough()
      .optional(),
    jobs_by_status: z.record(z.string(), z.number()).optional(),
    total_jobs: z.number().optional(),
    active_employees: z.number().optional(),
    jobs_last_7_days: z.number().optional(),
  })
  .passthrough();

/**
 * The plaintext temporary password is returned exactly once and should
 * be treated as secret-adjacent PII — caller shows in a modal, never
 * persists to state after the modal closes. See the `InviteEmployeeResponse`
 * comment in types.ts for the caller contract.
 */
export const InviteEmployeeResponseSchema = z.object({
  userId: z.string(),
  email: z.string(),
  name: z.string(),
  temporaryPassword: z.string(),
});
