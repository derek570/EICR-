'use client';

import * as React from 'react';
import Link from 'next/link';
import { ChevronRight, SlidersHorizontal, Zap } from 'lucide-react';
import { HeroHeader } from '@/components/ui/hero-header';
import { SectionCard } from '@/components/ui/section-card';

/**
 * Defaults hub — iOS `DefaultsManagerView.swift`.
 *
 * The iOS sheet exposes two sub-editors (Default Values + Cable Size
 * Defaults) that share the same underlying `user_defaults.json` blob
 * but slice it across different field groupings for ergonomic reasons:
 *
 *   - Default Values: the general "preferences" the inspector wants to
 *     preset on every job (test voltage, max disconnect time, polarity
 *     default). Applies to every circuit.
 *   - Cable Size Defaults: per-circuit-type cable + OCPD sizing so the
 *     inspector can override the BS 7671 schema defaults with their
 *     own house conventions (e.g. "we always run 4.0mm² to sockets").
 *
 * The web port keeps that split because it maps cleanly to the two
 * editor pages below — mixing them on one screen would reproduce
 * iOS's usability complaint and make the form much taller than needs
 * to be on mobile.
 *
 * No "Apply to Job" button lives here — that affordance stays on the
 * Circuits tab (Phase 5 already ships it). This page is purely for
 * editing the values that the Circuits tab reads.
 */
export default function DefaultsHubPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
      <HeroHeader
        eyebrow="Defaults"
        title="Defaults Manager"
        subtitle="Preset circuit fields and cable sizing so every new job starts configured"
      />

      <SectionCard accent="blue" title="Editors">
        <nav className="flex flex-col gap-2">
          <DefaultsLink
            href="/settings/defaults/values"
            icon={<SlidersHorizontal className="h-5 w-5" aria-hidden />}
            title="Default Values"
            subtitle="Test voltage, max disconnect time, polarity, RCD operating current"
          />
          <DefaultsLink
            href="/settings/defaults/cable"
            icon={<Zap className="h-5 w-5" aria-hidden />}
            title="Cable Size Defaults"
            subtitle="Per-circuit-type live / CPC CSA, OCPD rating + type"
          />
        </nav>
      </SectionCard>

      <p className="px-1 text-[12px] text-[var(--color-text-tertiary)]">
        Defaults fill empty fields only — they never overwrite a value you&apos;ve already set on a
        circuit.
      </p>
    </main>
  );
}

function DefaultsLink({
  href,
  icon,
  title,
  subtitle,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <Link
      href={href}
      className="block focus-visible:outline-2 focus-visible:outline-[var(--color-brand-blue)] rounded-[var(--radius-md)]"
    >
      <div className="flex items-center gap-4 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] p-3 transition hover:bg-[var(--color-surface-3)]">
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-md)]"
          style={{
            color: 'var(--color-brand-blue)',
            background: 'color-mix(in oklab, var(--color-brand-blue) 15%, transparent)',
          }}
        >
          {icon}
        </span>
        <div className="flex flex-1 flex-col gap-0.5">
          <span className="text-[15px] font-semibold text-[var(--color-text-primary)]">
            {title}
          </span>
          <span className="text-[12px] text-[var(--color-text-secondary)]">{subtitle}</span>
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-[var(--color-text-tertiary)]" aria-hidden />
      </div>
    </Link>
  );
}
