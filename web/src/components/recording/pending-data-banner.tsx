'use client';

import * as React from 'react';
import { Inbox } from 'lucide-react';

/**
 * Pending-data banner — "N unassigned readings" warning chip.
 *
 * Mirrors iOS `PendingDataBanner` (CertMateUnified/Sources/Views/
 * Recording/PendingDataBanner.swift). An "unassigned reading" is a
 * value Sonnet could not confidently match to a circuit or field —
 * surfaced here so the inspector can glance at the recording chrome and
 * realise they need to disambiguate before ending the session.
 *
 * The component is purely presentational; the count is tracked by the
 * recording context from extraction results (validation_alerts /
 * questions with `orphaned` classification) and passed in as a prop.
 */
export function PendingDataBanner({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      role="status"
      aria-live="polite"
      className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-status-limitation)]/20 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--color-status-limitation)] ring-1 ring-[var(--color-status-limitation)]/40"
    >
      <Inbox className="h-3 w-3" strokeWidth={2.5} aria-hidden />
      <span>
        {count} unassigned reading{count === 1 ? '' : 's'}
      </span>
    </span>
  );
}
