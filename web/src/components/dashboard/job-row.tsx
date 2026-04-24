'use client';

import * as React from 'react';
import Link from 'next/link';
import { ChevronRight, CloudUpload, FileText, Trash2 } from 'lucide-react';
import type { Job } from '@/lib/types';
import { api } from '@/lib/api-client';
import { getUser } from '@/lib/auth';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

/**
 * Recent-jobs row matching the iOS dashboard:
 * - 3px vertical stripe on the LEFT (blue=EICR, green=EIC)
 * - File icon in matching cert colour
 * - Address title + cert-type suffix + relative date
 * - Optional "Pending sync" chip (Phase 7d) when this job has an
 *   offline mutation still queued in the outbox. Rendered BETWEEN
 *   the cert/date line and the status pill so it reads as "extra
 *   state" rather than competing with the primary status. Kept
 *   separate from the existing status pill so poisoned/failed
 *   network state can't be confused with the backend's
 *   pending/processing/done/failed job status.
 * - Amber PENDING / green DONE / red FAILED pill on the right
 * - Chevron right
 *
 * Phase 3 additions (iOS `DashboardView.swift:L133-L165` swipe-to-delete
 * + `L294-L308` delete-job alert):
 * - Touch swipe-left reveals a Delete button (position: absolute,
 *   slides the row left to expose the red trailing action).
 * - Right-click (desktop) opens a native context-menu entry via a
 *   small custom menu — keeps the gesture close to iOS's long-press
 *   fallback without requiring a native menu API.
 * - Both paths route through the shared `ConfirmDialog` so the
 *   destructive confirm obeys the design tokens.
 */

const STATUS_LABEL: Record<Job['status'], string> = {
  pending: 'PENDING',
  processing: 'IN PROGRESS',
  done: 'DONE',
  failed: 'FAILED',
};

const STATUS_PILL: Record<Job['status'], { bg: string; fg: string }> = {
  pending: { bg: 'rgba(255,159,10,0.18)', fg: '#ffb340' },
  processing: { bg: 'rgba(255,159,10,0.18)', fg: '#ffb340' },
  done: { bg: 'rgba(48,209,88,0.18)', fg: '#30d158' },
  failed: { bg: 'rgba(255,69,58,0.18)', fg: '#ff6b62' },
};

const SWIPE_THRESHOLD = 60; // px — row offset at which the delete action locks open

