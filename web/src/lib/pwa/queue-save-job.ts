import { api } from '@/lib/api-client';
import { ApiError, type JobDetail } from '@/lib/types';
import { getCachedJob, putCachedJob } from './job-cache';
import { enqueueSaveJobMutation, removeMutation } from './outbox';

/**
 * Offline-tolerant write path for `api.saveJob` (Phase 7c).
 *
 * Why this exists:
 *   - The raw `api.saveJob` throws on any network failure, which means
 *     an inspector tapping "save" in a basement consumer-unit room just
 *     loses their edit. This wrapper promises the mutation will be
 *     retried until it either succeeds or the attempts cap kicks in.
 *   - Writing to the outbox BEFORE firing the network request is what
 *     makes this durable: if the user closes the tab immediately after
 *     save (common — phone pockets, offline → offline transitions), the
 *     mutation still lives in IDB and the next session's replay worker
 *     picks it up.
 *
 * Order of operations (do not reorder — each step's failure mode matters):
 *   1. Enqueue to outbox. If this throws, the mutation was never stored
 *      and the caller can surface the failure immediately. Surfacing
 *      here (rather than silently continuing) is load-bearing: a failed
 *      IDB write means durability guarantees are broken, and the user
 *      needs to know.
 *   2. Fire the network request. Pass through `ApiError` for 4xx so the
 *      caller can handle validation errors (the row stays in the outbox
 *      but the replay worker's exponential backoff + eventual poisoning
 *      prevents it from spamming the server forever with bad data).
 *   3. On 2xx — remove the outbox row and refresh the IDB read cache so
 *      the next SWR read shows the post-save state without a round-trip.
 *      Cache refresh uses a read-modify-write against the cached detail
 *      so we don't blow away unrelated fields that the patch didn't
 *      touch (the server's response is only `{success}`, not the full
 *      doc).
 *   4. On network failure — leave the row for the replay worker. Do NOT
 *      bump attempts here; attempt bookkeeping is the replay worker's
 *      job so counts stay consistent across immediate-vs-retry paths.
 *
 * Shape of the return value:
 *   - `synced: true` means the mutation made it to the server in-line.
 *   - `synced: false` means the mutation is durably queued but the
 *     network call failed; the replay worker will handle it when online.
 *   - Either way, `queued: true` — the caller can safely mark the UI
 *     "saved" for 2xx-eventually semantics (Phase 7d will refine this
 *     with pending-count badges).
 *
 * We deliberately do NOT throw on plain network errors: every offline
 * edit is expected to go through this path, and turning every offline
 * save into a thrown exception would make the caller's control flow
 * miserable. 4xx ApiErrors ARE re-thrown because they indicate a bad
 * patch that will never replay successfully — the caller should show
 * a validation message rather than pretend the save queued.
 */
export async function queueSaveJob(
  userId: string,
  jobId: string,
  patch: Partial<JobDetail>,
  opts: {
    /**
     * Full in-memory `JobDetail` post-patch. If provided, we refresh the
     * IDB read-through cache on success so a subsequent dashboard /
     * job-detail visit sees the new state instantly (without this, the
     * next SWR read would paint stale cached data for a tick). Optional
     * because some call-sites (e.g. future bulk operations) won't have
     * the merged detail to hand; they can skip the cache refresh and
     * accept a one-frame staleness.
     */
    optimisticDetail?: JobDetail;
  } = {}
): Promise<{ queued: true; synced: boolean; mutationId: string }> {
  // Step 1 — durability first.
  const mutation = await enqueueSaveJobMutation(userId, jobId, patch);

  // Step 2 — network, best-effort.
  try {
    await api.saveJob(userId, jobId, patch);
  } catch (err) {
    // 4xx is a persistent server rejection — surface it so the caller
    // can unwind the optimistic UI. The outbox row stays (the replay
    // worker will poison it after MAX_ATTEMPTS retries), but surfacing
    // the error is correct here because retrying a bad patch won't
    // fix it.
    if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
      throw err;
    }
    // Transient (network / 5xx / offline) — replay worker owns it.
    return { queued: true, synced: false, mutationId: mutation.id };
  }

  // Step 3 — clear the outbox row and warm the read cache.
  await removeMutation(mutation.id);
  if (opts.optimisticDetail) {
    // Fire-and-forget: a failed cache write is a best-effort loss,
    // the next SWR read will simply fetch from the network.
    void putCachedJob(userId, jobId, opts.optimisticDetail);
  } else {
    // No optimistic detail — attempt a read-modify-write so the cache
    // at least reflects the patch rather than whatever stale doc was
    // there. If there's nothing cached, skip — we'd have to invent
    // defaults for every required JobDetail field, and the next
    // fetch will populate correctly anyway.
    const current = await getCachedJob(userId, jobId);
    if (current) {
      void putCachedJob(userId, jobId, { ...current, ...patch });
    }
  }
  return { queued: true, synced: true, mutationId: mutation.id };
}
