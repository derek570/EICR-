/**
 * L2 obs-photo sprint Phase 4 — captureObservationPhoto orchestration.
 *
 * Pins every state-machine path of the capture flow without standing
 * up a React tree: the module under test is injected with mock deps
 * for resize / upload / IDB / refs / job. Tests assert on the
 * observable side effects (job patches applied, pending state set/
 * cleared, IDB writes, error callbacks).
 *
 * Tests by path:
 *
 *  1. Forward-link, happy path (upload succeeds, no observation
 *     during upload) → pending tuple ends settled with filename.
 *  2. Forward-link, race (observation lands during upload writing
 *     blobId placeholder) → upload-success rewrites placeholder,
 *     drains pending.
 *  3. Reverse-link → placeholder attached optimistically, recent
 *     observation cleared, no pending entered, upload-success
 *     rewrites placeholder.
 *  4. Reverse-link target missing (observation deleted between ref-
 *     set and capture) → falls back to forward-link path.
 *  5. Resize failure → no upload attempted, no state changes,
 *     onError fires.
 *  6. Upload failure on forward-link → pending state drained,
 *     onError fires.
 *  7. Upload failure on reverse-link → placeholder rolled back from
 *     the observation, onError fires.
 *  8. Concurrent capture replaces pending (PLAN §0.2 iOS replace-not-
 *     queue) — newer tuple wins, the older upload-success does NOT
 *     wipe the newer pending tuple.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captureObservationPhoto } from '@/lib/recording/capture-observation-photo';
import type {
  PendingObservationPhoto,
  RecentObservationRef,
} from '@/lib/recording/observation-photo';
import type { JobDetail, ObservationRow } from '@/lib/types';

interface MockState {
  pending: PendingObservationPhoto | null;
  recent: RecentObservationRef | null;
  job: JobDetail | null;
  idbWrites: PendingObservationPhoto[];
  idbClears: string[];
  patches: Partial<JobDetail>[];
  errors: Error[];
  logs: Array<{ event: string; payload: Record<string, unknown> }>;
}

function makeState(over: Partial<MockState> = {}): MockState {
  return {
    pending: null,
    recent: null,
    job: { id: 'job-1', address: 'x', status: 'pending', created_at: 'x' } as unknown as JobDetail,
    idbWrites: [],
    idbClears: [],
    patches: [],
    errors: [],
    logs: [],
    ...over,
  };
}

function makeDeps(
  state: MockState,
  over: {
    resize?: (blob: Blob) => Promise<Blob>;
    uploadPhoto?: (userId: string, jobId: string, blob: Blob) => Promise<{ filename: string }>;
    now?: () => number;
    blobId?: string;
  } = {}
) {
  const file = new Blob(['fake-bytes']);
  const resized = new Blob(['resized-bytes'], { type: 'image/jpeg' });
  return {
    userId: 'user-1',
    jobId: 'job-1',
    file,
    resize: over.resize ?? (async () => resized),
    uploadPhoto: over.uploadPhoto ?? (async () => ({ filename: 'photo-1700000000000-abc.jpg' })),
    generateBlobId: () => over.blobId ?? 'blob-aaa',
    now: over.now ?? (() => 1_700_000_000_000),
    writePendingPhoto: async (record: PendingObservationPhoto) => {
      state.idbWrites.push(record);
    },
    clearPendingPhoto: async (jobId: string) => {
      state.idbClears.push(jobId);
    },
    getRecentObservation: () => state.recent,
    clearRecentObservation: () => {
      state.recent = null;
    },
    getPendingPhoto: () => state.pending,
    setPendingPhoto: (record: PendingObservationPhoto | null) => {
      state.pending = record;
    },
    getJob: () => state.job,
    applyJobPatch: (patch: Partial<JobDetail>) => {
      state.patches.push(patch);
      state.job = { ...(state.job as JobDetail), ...patch };
    },
    onError: (err: Error) => state.errors.push(err),
    log: (event: string, payload: Record<string, unknown>) => state.logs.push({ event, payload }),
  };
}

beforeEach(() => {
  // No global setup — tests are independent via fresh `makeState()`.
});

describe('captureObservationPhoto — forward-link path', () => {
  it('happy path: enters pending, uploads, settles with filename', async () => {
    const state = makeState();
    await captureObservationPhoto(makeDeps(state));

    // Pending state was entered (initial write with status='uploading'
    // followed by settled write with status='pending' + filename).
    expect(state.idbWrites).toHaveLength(2);
    expect(state.idbWrites[0]).toMatchObject({
      jobId: 'job-1',
      blobId: 'blob-aaa',
      status: 'uploading',
      timestamp: 1_700_000_000_000,
    });
    expect(state.idbWrites[1]).toMatchObject({
      jobId: 'job-1',
      blobId: 'blob-aaa',
      status: 'pending',
      filename: 'photo-1700000000000-abc.jpg',
    });

    // Final ref state = settled (Phase 3 will claim on next observation).
    expect(state.pending?.status).toBe('pending');
    expect(state.pending?.filename).toBe('photo-1700000000000-abc.jpg');

    // No observations affected (no forward-link race in this test).
    expect(state.patches).toHaveLength(0);
    expect(state.errors).toHaveLength(0);
  });

  it('race: forward-link writes placeholder during upload, success rewrites it', async () => {
    const state = makeState();
    let uploadResolve!: (v: { filename: string }) => void;
    const uploadPromise = new Promise<{ filename: string }>((resolve) => (uploadResolve = resolve));
    const captureRun = captureObservationPhoto(
      makeDeps(state, { uploadPhoto: () => uploadPromise })
    );
    // Wait a microtask so resize completes and pending state is set.
    await Promise.resolve();
    await Promise.resolve();

    // Simulate Phase 3 forward-link: observation lands with blobId
    // placeholder in photos[].
    state.job = {
      ...(state.job as JobDetail),
      observations: [
        { id: 'obs-1', description: 'Test', code: 'C2', photos: ['blob-aaa'] },
      ] as ObservationRow[],
    } as JobDetail;

    uploadResolve({ filename: 'server-name.jpg' });
    await captureRun;

    // Placeholder was rewritten to canonical filename.
    const lastPatch = state.patches[state.patches.length - 1];
    expect(lastPatch.observations).toHaveLength(1);
    expect((lastPatch.observations as ObservationRow[])[0].photos).toEqual(['server-name.jpg']);

    // Pending state drained.
    expect(state.pending).toBeNull();
    expect(state.idbClears).toContain('job-1');
  });
});

describe('captureObservationPhoto — reverse-link path', () => {
  it('attaches placeholder to recent observation, clears recent, no pending', async () => {
    const state = makeState({
      recent: { id: 'obs-recent', timestamp: 1_700_000_000_000 - 30_000 },
      job: {
        id: 'job-1',
        address: 'x',
        status: 'pending',
        created_at: 'x',
        observations: [{ id: 'obs-recent', description: 'Loose neutral', code: 'C2' }],
      } as unknown as JobDetail,
    });

    await captureObservationPhoto(makeDeps(state));

    // Eager-attached the placeholder.
    expect(state.patches[0].observations).toBeDefined();
    expect((state.patches[0].observations as ObservationRow[])[0].photos).toEqual(['blob-aaa']);

    // Recent ref cleared (iOS clears recentObservation in Case B).
    expect(state.recent).toBeNull();

    // Pending never entered.
    expect(state.idbWrites).toHaveLength(0);
    expect(state.pending).toBeNull();

    // Upload success rewrote the placeholder.
    const lastPatch = state.patches[state.patches.length - 1];
    expect((lastPatch.observations as ObservationRow[])[0].photos).toEqual([
      'photo-1700000000000-abc.jpg',
    ]);
  });

  it('falls back to forward-link when the recent observation is gone', async () => {
    const state = makeState({
      recent: { id: 'obs-deleted', timestamp: 1_700_000_000_000 - 5_000 },
      job: {
        id: 'job-1',
        address: 'x',
        status: 'pending',
        created_at: 'x',
        observations: [], // recent observation no longer exists
      } as unknown as JobDetail,
    });

    await captureObservationPhoto(makeDeps(state));

    // No eager-attach patch (target not found).
    expect(state.patches).toHaveLength(0);

    // Forward-link path was taken — pending state entered + settled.
    expect(state.idbWrites).toHaveLength(2);
    expect(state.idbWrites[0].status).toBe('uploading');
    expect(state.idbWrites[1].status).toBe('pending');

    // Telemetry: target-missing event was logged.
    expect(
      state.logs.some((l) => l.event === 'observation_photo_reverse_link_target_missing')
    ).toBe(true);
  });

  it('does NOT reverse-link when recent observation is past the window', async () => {
    const state = makeState({
      // 90 s ago — past the 60 s window.
      recent: { id: 'obs-stale', timestamp: 1_700_000_000_000 - 90_000 },
      job: {
        id: 'job-1',
        address: 'x',
        status: 'pending',
        created_at: 'x',
        observations: [{ id: 'obs-stale', description: 'old', code: 'C2' }],
      } as unknown as JobDetail,
    });

    await captureObservationPhoto(makeDeps(state));

    // Forward-link path taken — pending entered.
    expect(state.idbWrites).toHaveLength(2);
    // Stale recent ref intentionally NOT cleared by this capture —
    // it'll be cleared by the next applyObservations call that emits
    // a fresh observation, or expire naturally on job switch. We
    // could also choose to clear it here defensively; current
    // behaviour matches the simpler "forward-link doesn't touch
    // recent ref" rule.
    expect(state.recent).toEqual({
      id: 'obs-stale',
      timestamp: 1_700_000_000_000 - 90_000,
    });
  });
});

describe('captureObservationPhoto — failure paths', () => {
  it('resize failure → no upload, no state changes, onError fires', async () => {
    const state = makeState();
    const resizeErr = new Error('canvas blew up');
    await captureObservationPhoto(
      makeDeps(state, {
        resize: async () => {
          throw resizeErr;
        },
      })
    );

    expect(state.idbWrites).toHaveLength(0);
    expect(state.patches).toHaveLength(0);
    expect(state.pending).toBeNull();
    expect(state.errors).toEqual([resizeErr]);
  });

  it('upload failure on forward-link → pending drained, onError fires', async () => {
    const state = makeState();
    const uploadErr = new Error('network down');
    await captureObservationPhoto(
      makeDeps(state, {
        uploadPhoto: async () => {
          throw uploadErr;
        },
      })
    );

    // Pending was entered then drained.
    expect(state.idbWrites).toHaveLength(1);
    expect(state.idbWrites[0].status).toBe('uploading');
    expect(state.pending).toBeNull();
    expect(state.idbClears).toContain('job-1');
    expect(state.errors).toEqual([uploadErr]);
  });

  it('upload failure on reverse-link → placeholder rolled back, onError fires', async () => {
    const state = makeState({
      recent: { id: 'obs-recent', timestamp: 1_700_000_000_000 - 5_000 },
      job: {
        id: 'job-1',
        address: 'x',
        status: 'pending',
        created_at: 'x',
        observations: [
          {
            id: 'obs-recent',
            description: 'Test',
            code: 'C2',
            photos: ['existing.jpg'],
          },
        ],
      } as unknown as JobDetail,
    });

    const uploadErr = new Error('500 server error');
    await captureObservationPhoto(
      makeDeps(state, {
        uploadPhoto: async () => {
          throw uploadErr;
        },
      })
    );

    // First patch added the placeholder; second patch rolled it back.
    expect(state.patches).toHaveLength(2);
    expect((state.patches[0].observations as ObservationRow[])[0].photos).toEqual([
      'existing.jpg',
      'blob-aaa',
    ]);
    expect((state.patches[1].observations as ObservationRow[])[0].photos).toEqual(['existing.jpg']);
    expect(state.errors).toEqual([uploadErr]);
  });

  it('upload failure: empty photos[] becomes undefined (no orphan empty array)', async () => {
    const state = makeState({
      recent: { id: 'obs-recent', timestamp: 1_700_000_000_000 - 5_000 },
      job: {
        id: 'job-1',
        address: 'x',
        status: 'pending',
        created_at: 'x',
        observations: [{ id: 'obs-recent', description: 'Test', code: 'C2' }],
      } as unknown as JobDetail,
    });

    await captureObservationPhoto(
      makeDeps(state, {
        uploadPhoto: async () => {
          throw new Error('boom');
        },
      })
    );

    const finalObs = (state.patches[state.patches.length - 1].observations as ObservationRow[])[0];
    // photos[] was emptied → dropped to undefined.
    expect(finalObs.photos).toBeUndefined();
  });
});

describe('captureObservationPhoto — replace-not-queue concurrency', () => {
  it('does not clobber a newer pending tuple set during this capture', async () => {
    // Simulates: capture A enters pending, upload A is slow, capture
    // B starts, capture B overwrites pending (iOS replace-not-queue),
    // upload A finally returns. Upload A must NOT wipe capture B's
    // pending tuple from the ref or IDB.
    const state = makeState();
    let uploadResolve!: (v: { filename: string }) => void;
    const uploadPromise = new Promise<{ filename: string }>((resolve) => (uploadResolve = resolve));
    const captureA = captureObservationPhoto(
      makeDeps(state, {
        uploadPhoto: () => uploadPromise,
        blobId: 'blob-A',
      })
    );

    // Let resize + initial pending write happen.
    await Promise.resolve();
    await Promise.resolve();

    // Simulate capture B replacing the pending slot mid-flight.
    state.pending = {
      jobId: 'job-1',
      blobId: 'blob-B',
      timestamp: 1_700_000_000_000 + 10,
      status: 'uploading',
    };
    state.idbWrites = []; // ignore prior writes for clarity

    uploadResolve({ filename: 'server-A.jpg' });
    await captureA;

    // Upload-A must NOT have set pending back to A's state, nor
    // cleared IDB (the IDB record now belongs to capture B).
    expect(state.pending?.blobId).toBe('blob-B');
    expect(state.idbClears).not.toContain('job-1');
  });
});
