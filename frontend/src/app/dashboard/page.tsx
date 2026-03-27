'use client';

import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  RefreshCw,
  CloudOff,
  Bell,
  Download,
  CheckSquare,
  XSquare,
  Search,
  Settings,
  Users,
  FileCheck,
  ClipboardList,
  Zap,
  CheckCircle2,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { MetricCard } from '@/components/dashboard/metric-card';
import { SetupToolCard } from '@/components/dashboard/setup-tool-card';
import { RecentJobRow } from '@/components/dashboard/recent-job-row';
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
  const [searchQuery, setSearchQuery] = useState('');

  // Get online status from the store
  const { isOnline, setOnline, setUser: setStoreUser, refreshPendingCount } = useJobStore();

  // Merge API jobs with local dirty jobs
  const mergeJobsWithLocal = useCallback(
    async (apiJobs: Job[], userId: string): Promise<DashboardJob[]> => {
      try {
        const localJobs = await getAllLocalJobs(userId);

        const localJobById = new Map<string, LocalJob>();
        const localJobByAddress = new Map<string, LocalJob>();
        localJobs.forEach((job) => {
          localJobById.set(job.id, job);
          if (job.address) localJobByAddress.set(job.address, job);
        });

        const mergedJobs: DashboardJob[] = apiJobs.map((job) => {
          const localByID = localJobById.get(job.id);
          const localByAddress = job.address ? localJobByAddress.get(job.address) : undefined;
          const localJob = localByID || localByAddress;
          return {
            ...job,
            isLocalDirty: localJob?.isDirty || false,
          };
        });

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

    if (!navigator.onLine) {
      setOnline(false);
    }

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [setOnline]);

  // Track previous job statuses for completion detection
  const prevJobsRef = useRef<Map<string, string | undefined>>(new Map());
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

  // Fallback poll every 30 seconds for resilience
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
    const storedUser = localStorage.getItem('user');
    if (!storedUser) {
      router.push('/login');
      return;
    }

    const userData = JSON.parse(storedUser) as User;
    setUser(userData);
    setStoreUser(userData.id);

    async function loadJobs() {
      try {
        if (navigator.onLine) {
          const jobsList = await api.getJobs(userData.id);
          const mergedJobs = await mergeJobsWithLocal(jobsList, userData.id);
          setJobs(mergedJobs);
        } else {
          const offlineJobs = await loadOfflineJobs(userData.id);
          setJobs(offlineJobs);
          setOfflineMessage('You are offline. Showing cached jobs.');
        }
      } catch (error) {
        console.error('Failed to load jobs:', error);
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

  // Show push notification prompt once
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
    document.cookie = 'token=; path=/; max-age=0';
    router.push('/login');
  };

  const handleDeleteJob = async (e: React.MouseEvent, jobId: string, jobAddress: string) => {
    e.preventDefault();
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
      const jobsList = await api.getJobs(user.id);
      const mergedJobs = await mergeJobsWithLocal(jobsList, user.id);
      setJobs(mergedJobs);
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

  // Compute metrics from jobs
  const metrics = useMemo(() => {
    const total = jobs.length;
    const pending = jobs.filter((j) => j.status === 'pending' || j.status === 'processing').length;
    const completed = jobs.filter((j) => j.status === 'done').length;
    return { total, pending, completed };
  }, [jobs]);

  // Recent 5 jobs sorted by date descending
  const recentJobs = useMemo(() => {
    return [...jobs]
      .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())
      .slice(0, 5);
  }, [jobs]);

  // Search-filtered jobs
  const filteredJobs = useMemo(() => {
    if (!searchQuery.trim()) return null;
    const q = searchQuery.toLowerCase();
    return [...jobs]
      .filter(
        (j) =>
          (j.address || '').toLowerCase().includes(q) ||
          (j.certificate_type || '').toLowerCase().includes(q) ||
          (j.status || '').toLowerCase().includes(q)
      )
      .sort(
        (a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
      );
  }, [jobs, searchQuery]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading dashboard...</div>
      </div>
    );
  }

  // Jobs to display in the list (search results or recent)
  const displayJobs = filteredJobs ?? (jobs.length > 5 ? recentJobs : jobs);

  return (
    <div className="min-h-screen bg-background">
      <DashboardHeader userEmail={user?.email} userRole={user?.role} onLogout={handleLogout} />

      <main className="max-w-4xl mx-auto p-5 md:p-6 space-y-6">
        {/* Offline message banner */}
        {offlineMessage && (
          <div className="px-4 py-3 rounded-[12px] glass-bg border border-amber-500/20 flex items-center gap-2">
            <CloudOff className="h-4 w-4 text-amber-400 flex-shrink-0" />
            <span className="text-sm text-amber-300">{offlineMessage}</span>
          </div>
        )}

        {/* Push notification prompt */}
        {showPushBanner && (
          <div className="px-4 py-3 rounded-[12px] glass-bg border border-brand-blue/20 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Bell className="h-4 w-4 text-brand-blue flex-shrink-0" />
              <span className="text-sm text-blue-300">
                Get notified when your certificates are ready?
              </span>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <Button size="sm" variant="glass-outline" onClick={handleDismissPush}>
                No thanks
              </Button>
              <Button size="sm" variant="glass" onClick={handleAcceptPush}>
                Enable
              </Button>
            </div>
          </div>
        )}

        {/* ═══ Hero Header Card — glassmorphic ═══ */}
        <div
          className="relative overflow-hidden rounded-[18px] p-5 animate-[stagger-in_0.4s_ease-out_both]"
          style={{
            background: '#141414',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            border: '1px solid rgba(255,255,255,0.1)',
          }}
        >
          <div className="flex items-center gap-2 mb-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-brand-blue to-brand-green shadow-[0_2px_8px_rgba(0,102,255,0.3)]">
              <Zap className="h-4 w-4 text-white" />
            </div>
            <span className="text-sm font-semibold gradient-text tracking-wide">CertMate</span>
          </div>
          <h1 className="text-2xl font-bold text-foreground mb-1">
            Welcome back
            {user?.name ? (
              <>
                , <span className="gradient-text">{user.name.split(' ')[0]}</span>
              </>
            ) : null}
          </h1>
          <p className="text-sm text-muted-foreground mb-3">
            {jobs.length === 0
              ? 'Create your first job to get started'
              : `You have ${metrics.pending} active job${metrics.pending !== 1 ? 's' : ''} in progress`}
          </p>
          <Button
            variant="glass-ghost"
            size="sm"
            onClick={refreshJobs}
            disabled={refreshing}
            aria-label="Refresh jobs list"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>

        {/* ═══ START BUTTONS — Primary CTA, impossible to miss ═══ */}
        <div className="grid grid-cols-2 gap-4 animate-[stagger-in_0.4s_ease-out_0.1s_both]">
          <button
            type="button"
            onClick={() => handleNewJob('EICR')}
            disabled={creatingJob === 'EICR'}
            aria-label="Start new EICR certificate"
            className="group relative min-h-[60px] rounded-2xl font-bold text-lg text-white bg-gradient-to-br from-[#0066FF] to-[#0099FF] shadow-[0_4px_20px_rgba(0,102,255,0.4)] transition-all duration-200 hover:shadow-[0_8px_32px_rgba(0,102,255,0.5)] hover:brightness-110 hover:-translate-y-0.5 active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-brand-blue/50 focus-visible:ring-offset-2 focus-visible:ring-offset-L0 outline-none disabled:opacity-50 disabled:pointer-events-none flex items-center justify-center gap-2"
          >
            {creatingJob === 'EICR' ? (
              <RefreshCw className="w-5 h-5 animate-spin" />
            ) : (
              <FileCheck className="w-6 h-6" />
            )}
            Start EICR
          </button>
          <button
            type="button"
            onClick={() => handleNewJob('EIC')}
            disabled={creatingJob === 'EIC'}
            aria-label="Start new EIC certificate"
            className="group relative min-h-[60px] rounded-2xl font-bold text-lg text-white bg-gradient-to-br from-[#00C853] to-[#00E676] shadow-[0_4px_20px_rgba(0,200,83,0.4)] transition-all duration-200 hover:shadow-[0_8px_32px_rgba(0,200,83,0.5)] hover:brightness-110 hover:-translate-y-0.5 active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-brand-green/50 focus-visible:ring-offset-2 focus-visible:ring-offset-L0 outline-none disabled:opacity-50 disabled:pointer-events-none flex items-center justify-center gap-2"
          >
            {creatingJob === 'EIC' ? (
              <RefreshCw className="w-5 h-5 animate-spin" />
            ) : (
              <ClipboardList className="w-6 h-6" />
            )}
            Start EIC
          </button>
        </div>

        {/* ─── Metric Cards ─── */}
        <div className="grid grid-cols-3 gap-3 stagger-in">
          <MetricCard
            label="Total"
            value={metrics.total}
            icon={FileCheck}
            iconColor="rgb(0, 102, 255)"
            iconBgColor="rgba(0, 102, 255, 0.15)"
          />
          <MetricCard
            label="Pending"
            value={metrics.pending}
            icon={Zap}
            iconColor="#FFB300"
            iconBgColor="rgba(255, 179, 0, 0.15)"
          />
          <MetricCard
            label="Completed"
            value={metrics.completed}
            icon={CheckCircle2}
            iconColor="#00E676"
            iconBgColor="rgba(0, 230, 118, 0.15)"
          />
        </div>

        {/* ─── Search Bar ─── */}
        <div className="relative">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            placeholder="Search jobs by address, type, or status..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label="Search jobs"
            className="w-full h-11 pl-11 pr-4 rounded-[12px] bg-L2 border border-neutral-700 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-brand-blue/50 focus:border-brand-blue/50 transition-all"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors p-2.5 min-w-[44px] min-h-[44px] flex items-center justify-center"
              aria-label="Clear search"
            >
              <XSquare className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* ─── Recent Jobs ─── */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
              {filteredJobs
                ? `Results (${filteredJobs.length})`
                : recentJobs.length > 0 && jobs.length > 5
                  ? 'Recent Jobs'
                  : 'Jobs'}
            </h2>
            <Button
              variant="glass-ghost"
              size="sm"
              onClick={refreshJobs}
              disabled={refreshing}
              aria-label="Refresh jobs"
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            </Button>
          </div>

          {/* Multi-select controls */}
          {doneJobs.length >= 2 && !filteredJobs && (
            <div className="flex items-center gap-2">
              <Button
                variant="glass-outline"
                size="sm"
                onClick={selectedJobIds.size === doneJobs.length ? clearSelection : selectAllDone}
              >
                {selectedJobIds.size === doneJobs.length ? (
                  <>
                    <XSquare className="h-4 w-4 mr-1" />
                    Clear
                  </>
                ) : (
                  <>
                    <CheckSquare className="h-4 w-4 mr-1" />
                    Select All ({doneJobs.length})
                  </>
                )}
              </Button>
              {selectedJobIds.size > 0 && (
                <span className="text-sm text-muted-foreground">
                  {selectedJobIds.size} selected
                </span>
              )}
            </div>
          )}

          {jobs.length === 0 && !filteredJobs ? (
            <div
              className="flex flex-col items-center justify-center py-12 text-center animate-[stagger-in_0.4s_ease-out_both]"
              style={{ animationDelay: '120ms' }}
            >
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-brand-blue/10 to-brand-green/10 border border-brand-blue/20 flex items-center justify-center mb-5">
                <FileCheck className="h-7 w-7 text-brand-blue" />
              </div>
              <h2 className="text-lg font-semibold text-foreground mb-1">Ready to certify</h2>
              <p className="text-sm text-muted-foreground max-w-sm">
                Create your first job using the buttons above — just talk and CertMate fills out the
                form so it&apos;s ready to send before you leave site.
              </p>
            </div>
          ) : filteredJobs && filteredJobs.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No jobs match &ldquo;{searchQuery}&rdquo;
            </p>
          ) : selectedJobIds.size > 0 ? (
            <div className="flex flex-col gap-2">
              {displayJobs.map((job) => (
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
          ) : (
            <div className="flex flex-col gap-2">
              {displayJobs.map((job, i) => (
                <RecentJobRow key={job.id} job={job} index={i} />
              ))}
            </div>
          )}

          {/* View All link */}
          {!filteredJobs && jobs.length > 5 && selectedJobIds.size === 0 && (
            <div className="flex justify-center pt-1">
              <Button
                variant="glass-ghost"
                size="sm"
                className="text-brand-blue"
                onClick={() => setSearchQuery(' ')}
              >
                View all {jobs.length} jobs
              </Button>
            </div>
          )}
        </section>

        {/* ─── Setup Tools Grid ─── */}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
            Tools
          </h2>
          <div className="grid grid-cols-2 gap-3">
            <SetupToolCard
              label="Set Defaults"
              description="Inspector & company defaults"
              icon={Settings}
              onClick={() => setShowDefaultsModal(true)}
              index={0}
            />
            <SetupToolCard
              label="Company Details"
              description="Business info & branding"
              icon={Settings}
              onClick={() => router.push('/settings/company')}
              index={1}
            />
            <SetupToolCard
              label="Staff"
              description="Inspectors & team members"
              icon={Users}
              onClick={() => setShowInspectorModal(true)}
              index={2}
            />
            <SetupToolCard
              label="Settings"
              description="App preferences & config"
              icon={Settings}
              onClick={() => router.push('/settings')}
              index={3}
            />
          </div>
        </section>
      </main>

      {/* Floating bulk download button */}
      {selectedJobIds.size >= 2 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50">
          <button
            type="button"
            className="inline-flex items-center justify-center gap-2 h-[52px] px-6 rounded-full font-semibold text-white bg-gradient-to-r from-brand-green to-brand-blue shadow-[0_4px_16px_rgba(0,102,255,0.30)] transition-all duration-200 hover:shadow-[0_6px_24px_rgba(0,102,255,0.40)] hover:brightness-110 active:animate-spring-press focus-visible:ring-2 focus-visible:ring-brand-blue/50 focus-visible:ring-offset-2 focus-visible:ring-offset-L0 outline-none"
            onClick={handleBulkDownload}
            disabled={downloading}
            aria-label={
              downloading ? 'Preparing download' : `Download ${selectedJobIds.size} certificates`
            }
          >
            {downloading ? (
              <RefreshCw className="h-5 w-5 animate-spin" />
            ) : (
              <Download className="h-5 w-5" />
            )}
            {downloading ? 'Preparing ZIP...' : `Download ${selectedJobIds.size} Certificates`}
          </button>
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
