'use client';

import * as React from 'react';
import { MessageSquareText, Ruler } from 'lucide-react';
import { useJobContext } from '@/lib/job-context';
import { SectionCard } from '@/components/ui/section-card';
import { SelectChips } from '@/components/ui/select-chips';

/**
 * Extent & Type tab — mirrors iOS `ExtentTab.swift`.
 *
 * Two sections: "Extent of Work" (scope + installation type picker) and
 * "Comments". Both bodies are multiline text. EIC installation types are
 * the Constants.installationTypes enum lifted from iOS verbatim so the
 * eventual PDF mapping matches.
 *
 * Data shape: `job.extent: Record<string, unknown>` — we keep the string
 * values we care about typed, leave the record permissive so future fields
 * pass through without schema changes.
 */

type ExtentShape = {
  extent?: string;
  installation_type?: string;
  comments?: string;
};

const INSTALLATION_TYPES = [
  { value: 'new_installation', label: 'New installation' },
  { value: 'addition', label: 'Addition' },
  { value: 'alteration', label: 'Alteration' },
  { value: 'consumer_unit_upgrade', label: 'Consumer unit upgrade' },
];

export default function ExtentPage() {
  const { job, certificateType, updateJob } = useJobContext();
  const data = (job.extent ?? {}) as ExtentShape;
  const isEIC = certificateType === 'EIC';

  const patch = React.useCallback(
    (next: Partial<ExtentShape>) => {
      updateJob({ extent: { ...data, ...next } });
    },
    [data, updateJob]
  );

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
        <div className="flex flex-col gap-1">
          <p className="text-[11px] uppercase tracking-[0.14em] text-white/75">{certificateType}</p>
          <h2 className="text-[22px] font-bold text-white md:text-[26px]">
            Extent &amp; Limitations
          </h2>
          <p className="text-[13px] text-white/85">Scope, type &amp; comments</p>
        </div>
        <Ruler className="h-10 w-10 text-white/30" strokeWidth={2} aria-hidden />
      </div>

      <SectionCard accent="blue" icon={Ruler} title="Extent of Work">
        <MultilineField
          label="Extent"
          value={data.extent ?? ''}
          onChange={(v) => patch({ extent: v })}
          rows={4}
          showCount
        />
        {isEIC ? (
          <SelectChips
            label="Installation type"
            value={data.installation_type ?? null}
            options={INSTALLATION_TYPES}
            onChange={(v) => patch({ installation_type: v })}
          />
        ) : null}
      </SectionCard>

      <SectionCard accent="amber" icon={MessageSquareText} title="Comments">
        <MultilineField
          label="Comments"
          value={data.comments ?? ''}
          onChange={(v) => patch({ comments: v })}
          rows={4}
          showCount
        />
      </SectionCard>
    </div>
  );
}

/**
 * MultilineField with optional character counter to match iOS extent screen
 * which displays "N characters" under each textarea.
 */
function MultilineField({
  label,
  value,
  onChange,
  rows = 3,
  showCount = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  showCount?: boolean;
}) {
  const id = React.useId();
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-col rounded-[var(--radius-md)] border border-[var(--color-border-default)] bg-[var(--color-surface-1)] px-3 py-2 transition focus-within:border-[var(--color-brand-blue)]">
        <label
          htmlFor={id}
          className="text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]"
        >
          {label}
        </label>
        <textarea
          id={id}
          rows={rows}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full resize-none bg-transparent text-[15px] font-medium text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)]/60 focus:outline-none"
        />
      </div>
      {showCount ? (
        <p className="pr-1 text-right font-mono text-[11px] text-[var(--color-text-tertiary)]">
          {value.length} characters
        </p>
      ) : null}
    </div>
  );
}
