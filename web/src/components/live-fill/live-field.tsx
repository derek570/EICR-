'use client';

import * as React from 'react';
import { useIsFieldRecent } from '@/lib/recording/live-fill-state';
import { cn } from '@/lib/utils';

/**
 * LiveField — a label + value cell that flashes brand-blue when its
 * key is marked recent in the LiveFillStore.
 *
 * Mirrors iOS `LiveField` (LiveFillView.swift:804-856):
 *   - At rest:     transparent background.
 *   - On flash:    brand-blue @ 0.15 alpha background, with a 2s ease-out
 *                  transition back to transparent.
 *   - Empty value: renders an em-dash so the cell still occupies space
 *                  (preserves spatial memory — iOS parity point #4 in the
 *                  handoff doc).
 *
 * Implementation is CSS-only: toggling `data-recent="true|false"` re-
 * triggers the `transition: background-color 2s ease-out` every time
 * the key flips from stale→fresh. React's diffing handles the re-render.
 *
 * Reduced motion: a 200ms fade is still used (not instant) so the
 * inspector can still visually catch that the field was filled, just
 * without the slow animation.
 */
export function LiveField({
  fieldKey,
  label,
  value,
  className,
  monospace,
}: {
  /** Dot-path key used by the LiveFillStore (e.g. `supply.ze`). */
  fieldKey: string;
  label: string;
  value: string | number | null | undefined;
  className?: string;
  /** Use tabular-nums + monospace for values that benefit from column
   *  alignment (Ze, PFC, Zs readings, etc.). */
  monospace?: boolean;
}) {
  const recent = useIsFieldRecent(fieldKey);
  const display =
    value === null || value === undefined || (typeof value === 'string' && !value.trim())
      ? '—'
      : String(value);
  const isEmpty = display === '—';

  return (
    <div
      data-recent={recent ? 'true' : 'false'}
      className={cn(
        'cm-live-field flex flex-col gap-0.5 rounded-[var(--radius-sm)] px-2 py-1.5',
        className
      )}
    >
      <span className="text-[11px] font-medium uppercase tracking-[0.05em] text-[var(--color-text-tertiary)]">
        {label}
      </span>
      <span
        className={cn(
          'text-[14px] leading-snug',
          isEmpty ? 'text-[var(--color-text-tertiary)]' : 'text-[var(--color-text-primary)]',
          monospace && 'font-mono tabular-nums'
        )}
      >
        {display}
      </span>
    </div>
  );
}

/**
 * LiveFieldWide — full-width variant for long strings (addresses,
 * observation descriptions, remedial actions). Same recency behaviour,
 * different layout so the text can wrap onto multiple lines without
 * breaking the card grid.
 */
export function LiveFieldWide({
  fieldKey,
  label,
  value,
  className,
}: {
  fieldKey: string;
  label: string;
  value: string | number | null | undefined;
  className?: string;
}) {
  const recent = useIsFieldRecent(fieldKey);
  const display =
    value === null || value === undefined || (typeof value === 'string' && !value.trim())
      ? '—'
      : String(value);
  const isEmpty = display === '—';

  return (
    <div
      data-recent={recent ? 'true' : 'false'}
      className={cn(
        'cm-live-field flex flex-col gap-0.5 rounded-[var(--radius-sm)] px-2 py-1.5',
        className
      )}
    >
      <span className="text-[11px] font-medium uppercase tracking-[0.05em] text-[var(--color-text-tertiary)]">
        {label}
      </span>
      <span
        className={cn(
          'whitespace-pre-wrap break-words text-[14px] leading-snug',
          isEmpty ? 'text-[var(--color-text-tertiary)]' : 'text-[var(--color-text-primary)]'
        )}
      >
        {display}
      </span>
    </div>
  );
}
