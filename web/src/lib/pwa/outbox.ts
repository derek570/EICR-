import type { JobDetail } from '@/lib/types';
import {
  DB_NAME,
  OUTBOX_INDEX_BY_USER,
  STORE_OUTBOX,
  isSupported,
  openDB,
  wrapRequest,
  wrapTransaction,
  wrapTransactionStrict,
} from './job-cache';

/**
 * Offline mutation queue (Phase 7c).
 *
 * Purpose: when an inspector edits a job field while offline (subway,
 * basement consumer-unit room, flaky 3G on a rural site visit), the
 * current write path — `api.saveJob` — rejects and the edit is lost.
 * This store captures each mutation in IndexedDB so the replay worker
 * (`outbox-replay.ts`) can retry it as soon as connectivity returns, and
 * the next `/dashboard` / `/job/[id]` visit reads the optimistic value
 * from the IDB read-through cache (Phase 7b) instead of the stale server
 * state.
 *
 * Why a new module rather than growing `job-cache.ts`:
 *   - The read cache and the write queue have different lifetimes:
 *     read cache is best-effort + overwritten on every network success;
 *     the outbox is durable until successfully replayed or poisoned.
 *   - Keeping the outbox self-contained means the replay worker can
 *     evolve (add new op kinds beyond `saveJob`, new backoff policies)
 *     without touching the SWR read path that Phase 7b hardened.
 *   - Phase 7d UI (pending-count badges, conflict modals) imports only
 *     from here — not from the whole read-cache surface.
 *
 * Why vanilla IDB (same answer as job-cache.ts):
 *   - Three new functions on a store we already manage — the `idb`
 *     package would outweigh the code it'd save.
 *   - `openDB` / `wrapRequest` / `wrapTransaction` are reused from
 *     `job-cache.ts` (exported in Phase 7c) so the schema version is
 *     owned in one place.
 *
 * Conflict model (last-writer-wins):
 *   - `saveJob` is already a PATCH — only the dirty fields are sent.
 *     When the replay worker retries, the server merges the patch into
 *     whatever current state it holds. This matches iOS
 *     `APIClient.saveJob` behaviour, so a web inspector toggling a
 *     field offline while an iOS inspector edits the same job online
 *     produces the same final doc on both clients (the last replay
 *     wins per-field). The alternative — surfacing a conflict dialog
 *     — would require per-field base versions that the backend doesn't
 *     yet emit. Kept simple for parity; future phases can upgrade if
 *     conflicts prove a real problem in the field.
 */

export type OutboxOp = 'saveJob';

export interface OutboxMutation {
  /** uuid v4 — stable primary key across attempts. */
  id: string;
  op: OutboxOp;
  userId: string;
  jobId: string;
  /**
   * The patch the caller originally supplied. Stored verbatim so the
   * replay worker doesn't need to reconstruct it from in-memory state
   * (which is gone after a tab close).
   */
  patch: Partial<JobDetail>;
  /** ms since epoch; used for FIFO ordering + pending-age display. */
  createdAt: number;
  /** Count of network attempts that have failed. 0 until first retry. */
  attempts: number;
  /**
   * ms since epoch. The replay worker skips any row whose
   * `nextAttemptAt > Date.now()`. Fresh rows default to `createdAt` so
   * the initial write attempt happens immediately (the replay worker's
   * mount-pass + 'online' event will pick them up on the next tick).
   */
  nextAttemptAt: number;
  /** Last error string — surfaced in Phase 7d UI, ignored by the loop. */
  lastError?: string;
  /**
   * Once `attempts` has reached MAX_ATTEMPTS without success, the row
   * is marked poisoned and skipped by the replay worker. A Phase 7d
   * admin UI will surface + offer to re-queue or discard these. The
   * alternative — discarding silently — would drop user data without
   * feedback, which CLAUDE.md §"never swallow user work" rules out.
   */
  poisoned?: boolean;
}

/**
 * Retry policy. Kept small and readable — these are the numbers an
 * operator would want to reason about during a live incident.
 *
 * - BASE_BACKOFF_MS: minimum wait between attempts (covers transient
 *   blips without thrashing the network).
 * - MAX_BACKOFF_MS: cap so we don't end up with a 10-minute retry stall
 *   when the user has been continuously online.
 * - MAX_ATTEMPTS: after this many 4xx/5xx/network failures a row is
 *   poisoned. 10 is long enough to weather an hour-ish of spotty
 *   connectivity (2s, 4s, 8s, 16s, 32s, 64s, 128s, 256s, 300s, 300s
 *   — totals ~18 minutes at the cap) without retaining a permanently
 *   broken mutation that'll 4xx every time it replays.
 */
