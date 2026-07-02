'use client';

import * as React from 'react';
import { X } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { IconButton } from '@/components/ui/icon-button';
import type { JobDetail, ObservationRow } from '@/lib/types';
import { ObservationPhoto } from './observation-photo';

/**
 * Job photos picker — surfaces photos already attached to this job
 * (CCU is out of scope for this PWA slice — iOS exposes it too via
 * `JobPhotosPickerSheet.swift`, but the PWA's CCU storage model is
 * different and bringing it in would balloon the sprint. We can
 * follow up.) Inspector picks a photo, the picker emits
 * `(source, filename)` and the host applies move-vs-copy semantics.
 *
 * Sources:
 *   - `unassigned` — `job.unassigned_photos[]` pool. Move semantics:
 *     on save, the filename is REMOVED from the pool and appended
 *     to the target observation's `photos[]`.
 *   - `observation(id)` — another observation on the same job. Move
 *     semantics: filename is removed from the source observation
 *     and appended to the target.
 *
 * iOS canon: `JobPhotosPickerSheet.swift` (CertMateUnified). The PWA
 * picker mirrors the layout (cards per section, grid of thumbnails)
 * and emits the same source enum so the host's save logic is
 * structurally identical.
 */

export type JobPhotoSource =
  | { kind: 'unassigned' }
  | { kind: 'observation'; observationId: string };

/**
 * True iff the job has at least one photo the picker can offer.
 * Hosts gate the "From Job" button on this so an empty sheet never
 * appears.
 */
export function hasAnyPickableJobPhotos(
  job: JobDetail | null | undefined,
  excludeObservationId: string | null
): boolean {
  if (!job) return false;
  const unassigned = job.unassigned_photos ?? [];
  if (unassigned.length > 0) return true;
  const observations = (job.observations ?? []) as ObservationRow[];
  return observations.some(
    (o) => o.id !== excludeObservationId && Array.isArray(o.photos) && o.photos.length > 0
  );
}

export function JobPhotosPickerSheet({
  open,
  onClose,
  job,
  jobId,
  userId,
  excludeObservationId,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  job: JobDetail;
  jobId: string;
  userId: string;
  /** Hide photos on this observation — the user is editing it and
   *  picking from itself would be a no-op (and disorienting). */
  excludeObservationId: string | null;
  onSelect: (source: JobPhotoSource, filename: string) => void;
}) {
  const unassigned = React.useMemo(() => job.unassigned_photos ?? [], [job.unassigned_photos]);
  const otherObservations = React.useMemo(() => {
    const obs = (job.observations ?? []) as ObservationRow[];
    return obs
      .filter(
        (o) => o.id !== excludeObservationId && Array.isArray(o.photos) && o.photos.length > 0
      )
      .map((o) => ({
        id: o.id,
        code: o.code ?? 'C3',
        // Pick a short human-readable title from the observation
        // (description / location / schedule item). Mirrors iOS
        // `JobPhotosPickerSheet.swift:60-63`.
        title:
          [o.schedule_item, o.location, o.description]
            .map((s) => (s ?? '').trim())
            .find((s) => s.length > 0)
            ?.slice(0, 60) ?? `Observation ${o.code ?? ''}`,
        photos: o.photos as string[],
      }));
  }, [job.observations, excludeObservationId]);

  const isEmpty = unassigned.length === 0 && otherObservations.length === 0;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent
        unstyled
        aria-label="Photos in this job"
        aria-describedby={undefined}
        className="flex items-end justify-center md:items-center"
      >
        <div className="relative z-10 flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-[var(--radius-xl)] bg-[var(--color-surface-0)] shadow-2xl md:w-[640px] md:max-w-[95vw] md:rounded-[var(--radius-xl)]">
          <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-5 py-4">
            <DialogTitle asChild>
              <h2 className="text-[17px] font-bold text-[var(--color-text-primary)]">
                Photos in this job
              </h2>
            </DialogTitle>
            <IconButton onClick={onClose} aria-label="Close">
              <X className="h-4 w-4" aria-hidden />
            </IconButton>
          </div>

          <DialogDescription className="sr-only">
            Pick a photo from the unassigned pool or another observation to attach to the current
            observation.
          </DialogDescription>

          <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-5 py-5">
            {isEmpty ? (
              <p className="rounded-[var(--radius-md)] border border-dashed border-[var(--color-border-default)] bg-[var(--color-surface-1)] px-3 py-6 text-center text-[13px] text-[var(--color-text-tertiary)]">
                No photos on this job yet. Capture one during a recording or upload from the
                camera/library buttons above.
              </p>
            ) : null}

            {unassigned.length > 0 ? (
              <PhotoSection
                title="Unassigned"
                description="Photos captured during a recording that didn't auto-link to an observation."
              >
                <div className="grid grid-cols-3 gap-2 md:grid-cols-5">
                  {unassigned.map((filename) => (
                    <PhotoTile
                      key={`unassigned-${filename}`}
                      userId={userId}
                      jobId={jobId}
                      filename={filename}
                      onClick={() => {
                        onSelect({ kind: 'unassigned' }, filename);
                        onClose();
                      }}
                    />
                  ))}
                </div>
              </PhotoSection>
            ) : null}

            {otherObservations.map((group) => (
              <PhotoSection
                key={`obs-${group.id}`}
                title={group.title}
                description={`On observation ${group.code}. Pick to move.`}
              >
                <div className="grid grid-cols-3 gap-2 md:grid-cols-5">
                  {group.photos.map((filename) => (
                    <PhotoTile
                      key={`obs-${group.id}-${filename}`}
                      userId={userId}
                      jobId={jobId}
                      filename={filename}
                      onClick={() => {
                        onSelect({ kind: 'observation', observationId: group.id }, filename);
                        onClose();
                      }}
                    />
                  ))}
                </div>
              </PhotoSection>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PhotoSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-[13px] font-semibold text-[var(--color-text-primary)]">{title}</h3>
        <p className="mt-0.5 text-[12px] text-[var(--color-text-tertiary)]">{description}</p>
      </div>
      {children}
    </section>
  );
}

function PhotoTile({
  userId,
  jobId,
  filename,
  onClick,
}: {
  userId: string;
  jobId: string;
  filename: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="relative aspect-square overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-brand-blue)]"
      aria-label={`Attach photo ${filename}`}
    >
      <ObservationPhoto
        userId={userId}
        jobId={jobId}
        filename={filename}
        alt={`Photo ${filename}`}
        thumbnail
      />
    </button>
  );
}
