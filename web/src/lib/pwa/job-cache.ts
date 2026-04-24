import type { Job, JobDetail } from '@/lib/types';

/**
 * IndexedDB read-through cache for job data (Phase 7b).
 *
 * Purpose: when the user goes offline (subway, job-site basement, flaky
 * mobile data) or the server is briefly unreachable, the dashboard job
 * list and any previously-opened job detail still render from cache
 * instead of falling to the branded /offline shell and losing access to
 * their work. The cache is *shown first* (stale-while-revalidate) so
 * every page load feels instant even when the network is fine.
 *
 * Why vanilla IDB (no `idb` package):
 *   - Only two stores, two shapes, five operations — not worth the
 *     dependency or its bundle weight.
 *   - 7c's outbox will add more stores; if that commit wants a richer
 *     wrapper it can upgrade this file then. Keep 7b focused.
 *
 * Why not React Query's persister:
 *   - The app doesn't use React Query yet — data-fetching is imperative
 *     `useEffect` + state throughout. Introducing RQ here would balloon
 *     the diff across every page that fetches a job (Phase 3–6 surface
 *     area) and obscure the actual SWR change.
 *
 * Security — shared devices:
 *   - Job records can contain the inspector's notes, address, and
 *     observations, so on `clearAuth()` (sign-out) we purge the entire
 *     cache. If user A signs out and user B signs in, the new session
 *     fetches fresh from the network under B's user ID and populates B's
 *     own cache entries.
 *   - We don't partition by user at the database level (one shared DB,
 *     records keyed by `userId`) because a hostile browser profile can
 *     read any origin-scoped IDB — partitioning wouldn't add meaningful
 *     protection, and `clearAuth()` is the only durable wipe.
 *
 * SSR / non-browser guards:
 *   - Every export early-returns a null-ish value when `indexedDB` is
 *     unavailable (SSR render, private-mode Firefox with IDB disabled,
 *     or older Safari without durable storage). Callers can always
 *     await the return value without branching on environment.
 *   - `openDB()` caches the database handle so repeated reads don't
 *     reopen the connection; the handle stays alive for the tab.
 */

/*
 * Schema versioning:
 *   v1 (Phase 7b): `jobs-list` + `job-detail` stores.
 *   v2 (Phase 7c): added `outbox` store (keyPath `id`, index `by-user` on
 *                  `userId`) for the offline mutation queue. Defined here
 *                  rather than in a separate DB so `clearJobCache()` +
 *                  `openDB()` stay the single source of truth for the
 *                  whole `certmate-cache` database — adding a second DB
 *                  would double the SSR guards, the block handling, and
 *                  the schema drift surface area for zero benefit.
 */
export const DB_NAME = 'certmate-cache';
// v3: add `app-settings` store (tour state + future settings rows).
// See tour/state.ts — the store is shared so we have ONE authoritative
// upgrade path rather than consumers sneak-upgrading through db.close()
// + manual reopen (that would invalidate this module's cached handle
// and break outbox / job cache for the rest of the tab).
export const DB_VERSION = 3;
const STORE_JOBS_LIST = 'jobs-list';
const STORE_JOB_DETAIL = 'job-detail';
export const STORE_OUTBOX = 'outbox';
export const STORE_APP_SETTINGS = 'app-settings';
export const OUTBOX_INDEX_BY_USER = 'by-user';

interface CachedJobsList {
  userId: string;
  jobs: Job[];
  cachedAt: number;
}

interface CachedJobDetail {
  key: string; // `${userId}:${jobId}` — IDB keyPath
  userId: string;
  jobId: string;
  detail: JobDetail;
  cachedAt: number;
}

// Module-scope so the open promise is shared across calls in the same tab.
// If the promise rejects (e.g. IDB quota blown), we null it out so the next
// call gets a chance to retry instead of being permanently stuck.
let dbPromise: Promise<IDBDatabase> | null = null;

export function isSupported(): boolean {
  return typeof indexedDB !== 'undefined';
}

