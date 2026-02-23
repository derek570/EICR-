"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, RefreshCw, FolderOpen, LogOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { JobTable } from "@/components/dashboard/job-table";
import { CreateJobDialog } from "@/components/dashboard/create-job-dialog";
import { api } from "@/lib/api-client";
import { getUser, clearAuth } from "@/lib/auth";
import { useJobStore } from "@/lib/store";
import type { Job, CertificateType } from "@/lib/types";

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
      console.error("Failed to load jobs:", err);
      toast.error("Failed to load jobs");
    }
  }, []);

  useEffect(() => {
    const user = getUser();
    if (!user) {
      router.push("/login");
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
      toast.error("Failed to create job");
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
    router.push("/login");
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-pulse text-gray-400 dark:text-gray-500">Loading jobs...</div>
      </div>
    );
  }

  const user = getUser();

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Dashboard</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{user?.email}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={refreshing}
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button onClick={() => setShowCreateDialog(true)}>
            <Plus className="h-4 w-4 mr-2" />
            New Job
          </Button>
          <Button variant="ghost" size="sm" onClick={handleLogout}>
            <LogOut className="h-4 w-4 mr-2" />
            Sign out
          </Button>
        </div>
      </div>

      {jobs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <FolderOpen className="h-16 w-16 text-gray-300 dark:text-gray-600 mb-4" />
          <h2 className="text-lg font-medium text-gray-700 dark:text-gray-300 mb-2">No jobs yet</h2>
          <p className="text-gray-500 dark:text-gray-400 mb-6 max-w-sm">
            Create your first electrical certificate job to get started.
          </p>
          <Button onClick={() => setShowCreateDialog(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Create First Job
          </Button>
        </div>
      ) : (
        <JobTable
          jobs={jobs}
          onRefresh={handleRefresh}
          onJobDeleted={handleJobDeleted}
        />
      )}

      <CreateJobDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        onCreateJob={handleCreateJob}
      />
    </div>
  );
}
