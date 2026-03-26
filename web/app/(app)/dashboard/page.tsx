'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  Plus,
  RefreshCw,
  FileCheck,
  ClipboardList,
  Zap,
  CircuitBoard,
  Eye,
  LayoutTemplate,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  GlassCard,
  GlassCardHeader,
  GlassCardTitle,
  GlassCardContent,
} from '@/components/ui/glass-card';
import { MetricCard } from '@/components/dashboard/metric-card';
import { RecentJobRow } from '@/components/dashboard/recent-job-row';
import { QuickActionButton } from '@/components/dashboard/quick-action-button';
import { SetupToolCard } from '@/components/dashboard/setup-tool-card';
import { CreateJobDialog } from '@/components/dashboard/create-job-dialog';
import { api } from '@/lib/api-client';
import { getUser } from '@/lib/auth';
import { useJobStore } from '@/lib/store';
import type { Job, CertificateType } from '@/lib/types';

export default function DashboardPage() {
  const router = useRouter();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const { setUser: setStoreUser } = useJobStore();
  const [currentUser, setCurrentUser] = useState<ReturnType<typeof getUser>>(null);
  const nowRef = useRef(Date.now());

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
    setCurrentUser(user);
    setStoreUser(user.id);
    nowRef.current = Date.now();
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

  const handleStartEICR = () => handleCreateJob('EICR');
  const handleStartEIC = () => handleCreateJob('EIC');

  // Compute metrics from jobs
  const metrics = useMemo(() => {
    const active = jobs.filter((j) => j.status === 'pending' || j.status === 'processing').length;
    const completed = jobs.filter((j) => j.status === 'done').length;
    // Expiring = completed jobs older than 5 years
    const fiveYearsMs = 5 * 365.25 * 24 * 60 * 60 * 1000;
    const expiring = jobs.filter((j) => {
      const age = nowRef.current - new Date(j.created_at).getTime();
      return age > fiveYearsMs && j.status === 'done';
    }).length;
    return { active, completed, expiring };
  }, [jobs]);

  // Recent 5 jobs sorted by date descending
  const recentJobs = useMemo(() => {
    return [...jobs]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 5);
  }, [jobs]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-pulse text-muted-foreground">Loading dashboard...</div>
      </div>
    );
  }

  return (
    <div className="p-5 md:p-6 space-y-6 max-w-4xl mx-auto">
      {/* ─── Hero Card ─── */}
      <GlassCard
        gradientBorder
        glow
        className="relative overflow-hidden animate-[stagger-in_0.4s_ease-out_both]"
      >
        <GlassCardHeader className="pb-2">
          <GlassCardTitle className="text-2xl">
            Welcome back
            {currentUser?.name ? (
              <>
                , <span className="gradient-text">{currentUser.name.split(' ')[0]}</span>
              </>
            ) : null}
          </GlassCardTitle>
          <p className="text-sm text-muted-foreground">
            {jobs.length === 0
              ? 'Create your first job to get started'
              : `You have ${metrics.active} active job${metrics.active !== 1 ? 's' : ''} in progress`}
          </p>
        </GlassCardHeader>
        <GlassCardContent className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={handleRefresh} disabled={refreshing}>
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </GlassCardContent>
      </GlassCard>

      {/* ─── Metric Cards ─── */}
      <div className="grid grid-cols-3 gap-3 stagger-in">
        <MetricCard
          label="Active"
          value={metrics.active}
          icon={Zap}
          iconColor="rgb(0, 102, 255)"
          iconBgColor="rgba(0, 102, 255, 0.15)"
        />
        <MetricCard
          label="Completed"
          value={metrics.completed}
          icon={CheckCircle2}
          iconColor="#00E676"
          iconBgColor="rgba(0, 230, 118, 0.15)"
        />
        <MetricCard
          label="Expiring"
          value={metrics.expiring}
          icon={AlertTriangle}
          iconColor="#FFB300"
          iconBgColor="rgba(255, 179, 0, 0.15)"
        />
      </div>

      {/* ─── Quick Actions ─── */}
      <section
        className="space-y-3 animate-[stagger-in_0.4s_ease-out_both]"
        style={{ animationDelay: '180ms' }}
      >
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          Quick Actions
        </h2>
        <div className="flex flex-wrap gap-3">
          <QuickActionButton label="Start EICR" icon={FileCheck} onClick={handleStartEICR} />
          <QuickActionButton label="Start EIC" icon={ClipboardList} onClick={handleStartEIC} />
        </div>
      </section>

      {/* ─── Setup Tools Grid ─── */}
      <section
        className="space-y-3 animate-[stagger-in_0.4s_ease-out_both]"
        style={{ animationDelay: '240ms' }}
      >
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          Tools
        </h2>
        <div className="grid grid-cols-2 gap-3">
          <SetupToolCard
            label="Boards"
            description="Distribution boards & CCUs"
            icon={CircuitBoard}
            onClick={() => router.push('/job')}
            index={0}
          />
          <SetupToolCard
            label="Circuits"
            description="Circuit schedules & test results"
            icon={Zap}
            onClick={() => router.push('/job')}
            index={1}
          />
          <SetupToolCard
            label="Observations"
            description="C1, C2, C3, FI codes"
            icon={Eye}
            onClick={() => router.push('/job')}
            index={2}
          />
          <SetupToolCard
            label="Templates"
            description="Reusable job templates"
            icon={LayoutTemplate}
            onClick={() => router.push('/job')}
            index={3}
          />
        </div>
      </section>

      {/* ─── Recent Jobs ─── */}
      {recentJobs.length > 0 && (
        <section
          className="space-y-3 animate-[stagger-in_0.4s_ease-out_both]"
          style={{ animationDelay: '300ms' }}
        >
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
              Recent Jobs
            </h2>
            <Button
              variant="link"
              className="text-xs text-brand-blue"
              onClick={() => router.push('/dashboard')}
            >
              View all
            </Button>
          </div>
          <div className="flex flex-col gap-2">
            {recentJobs.map((job, i) => (
              <RecentJobRow key={job.id} job={job} index={i} />
            ))}
          </div>
        </section>
      )}

      {/* ─── Empty State ─── */}
      {jobs.length === 0 && (
        <div
          className="flex flex-col items-center justify-center py-12 text-center animate-[stagger-in_0.4s_ease-out_both]"
          style={{ animationDelay: '120ms' }}
        >
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-brand-blue/10 to-brand-green/10 border border-brand-blue/20 flex items-center justify-center mb-5">
            <FileCheck className="h-7 w-7 text-brand-blue" />
          </div>
          <h2 className="text-lg font-semibold text-foreground mb-1">Ready to certify</h2>
          <p className="text-sm text-muted-foreground mb-6 max-w-sm">
            Create your first job, then just talk — CertMate fills out the form so it&apos;s ready
            to send before you leave site.
          </p>
          <Button onClick={() => setShowCreateDialog(true)}>
            <Plus className="h-4 w-4" />
            Create First Job
          </Button>
        </div>
      )}

      <CreateJobDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        onCreateJob={handleCreateJob}
      />
    </div>
  );
}
