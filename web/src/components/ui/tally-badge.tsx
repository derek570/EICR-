import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * TallyBadge — compact count-plus-label pill.
 *
 * Consumer surfaces:
 *   - Observations tab C1/C2/C3/FI tally (`ObservationsTab.swift:L66-L129`,
 *     `observations/page.tsx:L108-L148`)
 *   - Dashboard Alerts bell badge (Phase 3)
 *   - Any "N item" summary pill across settings/dashboard
 *
 * Variants map to the severity colour tokens already defined in
 * `globals.css`:
 *   destructive -> C1 red (`--color-severity-c1`)
 *   warn        -> C2 amber (`--color-severity-c2`)
 *   info        -> C3 blue (`--color-severity-c3`)
 *   muted       -> FI purple (`--color-severity-fi`)
 *   success     -> OK green (`--color-severity-ok`)
 *
 * Rendering:
 *   - Pill with 15% tinted background + coloured text (matches iOS
 *     `cmStatusBadgeStyle`).
 *   - When `label` is omitted, the pill reads as a pure count (used by
 *     the Alerts bell).
 *   - `aria-label` composes count + label for screen readers.
 */
export type TallyBadgeVariant = 'destructive' | 'warn' | 'info' | 'muted' | 'success';

const VARIANT_TO_VAR: Record<TallyBadgeVariant, string> = {
  destructive: 'var(--color-severity-c1)',
  warn: 'var(--color-severity-c2)',
  info: 'var(--color-severity-c3)',
  muted: 'var(--color-severity-fi)',
  success: 'var(--color-severity-ok)',
};

export function TallyBadge({
  count,
  label,
  variant = 'info',
  className,
  title,
}: {
  count: number;
  label?: string;
  variant?: TallyBadgeVariant;
  className?: string;
  title?: string;
}) {
  const c = VARIANT_TO_VAR[variant];
  const ariaLabel = label ? `${count} ${label}` : `${count}`;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-[0.05em]',
        className
      )}
      style={{
        color: c,
        background: `color-mix(in srgb, ${c} 15%, transparent)`,
      }}
      aria-label={ariaLabel}
      title={title}
    >
      <span className="tabular-nums">{count}</span>
      {label ? <span className="text-[10px] opacity-90">{label}</span> : null}
    </span>
  );
}
