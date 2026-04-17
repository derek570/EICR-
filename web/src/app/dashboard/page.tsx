'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api-client';
import { getUser, clearAuth } from '@/lib/auth';
import type { Job } from '@/lib/types';
import { AnimatedCounter } from '@/components/dashboard/animated-counter';
import { JobRow } from '@/components/dashboard/job-row';

/**
 * Dashboard home — mirrors iOS DashboardView:
 *  - Hero stats (total jobs, in progress, completed) with animated counters
 *  - Quick actions (New EICR, New EIC)
 *  - Recent jobs list
 *  - Setup tools (placeholders filled in later phases)
 */
export default function DashboardPage() {
  const router = useRouter();
  const [jobs, setJobs] = React.useState<Job[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);

  React.useEffect(() => {
    const user = getUser();
    if (!user) {
      router.replace('/login');
      return;
    }
    let cancelled = false;
    api
      .jobs(user.id)
      .then((list) => {
        if (!cancelled) setJobs(list);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        // Auth probably expired — kick to login.
        if (/401/.test(err.message)) {
          clearAuth();
          router.replace('/login');
          return;
        }
        setError(err.message);
        setJobs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  const stats = React.useMemo(() => {
    const list = jobs ?? [];
    return {
      total: list.length,
      inProgress: list.filter((j) => j.status === 'processing' || j.status === 'pending').length,
      done: list.filter((j) => j.status === 'done').length,
    };
  }, [jobs]);

  async function createJob(kind: 'EICR' | 'EIC') {
    const user = getUser();
    if (!user) return;
    setCreating(true);
    try {
      const { id } = await api.createJob(user.id, kind);
      router.push(`/job/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create job");
    } finally {
      setCreating(false);
    }
  }

  const recent = jobs?.slice(0, 8) ?? [];

  return (
    <main
      className="relative mx-auto flex w-full flex-col gap-8 px-4 py-6 md:px-8 md:py-10"
      style={{ maxWidth: '1200px' }}
    >
      {/* Ambient background glow (subtler than login) */}
      <div
        className="cm-orb"
        style={{
          top: '-180px',
          right: '-80px',
          width: '420px',
          height: '420px',
          opacity: 0.35,
          background: 'radial-gradient(circle, rgba(0,102,255,0.6), transparent 70%)',
        }}
        aria-hidden
      />

      {/* Hero stats */}
      <section aria-labelledby="stats-heading" className="grid gap-3 md:grid-cols-3">
        <h2 id="stats-heading" className="sr-only">
          Certificate overview
        </h2>
        <StatCard label="Certificates" value={stats.total} color="var(--color-brand-blue)" />
        <StatCard
          label="In progress"
          value={stats.inProgress}
          color="var(--color-status-processing)"
        />
        <StatCard label="Complete" value={stats.done} color="var(--color-brand-green)" />
      </section>

      {/* Quick actions */}
      <section className="flex flex-col gap-3">
        <h2 className="text-[13px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
          New certificate
        </h2>
        <div className="flex flex-wrap gap-3">
          <Button size="lg" onClick={() => createJob('EICR')} disabled={creating}>
            New EICR
          </Button>
          <Button
            size="lg"
            variant="secondary"
            onClick={() => createJob('EIC')}
            disabled={creating}
          >
            New EIC
          </Button>
        </div>
      </section>

      {/* Recent jobs */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-[13px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
            Recent
          </h2>
          {jobs && jobs.length > recent.length ? (
            <span className="text-xs text-[var(--color-text-tertiary)]">
              Showing {recent.length} of {jobs.length}
            </span>
          ) : null}
        </div>
        {error ? (
          <p
            role="alert"
            className="rounded-[var(--radius-md)] border border-[var(--color-status-failed)]/40 bg-[var(--color-status-failed)]/10 px-3 py-2 text-sm text-[var(--color-status-failed)]"
          >
            {error}
          </p>
        ) : null}
        {jobs === null ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="cm-shimmer h-16 rounded-[var(--radius-lg)] bg-[var(--color-surface-2)]"
              />
            ))}
          </div>
        ) : recent.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>No certificates yet</CardTitle>
              <CardDescription>
                Start a new EICR or EIC above to begin a voice-driven inspection.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <div className="flex flex-col gap-2">
            {recent.map((j) => (
              <JobRow key={j.id} job={j} />
            ))}
          </div>
        )}
      </section>

      {/* Setup tools — each tool becomes a full page in Phase 6 */}
      <section className="flex flex-col gap-3">
        <h2 className="text-[13px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
          Setup
        </h2>
        <div className="grid gap-3 md:grid-cols-3">
          <SetupTile
            title="Company details"
            description="Logo, address, registration."
            href="/settings/company"
          />
          <SetupTile
            title="Inspectors"
            description="Qualifications & signatures."
            href="/settings/inspectors"
          />
          <SetupTile
            title="Defaults"
            description="Cable sizes, OCPD ratings."
            href="/settings/defaults"
          />
        </div>
      </section>
    </main>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <Card className="flex flex-col gap-1 py-5">
      <span className="text-[12px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
        {label}
      </span>
      <AnimatedCounter
        value={value}
        className="mt-1 text-[52px] font-black leading-none"
        aria-label={`${value} ${label.toLowerCase()}`}
      />
      <span
        className="mt-2 block h-1 w-10 rounded-full"
        style={{ background: color }}
        aria-hidden
      />
    </Card>
  );
}

function SetupTile({
  title,
  description,
  href,
}: {
  title: string;
  description: string;
  href: string;
}) {
  return (
    <a
      href={href}
      className="group flex flex-col gap-1 rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-4 py-4 transition hover:bg-[var(--color-surface-3)]"
    >
      <span className="text-[15px] font-semibold text-[var(--color-text-primary)]">{title}</span>
      <span className="text-xs text-[var(--color-text-secondary)]">{description}</span>
    </a>
  );
}
