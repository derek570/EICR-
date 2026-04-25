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
import { MultilineField } from '@/components/ui/multiline-field';
import { NumericStepper } from '@/components/ui/numeric-stepper';
import { HeroHeader } from '@/components/ui/hero-header';
import { SectionCard } from '@/components/ui/section-card';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { SelectChips } from '@/components/ui/select-chips';
import { usePostcodeLookup } from '@/hooks/use-postcode-lookup';

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
  // See DesignPage for the rationale — memo-wrap keeps identity stable
  // so `patch` isn't rebuilt every render.
  const details = React.useMemo<InstallationShape>(
    () => (job.installation_details ?? {}) as InstallationShape,
    [job.installation_details]
  );

  const patch = React.useCallback(
    (next: Partial<InstallationShape>) => {
      updateJob({ installation_details: { ...details, ...next } });
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

  // -----------------------------------------------------------------
  // Debounced postcode autocomplete — mirrors iOS InstallationTab
  // `schedulePostcodeLookup` / `performPostcodeLookup` at L251-L306.
  // One hook per field so their memo caches stay independent.
  //
  // The 400ms debounce matches iOS and is the sweet spot between
  // "inspector types fast, only fire once" and "feels responsive
  // when they paste a value in". The hook also normalises + memos
  // internally — we only need to plumb the onChange + patch back in.
  //
  // Fill-empty-only semantics: we only overwrite town/county if the
  // user hasn't typed a value there already. This matches the iOS
  // backend's `enrichInstallationDetails()` and the obvious UX
  // expectation (manual edits win over postcodes.io's opinion).
  // -----------------------------------------------------------------
  const installationPostcodeLookup = usePostcodeLookup({
    onResolved: ({ postcode, town, county }) => {
      const next: Partial<InstallationShape> = { postcode };
      if (!details.town) next.town = town;
      if (!details.county) next.county = county;
      patch(next);
    },
  });
  const clientPostcodeLookup = usePostcodeLookup({
    onResolved: ({ postcode, town, county }) => {
      const next: Partial<InstallationShape> = { client_postcode: postcode };
      if (!details.client_town) next.client_town = town;
      if (!details.client_county) next.client_county = county;
      patch(next);
    },
  });

  // -----------------------------------------------------------------
  // N/A sentinel for "Date of previous inspection" (EICR only).
  // iOS `CMDatePickerStringField` stores either a date string or the
  // literal "N/A". The web input is a native `<input type="date">` so
  // we can't show "N/A" inside it — instead we toggle the visible
  // input to a disabled greyed-out placeholder when the value is
  // "N/A", and show a small pill-button that swaps between the two
  // states. Tapping N/A when set clears it back to an editable date.
  // -----------------------------------------------------------------
  const isPreviousNA = details.date_of_previous_inspection === 'N/A';
  const togglePreviousNA = () => {
    if (isPreviousNA) {
      patch({ date_of_previous_inspection: undefined });
    } else {
      patch({ date_of_previous_inspection: 'N/A' });
    }
  };

  // -----------------------------------------------------------------
  // Auto-seed defaults on first mount — iOS parity
  // (`ensureDateOfInspection` + default `next_inspection_years = 5`
  // at `InstallationTab.swift:L503-L527`).
  //
  // We run this once-per-mount and guard with a ref so a parent
  // re-render (e.g. the job saving in the background) can't re-trigger
  // the seed after the user has deliberately cleared a field. Also
  // avoids the classic pitfall of reading `details` from closure —
  // we compute the seed patch inline off the passed `job`.
  // -----------------------------------------------------------------
  const seededRef = React.useRef(false);
  React.useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    const seed: Partial<InstallationShape> = {};
    if (!details.date_of_inspection) {
      seed.date_of_inspection = new Date().toISOString().slice(0, 10);
    }
    if (details.next_inspection_years == null) {
      seed.next_inspection_years = 5;
    }
    if (!details.next_inspection_due_date) {
      const baseIso = seed.date_of_inspection ?? details.date_of_inspection;
      const years = seed.next_inspection_years ?? details.next_inspection_years ?? 5;
      const base = baseIso ? new Date(baseIso) : new Date();
      const due = new Date(base);
      due.setFullYear(base.getFullYear() + years);
      seed.next_inspection_due_date = due.toISOString().slice(0, 10);
    }
    if (Object.keys(seed).length > 0) {
      patch(seed);
    }
    // `patch` changes identity per render (memoised on details), but
    // the ref guard prevents re-entry, so we can safely depend only on
    // the mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="cm-stagger-children mx-auto flex w-full flex-col gap-5 px-4 py-6 md:px-8 md:py-8"
      style={{ maxWidth: '960px' }}
    >
      {/* Hero banner — iOS parity ("Installation Details" / gradient). */}
      <HeroHeader
        eyebrow={certificateType}
        title="Installation Details"
        subtitle="Client, premises & dates"
        accent="client"
        icon={<Building2 className="h-10 w-10" strokeWidth={2} aria-hidden />}
      />

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
            onChange={(e) => {
              const v = e.target.value;
              patch({ client_postcode: v });
              clientPostcodeLookup.onChange(v);
            }}
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
            onChange={(e) => {
              const v = e.target.value;
              patch({ postcode: v });
              installationPostcodeLookup.onChange(v);
            }}
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
            <div className="flex flex-col gap-1.5">
              <FloatingLabelInput
                label="Date of previous inspection"
                type="date"
                // When the inspector has flipped the N/A sentinel on,
                // the native date input can't render "N/A" — blank
                // the field and disable keyboard entry until they
                // toggle the pill off again.
                disabled={isPreviousNA}
                value={isPreviousNA ? '' : (details.date_of_previous_inspection ?? '')}
                onChange={(e) => patch({ date_of_previous_inspection: e.target.value })}
                trailing={
                  <button
                    type="button"
                    onClick={togglePreviousNA}
                    aria-pressed={isPreviousNA}
                    aria-label="Mark previous inspection as not available"
                    className={`rounded-full px-2 py-0.5 text-[11px] font-semibold transition ${
                      isPreviousNA
                        ? 'bg-[var(--color-brand-blue)] text-white'
                        : 'bg-[var(--color-surface-2)] text-[var(--color-text-secondary)]'
                    }`}
                  >
                    N/A
                  </button>
                }
              />
              {isPreviousNA ? (
                <p className="text-[11px] text-[var(--color-text-tertiary)]">
                  No previous inspection on record.
                </p>
              ) : null}
            </div>
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
