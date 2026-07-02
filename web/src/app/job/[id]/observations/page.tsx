'use client';

import * as React from 'react';
import { useParams } from 'next/navigation';
import { AlertTriangle, ClipboardList, ImageIcon, MapPin, Plus, Trash2 } from 'lucide-react';
import { useJobContext } from '@/lib/job-context';
import type { ObservationRow } from '@/lib/types';
import type { ScheduleOutcome } from '@/lib/constants/inspection-schedule';
import { getUser } from '@/lib/auth';
import { SectionCard } from '@/components/ui/section-card';
import { HeroHeader } from '@/components/ui/hero-header';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ObservationPhoto } from '@/components/observations/observation-photo';
import { ObservationSheet } from '@/components/observations/observation-sheet';
import { cn } from '@/lib/utils';

/**
 * Observations tab — mirrors iOS `ObservationsTab.swift`.
 *
 * Layout: gradient hero with C1/C2/C3/FI tally + Add button, then a list
 * of observation cards. Tap Add for a new blank sheet, tap any card to
 * edit. The photo upload flow (Phase 5c) lives in <ObservationSheet>;
 * this page just renders up to three thumbnails inline per card and
 * opens the sheet on click.
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

/** Small helper — crypto.randomUUID is available in every modern runtime
 *  that ships Next.js 16, but we fall back to Date.now() just to stay
 *  safe on older Safari TP builds that still wheeze on some `crypto`
 *  methods in privacy mode. */
function makeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `obs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export default function ObservationsPage() {
  const { job, certificateType, updateJob } = useJobContext();
  const params = useParams<{ id: string }>();
  const jobId = params?.id ?? '';
  const userId = React.useMemo(() => getUser()?.id ?? null, []);

  const observations = React.useMemo(() => job.observations ?? [], [job.observations]);

  // `null` = sheet closed. A string id = editing existing. The literal
  // string 'new' = a blank row queued in `draftNew` below.
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [draftNew, setDraftNew] = React.useState<ObservationRow | null>(null);

  const counts = React.useMemo(() => countByCode(observations), [observations]);

  const openAdd = () => {
    const blank: ObservationRow = { id: makeId() };
    setDraftNew(blank);
    setEditingId(blank.id);
  };

  const openEdit = (id: string) => {
    setDraftNew(null);
    setEditingId(id);
  };

  const closeSheet = () => {
    setEditingId(null);
    setDraftNew(null);
  };

  /** Build a `(patch)` shape that mirrors iOS `ObservationScheduleLinker`
   *  for either an edit (`before` set) or a delete (`after` null +
   *  `before` set). Returns null when no schedule-side mutation is
   *  needed.
   *
   *  Rules (M5 + M6 of the 2026-05-12 parity audit):
   *    - Delete with schedule_item: items[ref] = '✓' (restore tick).
   *    - Edit changing schedule_item: items[oldRef] = '✓' AND, if
   *      new ref + code present, items[newRef] = code.
   *    - Edit keeping schedule_item, changing code: items[ref] = new
   *      code (or '✓' when code cleared).
   *
   *  iOS canon: `ObservationScheduleLinker.observationEdited` /
   *  `observationDeleted` (Sources/Services/ObservationScheduleLinker.swift). */
  const buildScheduleSync = (
    before: ObservationRow | null,
    after: ObservationRow | null
  ): Record<string, ScheduleOutcome> | null => {
    const oldRef =
      before && typeof before.schedule_item === 'string' && before.schedule_item
        ? before.schedule_item
        : null;
    const newRef =
      after && typeof after.schedule_item === 'string' && after.schedule_item
        ? after.schedule_item
        : null;
    if (!oldRef && !newRef) return null;
    const inspection = (job.inspection_schedule ?? {}) as {
      items?: Record<string, ScheduleOutcome | undefined>;
    };
    const items: Record<string, ScheduleOutcome> = {};
    for (const [k, v] of Object.entries(inspection.items ?? {})) {
      if (v != null) items[k] = v;
    }
    let touched = false;
    if (oldRef && oldRef !== newRef) {
      items[oldRef] = 'tick';
      touched = true;
    }
    if (newRef && after) {
      const newCode = after.code;
      // ScheduleOutcome covers C1/C2/C3/tick/N/A/LIM; FI is an observation
      // code without a matching schedule outcome, so we map it to a tick on
      // the schedule row (still flagged, but not as a coded danger).
      if (newCode === 'C1' || newCode === 'C2' || newCode === 'C3') {
        if (items[newRef] !== newCode) {
          items[newRef] = newCode;
          touched = true;
        }
      } else if (oldRef === newRef) {
        // Edit cleared the code but kept the schedule_item. Restore
        // the tick so the row doesn't read as still-flagged.
        if (items[newRef] !== 'tick') {
          items[newRef] = 'tick';
          touched = true;
        }
      }
    }
    return touched ? items : null;
  };

  const handleSave = (next: ObservationRow) => {
    const existingIdx = observations.findIndex((o) => o.id === next.id);
    const before = existingIdx >= 0 ? observations[existingIdx] : null;
    const nextList = observations.slice();
    if (existingIdx >= 0) {
      nextList[existingIdx] = next;
    } else {
      nextList.push(next);
    }
    const scheduleItems = buildScheduleSync(before, next);
    if (scheduleItems) {
      const inspection = (job.inspection_schedule ?? {}) as Record<string, unknown>;
      updateJob({
        observations: nextList,
        inspection_schedule: { ...inspection, items: scheduleItems },
      });
    } else {
      updateJob({ observations: nextList });
    }
    closeSheet();
  };

  /**
   * Trash bin icon wraps this — but we queue the delete through a
   * ConfirmDialog (Phase 1 primitive) since a mis-tap would lose the
   * defect and any uploaded photos. Mirrors iOS context-menu delete at
   * ObservationsTab.swift:L22-L45 which has a native confirmation.
   *
   * M5 of the parity audit — when the deleted observation carries a
   * `schedule_item`, restore that row in `inspection_schedule.items`
   * to `'✓'` (tick) so the Inspection tab doesn't render a C1/C2/C3
   * outcome with no underlying observation. iOS does this via
   * `ObservationScheduleLinker.observationDeleted`. The pre-fix
   * comment that claimed "no extra cross-tab wiring needed" was
   * wrong — the reverse-link IS required for parity.
   */
  const [pendingDeleteId, setPendingDeleteId] = React.useState<string | null>(null);
  const pendingDelete = pendingDeleteId
    ? (observations.find((o) => o.id === pendingDeleteId) ?? null)
    : null;
  const confirmDelete = () => {
    if (!pendingDeleteId || !pendingDelete) return;
    const remaining = observations.filter((o) => o.id !== pendingDeleteId);
    const scheduleItems = buildScheduleSync(pendingDelete, null);
    if (scheduleItems) {
      const inspection = (job.inspection_schedule ?? {}) as Record<string, unknown>;
      updateJob({
        observations: remaining,
        inspection_schedule: { ...inspection, items: scheduleItems },
      });
    } else {
      updateJob({ observations: remaining });
    }
    setPendingDeleteId(null);
  };

  const editing =
    editingId === null
      ? null
      : ((draftNew && draftNew.id === editingId
          ? draftNew
          : observations.find((o) => o.id === editingId)) ?? null);

  return (
    <div
      className="cm-stagger-children mx-auto flex w-full flex-col gap-5 px-4 py-6 md:px-8 md:py-8"
      style={{ maxWidth: '960px' }}
    >
      <HeroHeader
        eyebrow={certificateType}
        title="Observations"
        subtitle="Defects, recommendations & notes"
        accent="test-results"
        icon={<AlertTriangle className="h-10 w-10" strokeWidth={2} aria-hidden />}
        action={
          <button
            type="button"
            onClick={openAdd}
            className="inline-flex items-center gap-1.5 rounded-full bg-white/95 px-3.5 py-1.5 text-[12px] font-semibold text-[var(--color-brand-blue)] shadow-sm transition hover:bg-white"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            Add
          </button>
        }
      >
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
      </HeroHeader>

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
            <ObservationCard
              key={obs.id}
              obs={obs}
              userId={userId}
              jobId={jobId}
              onOpen={() => openEdit(obs.id)}
              onRemove={() => setPendingDeleteId(obs.id)}
            />
          ))}
        </div>
      )}

      {editing && jobId ? (
        <ObservationSheet
          observation={editing}
          jobId={jobId}
          onSave={handleSave}
          onCancel={closeSheet}
        />
      ) : null}

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDeleteId(null);
        }}
        title="Delete observation?"
        description={
          pendingDelete ? (
            <>
              {pendingDelete.code ? `${pendingDelete.code} · ` : null}
              {pendingDelete.description?.slice(0, 120) || 'No description'}
              {pendingDelete.schedule_item
                ? ` (linked to schedule item ${pendingDelete.schedule_item})`
                : ''}
              . This cannot be undone.
            </>
          ) : (
            'This cannot be undone.'
          )
        }
        confirmLabel="Delete"
        destructive
        onConfirm={confirmDelete}
      />
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

function ObservationCard({
  obs,
  userId,
  jobId,
  onOpen,
  onRemove,
}: {
  obs: ObservationRow;
  userId: string | null;
  jobId: string;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const code = obs.code;
  const colour = code ? CODE_COLOUR[code] : 'var(--color-text-tertiary)';
  const subtitle = code ? CODE_LABEL[code] : 'Observation';
  const photos = obs.photos ?? [];
  // Preview up to three thumbnails inline; the sheet shows the full grid.
  const previewCount = 3;
  const extra = Math.max(0, photos.length - previewCount);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className="group flex cursor-pointer flex-col gap-2 rounded-[var(--radius-md)] border border-[var(--color-border-default)] bg-[var(--color-surface-1)] px-3 py-3 transition hover:border-[var(--color-border-strong)]"
    >
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
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
                {subtitle}
              </span>
              {obs.schedule_item ? (
                <span
                  className="inline-flex items-center gap-1 rounded-full bg-[var(--color-brand-blue)]/15 px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-brand-blue)]"
                  title={obs.schedule_description ?? undefined}
                >
                  <ClipboardList className="h-2.5 w-2.5" aria-hidden />
                  from schedule item {obs.schedule_item}
                </span>
              ) : null}
            </div>
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
          onClick={(e) => {
            // Don't open the sheet when the user is just deleting.
            e.stopPropagation();
            onRemove();
          }}
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
      {/* obs-#52 Fix B (WS3 item 3) — regulation ref + canonical BS 7671
          wording + rationale, same order/emphasis as iOS
          ObservationCardView.swift:71-88: ref line (info colour), canonical
          title (primary), canonical description (secondary), then italic
          "Because {rationale}". Title/description absent on a table MISS —
          only ref + rationale show, unchanged from before. */}
      {obs.regulation ? (
        <p className="text-[12px] leading-snug text-[var(--color-brand-blue)]">{obs.regulation}</p>
      ) : null}
      {obs.regulation_title ? (
        <p className="text-[12px] leading-snug text-[var(--color-text-primary)]">
          {obs.regulation_title}
        </p>
      ) : null}
      {obs.regulation_description ? (
        <p className="text-[12px] leading-snug text-[var(--color-text-secondary)]">
          {obs.regulation_description}
        </p>
      ) : null}
      {obs.rationale ? (
        <p className="text-[12px] italic leading-snug text-[var(--color-text-secondary)]">
          Because {obs.rationale}
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
      {photos.length > 0 && userId ? (
        <div className="flex items-center gap-1.5 pt-1">
          {photos.slice(0, previewCount).map((filename) => (
            <div
              key={filename}
              className="h-12 w-12 overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)]"
            >
              <ObservationPhoto
                userId={userId}
                jobId={jobId}
                filename={filename}
                alt=""
                thumbnail
              />
            </div>
          ))}
          {extra > 0 ? (
            <span className="inline-flex h-12 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-2 text-[11px] font-semibold text-[var(--color-text-secondary)]">
              <ImageIcon className="mr-1 h-3 w-3" aria-hidden />+{extra}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
