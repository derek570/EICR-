'use client';

import * as React from 'react';
import {
  CheckCircle2,
  ClipboardCheck,
  Gauge,
  Hammer,
  Info,
  PencilRuler,
  ShieldCheck,
  Signature,
  UserCheck,
  Wrench,
  Zap as ZapIcon,
} from 'lucide-react';
import { api } from '@/lib/api-client';
import { useJobContext } from '@/lib/job-context';
import { useCurrentUser } from '@/lib/use-current-user';
import type { InspectorProfile } from '@/lib/types';
import { HeroHeader } from '@/components/ui/hero-header';
import { SectionCard } from '@/components/ui/section-card';
import { cn } from '@/lib/utils';

/**
 * Staff tab — mirrors iOS `InspectorTab.swift`.
 *
 * EICR shows two role pickers: "Inspected & Tested By" and "Authorised By".
 * EIC shows three: Designer, Constructor, Inspection & Testing. Each role
 * picker is a list of `InspectorProfile`s loaded from
 * `api.inspectorProfiles(user.id)` on mount — same source as the Settings
 * → Staff page so the roster stays in sync. iOS reads from a local GRDB
 * table populated by the same API; PWA has no client-side DB so we fetch
 * each time the tab mounts (cheap — single JSON blob per user).
 *
 * Selecting an inspector also reveals a Test Equipment card showing
 * serial numbers + calibration dates for the 5 test instruments (MFT,
 * Continuity, IR, Earth fault, RCD). Equipment fields live on the PWA
 * `InspectorProfile` extension only; backend stores the profiles blob
 * verbatim so the keys round-trip.
 *
 * State shape (snake_case per JobFormData):
 *   - job.inspector_id
 *   - job.authorised_by_id     (EICR)
 *   - job.designer_id          (EIC)
 *   - job.constructor_id       (EIC)
 */

type StaffJobShape = {
  inspector_id?: string;
  authorised_by_id?: string;
  designer_id?: string;
  constructor_id?: string;
};

