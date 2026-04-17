'use client';

import * as React from 'react';
import {
  BathIcon,
  Bolt,
  ClipboardCheck,
  Eye,
  Flame,
  MapPin,
  Shield,
  SlidersHorizontal,
  Wrench,
} from 'lucide-react';
import { useJobContext } from '@/lib/job-context';
import { SectionCard } from '@/components/ui/section-card';
import { cn } from '@/lib/utils';
import {
  EIC_SCHEDULE,
  EICR_SCHEDULE,
  OUTCOME_OPTIONS,
  type ScheduleItem,
  type ScheduleOutcome,
} from '@/lib/constants/inspection-schedule';

/**
 * Inspection Schedule tab — mirrors iOS `InspectionTab.swift`.
 *
 * For EICR the schedule is seven large sections (~90 items) tracking
 * BS 7671 Appendix 6 items. Each row has an outcome chip group
 * (✓, ✗, N/A, LIM, C1, C2, C3, FI) plus per-section progress indicator.
 *
 * For EIC the schedule is the 14 top-level items (§1.0 to §14.0).
 *
 * "Schedule Options" header provides 3 smart toggles matching iOS:
 *   • TT Earthing System — auto-ticks 3.2 & marks 3.1 N/A (or vice versa)
 *   • Microgeneration    — auto-ticks 2.0, 4.11, 4.21, 4.22
 *   • Mark Section 7 N/A — bulk N/A for every 7.xx item
 * These are deliberate shortcuts because the three conditions apply to
 * >80% of UK domestic EICRs — auto-filling saves ~30 taps per certificate.
 *
 * Outcomes are stored as `job.inspection.items: Record<ref, outcome>`
 * (snake_case ref kept verbatim — "4.12", "5.12.1" etc). The backend
 * reads this shape directly when rendering the PDF schedule page.
 */

type InspectionShape = {
  items?: Record<string, ScheduleOutcome | undefined>;
  is_tt_earthing?: boolean;
  has_microgeneration?: boolean;
  mark_section_7_na?: boolean;
};

const EICR_SECTION_ICONS = [Eye, Bolt, Shield, Wrench, ClipboardCheck, BathIcon, Flame, MapPin];
const EICR_SECTION_ACCENTS: Array<'blue' | 'green' | 'amber' | 'magenta' | 'red'> = [
  'blue',
  'amber',
  'green',
  'magenta',
  'blue',
  'green',
  'red',
  'amber',
];

