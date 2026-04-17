'use client';

import * as React from 'react';
import {
  Building2,
  Calendar,
  CheckCircle,
  ClipboardList,
  FileText,
  Home,
  Ruler,
  ShieldCheck,
  User,
} from 'lucide-react';
import { useJobContext } from '@/lib/job-context';
import { FloatingLabelInput } from '@/components/ui/floating-label-input';
import { NumericStepper } from '@/components/ui/numeric-stepper';
import { SectionCard } from '@/components/ui/section-card';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { SelectChips } from '@/components/ui/select-chips';

/**
 * Installation tab — mirrors iOS `InstallationTab.swift` field-for-field.
 *
 * Sections (EICR + EIC):
 *   · Client details           (name, address parts, phone, email)
 *   · Installation address     (address parts, occupier)
 *   · Inspection dates         (inspection date, previous date, years, next due)
 *   · Premises                 (description, records + evidence toggles)
 *
 * Sections (EICR only):
 *   · Previous inspection      (cert number, estimated age)
 *   · Report details           (reason for report)
 *   · General condition        (free-text condition summary)
 *   · Extent & limitations     (extent, agreed limitations, agreed with, operational)
 *
 * Save model: every change calls `updateJob` which merges locally and flips
 * the dirty flag. The debounced POST lands in Phase 4 alongside recording —
 * for now the shape is correct and persistence is purely in-memory.
 */

type InstallationShape = {
  client_name?: string;
  client_address?: string;
  client_town?: string;
  client_county?: string;
  client_postcode?: string;
  client_phone?: string;
  client_email?: string;

  address?: string;
  town?: string;
  county?: string;
  postcode?: string;
  occupier_name?: string;

  date_of_inspection?: string; // ISO yyyy-mm-dd
  date_of_previous_inspection?: string;
  next_inspection_years?: number;
  next_inspection_due_date?: string;

  premises_description?: string;
  installation_records_available?: boolean;
  evidence_of_additions_alterations?: boolean;

  previous_certificate_number?: string;
  estimated_age_of_installation?: string;

  reason_for_report?: string;
  general_condition_of_installation?: string;

  extent?: string;
  agreed_limitations?: string;
  agreed_with?: string;
  operational_limitations?: string;
};

const PREMISES_OPTIONS = [
  { value: 'Residential', label: 'Residential' },
  { value: 'Commercial', label: 'Commercial' },
  { value: 'Industrial', label: 'Industrial' },
  { value: 'Other', label: 'Other' },
];