const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 5 * 60 * 1_000;
export const MAX_ATTEMPTS = 10;

function generateId(): string {
  // crypto.randomUUID is in every evergreen browser + Node 19+;
  // the type-check guard keeps SSR + older-Safari-that-shouldn't-be-here
  // from crashing — we fall back to a non-crypto uuid-shaped string so
  // the replay worker can still key rows even in the degenerate case.
  const maybeCrypto = typeof globalThis.crypto !== 'undefined' ? globalThis.crypto : null;
  if (maybeCrypto && typeof maybeCrypto.randomUUID === 'function') {
    return maybeCrypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Compute the next retry timestamp for a mutation that just failed its
 * `attempts + 1`-th attempt. Callers pass the NEW attempt count (i.e.
 * after incrementing) so the first retry waits BASE_BACKOFF_MS, the
 * second waits 2×, etc. Capped at MAX_BACKOFF_MS.
 */
function backoffUntil(newAttempts: number, now: number): number {
  // 2^(n-1) so attempts=1 → 2s, attempts=2 → 4s, attempts=3 → 8s...
  const exp = Math.pow(2, Math.max(0, newAttempts - 1));
  const wait = Math.min(BASE_BACKOFF_MS * exp, MAX_BACKOFF_MS);
  return now + wait;
}

/**
 * Append a new `saveJob` mutation to the outbox. Returns the stored
 * record so the caller can thread the id through an optimistic UI
 * without a second read. On IDB failure we surface the error to the
 * caller (unlike read-cache helpers which swallow) — a missed queue
 * write would silently drop the inspector's edit, which is exactly the
 * failure mode Phase 7c exists to prevent.
 */
export async function enqueueSaveJobMutation(
  userId: string,
  jobId: string,
  patch: Partial<JobDetail>
): Promise<OutboxMutation> {
  if (!isSupported()) {
    throw new Error('[outbox] IndexedDB not supported in this environment');
  }
  const now = Date.now();
  const mutation: OutboxMutation = {
    id: generateId(),
    op: 'saveJob',
    userId,
    jobId,
    patch,
    createdAt: now,
    attempts: 0,
    nextAttemptAt: now, // immediately eligible for the next replay pass
  };
  const db = await openDB();
  const tx = db.transaction(STORE_OUTBOX, 'readwrite');
  tx.objectStore(STORE_OUTBOX).put(mutation);
  // Strict wrapper — if IDB quota is blown or the tx aborts, we must
  // surface that failure to the caller so the UI can flag "offline
  // save failed" instead of silently dropping the inspector's edit.
  // The lenient `wrapTransaction` would resolve either way and the
  // missed write would never be noticed until the server state
  // diverged from what the inspector thought they saved.
  await wrapTransactionStrict(tx);
  return mutation;
}

/**
 * Return all non-poisoned mutations sorted by `createdAt` ascending
 * (FIFO replay order). Poisoned rows are omitted from the loop — a
 * Phase 7d UI will fetch them separately via `listPoisonedMutations()`
 * (added when there's a UI caller, not now — CLAUDE.md §"no hypothetical
 * abstractions").
 *
 * The sort happens client-side because IDB cursors don't guarantee
 * order across indexes and we want a stable guarantee. The outbox is
 * expected to be tiny (single-digit rows in normal use, low dozens
 * during an extended offline session), so the sort is cheap.
 */
export async function listPendingMutations(): Promise<OutboxMutation[]> {
  if (!isSupported()) return [];
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_OUTBOX, 'readonly');
    const store = tx.objectStore(STORE_OUTBOX);
    const all = (await wrapRequest(store.getAll())) as OutboxMutation[] | null;
    if (!all) return [];
    return all.filter((m) => !m.poisoned).sort((a, b) => a.createdAt - b.createdAt);
  } catch (err) {
    console.warn('[outbox] listPendingMutations failed', err);
    return [];
  }
}

/**
 * Remove a mutation — called after a successful replay. Idempotent:
 * deleting a missing key is a no-op in IDB, which matches what we want
 * when two tabs race to replay the same row (one wins the server call,
 * the other gets a 4xx on the already-applied patch).
 */
export async function removeMutation(id: string): Promise<void> {
  if (!isSupported()) return;
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_OUTBOX, 'readwrite');
    tx.objectStore(STORE_OUTBOX).delete(id);
    await wrapTransaction(tx);
  } catch (err) {
    console.warn('[outbox] removeMutation failed', err);
  }
}

