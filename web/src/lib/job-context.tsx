'use client';

import * as React from 'react';
import type { CertificateType, JobDetail } from './types';
import { ApiError } from './types';
import { getUser } from './auth';
import { queueSaveJob } from './pwa/queue-save-job';
import { flushDesignationDrafts } from './designation-drafts';
import { repairJobCircuitDesignations } from './repair-job-designations';

/**
 * Per-job state container. Holds the fetched JobDetail plus a couple of
 * derived flags (dirty/syncing) and two mutators:
 *
 *  - updateJob(partial) — local merge + queue to the offline outbox /
 *    network via a debounced `flushSave`. Every input in the job tabs
 *    calls this; the debounce buffers rapid typing into a single PATCH.
 *  - setJob(full)        — replace wholesale (used after a network save
 *    round-trip so server-derived fields like updated_at can flow in).
 *
 * The shape deliberately mirrors the legacy `useJob` hook so the tab
 * components from Phase 3+ read the same API.
 *
 * Persistence pipeline (pre-deploy fix):
 *   1. `updateJob(patch)` merges into local state, unions the patch keys
 *      into `pendingPatchRef`, and flips `isDirty: true`.
 *   2. A 800ms debounce timer (`scheduleSave`) fires `flushSave`.
 *   3. `flushSave` drains `pendingPatchRef` and hands the batched patch to
 *      `queueSaveJob` — which writes to the IDB outbox first (durability),
 *      then fires the network PUT. The outbox replay worker owns retries
 *      on network failure; the caller only sees 4xx (validation error).
 *   4. On success with no new patch queued since the flush, `isDirty`
 *      clears. If the user kept typing during the flight, `isDirty` stays
 *      true and a fresh debounce re-arms from the next keystroke.
 *   5. On unmount, a cleanup effect flushes synchronously so in-flight
 *      edits aren't lost on navigation between tabs.
 *
 * 4xx errors surface via `saveError` for the caller (e.g. `JobHeader`'s
 * save-status pill) to display. Transient (network / 5xx) failures are
 * swallowed here because the replay worker will retry — surfacing every
 * transient blip as an error would be noisy and misleading (the write
 * IS durable, just not synced yet).
 */
/**
 * Accept either a plain partial (legacy ergonomics) OR a functional
 * updater that derives the patch from the freshest `prev` snapshot.
 *
 * Async handlers MUST use the functional form — a captured `job`
 * snapshot from the outer scope is almost always stale by the time
 * the promise resolves (CCU/doc-extract/observation races all trace
 * back to this). The plain-partial form is retained for simple
 * synchronous input onChange handlers.
 */
type JobPatch = Partial<JobDetail> | ((prev: JobDetail) => Partial<JobDetail>);

interface JobContextValue {
  job: JobDetail;
  certificateType: CertificateType;
  updateJob: (patch: JobPatch) => void;
  setJob: (next: JobDetail) => void;
  isDirty: boolean;
  isSaving: boolean;
  /** Non-null when the last save returned a 4xx (validation error). */
  saveError: string | null;
  /**
   * True once the doc held in state is (or descends from) a successful
   * network fetch — NOT a cache paint. Mount-time auto-seeders MUST gate
   * on this: seeding a cached/blank doc and letting the debounced save
   * PUT it wipes the job's sections server-side (the 2026-07-02 WS5
   * data-loss incident — see `web/audit/INDEX-2026-07.md`). Mirrors iOS,
   * which seeds only after `load()` succeeds.
   */
  isHydrated: boolean;
  /**
   * PLAN-B2 atomic-commit contract (a): synchronously commit a patch
   * into the authoritative job ref AND the pending save patch, and
   * return the EXACT merged JobDetail snapshot. Unlike `updateJob`
   * (whose ref bookkeeping runs inside a React state updater, i.e. not
   * until the next render pass), the returned snapshot is safe for an
   * IMMEDIATE consumer — a job-state sync push or a PDF render — with
   * no stale render-tick window. Designation draft commits use this.
   */
  commitJobPatch: (patch: JobPatch) => JobDetail;
  /**
   * PLAN-B2 atomic-commit contract (b): flush all registered
   * designation drafts synchronously and return the resulting
   * authoritative snapshot. Callers that need "commit everything, then
   * consume the exact committed state" (PDF preflight, preset
   * processing, job-state sync) use this instead of racing the
   * debounced save.
   */
  flushDraftsAndGetSnapshot: () => JobDetail;
  /**
   * PLAN-B2 (B2-4) server-fallback PDF gate: UNCONDITIONALLY enqueue
   * and await a save of the current FULL circuits snapshot (draining
   * any pending patch alongside), surfacing `queueSaveJob`'s `synced`
   * outcome. An earlier repair may already have drained into the outbox
   * with synced=false and an empty pendingPatchRef — so a no-op flush
   * proves nothing about S3; only THIS call returning `synced: true`
   * may unlock server-side PDF generation. `synced: false` covers
   * offline (outbox-only), signed-out, and 4xx rejection alike — the
   * caller must fall back to the client renderer or fail visibly.
   */
  saveCircuitsSnapshotNow: () => Promise<{ synced: boolean }>;
}

