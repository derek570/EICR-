'use client';

import * as React from 'react';
import { useParams } from 'next/navigation';
import { AlertTriangle, ClipboardList, ImageIcon, MapPin, Plus, Trash2 } from 'lucide-react';
import { useJobContext } from '@/lib/job-context';
import type { ObservationRow } from '@/lib/types';
import { getUser } from '@/lib/auth';
import { SectionCard } from '@/components/ui/section-card';
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

  const handleSave = (next: ObservationRow) => {
    const existingIdx = observations.findIndex((o) => o.id === next.id);
    if (existingIdx >= 0) {
      const nextList = observations.slice();
      nextList[existingIdx] = next;
      updateJob({ observations: nextList });
    } else {
      updateJob({ observations: [...observations, next] });
    }
    closeSheet();
  };

  /**
   * Trash bin icon wraps this — but we queue the delete through a
   * ConfirmDialog (Phase 1 primitive) since a mis-tap would lose the
   * defect and any uploaded photos. Mirrors iOS context-menu delete at
   * ObservationsTab.swift:L22-L45 which has a native confirmation.
   *
   * Additionally clears any Inspection schedule item back-reference
   * via the schedule_item column on the observation. iOS does this in
   * `ObservationScheduleLinker.observationDeleted`
   * (ObservationsTab.swift:L173-L178) — the reference is one-way
   * (observation → schedule ref), so on the web side the observation
   * being gone is enough to clear the Inspection tab's inline preview,
   * which reads through `observations.find(o => o.schedule_item === ref)`.
   * No extra cross-tab wiring needed.
   */
  const [pendingDeleteId, setPendingDeleteId] = React.useState<string | null>(null);
  const pendingDelete = pendingDeleteId
    ? (observations.find((o) => o.id === pendingDeleteId) ?? null)
    : null;
  const confirmDelete = () => {
    if (!pendingDeleteId) return;
    updateJob({ observations: observations.filter((o) => o.id !== pendingDeleteId) });
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
            onClick={openAdd}
            className="inline-flex items-center gap-1.5 rounded-full bg-white/95 px-3.5 py-1.5 text-[12px] font-semibold text-[var(--color-brand-blue)] shadow-sm transition hover:bg-white"
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
