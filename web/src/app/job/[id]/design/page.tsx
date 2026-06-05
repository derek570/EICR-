'use client';

import * as React from 'react';
import { AlertTriangle, CheckCircle2, Info, PencilRuler } from 'lucide-react';
import { useJobContext } from '@/lib/job-context';
import { HeroHeader } from '@/components/ui/hero-header';
import { MultilineField } from '@/components/ui/multiline-field';
import { SectionCard } from '@/components/ui/section-card';

/**
 * Design & Construction tab — mirrors iOS `DesignTab.swift`.
 *
 * A single section capturing BS 7671 departures. Includes the iOS "No
 * Departures" green capsule shortcut that prefills both fields with the
 * standard N/A strings so inspectors aren't retyping the same answer on
 * every unremarkable certificate.
 *
 * Data shape: `job.design_construction.departures_from_bs7671` + `departure_details`
 * strings. Snake_case to match the backend JobFormData persistence.
 */

type DesignShape = {
  departures_from_bs7671?: string;
  departure_details?: string;
};

export default function DesignPage() {
  const { job, certificateType, updateJob } = useJobContext();
  // Memo-wrap the `?? {}` fallback so the identity stays stable across
  // renders when `job.design_construction` doesn't change. Without the memo,
  // `data` is a fresh object on every render, which makes the useCallback
  // below rebuild `patch` on every render and defeats the memoisation
  // entirely (flagged by react-hooks/exhaustive-deps).
  const data = React.useMemo<DesignShape>(
    () => (job.design_construction ?? {}) as DesignShape,
    [job.design_construction]
  );

  const patch = React.useCallback(
    (next: Partial<DesignShape>) => {
      updateJob({ design_construction: { ...data, ...next } });
    },
    [data, updateJob]
  );

  const showShortcut = !(data.departures_from_bs7671 ?? '').trim();

  return (
    <div
      className="cm-stagger-children mx-auto flex w-full flex-col gap-5 px-4 py-6 md:px-8 md:py-8"
      style={{ maxWidth: '960px' }}
    >
      <HeroHeader
        eyebrow={certificateType}
        title="Design & Construction"
        subtitle="BS 7671 compliance"
        accent="notes"
        icon={<PencilRuler className="h-10 w-10" strokeWidth={2} aria-hidden />}
      />

      <SectionCard accent="amber" icon={AlertTriangle} title="Departures from BS 7671">
        <div
          className="flex items-start gap-2 rounded-[var(--radius-md)] px-3 py-2.5"
          style={{ background: 'rgba(0, 102, 255, 0.06)' }}
        >
          <Info
            className="mt-0.5 h-4 w-4 shrink-0"
            style={{ color: 'var(--color-brand-blue)' }}
            aria-hidden
          />
          <p className="text-[12.5px] leading-snug text-[var(--color-text-secondary)]">
            Record any departures from BS 7671 and the reasons for them.
          </p>
        </div>

        {showShortcut ? (
          <button
            type="button"
            onClick={() =>
              patch({
                departures_from_bs7671: 'No departures',
                departure_details: 'N/A',
              })
            }
            className="inline-flex w-fit items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold transition hover:bg-[var(--color-brand-green)]/15"
            style={{
              color: 'var(--color-brand-green)',
              borderColor: 'rgba(0, 204, 102, 0.2)',
              background: 'rgba(0, 204, 102, 0.08)',
            }}
          >
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
            No Departures
          </button>
        ) : null}

        <MultilineField
          label="Departures"
          value={data.departures_from_bs7671 ?? ''}
          onChange={(v) => patch({ departures_from_bs7671: v })}
          rows={4}
        />
        <MultilineField
          label="Departure details"
          value={data.departure_details ?? ''}
          onChange={(v) => patch({ departure_details: v })}
          rows={4}
        />
      </SectionCard>
    </div>
  );
}
