'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useJobContext } from '@/lib/job-context';

/**
 * Job overview / index tab — the default screen when a user opens a job.
 *
 * Shows a grid of shortcut cards to every tab in the unified set, plus a
 * short tip. Real completion status per section lights up as each Phase 3
 * tab lands; for now we chip every card with "Not started".
 */
export default function JobOverviewPage() {
  const { job, certificateType } = useJobContext();
  const params = useParams<{ id: string }>();
  const jobId = params.id;
  const base = `/job/${jobId}`;

  // Unified tab set — mirrors the floating action bar + tab nav order so
  // users can scan the same sequence regardless of entry point.
  const sections = [
    { slug: '/installation', label: 'Installation', desc: 'Address, occupier, client.' },
    { slug: '/supply', label: 'Supply', desc: 'Earthing, prospective fault.' },
    { slug: '/board', label: 'Board', desc: 'Consumer unit, main switch.' },
    { slug: '/circuits', label: 'Circuits', desc: 'Details & test readings.' },
    { slug: '/inspection', label: 'Inspection', desc: 'Tick-sheet items.' },
    { slug: '/extent', label: 'Extent', desc: 'Scope & limitations.' },
    { slug: '/design', label: 'Design', desc: 'Calculations, selection.' },
    { slug: '/staff', label: 'Staff', desc: 'Inspectors & signatures.' },
    { slug: '/pdf', label: 'PDF', desc: 'Preview & download.' },
  ];

  return (
    <div
      className="mx-auto flex w-full flex-col gap-6 px-4 py-6 md:px-8 md:py-10"
      style={{ maxWidth: '960px' }}
    >
      <header className="flex flex-col gap-1">
        <p className="text-[11px] uppercase tracking-[0.14em] text-[var(--color-text-tertiary)]">
          {certificateType} · {job.status}
        </p>
        <h2 className="text-[24px] font-semibold text-[var(--color-text-primary)] md:text-[28px]">
          Overview
        </h2>
        <p className="text-sm text-[var(--color-text-secondary)]">
          Jump to any section to start or continue editing. Voice recording lives on the{' '}
          <span className="text-[var(--color-brand-green)]">Mic</span> button in the floating bar
          (coming in Phase 4).
        </p>
      </header>

      <div className="grid gap-3 md:grid-cols-2">
        {sections.map((s) => (
          <Link
            key={s.slug}
            href={`${base}${s.slug}`}
            className="group flex flex-col gap-1 rounded-[var(--radius-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-4 py-4 transition hover:bg-[var(--color-surface-3)]"
          >
            <span className="text-[15px] font-semibold text-[var(--color-text-primary)]">
              {s.label}
            </span>
            <span className="text-xs text-[var(--color-text-secondary)]">{s.desc}</span>
            <span
              className="mt-2 inline-flex w-fit items-center gap-1 rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]"
              aria-hidden
            >
              Not started
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
