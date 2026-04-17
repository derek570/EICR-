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
interface JobContextValue {
  job: JobDetail;
  certificateType: CertificateType;
  updateJob: (patch: Partial<JobDetail>) => void;
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

  // Keep local state in sync when parent fetches a fresh copy.
  React.useEffect(() => {
    setJob(initial);
    setIsDirty(false);
  }, [initial]);

  const updateJob = React.useCallback((patch: Partial<JobDetail>) => {
    setJob((prev) => ({ ...prev, ...patch }));
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
