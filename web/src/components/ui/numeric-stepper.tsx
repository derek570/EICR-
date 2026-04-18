'use client';

import * as React from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { FloatingLabelInput } from './floating-label-input';

/**
 * NumericStepper — FloatingLabelInput with up/down chevrons on the right.
 * Used for circuit currents (In, Ib), cable sizes, number of circuits etc.
 *
 * Keeps numeric semantics (inputMode="decimal", optional min/max/step) but
 * lets the user step by `step` (default 1) via the chevron buttons. Values
 * are emitted as numbers to the parent via `onValueChange`; raw text changes
 * still fire onChange so callers can use this inside react-hook-form.
 */
export type NumericStepperProps = {
  label: string;
  value: number | '';
  onValueChange: (next: number | '') => void;
  step?: number;
  min?: number;
  max?: number;
  hint?: string;
  unit?: string;
  inputMode?: 'numeric' | 'decimal';
  placeholder?: string;
};

export function NumericStepper({
  label,
  value,
  onValueChange,
  step = 1,
  min,
  max,
  hint,
  unit,
  inputMode = 'decimal',
  placeholder,
}: NumericStepperProps) {
  const commit = (n: number) => {
    if (min !== undefined && n < min) n = min;
    if (max !== undefined && n > max) n = max;
    onValueChange(n);
  };

  return (
    <FloatingLabelInput
      label={label}
      inputMode={inputMode}
      placeholder={placeholder}
      value={value === '' ? '' : String(value)}
      onChange={(e) => {
        const raw = e.target.value.trim();
        if (raw === '') return onValueChange('');
        const n = Number(raw);
        if (Number.isNaN(n)) return;
        onValueChange(n);
      }}
      hint={hint}
      trailing={
        <div className="flex items-center gap-1">
          {unit ? (
            <span className="mr-1 rounded-full bg-[var(--color-surface-2)] px-2 py-0.5 text-[11px] font-semibold text-[var(--color-text-secondary)]">
              {unit}
            </span>
          ) : null}
          <div className="flex flex-col">
            <button
              type="button"
              aria-label={`Increase ${label}`}
              onClick={() => commit((value === '' ? 0 : Number(value)) + step)}
              className={cn(
                'flex h-4 w-5 items-center justify-center rounded-t-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-3)] active:bg-[var(--color-surface-4)]'
              )}
            >
              <ChevronUp className="h-3 w-3" aria-hidden />
            </button>
            <button
              type="button"
              aria-label={`Decrease ${label}`}
              onClick={() => commit((value === '' ? 0 : Number(value)) - step)}
              className={cn(
                'flex h-4 w-5 items-center justify-center rounded-b-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-3)] active:bg-[var(--color-surface-4)]'
              )}
            >
              <ChevronDown className="h-3 w-3" aria-hidden />
            </button>
          </div>
        </div>
      }
    />
  );
}
