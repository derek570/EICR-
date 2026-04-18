/**
 * System-admin wire schemas — `/api/admin/users/*`.
 *
 * `AdminUser` extends the public `User` with lifecycle metadata
 * (active flag, lockout, last-login, created-at). Read-mostly +
 * mutate via dedicated endpoints (update / reset-password / unlock).
 */

import { z } from 'zod';
import { UserSchema } from './auth';
import { paginatedSchema } from './company';

export const AdminUserSchema = UserSchema.extend({
  is_active: z.boolean().optional(),
  last_login: z.string().nullable().optional(),
  locked_until: z.string().nullable().optional(),
  failed_login_attempts: z.number().optional(),
  created_at: z.string().optional(),
}).passthrough();

export const AdminUserListSchema = paginatedSchema(AdminUserSchema);

export const AdminSuccessResponseSchema = z.object({ success: z.literal(true) });

/**
 * Minimal `{id, name}` pairs returned by `GET /api/admin/users/companies/list`.
 *
 * Deliberately NOT reusing the full CompanySchema — the admin picker only
 * needs `id` + `name`. A strict shape here means a zod drift at the
 * picker endpoint surfaces via `parseOrWarn` even though the payload
 * is tiny.
 */
export const CompanyLiteSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export const CompanyLiteListSchema = z.array(CompanyLiteSchema);
