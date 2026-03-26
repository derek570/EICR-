'use client';

import { cn } from '@/lib/utils';
import type { ValidationAlert } from '@/lib/types';

interface AlertCardProps {
  alert: ValidationAlert;
  queueCount: number;
  onAccept: () => void;
  onReject: () => void;
  onDismiss: () => void;
}

function severityStyles(severity: string) {
  switch (severity) {
    case 'error':
      return {
        border: 'border-status-red/30',
        glow: 'shadow-[0_4px_20px_rgba(255,82,82,0.15)]',
        icon: '\u26D4',
        iconBg: 'bg-status-red/15',
        iconColor: 'text-status-red',
        acceptBg: 'bg-status-red hover:bg-status-red/80',
      };
    case 'warning':
      return {
        border: 'border-status-amber/30',
        glow: 'shadow-[0_4px_20px_rgba(255,179,0,0.15)]',
        icon: '\u26A0\uFE0F',
        iconBg: 'bg-status-amber/15',
        iconColor: 'text-status-amber',
        acceptBg: 'bg-status-amber hover:bg-status-amber/80',
      };
    default:
      return {
        border: 'border-status-blue/30',
        glow: 'shadow-[0_4px_20px_rgba(41,121,255,0.15)]',
        icon: '\u2139\uFE0F',
        iconBg: 'bg-status-blue/15',
        iconColor: 'text-status-blue',
        acceptBg: 'bg-status-blue hover:bg-status-blue/80',
      };
  }
}

export function AlertCard({ alert, queueCount, onAccept, onReject, onDismiss }: AlertCardProps) {
  const styles = severityStyles(alert.severity);

  return (
    <div className={cn('glass-card p-4 transition-all', styles.border, styles.glow)}>
      <div className="flex items-start gap-3">
        {/* Icon */}
        <div
          className={cn(
            'flex items-center justify-center h-8 w-8 rounded-full shrink-0',
            styles.iconBg
          )}
        >
          <span className={cn('text-base', styles.iconColor)}>{styles.icon}</span>
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground">{alert.message}</p>
          {alert.suggestedAction && (
            <p className="mt-1 text-xs text-muted-foreground">Suggested: {alert.suggestedAction}</p>
          )}
        </div>

        {/* Dismiss */}
        <button
          onClick={onDismiss}
          className="text-muted-foreground hover:text-foreground text-sm transition-colors"
          title="Dismiss"
          aria-label="Dismiss alert"
        >
          &times;
        </button>
      </div>

      {/* Action buttons */}
      <div className="mt-3 flex items-center justify-between">
        <div className="flex gap-2">
          <button
            onClick={onAccept}
            className={cn(
              'rounded-full px-4 py-1.5 text-xs font-medium text-white transition-colors',
              styles.acceptBg
            )}
          >
            Accept
          </button>
          <button
            onClick={onReject}
            className="rounded-full border border-white/10 bg-L2 px-4 py-1.5 text-xs font-medium text-foreground hover:bg-L3 transition-colors"
          >
            Reject
          </button>
        </div>

        {queueCount > 0 && (
          <span className="text-xs text-muted-foreground">+{queueCount} more</span>
        )}
      </div>
    </div>
  );
}
