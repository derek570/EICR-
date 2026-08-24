/**
 * PLAN-B2 mini-review c1 — cross-tab per-job save lock.
 *
 * The PDF gate's "prove the canonical snapshot was the last write"
 * check races the outbox replay worker (and other tabs): an older
 * replay finishing AFTER the fresh snapshot save would revert S3, and
 * removing its row could make a later outbox read look drained. Both
 * the replay worker's per-mutation processing and the PDF gate's
 * save+proof therefore serialise through the Web Locks API where
 * available (cross-tab), falling back to an in-process promise chain
 * (same-tab coverage — jsdom/tests and legacy browsers).
 */

const fallbackChains = new Map<string, Promise<unknown>>();

function lockName(userId: string, jobId: string): string {
  return `certmate-job-save:${userId}:${jobId}`;
}

export async function withJobSaveLock<T>(
  userId: string,
  jobId: string,
  op: () => Promise<T>
): Promise<T> {
  const name = lockName(userId, jobId);
  const locks = (
    globalThis.navigator as Navigator & {
      locks?: { request<R>(n: string, cb: () => Promise<R>): Promise<R> };
    }
  )?.locks;
  if (locks?.request) {
    return locks.request(name, op);
  }
  // In-process fallback: chain ops per lock name.
  const prev = fallbackChains.get(name) ?? Promise.resolve();
  const next = prev.then(op, op);
  fallbackChains.set(
    name,
    next.catch(() => undefined)
  );
  return next;
}
