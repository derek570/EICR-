'use client';

import * as React from 'react';
import Link from 'next/link';
import { Bell } from 'lucide-react';
import { api } from '@/lib/api-client';
import { getUser } from '@/lib/auth';
import { getCachedJobs } from '@/lib/pwa/job-cache';
import type { Job } from '@/lib/types';
import { bucketJobs } from '@/lib/alerts/buckets';

/**
 * Header-chrome alerts bell (Phase 3).
 *
 * Mirrors iOS `DashboardView.swift:L201-L221` toolbar bell — live
 * count of jobs that need attention (failed status). Tap navigates
 * to `/alerts` where the full three-bucket breakdown lives.
 *
 * Data path:
 *   - Reuses the same `api.jobs(userId)` endpoint the dashboard
 *     uses, plus the shared IDB cache so we paint from cache on
 *     offline navigation. We don't maintain a separate store — the
 *     dashboard already fetches this list and the network request
 *     is cheap when we duplicate.
 *   - Counts re-compute via `bucketJobs` so the badge is identical
 *     to the page's section counts (single source of truth).
 *
 * Anonymous states:
 *   - Unauthenticated (no user token) — renders nothing; the
 *     AppShell that wraps us is already auth-gated, but this is
 *     a belt-and-braces check for dev-only code paths.
 *   - `jobs === null` — renders a zero-state bell with no badge,
 *     matching iOS's "loading" treatment where the bell is visible
 *     but silent.
 *   - `count === 0` — no badge.
 */
export function AlertsBell({ dataTour }: { dataTour?: string } = {}) {
  const [jobs, setJobs] = React.useState<Job[] | null>(null);

  React.useEffect(() => {
    const user = getUser();
    if (!user) return;
    let cancelled = false;

    const fetchJobs = () => {
      void api
        .jobs(user.id)
        .then((list) => {
          if (cancelled) return;
          setJobs(list);
        })
        .catch(() => {
          // Swallow — the header-chrome bell can't surface its own
          // error, and the dashboard / alerts page will render the
          // banner if this request is failing on them too.
        });
    };

    // Cache-first paint so the badge is correct on offline nav /
    // cold-boot before the network lands.
    void getCachedJobs(user.id).then((cached) => {
      if (cancelled) return;
      if (cached) setJobs((prev) => prev ?? cached);
    });

    fetchJobs();

    // Refetch on focus + visibility changes so in-session deletes on
    // other surfaces (dashboard / alerts page) propagate to the badge
    // without needing a full shell remount.
    const onFocus = () => fetchJobs();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') fetchJobs();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const count = React.useMemo(() => {
    if (!jobs) return 0;
    const buckets = bucketJobs(jobs);
    return buckets.needsAttention.length;
  }, [jobs]);

  return (
    <Link
      href="/alerts"
      aria-label={count > 0 ? `Alerts — ${count} needs attention` : 'Alerts'}
      data-tour={dataTour}
      className="relative inline-flex h-10 w-10 items-center justify-center rounded-full text-[var(--color-text-primary)] transition hover:bg-[var(--color-surface-3)] focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)]"
    >
      <Bell className="h-5 w-5" strokeWidth={2} aria-hidden />
      {count > 0 ? (
        <span
          aria-hidden
          className="absolute right-1 top-1 inline-flex min-w-4 items-center justify-center rounded-full bg-[var(--color-status-failed)] px-1 text-[10px] font-bold text-white"
        >
          {count > 99 ? '99+' : count}
        </span>
      ) : null}
    </Link>
  );
}