export default function InstallationPage() {
  const { job, certificateType, updateJob } = useJobContext();
  const isEIC = certificateType === 'EIC';
  const details = (job.installation ?? {}) as InstallationShape;

  const patch = React.useCallback(
    (next: Partial<InstallationShape>) => {
      updateJob({ installation: { ...details, ...next } });
    },
    [details, updateJob]
  );

  /** Compute next-due from date_of_inspection + years for instant feedback. */
  const setYears = (years: number | '') => {
    if (years === '') return patch({ next_inspection_years: undefined });
    const base = details.date_of_inspection ? new Date(details.date_of_inspection) : new Date();
    const due = new Date(base);
    due.setFullYear(base.getFullYear() + years);
    patch({
      next_inspection_years: years,
      next_inspection_due_date: due.toISOString().slice(0, 10),
    });
  };

  return (
    <div
      className="mx-auto flex w-full flex-col gap-5 px-4 py-6 md:px-8 md:py-8"
      style={{ maxWidth: '960px' }}
    >
      {/* Hero banner — iOS parity ("Installation Details" / gradient). */}
      <div
        className="relative flex items-center justify-between overflow-hidden rounded-[var(--radius-xl)] px-5 py-5 md:px-6 md:py-6"
        style={{
          background:
            'linear-gradient(135deg, var(--color-brand-blue) 0%, var(--color-brand-green) 100%)',
        }}
      >
        <div className="flex flex-col gap-1">
          <p className="text-[11px] uppercase tracking-[0.14em] text-white/75">{certificateType}</p>
          <h2 className="text-[22px] font-bold text-white md:text-[26px]">Installation Details</h2>
          <p className="text-[13px] text-white/85">Client, premises &amp; dates</p>
        </div>
        <Building2 className="h-10 w-10 text-white/30" strokeWidth={2} aria-hidden />
      </div>

      <SectionCard accent="blue" icon={User} title="Client details">
        <FloatingLabelInput
          label="Client name"
          value={details.client_name ?? ''}
          onChange={(e) => patch({ client_name: e.target.value })}
        />
        <FloatingLabelInput
          label="Client address"
          value={details.client_address ?? ''}
          onChange={(e) => patch({ client_address: e.target.value })}
        />
        <div className="grid gap-3 md:grid-cols-2">
          <FloatingLabelInput
            label="Town / City"
            value={details.client_town ?? ''}
            onChange={(e) => patch({ client_town: e.target.value })}
          />
          <FloatingLabelInput
            label="County"
            value={details.client_county ?? ''}
            onChange={(e) => patch({ client_county: e.target.value })}
          />
          <FloatingLabelInput
            label="Postcode"
            value={details.client_postcode ?? ''}
            onChange={(e) => patch({ client_postcode: e.target.value })}
          />
          <FloatingLabelInput
            label="Phone"
            inputMode="tel"
            value={details.client_phone ?? ''}
            onChange={(e) => patch({ client_phone: e.target.value })}
          />
        </div>
        <FloatingLabelInput
          label="Email"
          type="email"
          inputMode="email"
          autoCapitalize="none"
          value={details.client_email ?? ''}
          onChange={(e) => patch({ client_email: e.target.value })}
        />
      </SectionCard>

      <SectionCard accent="blue" icon={Home} title="Installation address">
        <FloatingLabelInput
          label="Address"
          value={details.address ?? ''}
          onChange={(e) => patch({ address: e.target.value })}
        />
        <div className="grid gap-3 md:grid-cols-2">
          <FloatingLabelInput
            label="Town / City"
            value={details.town ?? ''}
            onChange={(e) => patch({ town: e.target.value })}
          />
          <FloatingLabelInput
            label="County"
            value={details.county ?? ''}
            onChange={(e) => patch({ county: e.target.value })}
          />
          <FloatingLabelInput
            label="Postcode"
            value={details.postcode ?? ''}
            onChange={(e) => patch({ postcode: e.target.value })}
          />
          <FloatingLabelInput
            label="Occupier name"
            value={details.occupier_name ?? ''}
            onChange={(e) => patch({ occupier_name: e.target.value })}
          />
        </div>
      </SectionCard>

      <SectionCard accent="green" icon={Calendar} title="Inspection dates">
        <div className="grid gap-3 md:grid-cols-2">
          <FloatingLabelInput
            label="Date of inspection"
            type="date"
            value={details.date_of_inspection ?? ''}
            onChange={(e) => patch({ date_of_inspection: e.target.value })}
          />
          {!isEIC ? (
            <FloatingLabelInput
              label="Date of previous inspection"
              type="date"
              value={details.date_of_previous_inspection ?? ''}
              onChange={(e) => patch({ date_of_previous_inspection: e.target.value })}
            />
          ) : null}
          <NumericStepper
            label="Next inspection (years)"
            value={details.next_inspection_years ?? ''}
            onValueChange={setYears}
            min={1}
            max={10}
            step={1}
          />
          <FloatingLabelInput
            label="Next inspection due"
            type="date"
            value={details.next_inspection_due_date ?? ''}
            onChange={(e) => patch({ next_inspection_due_date: e.target.value })}
          />
        </div>
      </SectionCard>

      <SectionCard accent="blue" icon={Home} title="Premises">
        <SelectChips
          label="Description"
          value={details.premises_description ?? null}
          onChange={(v) => patch({ premises_description: v })}
          options={PREMISES_OPTIONS}
        />

        {!isEIC ? (
          <div className="flex flex-col gap-2">
            <label className="text-[11px] uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
              Installation records available?
            </label>
            <SegmentedControl
              aria-label="Installation records available"
              value={
                details.installation_records_available === true
                  ? 'yes'
                  : details.installation_records_available === false
                    ? 'no'
                    : null
              }
              onChange={(v) => patch({ installation_records_available: v === 'yes' })}
              options={[
                { value: 'yes', label: 'Yes', variant: 'pass' },
                { value: 'no', label: 'No', variant: 'fail' },
              ]}
            />
            <label className="mt-2 text-[11px] uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
              Evidence of additions / alterations?
            </label>
            <SegmentedControl
              aria-label="Evidence of additions or alterations"
              value={
                details.evidence_of_additions_alterations === true
                  ? 'yes'
                  : details.evidence_of_additions_alterations === false
                    ? 'no'
                    : null
              }
              onChange={(v) => patch({ evidence_of_additions_alterations: v === 'yes' })}
              options={[
                { value: 'yes', label: 'Yes', variant: 'pass' },
                { value: 'no', label: 'No', variant: 'fail' },
              ]}
            />
          </div>
        ) : null}
      </SectionCard>

      {!isEIC ? (
        <>
          <SectionCard accent="green" icon={ClipboardList} title="Previous inspection">
            <div className="grid gap-3 md:grid-cols-2">
              <FloatingLabelInput
                label="Previous certificate number"
                value={details.previous_certificate_number ?? ''}
                onChange={(e) => patch({ previous_certificate_number: e.target.value })}
              />
              <FloatingLabelInput
                label="Estimated age (years)"
                inputMode="numeric"
                value={details.estimated_age_of_installation ?? ''}
                onChange={(e) => patch({ estimated_age_of_installation: e.target.value })}
              />
            </div>
          </SectionCard>

          <SectionCard accent="amber" icon={FileText} title="Report details">
            <MultilineField
              label="Reason for report"
              value={details.reason_for_report ?? ''}
              onChange={(v) => patch({ reason_for_report: v })}
              rows={3}
            />
          </SectionCard>

          <SectionCard accent="green" icon={ShieldCheck} title="General condition">
            <MultilineField
              label="General condition of installation"
              value={details.general_condition_of_installation ?? ''}
              onChange={(v) => patch({ general_condition_of_installation: v })}
              rows={4}
            />
          </SectionCard>

          <SectionCard accent="magenta" icon={Ruler} title="Extent & limitations">
            <MultilineField
              label="Extent of installation covered"
              value={details.extent ?? ''}
              onChange={(v) => patch({ extent: v })}
              rows={3}
            />
            <MultilineField
              label="Agreed limitations"
              value={details.agreed_limitations ?? ''}
              onChange={(v) => patch({ agreed_limitations: v })}
              rows={3}
            />
            <FloatingLabelInput
              label="Agreed with"
              value={details.agreed_with ?? ''}
              onChange={(e) => patch({ agreed_with: e.target.value })}
            />
            <MultilineField
              label="Operational limitations"
              value={details.operational_limitations ?? ''}
              onChange={(v) => patch({ operational_limitations: v })}
              rows={3}
            />
          </SectionCard>
        </>
      ) : null}

      {/* Staff hint — full staff CRUD lives on /staff tab. */}
      <SectionCard
        accent="blue"
        icon={CheckCircle}
        title="Staff"
        subtitle="Inspector assignment lives on the Staff tab."
        showCodeChip
      />
    </div>
  );
}

/* ----------------------------------------------------------------------- */

/**
 * MultilineField — FloatingLabelInput's shape with a textarea.
 * Inline here (vs. a primitive) because only the Report Notes block
 * on Installation/Extent actually wants multi-line input.
 */
function MultilineField({
  label,
  value,
  onChange,
  rows = 3,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
}) {
  const id = React.useId();
  return (
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
  );
}
