import * as React from 'react';
import { cn } from '@/lib/utils';
import {
  SECTION_ACCENTS,
  type SectionAccent as CategoryAccent,
} from '@/lib/constants/section-accents';

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
 * Phase 1 — iOS-parity category accents are also accepted (client,
 * electrical, board, test-results, schedule, notes, protection). When a
 * category accent is passed, the card also picks up the very-subtle
 * tinted background + accent-tinted border, matching `CMSectionCard`.
 * The original five colour accents keep the original byte-identical
 * surface so every existing callsite stays visually unchanged.
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
export type ColourAccent = 'blue' | 'green' | 'amber' | 'magenta' | 'red';
export type SectionAccent = ColourAccent | CategoryAccent;

const COLOUR_ACCENTS: Record<ColourAccent, string> = {
  blue: 'var(--color-brand-blue)',
  green: 'var(--color-brand-green)',
  amber: 'var(--color-status-processing)',
  magenta: '#ff375f',
  red: 'var(--color-status-failed)',
};

function isCategoryAccent(accent: SectionAccent): accent is CategoryAccent {
  return accent in SECTION_ACCENTS;
}

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
  const category = isCategoryAccent(accent) ? SECTION_ACCENTS[accent] : null;
  const accentColor = category ? category.stripe : COLOUR_ACCENTS[accent as ColourAccent];
  // WS5 (2026-07-02) — iOS CMSectionCard recipe (CMSectionCard.swift:48-108):
  // L1 background + Blue.subtle (blue-vibrant 8%) tint, gradient border
  // from the accent at 20% → 8% (padding-box/border-box trick), radius 16
  // (cardRedesign), padding 16. Category accents carry the full recipe;
  // legacy colour accents get the same card chrome with a plain subtle
  // border (they predate the iOS category system).
  const surfaceStyle: React.CSSProperties = category
    ? {
        background:
          `linear-gradient(color-mix(in srgb, var(--color-blue-vibrant) 8%, transparent), color-mix(in srgb, var(--color-blue-vibrant) 8%, transparent)) padding-box, ` +
          `linear-gradient(var(--color-surface-1), var(--color-surface-1)) padding-box, ` +
          `linear-gradient(135deg, color-mix(in srgb, ${category.stripe} 20%, transparent), color-mix(in srgb, ${category.stripe} 8%, transparent)) border-box`,
        borderColor: 'transparent',
      }
    : {};
  return (
    <section
      {...props}
      className={cn(
        'relative overflow-hidden rounded-[var(--radius-section-card)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] p-4',
        className
      )}
      style={{ ...surfaceStyle, ...(props.style ?? {}) }}
    >
      {/* Left accent bar — iOS `cmStatusConduit`: 3px vertical gradient
          (accent → 40%), inset from the card edges like the SwiftUI
          original (leading 4px, vertical 8px). */}
      <span
        aria-hidden
        className="absolute bottom-2 left-1 top-2 w-[3px] rounded-full"
        style={{
          background: `linear-gradient(180deg, ${accentColor}, color-mix(in srgb, ${accentColor} 40%, transparent))`,
        }}
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
