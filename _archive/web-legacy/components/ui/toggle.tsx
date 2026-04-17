'use client';

import * as React from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { cn } from '@/lib/utils';

const Toggle = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    className={cn(
      'peer inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full',
      'border border-white/8 outline-none',
      'transition-all duration-200',
      'focus-visible:ring-2 focus-visible:ring-brand-blue/50 focus-visible:ring-offset-2 focus-visible:ring-offset-L0',
      'disabled:cursor-not-allowed disabled:opacity-50',
      'data-[state=unchecked]:bg-L3',
      'data-[state=checked]:bg-gradient-to-r data-[state=checked]:from-brand-blue data-[state=checked]:to-brand-green',
      'data-[state=checked]:shadow-[0_4px_16px_rgba(0,102,255,0.30)]',
      className
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        'pointer-events-none block h-5 w-5 rounded-full bg-white shadow-md',
        'transition-transform duration-200',
        'data-[state=checked]:translate-x-[22px] data-[state=unchecked]:translate-x-[3px]'
      )}
    />
  </SwitchPrimitive.Root>
));
Toggle.displayName = 'Toggle';

export { Toggle };