export function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const tx = request.transaction;
      // Each branch is additive and idempotent — both v1 and v2 paths
      // must no-op when the store already exists, so an upgrade from
      // v1→v2 preserves the existing `jobs-list` / `job-detail` data
      // and only creates the missing `outbox` store. We intentionally
      // don't version-gate with `event.oldVersion` because IDB forces
      // a fresh `onupgradeneeded` anyway if the version mismatches;
      // checking `contains()` is the safe universal pattern.
      if (!db.objectStoreNames.contains(STORE_JOBS_LIST)) {
        db.createObjectStore(STORE_JOBS_LIST, { keyPath: 'userId' });
      }
      if (!db.objectStoreNames.contains(STORE_JOB_DETAIL)) {
        db.createObjectStore(STORE_JOB_DETAIL, { keyPath: 'key' });
      }
      // v2 — outbox. `id` is a client-generated uuid so a single
      // inspector can queue multiple mutations for the same jobId
      // without collisions. `by-user` index supports future per-user
      // purges; Phase 7c only needs the full-clear path but the index
      // is cheap to add during initial schema creation (adding it
      // later requires another version bump for no gain).
      if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
        const store = db.createObjectStore(STORE_OUTBOX, { keyPath: 'id' });
        store.createIndex(OUTBOX_INDEX_BY_USER, 'userId', { unique: false });
      } else if (tx) {
        // Existing store from a prior v2 open — make sure the index
        // exists (belt-and-braces for partial upgrades during dev).
        const store = tx.objectStore(STORE_OUTBOX);
        if (!store.indexNames.contains(OUTBOX_INDEX_BY_USER)) {
          store.createIndex(OUTBOX_INDEX_BY_USER, 'userId', { unique: false });
        }
      }
      // v3 — app-settings. `key`-keyed so we can add sibling settings
      // rows (tour state, theme, etc.) without another schema bump.
      if (!db.objectStoreNames.contains(STORE_APP_SETTINGS)) {
        db.createObjectStore(STORE_APP_SETTINGS, { keyPath: 'key' });
      }
      // Silence the unused-parameter lint without weakening the type:
      // the event object is often useful for debugging upgrade paths.
      void event;
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error ?? new Error('IndexedDB open failed'));
    };
    // A concurrent schema upgrade in another tab can block this open until
    // the other tab releases it. Surfacing as an error (rather than
    // hanging forever) lets callers fall back to network-only.
    request.onblocked = () => {
      dbPromise = null;
      reject(new Error('IndexedDB open blocked by another tab'));
    };
  });
  return dbPromise;
}

/**
 * Generic helper to run a transaction and resolve once `oncomplete` fires
 * (for writes) or once the request has a result (for reads). Wrapping the
 * raw IDB event API in promises keeps callers linear.
 *
 * We intentionally swallow errors to `null` / `undefined` rather than
 * letting them bubble: the cache is a best-effort optimisation, and a
 * failed cache read must never break the page — the network fetch is
 * always also in-flight. Errors are logged to console for debugging.
 */
export function wrapRequest<T>(request: IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => {
      console.warn('[job-cache] request failed', request.error);
      resolve(null);
    };
  });
}

export function wrapTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => {
      console.warn('[job-cache] transaction failed', tx.error);
      resolve();
    };
    tx.onabort = () => {
      console.warn('[job-cache] transaction aborted', tx.error);
      resolve();
    };
  });
}

/**
 * Strict variant of `wrapTransaction` for stores where silent failure
 * causes data loss rather than a stale cache. The outbox is the main
 * user — if an `enqueueSaveJobMutation` write silently no-ops because
 * IDB quota is blown or the schema has drifted, the caller returns
 * success and the mutation is gone forever. `wrapTransactionStrict`
 * rejects on `onerror` / `onabort` so the caller can surface the
 * failure (e.g. "offline save failed — please connect and retry").
 *
 * Read-through cache writes should keep using the lenient
 * `wrapTransaction` because a dropped cache write is recoverable via
 * the next network fetch — only correctness-critical writes need this.
 */
