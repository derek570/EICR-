/**
 * Auth wire schemas — `/api/auth/login`, `/api/auth/me`.
 *
 * The `User` shape round-trips between iOS + web + backend: the JWT
 * claim set is a subset of these fields. Keep the enum literals (`role`,
 * `company_role`) aligned with the backend (`src/auth.js:121`).
 */

import { z } from 'zod';

const ROLE = z.enum(['admin', 'user']);
const COMPANY_ROLE = z.enum(['owner', 'admin', 'employee']);

export const UserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  company_name: z.string().optional(),
  role: ROLE.optional(),
  // Nullable at the JWT layer for legacy users not yet bound to a
  // company — see `CLAUDE.md > RBAC` and P0-5/D4 in the fix plan.
  company_id: z.string().optional(),
  company_role: COMPANY_ROLE.optional(),
});

export const LoginResponseSchema = z.object({
  token: z.string(),
  user: UserSchema,
});