export default function StaffPage() {
  const { job, certificateType, updateJob } = useJobContext();
  const { user } = useCurrentUser();
  const isEIC = certificateType === 'EIC';
  const data = job as unknown as StaffJobShape;
  const [inspectors, setInspectors] = React.useState<InspectorProfile[]>([]);

  // Fetch the roster on mount + whenever the signed-in user changes.
  // Errors are swallowed (the empty-state copy already explains what to
  // do); a transient API failure shouldn't blow up the whole tab. Mirrors
  // iOS `InspectorTab.onAppear` which also tolerates an empty roster.
  //
  // Crucially we clear the local roster on every user change *and* on a
  // failed fetch so the picker can never render a previous account's
  // signatories. Without this, `useCurrentUser` flipping to `null` on a
  // 401/403 (its documented session-revoked path) would leave the prior
  // roster visible and the inspector could click a stale id, writing
  // another account's signatory into `job.inspector_id`. Codex review
  // finding on `317d18d`.
  React.useEffect(() => {
    if (!user) {
      setInspectors([]);
      return;
    }
    let cancelled = false;
    void api.inspectorProfiles(user.id).then(
      (list) => {
        if (!cancelled) setInspectors(list);
      },
      () => {
        // On rejection clear the roster — see comment above. Settings →
        // Staff is the canonical place to debug fetch issues, so we
        // intentionally don't surface a toast here.
        if (!cancelled) setInspectors([]);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [user]);

  const setRole = (role: keyof StaffJobShape, id: string) => {
    updateJob({ [role]: id } as Partial<typeof job>);
  };

  // Test-equipment card surfaces the roster entry currently bound to
  // the primary Inspector role (both EICR "Inspected by" and EIC
  // "Inspection & Testing" use inspector_id).
  const activeInspector = inspectors.find((i) => i.id === data.inspector_id);

  return (
    <div
      className="cm-stagger-children mx-auto flex w-full flex-col gap-5 px-4 py-6 md:px-8 md:py-8"
      style={{ maxWidth: '960px' }}
    >
      <HeroHeader
        eyebrow={certificateType}
        title="Staff Assignments"
        subtitle={isEIC ? 'Design, construction & testing' : 'Inspection & authorisation'}
        accent="client"
        icon={<UserCheck className="h-10 w-10" strokeWidth={2} aria-hidden />}
      />

      {isEIC ? (
        <>
          <RolePickerCard
            accent="blue"
            icon={PencilRuler}
            title="Responsible for Design"
            inspectors={inspectors}
            selectedId={data.designer_id}
            onSelect={(id) => setRole('designer_id', id)}
          />
          <RolePickerCard
            accent="amber"
            icon={Hammer}
            title="Responsible for Construction"
            inspectors={inspectors}
            selectedId={data.constructor_id}
            onSelect={(id) => setRole('constructor_id', id)}
          />
          <RolePickerCard
            accent="green"
            icon={ClipboardCheck}
            title="Inspection & Testing"
            inspectors={inspectors}
            selectedId={data.inspector_id}
            onSelect={(id) => setRole('inspector_id', id)}
          />
        </>
      ) : (
        <>
          <RolePickerCard
            accent="blue"
            icon={ShieldCheck}
            title="Inspected and Tested By"
            inspectors={inspectors}
            selectedId={data.inspector_id}
            onSelect={(id) => setRole('inspector_id', id)}
          />
          <RolePickerCard
            accent="magenta"
            icon={Signature}
            title="Authorised By"
            inspectors={inspectors}
            selectedId={data.authorised_by_id}
            onSelect={(id) => setRole('authorised_by_id', id)}
          />
        </>
      )}

      {activeInspector ? <EquipmentCard inspector={activeInspector} /> : null}
    </div>
  );
}

/* ----------------------------------------------------------------------- */

function RolePickerCard({
  accent,
  icon,
  title,
  inspectors,
  selectedId,
  onSelect,
}: {
  accent: 'blue' | 'green' | 'amber' | 'magenta' | 'red';
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean; strokeWidth?: number }>;
  title: string;
  inspectors: InspectorProfile[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}) {
  return (
    <SectionCard accent={accent} icon={icon} title={title}>
      {inspectors.length === 0 ? (
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
            No staff profiles configured yet. Add inspectors under{' '}
            <span className="font-semibold">Settings → Inspectors</span> (Phase 6) — selecting one
            here will auto-fill name, position, enrolment number, signature &amp; test-equipment
            serials on the final PDF.
          </p>
        </div>
      ) : (
        inspectors.map((i) => {
          const selected = i.id === selectedId;
          return (
            <button
              key={i.id}
              type="button"
              onClick={() => onSelect(i.id)}
              aria-pressed={selected}
              className={cn(
                'flex items-center gap-3 rounded-[var(--radius-md)] border px-3 py-2.5 text-left transition',
                selected
                  ? 'border-[var(--color-brand-blue)]/40 bg-[var(--color-brand-blue)]/[0.06]'
                  : 'border-transparent bg-[var(--color-surface-2)] hover:border-[var(--color-border-default)]'
              )}
            >
              <span
                className={cn(
                  'flex h-10 w-10 items-center justify-center rounded-full font-semibold',
                  selected ? 'text-white' : 'text-[var(--color-brand-blue)]'
                )}
                style={{
                  background: selected ? 'var(--color-brand-blue)' : 'rgba(0, 102, 255, 0.12)',
                }}
              >
                {i.name.trim().charAt(0).toUpperCase() || '?'}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[15px] font-medium text-[var(--color-text-primary)]">
                  {i.name}
                </span>
                {i.position ? (
                  <span className="truncate text-[12px] text-[var(--color-text-secondary)]">
                    {i.position}
                  </span>
                ) : null}
              </span>
              {selected ? (
                <CheckCircle2
                  className="h-5 w-5 shrink-0"
                  style={{ color: 'var(--color-brand-green)' }}
                  aria-hidden
                />
              ) : null}
            </button>
          );
        })
      )}
    </SectionCard>
  );
}

/* ----------------------------------------------------------------------- */

function EquipmentCard({ inspector }: { inspector: InspectorProfile }) {
  return (
    <SectionCard accent="green" icon={Wrench} title="Test Equipment">
      <EquipmentRow
        icon={Gauge}
        name="MFT"
        serial={inspector.mft_serial_number}
        calibration={inspector.mft_calibration_date}
      />
      <EquipmentRow
        icon={ZapIcon}
        name="Continuity"
        serial={inspector.continuity_serial_number}
        calibration={inspector.continuity_calibration_date}
      />
      <EquipmentRow
        icon={ShieldCheck}
        name="Insulation Resistance"
        serial={inspector.insulation_serial_number}
        calibration={inspector.insulation_calibration_date}
      />
      <EquipmentRow
        icon={ZapIcon}
        name="Earth Fault Loop"
        serial={inspector.earth_fault_serial_number}
        calibration={inspector.earth_fault_calibration_date}
      />
      <EquipmentRow
        icon={ShieldCheck}
        name="RCD"
        serial={inspector.rcd_serial_number}
        calibration={inspector.rcd_calibration_date}
      />
    </SectionCard>
  );
}

function EquipmentRow({
  icon: Icon,
  name,
  serial,
  calibration,
}: {
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  name: string;
  serial?: string;
  calibration?: string;
}) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span
        className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)]"
        style={{ background: 'rgba(0, 204, 102, 0.12)' }}
      >
        <Icon
          className="h-4 w-4"
          aria-hidden
          {...({ style: { color: 'var(--color-brand-green)' } } as Record<string, unknown>)}
        />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[14px] font-medium text-[var(--color-text-primary)]">{name}</span>
        <div className="flex flex-wrap items-center gap-3 text-[11.5px] text-[var(--color-text-secondary)]">
          <span>
            <span className="mr-1 font-bold" style={{ color: 'var(--color-brand-blue)' }}>
              S/N
            </span>
            {serial ?? '—'}
          </span>
          <span>
            <span className="mr-1 font-bold" style={{ color: 'var(--color-brand-green)' }}>
              Cal
            </span>
            {calibration ?? '—'}
          </span>
        </div>
      </div>
    </div>
  );
}
