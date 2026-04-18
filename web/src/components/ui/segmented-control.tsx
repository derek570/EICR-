'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * SegmentedControl — the row of PASS / FAIL / LIM / N/A pill buttons used
 * across iOS inspection + circuits screens.
 *
 * Selected segment is fully filled with a semantic colour (green/red/amber/gray);
 * unselected segments render as a dark-surface outlined pill with white text.
 *
 * Built as a controlled component so callers pass `value` + `onChange` and we
 * keep it dumb. Accepts an arbitrary list of options so the same primitive
 * works for { PASS/FAIL/LIM/NA }, { YES/NO }, { IMP/ADD/SWA/PVC } etc.
 */
export type SegmentVariant = 'pass' | 'fail' | 'lim' | 'neutral' | 'info';

export type SegmentOption<T extends string = string> = {
  value: T;
  label: string;
  variant?: SegmentVariant;
};

const VARIANT_FILL: Record<SegmentVariant, string> = {
  pass: 'var(--color-status-done)',
  fail: 'var(--color-status-failed)',
  lim: 'var(--color-status-processing)',
  neutral: 'var(--color-text-tertiary)',
  info: 'var(--color-brand-blue)',
};

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  'aria-label': ariaLabel,
  className,
}: {
  options: SegmentOption<T>[];
  value: T | null;
  onChange: (next: T) => void;
  'aria-label'?: string;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        'flex w-full items-center gap-1.5 rounded-full bg-[var(--color-surface-1)] p-1',
        className
      )}
    >
      {options.map((opt) => {
        const isSelected = value === opt.value;
        const fill = VARIANT_FILL[opt.variant ?? 'info'];
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={isSelected}
            onClick={() => onChange(opt.value)}
            className={cn(
              'flex-1 rounded-full px-3 py-2 text-[13px] font-semibold transition active:scale-[0.98]',
              isSelected ? 'text-white shadow-sm' : 'text-[var(--color-text-secondary)]'
            )}
            style={{
              background: isSelected ? fill : 'transparent',
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
