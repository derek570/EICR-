'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  autoResize?: boolean;
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, autoResize = true, onChange, ...props }, ref) => {
    const internalRef = React.useRef<HTMLTextAreaElement | null>(null);

    const setRefs = React.useCallback(
      (node: HTMLTextAreaElement | null) => {
        internalRef.current = node;
        if (typeof ref === 'function') {
          ref(node);
        } else if (ref) {
          (ref as React.MutableRefObject<HTMLTextAreaElement | null>).current = node;
        }
      },
      [ref]
    );

    const adjustHeight = React.useCallback(() => {
      const textarea = internalRef.current;
      if (textarea && autoResize) {
        textarea.style.height = 'auto';
        textarea.style.height = `${textarea.scrollHeight}px`;
      }
    }, [autoResize]);

    React.useEffect(() => {
      adjustHeight();
    }, [adjustHeight]);

    const handleChange = React.useCallback(
      (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        adjustHeight();
        onChange?.(e);
      },
      [adjustHeight, onChange]
    );

    return (
      <textarea
        className={cn(
          'flex min-h-[120px] w-full rounded-[12px] bg-L2 px-4 py-3 text-[16px] leading-[1.5] text-foreground',
          'border border-white/8 outline-none',
          'placeholder:text-muted-foreground',
          'transition-all duration-200',
          'focus:border-transparent focus:shadow-[0_4px_16px_rgba(0,102,255,0.30)]',
          'focus:ring-1 focus:ring-brand-blue/50',
          'disabled:cursor-not-allowed disabled:opacity-50',
          autoResize && 'resize-none overflow-hidden',
          className
        )}
        ref={setRefs}
        onChange={handleChange}
        {...props}
      />
    );
  }
);
Textarea.displayName = 'Textarea';

export { Textarea };
