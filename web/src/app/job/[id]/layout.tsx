'use client';

import * as React from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AppShell } from '@/components/layout/app-shell';
import { JobHeader } from '@/components/job/job-header';
import { JobTabNav } from '@/components/job/job-tab-nav';
import { FloatingActionBar } from '@/components/job/floating-action-bar';
import { RecordingOverlay } from '@/components/recording/recording-overlay';
import { TranscriptBar } from '@/components/recording/transcript-bar';
import { LiveFillView } from '@/components/live-fill/live-fill-view';
import { JobProvider } from '@/lib/job-context';
import { RecordingProvider, useRecording } from '@/lib/recording-context';
import { api } from '@/lib/api-client';
import { clearAuth, getUser } from '@/lib/auth';
import type { JobDetail } from '@/lib/types';

/**
 * Shell for every /job/[id]/... route.
 *
 * Layout matches iOS JobDetailView:
 *   ┌─── JobHeader (Back • Title • ⋯) ───┐
 *   │                                    │
 *   ├─── JobTabNav (horizontal strip)────┤
 *   │                                    │
 *   │                                    │
 *   │          children (tab)            │
 *   │                                    │
 *   └─── FloatingActionBar (fixed) ──────┘
 *
 * Fetches the job once on mount and holds it in JobProvider. Debounced
 * auto-save + recording overlay arrive in Phase 4 (floating bar is the
 * visual placeholder for those wires today).
 */
export default function JobLayout({ children }: { children: React.ReactNode }) {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const jobId = params.id;

  const [job, setJob] = React.useState<JobDetail | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const user = getUser();
    if (!user) {
      router.replace('/login');
      return;
    }
    let cancelled = false;
    api
      .job(user.id, jobId)
      .then((detail) => {
        if (!cancelled) setJob(detail);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        if (/401/.test(err.message)) {
          clearAuth();
          router.replace('/login');
          return;
        }
        setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [jobId, router]);

  return (
    <AppShell>
      {job === null ? (
        <JobShellLoading error={error} />
      ) : (
        <JobProvider initial={job}>
          <RecordingProvider>
            <div className="flex min-h-[calc(100dvh-56px)] flex-col">
              <JobHeader />
              <JobTabNav jobId={jobId} certificateType={job.certificate_type ?? 'EICR'} />
              <TranscriptBar />
              <JobBody>{children}</JobBody>
              <FloatingActionBar />
              <RecordingOverlay />
            </div>
          </RecordingProvider>
        </JobProvider>
      )}
    </AppShell>
  );
}

/**
 * While recording (active/dozing/sleeping), swap the active tab content
 * for <LiveFillView> so the inspector sees every extracted field update
 * in real time. Option A in the Phase 5d handoff — matches iOS exactly,
 * no z-index juggling, and the FloatingActionBar / TranscriptBar /
 * RecordingOverlay stay mounted at their usual positions.
 *
 * Lives inside <RecordingProvider> so the hook call is safe; has to be
 * its own component because useRecording can't be called from the
 * server-rendered layout boundary.
 */
function JobBody({ children }: { children: React.ReactNode }) {
  const { state } = useRecording();
  const showLiveFill = state === 'active' || state === 'dozing' || state === 'sleeping';
  return (
    <div className="flex-1 overflow-y-auto pb-28">{showLiveFill ? <LiveFillView /> : children}</div>
  );
}

function JobShellLoading({ error }: { error: string | null }) {
  if (error) {
    return (
      <div className="flex min-h-[calc(100dvh-56px)] items-center justify-center px-4">
        <div
          role="alert"
          className="rounded-[var(--radius-lg)] border border-[var(--color-status-failed)]/40 bg-[var(--color-status-failed)]/10 px-4 py-3 text-sm text-[var(--color-status-failed)]"
          style={{ maxWidth: '420px' }}
        >
          Couldn’t load job: {error}
        </div>
      </div>
    );
  }
  return (
    <div className="flex min-h-[calc(100dvh-56px)] flex-col gap-4 p-4 md:p-6">
      <div className="cm-shimmer h-12 w-3/4 rounded-[var(--radius-md)] bg-[var(--color-surface-2)]" />
      <div className="cm-shimmer h-14 w-full rounded-[var(--radius-md)] bg-[var(--color-surface-2)]" />
      <div className="cm-shimmer h-32 w-full rounded-[var(--radius-lg)] bg-[var(--color-surface-2)]" />
      <div className="cm-shimmer h-64 w-full rounded-[var(--radius-lg)] bg-[var(--color-surface-2)]" />
    </div>
  );
}