const JobContext = React.createContext<JobContextValue | null>(null);

/**
 * Debounce window. 800ms is the sweet spot we settled on during Phase 4
 * prototyping: short enough that pausing between fields feels like "it's
 * saving", long enough that full-address typing doesn't fire a PATCH per
 * keystroke. Kept as a module constant so tests can import and override
 * if needed.
 */
const SAVE_DEBOUNCE_MS = 800;

export function useJobContext(): JobContextValue {
  const ctx = React.useContext(JobContext);
  if (!ctx) {
    throw new Error('useJobContext must be used inside a <JobProvider>');
  }
  return ctx;
}

export function JobProvider({
  initial,
  hydrated = true,
  networkRejected = false,
  children,
}: {
  initial: JobDetail;
  /**
   * Whether the CURRENT `initial` prop came from a successful network
   * fetch (vs an IDB cache paint). The job layout passes this; it flips
   * false → true when `api.job()` resolves. Defaults to true so callers
   * that don't do cache-then-hydrate (tests, future embeds) keep the
   * pre-guard behaviour.
   */
  hydrated?: boolean;
  /**
   * PLAN-B2 (B2-4): true once the layout's network fetch has FAILED
   * (non-auth) while a cached doc painted — i.e. we are CONFIRMED
   * offline and the cache is the authoritative doc for this session.
   * Only then may a load-boundary designation repair of a cache doc be
   * persisted (through the ordinary outbox path). While the network
   * outcome is still unknown, a cache repair stays display-only —
   * queueing it would recreate the cache-before-hydration overwrite
   * class the `isHydrated` gate exists to prevent (fix 851ba63e).
   */
  networkRejected?: boolean;
  children: React.ReactNode;
}) {
  // PLAN-B2 (B2-4): the doc enters state load-REPAIRED (display/PDF
  // safe) — but a mount-time repair NEVER creates a pending patch or
  // scheduled save; persistence decisions live in the re-sync effect
  // below where the doc's provenance (network / confirmed-offline
  // cache) is known.
  const [job, setJob] = React.useState<JobDetail>(() => repairJobCircuitDesignations(initial).job);
  const [isDirty, setIsDirty] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  // `isHydrated` is provider STATE, not the raw prop: it must only flip
  // true once the hydrated doc has actually been accepted into `job`
  // (the re-sync effect below). Exposing the prop directly would race —
  // child effects (the tab-page auto-seeders) run BEFORE this provider's
  // effects on the same commit, so they'd see hydrated=true while `job`
  // still holds the cached blank doc, seed against it, and the resulting
  // pending patch would then block the fresh doc from ever landing.
  const [isHydrated, setIsHydrated] = React.useState(hydrated);

  // Keep a ref of the freshest job so `flushSave` (fired from a timer)
  // reads the post-patch doc even when the closure was captured with a
  // stale snapshot. Mirrors the "functional updater" pattern in
  // `updateJob` — both are guarding against the same stale-closure trap.
  const jobRef = React.useRef<JobDetail>(initial);
  jobRef.current = job;

  // Union of all patch keys since the last successful save. We store the
  // full patch value here (not just the keys) so the outbox call has the
  // exact field set to PATCH; otherwise we'd need to diff against the
  // pre-edit server doc, which we don't carry.
  const pendingPatchRef = React.useRef<Partial<JobDetail>>({});
  const saveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guard against running a flush after unmount (would leave the
  // `isSaving` spinner spinning in a dead component — React warns in
  // strict mode).
  const mountedRef = React.useRef(true);

  // Re-sync local state when the parent hands us a genuinely different
  // job (by id) OR when the server has a newer `updated_at` for the
  // same id AND we have no local unsynced edits. The second clause is
  // the cache-then-hydrate fix (was: id-only gate dropped fresh network
  // payloads forever when the cache won the race).
  const flushSave = React.useCallback(async () => {
    // PLAN-B2 — commit any focused designation draft BEFORE draining the
    // pending patch, so a typing pause longer than the debounce can
    // never persist the raw pre-blur designation. Draft commits are
    // synchronous and land in both jobRef and pendingPatchRef.
    flushDesignationDrafts();
    const pending = pendingPatchRef.current;
    const keys = Object.keys(pending);
    if (keys.length === 0) return;
    const user = getUser();
    if (!user) {
      // Signed out — the middleware will bounce the next nav. Drop the
      // queued patch rather than sending an un-authed PUT.
      pendingPatchRef.current = {};
      return;
    }
    // Snapshot + clear so any keystrokes during the flight re-fill the
    // ref instead of being wiped by a racing flush.
    pendingPatchRef.current = {};
    const detail = jobRef.current;
    const jobId = detail.id;
    setIsSaving(true);
    setSaveError(null);
    try {
      await queueSaveJob(user.id, jobId, pending, { optimisticDetail: detail });
      if (!mountedRef.current) return;
      // Clear `isDirty` only if no new edits queued while we were saving.
      // If the user kept typing, keep the flag and let the next debounce
      // fire another flush for the new keys.
      if (Object.keys(pendingPatchRef.current).length === 0) {
        setIsDirty(false);
      }
    } catch (err) {
      // `queueSaveJob` re-throws 4xx only. Transient failures (network
      // / 5xx) stay in the outbox and the replay worker owns them — no
      // error UI here because the write IS durable, just not synced.
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        if (mountedRef.current) {
          setSaveError(err.message);
        }
      }
    } finally {
      if (mountedRef.current) {
        setIsSaving(false);
      }
    }
  }, []);

  const scheduleSave = React.useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void flushSave();
    }, SAVE_DEBOUNCE_MS);
  }, [flushSave]);

  const lastInitialIdRef = React.useRef(initial.id);
  const lastInitialUpdatedRef = React.useRef(initial.updated_at ?? null);
  // PLAN-B2 (B2-4): one repair-persist per accepted doc version. The
  // effect re-runs on `isDirty` flips; without this tag the fresh-cache
  // branch would re-enqueue the repaired circuits every pass.
  const repairEnqueuedForRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    const nextUpdated = initial.updated_at ?? null;
    const idChanged = lastInitialIdRef.current !== initial.id;
    const updatedChanged = lastInitialUpdatedRef.current !== nextUpdated;
    // Only replace from server if either the id changed (new route) OR
    // the server has advanced `updated_at` AND we aren't sitting on a
    // dirty local doc the user hasn't finished editing. Clobbering an
    // in-flight edit would silently lose keystrokes.
    const pendingKeys = Object.keys(pendingPatchRef.current).length;
    const safeToReplace = idChanged || (updatedChanged && !isDirty && pendingKeys === 0);
    const versionTag = `${initial.id}:${nextUpdated ?? ''}`;
    // PLAN-B2 (B2-4) — the accepted doc is load-repaired BEFORE it
    // enters state, and the repair is PERSISTED only when the doc's
    // provenance allows it (see below). Repair is pure and returns the
    // same object when nothing changed.
    const repaired = repairJobCircuitDesignations(initial);
    // A repaired snapshot may be persisted only when (a) it descends
    // from an ACCEPTED network doc (authoritative), or (b) we are
    // CONFIRMED offline and the cache is authoritative — explicitly
    // through the ordinary outbox path. A cache doc whose network
    // outcome is still UNKNOWN must never become a pending patch: the
    // dirty/pending state would make this provider reject the newer
    // network doc and later PUT the stale cached circuits (the exact
    // cache-before-hydration overwrite class of fix 851ba63e).
    const mayPersistRepair = hydrated || networkRejected;
    const enqueueRepairedCircuits = () => {
      if (!repaired.changed) return;
      if (!mayPersistRepair) return;
      if (repairEnqueuedForRef.current === versionTag) return;
      repairEnqueuedForRef.current = versionTag;
      pendingPatchRef.current = {
        ...pendingPatchRef.current,
        circuits: repaired.job.circuits,
      };
      setIsDirty(true);
      scheduleSave();
    };
    if (safeToReplace) {
      lastInitialIdRef.current = initial.id;
      lastInitialUpdatedRef.current = nextUpdated;
      setJob(repaired.job);
      setIsDirty(false);
      setSaveError(null);
      // The accepted doc's provenance travels with it: a network doc
      // marks us hydrated; a cache paint (id change while offline)
      // marks us NOT hydrated so the auto-seeders stay off.
      setIsHydrated(hydrated);
      enqueueRepairedCircuits();
    } else if (hydrated && !idChanged && !updatedChanged) {
      // Network doc landed but matches the version we already hold
      // (the cache was fresh — same id, same `updated_at`). Nothing to
      // replace, but the doc in state IS the network version, so the
      // seeders can safely run. Without this branch a fresh-cache visit
      // would never hydrate and seeding would be permanently off.
      setIsHydrated(true);
      // The mount-time repair already fixed the DISPLAY copy; the
      // server still holds the dirty designations. Now that the network
      // has confirmed this exact version, persist the repair once.
      enqueueRepairedCircuits();
    } else if (networkRejected && !idChanged && !updatedChanged) {
      // CONFIRMED offline: the cache doc in state is authoritative for
      // this session — persist its repair through the ordinary outbox
      // path (replay syncs it when connectivity returns).
      enqueueRepairedCircuits();
    }
    // NOTE: when a hydrated doc is REJECTED (dirty local edits), we
    // deliberately stay un-hydrated — state holds cache+edits, not the
    // server doc, and silently seeding on top of that mix is exactly
    // the wipe vector this flag exists to close. Safe direction: the
    // seeders simply never run for that mount.
  }, [initial, isDirty, hydrated, networkRejected, scheduleSave]);

  const updateJob = React.useCallback(
    (patch: JobPatch) => {
      setJob((prev) => {
        const resolved = typeof patch === 'function' ? patch(prev) : patch;
        // Merge into pending BEFORE applying the state update so a
        // re-entrant `updateJob` call inside the same tick (rare, but
        // observation photo uploads do batch) unions correctly.
        pendingPatchRef.current = { ...pendingPatchRef.current, ...resolved };
        return { ...prev, ...resolved };
      });
      setIsDirty(true);
      scheduleSave();
    },
    [scheduleSave]
  );

  // Flush on unmount so edits don't get stranded when the inspector
  // navigates mid-debounce. Synchronous flush (fire-and-forget) is fine
  // — the outbox write is durable, and the network follow-up runs
  // outside the React lifecycle.
  React.useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      // PLAN-B2 — a focused designation draft must survive navigation/
      // unmount. Commits mutate jobRef/pendingPatchRef directly (the
      // setJob half is a no-op post-unmount, which is fine — the model
      // consumer at this point is the persistence path, not the UI).
      flushDesignationDrafts();
      if (Object.keys(pendingPatchRef.current).length > 0) {
        void flushSave();
      }
    };
  }, [flushSave]);

  // PLAN-B2 — backgrounding boundaries: pagehide (BFCache / tab close)
  // and visibility-hidden both commit focused designation drafts and
  // push any pending patch to the durable outbox immediately. Without
  // this, pocketing the phone mid-edit strands the draft in component
  // state (blur never fires under pagehide on iOS Safari).
  React.useEffect(() => {
    const flushForBackground = () => {
      flushDesignationDrafts();
      if (Object.keys(pendingPatchRef.current).length > 0) {
        void flushSave();
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flushForBackground();
    };
    window.addEventListener('pagehide', flushForBackground);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flushForBackground);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [flushSave]);

  // PLAN-B2 atomic-commit contract (a) — see JobContextValue docs. The
  // ref mutations happen synchronously HERE (not inside a React state
  // updater), so the returned snapshot is immediately consumable and
  // the pending patch is immediately drainable by an awaitable save.
  const commitJobPatch = React.useCallback(
    (patch: JobPatch): JobDetail => {
      // The functional form resolves against jobRef (the freshest
      // committed snapshot), mirroring updateJob's stale-closure guard.
      const resolved = typeof patch === 'function' ? patch(jobRef.current) : patch;
      const merged = { ...jobRef.current, ...resolved } as JobDetail;
      jobRef.current = merged;
      pendingPatchRef.current = { ...pendingPatchRef.current, ...resolved };
      setJob(merged);
      setIsDirty(true);
      scheduleSave();
      return merged;
    },
    [scheduleSave]
  );

  // PLAN-B2 atomic-commit contract (b) — flush drafts, return the exact
  // committed snapshot.
  const flushDraftsAndGetSnapshot = React.useCallback((): JobDetail => {
    flushDesignationDrafts();
    return jobRef.current;
  }, []);

  // PLAN-B2 (B2-4) — the server-fallback PDF gate. UNCONDITIONAL full
  // circuits-snapshot save: an earlier repair may have drained into the
  // outbox with synced=false leaving pendingPatchRef empty, so a no-op
  // flush proves nothing about S3. Always enqueue a fresh save carrying
  // the CURRENT full canonical circuits array (plus any other pending
  // keys, which this drains), and surface queueSaveJob's `synced`.
  const saveCircuitsSnapshotNow = React.useCallback(async (): Promise<{ synced: boolean }> => {
    flushDesignationDrafts();
    const user = getUser();
    if (!user) return { synced: false };
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    const pending = pendingPatchRef.current;
    pendingPatchRef.current = {};
    const detail = jobRef.current;
    const patch: Partial<JobDetail> = { ...pending, circuits: detail.circuits };
    if (mountedRef.current) {
      setIsSaving(true);
      setSaveError(null);
    }
    try {
      const result = await queueSaveJob(user.id, detail.id, patch, { optimisticDetail: detail });
      if (mountedRef.current && Object.keys(pendingPatchRef.current).length === 0) {
        setIsDirty(false);
      }
      return { synced: result.synced };
    } catch (err) {
      // 4xx — a validation rejection will never sync; surface it and
      // report un-synced so the caller fails visibly / falls back.
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        if (mountedRef.current) setSaveError(err.message);
      }
      return { synced: false };
    } finally {
      if (mountedRef.current) setIsSaving(false);
    }
  }, []);

  const value = React.useMemo<JobContextValue>(
    () => ({
      job,
      certificateType: job.certificate_type ?? 'EICR',
      updateJob,
      setJob,
      isDirty,
      isSaving,
      saveError,
      isHydrated,
      commitJobPatch,
      flushDraftsAndGetSnapshot,
      saveCircuitsSnapshotNow,
    }),
    [
      job,
      updateJob,
      isDirty,
      isSaving,
      saveError,
      isHydrated,
      commitJobPatch,
      flushDraftsAndGetSnapshot,
      saveCircuitsSnapshotNow,
    ]
  );

  return <JobContext.Provider value={value}>{children}</JobContext.Provider>;
}
