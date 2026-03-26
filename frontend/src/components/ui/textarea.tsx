import * as React from 'react';

import { cn } from '@/lib/utils';

export interface TextareaProps extends React.ComponentPropsWithoutRef<'textarea'> {
  variant?: 'default' | 'glass';
  autoResize?: boolean;
}

function Textarea({
  className,
  variant = 'default',
  autoResize = false,
  onChange,
  ...props
}: TextareaProps) {
  const internalRef = React.useRef<HTMLTextAreaElement | null>(null);

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
      ref={internalRef}
      data-slot="textarea"
      className={cn(
        variant === 'default' && [
          'placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground dark:bg-input/30 border-input w-full min-w-0 rounded-md border bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
          'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
          'aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive',
          !autoResize && 'min-h-[80px] resize-y',
          autoResize && 'resize-none overflow-hidden min-h-[80px]',
        ],
        variant === 'glass' && [
          'flex min-h-[120px] w-full rounded-[12px] bg-L2 px-4 py-3 text-[16px] leading-[1.5] text-foreground',
          'border border-neutral-700 outline-none',
          'placeholder:text-muted-foreground',
          'transition-all duration-200',
          'focus:border-transparent focus:shadow-[0_4px_16px_rgba(0,102,255,0.30)]',
          'focus:ring-1 focus:ring-brand-blue/50',
          'disabled:cursor-not-allowed disabled:opacity-50',
          autoResize && 'resize-none overflow-hidden',
          !autoResize && 'resize-y',
        ],
        className
      )}
      onChange={handleChange}
      {...props}
    />
  );
}

export { Textarea };
