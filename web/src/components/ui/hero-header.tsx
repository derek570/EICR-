import * as React from 'react';
import { cn } from '@/lib/utils';
import { SECTION_ACCENTS, type SectionAccent } from '@/lib/constants/section-accents';

/**
 * HeroHeader — top-of-tab gradient banner shared across every job-detail
 * and settings surface.
 *
 * iOS parity: `InstallationTab.swift:L308-L340` (and the matching helpers
 * on every other tab). iOS stacks:
 *   - `CMDesign.Gradients.hero` (blue -> green diagonal)
 *   - `CMDesign.Gradients.accentShimmer` at 30% opacity
 *   - `cmShadow(blueGlow)` + `cmAmbientGlow(brandBlue, radius: 50)`
 *
 * Web port uses a linear gradient for the base (matches the existing
 * installation/observations banners byte-for-byte), plus a slow breathing
 * radial glow overlay keyed off `--hero-accent` so each tab can tint the
 * glow to its section category. Respects `prefers-reduced-motion` —
 * the overlay is drawn but stops animating.
 *
 * When callers omit `accent`, the glow falls back to the brand-blue tone
 * so the visual matches the existing static banners in every `page.tsx`.
 */
export function HeroHeader({
  title,
  subtitle,
  eyebrow,
  icon,
  accent,
  action,
  className,
  children,
}: {
  title: string;
  subtitle?: string;
  eyebrow?: string;
  icon?: React.ReactNode;
  accent?: SectionAccent;
  action?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}) {
  const glow = accent ? SECTION_ACCENTS[accent].stripe : 'var(--color-brand-blue)';

  return (
    <div
      className={cn(
        'cm-hero relative flex items-center justify-between gap-4 overflow-hidden rounded-[var(--radius-xl)] px-5 py-5 md:px-6 md:py-6',
        className
      )}
      style={
        {
          background:
            'linear-gradient(135deg, var(--color-brand-blue) 0%, var(--color-brand-green) 100%)',
          '--hero-accent': glow,
        } as React.CSSProperties
      }
    >
      <span aria-hidden className="cm-hero-glow" />
      <div className="relative flex flex-1 flex-col gap-1">
        {eyebrow ? (
          <p className="text-[11px] uppercase tracking-[0.14em] text-white/75">{eyebrow}</p>
        ) : null}
        <h2 className="text-[22px] font-bold text-white md:text-[26px]">{title}</h2>
        {subtitle ? <p className="text-[13px] text-white/85">{subtitle}</p> : null}
        {children}
      </div>
      {action || icon ? (
        <div className="relative flex shrink-0 flex-col items-end gap-2">
          {icon ? <span className="text-white/30">{icon}</span> : null}
          {action ? <div>{action}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
