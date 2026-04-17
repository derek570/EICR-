'use client';

import Link from 'next/link';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useJobContext } from '@/lib/job-context';
import { useParams } from 'next/navigation';

/**
 * Job overview / index tab. Shows a quick summary of completion progress
 * across each section and links to the relevant tabs. Real progress math
 * lands alongside each Phase 3 tab — for now we show "Not started" chips.
 */
export default function JobOverviewPage() {
  const { job, certificateType } = useJobContext();
  const params = useParams<{ id: string }>();
  const jobId = params.id;

  const sections =
    certificateType === 'EIC'
      ? [
          { slug: '/installation', label: 'Installation', desc: 'Address, occupier, client.' },
          { slug: '/extent', label: 'Extent & Type', desc: 'Scope of works.' },
          { slug: '/supply', label: 'Supply', desc: 'Earthing, prospective fault.' },
          { slug: '/board', label: 'Board', desc: 'Consumer unit, main switch.' },
          { slug: '/circuits', label: 'Circuits', desc: 'Details & test readings.' },
          { slug: '/inspection', label: 'Inspection', desc: 'EIC tick-sheet.' },
          { slug: '/design', label: 'Design', desc: 'Calculations, selection.' },
          { slug: '/inspector', label: 'Inspector', desc: 'Signatures, qualifications.' },
          { slug: '/pdf', label: 'PDF', desc: 'Preview & download.' },
        ]
      : [
          { slug: '/installation', label: 'Installation', desc: 'Address, occupier, client.' },
          { slug: '/supply', label: 'Supply', desc: 'Earthing, prospective fault.' },
          { slug: '/board', label: 'Board', desc: 'Consumer unit, main switch.' },
          { slug: '/circuits', label: 'Circuits', desc: 'Details & test readings.' },
          {
            slug: '/observations',
            label: 'Observations',
            desc: 'C1/C2/C3/FI findings.',
          },
          { slug: '/inspection', label: 'Inspection', desc: 'EICR tick-sheet.' },
          { slug: '/inspector', label: 'Inspector', desc: 'Signatures, qualifications.' },
          { slug: '/pdf', label: 'PDF', desc: 'Preview & download.' },
        ];

  const base = `/job/${jobId}`;

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
          Jump to any section to start or continue editing. Voice recording is available from the
          floating mic button (coming in Phase 4).
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

      <Card>
        <CardHeader>
          <CardTitle>Tip</CardTitle>
          <CardDescription>
            Your iOS app syncs the same job record. Changes on either surface show up here after a
            save.
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
