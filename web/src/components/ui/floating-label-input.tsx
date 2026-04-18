'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * FloatingLabelInput — iOS-style form field.
 *
 * Visual: tall rounded box (h-14) on surface-2 with the LABEL sitting top-left
 * at 11 px and the VALUE beneath it at 15 px. Focus state lifts the border
 * to brand-blue. When the input is empty and unfocused, the label stays in
 * place (iOS does not float down into the value slot — the two lines are
 * always stacked).
 *
 * Supports:
 *   - `trailing` slot for per-field suffix icons (stepper arrows, chevrons,
 *     unit chips). Renders inside the right edge.
 *   - `state`: 'error' surfaces the failed token outline.
 *   - Refs forwarded so callers can use react-hook-form etc.
 */
export type FloatingLabelInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> & {
  label: string;
  state?: 'default' | 'error';
  trailing?: React.ReactNode;
  /** Optional helper text under the field. */
  hint?: string;
};

export const FloatingLabelInput = React.forwardRef<HTMLInputElement, FloatingLabelInputProps>(
  function FloatingLabelInput(
    { label, state = 'default', trailing, hint, className, id, ...props },
    ref
  ) {
    const reactId = React.useId();
    const inputId = id ?? reactId;
    const errorColor = 'var(--color-status-failed)';
    return (
      <div className="flex flex-col gap-1">
        <div
          className={cn(
            'group relative flex h-14 items-stretch rounded-[var(--radius-md)] border bg-[var(--color-surface-1)] transition focus-within:border-[var(--color-brand-blue)]',
            state === 'error'
              ? 'border-[var(--color-status-failed)]'
              : 'border-[var(--color-border-default)]',
            className
          )}
        >
          <div className="flex flex-1 flex-col justify-center px-3">
            <label
              htmlFor={inputId}
              className="pointer-events-none text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]"
            >
              {label}
            </label>
            <input
              id={inputId}
              ref={ref}
              {...props}
              className="w-full bg-transparent text-[15px] font-medium text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)]/60 focus:outline-none"
            />
          </div>
          {trailing ? (
            <div className="flex items-center gap-1 pr-2 text-[var(--color-text-secondary)]">
              {trailing}
            </div>
          ) : null}
        </div>
        {hint ? (
          <p
            className="px-1 text-[11px]"
            style={{ color: state === 'error' ? errorColor : 'var(--color-text-tertiary)' }}
          >
            {hint}
          </p>
        ) : null}
      </div>
    );
  }
);
