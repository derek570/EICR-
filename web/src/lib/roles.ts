import type { User } from './types';

/**
 * Role predicates. iOS uses `user.isAdmin` and `user.isCompanyAdmin`
 * computed properties; the web mirrors them here so role checks stay
 * consistent across the codebase and easy to update when the role
 * model evolves.
 *
 * `isSystemAdmin` — the top-tier "platform admin" flag. Grants access
 * to /settings/admin/* (user CRUD, lockout management, etc.).
 *
 * `isCompanyAdmin` — EITHER a system admin OR a company `owner` /
 * `admin`. Grants access to company-scoped admin surfaces (invite
 * employees, edit branding, see team-wide stats). System admins are
 * always company-admins so the fallback holds for cross-tenant ops.
 *
 * These are the ONLY role helpers callers should use — do not inline
 * `u?.role === 'admin'` at the call site. Keeps the entire codebase
 * pointing at a single source of truth.
 */

export function isSystemAdmin(u: User | null | undefined): boolean {
  return u?.role === 'admin';
}

export function isCompanyAdmin(u: User | null | undefined): boolean {
  if (!u) return false;
  if (isSystemAdmin(u)) return true;
  return u.company_role === 'owner' || u.company_role === 'admin';
}