export default function InspectionPage() {
  const { job, certificateType, updateJob } = useJobContext();
  const isEIC = certificateType === 'EIC';
  const insp = (job.inspection ?? {}) as InspectionShape;
  const items = insp.items ?? {};

  const patch = React.useCallback(
    (next: Partial<InspectionShape>) => {
      updateJob({ inspection: { ...insp, ...next } });
    },
    [insp, updateJob]
  );

  const setOutcome = (ref: string, outcome: ScheduleOutcome) => {
    patch({ items: { ...items, [ref]: outcome === items[ref] ? undefined : outcome } });
  };

  // --- Auto-fill shortcuts -------------------------------------------------

  const setTTEarthing = (on: boolean) => {
    const next = { ...items };
    if (on) {
      next['3.1'] = 'N/A';
      next['3.2'] = '✓';
    } else {
      next['3.1'] = '✓';
      next['3.2'] = 'N/A';
    }
    patch({ is_tt_earthing: on, items: next });
  };

  const setMicrogeneration = (on: boolean) => {
    const next = { ...items };
    const refs = ['2.0', '4.11', '4.21', '4.22'];
    for (const r of refs) next[r] = on ? '✓' : 'N/A';
    patch({ has_microgeneration: on, items: next });
  };

  const setSection7NA = (on: boolean) => {
    const next = { ...items };
    if (on) {
      for (const item of EICR_SCHEDULE[6].items) next[item.ref] = 'N/A';
    } else {
      for (const item of EICR_SCHEDULE[6].items) delete next[item.ref];
    }
    patch({ mark_section_7_na: on, items: next });
  };

  // Refs that are auto-controlled by the three toggles — disabled to stop
  // inspectors accidentally overriding the auto-fill mid-save.
  const autoControlled = React.useMemo(() => {
    const refs = new Set<string>();
    if (insp.is_tt_earthing !== undefined) {
      refs.add('3.1');
      refs.add('3.2');
    }
    if (insp.has_microgeneration !== undefined) {
      refs.add('2.0');
      refs.add('4.11');
      refs.add('4.21');
      refs.add('4.22');
    }
    if (insp.mark_section_7_na) {
      for (const item of EICR_SCHEDULE[6].items) refs.add(item.ref);
    }
    return refs;
  }, [insp.is_tt_earthing, insp.has_microgeneration, insp.mark_section_7_na]);

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
          <h2 className="text-[22px] font-bold text-white md:text-[26px]">Inspection Schedule</h2>
          <p className="text-[13px] text-white/85">
            {isEIC ? 'Design, construction & verification' : 'Periodic inspection & testing'}
          </p>
        </div>
        <ClipboardCheck className="h-10 w-10 text-white/30" strokeWidth={2} aria-hidden />
      </div>

      {!isEIC ? (
        <SectionCard accent="blue" icon={SlidersHorizontal} title="Schedule Options">
          <ToggleRow
            label="TT Earthing System"
            hint={insp.is_tt_earthing ? '3.2 ticked, 3.1 marked N/A' : '3.1 ticked, 3.2 marked N/A'}
            value={insp.is_tt_earthing === true}
            onChange={setTTEarthing}
          />
          <ToggleRow
            label="Microgeneration / Solar / Batteries"
            hint={
              insp.has_microgeneration
                ? 'Items 2.0, 4.11, 4.21, 4.22 ticked'
                : 'Items 2.0, 4.11, 4.21, 4.22 marked N/A'
            }
            value={insp.has_microgeneration === true}
            onChange={setMicrogeneration}
          />
          <ToggleRow
            label="Mark all Section 7 as N/A"
            hint="Special locations not present"
            value={insp.mark_section_7_na === true}
            onChange={setSection7NA}
          />
        </SectionCard>
      ) : null}

      {isEIC
        ? // EIC: 14 top-level items rendered as a single card
          (() => (
            <SectionCard accent="blue" icon={ClipboardCheck} title="EIC Inspection Schedule">
              {EIC_SCHEDULE.map((item) => (
                <ScheduleRow
                  key={item.ref}
                  item={item}
                  outcome={items[item.ref]}
                  onSelect={(o) => setOutcome(item.ref, o)}
                />
              ))}
            </SectionCard>
          ))()
        : // EICR: 7 sections, each its own SectionCard with progress header
          EICR_SCHEDULE.map((section, sectionIndex) => {
            const sectionItems = section.items;
            const answered = sectionItems.filter(
              (i) => items[i.ref] !== undefined || autoControlled.has(i.ref)
            ).length;
            const Icon = EICR_SECTION_ICONS[sectionIndex % EICR_SECTION_ICONS.length];
            const accent = EICR_SECTION_ACCENTS[sectionIndex % EICR_SECTION_ACCENTS.length];
            return (
              <SectionCard key={section.title} accent={accent} icon={Icon} title={section.title}>
                <div className="flex items-center justify-between gap-2 pb-1">
                  <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
                    Progress
                  </span>
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'font-mono text-[11px] font-bold',
                        answered === sectionItems.length
                          ? 'text-[var(--color-brand-green)]'
                          : 'text-[var(--color-text-tertiary)]'
                      )}
                    >
                      {answered}/{sectionItems.length}
                    </span>
                    <div className="h-1 w-10 overflow-hidden rounded-full bg-[var(--color-surface-3)]">
                      <div
                        className="h-full transition-all"
                        style={{
                          width: `${sectionItems.length === 0 ? 0 : (answered / sectionItems.length) * 100}%`,
                          background:
                            answered === sectionItems.length
                              ? 'var(--color-brand-green)'
                              : 'var(--color-brand-blue)',
                        }}
                      />
                    </div>
                  </div>
                </div>
                {sectionItems.map((item) => (
                  <ScheduleRow
                    key={item.ref}
                    item={item}
                    outcome={items[item.ref]}
                    onSelect={(o) => setOutcome(item.ref, o)}
                    autoControlled={autoControlled.has(item.ref)}
                  />
                ))}
              </SectionCard>
            );
          })}
    </div>
  );
}

