'use client';

import { useJobContext } from '@/lib/job-context';

/**
 * Per-job header bar. Shows address + certificate type pill + save status.
 * Lives inside the AppShell's top nav on desktop, stacks beneath it on mobile.
 */
export function JobHeader() {
  const { job, certificateType, isDirty, isSaving } = useJobContext();
  const created = new Date(job.created_at);
  const createdLabel = Number.isNaN(created.getTime())
    ? ''
    : created.toLocaleDateString(undefined, {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      });

  return (
    <header className="flex flex-col gap-2 border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-0)]/80 px-4 py-3 backdrop-blur md:px-6 md:py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]">
            {certificateType} · {createdLabel}
          </p>
          <h1 className="mt-0.5 truncate text-[18px] font-semibold text-[var(--color-text-primary)] md:text-[22px]">
            {job.address || 'Untitled job'}
          </h1>
        </div>
        <SaveStatus isDirty={isDirty} isSaving={isSaving} />
      </div>
    </header>
  );
}

function SaveStatus({ isDirty, isSaving }: { isDirty: boolean; isSaving: boolean }) {
  if (isSaving) {
    return (
      <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-3 py-1 text-xs text-[var(--color-text-secondary)]">
        <span className="block h-2 w-2 animate-pulse rounded-full bg-[var(--color-brand-blue)]" />
        Saving…
      </span>
    );
  }
  if (isDirty) {
    return (
      <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--color-status-pending)]/30 bg-[var(--color-status-pending)]/10 px-3 py-1 text-xs text-[var(--color-status-pending)]">
        <span className="block h-2 w-2 rounded-full bg-[var(--color-status-pending)]" />
        Unsaved
      </span>
    );
  }
  return (
    <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-3 py-1 text-xs text-[var(--color-text-tertiary)]">
      <span className="block h-2 w-2 rounded-full bg-[var(--color-brand-green)]" />
      Saved
    </span>
  );
}
