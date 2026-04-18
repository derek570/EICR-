'use client';

import * as React from 'react';
import type { CertificateType, JobDetail } from './types';
import { ApiError } from './types';
import { getUser } from './auth';
import { queueSaveJob } from './pwa/queue-save-job';

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
  children,
}: {
  initial: JobDetail;
  children: React.ReactNode;
}) {
  const [job, setJob] = React.useState<JobDetail>(initial);
  const [isDirty, setIsDirty] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);

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
  const lastInitialIdRef = React.useRef(initial.id);
  const lastInitialUpdatedRef = React.useRef(initial.updated_at ?? null);
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
    if (safeToReplace) {
      lastInitialIdRef.current = initial.id;
      lastInitialUpdatedRef.current = nextUpdated;
      setJob(initial);
      setIsDirty(false);
      setSaveError(null);
    }
  }, [initial, isDirty]);

  const flushSave = React.useCallback(async () => {
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
      if (Object.keys(pendingPatchRef.current).length > 0) {
        void flushSave();
      }
    };
  }, [flushSave]);

  const value = React.useMemo<JobContextValue>(
    () => ({
      job,
      certificateType: job.certificate_type ?? 'EICR',
      updateJob,
      setJob,
      isDirty,
      isSaving,
      saveError,
    }),
    [job, updateJob, isDirty, isSaving, saveError]
  );

  return <JobContext.Provider value={value}>{children}</JobContext.Provider>;
}
