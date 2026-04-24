'use client';

import * as React from 'react';
import { Loader2 } from 'lucide-react';

/**
 * Processing badge — "Processing (N)" chip visible while Sonnet is
 * crunching one or more in-flight extractions.
 *
 * Mirrors iOS `ProcessingBadgeView` (CertMateUnified/Sources/Views/
 * Recording/ProcessingBadgeView.swift). The count is the number of
 * transcripts sent to Sonnet that haven't yet returned an extraction
 * result — surfaces the latency the inspector is paying so they don't
 * think the app has hung during a long turn.
 *
 * Hidden when the count is zero so the recording chrome doesn't carry
 * an empty badge between turns.
 */
export function ProcessingBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      role="status"
      aria-live="polite"
      className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-status-processing)]/90 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.07em] text-white shadow-[0_2px_10px_rgba(0,0,0,0.3)]"
    >
      <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2.5} aria-hidden />
      <span>Processing{count > 1 ? ` (${count})` : ''}</span>
    </span>
  );
}
