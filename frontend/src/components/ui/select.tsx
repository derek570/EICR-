'use client';

import * as React from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';

import { cn } from '@/lib/utils';

const Select = SelectPrimitive.Root;

const SelectGroup = SelectPrimitive.Group;

const SelectValue = SelectPrimitive.Value;

const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger> & {
    variant?: 'default' | 'glass';
  }
>(({ className, children, variant = 'default', ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      variant === 'default' &&
        'flex h-9 w-full items-center justify-between whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1',
      variant === 'glass' && [
        'flex h-12 w-full items-center justify-between rounded-[12px] bg-L2 px-4 text-[16px] leading-[1.5] text-foreground',
        'border border-neutral-700 outline-none',
        'transition-all duration-200',
        'placeholder:text-muted-foreground',
        'focus:border-transparent focus:shadow-[0_4px_16px_rgba(0,102,255,0.30)]',
        'focus:ring-1 focus:ring-brand-blue/50',
        'disabled:cursor-not-allowed disabled:opacity-50',
        '[&>span]:truncate',
      ],
      className
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <ChevronDown
        className={cn(
          'h-4 w-4 shrink-0',
          variant === 'default' && 'opacity-50',
          variant === 'glass' && 'ml-2 text-muted-foreground'
        )}
      />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

const SelectScrollUpButton = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.ScrollUpButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollUpButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollUpButton
    ref={ref}
    className={cn('flex cursor-default items-center justify-center py-1', className)}
    {...props}
  >
    <ChevronUp className="h-4 w-4 text-muted-foreground" />
  </SelectPrimitive.ScrollUpButton>
));
SelectScrollUpButton.displayName = SelectPrimitive.ScrollUpButton.displayName;

const SelectScrollDownButton = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.ScrollDownButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollDownButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollDownButton
    ref={ref}
    className={cn('flex cursor-default items-center justify-center py-1', className)}
    {...props}
  >
    <ChevronDown className="h-4 w-4 text-muted-foreground" />
  </SelectPrimitive.ScrollDownButton>
));
SelectScrollDownButton.displayName = SelectPrimitive.ScrollDownButton.displayName;

const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content> & {
    variant?: 'default' | 'glass';
  }
>(({ className, children, position = 'popper', variant = 'default', ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      className={cn(
        variant === 'default' &&
          'relative z-50 max-h-96 min-w-[8rem] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
        variant === 'glass' && [
          'relative z-50 max-h-72 min-w-[8rem] overflow-hidden rounded-[12px] bg-L1 border border-neutral-700',
          'shadow-[0_6px_20px_rgba(0,0,0,0.14)]',
          'data-[state=open]:animate-in data-[state=closed]:animate-out',
          'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
          'data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2',
          'data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
        ],
        position === 'popper' &&
          'data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1',
        className
      )}
      position={position}
      {...props}
    >
      <SelectScrollUpButton />
      <SelectPrimitive.Viewport
        className={cn(
          'p-1',
          position === 'popper' &&
            'h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)]'
        )}
      >
        {children}
      </SelectPrimitive.Viewport>
      <SelectScrollDownButton />
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
));
SelectContent.displayName = SelectPrimitive.Content.displayName;

const SelectLabel = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label> & {
    variant?: 'default' | 'glass';
  }
>(({ className, variant = 'default', ...props }, ref) => (
  <SelectPrimitive.Label
    ref={ref}
    className={cn(
      variant === 'default' && 'px-2 py-1.5 text-sm font-semibold',
      variant === 'glass' && 'px-3 py-1.5 text-[14px] font-semibold text-muted-foreground',
      className
    )}
    {...props}
  />
));
SelectLabel.displayName = SelectPrimitive.Label.displayName;

const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item> & {
    variant?: 'default' | 'glass';
  }
>(({ className, children, variant = 'default', ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      variant === 'default' &&
        'relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-2 pr-8 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
      variant === 'glass' && [
        'relative flex w-full cursor-default select-none items-center rounded-[8px] py-2.5 pl-3 pr-8 text-[16px] text-foreground outline-none',
        'transition-colors duration-150',
        'focus:bg-white/8 focus:text-foreground',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
      ],
      className
    )}
    {...props}
  >
    <span
      className={cn(
        'absolute flex items-center justify-center',
        variant === 'default' && 'right-2 h-3.5 w-3.5',
        variant === 'glass' && 'right-3 h-4 w-4'
      )}
    >
      <SelectPrimitive.ItemIndicator>
        <Check className={cn('h-4 w-4', variant === 'glass' && 'text-brand-blue')} />
      </SelectPrimitive.ItemIndicator>
    </span>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;

const SelectSeparator = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator> & {
    variant?: 'default' | 'glass';
  }
>(({ className, variant = 'default', ...props }, ref) => (
  <SelectPrimitive.Separator
    ref={ref}
    className={cn(
      '-mx-1 my-1 h-px',
      variant === 'default' && 'bg-muted',
      variant === 'glass' && 'bg-white/8',
      className
    )}
    {...props}
  />
));
SelectSeparator.displayName = SelectPrimitive.Separator.displayName;

export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
  SelectScrollUpButton,
  SelectScrollDownButton,
};
