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
export const DB_VERSION = 2;
const STORE_JOBS_LIST = 'jobs-list';
const STORE_JOB_DETAIL = 'job-detail';
export const STORE_OUTBOX = 'outbox';
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
