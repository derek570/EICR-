/**
 * L2 observation-photo auto-link sprint (2026-05-13) — Phase 1.
 *
 * Pins the new `pending-observation-photo` IDB store added at v4:
 *   - v3 → v4 migration is additive — pre-existing v3 data (jobs-list,
 *     job-detail, outbox, app-settings) survives the bump and the new
 *     store is created empty. Runs FIRST so the module hasn't yet
 *     opened the DB at v4 (avoids deleteDatabase-blocked-by-open-
 *     connection hangs under fake-indexeddb, same pattern outbox.test.ts
 *     documents in its isolation note).
 *   - read / write / clear helpers round-trip a record.
 *   - Replace semantic: writing a second record under the same `jobId`
 *     overwrites the first (matches iOS canon at
 *     DeepgramRecordingViewModel.swift:1553 and PLAN §0.2).
 *   - Different jobIds stay independent.
 *   - `clearJobCache()` includes the new store (shared-device safety).
 *
 * Why no top-level imports from job-cache: importing the module under
 * test would trigger openDB() at v4 on first call from any other suite,
 * defeating the migration test. We import dynamically inside each `it`.
 */

import { beforeEach, describe, expect, it } from 'vitest';

describe('v3 → current migration (runs first — installs v3 manually then bumps)', () => {
  it('preserves a populated v3 schema and adds the new stores on bump', async () => {
    // Step 1: open the DB at v3 directly via raw IDB and seed user data.
    // This must happen before any code path opens at v4.
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('certmate-cache', 3);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('jobs-list', { keyPath: 'userId' });
        db.createObjectStore('job-detail', { keyPath: 'key' });
        const outbox = db.createObjectStore('outbox', { keyPath: 'id' });
        outbox.createIndex('by-user', 'userId', { unique: false });
        db.createObjectStore('app-settings', { keyPath: 'key' });
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['jobs-list', 'outbox'], 'readwrite');
        tx.objectStore('jobs-list').put({
          userId: 'u1',
          jobs: [{ id: 'j1', address: 'pre-existing', status: 'done', created_at: 'x' }],
          cachedAt: 1,
        });
        tx.objectStore('outbox').put({
          id: 'mut-1',
          userId: 'u1',
          jobId: 'j1',
          op: 'saveJob',
          patch: { address: 'pre-existing-edit' },
          createdAt: 1,
          attempts: 0,
          nextAttemptAt: 0,
        });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });

    // Step 2: dynamic-import the module — first openDB call triggers
    // the upgrade path to the CURRENT version, which must create the
    // newer stores (v4 pending-observation-photo, v5 WS6
    // pending-ccu-extraction) without touching the v3 data.
    const cache = await import('@/lib/pwa/job-cache');
    expect(cache.DB_VERSION).toBe(5);

    // jobs-list survived the upgrade.
    const jobs = await cache.getCachedJobs('u1');
    expect(jobs).toHaveLength(1);
    expect(jobs?.[0].address).toBe('pre-existing');

    // outbox row survived the upgrade.
    const outbox = await import('@/lib/pwa/outbox');
    const pending = await outbox.listPendingMutations();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe('mut-1');

    // New v4 store exists, starts empty, and is writable.
    expect(await cache.readPendingPhoto('any-job')).toBeNull();
    await cache.writePendingPhoto({
      jobId: 'any-job',
      blobId: 'new',
      timestamp: 9,
      status: 'pending',
    });
    expect((await cache.readPendingPhoto('any-job'))?.blobId).toBe('new');

    // New v5 store (WS6 pending-CCU queue) exists and starts empty.
    const queue = await import('@/lib/ccu/pending-extraction-queue');
    expect(await queue.getPendingCcuExtractions('any-job')).toEqual([]);
  });
});

