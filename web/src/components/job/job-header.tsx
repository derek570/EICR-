'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ChevronLeft, MoreHorizontal } from 'lucide-react';
import { useJobContext } from '@/lib/job-context';
import { IconButton } from '@/components/ui/icon-button';

/**
 * iOS-style job detail header:
 *
 *    [ < Back ]         <address>                  [ ··· ]
 *
 * - Back button on the left (chevron + "Back" text), tinted brand blue.
 * - Centred title showing the job address (truncated on narrow screens).
 * - Overflow 3-dot menu button on the right — placeholder wired to a
 *   console handler until Phase 6 settings + delete actions land.
 *
 * Save-status indicator moves beneath the centred title as a small pill so
 * it remains visible without fighting the iOS header symmetry.
 */
export function JobHeader() {
  const router = useRouter();
  const { job, isDirty, isSaving } = useJobContext();

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
          style={{ maxWidth: 'calc(100% - 200px)' }}
        >
          {job.address || 'Untitled job'}
        </h1>

        {/* D8: 44×44 (was 36×36 — h-9 w-9). The surface variant preserves
         * the iOS filled-circle affordance; brand-blue text is added via
         * className since it's job-header-specific and not a shared variant. */}
        <IconButton
          variant="surface"
          aria-label="Job menu"
          onClick={() => {
            // Placeholder for the iOS header's 3-dot menu. Full set of
            // actions (rename, delete, export, etc.) lands in Phase 6.
            console.log('[job-header] overflow menu');
          }}
          className="ml-auto text-[var(--color-brand-blue)]"
        >
          <MoreHorizontal className="h-5 w-5" strokeWidth={2} aria-hidden />
        </IconButton>
      </div>

      <div className="flex justify-center pb-1">
        <SaveStatus isDirty={isDirty} isSaving={isSaving} />
      </div>
    </header>
  );
}

function SaveStatus({ isDirty, isSaving }: { isDirty: boolean; isSaving: boolean }) {
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
