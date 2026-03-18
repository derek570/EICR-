'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Plus, RefreshCw, FolderOpen, LogOut, Mic, FileCheck } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { JobTable } from '@/components/dashboard/job-table';
import { CreateJobDialog } from '@/components/dashboard/create-job-dialog';
import { api } from '@/lib/api-client';
import { getUser, clearAuth } from '@/lib/auth';
import { useJobStore } from '@/lib/store';
import type { Job, CertificateType } from '@/lib/types';

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

  const handleLogout = async () => {
    try {
      await api.logout();
    } catch {
      // Ignore
    }
    clearAuth();
    router.push('/login');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-pulse text-gray-500">Loading jobs...</div>
      </div>
    );
  }

  const user = getUser();

  return (
    <div className="p-6 space-y-6">
      {/* Dashboard header with gradient accent */}
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
          <Button
            variant="ghost"
            size="sm"
            onClick={handleLogout}
            className="text-gray-400 hover:text-gray-300"
          >
            <LogOut className="h-4 w-4 mr-2" />
            Sign out
          </Button>
        </div>
      </div>

      {jobs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          {/* Empty state with brand styling */}
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
      ) : (
        <JobTable jobs={jobs} onRefresh={handleRefresh} onJobDeleted={handleJobDeleted} />
      )}

      <CreateJobDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        onCreateJob={handleCreateJob}
      />
    </div>
  );
}
