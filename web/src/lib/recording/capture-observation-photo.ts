/**
 * Observation-photo capture orchestration (L2 sprint 2026-05-13,
 * Phase 4).
 *
 * Lives outside `recording-context.tsx` because the state machine
 * is non-trivial (forward-link vs. reverse-link vs. upload-during-
 * resize race) and benefits from injectable deps so tests can drive
 * every path without standing up a React tree.
 *
 * iOS canon: `DeepgramRecordingViewModel.swift:1504-1591`.
 */

import type { JobDetail, ObservationRow } from '@/lib/types';
import type { PendingObservationPhoto, RecentObservationRef } from './observation-photo';
import { isWithinLinkWindow } from './observation-photo';

export interface CaptureObservationPhotoDeps {
  /** Identifying context — usually read from current user + jobRef. */
  userId: string;
  jobId: string;
  /** Bytes to resize + upload. */
  file: Blob;

  /** Shrink + re-encode the source to a wire-friendly JPEG. */
  resize: (blob: Blob) => Promise<Blob>;
  /** Multipart POST to /api/job/.../photos. Returns the canonical
   *  server-assigned filename which the client appends to
   *  `ObservationRow.photos[]`. */
  uploadPhoto: (userId: string, jobId: string, blob: Blob) => Promise<{ filename: string }>;

  /** Returns a stable client-generated UUID. Pure-function injection
   *  lets tests pin deterministic blobIds. */
  generateBlobId: () => string;
  /** Wall-clock now. Injectable for the same reason. */
  now: () => number;

  /** IDB writers — surface so a Safari reload mid-recording sees the
   *  pending tuple. */
  writePendingPhoto: (record: PendingObservationPhoto) => Promise<void>;
  clearPendingPhoto: (jobId: string) => Promise<void>;

  /** Reverse-link feed maintained by `applyObservations` via
   *  `onLastObservationCreated`. Cleared once a reverse-link claims
   *  the photo so the next capture doesn't double-attach. */
  getRecentObservation: () => RecentObservationRef | null;
  clearRecentObservation: () => void;

  /** Pending-photo slot — set during a forward-link capture, cleared
   *  on attach / failure. The forward-link in Phase 3 reads this
   *  same ref through `applyExtractionToJob`. */
  getPendingPhoto: () => PendingObservationPhoto | null;
  setPendingPhoto: (record: PendingObservationPhoto | null) => void;

  /** Current job snapshot — used to find the target observation in
   *  the reverse-link path and to rewrite placeholder entries on
   *  upload success. */
  getJob: () => JobDetail | null;
  /** Apply a partial JobDetail patch (writes through to React state
   *  AND mirrors into the recording-context's jobRef). */
  applyJobPatch: (patch: Partial<JobDetail>) => void;

  /** Optional callbacks for telemetry / UI surfaces. */
  onError?: (err: Error) => void;
  log?: (event: string, payload: Record<string, unknown>) => void;
}

/**
 * Sole entry point — runs the full capture pipeline. Resolves once
 * the upload settles (success OR failure); never throws.
 *
 * Three behavioural paths:
 *
 *  1. **Reverse-link** — `getRecentObservation()` returns a ref
 *     within the 60 s window. Optimistically appends the client
 *     `blobId` placeholder to that observation's `.photos[]` BEFORE
 *     the upload starts; on success the placeholder is rewritten to
 *     the canonical filename. Pending state is NOT entered (iOS
 *     :1546 — Case B clears `recentObservation` and returns).
 *
 *  2. **Forward-link** — no recent observation. Enters pending
 *     state (`setPendingPhoto` + IDB write) so the Phase 3 forward-
 *     link in `applyObservations` can claim the photo when the
 *     observation finally lands. On upload success, either:
 *       (a) the forward-link already wrote `blobId` into a row →
 *           rewrite placeholder to filename, clear pending; OR
 *       (b) no observation arrived yet → leave pending with
 *           filename + status='pending' for the next chance.
 *
 *  3. **Upload failure** — both paths clean up symmetrically: any
 *     placeholder occurrences in observations[] are stripped, the
 *     pending tuple is dropped from ref + IDB, `onError` fires so
 *     the host can surface a toast. The user gets to retry with a
 *     fresh tap.
 *
 * Why the placeholder is the `blobId` (a client UUID) and not the
 * server filename:
 *   - Phase 3's forward-link can fire WHILE the upload is in flight
 *     (PLAN §Risks §1 — upload-during-resize race). At that moment
 *     the server filename doesn't exist yet, but the placeholder
 *     does — so the observation gets *something* and the rewrite
 *     pass on upload-success completes the link.
 *   - The blobId is a UUIDv4 so a stray placeholder that survives
 *     a crash never collides with a real filename in the picker.
 */
