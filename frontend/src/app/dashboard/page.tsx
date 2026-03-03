'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  FolderOpen,
  Plus,
  RefreshCw,
  CloudOff,
  Bell,
  Download,
  CheckSquare,
  XSquare,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import type { User, Job } from '@/lib/api';
import { useJobStore } from '@/lib/store';
import { getAllLocalJobs, type LocalJob } from '@/lib/db';
import { InspectorModal } from '@/components/inspector-modal';
import { DefaultsModal } from '@/components/defaults-modal';
import { CloneDialog } from '@/components/clone-dialog';
import { connectSocket, disconnectSocket, onJobCompleted, onJobFailed } from '@/lib/socket';
import { subscribeToPush } from '@/lib/push';
import { DashboardHeader } from '@/components/dashboard/dashboard-header';
import { JobCard } from '@/components/dashboard/job-card';
import type { DashboardJob } from '@/components/dashboard/job-card';

export default function DashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [jobs, setJobs] = useState<DashboardJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [offlineMessage, setOfflineMessage] = useState<string | null>(null);
  const [showInspectorModal, setShowInspectorModal] = useState(false);
  const [showDefaultsModal, setShowDefaultsModal] = useState(false);
  const [deletingJobId, setDeletingJobId] = useState<string | null>(null);
  const [showPushBanner, setShowPushBanner] = useState(false);
  const [cloneTarget, setCloneTarget] = useState<{ jobId: string; address: string } | null>(null);
  const [selectedJobIds, setSelectedJobIds] = useState<Set<string>>(new Set());
  const [downloading, setDownloading] = useState(false);
  const [creatingJob, setCreatingJob] = useState<'EICR' | 'EIC' | null>(null);

  // Get online status from the store
  const { isOnline, setOnline, setUser: setStoreUser, refreshPendingCount } = useJobStore();

  // Merge API jobs with local dirty jobs
  const mergeJobsWithLocal = useCallback(
    async (apiJobs: Job[], userId: string): Promise<DashboardJob[]> => {
      try {
        const localJobs = await getAllLocalJobs(userId);

        // Create maps for lookup by both id and address
        const localJobById = new Map<string, LocalJob>();
        const localJobByAddress = new Map<string, LocalJob>();
        localJobs.forEach((job) => {
          localJobById.set(job.id, job);
          if (job.address) localJobByAddress.set(job.address, job);
        });

        // Mark API jobs that have local dirty versions (check by id OR address)
        const mergedJobs: DashboardJob[] = apiJobs.map((job) => {
          const localByID = localJobById.get(job.id);
          const localByAddress = job.address ? localJobByAddress.get(job.address) : undefined;
          const localJob = localByID || localByAddress;
          return {
            ...job,
            isLocalDirty: localJob?.isDirty || false,
          };
        });

        // Add any local-only jobs (shouldn't happen often, but handles edge cases)
        // Check both id AND address to prevent duplicates when job ID changes after processing
        localJobs.forEach((localJob) => {
          const alreadyExists = mergedJobs.find(
            (j) => j.id === localJob.id || (localJob.address && j.address === localJob.address)
          );
          if (!alreadyExists) {
            mergedJobs.push({
              id: localJob.id,
              address: localJob.address,
              status: localJob.status,
              created_at: localJob.created_at,
              isLocalDirty: localJob.isDirty,
            });
          }
        });

        return mergedJobs;
      } catch {
        // If IndexedDB fails, just return API jobs without local markers
        return apiJobs.map((job) => ({ ...job, isLocalDirty: false }));
      }
    },
    []
  );

  // Load jobs from IndexedDB when offline
  const loadOfflineJobs = useCallback(async (userId: string): Promise<DashboardJob[]> => {
    try {
      const localJobs = await getAllLocalJobs(userId);
      return localJobs.map((job) => ({
        id: job.id,
        address: job.address,
        status: job.status,
        created_at: job.created_at,
        isLocalDirty: job.isDirty,
      }));
    } catch {
      return [];
    }
  }, []);

  const refreshJobs = async () => {
    if (!user) return;
    setRefreshing(true);
    setOfflineMessage(null);

    try {
      if (isOnline) {
        const jobsList = await api.getJobs(user.id);
        const mergedJobs = await mergeJobsWithLocal(jobsList, user.id);
        setJobs(mergedJobs);
      } else {
        const offlineJobs = await loadOfflineJobs(user.id);
        setJobs(offlineJobs);
        setOfflineMessage('Showing cached jobs. Connect to internet to refresh.');
      }
    } catch (error) {
      console.error('Failed to refresh jobs:', error);
      // If API fails, try loading from cache
      const offlineJobs = await loadOfflineJobs(user.id);
      if (offlineJobs.length > 0) {
        setJobs(offlineJobs);
        setOfflineMessage('Unable to reach server. Showing cached jobs.');
      }
    } finally {
      setRefreshing(false);
    }
  };

  // Track online/offline status
  useEffect(() => {
    const handleOnline = () => {
      setOnline(true);
      setOfflineMessage(null);
    };
    const handleOffline = () => {
      setOnline(false);
      setOfflineMessage('You are offline. Showing cached jobs.');
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Set initial state
    if (!navigator.onLine) {
      setOnline(false);
    }

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [setOnline]);

  // Track previous job statuses for completion detection
  const prevJobsRef = useRef<Map<string, string>>(new Map());
  const initialLoadComplete = useRef(false);
  const mergeJobsRef = useRef(mergeJobsWithLocal);
  mergeJobsRef.current = mergeJobsWithLocal;
  const routerRef = useRef(router);
  routerRef.current = router;
  const userRef = useRef(user);
  userRef.current = user;

  // Real-time socket events for job completion/failure
  useEffect(() => {
    if (!isOnline || !user) return;

    connectSocket();

    const unsubCompleted = onJobCompleted(async (event) => {
      if (!initialLoadComplete.current) return;
      const currentUser = userRef.current;
      if (!currentUser) return;

      toast.success(`Job completed: ${event.address || event.jobId}`);

      try {
        const jobsList = await api.getJobs(currentUser.id);
        const mergedJobs = await mergeJobsRef.current(jobsList, currentUser.id);
        prevJobsRef.current = new Map(mergedJobs.map((j) => [j.id, j.status]));
        setJobs(mergedJobs);
      } catch (err) {
        console.error('Failed to refresh after job:completed', err);
      }

      const pendingJobId = localStorage.getItem('pendingJobId');
      if (pendingJobId === event.jobId) {
        localStorage.removeItem('pendingJobId');
        routerRef.current.push(`/job/${event.jobId}`);
      }
    });

    const unsubFailed = onJobFailed(async (event) => {
      if (!initialLoadComplete.current) return;
      const currentUser = userRef.current;
      if (!currentUser) return;

      toast.error(`Job failed: ${event.error || event.jobId}`);

      try {
        const jobsList = await api.getJobs(currentUser.id);
        const mergedJobs = await mergeJobsRef.current(jobsList, currentUser.id);
        prevJobsRef.current = new Map(mergedJobs.map((j) => [j.id, j.status]));
        setJobs(mergedJobs);
      } catch (err) {
        console.error('Failed to refresh after job:failed', err);
      }

      const pendingJobId = localStorage.getItem('pendingJobId');
      if (pendingJobId === event.jobId) {
        localStorage.removeItem('pendingJobId');
      }
    });

    return () => {
      unsubCompleted();
      unsubFailed();
      disconnectSocket();
    };
  }, [isOnline, user]);

  // Fallback poll every 30 seconds for resilience (in case socket disconnects)
  useEffect(() => {
    const hasProcessingJobs = jobs.some((job) => job.status === 'processing');

    if (!hasProcessingJobs || !isOnline || !user) {
      return () => {};
    }

    const pollInterval = setInterval(async () => {
      const currentUser = userRef.current;
      if (!currentUser) return;

      try {
        const jobsList = await api.getJobs(currentUser.id);
        const mergedJobs = await mergeJobsRef.current(jobsList, currentUser.id);

        const pendingJobId = localStorage.getItem('pendingJobId');
        mergedJobs.forEach((job) => {
          const prevStatus = prevJobsRef.current.get(job.id);
          if (prevStatus === 'processing' && job.status === 'done') {
            toast.success(`Job completed: ${job.address}`);
            if (pendingJobId === job.id) {
              localStorage.removeItem('pendingJobId');
              routerRef.current.push(`/job/${job.id}`);
            }
          } else if (prevStatus === 'processing' && job.status === 'failed') {
            toast.error(`Job failed: ${job.address}`);
            if (pendingJobId === job.id) {
              localStorage.removeItem('pendingJobId');
            }
          }
        });

        prevJobsRef.current = new Map(mergedJobs.map((j) => [j.id, j.status]));
        setJobs(mergedJobs);
      } catch (error) {
        console.error('Fallback poll failed:', error);
      }
    }, 30000);

    return () => clearInterval(pollInterval);
  }, [jobs, isOnline, user]);

  // Initialize previous job statuses when jobs first load
  useEffect(() => {
    if (jobs.length > 0) {
      prevJobsRef.current = new Map(jobs.map((j) => [j.id, j.status]));
    }
  }, []);

  useEffect(() => {
    // Check if logged in
    const storedUser = localStorage.getItem('user');
    if (!storedUser) {
      router.push('/login');
      return;
    }

    const userData = JSON.parse(storedUser) as User;
    setUser(userData);
    setStoreUser(userData.id);

    // Load jobs from API or IndexedDB
    async function loadJobs() {
      try {
        if (navigator.onLine) {
          // Online: fetch from API and merge with local
          const jobsList = await api.getJobs(userData.id);
          const mergedJobs = await mergeJobsWithLocal(jobsList, userData.id);
          setJobs(mergedJobs);
        } else {
          // Offline: load from IndexedDB
          const offlineJobs = await loadOfflineJobs(userData.id);
          setJobs(offlineJobs);
          setOfflineMessage('You are offline. Showing cached jobs.');
        }
      } catch (error) {
        console.error('Failed to load jobs:', error);
        // If API fails, try loading from cache
        const offlineJobs = await loadOfflineJobs(userData.id);
        if (offlineJobs.length > 0) {
          setJobs(offlineJobs);
          setOfflineMessage('Unable to reach server. Showing cached jobs.');
        }
      } finally {
        setLoading(false);
        initialLoadComplete.current = true;
      }
    }

    loadJobs();
    refreshPendingCount();
  }, [router, mergeJobsWithLocal, loadOfflineJobs, setStoreUser, refreshPendingCount]);

  // Show push notification prompt once (after user loads)
  useEffect(() => {
    if (!user) return;
    if (typeof window === 'undefined') return;
    if (!('Notification' in window)) return;

    const pushAsked = localStorage.getItem('push-asked');
    if (!pushAsked && Notification.permission === 'default') {
      setShowPushBanner(true);
    }
  }, [user]);

  const handleAcceptPush = async () => {
    setShowPushBanner(false);
    localStorage.setItem('push-asked', 'true');
    await subscribeToPush();
  };

  const handleDismissPush = () => {
    setShowPushBanner(false);
    localStorage.setItem('push-asked', 'dismissed');
  };

  const handleLogout = async () => {
    disconnectSocket();
    try {
      await api.logout();
    } catch {
      // Ignore errors, clear local storage anyway
    }
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    // Clear cookie for middleware
    document.cookie = 'token=; path=/; max-age=0';
    router.push('/login');
  };

  const handleDeleteJob = async (e: React.MouseEvent, jobId: string, jobAddress: string) => {
    e.preventDefault(); // Prevent navigation to job
    e.stopPropagation();

    if (!user) return;

    const confirmed = window.confirm(
      `Are you sure you want to delete "${jobAddress}"?\n\nThis action cannot be undone.`
    );
    if (!confirmed) return;

    setDeletingJobId(jobId);
    try {
      await api.deleteJob(user.id, jobId);
      toast.success(`Job deleted: ${jobAddress}`);
      // Remove from local state
      setJobs((prev) => prev.filter((j) => j.id !== jobId));
    } catch (error) {
      console.error('Failed to delete job:', error);
      toast.error('Failed to delete job. Please try again.');
    } finally {
      setDeletingJobId(null);
    }
  };

  const handleCloneClick = (e: React.MouseEvent, jobId: string, jobAddress: string) => {
    e.preventDefault();
    e.stopPropagation();
    setCloneTarget({ jobId, address: jobAddress });
  };

  const handleCloneConfirm = async (newAddress: string, clearTestResults: boolean) => {
    if (!user || !cloneTarget) return;
    try {
      const result = await api.cloneJob(user.id, cloneTarget.jobId, newAddress, clearTestResults);
      toast.success(`Job cloned to "${result.address}"`);
      setCloneTarget(null);
      // Refresh job list to show the new clone
      const jobsList = await api.getJobs(user.id);
      const mergedJobs = await mergeJobsWithLocal(jobsList, user.id);
      setJobs(mergedJobs);
      // Navigate to the new job
      router.push(`/job/${result.jobId}`);
    } catch (error) {
      console.error('Failed to clone job:', error);
      toast.error('Failed to clone job. Please try again.');
    }
  };

  // Multi-select handlers for bulk download
  const doneJobs = jobs.filter((j) => j.status === 'done');

  const toggleJobSelection = (e: React.MouseEvent, jobId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedJobIds((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) {
        next.delete(jobId);
      } else {
        next.add(jobId);
      }
      return next;
    });
  };

  const selectAllDone = () => {
    setSelectedJobIds(new Set(doneJobs.map((j) => j.id)));
  };

  const clearSelection = () => {
    setSelectedJobIds(new Set());
  };

  const handleBulkDownload = async () => {
    if (!user || selectedJobIds.size < 2) return;
    setDownloading(true);
    try {
      await api.bulkDownload(user.id, Array.from(selectedJobIds));
      toast.success(`Downloading ${selectedJobIds.size} certificates`);
      setSelectedJobIds(new Set());
    } catch (error) {
      console.error('Bulk download failed:', error);
      toast.error(
        'Bulk download failed. Make sure PDFs have been generated for all selected jobs.'
      );
    } finally {
      setDownloading(false);
    }
  };

  const handleNewJob = async (type: 'EICR' | 'EIC') => {
    if (!user) return;
    setCreatingJob(type);
    try {
      const result = await api.createBlankJob(user.id, type);
      toast.success(`New ${type} job created`);
      router.push(`/record?type=${type}&jobId=${result.jobId}`);
    } catch (error) {
      console.error('Failed to create job:', error);
      toast.error('Failed to create job');
    } finally {
      setCreatingJob(null);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <DashboardHeader
        userEmail={user?.email}
        userRole={user?.role}
        onShowInspectors={() => setShowInspectorModal(true)}
        onShowDefaults={() => setShowDefaultsModal(true)}
        onLogout={handleLogout}
      />

      {/* Main content */}
      <main className="max-w-7xl mx-auto px-4 py-6">
        {/* Offline message banner */}
        {offlineMessage && (
          <div className="mb-4 px-4 py-3 rounded-lg bg-amber-50 border border-amber-200 flex items-center gap-2">
            <CloudOff className="h-4 w-4 text-amber-600 flex-shrink-0" />
            <span className="text-sm text-amber-800">{offlineMessage}</span>
          </div>
        )}

        {/* Push notification prompt */}
        {showPushBanner && (
          <div className="mb-4 px-4 py-3 rounded-lg bg-blue-50 border border-blue-200 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Bell className="h-4 w-4 text-blue-600 flex-shrink-0" />
              <span className="text-sm text-blue-800">
                Get notified when your certificates are ready?
              </span>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <Button size="sm" variant="outline" onClick={handleDismissPush}>
                No thanks
              </Button>
              <Button
                size="sm"
                className="bg-blue-600 hover:bg-blue-700"
                onClick={handleAcceptPush}
              >
                Enable
              </Button>
            </div>
          </div>
        )}

        <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-6 gap-3">
          <h1 className="text-2xl font-bold">Your Jobs</h1>
          <div className="grid grid-cols-2 sm:flex gap-2">
            <Button
              disabled={!isOnline || creatingJob !== null}
              className="bg-blue-600 hover:bg-blue-700 w-full col-span-1"
              onClick={() => handleNewJob('EICR')}
            >
              {creatingJob === 'EICR' ? (
                <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Plus className="h-4 w-4 mr-2" />
              )}
              Record EICR
            </Button>
            <Button
              disabled={!isOnline || creatingJob !== null}
              className="bg-emerald-600 hover:bg-emerald-700 w-full col-span-1"
              onClick={() => handleNewJob('EIC')}
            >
              {creatingJob === 'EIC' ? (
                <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Plus className="h-4 w-4 mr-2" />
              )}
              Record EIC
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={refreshJobs}
              disabled={refreshing}
              className="col-span-2 sm:col-span-1"
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>

        {/* Multi-select controls - shown when there are completed jobs */}
        {doneJobs.length >= 2 && (
          <div className="flex items-center gap-2 mb-4">
            <Button
              variant="outline"
              size="sm"
              onClick={selectedJobIds.size === doneJobs.length ? clearSelection : selectAllDone}
            >
              {selectedJobIds.size === doneJobs.length ? (
                <>
                  <XSquare className="h-4 w-4 mr-2" />
                  Clear Selection
                </>
              ) : (
                <>
                  <CheckSquare className="h-4 w-4 mr-2" />
                  Select All ({doneJobs.length})
                </>
              )}
            </Button>
            {selectedJobIds.size > 0 && (
              <span className="text-sm text-muted-foreground">{selectedJobIds.size} selected</span>
            )}
          </div>
        )}

        {jobs.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <FolderOpen className="h-12 w-12 text-muted-foreground mb-4" />
              <CardTitle className="mb-2">No jobs yet</CardTitle>
              <CardDescription className="text-center mb-4">
                Record audio and take photos to create your first job.
              </CardDescription>
              <div className="flex gap-3">
                <Button
                  disabled={!isOnline || creatingJob !== null}
                  className="bg-blue-600 hover:bg-blue-700"
                  onClick={() => handleNewJob('EICR')}
                >
                  {creatingJob === 'EICR' ? (
                    <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Plus className="h-4 w-4 mr-2" />
                  )}
                  Record EICR
                </Button>
                <Button
                  disabled={!isOnline || creatingJob !== null}
                  className="bg-emerald-600 hover:bg-emerald-700"
                  onClick={() => handleNewJob('EIC')}
                >
                  {creatingJob === 'EIC' ? (
                    <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Plus className="h-4 w-4 mr-2" />
                  )}
                  Record EIC
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {jobs.map((job) => (
              <JobCard
                key={job.id}
                job={job}
                isSelected={selectedJobIds.has(job.id)}
                deletingJobId={deletingJobId}
                onToggleSelection={toggleJobSelection}
                onClone={handleCloneClick}
                onDelete={handleDeleteJob}
              />
            ))}
          </div>
        )}
      </main>

      {/* Floating bulk download button */}
      {selectedJobIds.size >= 2 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50">
          <Button
            size="lg"
            className="bg-primary hover:bg-primary/90 shadow-lg rounded-full px-6 gap-2"
            onClick={handleBulkDownload}
            disabled={downloading}
          >
            {downloading ? (
              <RefreshCw className="h-5 w-5 animate-spin" />
            ) : (
              <Download className="h-5 w-5" />
            )}
            {downloading ? 'Preparing ZIP...' : `Download ${selectedJobIds.size} Certificates`}
          </Button>
        </div>
      )}

      {/* Modals */}
      {user && (
        <>
          <InspectorModal
            userId={user.id}
            isOpen={showInspectorModal}
            onClose={() => setShowInspectorModal(false)}
          />
          <DefaultsModal
            userId={user.id}
            isOpen={showDefaultsModal}
            onClose={() => setShowDefaultsModal(false)}
          />
          <CloneDialog
            isOpen={!!cloneTarget}
            onClose={() => setCloneTarget(null)}
            onConfirm={handleCloneConfirm}
            sourceAddress={cloneTarget?.address || ''}
          />
        </>
      )}
    </div>
  );
}
