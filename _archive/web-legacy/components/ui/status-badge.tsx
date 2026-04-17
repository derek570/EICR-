'use client';

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const statusBadgeVariants = cva(
  [
    'inline-flex items-center justify-center rounded-full px-3 py-1',
    'text-[11px] font-bold uppercase tracking-wider leading-[1.2]',
    'whitespace-nowrap select-none',
  ].join(' '),
  {
    variants: {
      status: {
        green: 'bg-status-green/15 text-status-green border border-status-green/20',
        amber: 'bg-status-amber/15 text-status-amber border border-status-amber/20',
        red: 'bg-status-red/15 text-status-red border border-status-red/20',
        blue: 'bg-status-blue/15 text-status-blue border border-status-blue/20',
        satisfactory:
          'bg-status-satisfactory/15 text-status-satisfactory border border-status-satisfactory/20',
        unsatisfactory:
          'bg-status-unsatisfactory/15 text-status-unsatisfactory border border-status-unsatisfactory/20',
        c1: 'bg-status-c1/15 text-status-c1 border border-status-c1/20',
        c2: 'bg-status-c2/15 text-status-c2 border border-status-c2/20',
        c3: 'bg-status-c3/15 text-status-c3 border border-status-c3/20',
        fi: 'bg-status-fi/15 text-status-fi border border-status-fi/20',
        limitation:
          'bg-status-limitation/15 text-status-limitation border border-status-limitation/20',
        pending: 'bg-status-pending/15 text-status-pending border border-status-pending/20',
      },
    },
    defaultVariants: {
      status: 'blue',
    },
  }
);

export interface StatusBadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof statusBadgeVariants> {}

const StatusBadge = React.forwardRef<HTMLSpanElement, StatusBadgeProps>(
  ({ className, status, ...props }, ref) => {
    return <span ref={ref} className={cn(statusBadgeVariants({ status, className }))} {...props} />;
  }
);
StatusBadge.displayName = 'StatusBadge';

export { StatusBadge, statusBadgeVariants };
