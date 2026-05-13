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