/* ----------------------------------------------------------------------- */

function ToggleRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-1 border-b border-[var(--color-border-default)]/40 pb-3 last:border-b-0 last:pb-0">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[14px] font-medium text-[var(--color-text-primary)]">{label}</span>
        <button
          type="button"
          role="switch"
          aria-checked={value}
          onClick={() => onChange(!value)}
          className={cn(
            'relative inline-flex h-6 w-11 shrink-0 rounded-full border border-transparent transition',
            value ? 'bg-[var(--color-brand-blue)]' : 'bg-[var(--color-surface-3)]'
          )}
        >
          <span
            aria-hidden
            className={cn(
              'inline-block h-5 w-5 translate-x-0.5 translate-y-0.5 rounded-full bg-white shadow transition',
              value && 'translate-x-[22px]'
            )}
          />
        </button>
      </div>
      <div className="flex items-center gap-2">
        <span
          className="rounded-full px-1.5 py-0.5 text-[10px] font-bold text-white"
          style={{ background: 'var(--color-brand-blue)' }}
        >
          Auto
        </span>
        <span className="text-[12px] text-[var(--color-text-secondary)]">{hint}</span>
      </div>
    </div>
  );
}

function ScheduleRow({
  item,
  outcome,
  onSelect,
  autoControlled,
}: {
  item: ScheduleItem;
  outcome?: ScheduleOutcome;
  onSelect: (outcome: ScheduleOutcome) => void;
  autoControlled?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-[var(--radius-sm)] border border-transparent px-2 py-2 transition',
        autoControlled && 'opacity-60'
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className="mt-0.5 w-11 shrink-0 font-mono text-[11.5px] font-bold"
          style={{ color: 'var(--color-brand-blue)' }}
        >
          {item.ref}
        </span>
        <p className="flex-1 text-[12.5px] leading-snug text-[var(--color-text-primary)]">
          {item.description}
        </p>
        {autoControlled ? (
          <span
            className="ml-1 shrink-0 rounded-full px-1.5 py-0.5 text-[9.5px] font-bold uppercase text-white"
            style={{ background: 'var(--color-brand-blue)' }}
          >
            Auto
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1 pl-14">
        {OUTCOME_OPTIONS.map((opt) => {
          const selected = outcome === opt;
          return (
            <button
              key={opt}
              type="button"
              disabled={autoControlled}
              onClick={() => onSelect(opt)}
              aria-pressed={selected}
              className={cn(
                'min-w-[2rem] rounded-full border px-2 py-0.5 text-[11px] font-bold transition',
                selected
                  ? 'border-transparent text-white'
                  : 'border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]',
                autoControlled && 'cursor-not-allowed'
              )}
              style={selected ? { background: outcomeColour(opt) } : undefined}
            >
              {opt}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function outcomeColour(o: ScheduleOutcome): string {
  switch (o) {
    case '✓':
      return 'var(--color-brand-green)';
    case '✗':
    case 'C1':
      return 'var(--color-status-failed)';
    case 'LIM':
    case 'C2':
      return 'var(--color-status-processing)';
    case 'C3':
      return 'var(--color-brand-blue)';
    case 'FI':
      return 'var(--color-status-limitation)';
    case 'N/A':
    default:
      return 'var(--color-text-tertiary)';
  }
}
