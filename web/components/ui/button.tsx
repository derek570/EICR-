'use client';

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  [
    'inline-flex items-center justify-center gap-2 whitespace-nowrap font-semibold',
    'transition-all duration-200 outline-none',
    'focus-visible:ring-2 focus-visible:ring-brand-blue/50 focus-visible:ring-offset-2 focus-visible:ring-offset-L0',
    'disabled:pointer-events-none disabled:opacity-50',
    'active:animate-spring-press',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  ].join(' '),
  {
    variants: {
      variant: {
        default: [
          'bg-gradient-to-r from-brand-green to-brand-blue text-white',
          'shadow-[0_4px_16px_rgba(0,102,255,0.30)]',
          'hover:shadow-[0_6px_24px_rgba(0,102,255,0.40)] hover:brightness-110',
        ].join(' '),
        outline: ['glass-bg border border-white/8 text-foreground', 'hover:bg-white/10'].join(' '),
        ghost: ['bg-transparent text-foreground', 'hover:bg-L2'].join(' '),
        destructive: [
          'bg-status-red text-white',
          'shadow-[0_4px_16px_rgba(255,82,82,0.30)]',
          'hover:shadow-[0_6px_24px_rgba(255,82,82,0.40)] hover:brightness-110',
        ].join(' '),
        link: 'text-brand-blue underline-offset-4 hover:underline !p-0 !h-auto',
      },
      size: {
        default: 'h-[52px] px-6 text-[16px] rounded-full',
        sm: 'h-10 px-4 text-[14px] rounded-full',
        lg: 'h-14 px-8 text-[18px] rounded-full',
        icon: 'h-10 w-10 rounded-full',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  }
);
Button.displayName = 'Button';

export { Button, buttonVariants };
