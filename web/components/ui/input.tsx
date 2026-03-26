'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          'flex h-12 w-full rounded-[12px] bg-L2 px-4 text-[16px] leading-[1.5] text-foreground',
          'border border-white/8 outline-none',
          'placeholder:text-muted-foreground',
          'transition-all duration-200',
          'focus:border-transparent focus:shadow-[0_4px_16px_rgba(0,102,255,0.30)]',
          'focus:ring-1 focus:ring-brand-blue/50',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'file:border-0 file:bg-transparent file:text-sm file:font-medium',
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Input.displayName = 'Input';

export { Input };
