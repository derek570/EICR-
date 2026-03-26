'use client';

import * as React from 'react';
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group';
import { cn } from '@/lib/utils';

const RadioGroup = React.forwardRef<
  React.ComponentRef<typeof RadioGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>
>(({ className, ...props }, ref) => (
  <RadioGroupPrimitive.Root className={cn('grid gap-3', className)} {...props} ref={ref} />
));
RadioGroup.displayName = RadioGroupPrimitive.Root.displayName;

const RadioGroupItem = React.forwardRef<
  React.ComponentRef<typeof RadioGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>
>(({ className, ...props }, ref) => (
  <RadioGroupPrimitive.Item
    ref={ref}
    className={cn(
      'peer h-5 w-5 shrink-0 rounded-full outline-none',
      'border-2 border-white/12 bg-L2',
      'transition-all duration-200',
      'focus-visible:ring-2 focus-visible:ring-brand-blue/50 focus-visible:ring-offset-2 focus-visible:ring-offset-L0',
      'disabled:cursor-not-allowed disabled:opacity-50',
      'data-[state=checked]:border-brand-blue data-[state=checked]:bg-transparent',
      'data-[state=checked]:shadow-[0_2px_8px_rgba(0,102,255,0.25)]',
      className
    )}
    {...props}
  >
    <RadioGroupPrimitive.Indicator className="flex items-center justify-center">
      <div className="h-2.5 w-2.5 rounded-full bg-gradient-to-br from-brand-blue to-brand-green" />
    </RadioGroupPrimitive.Indicator>
  </RadioGroupPrimitive.Item>
));
RadioGroupItem.displayName = RadioGroupPrimitive.Item.displayName;

export { RadioGroup, RadioGroupItem };
