'use client';

import * as React from 'react';
import { AlertTriangle, MapPin, Plus, Trash2 } from 'lucide-react';
import { useJobContext } from '@/lib/job-context';
import type { ObservationRow } from '@/lib/types';
import { SectionCard } from '@/components/ui/section-card';
import { cn } from '@/lib/utils';

/**
 * Observations tab — mirrors iOS `ObservationsTab.swift`.
 *
 * Hero banner with C1/C2/C3/FI tally, an Add button (wires up to the
 * AddObservation sheet in Phase 5), and a list of observation cards.
 *
 * This Phase 3c landing delivers:
 *   • empty-state card
 *   • count badges in the hero
 *   • list of observation cards with code chip + location + description
 *   • remove button (inline — edit sheet arrives in Phase 5)
 *
 * Add/edit dialogs, photo attachment, and schedule-item linking wire up
 * in Phase 5 where capture/flows land.
 */

const CODE_COLOUR: Record<NonNullable<ObservationRow['code']>, string> = {
  C1: 'var(--color-status-failed)',
  C2: 'var(--color-status-processing)',
  C3: 'var(--color-brand-blue)',
  FI: 'var(--color-status-limitation)',
};

const CODE_LABEL: Record<NonNullable<ObservationRow['code']>, string> = {
  C1: 'Danger present — immediate action required',
  C2: 'Potentially dangerous — urgent remedial action',
  C3: 'Improvement recommended',
  FI: 'Further investigation required',
};

export default function ObservationsPage() {
  const { job, certificateType, updateJob } = useJobContext();
  const observations = job.observations ?? [];

  const counts = React.useMemo(() => countByCode(observations), [observations]);

  const removeAt = (id: string) => {
    updateJob({ observations: observations.filter((o) => o.id !== id) });
  };

  return (
    <div
      className="mx-auto flex w-full flex-col gap-5 px-4 py-6 md:px-8 md:py-8"
      style={{ maxWidth: '960px' }}
    >
      <div
        className="relative flex items-center justify-between overflow-hidden rounded-[var(--radius-xl)] px-5 py-5 md:px-6 md:py-6"
        style={{
          background:
            'linear-gradient(135deg, var(--color-brand-blue) 0%, var(--color-brand-green) 100%)',
        }}
      >
        <div className="flex flex-1 flex-col gap-2">
          <p className="text-[11px] uppercase tracking-[0.14em] text-white/75">{certificateType}</p>
          <h2 className="text-[22px] font-bold text-white md:text-[26px]">Observations</h2>
          <p className="text-[13px] text-white/85">Defects, recommendations &amp; notes</p>
          {observations.length > 0 ? (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <CountBadge label="Total" count={observations.length} colour="white" />
              {counts.C1 > 0 ? (
                <CountBadge label="C1" count={counts.C1} colour={CODE_COLOUR.C1} />
              ) : null}
              {counts.C2 > 0 ? (
                <CountBadge label="C2" count={counts.C2} colour={CODE_COLOUR.C2} />
              ) : null}
              {counts.C3 > 0 ? (
                <CountBadge label="C3" count={counts.C3} colour={CODE_COLOUR.C3} />
              ) : null}
              {counts.FI > 0 ? (
                <CountBadge label="FI" count={counts.FI} colour={CODE_COLOUR.FI} />
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="flex flex-col items-end gap-2">
          <AlertTriangle className="h-10 w-10 text-white/30" strokeWidth={2} aria-hidden />
          <button
            type="button"
            disabled
            className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-full bg-white/95 px-3.5 py-1.5 text-[12px] font-semibold text-[var(--color-brand-blue)] opacity-90"
            title="Add observation wires up in Phase 5"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            Add
          </button>
        </div>
      </div>

      {observations.length === 0 ? (
        <SectionCard accent="blue" icon={AlertTriangle} title="No observations">
          <p className="text-[13px] text-[var(--color-text-secondary)]">
            Tap <span className="font-semibold">Add</span> to record a C1 / C2 / C3 / FI finding, or
            use the <span className="font-semibold">Obs</span> shortcut in the floating action bar
            during a live recording session. Codes populate here automatically when Sonnet detects a
            defect keyword in the transcript.
          </p>
        </SectionCard>
      ) : (
        <div className="flex flex-col gap-3">
          {observations.map((obs) => (
            <ObservationCard key={obs.id} obs={obs} onRemove={() => removeAt(obs.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------------- */

function countByCode(list: ObservationRow[]) {
  const c = { C1: 0, C2: 0, C3: 0, FI: 0 } as Record<'C1' | 'C2' | 'C3' | 'FI', number>;
  for (const o of list) {
    if (o.code && c[o.code] !== undefined) c[o.code] += 1;
  }
  return c;
}

function CountBadge({ label, count, colour }: { label: string; count: number; colour: string }) {
  const isWhite = colour === 'white';
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
      style={{
        background: isWhite ? 'rgba(255,255,255,0.15)' : colour,
        color: isWhite ? 'white' : 'white',
      }}
    >
      <span className="uppercase tracking-[0.08em]">{label}</span>
      <span className="font-mono">{count}</span>
    </span>
  );
}

function ObservationCard({ obs, onRemove }: { obs: ObservationRow; onRemove: () => void }) {
  const code = obs.code;
  const colour = code ? CODE_COLOUR[code] : 'var(--color-text-tertiary)';
  const subtitle = code ? CODE_LABEL[code] : 'Observation';

  return (
    <div className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-[var(--color-border-default)] bg-[var(--color-surface-1)] px-3 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'inline-flex h-7 min-w-[2.25rem] items-center justify-center rounded-full px-2 text-[12px] font-bold text-white'
            )}
            style={{ background: colour }}
          >
            {code ?? '—'}
          </span>
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
              {subtitle}
            </span>
            {obs.location ? (
              <span className="inline-flex items-center gap-1 text-[12px] text-[var(--color-text-secondary)]">
                <MapPin className="h-3 w-3" aria-hidden />
                {obs.location}
              </span>
            ) : null}
          </div>
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] px-2 py-1 text-[11px] font-semibold transition hover:bg-[var(--color-status-failed)]/10"
          style={{ color: 'var(--color-status-failed)' }}
        >
          <Trash2 className="h-3 w-3" aria-hidden />
          Remove
        </button>
      </div>
      {obs.description ? (
        <p className="text-[13.5px] leading-snug text-[var(--color-text-primary)]">
          {obs.description}
        </p>
      ) : null}
      {obs.remedial ? (
        <p className="border-t border-[var(--color-border-default)]/50 pt-2 text-[12.5px] italic text-[var(--color-text-secondary)]">
          <span className="font-semibold not-italic text-[var(--color-text-primary)]">
            Remedial action:
          </span>{' '}
          {obs.remedial}
        </p>
      ) : null}
    </div>
  );
}
