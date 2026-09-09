'use client';

import * as React from 'react';
import type { CertificateType, JobDetail } from './types';
import { ApiError } from './types';
import { getUser } from './auth';
import { queueSaveJob } from './pwa/queue-save-job';
import { listPendingMutationsStrict } from './pwa/outbox';
import { withJobSaveLock } from './pwa/job-save-lock';
import { flushDesignationDrafts } from './designation-drafts';
import { repairJobCircuitDesignations } from './repair-job-designations';
// PLAN-E-TERM — the post-session unresolved-audio record rows for THIS
// job (visibility is decided beneath RecordingProvider, where the active
// session is in scope — this provider wraps it and cannot see that).
import {
  clearUnresolvedAudioForCertificate,
  listUnresolvedAudioForJob,
  resolveUnresolvedAudio,
  subscribeUnresolvedAudioChanges,
} from './recording/unresolved-audio-store';
import type { UnresolvedAudioRecord } from './recording/unresolved-audio-record';

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

/** A02D — who produced a job mutation. `manual` = the inspector's own
 *  typed/tapped edit through `updateJob`/`commitJobPatch` (a designation
 *  draft commit included); `recording` = the recording pipeline's own writes
 *  (`updateJobFromRecording`); listeners ignore the latter. */
export type JobMutationSource = 'manual' | 'recording';

export interface JobMutationEvent {
  readonly prev: JobDetail;
  readonly next: JobDetail;
  readonly source: JobMutationSource;
}

interface JobContextValue {
  job: JobDetail;
  certificateType: CertificateType;
  updateJob: (patch: JobPatch) => void;
  /** A02D — the recording pipeline's own write path. Identical merge to
   *  `updateJob` but tagged `recording`, so the manual-edit observer never
   *  mistakes a regex/Sonnet/local-command write for an inspector tap. */
  updateJobFromRecording: (patch: JobPatch) => void;
  /**
   * A02D — observe every job mutation SYNCHRONOUSLY at the tap, with the
   * exact pre/post snapshots and its source. The recording provider samples
   * its manual clear/replacement cutoffs inside this callback (the
   * dispatched-stream position and the admitted-buffer head at the tap),
   * which is only sound because the notification runs on the same tick as
   * the mutation, before any await.
   */
  subscribeJobMutations: (listener: (event: JobMutationEvent) => void) => () => void;
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
  /**
   * PLAN-E-TERM — every unresolved-audio row (tombstones included) for
   * the signed-in user + this job, loaded client-side after mount
   * (hydration-safe: the server render has no IDB) and refreshed on
   * every store change. Visibility (unresolved AND session-inactive) is
   * decided by the banner beneath RecordingProvider.
   */
  unresolvedAudio: UnresolvedAudioRecord[];
  /** Banner action: writes `resolved_via: dismissed` (a tombstone). */
  dismissUnresolvedAudio: (key: string) => Promise<void>;
  /**
   * PDF-success path: terminalize `certificate_cleared` ONLY rows whose
   * recording session is NOT in `activeSessionIds` at the success
   * instant; a still-accruing session's rows survive. Resolves to the
   * number of rows terminalized.
   */
  clearUnresolvedAudioForCertificate: (activeSessionIds: ReadonlySet<string>) => Promise<number>;
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
  // Stable-ref mirror for identity-stable callbacks (the PDF gate).
  const isHydratedRef = React.useRef(isHydrated);
  isHydratedRef.current = isHydrated;

