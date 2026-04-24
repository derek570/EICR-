'use client';

import * as React from 'react';
import { useParams } from 'next/navigation';
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
import { HeroHeader } from '@/components/ui/hero-header';
import { SectionCard } from '@/components/ui/section-card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ObservationSheet } from '@/components/observations/observation-sheet';
import type { ObservationRow } from '@/lib/types';
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
 *
 * Phase 4 additions (iOS parity):
 *   - Linked-observation inline preview under outcomes — tapping opens
 *     the ObservationSheet for in-place editing (InspectionTab.swift:L266-L284).
 *   - Inline create-observation form on C1/C2/C3 click when none is
 *     linked yet (InspectionTab.swift:L286-L300).
 *   - Confirm-before-unlink when an outcome is changed away from a code
 *     that linked an observation (InspectionTab.swift:L43-L66).
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

const OBSERVATION_CODES: ReadonlyArray<ScheduleOutcome> = ['C1', 'C2', 'C3'];

function outcomeToObservationCode(
  outcome: ScheduleOutcome | undefined
): NonNullable<ObservationRow['code']> | null {
  if (!outcome) return null;
  if (outcome === 'C1' || outcome === 'C2' || outcome === 'C3') return outcome;
  if (outcome === 'FI') return 'FI';
  return null;
}

function makeObservationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `obs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export default function InspectionPage() {
  const { job, certificateType, updateJob } = useJobContext();
  const params = useParams<{ id: string }>();
  const jobId = params?.id ?? '';
  const isEIC = certificateType === 'EIC';
  const insp = React.useMemo<InspectionShape>(
    () => (job.inspection ?? {}) as InspectionShape,
    [job.inspection]
  );
  const items = insp.items ?? {};
  const observations = React.useMemo(() => job.observations ?? [], [job.observations]);

  const patch = React.useCallback(
    (next: Partial<InspectionShape>) => {
      updateJob({ inspection: { ...insp, ...next } });
    },
    [insp, updateJob]
  );

  /**
   * Find the observation linked to a given schedule row. iOS stores the
   * link on the observation side (`observation.schedule_item === ref`);
   * web mirrors that so a round-trip via the backend is lossless.
   */
  const observationForRef = React.useCallback(
    (ref: string): ObservationRow | undefined =>
      observations.find((o) => {
        const asAny = o as ObservationRow & { schedule_item?: string };
        return asAny.schedule_item === ref;
      }),
    [observations]
  );

  /**
   * Core setOutcome. Handles all four phase-4 flows:
   *   1. Plain outcome change with no linked observation → write.
   *   2. Selecting C1/C2/C3 on an empty row → open the inline form.
   *   3. Re-selecting the same outcome → clear it.
   *   4. Changing an outcome that has a linked observation → open the
   *      unlink-confirm dialog.
   */
  const [inlineFormRef, setInlineFormRef] = React.useState<string | null>(null);
  const [pendingChange, setPendingChange] = React.useState<{
    ref: string;
    nextOutcome: ScheduleOutcome | null;
  } | null>(null);

  const commitOutcome = (ref: string, nextOutcome: ScheduleOutcome | null) => {
    const next: Record<string, ScheduleOutcome | undefined> = { ...items };
    if (nextOutcome === null) {
      delete next[ref];
    } else {
      next[ref] = nextOutcome;
    }
    patch({ items: next });
  };

  const setOutcome = (ref: string, requested: ScheduleOutcome) => {
    const current = items[ref];
    const toggleOff = requested === current;
    const nextOutcome: ScheduleOutcome | null = toggleOff ? null : requested;

    const linked = observationForRef(ref);

    // Re-tapping the same outcome toggles it off. If there's a linked
    // observation, the unlink-confirm flow still applies.
    if (linked) {
      const linkedCode = linked.code;
      // Picking a non-observation outcome OR a different observation
      // code OR toggling off — all of these break the link.
      const willKeepLink =
        nextOutcome !== null && outcomeToObservationCode(nextOutcome) === linkedCode;
      if (!willKeepLink) {
        setPendingChange({ ref, nextOutcome });
        return;
      }
      // Same code chosen again → no-op, leave link alone.
      commitOutcome(ref, nextOutcome);
      return;
    }

    // No linked observation yet. If the user picked C1 / C2 / C3 we
    // open the inline form and defer the outcome write to the save
    // handler — matches iOS behaviour where the form IS the outcome
    // confirmation.
    if (!toggleOff && OBSERVATION_CODES.includes(requested)) {
      commitOutcome(ref, nextOutcome);
      setInlineFormRef(ref);
      return;
    }

    commitOutcome(ref, nextOutcome);
  };

  const confirmUnlink = () => {
    if (!pendingChange) return;
    const linked = observationForRef(pendingChange.ref);
    // Apply outcome + drop the observation atomically so the backend
    // only writes once. Mirrors iOS confirmPendingOutcomeChange.
    const nextItems: Record<string, ScheduleOutcome | undefined> = { ...items };
    if (pendingChange.nextOutcome === null) {
      delete nextItems[pendingChange.ref];
    } else {
      nextItems[pendingChange.ref] = pendingChange.nextOutcome;
    }
    const nextObservations = linked ? observations.filter((o) => o.id !== linked.id) : observations;
    updateJob({
      inspection: { ...insp, items: nextItems },
      observations: nextObservations,
    });
    setPendingChange(null);
  };

  const cancelUnlink = () => {
    setPendingChange(null);
  };

  // --- Inline form save/cancel -------------------------------------------

  const saveInlineObservation = (
    ref: string,
    code: NonNullable<ObservationRow['code']>,
    location: string,
    description: string
  ) => {
    const item = findItem(ref);
    const draft: ObservationRow & { schedule_item?: string; schedule_description?: string } = {
      id: makeObservationId(),
      code,
      location: location.trim() || undefined,
      description: description.trim() || undefined,
      schedule_item: ref,
      schedule_description: item?.description,
    };
    updateJob({ observations: [...observations, draft] });
    setInlineFormRef(null);
  };

  const cancelInlineForm = () => setInlineFormRef(null);

  // --- ObservationSheet bridge for "tap the preview to edit" -------------

  const [editingObservationId, setEditingObservationId] = React.useState<string | null>(null);
  const editingObservation =
    editingObservationId === null
      ? null
      : (observations.find((o) => o.id === editingObservationId) ?? null);

  const handleObservationSheetSave = (next: ObservationRow) => {
    const idx = observations.findIndex((o) => o.id === next.id);
    const updated = observations.slice();
    if (idx >= 0) updated[idx] = next;
    else updated.push(next);
    updateJob({ observations: updated });
    setEditingObservationId(null);
  };

  // --- Auto-fill shortcuts (unchanged from pre-Phase-4) ------------------

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

  const pendingItem = pendingChange ? findItem(pendingChange.ref) : null;

  return (
    <div
      className="cm-stagger-children mx-auto flex w-full flex-col gap-5 px-4 py-6 md:px-8 md:py-8"
      style={{ maxWidth: '960px' }}
    >
      <HeroHeader
        eyebrow={certificateType}
        title="Inspection Schedule"
        subtitle={isEIC ? 'Design, construction & verification' : 'Periodic inspection & testing'}
        accent="schedule"
        icon={<ClipboardCheck className="h-10 w-10" strokeWidth={2} aria-hidden />}
      />

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

      {isEIC ? (
        <SectionCard accent="blue" icon={ClipboardCheck} title="EIC Inspection Schedule">
          {EIC_SCHEDULE.map((item) => (
            <ScheduleRow
              key={item.ref}
              item={item}
              outcome={items[item.ref]}
              onSelect={(o) => setOutcome(item.ref, o)}
              linkedObservation={observationForRef(item.ref)}
              onOpenObservation={(id) => setEditingObservationId(id)}
              inlineFormOpen={inlineFormRef === item.ref}
              onInlineSave={(loc, desc) => {
                const code = outcomeToObservationCode(items[item.ref]);
                if (!code || code === 'FI') {
                  cancelInlineForm();
                  return;
                }
                saveInlineObservation(item.ref, code, loc, desc);
              }}
              onInlineCancel={cancelInlineForm}
            />
          ))}
        </SectionCard>
      ) : (
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
                  linkedObservation={observationForRef(item.ref)}
                  onOpenObservation={(id) => setEditingObservationId(id)}
                  inlineFormOpen={inlineFormRef === item.ref}
                  onInlineSave={(loc, desc) => {
                    const code = outcomeToObservationCode(items[item.ref]);
                    if (!code || code === 'FI') {
                      cancelInlineForm();
                      return;
                    }
                    saveInlineObservation(item.ref, code, loc, desc);
                  }}
                  onInlineCancel={cancelInlineForm}
                />
              ))}
            </SectionCard>
          );
        })
      )}

      {/* Confirm dialog — unlink observation on outcome change. */}
      <ConfirmDialog
        open={pendingChange !== null}
        onOpenChange={(next) => {
          if (!next) cancelUnlink();
        }}
        title="Delete linked observation?"
        description={
          pendingItem ? (
            <>
              Changing item {pendingItem.ref} will delete the observation linked to it.
              <br />
              This cannot be undone.
            </>
          ) : (
            'This will delete the linked observation. This cannot be undone.'
          )
        }
        confirmLabel="Delete observation"
        destructive
        onConfirm={confirmUnlink}
      />

      {editingObservation && jobId ? (
        <ObservationSheet
          observation={editingObservation}
          jobId={jobId}
          onSave={handleObservationSheetSave}
          onCancel={() => setEditingObservationId(null)}
        />
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------------------- */

/**
 * Resolve a schedule ref (e.g. "4.12") to its ScheduleItem across both
 * EIC + EICR schedules. Used by the unlink confirmation dialog to
 * render the human-readable item description.
 */
function findItem(ref: string): ScheduleItem | null {
  for (const sec of EICR_SCHEDULE) {
    const hit = sec.items.find((i) => i.ref === ref);
    if (hit) return hit;
  }
  const eicHit = EIC_SCHEDULE.find((i) => i.ref === ref);
  return eicHit ?? null;
}

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
  linkedObservation,
  onOpenObservation,
  inlineFormOpen,
  onInlineSave,
  onInlineCancel,
}: {
  item: ScheduleItem;
  outcome?: ScheduleOutcome;
  onSelect: (outcome: ScheduleOutcome) => void;
  autoControlled?: boolean;
  linkedObservation?: ObservationRow;
  onOpenObservation?: (id: string) => void;
  inlineFormOpen?: boolean;
  onInlineSave?: (location: string, description: string) => void;
  onInlineCancel?: () => void;
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

      {/*
        Linked-observation inline preview (InspectionTab.swift:L266-L284).
        Tap to open the ObservationSheet in edit mode — same sheet as the
        Observations tab, so the inspector doesn't need to switch tabs to
        refine AI-populated observations.
      */}
      {linkedObservation ? (
        <button
          type="button"
          onClick={() => onOpenObservation?.(linkedObservation.id)}
          aria-label="Edit linked observation"
          className="ml-14 mt-1 flex flex-col gap-1 rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-2.5 py-2 text-left transition hover:border-[var(--color-border-strong)]"
        >
          <div className="flex items-center gap-2">
            {linkedObservation.code ? (
              <span
                className="rounded-full px-1.5 py-0.5 text-[10px] font-bold text-white"
                style={{ background: outcomeColour(linkedObservation.code as ScheduleOutcome) }}
              >
                {linkedObservation.code}
              </span>
            ) : null}
            <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
              Linked observation
            </span>
          </div>
          {linkedObservation.location ? (
            <span className="text-[12px] text-[var(--color-text-secondary)]">
              {linkedObservation.location}
            </span>
          ) : null}
          {linkedObservation.description ? (
            <span className="line-clamp-2 text-[12.5px] text-[var(--color-text-primary)]">
              {linkedObservation.description}
            </span>
          ) : null}
          <span className="text-[10.5px] font-medium text-[var(--color-brand-blue)]">
            Tap to edit
          </span>
        </button>
      ) : null}

      {/* Inline observation form (InspectionTab.swift:L286-L300). */}
      {inlineFormOpen && !linkedObservation ? (
        <InlineObservationForm
          scheduleItem={item}
          onSave={(loc, desc) => onInlineSave?.(loc, desc)}
          onCancel={() => onInlineCancel?.()}
        />
      ) : null}
    </div>
  );
}

function InlineObservationForm({
  scheduleItem,
  onSave,
  onCancel,
}: {
  scheduleItem: ScheduleItem;
  onSave: (location: string, description: string) => void;
  onCancel: () => void;
}) {
  const [location, setLocation] = React.useState('');
  const [description, setDescription] = React.useState('');
  const canSave = description.trim().length > 0;

  return (
    <div className="ml-14 mt-1 flex flex-col gap-2 rounded-[var(--radius-sm)] border border-[var(--color-brand-blue)]/40 bg-[var(--color-brand-blue)]/5 px-3 py-3">
      <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
        New observation · {scheduleItem.ref}
      </span>
      <input
        type="text"
        value={location}
        onChange={(e) => setLocation(e.target.value)}
        placeholder="Location (e.g. Kitchen RCBO way 4)"
        className="h-9 rounded-[var(--radius-sm)] border border-[var(--color-border-default)] bg-[var(--color-surface-1)] px-2.5 text-[12.5px] text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-blue)]"
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="What was found?"
        rows={2}
        className="rounded-[var(--radius-sm)] border border-[var(--color-border-default)] bg-[var(--color-surface-1)] px-2.5 py-1.5 text-[12.5px] text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-blue)]"
      />
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-full px-3 py-1 text-[11px] font-semibold text-[var(--color-text-secondary)] transition hover:text-[var(--color-text-primary)]"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!canSave}
          onClick={() => onSave(location, description)}
          className="rounded-full bg-[var(--color-brand-blue)] px-3 py-1 text-[11px] font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-40"
        >
          Save
        </button>
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
