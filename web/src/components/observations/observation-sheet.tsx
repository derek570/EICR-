'use client';

import * as React from 'react';
import { Camera, FolderOpen, Loader2, MapPin, Trash2, X } from 'lucide-react';
import { api } from '@/lib/api-client';
import { ApiError, type ObservationRow } from '@/lib/types';
import { getUser } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { ObservationPhoto } from './observation-photo';

/**
 * Add/edit observation sheet — mirrors iOS `EditObservationSheet.swift`.
 *
 * Fields: C1/C2/C3/FI code (chip row), location (single-line), description
 * (multi-line), remedial action (multi-line), and a photo grid with two
 * upload buttons (Camera + Library) matching iOS's two-button pattern.
 *
 * Why two buttons instead of a single file input?
 *   iOS UX shows Camera and Library as discrete actions. On iOS Safari
 *   the native picker covers both when `capture` is omitted, but the
 *   discovery is poorer — users often expect two visible affordances.
 *   The Camera input sets `capture="environment"` to hint the rear
 *   camera (live shot of the defect), while the Library input omits
 *   `capture` so users can pick pre-taken photos.
 *
 * Save flow:
 *   Edits are local-only until the user taps Save. The photo uploads
 *   happen immediately (user taps Camera → shoot → upload kicks off in
 *   the background and the filename appends to the local `photos`
 *   array on success). Deletes also run against the backend
 *   immediately, but update the local array only after the 200 comes
 *   back so a failure doesn't lose state. On Save, the parent merges
 *   the finished observation back into `job.observations`.
 *
 * Discard:
 *   Cancel/Esc/backdrop-tap all discard unsaved *field* edits, but any
 *   photos already uploaded stay on S3 (matches iOS — photos are
 *   committed eagerly). If the user created a brand-new observation
 *   and then cancels, the `onCancel` caller is responsible for
 *   cleaning up any orphan photos (currently none are deleted — same
 *   behaviour as iOS, and the S3 lifecycle handles orphans).
 */

const CODE_OPTIONS: { value: NonNullable<ObservationRow['code']>; label: string; hint: string }[] =
  [
    { value: 'C1', label: 'C1', hint: 'Danger present' },
    { value: 'C2', label: 'C2', hint: 'Potentially dangerous' },
    { value: 'C3', label: 'C3', hint: 'Improvement recommended' },
    { value: 'FI', label: 'FI', hint: 'Further investigation' },
  ];

const CODE_COLOUR: Record<NonNullable<ObservationRow['code']>, string> = {
  C1: 'var(--color-status-failed)',
  C2: 'var(--color-status-processing)',
  C3: 'var(--color-brand-blue)',
  FI: 'var(--color-status-limitation)',
};

