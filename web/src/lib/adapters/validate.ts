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