describe('pending-observation-photo helpers (Phase 1)', () => {
  // The migration test above has already brought the DB to v4 + seeded
  // some data. clearJobCache wipes user-scoped stores between tests
  // (including pending-photo) without forcing a deleteDatabase, which
  // would block on the module's held connection.
  beforeEach(async () => {
    const { clearJobCache } = await import('@/lib/pwa/job-cache');
    await clearJobCache();
  });

  const FIXED_JOB_ID = 'job-1';
  const OTHER_JOB_ID = 'job-2';

  it('round-trips a write → read → clear cycle', async () => {
    const { writePendingPhoto, readPendingPhoto, clearPendingPhoto } =
      await import('@/lib/pwa/job-cache');

    const record = {
      jobId: FIXED_JOB_ID,
      blobId: 'blob-abc',
      timestamp: 1_700_000_000_000,
      status: 'uploading' as const,
    };
    await writePendingPhoto(record);

    expect(await readPendingPhoto(FIXED_JOB_ID)).toEqual(record);

    await clearPendingPhoto(FIXED_JOB_ID);
    expect(await readPendingPhoto(FIXED_JOB_ID)).toBeNull();
  });

  it('returns null when no pending photo exists for the job', async () => {
    const { readPendingPhoto } = await import('@/lib/pwa/job-cache');
    expect(await readPendingPhoto(FIXED_JOB_ID)).toBeNull();
  });

  it('replace-not-queue: second write for the same jobId overwrites', async () => {
    // Pins iOS canon at DeepgramRecordingViewModel.swift:1553 and
    // PLAN §0.2 — second photo overwrites the slot, no queue.
    const { writePendingPhoto, readPendingPhoto } = await import('@/lib/pwa/job-cache');

    await writePendingPhoto({
      jobId: FIXED_JOB_ID,
      blobId: 'first',
      timestamp: 1_000,
      status: 'pending',
      filename: 'first.jpg',
    });
    await writePendingPhoto({
      jobId: FIXED_JOB_ID,
      blobId: 'second',
      timestamp: 2_000,
      status: 'uploading',
    });

    const got = await readPendingPhoto(FIXED_JOB_ID);
    expect(got?.blobId).toBe('second');
    expect(got?.timestamp).toBe(2_000);
    expect(got?.status).toBe('uploading');
    expect(got?.filename).toBeUndefined();
  });

  it('keeps records for different jobIds independent', async () => {
    const { writePendingPhoto, readPendingPhoto, clearPendingPhoto } =
      await import('@/lib/pwa/job-cache');

    await writePendingPhoto({
      jobId: FIXED_JOB_ID,
      blobId: 'a',
      timestamp: 1,
      status: 'pending',
    });
    await writePendingPhoto({
      jobId: OTHER_JOB_ID,
      blobId: 'b',
      timestamp: 2,
      status: 'pending',
    });

    expect((await readPendingPhoto(FIXED_JOB_ID))?.blobId).toBe('a');
    expect((await readPendingPhoto(OTHER_JOB_ID))?.blobId).toBe('b');

    await clearPendingPhoto(FIXED_JOB_ID);
    expect(await readPendingPhoto(FIXED_JOB_ID)).toBeNull();
    expect((await readPendingPhoto(OTHER_JOB_ID))?.blobId).toBe('b');
  });

  it('persists optional filename when the upload settles', async () => {
    // Phase 4's capture handler patches the record with the server
    // filename and flips status 'uploading' → 'pending' on upload
    // success. Pin the round-trip.
    const { writePendingPhoto, readPendingPhoto } = await import('@/lib/pwa/job-cache');

    await writePendingPhoto({
      jobId: FIXED_JOB_ID,
      blobId: 'b1',
      timestamp: 1,
      status: 'pending',
      filename: 'server-assigned.jpg',
    });

    const got = await readPendingPhoto(FIXED_JOB_ID);
    expect(got?.filename).toBe('server-assigned.jpg');
    expect(got?.status).toBe('pending');
  });

  it('clearJobCache wipes pending-observation-photo alongside the other user-scoped stores', async () => {
    // Shared-device safety: signing out must not leave user A's
    // pending photo around for user B's next recording on the same
    // tablet. Mirrors jobs-list / job-detail / outbox.
    const { clearJobCache, writePendingPhoto, readPendingPhoto } =
      await import('@/lib/pwa/job-cache');

    await writePendingPhoto({
      jobId: FIXED_JOB_ID,
      blobId: 'x',
      timestamp: 1,
      status: 'pending',
    });
    expect((await readPendingPhoto(FIXED_JOB_ID))?.blobId).toBe('x');

    await clearJobCache();
    expect(await readPendingPhoto(FIXED_JOB_ID)).toBeNull();
  });
});
