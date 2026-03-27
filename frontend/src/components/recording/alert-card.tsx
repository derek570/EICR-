'use client';

import { AlertTriangle, HelpCircle, X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface AlertQuestion {
  field: string;
  circuit?: number;
  question: string;
  type: 'orphaned' | 'out_of_range' | 'unclear';
  value?: string;
}

interface AlertCardProps {
  question: AlertQuestion | null;
  onDismiss: () => void;
}

function severityStyles(type: string) {
  switch (type) {
    case 'out_of_range':
      return {
        border: 'border-status-amber/30',
        glow: 'shadow-[0_4px_20px_rgba(255,179,0,0.15)]',
        iconBg: 'bg-status-amber/15',
        iconColor: 'text-status-amber',
      };
    case 'orphaned':
      return {
        border: 'border-status-red/30',
        glow: 'shadow-[0_4px_20px_rgba(255,82,82,0.15)]',
        iconBg: 'bg-status-red/15',
        iconColor: 'text-status-red',
      };
    default:
      return {
        border: 'border-status-blue/30',
        glow: 'shadow-[0_4px_20px_rgba(41,121,255,0.15)]',
        iconBg: 'bg-status-blue/15',
        iconColor: 'text-status-blue',
      };
  }
}

export function AlertCard({ question, onDismiss }: AlertCardProps) {
  if (!question) return null;

  const styles = severityStyles(question.type);
  const Icon = question.type === 'out_of_range' ? AlertTriangle : HelpCircle;

  return (
    <div
      role="alert"
      aria-live="polite"
      className={cn(
        'mx-4 mb-2 glass-card p-3 transition-all animate-in slide-in-from-bottom-2 duration-300',
        styles.border,
        styles.glow
      )}
    >
      <div className="flex items-start gap-3">
        <div
          className={cn(
            'flex items-center justify-center h-8 w-8 rounded-full shrink-0',
            styles.iconBg
          )}
        >
          <Icon className={cn('h-4 w-4', styles.iconColor)} />
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground">{question.question}</p>
          {(question.value || question.field) && (
            <p className="text-xs mt-1">
              {question.value && <span className="text-foreground/70">{question.value}</span>}
              {question.value && question.field && (
                <span className="text-muted-foreground"> &middot; </span>
              )}
              {question.field && (
                <span className="text-muted-foreground">
                  {question.field}
                  {question.circuit != null && ` (circuit ${question.circuit})`}
                </span>
              )}
            </p>
          )}
        </div>

        <button
          onClick={onDismiss}
          className="text-muted-foreground hover:text-foreground text-sm transition-colors shrink-0 min-w-[44px] min-h-[44px] flex items-center justify-center -mr-2"
          title="Dismiss"
          aria-label="Dismiss alert"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
