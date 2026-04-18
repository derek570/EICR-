import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from '@radix-ui/react-slot';
import { cn } from '@/lib/utils';

/**
 * Button — matches iOS CertMate button styles.
 * - Primary: filled brand blue, white text, 600 weight
 * - Secondary: bordered, primary text
 * - Ghost: no border, primary text, hover bg
 * - Destructive: filled red
 * Minimum 44px hit area for touch targets.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-md)] font-semibold transition active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)]',
  {
    variants: {
      variant: {
        primary: 'bg-[var(--color-brand-blue)] text-white hover:brightness-110',
        secondary:
          'border border-[var(--color-border-default)] bg-transparent text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)]',
        ghost: 'bg-transparent text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)]',
        destructive: 'bg-[var(--color-status-failed)] text-white hover:brightness-110',
        success: 'bg-[var(--color-brand-green)] text-black hover:brightness-110',
      },
      size: {
        sm: 'h-9 px-3 text-sm',
        md: 'h-11 px-4 text-[15px]',
        lg: 'h-12 px-6 text-base',
        icon: 'h-11 w-11',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild, ...props },
  ref
) {
  const Comp = asChild ? Slot : 'button';
  return <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
});

export { buttonVariants };
