/**
 * L2 obs-photo sprint Phase 6 — JobPhotosPickerSheet helper logic.
 *
 * The picker UI is presentational and exercised through field test
 * (Phase 7). The pure helper `hasAnyPickableJobPhotos` is the gate
 * that controls whether the "From Job" button appears at all, and
 * its correctness keeps an empty picker sheet from ever opening.
 */

import { describe, expect, it } from 'vitest';
import { hasAnyPickableJobPhotos } from '@/components/observations/job-photos-picker-sheet';
import type { JobDetail, ObservationRow } from '@/lib/types';

function makeJob(over: Partial<JobDetail> = {}): JobDetail {
  return {
    id: 'job-1',
    address: 'x',
    status: 'pending',
    created_at: 'x',
    ...over,
  } as unknown as JobDetail;
}

describe('hasAnyPickableJobPhotos', () => {
  it('returns false for a job with no photos anywhere', () => {
    expect(hasAnyPickableJobPhotos(makeJob(), null)).toBe(false);
  });

  it('returns false when job is null/undefined', () => {
    expect(hasAnyPickableJobPhotos(null, null)).toBe(false);
    expect(hasAnyPickableJobPhotos(undefined, null)).toBe(false);
  });

  it('returns true when unassigned pool has at least one photo', () => {
    const job = makeJob({ unassigned_photos: ['photo-1.jpg'] });
    expect(hasAnyPickableJobPhotos(job, null)).toBe(true);
  });

  it('returns true when another observation has a photo', () => {
    const job = makeJob({
      observations: [
        {
          id: 'other-obs',
          description: 'something',
          code: 'C2',
          photos: ['photo-2.jpg'],
        },
      ] as ObservationRow[],
    });
    expect(hasAnyPickableJobPhotos(job, 'current-obs')).toBe(true);
  });

  it('excludes the current observation when checking', () => {
    // The picker is for moving photos FROM other sources TO the current
    // observation. Photos already on the current observation must not
    // count toward the "has any pickable" check.
    const job = makeJob({
      observations: [
        {
          id: 'current-obs',
          description: 'me',
          code: 'C2',
          photos: ['mine.jpg'],
        },
      ] as ObservationRow[],
    });
    expect(hasAnyPickableJobPhotos(job, 'current-obs')).toBe(false);
  });

  it('returns false when only empty arrays exist', () => {
    const job = makeJob({
      unassigned_photos: [],
      observations: [
        {
          id: 'other',
          description: 'no photos',
          code: 'C2',
          photos: [],
        },
      ] as ObservationRow[],
    });
    expect(hasAnyPickableJobPhotos(job, null)).toBe(false);
  });

  it('returns true when both unassigned and other-obs have photos', () => {
    const job = makeJob({
      unassigned_photos: ['a.jpg'],
      observations: [
        { id: 'other', description: 'x', code: 'C2', photos: ['b.jpg'] },
      ] as ObservationRow[],
    });
    expect(hasAnyPickableJobPhotos(job, 'current')).toBe(true);
  });

  it('treats unassigned_photos: null (blank-slate backend shape) as an empty pool', () => {
    // GET /api/job emits `unassigned_photos: null` when the pool was
    // never written (src/routes/jobs.js:594, pinned by backend
    // round-trip tests) — the gate must read that as "nothing
    // pickable", not crash or show the From-Job button.
    const job = makeJob({ unassigned_photos: null });
    expect(hasAnyPickableJobPhotos(job, null)).toBe(false);
  });
});
