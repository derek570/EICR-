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

function severityStyles(severity: string): {
  bg: string;
  border: string;
  icon: string;
  iconColor: string;
} {
  switch (severity) {
    case 'error':
      return {
        bg: 'bg-red-50',
        border: 'border-red-200',
        icon: '\u26D4',
        iconColor: 'text-red-600',
      };
    case 'warning':
      return {
        bg: 'bg-amber-50',
        border: 'border-amber-200',
        icon: '\u26A0\uFE0F',
        iconColor: 'text-amber-600',
      };
    default:
      return {
        bg: 'bg-blue-50',
        border: 'border-blue-200',
        icon: '\u2139\uFE0F',
        iconColor: 'text-blue-600',
      };
  }
}

export function AlertCard({ alert, queueCount, onAccept, onReject, onDismiss }: AlertCardProps) {
  const styles = severityStyles(alert.severity);

  return (
    <div className={cn('rounded-lg border p-4 shadow-sm transition-all', styles.bg, styles.border)}>
      <div className="flex items-start gap-3">
        {/* Icon */}
        <span className={cn('text-lg', styles.iconColor)}>{styles.icon}</span>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-900">{alert.message}</p>
          {alert.suggestedAction && (
            <p className="mt-1 text-xs text-gray-600">Suggested: {alert.suggestedAction}</p>
          )}
        </div>

        {/* Dismiss */}
        <button
          onClick={onDismiss}
          className="text-gray-400 hover:text-gray-600 text-sm"
          title="Dismiss"
        >
          x
        </button>
      </div>

      {/* Action buttons */}
      <div className="mt-3 flex items-center justify-between">
        <div className="flex gap-2">
          <button
            onClick={onAccept}
            className="rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700"
          >
            Accept
          </button>
          <button
            onClick={onReject}
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            Reject
          </button>
        </div>

        {queueCount > 0 && <span className="text-xs text-gray-500">+{queueCount} more</span>}
      </div>
    </div>
  );
}
