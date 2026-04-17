import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * SectionCard — the repeating "form card" unit across every /job/[id]/... tab.
 *
 * Mirrors the iOS JobDetail form cards: rounded dark-surface container with a
 * 3 px coloured accent stripe running down the LEFT edge. The accent colour
 * is semantic:
 *   blue    — default (Installation, Staff, Design)
 *   green   — supply / power / pass-state aggregate (Supply)
 *   amber   — partial / warning (Circuits with failures)
 *   magenta — design / limitations (Extent)
 *   red     — failure (Observations)
 *
 * Layout:
 *   - Optional icon + title header row (matches iOS SF Symbols + Bold title)
 *   - Optional bottom-centre `</>` code chip (via `showCodeChip` prop) — a
 *     tiny decorative pill used on some iOS cards.
 *
 * Usage:
 *   <SectionCard accent="blue" icon={Building2} title="Installation details">
 *     <FloatingLabelInput ... />
 *     ...
 *   </SectionCard>
 */
export type SectionAccent = 'blue' | 'green' | 'amber' | 'magenta' | 'red';

const ACCENT_TO_VAR: Record<SectionAccent, string> = {
  blue: 'var(--color-brand-blue)',
  green: 'var(--color-brand-green)',
  amber: 'var(--color-status-processing)',
  magenta: '#ff375f',
  red: 'var(--color-status-failed)',
};

export function SectionCard({
  accent = 'blue',
  icon: Icon,
  title,
  subtitle,
  showCodeChip = false,
  className,
  children,
  ...props
}: {
  accent?: SectionAccent;
  icon?: React.ComponentType<{
    className?: string;
    strokeWidth?: number;
    'aria-hidden'?: boolean;
  }>;
  title?: string;
  subtitle?: string;
  showCodeChip?: boolean;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'title'>) {
  const accentColor = ACCENT_TO_VAR[accent];
  return (
    <section
      {...props}
      className={cn(
        'relative overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] pl-4 pr-4 py-4 md:pl-5 md:pr-5 md:py-5',
        className
      )}
    >
      {/* Left accent stripe */}
      <span
        aria-hidden
        className="absolute left-0 top-0 h-full w-[3px] rounded-r-full"
        style={{ background: accentColor }}
      />

      {(title || Icon) && (
        <header className="mb-3 flex items-center gap-2">
          {Icon ? (
            <span style={{ color: accentColor }} className="inline-flex">
              <Icon className="h-4 w-4" strokeWidth={2.25} aria-hidden />
            </span>
          ) : null}
          <div className="flex flex-col">
            {title ? (
              <h3 className="text-[15px] font-bold tracking-tight text-[var(--color-text-primary)]">
                {title}
              </h3>
            ) : null}
            {subtitle ? (
              <p className="text-[12px] text-[var(--color-text-secondary)]">{subtitle}</p>
            ) : null}
          </div>
        </header>
      )}

      <div className="flex flex-col gap-3">{children}</div>

      {showCodeChip ? (
        <div className="mt-4 flex justify-center" aria-hidden>
          <span className="inline-flex items-center rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] px-2.5 py-0.5 font-mono text-[10px] text-[var(--color-text-tertiary)]">
            {'</>'}
          </span>
        </div>
      ) : null}
    </section>
  );
}
