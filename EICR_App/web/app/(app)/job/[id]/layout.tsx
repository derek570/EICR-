'use client';

import { createContext, useContext, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

import { JobHeader } from '@/components/job/job-header';
import { JobTabNav } from '@/components/job/job-tab-nav';
import { useJob } from '@/hooks/use-job';
import { useKeyboardShortcuts } from '@/hooks/use-keyboard-shortcuts';
import type { JobDetail, User } from '@/lib/types';

interface JobContextType {
  job: JobDetail;
  updateJob: (updates: Partial<JobDetail>) => void;
  user: User | null;
  certificateType: 'EICR' | 'EIC';
}

const JobContext = createContext<JobContextType | null>(null);

export function useJobContext() {
  const ctx = useContext(JobContext);
  if (!ctx) throw new Error('useJobContext must be used inside job layout');
  return ctx;
}

export default function JobLayout({ children }: { children: React.ReactNode }) {
  const params = useParams();
  const router = useRouter();
  const jobId = params.id as string;

  const { job, user, loading, isDirty, isSyncing, updateJob, save, certificateType } =
    useJob(jobId);

  // Keyboard shortcuts: Ctrl+S to save, Ctrl+P for PDF, Ctrl+R for recording (circuits page)
  useKeyboardShortcuts({
    'ctrl+s': save,
    'ctrl+p': () => router.push(`/job/${jobId}/pdf`),
    'ctrl+r': () => router.push(`/job/${jobId}/record`),
  });

  // Warn on unload if dirty
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (isDirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  if (loading || !job) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <JobContext.Provider value={{ job, updateJob, user, certificateType }}>
      <div className="flex flex-col h-full">
        <JobHeader
          address={job.address}
          createdAt={job.created_at}
          isDirty={isDirty}
          isSyncing={isSyncing}
          onSave={save}
        />
        <div className="flex flex-1 min-h-0">
          <JobTabNav jobId={jobId} certificateType={certificateType} />
          <div className="flex-1 overflow-auto">{children}</div>
        </div>
      </div>
    </JobContext.Provider>
  );
}
