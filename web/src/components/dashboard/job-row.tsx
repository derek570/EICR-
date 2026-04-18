import Link from 'next/link';
import { ChevronRight, CloudUpload, FileText } from 'lucide-react';
import type { Job } from '@/lib/types';

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

export function JobRow({ job, pendingSync = false }: { job: Job; pendingSync?: boolean }) {
  const cert = job.certificate_type ?? 'EICR';
  const accent = cert === 'EIC' ? 'var(--color-brand-green)' : 'var(--color-brand-blue)';
  const date = new Date(job.updated_at ?? job.created_at);
  const dateStr = date.toLocaleDateString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  const pill = STATUS_PILL[job.status];

  return (
    <Link
      href={`/job/${job.id}`}
      className="group relative flex items-center gap-3 overflow-hidden rounded-[14px] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] py-3 pl-4 pr-3 transition hover:bg-[var(--color-surface-3)] focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)]"
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
  );
}
