/**
 * L2 obs-photo sprint (2026-05-13) — Phase 3 integration.
 *
 * Pins the forward-link wiring inside `applyExtractionToJob` end to
 * end: pending tuple in options → observation lands within window →
 * photo attaches to LAST row → `onPhotoAttached` fires with the
 * blobId so the caller can drain its pending state. Also pins
 * `onLastObservationCreated` firing on every fresh observation so the
 * reverse-link path in Phase 4 has the data it needs.
 *
 * Goes through the public `applyExtractionToJob` entry point rather
 * than the internal `applyObservations` so we catch any future
 * threading bug between the two layers (EIC strip, options drop,
 * etc.).
 */

import { describe, expect, it, vi } from 'vitest';
import { applyExtractionToJob } from '@/lib/recording/apply-extraction';
import {
  OBSERVATION_PHOTO_LINK_WINDOW_MS,
  type PendingObservationPhoto,
} from '@/lib/recording/observation-photo';
import type { ExtractionResult } from '@/lib/recording/sonnet-session';
import type { JobDetail } from '@/lib/types';

const NOW = 1_700_000_000_000;

function makeJob(over: Partial<JobDetail> = {}): JobDetail {
  return {
    id: 'job_1',
    address: 'a',
    status: 'pending',
    created_at: new Date(0).toISOString(),
    certificate_type: 'EICR',
    ...over,
  } as unknown as JobDetail;
}

function makeResult(over: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    readings: [],
    field_clears: [],
    circuit_updates: [],
    observations: [],
    validation_alerts: [],
    confirmations: [],
    ...over,
  };
}

function makePending(over: Partial<PendingObservationPhoto> = {}): PendingObservationPhoto {
  return {
    jobId: 'job_1',
    blobId: 'blob-1',
    timestamp: NOW - 10_000, // 10 s ago by default
    status: 'pending',
    filename: 'capture.jpg',
    ...over,
  };
}

describe('applyExtractionToJob — forward-link (Phase 3)', () => {
  it('attaches a pending photo to the new observation when within window', () => {
    const onPhotoAttached = vi.fn();
    const onLastObservationCreated = vi.fn();
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    try {
      const applied = applyExtractionToJob(
        makeJob(),
        makeResult({
          observations: [{ observation_text: 'Damaged socket outlet', code: 'C2' }],
        }),
        {
          pendingPhoto: makePending(),
          onPhotoAttached,
          onLastObservationCreated,
        }
      );
      expect(applied?.patch.observations).toHaveLength(1);
      expect(applied?.patch.observations?.[0].photos).toEqual(['capture.jpg']);
      expect(onPhotoAttached).toHaveBeenCalledWith('blob-1');
      expect(onLastObservationCreated).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('does NOT attach when pending is past the auto-link window', () => {
    const onPhotoAttached = vi.fn();
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    try {
      const applied = applyExtractionToJob(
        makeJob(),
        makeResult({
          observations: [{ observation_text: 'Damaged socket outlet', code: 'C2' }],
        }),
        {
          // 90 s old — past the 60 s window.
          pendingPhoto: makePending({ timestamp: NOW - 90_000 }),
          onPhotoAttached,
        }
      );
      expect(applied?.patch.observations?.[0].photos).toBeUndefined();
      expect(onPhotoAttached).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('does NOT attach when this turn produced no new observations (pending stays for caller)', () => {
    // Observation is a duplicate of an existing one — applyObservations
    // dedups via 40-char prefix + 70 % word overlap. The dedup means
    // no row is appended this turn → no forward-link target → callback
    // does NOT fire, so the caller leaves the pending tuple in place
    // for the next chance.
    const onPhotoAttached = vi.fn();
    const job = makeJob({
      observations: [{ id: 'existing-1', description: 'Damaged socket outlet', code: 'C2' }],
    });
    const applied = applyExtractionToJob(
      job,
      makeResult({
        observations: [{ observation_text: 'DAMAGED SOCKET OUTLET', code: 'C2' }],
      }),
      {
        pendingPhoto: makePending(),
        onPhotoAttached,
      }
    );
    expect(applied?.patch.observations).toBeUndefined();
    expect(onPhotoAttached).not.toHaveBeenCalled();
  });

  it('attaches to the LAST observation when two land in the same turn', () => {
    const onPhotoAttached = vi.fn();
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    try {
      const applied = applyExtractionToJob(
        makeJob(),
        makeResult({
          observations: [
            { observation_text: 'First defect on circuit one', code: 'C2' },
            { observation_text: 'Second defect on circuit two', code: 'C2' },
          ],
        }),
        {
          pendingPhoto: makePending(),
          onPhotoAttached,
        }
      );
      const rows = applied!.patch.observations!;
      expect(rows).toHaveLength(2);
      expect(rows[0].photos).toBeUndefined();
      expect(rows[1].photos).toEqual(['capture.jpg']);
      expect(onPhotoAttached).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('uses blobId as a placeholder when the upload is still in flight (race handling)', () => {
    // PLAN §Risks §1 — the observation can land before the upload
    // resolves. The merge writes the blobId; Phase 4's upload-success
    // handler rewrites the placeholder onto the real filename.
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    try {
      const applied = applyExtractionToJob(
        makeJob(),
        makeResult({
          observations: [{ observation_text: 'Exposed live cable', code: 'C1' }],
        }),
        {
          pendingPhoto: makePending({
            blobId: 'placeholder-uuid',
            filename: undefined,
            status: 'uploading',
          }),
        }
      );
      expect(applied?.patch.observations?.[0].photos).toEqual(['placeholder-uuid']);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('records the LAST appended observation via onLastObservationCreated', () => {
    const onLastObservationCreated = vi.fn();
    const before = Date.now();
    const applied = applyExtractionToJob(
      makeJob(),
      makeResult({
        observations: [
          { observation_text: 'first defect somewhere distinctive', code: 'C2' },
          { observation_text: 'second defect somewhere else', code: 'C3' },
        ],
      }),
      { onLastObservationCreated }
    );
    expect(applied?.patch.observations).toHaveLength(2);
    expect(onLastObservationCreated).toHaveBeenCalledTimes(1);
    const [id, ts] = onLastObservationCreated.mock.calls[0];
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(ts).toBeGreaterThanOrEqual(before);
  });

  it('does NOT fire onLastObservationCreated when no row appended', () => {
    const onLastObservationCreated = vi.fn();
    const job = makeJob({
      observations: [{ id: 'e-1', description: 'pre-existing defect text here', code: 'C2' }],
    });
    applyExtractionToJob(
      job,
      makeResult({
        // Dedup against the existing row.
        observations: [{ observation_text: 'PRE-EXISTING DEFECT TEXT HERE', code: 'C2' }],
      }),
      { onLastObservationCreated }
    );
    expect(onLastObservationCreated).not.toHaveBeenCalled();
  });

  it('window boundary is closed-open at exactly OBSERVATION_PHOTO_LINK_WINDOW_MS', () => {
    // Defensive check: a capture at NOW - 60_000 ms is past the
    // boundary, no attach. Matches the closed-open contract in
    // isWithinLinkWindow.
    const onPhotoAttached = vi.fn();
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    try {
      const applied = applyExtractionToJob(
        makeJob(),
        makeResult({
          observations: [{ observation_text: 'Defect noted on inspection round', code: 'C3' }],
        }),
        {
          pendingPhoto: makePending({ timestamp: NOW - OBSERVATION_PHOTO_LINK_WINDOW_MS }),
          onPhotoAttached,
        }
      );
      expect(applied?.patch.observations?.[0].photos).toBeUndefined();
      expect(onPhotoAttached).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });
});
