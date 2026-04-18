import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Input matches iOS form fields: 44 px tall touch target, rounded-md,
 * subtle border on surface-2, brand-blue focus ring.
 */
export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function Input({ className, type = 'text', ...props }, ref) {
  return (
    <input
      ref={ref}
      type={type}
      className={cn(
        'h-11 w-full rounded-[var(--radius-md)]',
        'bg-[var(--color-surface-2)] px-3',
        'text-[15px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)]',
        'border border-[var(--color-border-default)]',
        'transition focus:border-[var(--color-brand-blue)] focus:outline-2 focus:outline-[var(--color-brand-blue)] focus:outline-offset-1',
        'disabled:opacity-50',
        className
      )}
      {...props}
    />
  );
});

export const Label = React.forwardRef<
  HTMLLabelElement,
  React.LabelHTMLAttributes<HTMLLabelElement>
>(function Label({ className, ...props }, ref) {
  return (
    <label
      ref={ref}
      className={cn(
        'mb-1 block text-[13px] font-semibold text-[var(--color-text-primary)]',
        className
      )}
      {...props}
    />
  );
});
