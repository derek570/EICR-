import Link from 'next/link';
import type { Job } from '@/lib/types';

const STATUS_LABEL: Record<Job['status'], string> = {
  pending: 'Pending',
  processing: 'In progress',
  done: 'Complete',
  failed: 'Failed',
};

const STATUS_COLOR: Record<Job['status'], string> = {
  pending: 'var(--color-status-pending)',
  processing: 'var(--color-status-processing)',
  done: 'var(--color-status-done)',
  failed: 'var(--color-status-failed)',
};

export function JobRow({ job }: { job: Job }) {
  const date = new Date(job.updated_at ?? job.created_at);
  const relative = relativeTime(date);

  return (
    <Link
      href={`/job/${job.id}`}
      className="flex items-center justify-between gap-4 rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-4 py-3 transition hover:bg-[var(--color-surface-3)] focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)]"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-semibold text-[var(--color-text-primary)]">
          {job.address || 'Untitled job'}
        </p>
        <p className="mt-0.5 text-xs text-[var(--color-text-tertiary)]">
          {job.certificate_type ?? 'EICR'} · {relative}
        </p>
      </div>
      <span
        className="flex shrink-0 items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium"
        style={{
          borderColor: 'var(--color-border-subtle)',
          color: STATUS_COLOR[job.status],
        }}
      >
        <span
          className="block h-2 w-2 rounded-full"
          style={{ background: STATUS_COLOR[job.status] }}
          aria-hidden
        />
        {STATUS_LABEL[job.status]}
      </span>
    </Link>
  );
}

function relativeTime(date: Date) {
  const now = Date.now();
  const diff = now - date.getTime();
  const m = 60_000;
  const h = 60 * m;
  const d = 24 * h;
  if (diff < m) return 'just now';
  if (diff < h) return `${Math.floor(diff / m)}m ago`;
  if (diff < d) return `${Math.floor(diff / h)}h ago`;
  if (diff < 7 * d) return `${Math.floor(diff / d)}d ago`;
  return date.toLocaleDateString();
}
