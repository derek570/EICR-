import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * SkeletonRow — shimmer placeholder row for loading states.
 *
 * Pairs the existing `.cm-shimmer` keyframes (globals.css L261) with a
 * darker base bar so content-shaped placeholders read as "loading" rather
 * than "empty". iOS parity: `cmSkeletonShimmer` modifier in
 * CertMateDesign.swift L1129-L1202.
 *
 * Renders `lines` stacked bars (default 1) with slightly varied widths so
 * stacked rows don't read as a solid block. Respects
 * `prefers-reduced-motion` via the global reduce rule — the shimmer sweep
 * flattens to a static bar but the redacted shape remains.
 */
export function SkeletonRow({
  lines = 1,
  className,
  'aria-label': ariaLabel = 'Loading',
}: {
  lines?: number;
  className?: string;
  'aria-label'?: string;
}) {
  const safeLines = Math.max(1, Math.floor(lines));
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={ariaLabel}
      aria-busy="true"
      className={cn('flex flex-col gap-2', className)}
    >
      {Array.from({ length: safeLines }).map((_, idx) => {
        const widthPct = idx === safeLines - 1 && safeLines > 1 ? 70 : 100;
        return (
          <span
            key={idx}
            aria-hidden
            className="cm-shimmer block h-3 rounded-full bg-[var(--color-surface-3)]"
            style={{ width: `${widthPct}%` }}
          />
        );
      })}
    </div>
  );
}
