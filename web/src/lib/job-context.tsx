'use client';

import * as React from 'react';
import type { CertificateType, JobDetail } from './types';

/**
 * Per-job state container. Holds the fetched JobDetail plus a couple of
 * derived flags (dirty/syncing) and two mutators:
 *
 *  - updateJob(partial) — local merge, does not hit the network. Every
 *    input in the job tabs calls this; a debounced save effect (Phase 4)
 *    flushes to the backend.
 *  - setJob(full)        — replace wholesale (used after a network save
 *    round-trip so server-derived fields like updated_at can flow in).
 *
 * The shape deliberately mirrors the legacy `useJob` hook so the tab
 * components from Phase 3+ read the same API.
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
}

const JobContext = React.createContext<JobContextValue | null>(null);

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
  const [isSaving] = React.useState(false); // wired up in Phase 4

  // Keep local state in sync ONLY when the parent hands us a genuinely
  // new job (different id) — otherwise every parent re-render clobbers
  // the user's in-flight edits and resets `isDirty`. The dashboard's
  // cache-then-hydrate pass re-provides `initial` with a fresh object
  // identity even when nothing meaningful changed, so comparing by
  // reference here is wrong; key on the stable `id`.
  const lastInitialIdRef = React.useRef(initial.id);
  React.useEffect(() => {
    if (lastInitialIdRef.current !== initial.id) {
      lastInitialIdRef.current = initial.id;
      setJob(initial);
      setIsDirty(false);
    }
  }, [initial]);

  const updateJob = React.useCallback((patch: JobPatch) => {
    setJob((prev) => {
      const resolved = typeof patch === 'function' ? patch(prev) : patch;
      return { ...prev, ...resolved };
    });
    setIsDirty(true);
  }, []);

  const value = React.useMemo<JobContextValue>(
    () => ({
      job,
      certificateType: job.certificate_type ?? 'EICR',
      updateJob,
      setJob,
      isDirty,
      isSaving,
    }),
    [job, updateJob, isDirty, isSaving]
  );

  return <JobContext.Provider value={value}>{children}</JobContext.Provider>;
}
