import * as React from 'react';

/**
 * Pill — compact coloured badge used across the Phase 6c admin screens.
 *
 * Extracted for Wave 3b (D11) from three copies:
 *   - web/src/app/settings/company/dashboard/page.tsx        (colors: blue/green/red)
 *   - web/src/app/settings/admin/users/[userId]/page.tsx     (colors: blue/green/red/amber)
 *   - web/src/app/settings/admin/users/page.tsx              (colors: blue/green/red/amber/neutral; `inline-flex items-center` wrapper)
 *
 * Two deliberate divergences are preserved as opt-in props rather than merged:
 *
 *   - `color` supports the widest palette (blue/green/red/amber/neutral). Call
 *     sites that previously only used a subset still type-check — TypeScript
 *     narrows from their argument site.
 *   - `inline` adds `inline-flex items-center` so inline icons inside the pill
 *     (used by the users-list "Locked" and "Admin" pills) line up vertically.
 *     The dashboard and [userId] pills don't host icons, so they still render
 *     as bare `<span>` — defaulting `inline` to false keeps their markup
 *     byte-identical.
 *
 * No hooks; safe from a Server Component without 'use client'.
 */
export function Pill({
  color,
  inline = false,
  children,
}: {
  color: 'blue' | 'green' | 'red' | 'amber' | 'neutral';
  inline?: boolean;
  children: React.ReactNode;
}) {
  const c =
    color === 'blue'
      ? 'var(--color-brand-blue)'
      : color === 'green'
        ? 'var(--color-brand-green)'
        : color === 'red'
          ? 'var(--color-status-failed)'
          : color === 'amber'
            ? 'var(--color-status-processing)'
            : 'var(--color-text-tertiary)';
  const className = inline
    ? 'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.05em]'
    : 'rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.05em]';
  return (
    <span
      className={className}
      style={{
        color: c,
        background: `color-mix(in oklab, ${c} 15%, transparent)`,
      }}
    >
      {children}
    </span>
  );
}