  // PLAN-E-TERM — unresolved-audio rows for this user+job. Loaded in an
  // effect (client only — never during SSR/hydration) and refreshed on
  // every same-tab / cross-tab store change. The effect depends on the
  // job ID only, not the job doc, so debounced edits don't re-query IDB.
  const jobId = job.id;
  const [unresolvedAudio, setUnresolvedAudio] = React.useState<UnresolvedAudioRecord[]>([]);
  React.useEffect(() => {
    const userId = getUser()?.id ?? null;
    if (!userId || !jobId) {
      setUnresolvedAudio([]);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      void listUnresolvedAudioForJob(userId, jobId).then((rows) => {
        if (!cancelled) setUnresolvedAudio(rows);
      });
    };
    // Store notifications are already batched; a short trailing debounce
    // keeps a burst of them to one IDB read + one render.
    const refreshSoon = () => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        refresh();
      }, 100);
    };
    refresh();
    const unsubscribe = subscribeUnresolvedAudioChanges(refreshSoon);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      unsubscribe();
    };
  }, [jobId]);

  const dismissUnresolvedAudio = React.useCallback(async (key: string) => {
    await resolveUnresolvedAudio(key, 'dismissed');
  }, []);

  const clearUnresolvedAudioForCertificateCb = React.useCallback(
    async (activeSessionIds: ReadonlySet<string>) => {
      const userId = getUser()?.id ?? null;
      if (!userId || !jobId) return 0;
      return clearUnresolvedAudioForCertificate(userId, jobId, activeSessionIds);
    },
    [jobId]
  );
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
  // PLAN-B2 Codex r1 — ALL queueSaveJob writes for this job serialise
  // through one promise chain: an older in-flight save finishing AFTER
  // a newer full-snapshot save could otherwise overwrite it server-side
  // (the PDF gate's save must be the LAST write before generatePdf).
  const saveChainRef = React.useRef<Promise<unknown>>(Promise.resolve());
  const enqueueSerialisedSave = React.useCallback(<T,>(op: () => Promise<T>): Promise<T> => {
    const next = saveChainRef.current.then(op, op);
    // The chain never rejects (each link's outcome is consumed by its
    // caller); keep the tail alive regardless of individual failures.
    saveChainRef.current = next.catch(() => undefined);
    return next;
  }, []);

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
    setIsSaving(true);
    setSaveError(null);
    try {
      // Cycle-5 — the DRAIN itself now happens INSIDE the serialised op.
      // Draining before queuing let a NEWER flush drain patch B while op
      // A was still in flight; A's pre-durability restore then
      // resurrected A's OLDER values into the pending ref, and the
      // re-armed save wrote them after B — reverting the newer edit.
      // With the drain serialised, an op's restore is provably the
      // newest un-enqueued state (nothing else can drain mid-flight).
      // Cycle-2 ordering unchanged: chain first, per-job cross-tab lock
      // inside the chained op (lock around the chain would deadlock
      // against a queued op that also wants it).
      const outcome = await enqueueSerialisedSave(
        async (): Promise<'saved' | 'empty' | 'rejected' | 'restored'> => {
          const drained = pendingPatchRef.current;
          if (Object.keys(drained).length === 0) return 'empty';
          pendingPatchRef.current = {};
          const detail = jobRef.current;
          try {
            await withJobSaveLock(user.id, detail.id, () =>
              queueSaveJob(user.id, detail.id, drained, { optimisticDetail: detail })
            );
            return 'saved';
          } catch (err) {
            // `queueSaveJob` re-throws 4xx only. Transient failures
            // (network / 5xx) stay in the outbox and the replay worker
            // owns them — no error UI because the write IS durable.
            if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
              if (mountedRef.current) setSaveError(err.message);
              return 'rejected';
            }
            // Codex r1 — a PRE-durability failure (the outbox enqueue
            // itself threw, e.g. IndexedDB unavailable) means the
            // drained patch reached NEITHER the server nor the outbox.
            // Restore it (newer pending keys win) and re-arm, else a
            // load-repair patch for this doc version would be lost
            // forever (the per-version tag blocks a re-enqueue).
            pendingPatchRef.current = { ...drained, ...pendingPatchRef.current };
            return 'restored';
          }
        }
      );
      if (!mountedRef.current) return;
      if (outcome === 'saved' || outcome === 'empty') {
        // Clear `isDirty` only if no new edits queued while we were
        // saving; if the user kept typing, the next debounce flushes.
        if (Object.keys(pendingPatchRef.current).length === 0) {
          setIsDirty(false);
        }
      } else if (outcome === 'restored') {
        setIsDirty(true);
        scheduleSaveRef.current?.();
      }
    } finally {
      if (mountedRef.current) {
        setIsSaving(false);
      }
    }
  }, [enqueueSerialisedSave]);

  const scheduleSave = React.useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void flushSave();
    }, SAVE_DEBOUNCE_MS);
  }, [flushSave]);
  // flushSave is declared before scheduleSave (it must not depend on it),
  // so the enqueue-failure retry path reaches the scheduler via a ref.
  const scheduleSaveRef = React.useRef<(() => void) | null>(null);
  scheduleSaveRef.current = scheduleSave;

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

  // A02D — synchronous mutation observers (see `subscribeJobMutations`).
  const mutationListenersRef = React.useRef<Set<(event: JobMutationEvent) => void>>(new Set());
  const subscribeJobMutations = React.useCallback(
    (listener: (event: JobMutationEvent) => void): (() => void) => {
      mutationListenersRef.current.add(listener);
      return () => {
        mutationListenersRef.current.delete(listener);
      };
    },
    []
  );
  const notifyMutation = React.useCallback(
    (prev: JobDetail, next: JobDetail, source: JobMutationSource) => {
      if (prev === next) return;
      for (const listener of mutationListenersRef.current) {
        try {
          listener({ prev, next, source });
        } catch (err) {
          console.warn('[job-context] mutation listener threw', err);
        }
      }
    },
    []
  );

  const applyPatch = React.useCallback(
    (patch: JobPatch, source: JobMutationSource): JobDetail => {
      const prev = jobRef.current;
      const resolved = typeof patch === 'function' ? patch(prev) : patch;
      const merged = { ...prev, ...resolved } as JobDetail;
      jobRef.current = merged;
      pendingPatchRef.current = { ...pendingPatchRef.current, ...resolved };
      setJob(merged);
      setIsDirty(true);
      scheduleSave();
      notifyMutation(prev, merged, source);
      return merged;
    },
    [scheduleSave, notifyMutation]
  );

  const updateJobFromRecording = React.useCallback(
    (patch: JobPatch) => {
      applyPatch(patch, 'recording');
    },
    [applyPatch]
  );

  const updateJob = React.useCallback(
    (patch: JobPatch) => {
      // PLAN-B2 Codex r1 — SAME synchronous primitive as commitJobPatch.
      // The old form resolved the patch inside a deferred React state
      // updater while commitJobPatch mutated the refs synchronously; a
      // same-tick updateJob(A) → commitJobPatch(B) sequence could then
      // evaluate A late and clobber it with B's object replacement,
      // leaving state/jobRef without A even though the queued save had
      // A+B. Resolving against jobRef.current here keeps state, jobRef,
      // and the pending patch in lock-step for every interleaving.
      applyPatch(patch, 'manual');
    },
    [applyPatch]
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
      return applyPatch(patch, 'manual');
    },
    [applyPatch]
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
    // Codex r1 — HYDRATION GATE: if the doc in state is (or descends
    // from) a cache paint whose network outcome never resolved in our
    // favour, PUTting its full circuits array could overwrite a NEWER
    // server schedule and then "prove" the stale doc synced. The gate
    // reads the provider-owned accepted-hydration STATE via a ref (this
    // callback is identity-stable across renders).
    if (!isHydratedRef.current) return { synced: false };
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    if (mountedRef.current) {
      setIsSaving(true);
      setSaveError(null);
    }
    try {
      // Cycle-2 — the SAVE and the drained-proof run inside ONE lock
      // hold (r1 locked only the proof: an older replay holding the
      // lock could land after a concurrent unlocked fresh save, remove
      // its row, and the later locked proof would see a drained outbox
      // over a reverted schedule). Chain first, lock inside the chained
      // op — same non-reentrant ordering as flushSave.
      // Cycle-5 — the DRAIN moves inside the op too (see flushSave):
      // draining before queuing let a failed older save restore its
      // stale patch over one a newer save had already drained.
      const result = await enqueueSerialisedSave(
        async (): Promise<{ synced: boolean; failed: boolean }> => {
          const pending = pendingPatchRef.current;
          pendingPatchRef.current = {};
          const detail = jobRef.current;
          const patch: Partial<JobDetail> = { ...pending, circuits: detail.circuits };
          try {
            const gate = await withJobSaveLock(user.id, detail.id, async () => {
              const saved = await queueSaveJob(user.id, detail.id, patch, {
                optimisticDetail: detail,
              });
              if (!saved.synced) return { synced: false as const };
              const rows = await listPendingMutationsStrict();
              // A POISONED row will never replay, so it cannot overwrite
              // the fresh save — only live pending rows block the gate.
              const drained = rows.every((m) => m.jobId !== detail.id || m.poisoned === true);
              return { synced: drained };
            });
            return { synced: gate.synced, failed: false };
          } catch (err) {
            // 4xx — a validation rejection will never sync; surface it
            // and report un-synced so the caller fails visibly.
            if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
              if (mountedRef.current) setSaveError(err.message);
              return { synced: false, failed: true };
            }
            // Mini-review c1 — same pre-durability restore as flushSave:
            // the outbox enqueue itself threw, so the drained patch
            // reached NEITHER the server nor the outbox. Restore (newer
            // keys win) and re-arm, else a draft/load-repair patch dies
            // with a failed PDF attempt.
            pendingPatchRef.current = { ...pending, ...pendingPatchRef.current };
            if (mountedRef.current) {
              setIsDirty(true);
              scheduleSaveRef.current?.();
            }
            return { synced: false, failed: true };
          }
        }
      );
      if (
        !result.failed &&
        mountedRef.current &&
        Object.keys(pendingPatchRef.current).length === 0
      ) {
        setIsDirty(false);
      }
      return { synced: result.synced };
    } finally {
      if (mountedRef.current) setIsSaving(false);
    }
  }, [enqueueSerialisedSave]);

  const value = React.useMemo<JobContextValue>(
    () => ({
      job,
      certificateType: job.certificate_type ?? 'EICR',
      updateJob,
      updateJobFromRecording,
      subscribeJobMutations,
      setJob,
      isDirty,
      isSaving,
      saveError,
      isHydrated,
      commitJobPatch,
      flushDraftsAndGetSnapshot,
      saveCircuitsSnapshotNow,
      unresolvedAudio,
      dismissUnresolvedAudio,
      clearUnresolvedAudioForCertificate: clearUnresolvedAudioForCertificateCb,
    }),
    [
      job,
      updateJob,
      updateJobFromRecording,
      subscribeJobMutations,
      isDirty,
      isSaving,
      saveError,
      isHydrated,
      unresolvedAudio,
      dismissUnresolvedAudio,
      clearUnresolvedAudioForCertificateCb,
      commitJobPatch,
      flushDraftsAndGetSnapshot,
      saveCircuitsSnapshotNow,
    ]
  );

  return <JobContext.Provider value={value}>{children}</JobContext.Provider>;
}
