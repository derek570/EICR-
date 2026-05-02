'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ChevronLeft, MoreVertical, SlidersHorizontal, Check, Compass } from 'lucide-react';
import { useJobContext } from '@/lib/job-context';
import { ApplyDefaultsSheet } from '@/components/defaults/apply-defaults-sheet';
import { applyPresetToJob } from '@/lib/defaults/service';

/**
 * iOS-style job detail header:
 *
 *    [ < Back ]         <address>                            [ ⋯ ]
 *
 * - Back button on the left (chevron + "Back" text), tinted brand blue.
 * - Centred title showing the job address (truncated on narrow screens).
 * - 3-dot overflow menu on the right (Phase C parity port of iOS
 *   JobDetailView.swift's toolbar menu): Edit Default Values, Apply
 *   Defaults to Job, Guided Tour.
 *
 * Save-status indicator sits beneath the centred title as a small pill
 * so it remains visible without fighting the iOS header symmetry. Now
 * driven by the real save pipeline in `JobProvider` (was hardcoded to
 * `false` pre-deploy).
 */
export function JobHeader() {
  const router = useRouter();
  const { job, isDirty, isSaving, saveError, updateJob } = useJobContext();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [applyOpen, setApplyOpen] = React.useState(false);

  // Click-outside dismissal — iOS dismisses the toolbar menu on any
  // tap outside the popover. Using a click listener captured at the
  // document level so taps on the buttons inside still bubble first.
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [menuOpen]);

  const onEditDefaults = () => {
    setMenuOpen(false);
    router.push('/settings/defaults');
  };
  const onApplyDefaults = () => {
    setMenuOpen(false);
    setApplyOpen(true);
  };
  const onGuidedTour = () => {
    setMenuOpen(false);
    // Tour kick-off — Phase D will fully rewire this; for now we drop
    // the marker that resets `cm-tour-job-seen` so the existing
    // useTour hook re-runs on next mount.
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem('cm-tour-job-seen');
      // Reload so any tour root that mounts on the job layout reads
      // the cleared flag and starts. Phase D will replace this with
      // a controlled tour controller.
      window.location.reload();
    }
  };

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

        {/* 3-dot menu — Phase C parity port (iOS JobDetailView toolbar).
            Anchored right; popover absolute-positioned beneath. */}
        <div ref={menuRef} className="ml-auto relative">
          <button
            type="button"
            aria-label="Job options"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-md)] text-[var(--color-text-primary)] transition hover:bg-[var(--color-surface-2)] focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)]"
          >
            <MoreVertical className="h-5 w-5" aria-hidden />
          </button>
          {menuOpen ? (
            <div
              role="menu"
              className="absolute right-0 top-full z-30 mt-1 w-56 overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] shadow-[0_8px_24px_rgba(0,0,0,0.4)]"
            >
              <MenuItem icon={<SlidersHorizontal className="h-4 w-4" />} onClick={onEditDefaults}>
                Edit Default Values
              </MenuItem>
              <MenuItem icon={<Check className="h-4 w-4" />} onClick={onApplyDefaults}>
                Apply Defaults to Job
              </MenuItem>
              <MenuItem icon={<Compass className="h-4 w-4" />} onClick={onGuidedTour}>
                Guided Tour
              </MenuItem>
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex justify-center pb-1">
        <SaveStatus isDirty={isDirty} isSaving={isSaving} saveError={saveError} />
      </div>

      {/* Apply Defaults sheet — same component the recording bar uses. */}
      <ApplyDefaultsSheet
        open={applyOpen}
        certificateType={job.certificate_type ?? 'EICR'}
        onClose={() => setApplyOpen(false)}
        onApply={(preset) => {
          const patch = applyPresetToJob(preset, job);
          if (Object.keys(patch).length > 0) {
            updateJob(patch);
          }
        }}
      />
    </header>
  );
}

function MenuItem({
  icon,
  onClick,
  children,
}: {
  icon: React.ReactNode;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-[14px] text-[var(--color-text-primary)] transition hover:bg-[var(--color-surface-3)] focus-visible:bg-[var(--color-surface-3)] focus-visible:outline-none"
    >
      <span className="text-[var(--color-brand-blue)]" aria-hidden>
        {icon}
      </span>
      <span className="flex-1">{children}</span>
    </button>
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