export function wrapTransactionStrict(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => {
      reject(tx.error ?? new Error('IndexedDB transaction failed'));
    };
    tx.onabort = () => {
      reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    };
  });
}

// ---------- Jobs list (dashboard) ----------

export async function getCachedJobs(userId: string): Promise<Job[] | null> {
  if (!isSupported()) return null;
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_JOBS_LIST, 'readonly');
    const store = tx.objectStore(STORE_JOBS_LIST);
    const record = (await wrapRequest(store.get(userId))) as CachedJobsList | null;
    return record?.jobs ?? null;
  } catch (err) {
    console.warn('[job-cache] getCachedJobs failed', err);
    return null;
  }
}

export async function putCachedJobs(userId: string, jobs: Job[]): Promise<void> {
  if (!isSupported()) return;
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_JOBS_LIST, 'readwrite');
    const store = tx.objectStore(STORE_JOBS_LIST);
    const record: CachedJobsList = { userId, jobs, cachedAt: Date.now() };
    store.put(record);
    await wrapTransaction(tx);
  } catch (err) {
    console.warn('[job-cache] putCachedJobs failed', err);
  }
}

// ---------- Job detail (single job) ----------

function detailKey(userId: string, jobId: string): string {
  return `${userId}:${jobId}`;
}

export async function getCachedJob(userId: string, jobId: string): Promise<JobDetail | null> {
  if (!isSupported()) return null;
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_JOB_DETAIL, 'readonly');
    const store = tx.objectStore(STORE_JOB_DETAIL);
    const record = (await wrapRequest(
      store.get(detailKey(userId, jobId))
    )) as CachedJobDetail | null;
    return record?.detail ?? null;
  } catch (err) {
    console.warn('[job-cache] getCachedJob failed', err);
    return null;
  }
}

export async function putCachedJob(
  userId: string,
  jobId: string,
  detail: JobDetail
): Promise<void> {
  if (!isSupported()) return;
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_JOB_DETAIL, 'readwrite');
    const store = tx.objectStore(STORE_JOB_DETAIL);
    const record: CachedJobDetail = {
      key: detailKey(userId, jobId),
      userId,
      jobId,
      detail,
      cachedAt: Date.now(),
    };
    store.put(record);
    await wrapTransaction(tx);
  } catch (err) {
    console.warn('[job-cache] putCachedJob failed', err);
  }
}

// ---------- Queued-outbox overlay (Wave 5 D7) ----------

/**
 * Read the cached `JobDetail` with every non-poisoned outbox mutation
 * for the same `(userId, jobId)` overlaid on top, FIFO.
 *
 * Why this exists (D7):
 *   Without the overlay, a reload-after-offline-edit flashes the pre-
 *   edit server doc until the replay worker drains the queue. Pre-D7
 *   the queued-offline path DID write-through the cache (Wave 1
 *   P0-13), but the cache row is authoritative-last-server-write, so
 *   a subsequent network success on a DIFFERENT field from another
 *   client would blow the optimistic patch away — the cached doc
 *   goes back to pre-edit even while the mutation still sits in the
 *   outbox. This helper makes the outbox authoritative over any
 *   `(userId, jobId)` field it touches until the row drains.
 *
 * Conflict resolution (documented per D7 non-negotiable):
 *   When the server wrote field X (flowed into the cached doc) and
 *   the client has a queued patch touching field Y AND field X, the
 *   overlay applies the queued patch last — so for every field the
 *   user touched, their pending write wins over the server's later
 *   write, and every untouched field shows the server's latest.
 *   This matches the iOS `APIClient.saveJob` + Sonnet
 *   `session_resume` last-writer-wins-per-field contract: the
 *   inspector's local intent wins until the server confirms, at
 *   which point the outbox row is removed and the cache write-through
 *   in `outbox-replay.ts` promotes the field into the shared state.
 *
 *   If two queued mutations both touch field Y, FIFO order (earliest
 *   enqueue first, then later ones overwrite) matches the replay
 *   worker's order-preservation contract — the overlay and the
 *   eventual replay stay in lockstep.
 *
 *   If a queued row targets a cached doc that does NOT exist (no
 *   server snapshot ever reached the device), we return null — the
 *   calling page's network fetch will populate eventually; we don't
 *   invent defaults for required JobDetail fields.
 *
 * Why NOT fold into `getCachedJob`:
 *   - The replay worker in `outbox-replay.ts` needs the RAW cached
 *     server snapshot to write-through — overlaying an already-queued
 *     row onto the cache on success would double-apply the patch.
 *   - This helper imports the outbox, which would create a cycle
 *     (outbox.ts already imports from job-cache.ts for `openDB` /
 *     `wrapTransaction` helpers). Put the overlay in a sibling
 *     file to break the cycle explicitly.
 *
 * Performance: one extra IDB `getAll()` on the outbox per read. The
 * outbox is expected to stay tiny; the read is sub-millisecond in
 * normal use.
 */
