'use client';

import Link from 'next/link';
import { Loader2, Trash2, Copy, CloudOff, CheckSquare, Square, ChevronRight } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';

export interface DashboardJob {
  id: string;
  address?: string;
  status?: string;
  certificate_type?: string;
  created_at?: string;
  isLocalDirty?: boolean;
}

interface JobCardProps {
  job: DashboardJob;
  isSelected: boolean;
  deletingJobId: string | null;
  onToggleSelection: (e: React.MouseEvent, jobId: string) => void;
  onClone: (e: React.MouseEvent, jobId: string, address: string) => void;
  onDelete: (e: React.MouseEvent, jobId: string, address: string) => void;
}

function statusToVariant(status?: string) {
  switch (status) {
    case 'done':
      return 'green' as const;
    case 'processing':
      return 'blue' as const;
    case 'pending':
      return 'amber' as const;
    case 'failed':
      return 'red' as const;
    default:
      return 'pending' as const;
  }
}

function statusLabel(status?: string) {
  switch (status) {
    case 'done':
      return 'Complete';
    case 'processing':
      return 'Processing';
    case 'failed':
      return 'Failed';
    default:
      return status || 'Draft';
  }
}

function formatDate(dateStr?: string): string {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function JobCard({
  job,
  isSelected,
  deletingJobId,
  onToggleSelection,
  onClone,
  onDelete,
}: JobCardProps) {
  const address = job.address || 'No address';
  const isDeleting = deletingJobId === job.id;

  return (
    <Link href={`/job/${job.id}`}>
      <div
        className={`group flex items-center gap-3 rounded-[14px] bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.06)] overflow-hidden transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_6px_20px_rgba(0,0,0,0.14)] hover:bg-[rgba(255,255,255,0.07)] cursor-pointer ${
          isSelected ? 'ring-2 ring-brand-blue shadow-[0_0_12px_rgba(0,102,255,0.2)]' : ''
        }`}
      >
        {/* Leading gradient accent bar */}
        <div className="w-1 self-stretch bg-gradient-to-b from-brand-blue to-brand-green flex-shrink-0 rounded-l-[14px]" />

        {/* Selection checkbox (only for done jobs) */}
        {job.status === 'done' && (
          <button
            onClick={(e) => onToggleSelection(e, job.id)}
            className="flex-shrink-0 text-muted-foreground hover:text-foreground ml-2 min-h-[44px] min-w-[44px] flex items-center justify-center"
            title={isSelected ? 'Deselect' : 'Select for bulk download'}
            aria-label={isSelected ? 'Deselect job' : 'Select job for bulk download'}
          >
            {isSelected ? (
              <CheckSquare className="h-4 w-4 text-brand-blue" />
            ) : (
              <Square className="h-4 w-4" />
            )}
          </button>
        )}

        {/* Main content */}
        <div className="min-w-0 flex-1 py-3.5 pr-0 pl-1">
          <p className="font-medium text-sm truncate text-foreground">{address}</p>
          <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
            <span className="font-medium text-brand-blue">{job.certificate_type || 'EICR'}</span>
            <span className="text-white/20">&middot;</span>
            {job.created_at && <span>{formatDate(job.created_at)}</span>}
            {job.isLocalDirty && (
              <>
                <span className="text-white/20">&middot;</span>
                <span className="inline-flex items-center gap-1 text-amber-400">
                  <CloudOff className="h-2.5 w-2.5" />
                  Unsaved
                </span>
              </>
            )}
          </div>
        </div>

        {/* Right side: status + actions */}
        <div className="flex items-center gap-1.5 flex-shrink-0 pr-3">
          <StatusBadge status={statusToVariant(job.status)} className="flex-shrink-0">
            {statusLabel(job.status)}
          </StatusBadge>
          <Button
            variant="glass-ghost"
            size="icon-sm"
            onClick={(e) => onClone(e, job.id, address)}
            title="Clone job"
            aria-label="Clone job"
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="glass-ghost"
            size="icon-sm"
            onClick={(e) => onDelete(e, job.id, address)}
            disabled={isDeleting}
            title="Delete job"
            aria-label="Delete job"
          >
            {isDeleting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-red-400" />
            )}
          </Button>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </div>
      </div>
    </Link>
  );
}
