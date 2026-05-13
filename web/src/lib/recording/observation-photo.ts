/**
 * Observation-photo auto-link primitives (L2 sprint 2026-05-13).
 *
 * Shared between `recording-context.tsx` (captures + persists pending
 * tuples) and `apply-extraction.ts` (forward-links a pending tuple to
 * the LAST observation on `applyObservations`). Keeping the constant
 * + helper here means both consumers import from one place and the
 * 60 s window can't drift across files.
 *
 * iOS canon for every behaviour in this file:
 *   - 60 s window: `DeepgramRecordingViewModel.swift:493`
 *     (`observationPhotoLinkWindow = 60.0`).
 *   - Pending tuple shape: `:497`
 *     (`(data, path, timestamp)` — we only need `(blobId, filename?,
 *     timestamp)` because PWA uploads complete the bytes-out-of-band
 *     and store on S3, vs iOS's local-temp-file pattern).
 *   - Replace-not-queue semantic: `:1553`.
 *   - Forward-link to LAST observation: `:5583-5593`.
 *   - Reverse-link via recent observation: `:1522-1549`.
 */

import type { ObservationRow } from '@/lib/types';
import type { PendingObservationPhotoRecord } from '@/lib/pwa/job-cache';

/**
 * Auto-link window — a Sonnet observation arriving within this many
 * milliseconds of a photo capture (in either direction) claims the
 * photo onto its `.photos[]`. Matches iOS exactly so the two
 * platforms behave the same in the inspector's hands. Sprint PLAN
 * §0.1 documents the empirical-from-iOS reasoning.
 */
export const OBSERVATION_PHOTO_LINK_WINDOW_MS = 60_000;

/**
 * The in-memory tuple held in `recording-context.tsx`'s
 * `pendingPhotoRef`. Same shape as the IDB record because the
 * persistence layer (PLAN §0.4) has to be able to rehydrate a tuple
 * verbatim after a Safari reload mid-recording.
 *
 * Fields:
 *   - `jobId`: keys both the IDB record AND the in-memory slot.
 *     Multiple jobs in the same browser session don't share a slot.
 *   - `blobId`: client-generated UUID assigned at resize completion.
 *     The forward-link writes this onto `ObservationRow.photos[]` as
 *     a placeholder so an observation arriving while the server
 *     upload is still in flight has SOMETHING to attach to (PLAN
 *     §Risks §1 — upload-during-resize race). When the upload
 *     resolves, the capture handler rewrites every placeholder
 *     occurrence with the real server `filename`.
 *   - `timestamp`: ms-since-epoch at which the photo was captured.
 *     `isWithinLinkWindow` compares against this.
 *   - `status`: `'uploading'` while the API request is in flight,
 *     `'pending'` once `filename` is known. A reload that interrupts
 *     an in-flight upload leaves the record at `'uploading'` with no
 *     `filename` — Phase 4's resume path drops the record because
 *     the blob is gone from memory and there's nothing to retry.
 *   - `filename`: server-assigned name from the upload response.
 *     Optional because it only exists once the upload settles.
 */
export type PendingObservationPhoto = PendingObservationPhotoRecord;

/**
 * Lightweight reference snapshot for the LAST observation Sonnet
 * appended to the job. The reverse-link path in
 * `captureObservationPhoto` (Phase 4) checks this on every capture —
 * if the most recent observation landed within the auto-link window,
 * the photo skips the pending slot and attaches directly. Cleared on
 * attach.
 *
 * iOS canon: `recentObservationId` + `recentObservationTimestamp` at
 * `DeepgramRecordingViewModel.swift:499-500`. We collapse them into
 * one struct because they're always read/written together.
 */
export interface RecentObservationRef {
  id: string;
  timestamp: number;
}

/**
 * True iff `timestamp` is within the auto-link window of `now`. The
 * `now` argument is injectable so tests can pin a deterministic
 * window edge without faking `Date.now`. Returns false for any
 * non-finite input to keep the call sites simple — callers don't
 * have to defensively check the timestamp.
 */
export function isWithinLinkWindow(timestamp: number, now: number = Date.now()): boolean {
  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) return false;
  const delta = now - timestamp;
  return delta >= 0 && delta < OBSERVATION_PHOTO_LINK_WINDOW_MS;
}

/**
 * Phase 3 forward-link primitive — attach a pending observation photo
 * to the LAST observation row in `newRows`. Mutates `newRows` in place
 * (only the last index) and returns `true` iff an attach happened.
 *
 * Conditions for no-op (returns false, `newRows` untouched):
 *   - `pending` is null / undefined.
 *   - `newRows` is empty (nothing to attach to; pending tuple stays
 *     in the caller's ref + IDB for the next turn).
 *   - `pending.timestamp` is past the auto-link window from `now`.
 *
 * Write semantics:
 *   - If `pending.filename` is set (the upload has resolved by the
 *     time the observation lands) the canonical filename is appended.
 *   - If `pending.filename` is NOT set (upload still in flight per
 *     PLAN §Risks §1), the client-generated `blobId` is appended as
 *     a placeholder. Phase 4's upload-success handler rewrites every
 *     placeholder occurrence onto the canonical filename in a second
 *     pass — that's why the blobId is a stable UUID rather than e.g.
 *     a `Date.now()`-derived string.
 *   - Pre-existing `photos[]` on the last row are PRESERVED — we
 *     append, never replace. iOS canon: line :5587 (`.photos =
 *     (.photos ?? []) + [path]`).
 *
 * Only the LAST row is attached. If Sonnet emitted multiple
 * observations in a single turn (rare but possible), the photo
 * lands on the most-recent one — same as iOS line :5583 ("LAST
 * observation"). Treating earlier rows as candidates would risk
 * mis-attribution: the inspector said one thing, took the photo,
 * said another thing — the latter is the intent.
 *
 * Pure function: no IDB, no logging, no callbacks. Callers are
 * responsible for clearing the pending state on a `true` return.
 */
export function mergePendingPhotoIntoObservations(
  newRows: ObservationRow[],
  pending: PendingObservationPhoto | null | undefined,
  now: number = Date.now()
): boolean {
  if (!pending) return false;
  if (newRows.length === 0) return false;
  if (!isWithinLinkWindow(pending.timestamp, now)) return false;
  const lastIdx = newRows.length - 1;
  const last = newRows[lastIdx];
  const nameOrPlaceholder = pending.filename ?? pending.blobId;
  const existingPhotos = Array.isArray(last.photos) ? last.photos : [];
  newRows[lastIdx] = { ...last, photos: [...existingPhotos, nameOrPlaceholder] };
  return true;
}
