/**
 * Adapter boundary — safeParse helper.
 *
 * Every api-client response is routed through `parseOrWarn`. On success,
 * the zod-parsed data is returned (which also strips unknown keys that
 * aren't explicitly whitelisted via `.passthrough()` / `.catchall(...)`
 * on the schema). On failure, a warning is logged with the offending
 * issue paths and the ORIGINAL raw data is returned unchanged.
 *
 * Why graceful degradation instead of throwing:
 *   - The web client has never validated wire shapes before Wave 2b.
 *     Turning on `safeParse(...).data!` semantics would have callers
 *     crashing on every backend prompt evolution. We'd spend the first
 *     week of Wave 2b chasing false-positive schema regressions.
 *   - The backend is the source of truth. A schema drift is a bug we
 *     want to SEE (via the console warning + observability later) but
 *     not a reason to block the user from finishing a certificate.
 *   - The legacy code already treats these shapes as permissive
 *     (`Record<string, unknown>` on JobDetail sections, `[key: string]:
 *     unknown` index signatures on CircuitRow / CCUAnalysisCircuit).
 *     Parsing strictly would fight the existing contract.
 *
 * If a future wave wants strict parsing (throw on drift) for specific
 * endpoints, add a `parseOrThrow` variant — don't flip the default.
 */

import { z, type ZodTypeAny } from 'zod';
import { ApiError } from '../types';

export function parseOrWarn<S extends ZodTypeAny>(
  schema: S,
  data: unknown,
  context: string
): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    // One-line issue summary — the full zod issue tree is noisy and
    // obscures the signal when 15 fields are optional-and-missing.
    const issues = result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`);
    console.warn(`[adapters] ${context} did not match schema; returning raw data.`, issues);
    // The raw data is returned as-is (cast) so callers that rely on
    // permissive fields still work. This preserves the pre-Wave-2b
    // behaviour byte-for-byte.
    return data as z.infer<S>;
  }
  return result.data;
}

/**
 * Strict variant of `parseOrWarn` — throws an `ApiError` on schema drift
 * instead of falling back to the raw payload. Scoped to call sites where
 * silent acceptance of a malformed response is materially unsafe:
 *
 *   - **Login** — accepting a malformed `LoginResponse` lets a broken
 *     payload write garbage `token` / `user` into localStorage. The
 *     downstream `/api/auth/me` fetch then fails in ways that are hard
 *     to distinguish from real auth failures.
 *   - **Admin writes** (adminUpdateUser, adminResetPassword,
 *     adminUnlockUser) — destructive operations where a `{success: true}`
 *     response is the ONLY signal the action landed. A mis-shaped
 *     response would silently read as success and the admin would have
 *     no indication their action failed. Throwing surfaces the problem
 *     immediately in the UI's existing error path.
 *
 * Everything else stays on `parseOrWarn` — reads are better off
 * degrading gracefully so a backend prompt evolution doesn't break the
 * inspector's read-only workflows.
 *
 * The thrown `ApiError` carries:
 *   - `status` — the HTTP status that was returned (2xx, since the fetch
 *     succeeded before we got here)
 *   - `message = 'Response shape invalid'`
 *   - `body` — the raw response payload, so callers can still inspect
 *     what came back if they catch the error
 *
 * Reusing `ApiError` (not a new class) means existing `err instanceof
 * ApiError` branches in form handlers continue to work without
 * migration.
 */
export function parseOrThrow<S extends ZodTypeAny>(
  schema: S,
  data: unknown,
  context: string,
  httpStatus = 200
): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`);
    console.warn(`[adapters] ${context} did not match schema; throwing.`, issues);
    throw new ApiError(httpStatus, 'Response shape invalid', data);
  }
  return result.data;
}
