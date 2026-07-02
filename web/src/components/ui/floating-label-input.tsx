'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * FloatingLabelInput — iOS-style form field.
 *
 * WS5 (2026-07-02) — restyled to the live iOS floating-field spec
 * (CMFloatingTextField.swift, `phase4-forms.md §2a`): L2 background,
 * 1.5px L3 border lifting to Green.vibrant + a 12px green glow on focus,
 * radius 12 (`--radius-input`), height 52 (`--h-input`). Label renders
 * the floated state permanently (12px medium, secondary → green when
 * focused — iOS floats the placeholder up; web keeps the two lines
 * always stacked). Value text is bodyRegular 17px — also ≥16px so iOS
 * Safari stops zoom-on-focus.
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
            'group relative flex h-[var(--h-input)] items-stretch rounded-[var(--radius-input)] border-[1.5px] bg-[var(--color-surface-2)] transition focus-within:border-[var(--color-green-vibrant)] focus-within:shadow-[0_0_12px_rgba(0,230,118,0.2)]',
            state === 'error'
              ? 'border-[var(--color-status-failed)]'
              : 'border-[color:var(--color-surface-3)]',
            className
          )}
        >
          <div className="flex flex-1 flex-col justify-center px-3">
            <label
              htmlFor={inputId}
              className="pointer-events-none text-[12px] font-medium text-[var(--color-text-secondary)] transition-colors group-focus-within:text-[var(--color-green-vibrant)]"
            >
              {label}
            </label>
            <input
              id={inputId}
              ref={ref}
              {...props}
              className="w-full bg-transparent text-[17px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)]/60 focus:outline-none"
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
