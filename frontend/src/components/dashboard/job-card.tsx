'use client';

import Link from 'next/link';
import { Loader2, Trash2, Copy, CloudOff, CheckSquare, Square } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

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

function statusBadge(status?: string) {
  switch (status) {
    case 'done':
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-900/50 text-green-400">
          Complete
        </span>
      );
    case 'processing':
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-900/50 text-blue-400">
          <Loader2 className="h-3 w-3 animate-spin" />
          Processing
        </span>
      );
    case 'failed':
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-900/50 text-red-400">
          Failed
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-muted text-muted-foreground">
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
      <Card
        className={`hover:shadow-md transition-shadow cursor-pointer ${
          isSelected ? 'ring-2 ring-primary' : ''
        }`}
      >
        <CardContent className="py-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <p className="font-medium truncate">{address}</p>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                {statusBadge(job.status)}
                {job.certificate_type && (
                  <span className="text-xs text-muted-foreground">{job.certificate_type}</span>
                )}
                {job.isLocalDirty && (
                  <span className="inline-flex items-center gap-1 text-xs text-amber-600">
                    <CloudOff className="h-3 w-3" />
                    Unsaved
                  </span>
                )}
              </div>
              {job.created_at && (
                <p className="text-xs text-muted-foreground mt-1">{formatDate(job.created_at)}</p>
              )}
            </div>

            {/* Actions */}
            <div className="flex items-center gap-1 flex-shrink-0">
              {job.status === 'done' && (
                <button
                  onClick={(e) => onToggleSelection(e, job.id)}
                  className="p-1 text-muted-foreground hover:text-foreground"
                  title={isSelected ? 'Deselect' : 'Select for bulk download'}
                >
                  {isSelected ? (
                    <CheckSquare className="h-4 w-4 text-primary" />
                  ) : (
                    <Square className="h-4 w-4" />
                  )}
                </button>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={(e) => onClone(e, job.id, address)}
                title="Clone job"
              >
                <Copy className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={(e) => onDelete(e, job.id, address)}
                disabled={isDeleting}
                title="Delete job"
              >
                {isDeleting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4 text-muted-foreground hover:text-red-600" />
                )}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
