'use client';

import * as React from 'react';
import { MessageSquareText, Ruler } from 'lucide-react';
import { useJobContext } from '@/lib/job-context';
import { HeroHeader } from '@/components/ui/hero-header';
import { MultilineField } from '@/components/ui/multiline-field';
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
 * Data shape: `job.extent_and_type: Record<string, unknown>` — we keep the string
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
  // See DesignPage for the rationale — memo-wrap keeps identity stable
  // so `patch` isn't rebuilt every render.
  const data = React.useMemo<ExtentShape>(
    () => (job.extent_and_type ?? {}) as ExtentShape,
    [job.extent_and_type]
  );
  const isEIC = certificateType === 'EIC';

  const patch = React.useCallback(
    (next: Partial<ExtentShape>) => {
      updateJob({ extent_and_type: { ...data, ...next } });
    },
    [data, updateJob]
  );

  return (
    <div
      className="cm-stagger-children mx-auto flex w-full flex-col gap-5 px-4 py-6 md:px-8 md:py-8"
      style={{ maxWidth: '960px' }}
    >
      <HeroHeader
        eyebrow={certificateType}
        title="Extent & Limitations"
        subtitle="Scope, type & comments"
        accent="notes"
        icon={<Ruler className="h-10 w-10" strokeWidth={2} aria-hidden />}
      />

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
