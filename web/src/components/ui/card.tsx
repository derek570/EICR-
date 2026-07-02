import * as React from 'react';
import { cn } from '@/lib/utils';

export function Card({
  className,
  glass = false,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { glass?: boolean }) {
  // WS5 (2026-07-02): default card is the iOS `cmCardStyle()` glass
  // recipe (`.cm-card` in globals.css) — radius 18 + 20px padding
  // (CMDesign CornerRadius.card / Spacing.cardPadding, the live-call-
  // site winners). The `glass` variant keeps the heavier `.cm-glass`
  // blur used by the login/error hero cards.
  return (
    <div
      className={cn('p-5', glass ? 'cm-glass rounded-[var(--radius-card)]' : 'cm-card', className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mb-4 flex flex-col gap-1', className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn(
        'text-[17px] font-bold tracking-tight text-[var(--color-text-primary)]',
        className
      )}
      {...props}
    />
  );
}

export function CardDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-sm text-[var(--color-text-secondary)]', className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-3', className)} {...props} />;
}