export async function captureObservationPhoto(deps: CaptureObservationPhotoDeps): Promise<void> {
  const log = deps.log ?? (() => {});
  const blobId = deps.generateBlobId();
  const timestamp = deps.now();

  let resized: Blob;
  try {
    resized = await deps.resize(deps.file);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log('observation_photo_resize_failed', { blob_id: blobId, error: error.message });
    deps.onError?.(error);
    return;
  }

  // --- Decide forward vs. reverse BEFORE the upload starts. ---
  const recent = deps.getRecentObservation();
  const reverseLinkObservationId =
    recent && isWithinLinkWindow(recent.timestamp, timestamp) ? recent.id : null;

  if (reverseLinkObservationId) {
    // Reverse-link path: optimistically attach the placeholder to
    // the recent observation. If the observation isn't actually in
    // the job anymore (deleted / deduped since the ref was set), we
    // silently fall through to the forward-link path — the photo
    // still uploads, just lands in pending.
    const job = deps.getJob();
    const observations = (job?.observations ?? []) as ObservationRow[];
    const idx = observations.findIndex((o) => o.id === reverseLinkObservationId);
    if (idx !== -1) {
      const target = observations[idx];
      const nextRows = observations.slice();
      nextRows[idx] = {
        ...target,
        photos: [...(target.photos ?? []), blobId],
      };
      deps.applyJobPatch({ observations: nextRows });
      deps.clearRecentObservation();
      log('observation_photo_reverse_link', {
        blob_id: blobId,
        observation_id: reverseLinkObservationId,
      });
    } else {
      log('observation_photo_reverse_link_target_missing', {
        blob_id: blobId,
        observation_id: reverseLinkObservationId,
      });
      // Fall through to forward-link.
      await enterPendingState(deps, blobId, timestamp);
    }
  } else {
    await enterPendingState(deps, blobId, timestamp);
  }

  // --- Upload. ---
  let filename: string;
  try {
    const response = await deps.uploadPhoto(deps.userId, deps.jobId, resized);
    filename = response.filename;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log('observation_photo_upload_failed', { blob_id: blobId, error: error.message });
    await rollbackPlaceholder(deps, blobId);
    deps.onError?.(error);
    return;
  }

  // --- Upload succeeded. Rewrite any placeholders + settle state. ---
  const job = deps.getJob();
  const observations = (job?.observations ?? []) as ObservationRow[];
  let rewroteAny = false;
  const nextRows = observations.map((o) => {
    if (!o.photos || !o.photos.includes(blobId)) return o;
    rewroteAny = true;
    return {
      ...o,
      photos: o.photos.map((p) => (p === blobId ? filename : p)),
    };
  });
  if (rewroteAny) {
    deps.applyJobPatch({ observations: nextRows });
    log('observation_photo_placeholder_rewritten', { blob_id: blobId, filename });
  }

  // Settle pending state. The pending tuple exists in the forward-
  // link case AND in the reverse-link case (we never wrote pending
  // there) — so check by blobId so we don't accidentally wipe a
  // newer pending tuple from a second capture that came in while
  // this upload was in flight (iOS "replace, not queue" still
  // applies — see PLAN §0.2 — so a newer tuple has overwritten
  // ours; we leave it alone).
  const currentPending = deps.getPendingPhoto();
  if (currentPending && currentPending.blobId === blobId) {
    if (rewroteAny) {
      // Forward-link Race-Case (a): placeholder was already
      // claimed by an observation that landed during the upload.
      // Drain pending entirely — nothing more to do.
      deps.setPendingPhoto(null);
      await deps.clearPendingPhoto(deps.jobId);
      log('observation_photo_pending_drained_after_attach', { blob_id: blobId });
    } else {
      // Forward-link Race-Case (b): no observation has arrived
      // yet. Update pending with the filename so the next forward-
      // link writes the canonical name from the start (no
      // placeholder needed). Also persist to IDB so a reload
      // surface still attaches correctly.
      const settled: PendingObservationPhoto = {
        ...currentPending,
        filename,
        status: 'pending',
      };
      deps.setPendingPhoto(settled);
      await deps.writePendingPhoto(settled);
      log('observation_photo_pending_settled_with_filename', {
        blob_id: blobId,
        filename,
      });
    }
  }
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/**
 * Enter the forward-link pending state. Sets the in-memory ref AND
 * persists to IDB so a Safari reload mid-recording can rehydrate.
 *
 * iOS canon: `:1552-1556` — the only difference is that iOS uses an
 * in-memory tuple (the view model is process-lived) while we double-
 * write to IDB because PWA loses React state on reload.
 */
async function enterPendingState(
  deps: CaptureObservationPhotoDeps,
  blobId: string,
  timestamp: number
): Promise<void> {
  const record: PendingObservationPhoto = {
    jobId: deps.jobId,
    blobId,
    timestamp,
    status: 'uploading',
  };
  deps.setPendingPhoto(record);
  await deps.writePendingPhoto(record);
  deps.log?.('observation_photo_pending_entered', {
    blob_id: blobId,
    job_id: deps.jobId,
  });
}

/**
 * Upload failure cleanup. Strips the placeholder from any
 * observation rows it landed on (forward-link race or reverse-link
 * eager-attach) and drains the pending tuple. After this runs the
 * job is in a clean state — no orphan placeholders, no stale IDB
 * record. The user can retry by tapping the Photo button again.
 */
async function rollbackPlaceholder(
  deps: CaptureObservationPhotoDeps,
  blobId: string
): Promise<void> {
  const job = deps.getJob();
  if (job) {
    const observations = (job.observations ?? []) as ObservationRow[];
    let mutated = false;
    const nextRows = observations.map((o) => {
      if (!o.photos || !o.photos.includes(blobId)) return o;
      mutated = true;
      const filtered = o.photos.filter((p) => p !== blobId);
      return filtered.length === 0
        ? // Drop the now-empty photos[] entirely — matches iOS
          // canon (`.photos` is optional). Avoids rendering an
          // empty thumbnail strip on the schedule row.
          { ...o, photos: undefined }
        : { ...o, photos: filtered };
    });
    if (mutated) {
      deps.applyJobPatch({ observations: nextRows });
      deps.log?.('observation_photo_placeholder_rolled_back', { blob_id: blobId });
    }
  }
  const pending = deps.getPendingPhoto();
  if (pending && pending.blobId === blobId) {
    deps.setPendingPhoto(null);
    await deps.clearPendingPhoto(deps.jobId);
  }
}
