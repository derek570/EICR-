'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Save, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { JobTabs } from '@/components/job-tabs';
import { OfflineIndicator } from '@/components/offline-indicator';
import { api, JobDetail, User } from '@/lib/api';
import { useJobStore } from '@/lib/store';
import { syncCurrentJob } from '@/lib/sync';
import { toast } from 'sonner';

interface JobContextType {
  job: JobDetail;
  updateJob: (updates: Partial<JobDetail>) => void;
  user: User | null;
  certificateType: 'EICR' | 'EIC';
}

export const JobContext = createContext<JobContextType | null>(null);

export function useJob() {
  const context = useContext(JobContext);
  if (!context) {
    throw new Error('useJob must be used within JobLayout');
  }
  return context;
}

interface JobLayoutProps {
  children: React.ReactNode;
}

export default function JobLayout({ children }: JobLayoutProps) {
  const params = useParams();
  const router = useRouter();
  const jobId = params.id as string;

  const [user, setUser] = useState<User | null>(null);
  // Skip the loading spinner if the job store already has this job's data pre-seeded
  // (e.g. navigating here from the record page which syncs liveJob → currentJob).
  const [loading, setLoading] = useState(() => {
    const existing = useJobStore.getState().currentJob;
    return !existing || existing.id !== jobId;
  });

  // Use Zustand store
  const {
    currentJob,
    isDirty,
    isSyncing,
    isOnline,
    loadJob,
    updateCircuits,
    updateObservations,
    updateBoardInfo,
    updateBoards,
    updateInstallationDetails,
    updateSupplyCharacteristics,
    updateInspectionSchedule,
    setInspectorId,
    updateExtentAndType,
    updateDesignConstruction,
    clearJob,
  } = useJobStore();

  useEffect(() => {
    const storedUser = localStorage.getItem('user');
    if (!storedUser) {
      router.push('/login');
      return;
    }

    const userData = JSON.parse(storedUser) as User;
    setUser(userData);
    useJobStore.getState().setUser(userData.id);

    async function loadJobData() {
      try {
        // Try to load from API first
        if (navigator.onLine) {
          const jobData = await api.getJob(userData.id, jobId);
          await loadJob(jobId, jobData, userData.id);
        } else {
          // Offline: try to load from IndexedDB
          const { getLocalJob } = await import('@/lib/db');
          const localJob = await getLocalJob(jobId);
          if (localJob) {
            await loadJob(
              jobId,
              {
                id: localJob.id,
                address: localJob.address,
                status: localJob.status,
                created_at: localJob.created_at,
                certificate_type: localJob.certificate_type || 'EICR',
                circuits: localJob.circuits,
                observations: localJob.observations,
                board_info: localJob.board_info,
                boards: localJob.boards,
                installation_details: localJob.installation_details,
                supply_characteristics: localJob.supply_characteristics,
                inspection_schedule: localJob.inspection_schedule,
                inspector_id: localJob.inspector_id,
                extent_and_type: localJob.extent_and_type,
                design_construction: localJob.design_construction,
              },
              userData.id
            );
          } else {
            toast.error('Job not available offline');
            router.push('/dashboard');
          }
        }
      } catch (error) {
        console.error('Failed to load job:', error);

        // Try IndexedDB fallback
        const { getLocalJob } = await import('@/lib/db');
        const localJob = await getLocalJob(jobId);
        if (localJob) {
          await loadJob(
            jobId,
            {
              id: localJob.id,
              address: localJob.address,
              status: localJob.status,
              created_at: localJob.created_at,
              certificate_type: localJob.certificate_type || 'EICR',
              circuits: localJob.circuits,
              observations: localJob.observations,
              board_info: localJob.board_info,
              boards: localJob.boards,
              installation_details: localJob.installation_details,
              supply_characteristics: localJob.supply_characteristics,
              inspection_schedule: localJob.inspection_schedule,
              inspector_id: localJob.inspector_id,
              extent_and_type: localJob.extent_and_type,
              design_construction: localJob.design_construction,
            },
            userData.id
          );
          toast.info('Loaded from offline cache');
        } else {
          toast.error('Failed to load job');
          router.push('/dashboard');
        }
      } finally {
        setLoading(false);
      }
    }

    loadJobData();

    return () => {
      clearJob();
    };
  }, [jobId, router, loadJob, clearJob]);

  // Warn on browser refresh/navigation if dirty
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isDirty) {
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);

  const handleBack = () => {
    if (isDirty) {
      const confirmed = window.confirm('You have unsaved changes. Are you sure you want to leave?');
      if (!confirmed) return;
    }
    router.push('/dashboard');
  };

  const handleSave = async () => {
    if (!user || !currentJob) return;

    const success = await syncCurrentJob();
    if (success) {
      toast.success('Job saved');
    } else if (!isOnline) {
      toast.info('Saved locally - will sync when online');
    } else {
      toast.error('Failed to save job');
    }
  };

  // Wrapper function to maintain backward compatibility with context consumers
  const updateJob = (updates: Partial<JobDetail>) => {
    if (updates.circuits) updateCircuits(updates.circuits);
    if (updates.observations) updateObservations(updates.observations);
    if (updates.board_info) updateBoardInfo(updates.board_info);
    if (updates.boards) updateBoards(updates.boards);
    if (updates.installation_details) updateInstallationDetails(updates.installation_details);
    if (updates.supply_characteristics) updateSupplyCharacteristics(updates.supply_characteristics);
    if (updates.inspection_schedule) updateInspectionSchedule(updates.inspection_schedule);
    if (updates.inspector_id) setInspectorId(updates.inspector_id);
    if (updates.extent_and_type) updateExtentAndType(updates.extent_and_type);
    if (updates.design_construction) updateDesignConstruction(updates.design_construction);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!currentJob) {
    return null;
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="bg-card border-b border-border sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={handleBack}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div>
              <h1 className="font-semibold truncate max-w-[200px] sm:max-w-none">
                {currentJob.address}
              </h1>
              <p className="text-xs text-muted-foreground">
                {new Date(currentJob.created_at).toLocaleDateString()} at{' '}
                {new Date(currentJob.created_at).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <OfflineIndicator />
            <Button onClick={handleSave} disabled={isSyncing || !isDirty} size="sm">
              {isSyncing ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="h-4 w-4 mr-2" />
                  Save
                </>
              )}
            </Button>
          </div>
        </div>
        <JobTabs jobId={jobId} certificateType={currentJob.certificate_type || 'EICR'} />
      </header>

      <main className="max-w-7xl mx-auto">
        <JobContext.Provider
          value={{
            job: currentJob,
            updateJob,
            user,
            certificateType: currentJob.certificate_type || 'EICR',
          }}
        >
          {children}
        </JobContext.Provider>
      </main>
    </div>
  );
}
