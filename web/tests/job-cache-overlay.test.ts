/**
 * Wave 5 D7 — `getCachedJobWithOverlay` regression suite.
 *
 * Scope:
 *   The cache-overlay helper in `web/src/lib/pwa/job-cache.ts` reads
 *   the server snapshot and merges every non-poisoned outbox mutation
 *   for the same `(userId, jobId)` on top, FIFO. Before D7 the cached
 *   read was authoritative-last-server-write, so a reload during an
 *   offline-edit session would flash the pre-edit state (or, worse,
 *   revert to pre-edit when a concurrent server write arrived on a
 *   different field).
 *
 * Why a separate file from `outbox.test.ts`: the overlay spans two
 * stores (`job-detail` + `outbox`) and exercises `queueSaveJob`'s
 * durability path — keeping it here isolates the conflict-resolution
 * assertions from the pure outbox state-machine tests.
 *
 * Conflict policy under test (per D7 non-negotiable):
 *   1. Queued patch wins over server snapshot, per-field.
 *   2. Server fields not touched by the queued patch stay from the
 *      snapshot.
 *   3. Multiple queued rows merge FIFO.
 *   4. Poisoned rows are NOT overlaid (they're dead mutations; the
 *      inspector's intent has been explicitly abandoned by the
 *      server rejection).
 *   5. No cached snapshot → returns null even with queued rows —
 *      inventing defaults for required JobDetail fields is worse
 *      than a one-frame delay while the page's network fetch lands.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearJobCache,
  getCachedJob,
  getCachedJobWithOverlay,
  putCachedJob,
} from '@/lib/pwa/job-cache';
import { enqueueSaveJobMutation, markMutationPoisoned, purgeOutbox } from '@/lib/pwa/outbox';
import type { JobDetail } from '@/lib/types';

const BASE_JOB: JobDetail = {
  id: 'job-1',
  address: '1 Test Road',
  status: 'pending',
  created_at: '2026-04-18T00:00:00Z',
  certificate_type: 'EICR',
  installation_details: { postcode: 'SW1A 1AA' },
};

beforeEach(async () => {
  await purgeOutbox();
  await clearJobCache();
});

describe('Wave 5 D7 · getCachedJobWithOverlay', () => {
  it('returns null when no server snapshot is cached (even with queued rows)', async () => {
    // Queued row targeting a job we've never fetched — pre-D7 would have
    // silently returned the base null; we keep that behaviour (documented
    // in the helper's JSDoc) because inventing defaults for required
    // JobDetail fields is worse than a one-frame delay.
    await enqueueSaveJobMutation('u1', 'job-1', { address: 'offline edit' });
    const result = await getCachedJobWithOverlay('u1', 'job-1');
    expect(result).toBeNull();
  });

  it('returns the raw cached doc when no outbox rows are queued', async () => {
    await putCachedJob('u1', 'job-1', BASE_JOB);
    const result = await getCachedJobWithOverlay('u1', 'job-1');
    expect(result).toEqual(BASE_JOB);
  });

  it('overlays a single queued patch on top of the cached doc', async () => {
    await putCachedJob('u1', 'job-1', BASE_JOB);
    await enqueueSaveJobMutation('u1', 'job-1', { address: '2 New Road' });

    const result = await getCachedJobWithOverlay('u1', 'job-1');
    expect(result).not.toBeNull();
    // Queued patch wins on the touched field.
    expect(result?.address).toBe('2 New Road');
    // Server fields untouched by the patch survive.
    expect(result?.installation_details).toEqual({ postcode: 'SW1A 1AA' });
    expect(result?.certificate_type).toBe('EICR');
  });

  it('merges multiple queued rows FIFO (later rows overwrite earlier rows per-field)', async () => {
    await putCachedJob('u1', 'job-1', BASE_JOB);
    await enqueueSaveJobMutation('u1', 'job-1', { address: 'first' });
    // Real-time gap so createdAt values differ — the sort key is
    // createdAt (ms since epoch). A microtask gap is sufficient under
    // fake-indexeddb because Date.now() advances on every call.
    await new Promise((r) => setTimeout(r, 2));
    await enqueueSaveJobMutation('u1', 'job-1', { address: 'second' });

    const result = await getCachedJobWithOverlay('u1', 'job-1');
    // FIFO — the second enqueue's patch is applied after the first and
    // wins on the shared `address` field. Matches the replay worker's
    // write order so the overlay and the eventual network replay stay
    // in lockstep (inspector sees the same final state both paths
    // produce).
    expect(result?.address).toBe('second');
  });

  it('ignores poisoned rows (they should NOT flash back onto the cached doc)', async () => {
    await putCachedJob('u1', 'job-1', BASE_JOB);
    const m = await enqueueSaveJobMutation('u1', 'job-1', { address: 'rejected edit' });
    // Simulate a 4xx that arrived + was routed to poison. The overlay
    // must NOT show this row — the server rejected it; putting it
    // back on screen would mislead the inspector into thinking their
    // edit stuck.
    await markMutationPoisoned(m.id, 'HTTP 422');

    const result = await getCachedJobWithOverlay('u1', 'job-1');
    expect(result?.address).toBe(BASE_JOB.address);
  });

  it('scopes to the exact (userId, jobId) — other jobs and users do not bleed through', async () => {
    await putCachedJob('u1', 'job-1', BASE_JOB);
    // Edits queued on a different job for the same user, and a different
    // user for the same job — neither should overlay on (u1, job-1).
    await enqueueSaveJobMutation('u1', 'job-2', { address: 'other job' });
    await enqueueSaveJobMutation('u2', 'job-1', { address: 'other user' });

    const result = await getCachedJobWithOverlay('u1', 'job-1');
    expect(result?.address).toBe(BASE_JOB.address);
  });

  it('does not mutate the raw cached doc (callers can still read it un-overlaid)', async () => {
    // The replay worker in outbox-replay.ts needs the RAW cache for its
    // write-through — if getCachedJobWithOverlay mutated the stored
    // record, replay success would double-apply the patch. This test
    // guards the invariant: overlay is a pure read, no IDB write.
    await putCachedJob('u1', 'job-1', BASE_JOB);
    await enqueueSaveJobMutation('u1', 'job-1', { address: 'overlay-only' });

    await getCachedJobWithOverlay('u1', 'job-1');

    const raw = await getCachedJob('u1', 'job-1');
    expect(raw?.address).toBe(BASE_JOB.address);
  });
});
