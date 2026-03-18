'use client';

import Link from 'next/link';
import { Loader2, Trash2, Copy, CloudOff, CheckSquare, Square, ChevronRight } from 'lucide-react';

import { Button } from '@/components/ui/button';

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

function certTypePill(type?: string) {
  if (!type) return null;
  const isEIC = type === 'EIC';
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ${
        isEIC ? 'bg-emerald-900/50 text-emerald-400' : 'bg-blue-900/50 text-blue-400'
      }`}
    >
      {type}
    </span>
  );
}

function statusPill(status?: string) {
  switch (status) {
    case 'done':
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-green-900/50 text-green-400">
          Complete
        </span>
      );
    case 'processing':
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-blue-900/50 text-blue-400">
          <Loader2 className="h-2.5 w-2.5 animate-spin" />
          Processing
        </span>
      );
    case 'failed':
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-red-900/50 text-red-400">
          Failed
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-muted text-muted-foreground">
          {status || 'Draft'}
        </span>
      );
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
        className={`flex items-center gap-3 px-4 py-3 rounded-lg bg-card border border-border hover:bg-accent/50 transition-colors cursor-pointer ${
          isSelected ? 'ring-2 ring-primary' : ''
        }`}
      >
        {/* Selection checkbox (only for done jobs) */}
        {job.status === 'done' && (
          <button
            onClick={(e) => onToggleSelection(e, job.id)}
            className="flex-shrink-0 text-muted-foreground hover:text-foreground"
            title={isSelected ? 'Deselect' : 'Select for bulk download'}
          >
            {isSelected ? (
              <CheckSquare className="h-4 w-4 text-primary" />
            ) : (
              <Square className="h-4 w-4" />
            )}
          </button>
        )}

        {/* Main content */}
        <div className="min-w-0 flex-1">
          <p className="font-medium text-sm truncate text-foreground">{address}</p>
          <div className="flex items-center gap-1.5 mt-1">
            {certTypePill(job.certificate_type)}
            {statusPill(job.status)}
            {job.isLocalDirty && (
              <span className="inline-flex items-center gap-1 text-[10px] text-amber-400">
                <CloudOff className="h-2.5 w-2.5" />
                Unsaved
              </span>
            )}
          </div>
        </div>

        {/* Right side: date + actions */}
        <div className="flex items-center gap-1 flex-shrink-0">
          {job.created_at && (
            <span className="text-xs text-muted-foreground mr-1 hidden sm:inline">
              {formatDate(job.created_at)}
            </span>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={(e) => onClone(e, job.id, address)}
            title="Clone job"
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={(e) => onDelete(e, job.id, address)}
            disabled={isDeleting}
            title="Delete job"
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
