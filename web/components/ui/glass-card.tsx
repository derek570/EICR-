import * as React from 'react';
import { cn } from '@/lib/utils';

interface GlassCardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Enable animated gradient border (blue→green) */
  gradientBorder?: boolean;
  /** Enable breathe-glow animation */
  glow?: boolean;
}

const GlassCard = React.forwardRef<HTMLDivElement, GlassCardProps>(
  ({ className, gradientBorder = false, glow = false, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        // Base glass effect (glass-bg includes -webkit-backdrop-filter for Safari)
        'rounded-[18px] glass-bg',
        // Default border
        !gradientBorder && 'border border-[rgba(255,255,255,0.08)]',
        // Gradient border
        gradientBorder && 'gradient-border',
        // Glow animation
        glow && 'animate-[breathe-glow_2s_ease-in-out_infinite]',
        // Shadow
        'shadow-[0_3px_10px_rgba(0,0,0,0.10)]',
        className
      )}
      {...props}
    />
  )
);
GlassCard.displayName = 'GlassCard';

const GlassCardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex flex-col gap-1.5 p-5', className)} {...props} />
  )
);
GlassCardHeader.displayName = 'GlassCardHeader';

const GlassCardTitle = React.forwardRef<
  HTMLHeadingElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h3
    ref={ref}
    className={cn('text-[19px] font-bold leading-tight tracking-tight text-foreground', className)}
    {...props}
  />
));
GlassCardTitle.displayName = 'GlassCardTitle';

const GlassCardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('px-5 pb-5', className)} {...props} />
  )
);
GlassCardContent.displayName = 'GlassCardContent';

export { GlassCard, GlassCardHeader, GlassCardTitle, GlassCardContent };
