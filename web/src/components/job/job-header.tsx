'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { useJobContext } from '@/lib/job-context';

/**
 * iOS-style job detail header:
 *
 *    [ < Back ]         <address>
 *
 * - Back button on the left (chevron + "Back" text), tinted brand blue.
 * - Centred title showing the job address (truncated on narrow screens).
 *
 * Pre-deploy: the 3-dot overflow menu that iOS carries on the right has
 * been removed for web — its handler was a `console.log` stub and there
 * are no wired menu actions yet (rename / delete / export all live on
 * the Dashboard or in separate tabs on web). Shipping a button that
 * only logs would be a lint-zero regression AND a user-visible dead
 * control. Re-introduce when the actions land; a Phase-6 follow-up is
 * tracked in the rebuild plan.
 *
 * Save-status indicator sits beneath the centred title as a small pill
 * so it remains visible without fighting the iOS header symmetry. Now
 * driven by the real save pipeline in `JobProvider` (was hardcoded to
 * `false` pre-deploy).
 */
export function JobHeader() {
  const router = useRouter();
  const { job, isDirty, isSaving, saveError } = useJobContext();

  return (
    <header className="flex flex-col border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-0)]/80 px-2 py-2 backdrop-blur md:px-4">
      <div className="relative flex min-h-[44px] items-center">
        <button
          type="button"
          onClick={() => router.back()}
          className="inline-flex items-center gap-0.5 rounded-[var(--radius-md)] px-2 py-1.5 text-[15px] font-medium text-[var(--color-brand-blue)] transition hover:bg-[var(--color-surface-2)] focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)]"
        >
          <ChevronLeft className="h-5 w-5" strokeWidth={2.25} aria-hidden />
          <span>Back</span>
        </button>

        <h1
          className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 truncate text-center text-[17px] font-semibold text-[var(--color-text-primary)]"
          style={{ maxWidth: 'calc(100% - 120px)' }}
        >
          {job.address || 'Untitled job'}
        </h1>
      </div>

      <div className="flex justify-center pb-1">
        <SaveStatus isDirty={isDirty} isSaving={isSaving} saveError={saveError} />
      </div>
    </header>
  );
}

function SaveStatus({
  isDirty,
  isSaving,
  saveError,
}: {
  isDirty: boolean;
  isSaving: boolean;
  saveError: string | null;
}) {
  // Error pill takes precedence — a 4xx save failure is the most
  // important state for the inspector to see, and showing "Saving…"
  // on top would hide the fact that something's broken.
  if (saveError) {
    return (
      <span
        role="alert"
        className="flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--color-status-failed)]/30 bg-[var(--color-status-failed)]/10 px-2.5 py-0.5 text-[11px] text-[var(--color-status-failed)]"
        title={saveError}
      >
        <span className="block h-1.5 w-1.5 rounded-full bg-[var(--color-status-failed)]" />
        Save failed
      </span>
    );
  }
  if (isSaving) {
    return (
      <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-2.5 py-0.5 text-[11px] text-[var(--color-text-secondary)]">
        <span className="block h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-brand-blue)]" />
        Saving…
      </span>
    );
  }
  if (isDirty) {
    return (
      <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--color-status-pending)]/30 bg-[var(--color-status-pending)]/10 px-2.5 py-0.5 text-[11px] text-[var(--color-status-pending)]">
        <span className="block h-1.5 w-1.5 rounded-full bg-[var(--color-status-pending)]" />
        Unsaved
      </span>
    );
  }
  return (
    <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-2.5 py-0.5 text-[11px] text-[var(--color-text-tertiary)]">
      <span className="block h-1.5 w-1.5 rounded-full bg-[var(--color-brand-green)]" />
      Saved
    </span>
  );
}