export function ObservationSheet({
  observation,
  jobId,
  onSave,
  onCancel,
}: {
  observation: ObservationRow;
  jobId: string;
  onSave: (next: ObservationRow) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = React.useState<ObservationRow>(observation);
  const [uploading, setUploading] = React.useState(false);
  const [photoError, setPhotoError] = React.useState<string | null>(null);

  const cameraInputRef = React.useRef<HTMLInputElement>(null);
  const libraryInputRef = React.useRef<HTMLInputElement>(null);

  // Resolve the signed-in user once. The photo endpoints need userId,
  // but the job page path only carries jobId — so pull from auth.
  const userId = React.useMemo(() => getUser()?.id ?? null, []);

  // Esc-to-cancel + scroll lock are now Radix's job. Before Wave 4 D5
  // this component rolled its own; Radix Dialog handles Esc, body
  // scroll lock, focus trap, and focus restore uniformly. The
  // `onOpenChange(false)` path below fires the same `onCancel` the
  // old keydown handler did.

  const patch = (p: Partial<ObservationRow>) => setDraft((d) => ({ ...d, ...p }));

  const openCamera = () => {
    setPhotoError(null);
    cameraInputRef.current?.click();
  };
  const openLibrary = () => {
    setPhotoError(null);
    libraryInputRef.current?.click();
  };

  const handleFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Reset immediately so the same file can be reselected after error.
    event.target.value = '';
    if (!file || !userId) {
      if (!userId) setPhotoError('Not signed in — please reload.');
      return;
    }

    setUploading(true);
    setPhotoError(null);
    try {
      const { photo } = await api.uploadObservationPhoto(userId, jobId, file);
      setDraft((d) => ({ ...d, photos: [...(d.photos ?? []), photo.filename] }));
    } catch (err) {
      const message =
        err instanceof ApiError
          ? `Upload failed (${err.status}): ${err.message}`
          : err instanceof Error
            ? err.message
            : 'Upload failed.';
      setPhotoError(message);
    } finally {
      setUploading(false);
    }
  };

  const deletePhoto = async (filename: string) => {
    if (!userId) return;
    setPhotoError(null);
    try {
      await api.deleteObservationPhoto(userId, jobId, filename);
      setDraft((d) => ({
        ...d,
        photos: (d.photos ?? []).filter((f) => f !== filename),
      }));
    } catch (err) {
      const message =
        err instanceof ApiError
          ? `Delete failed (${err.status}): ${err.message}`
          : err instanceof Error
            ? err.message
            : 'Delete failed.';
      setPhotoError(message);
    }
  };

  const save = () => {
    // Strip empty strings so the saved row doesn't claim a blank description.
    const cleaned: ObservationRow = {
      ...draft,
      description: draft.description?.trim() || undefined,
      location: draft.location?.trim() || undefined,
      remedial: draft.remedial?.trim() || undefined,
    };
    onSave(cleaned);
  };

  const photos = draft.photos ?? [];

  // Always open while this component is mounted — the parent unmounts
  // via `onCancel`. `onOpenChange(false)` is the Radix hook for Esc /
  // outside click / the built-in close button; each of them routes to
  // `onCancel` to match the pre-D5 behaviour.
  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onCancel())}>
      <DialogContent
        unstyled
        aria-label="Observation"
        className="flex items-end justify-center md:items-center"
      >
        {/* Panel */}
        <div className="relative z-10 flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-[var(--radius-xl)] bg-[var(--color-surface-0)] shadow-2xl md:w-[640px] md:max-w-[95vw] md:rounded-[var(--radius-xl)]">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-5 py-4">
            <DialogTitle asChild>
              <h2 className="text-[17px] font-bold text-[var(--color-text-primary)]">
                {observation.description ? 'Edit observation' : 'Add observation'}
              </h2>
            </DialogTitle>
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]"
              aria-label="Close"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>

          {/* Body — scrollable */}
          <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-5 py-5">
            {/* Code chips */}
            <section className="flex flex-col gap-2">
              <label className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
                Code
              </label>
              <div className="flex flex-wrap gap-2">
                {CODE_OPTIONS.map((opt) => {
                  const active = draft.code === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => patch({ code: opt.value })}
                      aria-pressed={active}
                      className={cn(
                        'flex items-center gap-2 rounded-full border px-3 py-1.5 text-[12px] font-semibold transition',
                        active
                          ? 'border-transparent text-white'
                          : 'border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                      )}
                      style={active ? { background: CODE_COLOUR[opt.value] } : undefined}
                    >
                      <span>{opt.label}</span>
                      <span className="font-normal opacity-80">{opt.hint}</span>
                    </button>
                  );
                })}
              </div>
            </section>

            {/* Location */}
            <section className="flex flex-col gap-1.5">
              <label
                htmlFor="obs-location"
                className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]"
              >
                <MapPin className="h-3 w-3" aria-hidden />
                Location
              </label>
              <input
                id="obs-location"
                type="text"
                value={draft.location ?? ''}
                onChange={(e) => patch({ location: e.target.value })}
                placeholder="e.g. Kitchen RCBO way 4"
                className="h-11 rounded-[var(--radius-md)] border border-[var(--color-border-default)] bg-[var(--color-surface-1)] px-3 text-[14px] text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-blue)]"
              />
            </section>

            {/* Description */}
            <section className="flex flex-col gap-1.5">
              <label
                htmlFor="obs-description"
                className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]"
              >
                Description
              </label>
              <textarea
                id="obs-description"
                value={draft.description ?? ''}
                onChange={(e) => patch({ description: e.target.value })}
                rows={3}
                placeholder="What was found?"
                className="rounded-[var(--radius-md)] border border-[var(--color-border-default)] bg-[var(--color-surface-1)] px-3 py-2 text-[14px] leading-snug text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-blue)]"
              />
            </section>

            {/* Remedial */}
            <section className="flex flex-col gap-1.5">
              <label
                htmlFor="obs-remedial"
                className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]"
              >
                Remedial action
              </label>
              <textarea
                id="obs-remedial"
                value={draft.remedial ?? ''}
                onChange={(e) => patch({ remedial: e.target.value })}
                rows={2}
                placeholder="Recommended fix (optional)"
                className="rounded-[var(--radius-md)] border border-[var(--color-border-default)] bg-[var(--color-surface-1)] px-3 py-2 text-[14px] leading-snug text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-blue)]"
              />
            </section>

            {/* Photos */}
            <section className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
                  Photos {photos.length > 0 ? `(${photos.length})` : null}
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={openCamera}
                    disabled={uploading || !userId}
                  >
                    <Camera className="h-3.5 w-3.5" aria-hidden />
                    Camera
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={openLibrary}
                    disabled={uploading || !userId}
                  >
                    <FolderOpen className="h-3.5 w-3.5" aria-hidden />
                    Library
                  </Button>
                </div>
              </div>

              {/* Hidden inputs. Camera sets capture="environment" (rear
                camera hint on iOS Safari); Library omits capture so the
                system sheet shows the user's photo library. */}
              <input
                ref={cameraInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                onChange={handleFile}
                className="sr-only"
                aria-hidden
              />
              <input
                ref={libraryInputRef}
                type="file"
                accept="image/*"
                onChange={handleFile}
                className="sr-only"
                aria-hidden
              />

              {uploading ? (
                <p
                  role="status"
                  className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-3 py-2 text-[12px] text-[var(--color-text-secondary)]"
                >
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  Uploading photo…
                </p>
              ) : null}

              {photoError ? (
                <p
                  role="alert"
                  className="rounded-[var(--radius-md)] border border-[var(--color-status-failed)]/40 bg-[var(--color-status-failed)]/10 px-3 py-2 text-[12px] text-[var(--color-status-failed)]"
                >
                  {photoError}
                </p>
              ) : null}

              {photos.length > 0 && userId ? (
                // 3-col mobile, 5-col desktop — matches iOS thumbnail grid.
                <div className="grid grid-cols-3 gap-2 md:grid-cols-5">
                  {photos.map((filename) => (
                    <div
                      key={filename}
                      className="relative aspect-square overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)]"
                    >
                      <ObservationPhoto
                        userId={userId}
                        jobId={jobId}
                        filename={filename}
                        alt="Observation defect photo"
                        thumbnail
                      />
                      <button
                        type="button"
                        onClick={() => deletePhoto(filename)}
                        aria-label="Remove photo"
                        className="absolute right-1 top-1 inline-flex h-6 w-6 items-center justify-center rounded-full bg-black/65 text-white opacity-90 transition hover:bg-black/80 hover:opacity-100"
                      >
                        <Trash2 className="h-3 w-3" aria-hidden />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="rounded-[var(--radius-md)] border border-dashed border-[var(--color-border-default)] bg-[var(--color-surface-1)] px-3 py-3 text-center text-[12px] text-[var(--color-text-tertiary)]">
                  No photos yet — tap Camera to capture the defect or Library to attach an existing
                  shot.
                </p>
              )}
            </section>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 border-t border-[var(--color-border-subtle)] px-5 py-3">
            <Button type="button" variant="ghost" size="md" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="button" variant="primary" size="md" onClick={save}>
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
