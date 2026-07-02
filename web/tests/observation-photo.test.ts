/**
 * L2 obs-photo sprint (2026-05-13) — Phases 2 + 3.
 *
 *  - Window constant + `isWithinLinkWindow` helper (Phase 2).
 *  - `mergePendingPhotoIntoObservations` forward-link primitive
 *    used by `applyObservations` in apply-extraction.ts (Phase 3).
 */

import { describe, expect, it } from 'vitest';
import {
  isWithinLinkWindow,
  mergePendingPhotoIntoObservations,
  OBSERVATION_PHOTO_LINK_WINDOW_MS,
  type PendingObservationPhoto,
} from '@/lib/recording/observation-photo';
import type { ObservationRow } from '@/lib/types';

function makePending(over: Partial<PendingObservationPhoto> = {}): PendingObservationPhoto {
  return {
    jobId: 'job-1',
    blobId: 'blob-1',
    timestamp: 1_700_000_000_000,
    status: 'pending',
    filename: 'server.jpg',
    ...over,
  };
}

function makeRow(over: Partial<ObservationRow> = {}): ObservationRow {
  return {
    id: 'obs-1',
    code: 'C2',
    description: 'Loose neutral terminal',
    ...over,
  } as ObservationRow;
}

describe('OBSERVATION_PHOTO_LINK_WINDOW_MS', () => {
  it('is 60 seconds (matches iOS DeepgramRecordingViewModel.swift:493)', () => {
    expect(OBSERVATION_PHOTO_LINK_WINDOW_MS).toBe(60_000);
  });
});

describe('isWithinLinkWindow', () => {
  const NOW = 1_700_000_000_000;

  it('returns true for `now`', () => {
    expect(isWithinLinkWindow(NOW, NOW)).toBe(true);
  });

  it('returns true 1 ms before the boundary', () => {
    expect(isWithinLinkWindow(NOW, NOW + OBSERVATION_PHOTO_LINK_WINDOW_MS - 1)).toBe(true);
  });

  it('returns false exactly at the boundary', () => {
    // Closed-open interval — 60 s exactly is treated as expired so a
    // capture at t=0 and an observation at t=60_000 never collide in
    // a race condition where both think they own the slot.
    expect(isWithinLinkWindow(NOW, NOW + OBSERVATION_PHOTO_LINK_WINDOW_MS)).toBe(false);
  });

  it('returns false past the boundary', () => {
    expect(isWithinLinkWindow(NOW, NOW + OBSERVATION_PHOTO_LINK_WINDOW_MS + 1_000)).toBe(false);
  });

  it('returns false for future timestamps (negative delta)', () => {
    // A capture in the "future" relative to now — should never happen
    // in practice but guard anyway so a clock-skew oddity doesn't
    // accidentally pin a photo into perpetual eligibility.
    expect(isWithinLinkWindow(NOW + 5_000, NOW)).toBe(false);
  });

  it('returns false for non-finite inputs', () => {
    expect(isWithinLinkWindow(Number.NaN, NOW)).toBe(false);
    expect(isWithinLinkWindow(NOW, Number.NaN)).toBe(false);
    expect(isWithinLinkWindow(Number.POSITIVE_INFINITY, NOW)).toBe(false);
  });

  it('uses Date.now() as the default reference', () => {
    // The helper without an explicit `now` reads Date.now. A timestamp
    // 1 second ago must still be within the window when no override
    // is passed.
    expect(isWithinLinkWindow(Date.now() - 1_000)).toBe(true);
  });
});

describe('mergePendingPhotoIntoObservations (Phase 3 forward-link)', () => {
  const NOW = 1_700_000_000_000;

  it('no-ops when pending is null', () => {
    const rows: ObservationRow[] = [makeRow()];
    const attached = mergePendingPhotoIntoObservations(rows, null, NOW);
    expect(attached).toBe(false);
    expect(rows[0].photos).toBeUndefined();
  });

  it('no-ops when newRows is empty', () => {
    const rows: ObservationRow[] = [];
    const attached = mergePendingPhotoIntoObservations(rows, makePending({ timestamp: NOW }), NOW);
    expect(attached).toBe(false);
    expect(rows).toHaveLength(0);
  });

  it('no-ops when pending is outside the auto-link window', () => {
    const rows: ObservationRow[] = [makeRow()];
    const attached = mergePendingPhotoIntoObservations(
      rows,
      makePending({ timestamp: NOW - 90_000 }),
      NOW
    );
    expect(attached).toBe(false);
    expect(rows[0].photos).toBeUndefined();
  });

  it('attaches filename to the LAST row within window', () => {
    const rows: ObservationRow[] = [makeRow()];
    const attached = mergePendingPhotoIntoObservations(
      rows,
      makePending({ timestamp: NOW - 30_000, filename: 'capture-123.jpg' }),
      NOW
    );
    expect(attached).toBe(true);
    expect(rows[0].photos).toEqual(['capture-123.jpg']);
  });

  it('attaches blobId as placeholder when filename is unset (upload still in flight)', () => {
    // Pins PLAN §Risks §1 — the upload-during-resize race. An
    // observation that lands BEFORE the upload settles still needs
    // *something* to write into photos[]; the blobId is that
    // stable placeholder. Phase 4's upload-success handler will
    // rewrite this entry with the canonical filename in a second
    // pass.
    const rows: ObservationRow[] = [makeRow()];
    const attached = mergePendingPhotoIntoObservations(
      rows,
      makePending({
        timestamp: NOW - 5_000,
        status: 'uploading',
        filename: undefined,
        blobId: 'blob-deadbeef',
      }),
      NOW
    );
    expect(attached).toBe(true);
    expect(rows[0].photos).toEqual(['blob-deadbeef']);
  });

  it('appends to existing photos[] rather than replacing', () => {
    // iOS canon (:5587) writes `.photos = (.photos ?? []) + [path]`.
    // Pre-existing entries must survive.
    const rows: ObservationRow[] = [makeRow({ photos: ['old1.jpg', 'old2.jpg'] })];
    const attached = mergePendingPhotoIntoObservations(
      rows,
      makePending({ timestamp: NOW - 10_000, filename: 'new.jpg' }),
      NOW
    );
    expect(attached).toBe(true);
    expect(rows[0].photos).toEqual(['old1.jpg', 'old2.jpg', 'new.jpg']);
  });

  it('attaches to LAST row only when multiple rows are present', () => {
    // Pins the "two observations in one turn → last only" iOS
    // canon at :5583.
    const rows: ObservationRow[] = [
      makeRow({ id: 'obs-1', description: 'first' }),
      makeRow({ id: 'obs-2', description: 'second' }),
    ];
    const attached = mergePendingPhotoIntoObservations(
      rows,
      makePending({ timestamp: NOW - 10_000, filename: 'photo.jpg' }),
      NOW
    );
    expect(attached).toBe(true);
    expect(rows[0].photos).toBeUndefined();
    expect(rows[1].photos).toEqual(['photo.jpg']);
  });

  it('returns false but leaves rows untouched on a future-timestamp pending', () => {
    const rows: ObservationRow[] = [makeRow()];
    const attached = mergePendingPhotoIntoObservations(
      rows,
      makePending({ timestamp: NOW + 5_000 }),
      NOW
    );
    expect(attached).toBe(false);
    expect(rows[0].photos).toBeUndefined();
  });
});
