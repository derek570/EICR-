import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * CertMate wordmark. Simple text-based mark in brand blue on dark surface.
 * Swap for SVG asset when user provides a final brand mark.
 */
export function Logo({
  className,
  size = 'md',
}: {
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const sizeClass = {
    sm: 'text-base',
    md: 'text-xl',
    lg: 'text-2xl',
  }[size];

  return (
    <span
      className={cn(
        'inline-flex items-baseline gap-1 font-bold tracking-tight',
        sizeClass,
        className
      )}
      aria-label="CertMate"
    >
      <span className="text-[var(--color-text-primary)]">CertMate</span>
      <span className="text-[var(--color-brand-blue)]">·</span>
      <span className="text-[var(--color-text-secondary)] text-[0.7em] font-medium">EICR</span>
    </span>
  );
}