/**
 * Increment the attempt count, apply exponential backoff, and poison
 * the row once it crosses MAX_ATTEMPTS. We read-modify-write in a
 * single readwrite transaction so two tabs retrying in parallel can't
 * produce an `attempts` count that drifts from the actual failure
 * count.
 */
export async function markMutationFailed(id: string, error: string): Promise<void> {
  if (!isSupported()) return;
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_OUTBOX, 'readwrite');
    const store = tx.objectStore(STORE_OUTBOX);
    const current = (await wrapRequest(store.get(id))) as OutboxMutation | null;
    if (!current) {
      // Another tab removed the row while we were failing — accept and
      // move on. Don't resurrect; the winning tab's decision stands.
      await wrapTransaction(tx);
      return;
    }
    const newAttempts = current.attempts + 1;
    const updated: OutboxMutation = {
      ...current,
      attempts: newAttempts,
      lastError: error.slice(0, 500), // cap so a stack trace can't bloat IDB
      nextAttemptAt: backoffUntil(newAttempts, Date.now()),
      poisoned: newAttempts >= MAX_ATTEMPTS,
    };
    store.put(updated);
    await wrapTransaction(tx);
  } catch (err) {
    console.warn('[outbox] markMutationFailed failed', err);
  }
}

/**
 * Mark a mutation as poisoned immediately, bypassing the attempt
 * counter. Called from the replay worker when the server returns a
 * 4xx (other than 401 — that's handled as "refresh and retry" upstream)
 * — a 400/403/404/409/422 means the patch itself is permanently
 * invalid under the current server state, so retrying will just 4xx
 * again forever. Leaving the row at the head of the FIFO queue would
 * stall every subsequent mutation (head-of-line blocking), and
 * silently discarding would lose the inspector's work. Poisoning lets
 * the loop skip past it while keeping the row visible to the Phase 7d
 * admin UI for a manual retry / discard decision.
 *
 * The `lastError` is capped at 500 chars for the same reason as
 * `markMutationFailed` (IDB bloat on stack traces).
 */
export async function markMutationPoisoned(id: string, error: string): Promise<void> {
  if (!isSupported()) return;
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_OUTBOX, 'readwrite');
    const store = tx.objectStore(STORE_OUTBOX);
    const current = (await wrapRequest(store.get(id))) as OutboxMutation | null;
    if (!current) {
      await wrapTransaction(tx);
      return;
    }
    const updated: OutboxMutation = {
      ...current,
      poisoned: true,
      lastError: error.slice(0, 500),
      // Push `nextAttemptAt` far into the future so any legacy code
      // path that forgets to check `poisoned` still won't pick it up.
      nextAttemptAt: Number.MAX_SAFE_INTEGER,
    };
    store.put(updated);
    await wrapTransaction(tx);
  } catch (err) {
    console.warn('[outbox] markMutationPoisoned failed', err);
  }
}

/**
 * Phase 7d admin UI needs to list the poisoned rows separately so an
 * inspector can re-queue or discard them. Returning them sorted by
 * `createdAt` keeps the UI stable across refreshes.
 */
export async function listPoisonedMutations(): Promise<OutboxMutation[]> {
  if (!isSupported()) return [];
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_OUTBOX, 'readonly');
    const store = tx.objectStore(STORE_OUTBOX);
    const all = (await wrapRequest(store.getAll())) as OutboxMutation[] | null;
    if (!all) return [];
    return all.filter((m) => m.poisoned).sort((a, b) => a.createdAt - b.createdAt);
  } catch (err) {
    console.warn('[outbox] listPoisonedMutations failed', err);
    return [];
  }
}

/**
 * Wipe every row in the outbox — called from `clearJobCache()` on
 * sign-out for the shared-device safety reasons documented in
 * `job-cache.ts`. Exposed here so a future ops tool could trigger it
 * without also nuking the read cache.
 */
export async function purgeOutbox(): Promise<void> {
  if (!isSupported()) return;
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_OUTBOX, 'readwrite');
    tx.objectStore(STORE_OUTBOX).clear();
    await wrapTransaction(tx);
  } catch (err) {
    console.warn('[outbox] purgeOutbox failed', err);
  }
}

// Re-export the DB constants so callers that need to inspect or extend
// the outbox (e.g. future Phase 7d UI queries) don't need two imports.
export { DB_NAME, OUTBOX_INDEX_BY_USER, STORE_OUTBOX };
