'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  Plus,
  RefreshCw,
  Mic,
  FileCheck,
  Activity,
  CheckCircle,
  XCircle,
  LayoutDashboard,
  Sliders,
  Users,
  Settings,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { JobTable } from '@/components/dashboard/job-table';
import { CreateJobDialog } from '@/components/dashboard/create-job-dialog';
import { MetricCard } from '@/components/dashboard/metric-card';
import { SetupToolCard } from '@/components/dashboard/setup-tool-card';
import { api } from '@/lib/api-client';
import { getUser } from '@/lib/auth';
import { useJobStore } from '@/lib/store';
import type { Job, CertificateType } from '@/lib/types';

/* ------------------------------------------------------------------ */
/*  Skeleton loading — mirrors iOS DashboardView skeleton placeholders */
/* ------------------------------------------------------------------ */
function DashboardSkeleton() {
  return (
    <div className="p-6 space-y-6 animate-pulse">
      {/* Header skeleton */}
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <div className="h-7 w-32 rounded-lg bg-white/[0.06]" />
          <div className="h-4 w-48 rounded bg-white/[0.04]" />
        </div>
        <div className="flex gap-2">
          <div className="h-9 w-24 rounded-lg bg-white/[0.06]" />
          <div className="h-9 w-28 rounded-lg bg-white/[0.08]" />
        </div>
      </div>

      {/* Metric cards skeleton */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-20 rounded-xl bg-white/[0.05] border border-white/[0.06]" />
        ))}
      </div>

      {/* Table skeleton rows */}
      <div className="space-y-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-14 rounded-lg bg-white/[0.04]" />
        ))}
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const { setUser: setStoreUser } = useJobStore();

  const loadJobs = useCallback(async () => {
    const user = getUser();
    if (!user) return;
    try {
      const jobsList = await api.getJobs(user.id);
      setJobs(jobsList);
    } catch (err) {
      console.error('Failed to load jobs:', err);
      toast.error('Failed to load jobs');
    }
  }, []);

  useEffect(() => {
    const user = getUser();
    if (!user) {
      router.push('/login');
      return;
    }
    setStoreUser(user.id);
    loadJobs().finally(() => setLoading(false));
  }, [router, setStoreUser, loadJobs]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadJobs();
    setRefreshing(false);
  };

  const handleCreateJob = async (certType: CertificateType) => {
    const user = getUser();
    if (!user) return;
    try {
      const result = await api.createBlankJob(user.id, certType);
      toast.success(`New ${certType} job created`);
      router.push(`/job/${result.jobId}`);
    } catch {
      toast.error('Failed to create job');
    }
  };

  const handleJobDeleted = (jobId: string) => {
    setJobs((prev) => prev.filter((j) => j.id !== jobId));
  };

  if (loading) {
    return <DashboardSkeleton />;
  }

  const user = getUser();

  /* Derive metrics from job list — mirrors iOS ACTIVE/DONE/EXPIRING hero */
  const activeCount = jobs.filter(
    (j) => j.status === 'pending' || j.status === 'processing'
  ).length;
  const doneCount = jobs.filter((j) => j.status === 'done').length;
  const failedCount = jobs.filter((j) => j.status === 'failed').length;

  const setupCards = [
    {
      label: 'Defaults',
      description: 'Set certificate defaults for faster form fill',
      icon: Sliders,
      href: '/defaults',
    },
    {
      label: 'Staff',
      description: 'Manage inspectors and team members',
      icon: Users,
      href: '/staff',
    },
    {
      label: 'Settings',
      description: 'Account, app preferences and integrations',
      icon: Settings,
      href: '/settings',
    },
  ];

  return (
    <div className="p-6 space-y-6">
      {/* Dashboard header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Dashboard</h1>
          <p className="text-sm text-gray-500 mt-1">{user?.email}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={refreshing}
            className="border-white/10 text-gray-300 hover:text-white hover:bg-white/5"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button
            onClick={() => setShowCreateDialog(true)}
            className="bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-700 hover:to-blue-600 text-white shadow-lg shadow-blue-500/20"
          >
            <Plus className="h-4 w-4 mr-2" />
            New Job
          </Button>
        </div>
      </div>

      {/* Metrics hero — mirrors iOS animated gradient hero card with ACTIVE/DONE/EXPIRING */}
      {jobs.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <MetricCard
            label="Active"
            value={activeCount}
            icon={Activity}
            iconColor="#3b82f6"
            iconBgColor="rgba(59,130,246,0.12)"
          />
          <MetricCard
            label="Completed"
            value={doneCount}
            icon={CheckCircle}
            iconColor="#22c55e"
            iconBgColor="rgba(34,197,94,0.12)"
          />
          <MetricCard
            label="Total"
            value={jobs.length}
            icon={LayoutDashboard}
            iconColor="#a855f7"
            iconBgColor="rgba(168,85,247,0.12)"
          />
        </div>
      )}

      {jobs.length === 0 ? (
        <>
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-blue-500/10 to-green-500/10 border border-blue-500/20 flex items-center justify-center mb-6">
              <Mic className="h-8 w-8 text-blue-400" />
            </div>
            <h2 className="text-xl font-semibold text-white mb-2">Ready to certify</h2>
            <p className="text-gray-400 mb-2 max-w-md">
              Create your first job, then just talk — CertMate fills out the form so it&apos;s ready
              to send before you leave site.
            </p>
            <div className="flex items-center gap-4 text-xs text-gray-500 mb-8">
              <span className="flex items-center gap-1">
                <Mic className="h-3 w-3" /> Voice-powered
              </span>
              <span className="flex items-center gap-1">
                <FileCheck className="h-3 w-3" /> AI extraction
              </span>
            </div>
            <Button
              onClick={() => setShowCreateDialog(true)}
              className="bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-700 hover:to-blue-600 text-white shadow-lg shadow-blue-500/20"
            >
              <Plus className="h-4 w-4 mr-2" />
              Create First Job
            </Button>
          </div>

          {/* Setup cards — mirrors iOS DashboardView setup quick-action cards */}
          <div>
            <h2 className="text-sm font-semibold text-gray-400 mb-3 uppercase tracking-wide">
              Get Set Up
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {setupCards.map((card, i) => (
                <SetupToolCard
                  key={card.href}
                  label={card.label}
                  description={card.description}
                  icon={card.icon}
                  index={i}
                  onClick={() => router.push(card.href)}
                />
              ))}
            </div>
          </div>
        </>
      ) : (
        <>
          <JobTable jobs={jobs} onRefresh={handleRefresh} onJobDeleted={handleJobDeleted} />

          {/* Setup cards always visible beneath table */}
          <div>
            <h2 className="text-sm font-semibold text-gray-400 mb-3 uppercase tracking-wide">
              Quick Setup
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {setupCards.map((card, i) => (
                <SetupToolCard
                  key={card.href}
                  label={card.label}
                  description={card.description}
                  icon={card.icon}
                  index={i}
                  onClick={() => router.push(card.href)}
                />
              ))}
            </div>
          </div>
        </>
      )}

      <CreateJobDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        onCreateJob={handleCreateJob}
      />
    </div>
  );
}
