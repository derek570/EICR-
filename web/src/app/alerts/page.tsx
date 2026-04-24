'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, CheckCircle2, Clock, Shield } from 'lucide-react';
import { api } from '@/lib/api-client';
import { clearAuth, getUser } from '@/lib/auth';
import { getCachedJobs, putCachedJobs } from '@/lib/pwa/job-cache';
import { ApiError, type Job } from '@/lib/types';
import { bucketJobs } from '@/lib/alerts/buckets';
import { SectionCard } from '@/components/ui/section-card';
import { TallyBadge } from '@/components/ui/tally-badge';
import { JobRow } from '@/components/dashboard/job-row';

/**
 * /alerts — three-bucket job overview (Phase 3).
 *
 * Mirrors iOS `AlertsView.swift`. Sections:
 *   - Needs Attention (red) — failed jobs.
 *   - In Progress (amber) — pending + processing.
 *   - Recently Completed (green) — done, capped at 10.
 *
 * All three sections are rendered when non-empty. The "Recently
 * Completed" section is collapsed by default (the other two are
 * expanded) because completed work is informational only — the
 * inspector's attention should flow to the top of the page first.
 *
 * Data fetch is a direct clone of the dashboard pattern (cache-
 * first, stale-while-revalidate). That duplication is deliberate
 * — extracting a shared hook couples two independent pages and
 * inflicts a re-render blast radius on both whenever either list
 * changes. Two ~20-line effects are cheaper than the abstraction.
 */
export default function AlertsPage() {
  const router = useRouter();
  const [jobs, setJobs] = React.useState<Job[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const user = getUser();
    if (!user) {
      router.replace('/login');
      return;
    }
    let cancelled = false;
    let networkLanded = false;
    let hadCache = false;

    void getCachedJobs(user.id).then((cached) => {
      if (cancelled || networkLanded) return;
      if (cached) {
        setJobs((prev) => prev ?? cached);
        hadCache = true;
      }
    });

    api
      .jobs(user.id)
      .then((list) => {
        if (cancelled) return;
        networkLanded = true;
        setJobs(list);
        void putCachedJobs(user.id, list);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          clearAuth();
          router.replace('/login');
          return;
        }
        if (hadCache) return;
        setError(err.message);
        setJobs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  const buckets = React.useMemo(() => bucketJobs(jobs ?? []), [jobs]);

  const total =
    buckets.needsAttention.length + buckets.inProgress.length + buckets.recentlyCompleted.length;

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-[22px] font-bold text-[var(--color-text-primary)]">Alerts</h1>
        <p className="text-[13px] text-[var(--color-text-secondary)]">
          Jobs that need attention, are in progress, or were recently completed.
        </p>
      </header>

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
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="cm-shimmer h-24 rounded-[var(--radius-lg)] bg-[var(--color-surface-2)]"
            />
          ))}
        </div>
      ) : total === 0 ? (
        <EmptyState />
      ) : (
        <>
          {buckets.needsAttention.length > 0 ? (
            <AlertSection
              title="Needs Attention"
              icon={AlertTriangle}
              variant="destructive"
              jobs={buckets.needsAttention}
              defaultOpen
            />
          ) : null}
          {buckets.inProgress.length > 0 ? (
            <AlertSection
              title="In Progress"
              icon={Clock}
              variant="warn"
              jobs={buckets.inProgress}
              defaultOpen
            />
          ) : null}
          {buckets.recentlyCompleted.length > 0 ? (
            <AlertSection
              title="Recently Completed"
              icon={CheckCircle2}
              variant="success"
              jobs={buckets.recentlyCompleted}
              defaultOpen={false}
            />
          ) : null}
        </>
      )}
    </main>
  );
}

// -----------------------------------------------------------------------

type Variant = 'destructive' | 'warn' | 'success';

const VARIANT_ACCENT: Record<Variant, 'red' | 'amber' | 'green'> = {
  destructive: 'red',
  warn: 'amber',
  success: 'green',
};

type LucideIcon = React.ComponentType<{
  className?: string;
  strokeWidth?: number;
  'aria-hidden'?: boolean;
}>;

function AlertSection({
  title,
  icon: Icon,
  variant,
  jobs,
  defaultOpen,
}: {
  title: string;
  icon: LucideIcon;
  variant: Variant;
  jobs: Job[];
  defaultOpen: boolean;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  const accent = VARIANT_ACCENT[variant];

  return (
    <SectionCard accent={accent}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="-m-2 flex w-[calc(100%+1rem)] items-center gap-2 rounded-[var(--radius-md)] px-2 py-2 text-left transition hover:bg-[var(--color-surface-3)]"
      >
        <span
          className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full"
          style={{
            background: `color-mix(in srgb, ${variantToVar(variant)} 18%, transparent)`,
            color: variantToVar(variant),
          }}
          aria-hidden
        >
          <Icon className="h-4 w-4" strokeWidth={2.25} aria-hidden />
        </span>
        <span className="flex-1 text-[15px] font-semibold text-[var(--color-text-primary)]">
          {title}
        </span>
        <TallyBadge count={jobs.length} variant={variant} />
        <span
          aria-hidden
          className="ml-1 text-[var(--color-text-tertiary)]"
          style={{
            transform: open ? 'rotate(90deg)' : 'none',
            transition: 'transform 140ms ease',
          }}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M9 18l6-6-6-6" />
          </svg>
        </span>
      </button>
      {open ? (
        <div className="mt-3 flex flex-col gap-2">
          {jobs.map((job) => (
            <JobRow key={job.id} job={job} />
          ))}
        </div>
      ) : null}
    </SectionCard>
  );
}

function variantToVar(v: Variant): string {
  switch (v) {
    case 'destructive':
      return 'var(--color-severity-c1)';
    case 'warn':
      return 'var(--color-severity-c2)';
    case 'success':
      return 'var(--color-severity-ok)';
  }
}

function EmptyState() {
  return (
    <section className="flex flex-col items-center justify-center gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-6 py-12 text-center">
      <Shield className="h-14 w-14 text-[var(--color-severity-ok)]" strokeWidth={1.5} aria-hidden />
      <h2 className="text-[17px] font-bold text-[var(--color-text-primary)]">All clear</h2>
      <p className="max-w-xs text-[13px] leading-[1.5] text-[var(--color-text-secondary)]">
        No alerts right now. Job notifications will appear here.
      </p>
    </section>
  );
}
