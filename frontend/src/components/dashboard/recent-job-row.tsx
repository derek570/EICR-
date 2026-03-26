'use client';

import { useRouter } from 'next/navigation';
import { StatusBadge } from '@/components/ui/status-badge';

function statusToVariant(status: string) {
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

interface RecentJobRowJob {
  id: string;
  address?: string;
  status?: string;
  certificate_type?: string;
  created_at?: string;
}

interface RecentJobRowProps {
  job: RecentJobRowJob;
  index: number;
}

export function RecentJobRow({ job, index }: RecentJobRowProps) {
  const router = useRouter();
  const date = job.created_at ? new Date(job.created_at) : null;
  const formattedDate = date
    ? date.toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : '';

  return (
    <button
      type="button"
      onClick={() => router.push(`/job/${job.id}`)}
      className="group flex items-center w-full text-left rounded-[14px] bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.06)] overflow-hidden transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_6px_20px_rgba(0,0,0,0.14)] hover:bg-[rgba(255,255,255,0.07)] active:animate-spring-press animate-[stagger-in_0.4s_ease-out_both]"
      style={{ animationDelay: `${index * 60}ms` }}
    >
      {/* Leading gradient accent bar */}
      <div className="w-1 self-stretch bg-gradient-to-b from-brand-blue to-brand-green flex-shrink-0 rounded-l-[14px]" />

      <div className="flex items-center justify-between flex-1 px-4 py-3.5 min-w-0">
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="text-sm font-medium text-foreground truncate">
            {job.address || 'Untitled'}
          </span>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-medium text-brand-blue">{job.certificate_type || 'EICR'}</span>
            <span className="text-white/20">&middot;</span>
            <span>{formattedDate}</span>
          </div>
        </div>

        <StatusBadge
          status={statusToVariant(job.status || 'pending')}
          className="ml-3 flex-shrink-0"
        >
          {job.status || 'Draft'}
        </StatusBadge>
      </div>
    </button>
  );
}
