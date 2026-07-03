/**
 * Runtime configuration client — the web STT kill-switch (parity WS4).
 *
 * Resolves which Deepgram model a recording session uses (`flux` | `nova3`)
 * from a RUNTIME env var (`DEEPGRAM_STT_MODEL` on the `eicr-pwa` ECS task def),
 * read via a same-origin Next route at `/runtime-config`. This is deliberately
 * NOT a `NEXT_PUBLIC_*` build-time var: those are inlined at `next build` in
 * this standalone ECS deploy and cannot be flipped after field trouble without
 * a full ~30-min CI rebuild. A runtime env var can be flipped by
 * re-registering the task def + updating `eicr-pwa` (~3-5 min), and clients
 * pick it up at the next RECORDING-session config fetch.
 *
 * ⚠️ Route path is `/runtime-config` (top-level), NOT `/api/runtime-config`:
 * the production ALB has a priority-10 rule forwarding ALL `/api/*` to the
 * BACKEND target group (`infrastructure/setup-domain.sh:394-406`), so an
 * `/api/runtime-config` route would 404 in prod, the fetch-failure fail-safe
 * would pin every session to nova3, and the Flux default could never take
 * effect. Do NOT fetch this through `api-client.ts` either (its
 * `NEXT_PUBLIC_API_URL` prefix would send the request to the backend API).
 *
 * Two named constants, split on purpose:
 *   - DEFAULT_STT_MODEL — the PRODUCT default, used when the env var is MISSING
 *     (blank/undefined). Starts 'nova3'; the Flux-default flip commit changes
 *     THIS one constant (and the task-def value) to 'flux'.
 *   - SAFE_STT_MODEL — the FAIL-SAFE posture, used on an UNRECOGNISED non-empty
 *     value AND on a config-route fetch failure. NEVER flips from 'nova3'.
 * Splitting them matters: after the flip, a bad env edit or a broken
 * runtime-config route must still fail SAFE to nova3, not silently keep Flux
 * running. The task def always sets the value explicitly (`nova3` until the
 * flip, `flux` in it) so live behaviour never depends on the missing-value
 * branch.
 */

import type { SttModel } from './recording/deepgram-service';

/** Product default (env MISSING). May flip to 'flux' in the flip commit. */
export const DEFAULT_STT_MODEL: SttModel = 'nova3';

/** Fail-safe (unrecognised value OR fetch failure). NEVER flips. */
export const SAFE_STT_MODEL: SttModel = 'nova3';

/** The same-origin route path. NEVER under `/api/*` (see file header). */
export const RUNTIME_CONFIG_PATH = '/runtime-config';

/**
 * Normalise a raw env value: lowercase, strip everything but a-z0-9, so
 * `nova-3` / `Nova3` / `nova_3` / `NOVA 3` all resolve to `nova3`, and
 * `Flux` / `flux` to `flux`. The likeliest emergency-edit error (a hyphen or
 * casing slip in `nova-3`) must NOT silently keep Flux running.
 */
function normaliseRaw(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Resolve a raw env value (or null/undefined for MISSING) into an `SttModel`.
 *  - MISSING (null/undefined/blank) → DEFAULT_STT_MODEL (product default).
 *  - normalises to 'nova3' → 'nova3'.
 *  - normalises to 'flux'  → 'flux'.
 *  - any other non-empty   → SAFE_STT_MODEL + a loud diagnostic naming the raw.
 */
export function resolveSttModel(raw: string | null | undefined): SttModel {
  if (raw == null || raw.trim() === '') {
    return DEFAULT_STT_MODEL;
  }
  const norm = normaliseRaw(raw);
  if (norm === 'nova3') return 'nova3';
  if (norm === 'flux') return 'flux';
  // Unrecognised non-empty value — fail SAFE and shout so a bad emergency
  // edit is diagnosable from the console/logs.
  console.error(
    `[runtime-config] Unrecognised DEEPGRAM_STT_MODEL value ${JSON.stringify(raw)} — falling back to SAFE_STT_MODEL='${SAFE_STT_MODEL}'.`
  );
  return SAFE_STT_MODEL;
}

// Module-level cache of the last resolved model. `null` until the first
// successful (or failed → fail-safe) load. Reused by reconnects; `force`
// re-fetches (a new recording session picks up an ECS env flip).
let cachedModel: SttModel | null = null;

/**
 * Fetch `/runtime-config` and resolve the STT model. Cached at module level;
 * pass `{ force: true }` to re-fetch (every RECORDING-session `start()` forces
 * so an emergency ECS flip is picked up without a page reload — the
 * `RecordingProvider` stays mounted across stop/start cycles, so an app-session
 * cache would ignore the flip until reload).
 *
 * A fetch failure OR a non-JSON body (e.g. an expired-token `/login` HTML
 * redirect — the route sits behind the middleware JWT gate) resolves to
 * SAFE_STT_MODEL with a loud diagnostic. Recording only runs authenticated, so
 * the redirect case is not expected in practice, but failing safe is correct.
 */
export async function ensureRuntimeConfigLoaded(opts?: { force?: boolean }): Promise<SttModel> {
  if (!opts?.force && cachedModel != null) return cachedModel;
  try {
    const res = await fetch(RUNTIME_CONFIG_PATH, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      console.error(
        `[runtime-config] /runtime-config returned ${res.status} — falling back to SAFE_STT_MODEL='${SAFE_STT_MODEL}'.`
      );
      cachedModel = SAFE_STT_MODEL;
      return cachedModel;
    }
    const body = (await res.json()) as { sttModel?: string | null };
    cachedModel = resolveSttModel(body?.sttModel);
    return cachedModel;
  } catch (err) {
    // Network failure OR JSON parse failure (non-JSON body, e.g. a /login
    // HTML redirect). Fail SAFE.
    console.error(
      `[runtime-config] fetch/parse failed (${err instanceof Error ? err.message : String(err)}) — falling back to SAFE_STT_MODEL='${SAFE_STT_MODEL}'.`
    );
    cachedModel = SAFE_STT_MODEL;
    return cachedModel;
  }
}

/** The last resolved model (synchronous). `DEFAULT_STT_MODEL` if never loaded. */
export function getResolvedSttModel(): SttModel {
  return cachedModel ?? DEFAULT_STT_MODEL;
}

/** Test-only: reset the module cache so cases don't leak between tests. */
export function __resetRuntimeConfigCacheForTests(): void {
  cachedModel = null;
}