export async function getCachedJobWithOverlay(
  userId: string,
  jobId: string
): Promise<JobDetail | null> {
  const base = await getCachedJob(userId, jobId);
  if (!base) return null;

  // Dynamic import to break the outbox → job-cache module cycle. The
  // outbox module already imports helpers from here; a static import
  // the other way would create a load-order hazard that existing
  // webpack bundlers would resolve non-deterministically. Defer the
  // require to call-time so both modules finish initialising before
  // either is consumed.
  //
  // We intentionally do NOT import via `@/lib/pwa/outbox` directly —
  // the named-import form also triggers the cycle at module-scope
  // because TS hoists the `import { ... } from` statement above local
  // bindings. `await import(...)` keeps the cycle lazy.
  const outbox = (await import('./outbox')) as typeof import('./outbox');
  const pending = await outbox.listPendingMutations();

  const relevant = pending
    .filter((m) => m.userId === userId && m.jobId === jobId && m.op === 'saveJob')
    .sort((a, b) => a.createdAt - b.createdAt);

  if (relevant.length === 0) return base;

  // FIFO overlay: shallow spread is sufficient because the outbox
  // patches are flat `Partial<JobDetail>` patches (individual field
  // flips from the debounced save path), and the JobDetail section
  // objects — `installation`, `extent`, `supply`, etc. — are fully
  // replaced by saveJob callers, not partially merged. If a future
  // phase starts sending deep-partial section edits, this is the one
  // place to upgrade to a deep merge; today the simpler contract
  // matches iOS exactly.
  let merged: JobDetail = base;
  for (const m of relevant) {
    merged = { ...merged, ...(m.patch as Partial<JobDetail>) };
  }
  return merged;
}

// ---------- Eviction ----------

/**
 * Wipe every cached record in every store. Called from `clearAuth()` on
 * sign-out so a shared device doesn't keep one inspector's jobs in IDB
 * for the next inspector to render offline.
 *
 * Phase 7c: this also nukes the `outbox` store. The handoff flagged two
 * options — purge only the signing-out user's outbox rows, or wipe the
 * whole outbox on every sign-out. We take the latter for symmetry with
 * the read cache and because it's strictly safer: a pending offline
 * mutation replayed under the wrong user's credentials (e.g. after a
 * sign-out/sign-in swap on a shared tablet) would corrupt data far worse
 * than losing a pending edit. Documented trade-off in
 * PHASE_7C_HANDOFF.md §"Shared-device safety".
 *
 * We don't `deleteDatabase` — that would force a full schema upgrade
 * dance on the next access and could block if another tab is open. A
 * `.clear()` per store is faster and safe under concurrent tabs.
 */
export async function clearJobCache(): Promise<void> {
  if (!isSupported()) return;
  try {
    const db = await openDB();
    const tx = db.transaction([STORE_JOBS_LIST, STORE_JOB_DETAIL, STORE_OUTBOX], 'readwrite');
    tx.objectStore(STORE_JOBS_LIST).clear();
    tx.objectStore(STORE_JOB_DETAIL).clear();
    tx.objectStore(STORE_OUTBOX).clear();
    await wrapTransaction(tx);
  } catch (err) {
    console.warn('[job-cache] clearJobCache failed', err);
  }
}
