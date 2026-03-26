import * as React from 'react';

import { cn } from '@/lib/utils';

export interface InputProps extends React.ComponentProps<'input'> {
  variant?: 'default' | 'glass';
}

function Input({ className, type, variant = 'default', ...props }: InputProps) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        variant === 'default' && [
          'file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground dark:bg-input/30 border-input h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
          'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
          'aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive',
        ],
        variant === 'glass' && [
          'flex h-12 w-full rounded-[12px] bg-L2 px-4 text-[16px] leading-[1.5] text-foreground',
          'border border-neutral-700 outline-none',
          'placeholder:text-muted-foreground',
          'transition-all duration-200',
          'focus:border-transparent focus:shadow-[0_4px_16px_rgba(0,102,255,0.30)]',
          'focus:ring-1 focus:ring-brand-blue/50',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'file:border-0 file:bg-transparent file:text-sm file:font-medium',
        ],
        className
      )}
      {...props}
    />
  );
}

export { Input };