export function JobRow({
  job,
  pendingSync = false,
  onDeleted,
}: {
  job: Job;
  pendingSync?: boolean;
  /**
   * Notifies the parent that the backend DELETE landed so it can
   * remove the row from the dashboard list without a full refetch.
   * Optional — the Alerts page doesn't need it because the list is
   * re-derived from the next cache read.
   */
  onDeleted?: (jobId: string) => void;
}) {
  const cert = job.certificate_type ?? 'EICR';
  const accent = cert === 'EIC' ? 'var(--color-brand-green)' : 'var(--color-brand-blue)';
  const date = new Date(job.updated_at ?? job.created_at);
  const dateStr = date.toLocaleDateString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  const pill = STATUS_PILL[job.status];

  // --- Swipe / delete state ---------------------------------------
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  // `swipeX` is how far the row content is translated to the left.
  // 0 = closed. Negative values reveal the delete action on the
  // trailing edge.
  const [swipeX, setSwipeX] = React.useState(0);
  const pointerStart = React.useRef<{ x: number; y: number } | null>(null);
  const wasSwipeGesture = React.useRef(false);

  const closeSwipe = React.useCallback(() => {
    setSwipeX(0);
    wasSwipeGesture.current = false;
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Only track touch / pen; mouse swipes on desktop conflict with
    // the right-click menu and aren't a common gesture there.
    if (e.pointerType === 'mouse') return;
    pointerStart.current = { x: e.clientX, y: e.clientY };
    wasSwipeGesture.current = false;
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointerStart.current) return;
    const dx = e.clientX - pointerStart.current.x;
    const dy = e.clientY - pointerStart.current.y;
    // Horizontal-dominant gesture: > 8px horizontal AND < 12px
    // vertical drift. This keeps vertical page scrolling snappy.
    if (Math.abs(dx) > 8 && Math.abs(dy) < 12) {
      wasSwipeGesture.current = true;
      const next = Math.max(-120, Math.min(0, dx));
      setSwipeX(next);
    }
  };

  const onPointerUp = () => {
    if (pointerStart.current && wasSwipeGesture.current) {
      // Lock open past the threshold; otherwise snap closed.
      if (swipeX <= -SWIPE_THRESHOLD) {
        setSwipeX(-96); // visible delete action
      } else {
        setSwipeX(0);
      }
    }
    pointerStart.current = null;
  };

  // Click handler on the row: swallow the click when a swipe gesture
  // just finished so the underlying <Link> navigation doesn't fire
  // after the inspector's thumb releases at the end of a swipe.
  const onLinkClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (wasSwipeGesture.current || swipeX < 0) {
      e.preventDefault();
      // Reset the gesture flag so the next tap on the closed row
      // navigates as expected.
      wasSwipeGesture.current = false;
    }
  };

  // --- Right-click context menu (desktop) -------------------------
  const [menu, setMenu] = React.useState<{ x: number; y: number } | null>(null);
  const onContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    // Only on pointer-fine devices — touch long-press already
    // triggers a native contextmenu on iOS but we don't want that
    // to show our menu (we use swipe there). Heuristic: if there's
    // no parent pointer:fine match, fall through to the browser
    // default (harmless right-click on the link).
    const isMouse = typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches;
    if (!isMouse) return;
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  };

  // Close the context menu on any outside click.
  React.useEffect(() => {
    if (!menu) return;
    const onDoc = () => setMenu(null);
    document.addEventListener('click', onDoc);
    document.addEventListener('scroll', onDoc, { passive: true });
    return () => {
      document.removeEventListener('click', onDoc);
      document.removeEventListener('scroll', onDoc);
    };
  }, [menu]);

  // --- Actual delete call ------------------------------------------
  const handleDelete = React.useCallback(async () => {
    const user = getUser();
    if (!user) return;
    try {
      await api.deleteJob(user.id, job.id);
      onDeleted?.(job.id);
    } finally {
      setConfirmOpen(false);
      closeSwipe();
    }
  }, [job.id, onDeleted, closeSwipe]);

  return (
    <div
      className="relative overflow-hidden rounded-[14px]"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onContextMenu={onContextMenu}
    >
      {/* Trailing delete action revealed by swipe */}
      <button
        type="button"
        aria-label={`Delete job for ${job.address || 'this job'}`}
        onClick={() => setConfirmOpen(true)}
        className="absolute inset-y-0 right-0 flex w-24 items-center justify-center gap-1 bg-[var(--color-status-failed)] text-white"
        style={{ pointerEvents: swipeX < 0 ? 'auto' : 'none' }}
        tabIndex={swipeX < 0 ? 0 : -1}
      >
        <Trash2 className="h-4 w-4" strokeWidth={2.25} aria-hidden />
        <span className="text-[12px] font-semibold">Delete</span>
      </button>

      <Link
        href={`/job/${job.id}`}
        onClick={onLinkClick}
        className="group relative flex items-center gap-3 overflow-hidden rounded-[14px] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] py-3 pl-4 pr-3 transition hover:bg-[var(--color-surface-3)] focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)]"
        style={{
          transform: `translateX(${swipeX}px)`,
          transition: pointerStart.current ? 'none' : 'transform 160ms ease',
        }}
      >
        {/* Left colour stripe — 3px */}
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-[3px]"
          style={{ background: accent }}
        />

        {/* File icon in cert colour */}
        <span
          aria-hidden
          className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[8px]"
          style={{ background: `color-mix(in srgb, ${accent} 18%, transparent)`, color: accent }}
        >
          <FileText className="h-4 w-4" strokeWidth={2} />
        </span>

        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold text-[var(--color-text-primary)]">
            {job.address || 'Untitled job'}
          </p>
          <p className="mt-0.5 flex items-center gap-2 text-xs">
            <span className="font-semibold" style={{ color: accent }}>
              {cert}
            </span>
            <span className="text-[var(--color-text-tertiary)]">{dateStr}</span>
          </p>
        </div>

        {pendingSync ? (
          <span
            className="inline-flex flex-shrink-0 items-center gap-1 rounded-full border border-[var(--color-brand-blue)]/40 bg-[var(--color-brand-blue)]/15 px-2 py-0.5 text-[10px] font-semibold text-[var(--color-brand-blue)]"
            title="Edits saved locally — will sync when you're online"
            aria-label="Pending sync — edits saved locally"
          >
            <CloudUpload className="h-3 w-3" strokeWidth={2.25} aria-hidden />
            <span className="hidden sm:inline">Pending</span>
          </span>
        ) : null}
        <span
          className="flex-shrink-0 rounded-full px-2.5 py-0.5 text-[10px] font-bold tracking-[0.1em]"
          style={{ background: pill.bg, color: pill.fg }}
        >
          {STATUS_LABEL[job.status]}
        </span>
        <ChevronRight
          aria-hidden
          className="h-4 w-4 flex-shrink-0 text-[var(--color-text-tertiary)]"
          strokeWidth={2}
        />
      </Link>

      {menu ? (
        <div
          role="menu"
          className="fixed z-40 min-w-[140px] overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] shadow-xl"
          style={{ top: menu.y, left: menu.x }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation();
              setMenu(null);
              setConfirmOpen(true);
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-[var(--color-status-failed)] hover:bg-[var(--color-surface-3)]"
          >
            <Trash2 className="h-4 w-4" strokeWidth={2.25} aria-hidden />
            Delete job
          </button>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(v) => {
          setConfirmOpen(v);
          if (!v) closeSwipe();
        }}
        title="Delete job?"
        description={`Delete job for ${job.address || 'this job'}? This cannot be undone.`}
        confirmLabel="Delete"
        destructive
        onConfirm={handleDelete}
      />
    </div>
  );
}
